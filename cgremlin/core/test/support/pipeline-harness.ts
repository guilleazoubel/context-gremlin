import { InMemoryFileSystem } from './in-memory-file-system';
import { FakeGitRunner } from './fake-git-runner';
import { FakeAgentRunner } from './fake-agent-runner';
import { SessionStore } from '../../src/engine/session-store';
import { WorktreeSeedingSessionStore } from './worktree-seeding-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { EngineEvents } from '../../src/engine/events';
import { StageRunner } from '../../src/pipeline/stage-runner';
import {
  PipelineService,
  type CreateInvestigationInput,
  type PipelineConfig,
  type PipelineServiceDeps,
} from '../../src/pipeline/pipeline-service';
import { KeyedLock } from '../../src/api/keyed-lock';
import type { AgentExitResult } from '../../src/agent/agent-runner';
import type { InvestigationSession } from '../../src/schema/session';
import type { EnvironmentService } from '../../src/env/environment-service';

export const SESSIONS_DIR = '/sessions';
export const WORKTREES_DIR = '/worktrees';
export const MIRRORS_DIR = '/mirrors';

export const FIXED_NOW = (): Date => new Date('2026-09-04T12:00:00.000Z');

export interface PipelineHarness {
  fs: InMemoryFileSystem;
  git: FakeGitRunner;
  store: SessionStore;
  workspace: WorkspaceManager;
  runner: FakeAgentRunner;
  events: EngineEvents;
  stageRunner: StageRunner;
  service: PipelineService;
  lock: KeyedLock;
  environment: EnvironmentService | undefined;
  finishRun: (files: Record<string, string>, exit: AgentExitResult) => Promise<void>;
}

// PipelineService methods that drive a stage run only resolve once the fake
// runner's onExit fires, and reaching that point crosses many sequential
// awaits (store.load/save, fs writes...) — the same depth problem the
// StageRunner tests hit. A fixed count of `await Promise.resolve()` calls
// can't reliably get past that; wait for a macrotask boundary instead, which
// flushes the whole chain regardless of exactly how deep it is.
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface HarnessOptions {
  /** Swap in an instrumented lock (e.g. one that records enter/exit) — still the ONE lock every component shares. */
  lock?: KeyedLock;
  /** Overrides FIXED_NOW for both StageRunner and PipelineService — a movable clock for TTL tests. */
  now?: () => Date;
  /** What a claim on a never-run session records as its runner (PipelineConfig.runnerKind). */
  runnerKind?: 'claude-code' | 'codex';
  /**
   * Built after the harness's fs/git/lock exist, so an EnvironmentService can
   * share them; omitted for every wiring that has no environment at all.
   */
  environment?: (parts: { fs: InMemoryFileSystem; git: FakeGitRunner; lock: KeyedLock }) => EnvironmentService;
  /** R50 — what the respond brief carries beyond the ticket; omitted means an empty body. */
  respondContext?: PipelineServiceDeps['respondContext'];
  /** PipelineServiceDeps.log — omitted means the service's own `console.warn` default. */
  log?: (line: string) => void;
}

export function createHarness(options: HarnessOptions = {}): PipelineHarness {
  const fs = new InMemoryFileSystem();
  const git = new FakeGitRunner(fs);
  const store = new WorktreeSeedingSessionStore(fs, SESSIONS_DIR);
  const workspace = new WorkspaceManager(git, fs, MIRRORS_DIR);
  const runner = new FakeAgentRunner();
  const events = new EngineEvents();
  const lock = options.lock ?? new KeyedLock();
  const now = options.now ?? FIXED_NOW;
  const runnerKind = options.runnerKind ?? 'claude-code';
  const environment = options.environment?.({ fs, git, lock });
  const stageRunner = new StageRunner({
    runner,
    store,
    fs,
    events,
    sessionsDir: SESSIONS_DIR,
    runnerKind,
    now,
    lock,
  });
  const config: PipelineConfig = {
    sessionsDir: SESSIONS_DIR,
    worktreesDir: WORKTREES_DIR,
    defaultBaseRef: 'origin/main',
    runnerKind,
    humanTurnTtlMs: 600_000,
  };
  const service = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs,
    git,
    events,
    config,
    now,
    lock,
    environment,
    ...(options.respondContext !== undefined ? { respondContext: options.respondContext } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });

  async function finishRun(files: Record<string, string>, exit: AgentExitResult): Promise<void> {
    await flush();
    const handle = runner.lastHandle();
    const sessionId = runner.getContext(handle).sessionId;
    const sessionDir = `${SESSIONS_DIR}/${sessionId}`;
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(`${sessionDir}/${name}`, content);
    }
    runner.emitExit(handle, exit);
  }

  return { fs, git, store, workspace, runner, events, stageRunner, service, lock, environment, finishRun };
}

export async function createInvestigation(
  service: PipelineService,
  overrides: Partial<CreateInvestigationInput> = {},
): Promise<InvestigationSession> {
  return service.createInvestigationSession({
    repoUrl: 'git@github.com:acme/app.git',
    ticket: 'APP-1',
    intent: 'investigate_only',
    driveToCompletion: false,
    ...overrides,
  });
}
