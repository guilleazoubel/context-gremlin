import type http from 'node:http';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { GitRunner } from '../git/git-runner';
import type { GhRunner } from '../gh/gh-runner';
import type { AgentRunner } from '../agent/agent-runner';
import type { CoreConfig } from '../config/core-config';
import { SessionStore } from '../engine/session-store';
import { WorkspaceManager } from '../workspace/workspace-manager';
import { EngineEvents } from '../engine/events';
import { KeyedLock } from '../api/keyed-lock';
import { StageRunner } from '../pipeline/stage-runner';
import { PipelineService } from '../pipeline/pipeline-service';
import { ReviewSessionFactory } from '../pipeline/review-session-factory';
import { DefaultPRDiscoveryStrategy } from '../discovery/pr-discovery-strategy';
import { ReconciliationTick } from '../discovery/reconciliation';
import type { DiscoveryConfig } from '../discovery/discovery-config';
import { DiscoveryScheduler, type Clock, type Tickable } from '../discovery/scheduler';
import { createApiServer } from '../api/server';

export interface EngineAdapters {
  fs: SessionFileSystem;
  git: GitRunner;
  gh: GhRunner;
  runner: AgentRunner;
  runnerKind: 'claude-code' | 'codex';
  clock?: Clock;
  now?: () => Date;
}

// Stream A's InventoryScanner isn't merged yet; `scanner` holds whatever
// `makeTickable` produces (the existing ReconciliationTick by default, via a
// thin adapter carrying a `lastReport` stub) so B4 can swap in the real
// InventoryScanner — which has the same run()/lastReport shape — as a
// one-line change to the default below, with no changes to serve()/tests.
export type ScannerLike = Tickable & { lastReport: unknown };

export interface Engine {
  server: http.Server;
  scheduler: DiscoveryScheduler;
  scanner: ScannerLike;
  pipeline: PipelineService;
  events: EngineEvents;
  store: SessionStore;
  lock: KeyedLock;
  config: CoreConfig;
}

export interface TickableParts {
  gh: GhRunner;
  store: SessionStore;
  factory: ReviewSessionFactory;
  pipeline: PipelineService;
  events: EngineEvents;
  lock: KeyedLock;
  discoveryConfig: DiscoveryConfig;
}

export interface BuildEngineOptions {
  makeTickable?: (parts: TickableParts) => ScannerLike;
}

function defaultMakeTickable(parts: TickableParts): ScannerLike {
  const strategy = new DefaultPRDiscoveryStrategy(parts.gh);
  const tick = new ReconciliationTick({
    gh: parts.gh,
    store: parts.store,
    strategy,
    factory: parts.factory,
    pipeline: parts.pipeline,
    events: parts.events,
    config: parts.discoveryConfig,
    lock: parts.lock,
  });
  return { run: () => tick.run(), lastReport: null };
}

/**
 * Pure wiring: builds every engine part sharing one KeyedLock/EngineEvents,
 * but starts no timers and does not listen on any socket — see `serve()` for
 * the side-effecting half.
 */
export function buildEngine(config: CoreConfig, adapters: EngineAdapters, opts: BuildEngineOptions = {}): Engine {
  // Guaranteed populated by resolveCoreConfig/loadCoreConfig (Task B1) by the
  // time a CoreConfig reaches buildEngine; only the zod schema itself leaves
  // them optional, to allow a raw, not-yet-resolved config as input to that.
  const sessionsDir = config.sessionsDir!;
  const worktreesDir = config.worktreesDir!;
  const mirrorsDir = config.mirrorsDir!;

  const store = new SessionStore(adapters.fs, sessionsDir);
  const workspace = new WorkspaceManager(adapters.git, adapters.fs, mirrorsDir);
  const events = new EngineEvents();
  const lock = new KeyedLock();
  const stageRunner = new StageRunner({
    runner: adapters.runner,
    store,
    fs: adapters.fs,
    events,
    sessionsDir,
    runnerKind: adapters.runnerKind,
    now: adapters.now,
  });
  const pipeline = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs: adapters.fs,
    git: adapters.git,
    events,
    config: {
      sessionsDir,
      worktreesDir,
      defaultBaseRef: config.defaultBaseRef,
      reviewSkillCommand: config.reviewSkillCommand,
      includeLiveUiCheck: config.includeLiveUiCheck,
    },
    now: adapters.now,
  });
  const factory = new ReviewSessionFactory({
    gh: adapters.gh,
    store,
    workspace,
    events,
    sessionsDir,
    worktreesDir,
    now: adapters.now,
  });

  const discoveryConfig: DiscoveryConfig = {
    repos: config.repos,
    watchAuthors: config.watchAuthors,
    me: config.me,
    pollIntervalMs: config.pollIntervalMs,
    prListLimit: config.prListLimit,
  };

  const makeTickable = opts.makeTickable ?? defaultMakeTickable;
  const scanner = makeTickable({ gh: adapters.gh, store, factory, pipeline, events, lock, discoveryConfig });
  const scheduler = new DiscoveryScheduler(scanner, config.pollIntervalMs, adapters.clock);

  const server = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: adapters.fs,
    sessionsDir,
    events,
    discovery: { scheduler, config: discoveryConfig },
    lock,
  });

  return { server, scheduler, scanner, pipeline, events, store, lock, config };
}
