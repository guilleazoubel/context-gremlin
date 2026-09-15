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
import { PipelineService, isClaimed } from '../pipeline/pipeline-service';
import { ReviewSessionFactory } from '../pipeline/review-session-factory';
import { ReconciliationTick } from '../discovery/reconciliation';
import { DiscoveryScheduler, type Clock, type Tickable } from '../discovery/scheduler';
import { InventoryScanner, type ScanReport } from '../inventory/inventory-scanner';
import { JiraRestSource } from '../jira/jira-rest-source';
import { JiraScanner } from '../jira/jira-scanner';
import { JiraStore, TicketDetailCache, type TicketDetailResult } from '../jira/jira-store';
import { ReviewThreadScanner, ReviewThreadStore, threadCacheKey, type ReviewThreadCache } from '../gh/review-threads';
import { PrStateResolver, PrStateStore, prStateKey } from '../gh/pr-state';
import { RespondSessionFactory } from '../pipeline/respond-session-factory';
import { QaSessionFactory } from '../pipeline/qa-session-factory';
import { QaTriggerLeg, doneCategoryWarnings } from '../qa/qa-trigger';
import { awaitRunStart } from '../pipeline/run-start';
import { QaTriggerStore } from '../qa/qa-trigger-store';
import type { WorkItem as WorkItemForQa } from '../work/work-item';
import { PR_VIEW_FIELDS, failingChecks, parsePrView } from '../gh/pr-view';
import type { JiraSource } from '../jira/jira-source';
import { InventoryStore } from '../inventory/inventory-store';
import { createApiServer, type EngineInfo } from '../api/server';
import { ShutdownController } from '../api/shutdown';
import { EventRing, attachEventRing } from '../api/event-stream';
import { NodeSessionWatcher } from '../fs/node-session-watcher';
import type { SessionWatcher } from '../fs/session-watcher';
import { EnvironmentService } from '../env/environment-service';
import { AckStore } from '../attention/ack-store';
import { DismissStore } from '../attention/dismiss-store';
import { WorkItemService } from '../work/work-item-service';
import {
  AttentionService,
  PrSourceAdapter,
  SessionSourceAdapter,
} from '../attention/attention-service';
import type { LocalAppRunner } from '../env/local-app-runner';
import { ENGINE_BUILD_ID, ENGINE_BUILD_TIME, ENGINE_NAME, ENGINE_VERSION } from '../version';

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
  /**
   * R-shutdown: `POST /shutdown`'s decision, built here because the build time it orders by is
   * this same `engineInfo`'s. It is inert until `serve()` installs the graceful `close()` — a
   * wiring with no `close()` answers 404 rather than accepting a stop it could not perform.
   */
  shutdown: ShutdownController;
  /**
   * E7(a) — the configuration trap the QA trigger cannot fix: a
   * `jira.qaStatuses` entry Jira classifies as `Done` never reaches the
   * snapshot, so the trigger can never fire for it. Read from the cached
   * snapshot at boot and logged; the leg reports the same text on
   * `ScanReport.qa.warnings`.
   */
  qaDoneStatusWarnings: () => Promise<string[]>;
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
  /**
   * Overrides the ticket-detail reader — a test seam only, so a brief that
   * depends on the ticket text can be asserted without standing up a Jira.
   */
  ticketDetail?: { detail(key: string): Promise<TicketDetailResult> };
}

/** The artifacts an earlier session on this ticket may have left behind, in the order a reader wants them. */
const QA_PRIOR_ARTIFACTS = ['REVIEW.md', 'FINDINGS.md', 'PLAN.md', 'COMMENTS.md'] as const;

/**
 * The ABSOLUTE paths of every artifact that ACTUALLY EXISTS in a session
 * whose `lineage.ticket` is this ticket — the QA agent's "what we already
 * know". Existence-checked, so the brief never hands it a path into nothing,
 * and tolerant: an unreadable session store simply contributes nothing
 * rather than failing the run.
 */
async function priorArtifactsFor(
  fs: SessionFileSystem,
  store: SessionStore,
  sessionsDir: string,
  ticket: string | null,
  selfId: string,
): Promise<string[]> {
  if (ticket === null) return [];
  const sessions = await store.list().catch(() => []);
  const paths: string[] = [];
  for (const session of sessions) {
    if (session.id === selfId || session.lineage.ticket !== ticket) continue;
    for (const name of QA_PRIOR_ARTIFACTS) {
      const path = `${sessionsDir}/${session.id}/${name}`;
      if (await fs.exists(path)) paths.push(path);
    }
  }
  return paths;
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
      qaSkillCommand: config.qaSkillCommand,
      includeLiveUiCheck: config.includeLiveUiCheck,
      runnerKind: adapters.runnerKind,
      humanTurnTtlMs: config.humanTurnTtlMs,
    },
    now: adapters.now,
    lock,
    environment: environment ?? undefined,
    // R18: the engine fetches the ticket text; the agent never sees a
    // credential, and the `## Ticket` block is composed in exactly one place.
    /**
     * R50/R52 — everything the respond brief carries beyond the ticket: the
     * cached review threads, the per-reviewer states, the failing checks and
     * the diff summary. One read-only `gh pr view` per respond run, the same
     * call `RespondSessionFactory` already makes.
     */
    respondContext: async (session) => {
      const empty = {
        threads: [],
        reviews: [],
        reviewDecision: null,
        failingChecks: [],
        changedFiles: null,
        additions: null,
        deletions: null,
      };
      const pr = session.pr;
      if (pr === null) return empty;
      const cache: ReviewThreadCache = await threadScanner.cached().catch(() => ({}));
      const threads = cache[threadCacheKey(pr.repo, pr.number)]?.threads ?? [];
      const inventoryEntry = (await inventoryStore.load().catch(() => null))?.entries.find(
        (e) => e.repo === pr.repo && e.number === pr.number,
      );
      try {
        const { stdout } = await adapters.gh.run([
          'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', PR_VIEW_FIELDS,
        ]);
        const view = parsePrView(stdout);
        return {
          threads,
          reviews: view.latestReviews.map((r) => ({
            author: r.author.login,
            state: r.state,
            body: typeof r.body === 'string' ? r.body : null,
            submittedAt: r.submittedAt,
          })),
          reviewDecision: view.reviewDecision,
          failingChecks: failingChecks(view.statusCheckRollup ?? []),
          changedFiles: inventoryEntry?.changedFiles ?? null,
          additions: inventoryEntry?.additions ?? null,
          deletions: inventoryEntry?.deletions ?? null,
        };
      } catch {
        // A brief with the threads but no review summary still beats no run.
        return { ...empty, threads };
      }
    },
    /**
     * Phase 15 — everything the QA brief carries beyond the ticket. The user's
     * ask was that the verification agent "have access to the jira with the
     * ACs, the pr, and our review/findings/development files for reference",
     * so: the merged PR from the pr-state cache (NO new gh call — that cache
     * is exactly what survives a PR leaving the open-PR inventory), and the
     * ABSOLUTE PATHS of every artifact an earlier session on this same ticket
     * actually wrote. Paths, not contents: the agent reads what it needs and
     * the brief stays inside its cap. A file that is not there is simply
     * absent — never a path the agent would follow into nothing.
     */
    qaContext: async (session) => {
      const pr = session.pr;
      const base = {
        prRepo: pr?.repo ?? null,
        prNumber: pr?.number ?? null,
        // The factory records the MERGE commit here — the thing QA is
        // supposed to be running.
        mergeSha: pr?.headSha ?? null,
      };
      const cache = pr === null ? {} : await prStateResolver.cached().catch(() => ({}));
      const entry = pr === null ? undefined : cache[prStateKey(pr.repo, pr.number)];
      const change =
        pr === null
          ? null
          : {
              title: entry?.title ?? pr.title,
              author: entry?.author ?? pr.author,
              mergedAt: entry?.mergedAt ?? null,
              changedFiles: entry?.changedFiles ?? null,
              additions: entry?.additions ?? null,
              deletions: entry?.deletions ?? null,
              // The pr-state cache is a row, not a diff: the brief tells the
              // agent the three ways to read the file list itself.
              files: [],
            };
      return {
        ...base,
        change,
        priorArtifacts: await priorArtifactsFor(adapters.fs, store, sessionsDir, session.lineage.ticket, session.id),
      };
    },
    tickets: {
      forBrief: async (key) => {
        const { ticket } = await ticketDetail.detail(key);
        if (ticket === null) return null;
        return {
          key: ticket.key,
          summary: ticket.summary,
          status: ticket.status,
          url: ticket.url,
          descriptionText: ticket.descriptionText,
          comments: ticket.comments,
        };
      },
    },
  });
  const respondFactory = new RespondSessionFactory({
    gh: adapters.gh,
    store,
    workspace,
    events,
    worktreesDir,
    me: config.me,
    now: adapters.now,
  });
  const qaFactory = new QaSessionFactory({
    gh: adapters.gh,
    store,
    workspace,
    events,
    worktreesDir,
    defaultBaseRef: config.defaultBaseRef,
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
  const ticketDetail =
    opts.ticketDetail ??
    new TicketDetailCache({
      source: jiraSource,
      snapshot: () => jiraScanner.lastReport(),
      now: adapters.now,
    });
  const jiraProjectKeys = config.jira?.projectKeys ?? [];
  /**
   * R28 — every ticket key a PR branch or a session's lineage named, so the
   * scanner can fetch a summary for the ones the JQL never returned. Both
   * reads are unlocked and tolerant: a corrupt inventory or an unreadable
   * session simply seeds fewer keys, and the scan carries on.
   */
  const seededTicketKeys = async (): Promise<string[]> => {
    if (jiraProjectKeys.length === 0) return [];
    const keys = new Set<string>();
    const inventory = await inventoryStore.load().catch(() => null);
    // Already filtered by projectKeys at scan time (R29).
    for (const entry of inventory?.entries ?? []) for (const key of entry.ticketKeys) keys.add(key);
    // A session's lineage was written UNFILTERED, so it is filtered here.
    const sessions = await store.list().catch(() => []);
    for (const session of sessions) {
      const ticket = session.lineage.ticket;
      const project = ticket === null ? null : /^([A-Z][A-Z0-9]+)-\d+$/.exec(ticket)?.[1] ?? null;
      if (ticket !== null && project !== null && jiraProjectKeys.includes(project)) keys.add(ticket);
    }
    return [...keys];
  };
  const jiraScanner = new JiraScanner({
    source: jiraSource,
    store: new JiraStore(adapters.fs, config.jiraCachePath!),
    jql: config.jira?.jql ?? '',
    seededKeys: seededTicketKeys,
    scanBudgetMs: config.jira?.scanBudgetMs ?? 20_000,
    ...(config.jira?.maxResults !== undefined ? { maxResults: config.jira.maxResults } : {}),
    now: adapters.now,
  });
  const tick = new ReconciliationTick({ gh: adapters.gh, store, pipeline, events, lock, now: adapters.now });
  // R52 — the review-thread leg: the engine's first GraphQL call, cached on
  // the PR's `updatedAt` so a steady-state tick makes ZERO of them.
  const threadScanner = new ReviewThreadScanner({
    gh: adapters.gh,
    store: new ReviewThreadStore(adapters.fs, config.reviewThreadsCachePath!),
    scanBudgetMs: config.reviewThreads.scanBudgetMs,
    now: adapters.now,
  });
  // The pr-state leg: what happened to a PR that a session names and the
  // open-PR inventory no longer has. One `gh pr view` per unknown PR, once
  // ever (a merged/closed state is final and never re-fetched).
  const prStateResolver = new PrStateResolver({
    gh: adapters.gh,
    store: new PrStateStore(adapters.fs, config.prStatesCachePath!),
    projectKeys: config.jira?.projectKeys ?? [],
    now: adapters.now,
  });
  // Phase 15 — the QA verification leg. It reads work items through a THUNK
  // because `workItems` is built after the scanner, and it takes the SAME
  // `lock` the API server and the pipeline hold, on the same key
  // `handleItemAgents` takes, so a tick and a manual POST cannot both create.
  // Assigned once `workItems` exists, a few dozen lines below: the leg is a
  // constructor argument of the scanner, which is built first.
  let workItemsForQa: { list(): Promise<{ items: readonly WorkItemForQa[] }> } | null = null;
  // Gap 2 — the same store instance the leg writes attempts to, read back by
  // WorkItemService so an abandoned attempt shows up on `/items`.
  const qaTriggerStore = new QaTriggerStore(adapters.fs, config.qaVerificationsPath!, adapters.now);
  const qaTrigger = new QaTriggerLeg({
    gh: adapters.gh,
    store: qaTriggerStore,
    lock,
    items: async () => (await workItemsForQa?.list())?.items ?? [],
    jira: async () => {
      const report = await jiraScanner?.lastReport();
      return { ok: report?.kind === 'ok', me: report?.me ?? null };
    },
    config: {
      autoVerify: config.qa.autoVerify,
      maxAutoStartsPerTick: config.qa.maxAutoStartsPerTick,
      maxAttemptsPerEntry: config.qa.maxAttemptsPerEntry,
      scanBudgetMs: config.qa.scanBudgetMs,
      backfillOnFirstRun: config.qa.backfillOnFirstRun,
      qaStatuses: config.jira?.qaStatuses ?? [],
    },
    qaFor: (slug) => ({
      hasUrl: config.environments[slug]?.qa?.url !== undefined,
      hasTestIdentity: environment?.hasQaTestIdentity(`https://github.com/${slug}.git`) ?? false,
    }),
    qaHealth: async (slug) =>
      (await environment?.qaHealth(`https://github.com/${slug}.git`)) ?? {
        ok: false,
        reason: 'no environment service is configured',
      },
    sessions: {
      existingFor: async (ticket) => {
        const session = await qaFactory.existingFor(ticket);
        return session === null
          ? null
          : {
              id: session.id,
              stageStatus: session.stageStatus,
              claimed: isClaimed(session, adapters.now?.() ?? new Date()),
            };
      },
      activeSessionIds: () => pipeline.activeSessionIds(),
    },
    stopSession: async (id) => {
      await pipeline.stop(id);
    },
    closeSession: async (id) => {
      await pipeline.transition(id, 'closed');
    },
    qaRepos: () =>
      Object.entries(config.environments)
        .filter(([, env]) => env.qa?.url !== undefined)
        .map(([slug]) => slug),
    createSession: (ticket, slug, number) => qaFactory.createFromMergedPr(ticket, slug, number),
    startRun: (id) => awaitRunStart(events, id, pipeline.runVerify(id)),
    now: adapters.now,
  });
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
    threads: threadScanner,
    prStates: prStateResolver,
    qa: qaTrigger,
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
    threads: threadScanner,
    prStates: prStateResolver,
    dismissals: new DismissStore(adapters.fs, config.dismissalsPath!),
    events,
    now: adapters.now,
    qaTrigger: qaTriggerStore,
    config: {
      me: config.me,
      watchAuthors: config.watchAuthors,
      showAllRepoPrs: config.showAllRepoPrs,
      projectKeys: config.jira?.projectKeys ?? [],
      botLogins: config.botLogins,
      ...(config.jira?.siteUrl !== undefined ? { jiraSiteUrl: config.jira.siteUrl } : {}),
    },
  });

  // The thunk the QA leg reads work items through — see its declaration above.
  workItemsForQa = workItems;

  const tickable = opts.makeTickable
    ? opts.makeTickable({ gh: adapters.gh, store, pipeline, events, lock, inventoryStore, scanner })
    : scanner;
  const scheduler = new DiscoveryScheduler<ScanReport>(tickable, config.pollIntervalMs, adapters.clock);

  const engineInfo: EngineInfo = {
    name: ENGINE_NAME,
    version: ENGINE_VERSION,
    buildId: ENGINE_BUILD_ID,
    buildTime: ENGINE_BUILD_TIME,
    pid: process.pid,
    startedAt: (adapters.now?.() ?? new Date()).toISOString(),
    socketPath: config.socketPath!,
  };

  const shutdown = new ShutdownController(engineInfo.buildTime);

  const server = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: adapters.fs,
    sessionsDir,
    events,
    git: adapters.git,
    inventory: { scanner, scheduler, factory, inventoryStore, config: { me: config.me } },
    attention,
    workItems,
    ticketDetail,
    respondFactory,
    qaFactory,
    now: adapters.now,
    eventRing,
    lock,
    config,
    engineInfo,
    shutdown,
    ...(environment ? { environment } : {}),
  });

  /**
   * E7(a) — read at BOOT, from the cached snapshot, so the trap that makes
   * the QA trigger silently inert is said out loud somewhere a human looks.
   * Tolerant: no cache, no Jira, no warning.
   */
  const qaDoneStatusWarnings = async (): Promise<string[]> => {
    const report = await jiraScanner.lastReport().catch(() => null);
    if (report === null || report.kind !== 'ok') return [];
    return doneCategoryWarnings(config.jira?.qaStatuses ?? [], report.issues);
  };

  return { server, scheduler, scanner, pipeline, events, store, lock, config, environment, attention, workItems, eventRing, engineInfo, shutdown, qaDoneStatusWarnings };
}
