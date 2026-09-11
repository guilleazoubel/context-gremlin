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
import { JiraRestSource } from '../jira/jira-rest-source';
import { JiraScanner } from '../jira/jira-scanner';
import { JiraStore } from '../jira/jira-store';
import type { JiraSource } from '../jira/jira-source';
import { InventoryStore } from '../inventory/inventory-store';
import { createApiServer, type EngineInfo } from '../api/server';
import { EventRing, attachEventRing } from '../api/event-stream';
import { NodeSessionWatcher } from '../fs/node-session-watcher';
import type { SessionWatcher } from '../fs/session-watcher';
import { EnvironmentService } from '../env/environment-service';
import { AckStore } from '../attention/ack-store';
import { WorkItemService } from '../work/work-item-service';
import {
  AttentionService,
  PrSourceAdapter,
  SessionSourceAdapter,
} from '../attention/attention-service';
import type { LocalAppRunner } from '../env/local-app-runner';
import { ENGINE_NAME, ENGINE_VERSION } from '../version';

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
  /** Overrides the real recursive `fs.watch` over the sessions dir — a test seam. */
  sessionWatcher?: SessionWatcher;
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
  attention: AttentionService;
  workItems: WorkItemService;
  eventRing: EventRing;
  /** What `GET /version` reports and what `serve()` records in its `engine.json` lock — one object, so the two can never disagree. */
  engineInfo: EngineInfo;
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
  /**
   * Overrides the Jira source — a test/harness seam (D7 also allows pointing
   * `jira.baseUrl` at a stub server, which is what the integration harness
   * does). `null` forces R35's `notConfigured`.
   */
  jiraSource?: JiraSource | null;
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
  const attentionAcksPath = config.attentionAcksPath!;

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
      runnerKind: adapters.runnerKind,
      humanTurnTtlMs: config.humanTurnTtlMs,
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

  // R35: no `jira` block, or one with no token, is `notConfigured` — the
  // scanner is still wired, so the report shape is always the same, but it
  // has no source and therefore makes no request.
  const jiraSource: JiraSource | null =
    opts.jiraSource ??
    (config.jira !== undefined && config.jira.apiToken !== undefined && config.jira.apiToken !== ''
      ? new JiraRestSource({
          baseUrl: config.jira.baseUrl ?? config.jira.siteUrl,
          siteUrl: config.jira.siteUrl,
          email: config.jira.email,
          apiToken: config.jira.apiToken,
          timeoutMs: config.jira.timeoutMs,
          maxResults: config.jira.maxResults,
          extraFields: config.jira.extraFields,
        })
      : null);
  const jiraScanner = new JiraScanner({
    source: jiraSource,
    store: new JiraStore(adapters.fs, config.jiraCachePath!),
    jql: config.jira?.jql ?? '',
    scanBudgetMs: config.jira?.scanBudgetMs ?? 20_000,
    ...(config.jira?.maxResults !== undefined ? { maxResults: config.jira.maxResults } : {}),
    now: adapters.now,
  });
  const tick = new ReconciliationTick({ gh: adapters.gh, store, pipeline, events, lock, now: adapters.now });
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
      botLogins: config.botLogins,
      projectKeys: config.jira?.projectKeys ?? [],
    },
    now: adapters.now,
    jira: jiraScanner,
  });

  // The attention model: one adapter per source (R18), an ack store of its
  // own (R10), and a service that takes no session lock (MG-A3). It starts
  // nothing — `serve()` owns subscribing it, exactly as it owns every other
  // side effect buildEngine deliberately leaves out.
  // Every engine event feeds the replay ring exactly once, at build time, so
  // a client that connects later still replays what it missed.
  const eventRing = new EventRing();
  attachEventRing(events, eventRing);
  const sessionWatcher = adapters.sessionWatcher ?? new NodeSessionWatcher(sessionsDir);

  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({
        store,
        fs: adapters.fs,
        sessionsDir,
        isRunning: (id) => pipeline.activeSessionIds().includes(id),
        ...(environment ? { localStatus: () => environment.status() } : {}),
      }),
      new PrSourceAdapter({ inventory: inventoryStore }),
    ],
    acks: new AckStore(adapters.fs, attentionAcksPath),
    events,
    watcher: sessionWatcher,
    now: adapters.now,
  });

  // R1: a GROUPING over the attention items, never a second derivation, and
  // it takes no session lock (MG-1). `serve()` owns start()/stop(), exactly
  // as it does for AttentionService.
  const workItems = new WorkItemService({
    attention,
    inventory: inventoryStore,
    jira: jiraScanner,
    events,
    config: {
      me: config.me,
      watchAuthors: config.watchAuthors,
      showAllRepoPrs: config.showAllRepoPrs,
      projectKeys: config.jira?.projectKeys ?? [],
      botLogins: config.botLogins,
      ...(config.jira?.siteUrl !== undefined ? { jiraSiteUrl: config.jira.siteUrl } : {}),
    },
  });

  const tickable = opts.makeTickable
    ? opts.makeTickable({ gh: adapters.gh, store, pipeline, events, lock, inventoryStore, scanner })
    : scanner;
  const scheduler = new DiscoveryScheduler<ScanReport>(tickable, config.pollIntervalMs, adapters.clock);

  const engineInfo: EngineInfo = {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    pid: process.pid,
    startedAt: (adapters.now?.() ?? new Date()).toISOString(),
    socketPath: config.socketPath!,
  };

  const server = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: adapters.fs,
    sessionsDir,
    events,
    inventory: { scanner, scheduler, factory, inventoryStore, config: { me: config.me } },
    attention,
    workItems,
    eventRing,
    lock,
    config,
    engineInfo,
    ...(environment ? { environment } : {}),
  });

  return { server, scheduler, scanner, pipeline, events, store, lock, config, environment, attention, workItems, eventRing, engineInfo };
}
