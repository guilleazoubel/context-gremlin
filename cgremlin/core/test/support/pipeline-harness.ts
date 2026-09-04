import { InMemoryFileSystem } from './in-memory-file-system';
import { FakeGitRunner } from './fake-git-runner';
import { FakeAgentRunner } from './fake-agent-runner';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { EngineEvents } from '../../src/engine/events';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { PipelineService, type CreateInvestigationInput, type PipelineConfig } from '../../src/pipeline/pipeline-service';
import { KeyedLock } from '../../src/api/keyed-lock';
import type { AgentExitResult } from '../../src/agent/agent-runner';
import type { InvestigationSession } from '../../src/schema/session';

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

export function createHarness(): PipelineHarness {
  const fs = new InMemoryFileSystem();
  const git = new FakeGitRunner();
  const store = new SessionStore(fs, SESSIONS_DIR);
  const workspace = new WorkspaceManager(git, fs, MIRRORS_DIR);
  const runner = new FakeAgentRunner();
  const events = new EngineEvents();
  const lock = new KeyedLock();
  const stageRunner = new StageRunner({
    runner,
    store,
    fs,
    events,
    sessionsDir: SESSIONS_DIR,
    runnerKind: 'claude-code',
    now: FIXED_NOW,
    lock,
  });
  const config: PipelineConfig = {
    sessionsDir: SESSIONS_DIR,
    worktreesDir: WORKTREES_DIR,
    defaultBaseRef: 'origin/main',
  };
  const service = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs,
    git,
    events,
    config,
    now: FIXED_NOW,
    lock,
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

  return { fs, git, store, workspace, runner, events, stageRunner, service, lock, finishRun };
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
