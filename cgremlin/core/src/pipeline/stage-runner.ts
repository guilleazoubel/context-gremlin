import type { AgentExitResult, AgentHandle, AgentRunner } from '../agent/agent-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { Session } from '../schema/session';
import type { LastRun, StageName } from '../schema/stage';
import { KeyedLock } from '../api/keyed-lock';

export class RunInProgressError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' already has a stage run in progress`);
    this.name = 'RunInProgressError';
  }
}
export class WorkspaceMissingError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' has no worktree; create its workspace before running a stage`);
    this.name = 'WorkspaceMissingError';
  }
}

export interface StageRunnerDeps {
  runner: AgentRunner;
  store: SessionStore;
  fs: SessionFileSystem;
  events: EngineEvents;
  sessionsDir: string;
  runnerKind: 'claude-code' | 'codex';
  now?: () => Date;
  /** Shared with PipelineService (and the API server) — see the locking invariant documented atop pipeline-service.ts. Required (not optional): a wiring that forgets to share it is a bug, not a degraded-but-working mode. */
  lock: KeyedLock;
}
export interface StageRunInput { sessionId: string; stage: StageName; brief: string | null; prompt: string }
export interface StageRunResult { exit: AgentExitResult; outcome: 'succeeded' | 'failed' | 'stopped'; session: Session }

interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean }

export class StageRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => Date;
  private readonly lock: KeyedLock;

  constructor(private readonly deps: StageRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.lock = deps.lock;
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  activeSessionIds(): string[] {
    return [...this.active.keys()];
  }

  async stop(sessionId: string): Promise<boolean> {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.stopRequested = true;
    if (run.handle) await this.deps.runner.stop(run.handle);
    return true;
  }

  async run(input: StageRunInput): Promise<StageRunResult> {
    const { sessionId, stage } = input;
    if (this.active.has(sessionId)) throw new RunInProgressError(sessionId);
    // Reserve the slot synchronously, before any await, so a stop() called
    // immediately after run() — even before the session has been loaded —
    // is observed once the run actually reaches the point of starting the
    // agent (see the stopRequested check below).
    const active: ActiveRun = { handle: null, stopRequested: false };
    this.active.set(sessionId, active);
    // Set the moment `run.started` fires — the caller (an API handler, or
    // PipelineService's runStageLocked) holds the per-session lock up to
    // exactly that point and releases it right after, per the invariant
    // documented atop pipeline-service.ts. Before that point we're still
    // inside the caller's lock, so acquiring it again here would deadlock
    // (KeyedLock is not re-entrant); after it, nothing else holds the lock
    // for this session, so every write below must acquire it itself.
    let runStarted = false;
    try {
      let session = await this.deps.store.load(sessionId);
      const worktreePath = session.workspace.worktreePath;
      if (!worktreePath) throw new WorkspaceMissingError(sessionId);

      const sessionDir = `${this.deps.sessionsDir}/${sessionId}`;
      try {
        await this.deps.fs.mkdir(sessionDir, { recursive: true });
        if (input.brief !== null) await this.deps.fs.writeFile(`${sessionDir}/BRIEF.md`, input.brief);
        await this.deps.fs.writeFile(`${sessionDir}/AGENT_STATE`, 'working');

        const startedAt = this.now().toISOString();
        const running: LastRun = { stage, startedAt, finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null };
        const previousResumeId = session.agent?.resumeId ?? null;
        session = { ...session, lastRun: running, agent: { runner: this.deps.runnerKind, resumeId: previousResumeId } };
        await this.deps.store.save(session);
        this.deps.events.emit('run.started', { session, stage });
        runStarted = true;

        let startupError: unknown = undefined;
        const exitPromise = new Promise<AgentExitResult>((resolve) => {
          void (async () => {
            const handle = await this.deps.runner.start({
              sessionId,
              workingDirectory: worktreePath,
              additionalDirs: [sessionDir],
              resumeId: previousResumeId ?? undefined,
            });
            active.handle = handle;
            this.deps.runner.onOutput(handle, (chunk) => this.deps.events.emit('run.output', { sessionId, stage, chunk }));
            this.deps.runner.onExit(handle, resolve);
            if (active.stopRequested) {
              // A stop() arrived before the agent actually started (e.g.
              // during runner.start()'s own await). Never call sendPrompt in
              // that case: for ClaudeCodeRunner that would spawn a real,
              // orphaned process nothing would ever track or reap.
              await this.deps.runner.stop(handle);
              resolve({ code: null, signal: null });
              return;
            }
            await this.deps.runner.sendPrompt(handle, input.prompt);
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
        const error =
          outcome === 'stopped' ? 'stopped by user'
          : outcome === 'failed' ? (exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`)
          : null;
        const resumeId = (active.handle && this.deps.runner.getResumeId?.(active.handle)) ?? previousResumeId;
        const finishedLastRun: LastRun = {
          ...running,
          finishedAt: this.now().toISOString(),
          exitCode: exit.code,
          signal: exit.signal,
          outcome,
          error,
        };
        // Locked: something else (a human transition, another chained stage)
        // may have written this session while the agent was running — only
        // `run.started` released the lock the caller held, so this is the
        // first write since then. Merge onto whatever is freshest, touching
        // only lastRun/agent, never clobbering a concurrent stageStatus change.
        session = await this.lock.withLock(sessionId, async () => {
          const fresh = await this.deps.store.load(sessionId);
          const merged: Session = { ...fresh, lastRun: finishedLastRun, agent: { runner: this.deps.runnerKind, resumeId } };
          await this.deps.store.save(merged);
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
