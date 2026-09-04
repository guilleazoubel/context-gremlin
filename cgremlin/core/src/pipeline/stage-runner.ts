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
    let session = await this.deps.store.load(sessionId);
    const worktreePath = session.workspace.worktreePath;
    if (!worktreePath) throw new WorkspaceMissingError(sessionId);

    const sessionDir = `${this.deps.sessionsDir}/${sessionId}`;
    const active: ActiveRun = { handle: null, stopRequested: false };
    this.active.set(sessionId, active);
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
          if (active.stopRequested) await this.deps.runner.stop(handle);
          await this.deps.runner.sendPrompt(handle, input.prompt);
        })().catch((err) => { startupError = err; resolve({ code: null, signal: null }); });
      });
      const exit = await exitPromise;
      if (startupError !== undefined) throw startupError;

      const outcome: StageRunResult['outcome'] = active.stopRequested
        ? 'stopped'
        : exit.code === 0 && exit.signal === null ? 'succeeded' : 'failed';
      const error =
        outcome === 'stopped' ? 'stopped by user'
        : outcome === 'failed' ? (exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`)
        : null;
      const resumeId = (active.handle && this.deps.runner.getResumeId?.(active.handle)) ?? previousResumeId;
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
      const current = await this.deps.store.load(sessionId);
      const failed: LastRun = {
        stage, startedAt: current.lastRun?.startedAt ?? this.now().toISOString(), finishedAt: this.now().toISOString(),
        exitCode: null, signal: null, outcome: 'failed', error: err instanceof Error ? err.message : String(err),
      };
      await this.deps.store.save({ ...current, lastRun: failed });
      this.deps.events.emit('run.finished', { session: { ...current, lastRun: failed }, stage, outcome: 'failed' });
      throw err;
    } finally {
      this.active.delete(sessionId);
    }
  }
}
