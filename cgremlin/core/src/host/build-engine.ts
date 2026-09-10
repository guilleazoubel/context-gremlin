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
import { ReconciliationTick } from '../discovery/reconciliation';
import { DiscoveryScheduler, type Clock, type Tickable } from '../discovery/scheduler';
import { InventoryScanner, type ScanReport } from '../inventory/inventory-scanner';
import { InventoryStore } from '../inventory/inventory-store';
import { createApiServer } from '../api/server';
import { EnvironmentService } from '../env/environment-service';
import type { LocalAppRunner } from '../env/local-app-runner';

export interface EngineAdapters {
  fs: SessionFileSystem;
  git: GitRunner;
  gh: GhRunner;
  runner: AgentRunner;
  runnerKind: 'claude-code' | 'codex';
  /** Absent for a wiring with no local app: `Engine.environment` is then null and every stage behaves exactly as it did pre-Phase-5. */
  localApp?: LocalAppRunner;
  clock?: Clock;
  now?: () => Date;
  /** Where prereq checks read `HOME` and the required env vars from; defaults to the real process environment. */
  env?: NodeJS.ProcessEnv;
}

export interface Engine {
  server: http.Server;
  scheduler: DiscoveryScheduler<ScanReport>;
  scanner: InventoryScanner;
  pipeline: PipelineService;
  events: EngineEvents;
  store: SessionStore;
  lock: KeyedLock;
  config: CoreConfig;
  environment: EnvironmentService | null;
}

export interface TickableParts {
  gh: GhRunner;
  store: SessionStore;
  pipeline: PipelineService;
  events: EngineEvents;
  lock: KeyedLock;
  inventoryStore: InventoryStore;
  scanner: InventoryScanner;
}

export interface BuildEngineOptions {
  /**
   * Overrides what the scheduler ticks (default: the real `scanner` this
   * function always builds) — a test seam only. `Engine.scanner` and the
   * server's `inventory.scanner` are always the real InventoryScanner
   * regardless of this override, so a substitute here only affects what
   * `scheduler.runNow()`/the interval actually invoke.
   */
  makeTickable?: (parts: TickableParts) => Tickable<ScanReport>;
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
  const inventoryPath = config.inventoryPath!;

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
    lock,
  });
  const environment = adapters.localApp
    ? new EnvironmentService({
        fs: adapters.fs,
        gh: adapters.gh,
        git: adapters.git,
        local: adapters.localApp,
        config,
        sessionsDir,
        statePath: config.localAppStatePath!,
        // The SAME KeyedLock every other part shares, so `local-app:<port>`
        // is serialized engine-wide (API route, pipeline and boot reap alike).
        lock,
        env: adapters.env ?? process.env,
        now: adapters.now,
      })
    : null;
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
    lock,
    environment: environment ?? undefined,
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

  const inventoryStore = new InventoryStore(adapters.fs, inventoryPath);
  const tick = new ReconciliationTick({ gh: adapters.gh, store, pipeline, events, lock });
  const scanner = new InventoryScanner({
    gh: adapters.gh,
    store,
    inventoryStore,
    reconciler: { reconcile: () => tick.run() },
    events,
    config: {
      repos: config.repos,
      me: config.me,
      watchAuthors: config.watchAuthors,
      prListLimit: config.prListLimit,
    },
    now: adapters.now,
  });

  const tickable = opts.makeTickable
    ? opts.makeTickable({ gh: adapters.gh, store, pipeline, events, lock, inventoryStore, scanner })
    : scanner;
  const scheduler = new DiscoveryScheduler<ScanReport>(tickable, config.pollIntervalMs, adapters.clock);

  const server = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: adapters.fs,
    sessionsDir,
    events,
    inventory: { scanner, scheduler, factory, inventoryStore, config: { me: config.me } },
    lock,
    config,
    ...(environment ? { environment } : {}),
  });

  return { server, scheduler, scanner, pipeline, events, store, lock, config, environment };
}
