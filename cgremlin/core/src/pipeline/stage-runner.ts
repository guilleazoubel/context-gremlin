import type { AgentExitResult, AgentHandle, AgentRunner } from '../agent/agent-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { Session } from '../schema/session';
import type { LastRun, StageName } from '../schema/stage';

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
}
export interface StageRunInput { sessionId: string; stage: StageName; brief: string | null; prompt: string }
export interface StageRunResult { exit: AgentExitResult; outcome: 'succeeded' | 'failed' | 'stopped'; session: Session }

interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean }

export class StageRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => Date;

  constructor(private readonly deps: StageRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
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
        const priorAgent = session.agent ?? null;
        // A session's agent conversation is tied to the runner that started
        // it — resuming a claude-code conversation id under codex (or vice
        // versa) is meaningless to the new runner, so never seed it; start a
        // fresh conversation instead and note the switch once the run
        // succeeds (a failed/stopped run keeps its own error text).
        const runnerMismatch = priorAgent !== null && priorAgent.runner !== this.deps.runnerKind;
        const seedResumeId = runnerMismatch ? null : (priorAgent?.resumeId ?? null);
        session = { ...session, lastRun: running, agent: { runner: this.deps.runnerKind, resumeId: seedResumeId } };
        await this.deps.store.save(session);
        this.deps.events.emit('run.started', { session, stage });

        let startupError: unknown = undefined;
        const exitPromise = new Promise<AgentExitResult>((resolve) => {
          void (async () => {
            const handle = await this.deps.runner.start({
              sessionId,
              workingDirectory: worktreePath,
              additionalDirs: [sessionDir],
              resumeId: seedResumeId ?? undefined,
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
        let error =
          outcome === 'stopped' ? 'stopped by user'
          : outcome === 'failed' ? (exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`)
          : null;
        if (outcome === 'succeeded' && runnerMismatch) {
          error = `runner changed from ${priorAgent!.runner} to ${this.deps.runnerKind}; started a fresh conversation`;
        }
        const resumeId = (active.handle && this.deps.runner.getResumeId?.(active.handle)) ?? seedResumeId;
        session = await this.deps.store.load(sessionId); // re-read: nothing else writes during a run, but never clobber a newer save
        session = {
          ...session,
          lastRun: { ...running, finishedAt: this.now().toISOString(), exitCode: exit.code, signal: exit.signal, outcome, error },
          agent: { runner: this.deps.runnerKind, resumeId },
        };
        await this.deps.store.save(session);
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
        try {
          const current = await this.deps.store.load(sessionId);
          finishedSession = { ...current, lastRun: failed };
          await this.deps.store.save(finishedSession);
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
