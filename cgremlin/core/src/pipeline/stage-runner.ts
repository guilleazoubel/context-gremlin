import { randomUUID } from 'node:crypto';
import type { AgentExitResult, AgentHandle, AgentRunner, LimitEvent, RunStats } from '../agent/agent-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { Session } from '../schema/session';
import type { LastRun, StageName } from '../schema/stage';
import { KeyedLock } from '../api/keyed-lock';
import { refreshWorkspaceGuardrails } from '../workspace/workspace-manager';
import { redactSecrets } from '../config/core-config';
import { archiveRound } from './round-archive';
import type { ResolvedRoute, RunnerKind } from '../config/routing';
import { appendRunRecord, recordPrefixOf, takeRunFacts, writeRunFacts, type PendingRun, type RunRecord } from './run-records';

export class RunInProgressError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' already has a stage run in progress`);
    this.name = 'RunInProgressError';
  }
}
/** The session record names no worktree at all — it was never created. */
export class WorkspaceMissingError extends Error {
  constructor(sessionId: string) {
    super(
      `Session '${sessionId}' has no worktree path recorded; create its workspace before running a stage`,
    );
    this.name = 'WorkspaceMissingError';
  }
}
/**
 * The record names a worktree, but the directory is not on disk — deleted by
 * hand, pruned, or on a wiped scratch disk. A DIFFERENT fault from the one
 * above and it must read that way in the log, because the remedy differs:
 * that one was never created, this one is gone.
 *
 * Checked explicitly (and not left to fail at spawn) because the guardrail
 * refresh below mkdir's recursively: unchecked, it would recreate the path
 * with `.claude/` and nothing else, the agent would spawn happily into an
 * empty directory, and a review agent that can see no code at all would still
 * write a confident report about nothing.
 */
export class WorktreeGoneError extends Error {
  constructor(sessionId: string, worktreePath: string) {
    super(
      `Session '${sessionId}' has a worktree path that no longer exists on disk: ${worktreePath}; recreate its workspace before running a stage`,
    );
    this.name = 'WorktreeGoneError';
  }
}
/** R116 — a stage routed to a runner kind this engine was not given. Fails the stage before any agent starts. */
export class RunnerUnavailableError extends Error {
  constructor(stage: StageName, kind: RunnerKind) {
    super(`Stage '${stage}' is routed to runner '${kind}', but no ${kind} runner is wired in this engine`);
    this.name = 'RunnerUnavailableError';
  }
}

export interface StageRunnerDeps {
  runner: AgentRunner;
  /**
   * R116 — one runner per kind, for stages routed away from `runnerKind`. `runner` is used for
   * `runnerKind` when this has no entry for it. A route naming a kind found in neither fails
   * that stage with RunnerUnavailableError.
   */
  runners?: Partial<Record<RunnerKind, AgentRunner>>;
  /** R116 — the route for a stage. Absent: every stage is `{ runner: runnerKind, model: null, effort: null }` (today). */
  routeFor?: (stage: StageName) => ResolvedRoute;
  store: SessionStore;
  fs: SessionFileSystem;
  events: EngineEvents;
  sessionsDir: string;
  runnerKind: RunnerKind;
  now?: () => Date;
  /** Shared with PipelineService (and the API server) — see the locking invariant documented atop pipeline-service.ts. Required (not optional): a wiring that forgets to share it is a bug, not a degraded-but-working mode. */
  lock: KeyedLock;
  /** One line per degraded side effect (run facts or a run record that could not be written). Defaults to `console.warn`, which the engine log captures. */
  log?: (line: string) => void;
}
export interface StageRunInput {
  sessionId: string;
  stage: StageName;
  brief: string | null;
  prompt: string;
  /**
   * R90 — fresh means fresh: no `--resume`, whatever the session's agent record holds, and the
   * previous round's BRIEF.md/FEEDBACK.md are archived first (src/pipeline/round-archive.ts).
   * Absent/false is today's behaviour: the session's own conversation is resumed.
   */
  fresh?: boolean;
  /** R90 — this round's FEEDBACK.md, written beside BRIEF.md. Null/absent writes none. */
  feedback?: string | null;
}
/**
 * Defect 2 — the engine captured the reason a run died and threw it away.
 *
 * The agent's output reached `run.output`, and the only thing that ever persisted one was the
 * engine log, behind `--verbose`. So a findings run that died three seconds in because
 * "Failed to authenticate: OAuth session expired and could not be refreshed" was recorded as
 * `agent exited with code 1` — a number, synthesized here, that folded in nothing the process
 * had actually said.
 *
 * A bounded TAIL is kept instead: 4 KB, which is a few screens of the very end of the run and is
 * where a dying process says why. It is held in memory for the length of one run, never written
 * anywhere on a run that succeeded, and the one line drawn out of it is capped again and passed
 * through `redactSecrets` before it is persisted — an auth failure is exactly the kind of message
 * that carries a token.
 */
const OUTPUT_TAIL_CAP = 4096;
const FAILURE_REASON_CAP = 400;

/**
 * The LAST thing the process said, as one line. A dying agent's final line is its complaint; the
 * lines above it are the work it was doing, which the exit code already summarizes.
 */
function failureReasonFrom(tail: string): string | null {
  const lines = tail.split('\n').map((line) => line.trim());
  const last = lines.filter((line) => line !== '').pop();
  if (last === undefined) return null;
  const capped = last.length > FAILURE_REASON_CAP ? `${last.slice(0, FAILURE_REASON_CAP)}…` : last;
  return redactSecrets(capped);
}

export interface StageRunResult { exit: AgentExitResult; outcome: 'succeeded' | 'failed' | 'stopped'; session: Session }

/** `runner` is the runner THIS run was routed to: stop() and the pid probe must ask it, not the default. */
interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean; runner: AgentRunner }

type PidLiveness = 'alive' | 'gone' | 'foreign';

/**
 * W8/serve.ts's ESRCH/EPERM classification, reused a third time here: ESRCH
 * means the pid is gone, EPERM means SOME process still holds that pid — not
 * necessarily ours, since pids get reused (same reasoning `pidLiveness` in
 * src/host/serve.ts applies to the engine lock). Anything else is a real
 * fault and rethrows. This NEVER sends a real signal — signal 0 only checks
 * existence, per Node's documented `process.kill` behavior.
 *
 * What this probe can prove: a specific pid no longer exists (ESRCH), which
 * is enough to know OUR child is gone. What it can never prove: that a pid
 * which IS alive (or foreign) is still our own child — a dead child's pid
 * can be recycled by the OS to an unrelated process before we ever probe it.
 * That is why `gone` is the only verdict this module treats as "dead"; both
 * `alive` and `foreign` fall back to "still live" rather than risk dropping
 * an entry that is only *reporting* under someone else's pid.
 */
function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'foreign';
    throw err;
  }
}

function statsOf(runner: AgentRunner, handle: AgentHandle | null): RunStats | null {
  if (handle === null) return null;
  try {
    return runner.getRunStats?.(handle) ?? null;
  } catch {
    return null;
  }
}

function pendingRunOf(input: StageRunInput, route: ResolvedRoute, startedAt: string, seedResumeId: string | null): PendingRun {
  return {
    v: 1, runId: randomUUID(), sessionId: input.sessionId, stage: input.stage, runner: route.runner, model: route.model, effort: route.effort,
    routeSource: route.source, fresh: input.fresh === true, resumed: seedResumeId !== null, startedAt,
  };
}

/**
 * The CLI emits a limit event per 1% move, so a long run near its quota would carry dozens of
 * near-identical lines. A record keeps only the latest event per (kind, limitType), in the order
 * those latest events arrived.
 */
function collapseLimitEvents(events: readonly LimitEvent[]): LimitEvent[] {
  const keyOf = (e: LimitEvent) => JSON.stringify([e.kind, e.limitType]);
  const lastIndex = new Map<string, number>();
  events.forEach((e, i) => lastIndex.set(keyOf(e), i));
  return events.filter((e, i) => lastIndex.get(keyOf(e)) === i);
}

/** S2-35 — a `rejected` limit means the run was stopped by the limit, whatever the exit code said. */
function runRecordOf(
  pending: PendingRun,
  stats: RunStats | null,
  end: { finishedAt: string; outcome: RunRecord['outcome']; error: string | null },
): RunRecord {
  const limited = (stats?.limitEvents ?? []).some((e) => e.kind === 'rejected');
  const outcome: RunRecord['outcome'] = limited ? 'stopped' : end.outcome;
  return {
    ...recordPrefixOf(pending),
    model: pending.model ?? stats?.observedModel ?? null,
    finishedAt: end.finishedAt,
    tokens: stats?.tokens ?? null,
    tokensSource: stats?.tokensSource ?? null,
    costUsd: stats?.costUsd ?? null,
    modelUsage: stats?.modelUsage ? { ...stats.modelUsage } : null,
    limitEvents: collapseLimitEvents(stats?.limitEvents ?? []),
    outcome,
    stopReason: limited ? 'limit' : outcome === 'stopped' ? 'user' : null,
    error: end.error,
    interrupted: false,
  };
}

export class StageRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => Date;
  private readonly lock: KeyedLock;

  constructor(private readonly deps: StageRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.lock = deps.lock;
  }

  isRunning(sessionId: string): boolean {
    return this.liveSessionIds().includes(sessionId);
  }

  /**
   * The ids of sessions with an in-flight run right now — the source of
   * truth for "what to stop" on shutdown, not any on-disk field.
   *
   * Self-correcting (the gap this closes): a child process can die without
   * the runner ever seeing an exit event (killed out-of-band, OOM-killed,
   * etc.), which would otherwise leave its entry in `active` forever —
   * wedging the session as permanently "live" with no way to claim it, chat
   * with it, or start a new run. Before reporting, each entry's pid (if any)
   * is checked with a signal-0 probe; an entry whose pid is confirmed gone is
   * dropped here so `runLiveness` sees it as `crashed` and the existing heal
   * path (PipelineService.isStale) takes it from there.
   */
  activeSessionIds(): string[] {
    return this.liveSessionIds();
  }

  /** Shared by `activeSessionIds()` and `isRunning()` so both self-correct the same way. */
  private liveSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, run] of this.active) {
      if (this.isEntryAlive(run)) {
        ids.push(sessionId);
      } else {
        this.active.delete(sessionId);
      }
    }
    return ids;
  }

  /**
   * `false` only when we can PROVE the backing pid is gone. Every other case
   * — no handle yet (mid-spawn, before `run()` even reaches `runner.start()`),
   * no pid yet (between `start()` and the first `sendPrompt()`), or a pid
   * that still answers to signal 0 (ours or, per `pidLiveness`, possibly
   * someone else's after reuse) — is treated as alive. Absence of proof of
   * death is not proof of life either, but the only alternative (assuming
   * dead) is exactly the wedge this exists to prevent.
   */
  private isEntryAlive(run: ActiveRun): boolean {
    if (run.handle === null) return true;
    const pid = run.runner.getPid?.(run.handle);
    if (pid === undefined) return true;
    return pidLiveness(pid) !== 'gone';
  }

  async stop(sessionId: string): Promise<boolean> {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.stopRequested = true;
    if (run.handle) await run.runner.stop(run.handle);
    return true;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  /** S2-25 — the record's known prefix, so a run the engine dies under can still be recorded on heal. Never throws. */
  private async writeFacts(sessionDir: string, pending: PendingRun): Promise<boolean> {
    try {
      await writeRunFacts(this.deps.fs, sessionDir, pending);
      return true;
    } catch (err) {
      this.log(`run facts for ${pending.sessionId} not written: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * R116/R118f — appends the run's record. If facts were written and this run's are no longer
   * there, the crash heal already recorded this run (S2-25): write nothing. Only facts carrying
   * this run's `runId` are taken; anyone else's (the next run's, after this lost run's late exit)
   * are left for their own run. Never throws: a failure is a log line and the run's outcome and
   * lastRun stay exactly what they were.
   *
   * Called under the session lock, right after the run's final lastRun save: so taking the facts
   * is serialized with the heal's (which takes them under the same lock, and only while lastRun
   * still says `running`), and nothing waiting on the lock (a claim, a transition) slips in
   * between the final lastRun and this run's `active` entry going away. If that lastRun save
   * fails, this is never reached and the facts stay: lastRun still says `running`, so the heal
   * records the run as interrupted.
   */
  private async recordRun(sessionDir: string, factsWritten: boolean, runId: string, record: RunRecord): Promise<void> {
    try {
      if (factsWritten && (await takeRunFacts(this.deps.fs, sessionDir, (facts) => facts.runId === runId)) === null) return;
      await appendRunRecord(this.deps.fs, sessionDir, record);
    } catch (err) {
      this.log(`run record for ${record.sessionId} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** R116 — the route for `stage`; without `routeFor`, today's single engine-wide runner. */
  private routeOf(stage: StageName): ResolvedRoute {
    return this.deps.routeFor?.(stage) ?? { stage, runner: this.deps.runnerKind, model: null, effort: null, source: 'legacy' };
  }

  private runnerOf(stage: StageName, kind: RunnerKind): AgentRunner {
    const runner = this.deps.runners?.[kind] ?? (kind === this.deps.runnerKind ? this.deps.runner : undefined);
    if (runner === undefined) throw new RunnerUnavailableError(stage, kind);
    return runner;
  }

  async run(input: StageRunInput): Promise<StageRunResult> {
    const { sessionId, stage } = input;
    if (this.active.has(sessionId)) throw new RunInProgressError(sessionId);
    // Reserve the slot synchronously, before any await, so a stop() called
    // immediately after run() — even before the session has been loaded —
    // is observed once the run actually reaches the point of starting the
    // agent (see the stopRequested check below).
    const active: ActiveRun = { handle: null, stopRequested: false, runner: this.deps.runner };
    this.active.set(sessionId, active);
    // Set the moment `run.started` fires — the caller (an API handler, or
    // PipelineService's runStageLocked) holds the per-session lock up to
    // exactly that point and releases it right after, per the invariant
    // documented atop pipeline-service.ts. Before that point we're still
    // inside the caller's lock, so acquiring it again here would deadlock
    // (KeyedLock is not re-entrant); after it, nothing else holds the lock
    // for this session, so every write below must acquire it itself.
    let runStarted = false;
    let pending: PendingRun | null = null;
    let factsWritten = false;
    try {
      let session = await this.deps.store.load(sessionId);
      const worktreePath = session.workspace.worktreePath;
      if (!worktreePath) throw new WorkspaceMissingError(sessionId);

      const sessionDir = `${this.deps.sessionsDir}/${sessionId}`;
      try {
        // R116 — the stage's route picks the runner, model and effort. Resolved first, inside this
        // try, so a route naming a runner this engine lacks fails the stage (recorded in lastRun)
        // before the worktree is touched or any agent starts.
        const route = this.routeOf(stage);
        const runner = this.runnerOf(stage, route.runner);
        // S2-6 — config already refuses this pairing; an injected or future (escalation) route
        // must not hand codex an effort it does not have either.
        if (route.runner === 'codex' && route.effort === 'max') {
          throw new Error(`Stage '${stage}' is routed to codex with effort 'max', but codex has no 'max' reasoning effort`);
        }
        active.runner = runner;
        // Every stage run in the engine funnels through here — a first
        // stage, a chained one, a re-run, a stage on a session resumed days
        // later — and this is the last point before the agent is spawned at
        // which the worktree path, the session's mode and its own PR are all
        // known and unambiguous. So the guardrails are (re)written HERE, not
        // only at worktree creation: a session created before a
        // permission-table change used to keep the old table forever, and one
        // created before the post helpers existed could never post at all.
        // Still inside the caller's lock (it releases at `run.started`,
        // below), and inside this try, so a failure to write them fails the
        // stage exactly as a failure to write BRIEF.md does — no try/catch of
        // its own, on purpose. The existence check comes FIRST for the reason
        // given on WorktreeGoneError: the refresh would otherwise conjure the
        // directory back.
        if (!(await this.deps.fs.exists(worktreePath))) {
          throw new WorktreeGoneError(sessionId, worktreePath);
        }
        await refreshWorkspaceGuardrails(
          this.deps.fs,
          worktreePath,
          // The whole session, not `session.mode`: what a session may do is
          // answered by permissionProfileFor (src/workspace/permission-guard.ts)
          // and recomputed here on every run, so authority an `intent` confers
          // survives the refresh instead of being reverted by it. And the STAGE,
          // so a review or live-check run in a dev worktree is denied commit
          // and push (R92).
          { ...session, stage },
          session.pr === null
            ? undefined
            : { repoSlug: session.pr.repo, prNumber: session.pr.number },
        );
        await this.deps.fs.mkdir(sessionDir, { recursive: true });
        // R90 — a fresh round first moves the previous round's hand-off aside.
        if (input.fresh === true) await archiveRound(this.deps.fs, sessionDir);
        if (input.brief !== null) await this.deps.fs.writeFile(`${sessionDir}/BRIEF.md`, input.brief);
        if (input.feedback != null) await this.deps.fs.writeFile(`${sessionDir}/FEEDBACK.md`, input.feedback);
        await this.deps.fs.writeFile(`${sessionDir}/AGENT_STATE`, 'working');

        const startedAt = this.now().toISOString();
        const running: LastRun = { stage, startedAt, finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null };
        const priorAgent = session.agent ?? null;
        // A session's agent conversation is tied to the runner that started
        // it — resuming a claude-code conversation id under codex (or vice
        // versa) is meaningless to the new runner, so never seed it; start a
        // fresh conversation instead and note the switch once the run
        // succeeds (a failed/stopped run keeps its own error text).
        const runnerMismatch = priorAgent !== null && priorAgent.runner !== route.runner;
        // The conversation this session would continue: what a non-fresh run resumes, and what a
        // fresh run still records if its own agent reported no id (R90 — Take over must still
        // find the last conversation).
        const carriedResumeId = runnerMismatch ? null : (priorAgent?.resumeId ?? null);
        const seedResumeId = input.fresh === true ? null : carriedResumeId;
        // `humanTurn` is carried forward, never re-derived: this rebuild
        // would otherwise silently drop a human's claim on the conversation
        // (R20/MG-A7). Same at the post-exit merge below.
        session = {
          ...session,
          lastRun: running,
          // Persists the CARRIED id, not the seed: a fresh run hands the runner no id, but a
          // startup failure or a crash mid-run must not erase the last conversation (S2-3).
          agent: { runner: route.runner, resumeId: carriedResumeId, humanTurn: priorAgent?.humanTurn ?? null },
        };
        await this.deps.store.save(session);
        pending = pendingRunOf(input, route, startedAt, seedResumeId);
        factsWritten = await this.writeFacts(sessionDir, pending);
        this.deps.events.emit('run.started', { session, stage });
        runStarted = true;

        let startupError: unknown = undefined;
        let outputTail = '';
        const exitPromise = new Promise<AgentExitResult>((resolve) => {
          void (async () => {
            const handle = await runner.start({
              sessionId,
              workingDirectory: worktreePath,
              additionalDirs: [sessionDir],
              resumeId: seedResumeId ?? undefined,
              // R116 — only what the route names; absent keeps the runner's own default.
              ...(route.model !== null ? { model: route.model } : {}),
              ...(route.effort !== null ? { effort: route.effort } : {}),
            });
            active.handle = handle;
            runner.onOutput(handle, (chunk) => {
              outputTail = (outputTail + chunk.data).slice(-OUTPUT_TAIL_CAP);
              this.deps.events.emit('run.output', { sessionId, stage, chunk });
            });
            runner.onExit(handle, resolve);
            if (active.stopRequested) {
              // A stop() arrived before the agent actually started (e.g.
              // during runner.start()'s own await). Never call sendPrompt in
              // that case: for ClaudeCodeRunner that would spawn a real,
              // orphaned process nothing would ever track or reap.
              await runner.stop(handle);
              resolve({ code: null, signal: null });
              return;
            }
            await runner.sendPrompt(handle, input.prompt);
          })().catch((err) => { startupError = err; resolve({ code: null, signal: null }); });
        });
        const exit = await exitPromise;
        if (startupError !== undefined) throw startupError;

        // No await happens between exitPromise settling and this read, so a
        // stop() cannot interleave and flip stopRequested here — keep it
        // that way; do not insert an await between exitPromise settling and
        // the outcome computation below.
        const outcome: StageRunResult['outcome'] = active.stopRequested
          ? 'stopped'
          : exit.code === 0 && exit.signal === null ? 'succeeded' : 'failed';
        // Defect 2: the exit code says THAT it died, the tail says WHY. Only on a failure — a
        // run that succeeded records nothing of its output, here or anywhere else.
        const said = outcome === 'failed' ? failureReasonFrom(outputTail) : null;
        const howItDied = exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`;
        let error =
          outcome === 'stopped' ? 'stopped by user'
          : outcome === 'failed' ? (said === null ? howItDied : `${howItDied}: ${said}`)
          : null;
        if (outcome === 'succeeded' && runnerMismatch) {
          error = `runner changed from ${priorAgent!.runner} to ${route.runner}; started a fresh conversation`;
        }
        const resumeId = (active.handle && runner.getResumeId?.(active.handle)) ?? carriedResumeId;
        const finishedLastRun: LastRun = {
          ...running,
          finishedAt: this.now().toISOString(),
          exitCode: exit.code,
          signal: exit.signal,
          outcome,
          error,
        };
        const runId = pending.runId;
        const record = runRecordOf(pending, statsOf(runner, active.handle), {
          finishedAt: finishedLastRun.finishedAt ?? this.now().toISOString(),
          outcome,
          error,
        });
        // Locked: something else (a human transition, another chained stage)
        // may have written this session while the agent was running — only
        // `run.started` released the lock the caller held, so this is the
        // first write since then. Merge onto whatever is freshest, touching
        // only lastRun/agent, never clobbering a concurrent stageStatus change.
        session = await this.lock.withLock(sessionId, async () => {
          const fresh = await this.deps.store.load(sessionId);
          const merged: Session = {
            ...fresh,
            lastRun: finishedLastRun,
            // From `fresh`, not from the pre-run snapshot: a human may have
            // claimed (or released) the conversation while the agent ran.
            agent: { runner: route.runner, resumeId, humanTurn: fresh.agent?.humanTurn ?? null },
          };
          await this.deps.store.save(merged);
          // Inside the lock, after lastRun: see recordRun for why.
          await this.recordRun(sessionDir, factsWritten, runId, record);
          return merged;
        });
        this.deps.events.emit('run.finished', { session, stage, outcome });
        return { exit, outcome, session };
      } catch (err) {
        const failed: LastRun = {
          stage,
          startedAt: session.lastRun?.startedAt ?? this.now().toISOString(),
          finishedAt: this.now().toISOString(),
          exitCode: null,
          signal: null,
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
        let finishedSession: Session = { ...session, lastRun: failed };
        const persistFailure = async () => {
          const current = await this.deps.store.load(sessionId);
          finishedSession = { ...current, lastRun: failed };
          await this.deps.store.save(finishedSession);
          // Only for a run that reached `run.started`; after lastRun, under the same lock (see recordRun).
          if (pending !== null) {
            await this.recordRun(
              sessionDir,
              factsWritten,
              pending.runId,
              runRecordOf(pending, statsOf(active.runner, active.handle), {
                finishedAt: failed.finishedAt ?? this.now().toISOString(),
                outcome: 'failed',
                error: failed.error,
              }),
            );
          }
        };
        try {
          // If run.started never fired, the caller still holds the lock for
          // this session (it releases exactly at run.started) — acquiring
          // it again here would deadlock. Only once run.started has fired
          // has the caller released it, making this write our own to make.
          if (runStarted) {
            await this.lock.withLock(sessionId, persistFailure);
          } else {
            await persistFailure();
          }
        } catch {
          // Persisting the failure record itself failed (e.g. disk full,
          // then a corrupt reload) — don't let that secondary error mask
          // the original failure. Fall back to the in-memory session
          // snapshot and keep rethrowing the ORIGINAL err below.
        }
        this.deps.events.emit('run.finished', { session: finishedSession, stage, outcome: 'failed' });
        throw err;
      }
    } finally {
      this.active.delete(sessionId);
    }
  }
}
