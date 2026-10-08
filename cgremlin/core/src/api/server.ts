import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionStore } from '../engine/session-store';
import type { GitRunner } from '../git/git-runner';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { PipelineService } from '../pipeline/pipeline-service';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { EngineEvents } from '../engine/events';
import type { Session } from '../schema/session';
import { KeyedLock } from './keyed-lock';
import { mapErrorToHttp } from './http-errors';
import {
  parseArtifactName,
  parseCreateDevelopmentRequest,
  parseCreateInvestigationRequest,
  parseCreateWorkspaceRequest,
  parseRemoveWorkspaceRequest,
  parseRunStageRequest,
  ValidationError,
} from './validation';
import { assertWorktreeNotInUse, TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { ArtifactNotFoundError, pickPrimaryArtifact, type ArtifactListing } from './artifacts';
import type { DiscoveryScheduler } from '../discovery/scheduler';
import { awaitRunStart } from '../pipeline/run-start';
import type { InventoryScanner, ScanReport } from '../inventory/inventory-scanner';
import type { InventoryStore } from '../inventory/inventory-store';
import { groupInventory, type Inventory, type InventoryEntry } from '../inventory/inventory';
import type { ReviewSessionFactory, CandidatePR } from '../pipeline/review-session-factory';
import type { RespondSessionFactory } from '../pipeline/respond-session-factory';
import type { QaSessionFactory } from '../pipeline/qa-session-factory';
import type { QaDiscoverResult } from '../qa/qa-trigger';
import { isClaimed, UnsupportedStageError } from '../pipeline/pipeline-service';
import type { EnvironmentService, LocalAppStatus } from '../env/environment-service';
import { redactSecrets, redactCoreConfig, type CoreConfig } from '../config/core-config';
import { handleEventStream, type EventRing } from './event-stream';
import type { WorkItemService } from '../work/work-item-service';
import type { WorkItem, WorkListKind } from '../work/work-item';
import { WORK_LIST_KINDS } from '../work/work-item';
import { parseWorkItemPath, type ParsedWorkItemId } from '../work/work-item-id';
import type { AttentionService } from '../attention/attention-service';
import { ITEM_SOURCES, parseItemRef, prRef, sessionRef, type ItemRef, type ItemSource } from '../attention/item-ref';
import { OwnPrError } from '../gh/own-pr-error';
import { resolveApprovalTarget, type PrApprover } from '../gh/pr-approval';
import { parsePrUrl } from '../gh/pr-url';
import { computeSessionChanges } from './session-changes';
import { parseShutdownRequest, type ShutdownController } from './shutdown';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(`Invalid JSON request body: ${(err as Error).message}`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export interface ApiServerDeps {
  sessionStore: SessionStore;
  workspaceManager: WorkspaceManager;
  pipeline: PipelineService;
  fs: SessionFileSystem;
  sessionsDir: string;
  events: EngineEvents;
  inventory?: {
    scanner: InventoryScanner;
    scheduler: DiscoveryScheduler<ScanReport>;
    factory: ReviewSessionFactory;
    inventoryStore: InventoryStore;
    config: { me: string };
  };
  lock?: KeyedLock;
  /** Absent for a wiring with no local-app adapter: every /local route then 404s. */
  environment?: EnvironmentService;
  /** Absent for a wiring with no attention model: every /attention route (and both ack aliases) then 404s. */
  attention?: AttentionService;
  /** The work-item layer (Phase 9). Absent leaves every `/items` route a clean 404. */
  workItems?: WorkItemService;
  /** R36 — the 60 s / `updated`-keyed ticket detail cache. Absent means `ticket: null`, never a 5xx. */
  ticketDetail?: { detail(key: string): Promise<{ ticket: unknown; ticketError: string | null }> };
  /**
   * Phase 18 — R84's per-entry PR lookup, reachable deliberately:
   * `POST /items/ticket/<KEY>/prs/discover`. Absent makes that route a clean 404, and the
   * panel's disabled QA verb then simply offers no discovery.
   */
  qaDiscovery?: { discover(ticketKey: string): Promise<QaDiscoverResult> };
  /** R51 — the respond-mode factory. Absent makes `{ mode: 'respond' }` a clean 404. */
  respondFactory?: RespondSessionFactory;
  /**
   * The HUMAN's approval on a reviewed pull request — the one GitHub write no
   * agent may make. Absent makes `POST /sessions/:id/approve-pr` a clean 404,
   * exactly like every other optional capability here.
   */
  prApprover?: PrApprover;
  /** Phase 15 — absent means QA verification is not configured on this wiring (404, exactly like respond). */
  qaFactory?: QaSessionFactory;
  /**
   * The clock the claim check reads. It MUST be the same one PipelineService
   * uses, or the route and the run disagree about whether a claim is live —
   * the route would try to restart and the run would answer 409.
   */
  now?: () => Date;
  /** Absent for a wiring with no event ring: GET /events then 404s. */
  eventRing?: EventRing;
  /** Absent for a wiring built without one (every test server that doesn't need it): `GET /config` then 404s. */
  config?: CoreConfig;
  /**
   * R1/R21: the identity `GET /version` reports. Captured once, at build
   * time — `activeRuns` is the only part of that body computed per request.
   * Absent for a wiring built without one: `GET /version` then 404s.
   */
  engineInfo?: EngineInfo;
  /**
   * R-shutdown: the stop the engine may refuse. Built by `buildEngine`, armed by `serve()` with
   * the graceful `close()`; absent or unarmed leaves `POST /shutdown` a clean 404, because an
   * engine with nothing wired to close it must never accept a stop it cannot perform.
   */
  shutdown?: ShutdownController;
  /** R-changes (Phase 10) — `GET /sessions/:id/changes`. Absent leaves that route a clean 404. */
  git?: GitRunner;
}

/** The identity a running engine reports on `GET /version` and records in its `engine.json` lock. */
export interface EngineInfo {
  name: string;
  version: string;
  /**
   * A content address of the engine bundle, stamped in by `scripts/build-engine.mjs`, or `dev`
   * for an engine that was never bundled. The version string is the package's and does not move
   * between phases; this does, which is what lets the extension tell a stale engine from its own.
   */
  buildId: string;
  /**
   * When that bundle was built (ISO), or null for an engine that was never bundled. The build id
   * says whether two engines are the same; only this says which of them is newer — the question a
   * window has to answer before it may replace the engine another window is also using.
   */
  buildTime: string | null;
  pid: number;
  startedAt: string;
  socketPath: string;
}

// Re-exported (not redefined) so every existing importer keeps working while
// ReviewSessionFactory can throw the same class without importing the server.
export { OwnPrError } from '../gh/own-pr-error';

export class NoScanYetError extends Error {
  constructor() {
    super('no inventory scan has been run yet');
    this.name = 'NoScanYetError';
  }
}

type InventoryDeps = NonNullable<ApiServerDeps['inventory']>;

async function loadCurrentInventory(inv: InventoryDeps): Promise<Inventory | null> {
  return inv.scanner.lastReport?.inventory ?? (await inv.inventoryStore.load());
}

function findEntry(inv: Inventory, repo: string, number: number): InventoryEntry | undefined {
  return inv.entries.find((e) => e.repo === repo && e.number === number);
}

// Shared by both review-session entry points (POST /reviews and POST
// /prs/:owner/:repo/:n/review): a session already tracking this PR is
// restarted when it is not genuinely live — queued, failed, or a
// 'reviewing' session whose lastRun is not actually in activeSessionIds
// (the on-disk state left behind by a crashed host) — and left alone (200)
// only when it truly is live already. Both routes must reach identical
// conclusions for the same session state.
async function respondForExistingReviewSession(
  res: ServerResponse,
  deps: ApiServerDeps,
  existing: Session,
): Promise<void> {
  // Phase 18: the ONE predicate. A session whose file still says `running`
  // while the runner holds nothing is a CRASHED run, not a live one.
  const isLive = deps.pipeline.runLivenessOf(existing) === 'live';
  if (!isLive) {
    if (existing.stageStatus === 'queued' || existing.stageStatus === 'failed') {
      // 0c: a run the preflight blocked is not started — say so (200, started:false).
      const started = await awaitRunStart(deps.events, existing.id, deps.pipeline.runReview(existing.id));
      const session = await deps.sessionStore.load(existing.id);
      sendJson(res, started ? 202 : 200, { session, created: false, started });
      return;
    }
    if (existing.stageStatus === 'reviewing') {
      // No live run for a session that claims to be 'reviewing' means the
      // host crashed mid-run — the on-disk phase is stale. Mark it failed
      // (a legal transition from 'reviewing') before restarting, rather
      // than leaving it stuck forever or silently resuming as if nothing
      // happened.
      await deps.pipeline.transition(existing.id, 'failed');
      // 0c: a run the preflight blocked is not started — say so (200, started:false).
      const started = await awaitRunStart(deps.events, existing.id, deps.pipeline.runReview(existing.id));
      const session = await deps.sessionStore.load(existing.id);
      sendJson(res, started ? 202 : 200, { session, created: false, started });
      return;
    }
  }
  sendJson(res, 200, { session: existing, created: false, started: false });
}

async function handleReviewStart(
  res: ServerResponse,
  deps: ApiServerDeps,
  inv: InventoryDeps,
  repoSlug: string,
  number: number,
  /** Phase 10 — only `POST /items/<path>/agents` with `{ selfReview: true }` sets this; every other caller keeps OwnPrError. */
  selfReview = false,
): Promise<void> {
  const inventory = await loadCurrentInventory(inv);
  if (!inventory) throw new NoScanYetError();
  const entry = findEntry(inventory, repoSlug, number);
  if (!entry) {
    sendJson(res, 404, { error: `PR ${repoSlug}#${number} is not in the current inventory` });
    return;
  }
  // Re-check against the live config rather than trusting entry.isMine (a
  // snapshot from whenever the inventory was last scanned) — the same
  // never-trust-a-stale-snapshot reasoning as the fresh session lookup below.
  if (!selfReview && entry.author.toLowerCase() === inv.config.me.toLowerCase()) {
    throw new OwnPrError(repoSlug, number);
  }

  const sessions = await deps.sessionStore.list();
  const existing = sessions.find(
    (s) =>
      s.mode === 'review' &&
      !TERMINAL_PHASES_BY_MODE.review.has(s.stageStatus) &&
      s.pr !== null &&
      s.pr.repo === repoSlug &&
      s.pr.number === number,
  );

  if (existing) {
    await respondForExistingReviewSession(res, deps, existing);
    return;
  }

  const candidate: CandidatePR = {
    kind: selfReview ? 'own' : 'review',
    repo: repoSlug,
    number,
    url: entry.url,
    author: entry.author,
    isDraft: entry.isDraft,
    reviewDecision: entry.reviewDecision,
    headSha: entry.headSha,
    title: entry.title,
  };
  const created = await inv.factory.createFromCandidate(candidate);
  const started = await awaitRunStart(deps.events, created.id, deps.pipeline.runReview(created.id));
  const session = await deps.sessionStore.load(created.id);
  sendJson(res, started ? 202 : 200, { session, created: true, started });
}


/**
 * R15 — `POST /items/<path>/agents`, composing the EXISTING creation paths
 * rather than inventing a second one, and under the SAME
 * `pr:<slug>#<n>` lock key the review routes take, so it cannot race
 * `POST /prs/…/review` or `POST /reviews`.
 */
async function handleItemAgents(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  lock: KeyedLock,
  item: WorkItem,
  request: AgentsRequest,
): Promise<void> {
  const pr = item.prs[0];

  if (request.mode === 'review') {
    if (pr === undefined) {
      throw new ValidationError('Invalid agent request: mode review requires an item with a pull request');
    }
    if (!deps.inventory) {
      sendJson(res, 404, { error: 'inventory not configured' });
      return;
    }
    const inv = deps.inventory;
    const selfReview = request.selfReview === true;
    await lock.withLock(`pr:${pr.repo}#${pr.number}`, () =>
      handleReviewStart(res, deps, inv, pr.repo, pr.number, selfReview),
    );
    return;
  }

  if (request.mode === 'respond') {
    // R51: only on a `pr/…` path, and only when the PR is mine. A 400 on an
    // item with no PR; a 409 (NotMyPrError) on somebody else's.
    if (pr === undefined) {
      throw new ValidationError('Invalid agent request: mode respond requires an item with a pull request');
    }
    if (!deps.respondFactory) {
      sendJson(res, 404, { error: 'respond mode not configured' });
      return;
    }
    const factory = deps.respondFactory;
    // The SAME lock key the review path takes (`server.ts`'s
    // `pr:<slug>#<n>`), so a respond start cannot race a review start on the
    // same PR and two concurrent posts yield one session.
    await lock.withLock(`pr:${pr.repo}#${pr.number}`, async () => {
      const existing = await factory.existingFor(pr.repo, pr.number);
      if (existing !== null) {
        // R51's parity rule, the same one POST /reviews has: never a second
        // session, and a RESTART on a recomposed brief — unless a run is
        // already in flight or the session is claimed, which is what stops
        // two agents writing one COMMENTS.md.
        if (deps.pipeline.runLivenessOf(existing) === 'live') {
          sendJson(res, 200, {
            session: existing,
            created: false,
            started: false,
            reason: 'a respond run is already in flight for this session',
            item,
          });
          return;
        }
        if (isClaimed(existing, deps.now ? deps.now() : new Date())) {
          sendJson(res, 200, {
            session: existing,
            created: false,
            started: false,
            reason: 'a human holds the conversation claim on this session',
            item,
          });
          return;
        }
        const started = await awaitRunStart(deps.events, existing.id, deps.pipeline.runRespond(existing.id));
        sendJson(res, started ? 202 : 200, {
          session: await deps.sessionStore.load(existing.id),
          created: false,
          started,
          item,
        });
        return;
      }
      const created = await factory.createFromPr(pr.repo, pr.number);
      // R56: the click that creates the session STARTS the run. The user's
      // click on a lit waitingForReview row IS the explicit ask (Phase 7 R5),
      // and anything else hands them a session with an empty BRIEF.md and a
      // second button to press.
      const started = await awaitRunStart(deps.events, created.id, deps.pipeline.runRespond(created.id));
      sendJson(res, started ? 202 : 200, {
        session: await deps.sessionStore.load(created.id),
        created: true,
        started,
        item,
      });
    });
    return;
  }

  if (request.mode === 'qa') {
    if (pr === undefined) {
      throw new ValidationError('Invalid agent request: mode qa requires an item whose pull request has merged');
    }
    if (!deps.qaFactory) {
      sendJson(res, 404, { error: 'qa mode not configured' });
      return;
    }
    const factory = deps.qaFactory;
    const ticket = item.ticket?.key ?? null;
    if (ticket === null) {
      throw new ValidationError('Invalid agent request: mode qa requires an item with a ticket');
    }
    const shouldStart = request.start ?? true;
    // R70 puts QA off the ladder, but the LOCK stays on the ladder's key:
    // `pr:<slug>#<n>` is what the review and respond routes take and what
    // the automatic leg takes, so a click and a tick cannot both create.
    await lock.withLock(`pr:${pr.repo}#${pr.number}`, async () => {
      const existing = await factory.existingFor(ticket);
      const session = existing ?? (await factory.createFromMergedPr(ticket, pr.repo, pr.number));
      const created = existing === null;
      if (existing !== null) {
        // The parity rule, verbatim from respond: never a second session,
        // and never a second agent writing one QA.md.
        if (deps.pipeline.runLivenessOf(existing) === 'live') {
          sendJson(res, 200, {
            session: existing, created: false, started: false,
            reason: 'a qa run is already in flight for this session', item,
          });
          return;
        }
        if (isClaimed(existing, deps.now ? deps.now() : new Date())) {
          sendJson(res, 200, {
            session: existing, created: false, started: false,
            reason: 'a human holds the conversation claim on this session', item,
          });
          return;
        }
      }
      if (!shouldStart) {
        // R73: no run, but BRIEF.md must exist — `Chat` lights up the moment
        // the session does, and an empty session directory is a dead end.
        await deps.pipeline.prepareQaSession(session.id);
        sendJson(res, 200, {
          session: await deps.sessionStore.load(session.id), created, started: false, item,
        });
        return;
      }
      const started = await awaitRunStart(deps.events, session.id, deps.pipeline.runVerify(session.id));
      sendJson(res, started ? 202 : 200, {
        session: await deps.sessionStore.load(session.id), created, started, item,
      });
    });
    return;
  }

  // investigation | development: a Jira ticket does not know which repo it
  // belongs to, and guessing would create a worktree in the wrong place.
  const repoUrl = request.repoUrl ?? (pr !== undefined ? `https://github.com/${pr.repo}.git` : undefined);
  if (repoUrl === undefined) {
    throw new ValidationError(
      'Invalid agent request: repoUrl is required for a ticket-only item (the ticket does not name a repo)',
    );
  }
  const ticket = item.ticket?.key ?? null;
  if (request.mode === 'investigation') {
    const session = await deps.pipeline.createInvestigationSession({
      repoUrl,
      ticket,
      intent: request.intent ?? 'investigate_only',
      driveToCompletion: request.driveToCompletion ?? false,
    });
    // Phase 7 R5: the run is EXPLICIT — this POST is the ask.
    await awaitRunStart(deps.events, session.id, deps.pipeline.runFindings(session.id));
    sendJson(res, 202, {
      session: await deps.sessionStore.load(session.id),
      created: true,
      started: true,
      item,
    });
    return;
  }
  const session = await deps.pipeline.createDevelopmentSession({ repoUrl, ticket });
  await awaitRunStart(deps.events, session.id, deps.pipeline.runDevelop(session.id));
  sendJson(res, 202, {
    session: await deps.sessionStore.load(session.id),
    created: true,
    started: true,
    item,
  });
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const lock = deps.lock ?? new KeyedLock();
  return http.createServer((req, res) => {
    void handleRequest(req, res, deps, lock);
  });
}

async function respondAfterRunStarted(
  res: ServerResponse,
  deps: ApiServerDeps,
  id: string,
  guard: Promise<unknown>,
): Promise<void> {
  // The HTTP response goes out once the run has *started*, not once the full
  // agent turn has finished; the turn keeps running in the background.
  // 0c: a run the preflight blocked resolves WITHOUT ever starting — that is a
  // completed request (the session now says needs-input), so it answers 200,
  // not 202 "accepted, running".
  const started = await awaitRunStart(deps.events, id, guard);
  const session = await deps.sessionStore.load(id);
  sendJson(res, started ? 202 : 200, { session });
}

async function handlePromote(res: ServerResponse, deps: ApiServerDeps, id: string): Promise<void> {
  const guard = deps.pipeline.promote(id);
  guard.catch(() => undefined);
  // The development session's id isn't known until promote() creates it, so
  // (unlike the other detached routes) we can't filter run.started by id in
  // advance. events is shared server-wide, so another session's promote or
  // run can legitimately fire run.started while this one is in flight —
  // filter on shape instead: the development session promote(id) itself
  // creates, i.e. mode 'development' with lineage.parentSessionId === id.
  let devId: string | undefined;
  let off: () => void = () => {};
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        off = deps.events.on('run.started', (e) => {
          if (e.session.mode === 'development' && e.session.lineage.parentSessionId === id) {
            devId = e.session.id;
            resolve();
          }
        });
      }),
      guard,
    ]);
  } finally {
    off();
  }
  if (!devId) {
    // stageRunner.run always emits run.started before the promote() promise
    // it's nested inside can possibly resolve, so this should be
    // unreachable — guard defensively rather than asserting non-null.
    throw new Error(`promote(${id}): no development run.started observed`);
  }
  const investigation = await deps.sessionStore.load(id);
  const development = await deps.sessionStore.load(devId);
  sendJson(res, 202, { investigation, development });
}

async function handleArtifactRead(
  res: ServerResponse,
  deps: ApiServerDeps,
  id: string,
  rawName: string,
): Promise<void> {
  const name = parseArtifactName(rawName);
  await deps.sessionStore.load(id); // SessionNotFoundError -> 404 for an unknown session
  const filePath = `${deps.sessionsDir}/${id}/${name}`;
  if (!(await deps.fs.exists(filePath))) {
    throw new ArtifactNotFoundError(id, name);
  }
  // Belt-and-braces, exactly like `localStatusHttp`: an artifact is written
  // by an AGENT, and Phase 15's QA agent talks to a real app with real
  // headers and cookies. Redact on the way out rather than trusting every
  // future agent never to paste one in.
  const content = redactSecrets(await deps.fs.readFile(filePath));
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(content);
}

/**
 * The artifact listing. The name filter is `parseArtifactName` itself, called
 * in a try/catch — there is deliberately no second allow-list, so widening
 * what is listable stays a one-regex edit in src/api/validation.ts and can
 * never drift from what the single-artifact read accepts.
 */
async function handleArtifactList(res: ServerResponse, deps: ApiServerDeps, id: string): Promise<void> {
  const session = await deps.sessionStore.load(id); // SessionNotFoundError -> 404
  const sessionDir = `${deps.sessionsDir}/${id}`;
  let names: string[];
  try {
    names = await deps.fs.readdir(sessionDir);
  } catch {
    // A session whose directory was never created (nothing has run yet) has
    // no artifacts — not an error.
    names = [];
  }
  const artifacts: ArtifactListing[] = [];
  for (const name of [...names].sort()) {
    try {
      parseArtifactName(name);
    } catch {
      continue;
    }
    const filePath = `${sessionDir}/${name}`;
    const mtimeMs = await deps.fs.statMtimeMs(filePath);
    if (mtimeMs === null) continue;
    let content: string;
    try {
      content = await deps.fs.readFile(filePath);
    } catch {
      // An allow-listed name that isn't a readable file (a directory, say):
      // omit it rather than failing the whole listing.
      continue;
    }
    artifacts.push({ name, mtime: new Date(mtimeMs).toISOString(), size: Buffer.byteLength(content, 'utf8') });
  }
  sendJson(res, 200, { artifacts, primary: pickPrimaryArtifact(session, artifacts) });
}

/** The same listing as the route above, as a VALUE — what `GET /items/<path>` returns per agent. */
async function collectArtifacts(deps: ApiServerDeps, id: string): Promise<ArtifactListing[]> {
  const sessionDir = `${deps.sessionsDir}/${id}`;
  let names: string[];
  try {
    names = await deps.fs.readdir(sessionDir);
  } catch {
    return [];
  }
  const artifacts: ArtifactListing[] = [];
  for (const name of [...names].sort()) {
    try {
      parseArtifactName(name);
    } catch {
      continue;
    }
    const filePath = `${sessionDir}/${name}`;
    const mtimeMs = await deps.fs.statMtimeMs(filePath);
    if (mtimeMs === null) continue;
    let content: string;
    try {
      content = await deps.fs.readFile(filePath);
    } catch {
      continue;
    }
    artifacts.push({ name, mtime: new Date(mtimeMs).toISOString(), size: Buffer.byteLength(content, 'utf8') });
  }
  return artifacts;
}

/**
 * 'unavailable' is how EnvironmentService reports a precondition failure it
 * degraded on (busy port, missing prereq, app never answered) — the same
 * class of thing `mapErrorToHttp` turns into a 409, so the status drives the
 * code rather than an exception.
 */
function localStatusHttp(status: LocalAppStatus): { code: number; body: unknown } {
  // Belt and braces: EnvironmentService already redacts what it hands back,
  // and redaction is idempotent, so no bypass URL can leave through here.
  const safe: LocalAppStatus = {
    ...status,
    reason: status.reason === null ? null : redactSecrets(status.reason),
    logTail: status.logTail === null ? null : redactSecrets(status.logTail),
  };
  return status.state === 'unavailable'
    ? { code: 409, body: { error: safe.reason ?? 'the local app is unavailable', status: safe } }
    : { code: 200, body: { status: safe } };
}

function sendLocalStatus(res: ServerResponse, status: LocalAppStatus): void {
  const { code, body } = localStatusHttp(status);
  sendJson(res, code, body);
}

/**
 * The /local routes. The session-scoped forms load the session first, so an
 * unknown id is a 404 before anything touches a process; the id-less forms
 * (`GET /local`, `POST /local/stop`) address whichever session currently owns
 * the app, which is what `cgremlin-core local status|stop` needs with no
 * argument. start/stop take the per-session lock so a second concurrent call
 * queues instead of racing; EnvironmentService additionally serializes on
 * `local-app:<port>`, and neither of those keys is the other, so no nesting
 * deadlock is possible.
 */
async function handleLocalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  lock: KeyedLock,
  environment: EnvironmentService,
  url: URL,
  method: string | undefined,
  id: string | null,
  action: 'status' | 'start' | 'stop',
): Promise<boolean> {
  if (action === 'status' && method !== 'GET') return false;
  if (action !== 'status' && method !== 'POST') return false;

  if (id === null) {
    if (action === 'start') return false; // starting always names a session
    sendLocalStatus(res, action === 'status' ? await environment.status() : await environment.stop());
    return true;
  }

  const session = await deps.sessionStore.load(id);
  if (action === 'status') {
    const status = await environment.status();
    // W8: a session that did not start the currently-running app sees it as
    // stopped, with ownedBy naming who actually owns it — the owner's own
    // status call (and the id-less GET /local) still see the real state.
    if (status.state === 'running' && status.sessionId !== null && status.sessionId !== id) {
      sendLocalStatus(res, {
        state: 'stopped',
        sessionId: null,
        url: null,
        pid: null,
        logPath: null,
        startedAt: null,
        reason: null,
        logTail: null,
        ownedBy: status.sessionId,
      });
      return true;
    }
    sendLocalStatus(res, status);
    return true;
  }
  const fresh = url.searchParams.get('fresh') === '1';
  const status = await lock.withLock(id, () =>
    action === 'start' ? environment.start(session, { fresh }) : environment.stop(id),
  );
  sendLocalStatus(res, status);
  return true;
}

/** `/local`, `/local/stop`, `/sessions/:id/local`, `/sessions/:id/local/{start,stop}`. */
function localActionFor(
  parts: readonly string[],
): { id: string | null; action: 'status' | 'start' | 'stop' } | null {
  if (parts[0] === 'local') {
    if (parts.length === 1) return { id: null, action: 'status' };
    if (parts.length === 2 && parts[1] === 'stop') return { id: null, action: 'stop' };
    return null;
  }
  if (parts[0] !== 'sessions' || parts[2] !== 'local') return null;
  if (parts.length === 3) return { id: parts[1], action: 'status' };
  if (parts.length === 4 && (parts[3] === 'start' || parts[3] === 'stop')) {
    return { id: parts[1], action: parts[3] };
  }
  return null;
}

/**
 * `/attention`, `/attention/ack`, and the two named ack aliases. The aliases
 * only format an ItemRef and delegate to the same `AttentionService.ack`, so
 * no client has to learn the ref grammar and no future source needs a bespoke
 * ack route (R18).
 */
async function handleAck(
  res: ServerResponse,
  attention: AttentionService,
  ref: ItemRef,
): Promise<void> {
  const item = await attention.ack(ref);
  sendJson(res, 200, { item });
}

function parseAckBody(body: unknown): ItemRef {
  const ref = (body as { ref?: unknown } | undefined)?.ref;
  if (typeof ref !== 'string') {
    throw new ValidationError("Invalid ack request: expected { ref: string }");
  }
  parseItemRef(ref); // grammar check only — the adapters decide what exists
  return ref;
}

function parseSourceFilter(raw: string | null): ItemSource | null {
  if (raw === null) return null;
  if (!(ITEM_SOURCES as readonly string[]).includes(raw)) {
    throw new ValidationError(`Invalid source '${raw}': expected one of ${ITEM_SOURCES.join(', ')}`);
  }
  return raw as ItemSource;
}

/**
 * The three conversation routes (R9, R12, R20). Deliberately NOT wrapped in
 * `lock.withLock` at the route layer, for exactly the reason the comment
 * inside `handleRequest` gives for /run and friends: `claimConversation` and
 * `releaseConversation` take the per-session lock themselves and KeyedLock is
 * not re-entrant, so a route-layer lock would deadlock. `conversation` is a
 * pure read.
 */
async function handleConversationRoute(
  res: ServerResponse,
  deps: ApiServerDeps,
  id: string,
  action: 'get' | 'claim' | 'release',
): Promise<void> {
  if (action === 'get') {
    sendJson(res, 200, await deps.pipeline.conversation(id));
    return;
  }
  const session =
    action === 'claim' ? await deps.pipeline.claimConversation(id) : await deps.pipeline.releaseConversation(id);
  sendJson(res, 200, { session });
}

/** `GET /sessions/:id/conversation`, `POST /sessions/:id/conversation/{claim,release}`. */
function conversationActionFor(
  parts: readonly string[],
  method: string | undefined,
): { id: string; action: 'get' | 'claim' | 'release' } | null {
  if (parts[0] !== 'sessions' || parts[2] !== 'conversation') return null;
  if (parts.length === 3 && method === 'GET') return { id: parts[1], action: 'get' };
  if (parts.length === 4 && method === 'POST' && (parts[3] === 'claim' || parts[3] === 'release')) {
    return { id: parts[1], action: parts[3] };
  }
  return null;
}

/** `GET /sessions/:id/changes` (Phase 10). Matches the `conversation` route's shape. */
function isSessionChangesRoute(parts: readonly string[], method: string | undefined): string | null {
  if (method !== 'GET' || parts.length !== 3 || parts[0] !== 'sessions' || parts[2] !== 'changes') return null;
  return parts[1];
}

/**
 * A ref-safe enough `baseRef` to hand to `git`: not empty, not padded with whitespace, and free
 * of the bytes `git check-ref-format` rejects in a ref component (whitespace inside it, the
 * special characters below, and a `..` anywhere). Deliberately conservative — this only ever
 * widens to the fallback, never narrows what a legitimate ref looks like.
 */
const UNSAFE_BASE_REF_CHARS = /[\s~^:?*[\\]/;

function isSafeBaseRef(value: string): boolean {
  if (value === '' || value.trim() !== value) return false;
  if (UNSAFE_BASE_REF_CHARS.test(value)) return false;
  if (value.includes('..')) return false;
  return true;
}

/**
 * The PR's own base ref (as scanned into the current inventory) when the
 * session carries a PR, else `config.defaultBaseRef` — never a persisted
 * field on the session itself (there isn't one). An inventory entry whose
 * `baseRef` is empty, whitespace, or not ref-safe (a scan that raced a
 * rename, or otherwise landed a corrupt value) is treated the same as no
 * entry at all, rather than being handed to `git` as-is.
 */
async function resolveChangesBaseRef(deps: ApiServerDeps, session: Session): Promise<string> {
  const fallback = deps.config?.defaultBaseRef ?? 'origin/main';
  if (session.pr === null || deps.inventory === undefined) return fallback;
  const inventory = await loadCurrentInventory(deps.inventory);
  if (inventory === null) return fallback;
  const entry = findEntry(inventory, session.pr.repo, session.pr.number);
  if (entry === undefined || !isSafeBaseRef(entry.baseRef)) return fallback;
  return entry.baseRef;
}

/**
 * `GET /sessions/:id/changes` (Phase 10) — deliberately NOT wrapped in
 * `lock.withLock`, the same reasoning as `conversation`'s `get` action: this
 * is a pure read of the worktree and never contends with a run.
 */
async function handleSessionChanges(res: ServerResponse, deps: ApiServerDeps, id: string): Promise<void> {
  const session = await deps.sessionStore.load(id);
  if (deps.git === undefined) {
    sendJson(res, 404, { error: 'git not configured' });
    return;
  }
  const worktreePath = session.workspace.worktreePath;
  if (worktreePath === undefined) {
    sendJson(res, 200, { base: null, baseResolved: null, head: null, committed: null, workingTree: null });
    return;
  }
  const base = await resolveChangesBaseRef(deps, session);
  const result = await computeSessionChanges(deps.git, worktreePath, base);
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// The /items surface (R14, R15, R25, R31, R35, R47, R65).
// ---------------------------------------------------------------------------

/**
 * R65 — a `pr/…` path resolves to the item whose `prs` CONTAINS that PR and a
 * `session/:id` path to the item whose `agents` contains that session, never
 * by matching the path against the item's own `id`: R28 fixes the id to the
 * ticket the moment a link exists, so an id lookup would 404 on exactly the
 * merged items this phase exists to create.
 */
function findAddressedItem(items: readonly WorkItem[], parsed: ParsedWorkItemId): WorkItem | undefined {
  if (parsed.kind === 'ticket') return items.find((i) => i.ticket?.key === parsed.key);
  if (parsed.kind === 'pr') {
    return items.find((i) => i.prs.some((pr) => pr.repo === `${parsed.repo}` && pr.number === parsed.number));
  }
  return items.find((i) => i.agents.some((a) => a.sessionId === parsed.id));
}

const AGENT_MODES = ['review', 'investigation', 'development', 'respond', 'qa'] as const;

interface AgentsRequest {
  mode: (typeof AGENT_MODES)[number];
  repoUrl?: string;
  intent?: 'investigate_only' | 'development';
  driveToCompletion?: boolean;
  /** Phase 10 — mode 'review' only: deliberately review the caller's OWN PR, bypassing OwnPrError. */
  selfReview?: boolean;
  /**
   * Phase 15 — `false` creates the session and composes its BRIEF.md WITHOUT
   * starting a run (R73's chat-only entry point). Defaults to `true`, which
   * is every pre-Phase-15 caller's behaviour unchanged.
   */
  start?: boolean;
}

function parseAgentsRequest(body: unknown): AgentsRequest {
  const raw = (body ?? {}) as Record<string, unknown>;
  const mode = raw.mode;
  if (typeof mode !== 'string' || !(AGENT_MODES as readonly string[]).includes(mode)) {
    throw new ValidationError(`Invalid agent request: mode must be one of ${AGENT_MODES.join(', ')}`);
  }
  const request: AgentsRequest = { mode: mode as AgentsRequest['mode'] };
  if (raw.repoUrl !== undefined) {
    if (typeof raw.repoUrl !== 'string' || raw.repoUrl === '') {
      throw new ValidationError('Invalid agent request: repoUrl must be a non-empty string');
    }
    request.repoUrl = raw.repoUrl;
  }
  if (raw.intent === 'investigate_only' || raw.intent === 'development') request.intent = raw.intent;
  if (typeof raw.driveToCompletion === 'boolean') request.driveToCompletion = raw.driveToCompletion;
  if (typeof raw.selfReview === 'boolean') request.selfReview = raw.selfReview;
  if (raw.start !== undefined) {
    if (typeof raw.start !== 'boolean') {
      throw new ValidationError('Invalid agent request: start must be a boolean');
    }
    request.start = raw.start;
  }
  return request;
}

/** R31 — the ack fans out SERVER-side over every contributing ref, so no client re-derives which refs an item owns. */
async function handleItemAck(
  res: ServerResponse,
  attention: AttentionService,
  workItems: WorkItemService,
  item: WorkItem,
): Promise<void> {
  const acked: ItemRef[] = [];
  const failed: Array<{ ref: ItemRef; error: string }> = [];
  for (const ref of item.attention.refs) {
    try {
      await attention.ack(ref);
      acked.push(ref);
    } catch (err) {
      // A ref can vanish between the read and the ack: skip it rather than
      // failing the whole fan-out.
      if (err instanceof Error && err.name === 'ItemNotFoundError') continue;
      failed.push({ ref, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const refreshed = (await workItems.list()).items.find((i) => i.id === item.id) ?? item;
  const status = acked.length === 0 && failed.length > 0 ? 502 : 200;
  sendJson(res, status, { item: refreshed, acked, failed });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  lock: KeyedLock,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method;

    // R1: the identity probe. First branch in the chain and free of every
    // optional dependency, so "did cgremlin-core answer?" is answerable on
    // any wiring — unlike GET /config, which 404s without a config dep.
    if (method === 'GET' && parts.length === 1 && parts[0] === 'version') {
      if (!deps.engineInfo) {
        sendJson(res, 404, { error: 'version not available' });
        return;
      }
      const { name, version, buildId, buildTime, pid, startedAt, socketPath } = deps.engineInfo;
      // R21: recomputed per request. Live StageRunner runs PLUS environment
      // preparations still in flight — a stage still preparing has no active
      // run for pipeline.stop() to find, yet a restart aborts it.
      const activeRuns = deps.pipeline.activeSessionIds().length + (deps.environment?.inFlightCount() ?? 0);
      sendJson(res, 200, { name, version, buildId, buildTime, pid, startedAt, socketPath, activeRuns });
      return;
    }

    // R-shutdown: the stop that can be REFUSED, and the reason the ping-pong ended. First-class
    // beside /version and under no lock, for the same reason: a window has to be able to ask an
    // engine to stand down whatever else that engine is doing, and get a verdict either way.
    if (method === 'POST' && parts.length === 1 && parts[0] === 'shutdown') {
      if (!deps.engineInfo || deps.shutdown === undefined || !deps.shutdown.installed) {
        sendJson(res, 404, { error: 'shutdown not available' });
        return;
      }
      const request = parseShutdownRequest(await readJsonBody(req));
      const decision = deps.shutdown.decide(request);
      if (!decision.accepted) {
        sendJson(res, 409, decision);
        return;
      }
      sendJson(res, 202, { accepted: true });
      // AFTER the answer is on the wire: close() drops every open connection, so performing it
      // inline would cut this very response off before the requester could read it.
      const perform = (): void => deps.shutdown?.perform();
      if (res.writableFinished) perform();
      else res.once('finish', perform);
      return;
    }

    // The server-sent event stream. First branch in the chain, and the only
    // one that hijacks the response: it writes SSE frames and returns without
    // ever reaching sendJson or the 404 fall-through.
    if (method === 'GET' && parts.length === 1 && parts[0] === 'events') {
      if (!deps.eventRing) {
        sendJson(res, 404, { error: 'events not configured' });
        return;
      }
      handleEventStream(req, res, { ring: deps.eventRing });
      return;
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const sessions = await deps.sessionStore.list();
      sendJson(res, 200, { sessions });
      return;
    }

    if (method === 'GET' && parts.length === 2 && parts[0] === 'sessions') {
      const session = await deps.sessionStore.load(parts[1]);
      sendJson(res, 200, { session });
      return;
    }

    if (method === 'GET' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'artifacts') {
      const id = parts[1];
      await lock.withLock(id, () => handleArtifactList(res, deps, id));
      return;
    }

    if (method === 'GET' && parts.length === 4 && parts[0] === 'sessions' && parts[2] === 'artifacts') {
      const id = parts[1];
      await lock.withLock(id, () => handleArtifactRead(res, deps, id, parts[3]));
      return;
    }

    // The /items surface (Phase 9). Ahead of /prs and /attention so an
    // unwired work-item layer answers its own 404 rather than another
    // gate's message (the `deps.attention` pattern).
    if (parts[0] === 'items') {
      if (!deps.workItems) {
        sendJson(res, 404, { error: 'items not configured' });
        return;
      }
      const workItems = deps.workItems;

      if (method === 'GET' && parts.length === 1) {
        const listParam = url.searchParams.get('list');
        if (listParam !== null && !(WORK_LIST_KINDS as readonly string[]).includes(listParam)) {
          // `reviewing` is a GROUP inside parkingLot, not a list (R47).
          throw new ValidationError(
            `Invalid list '${listParam}': expected one of ${WORK_LIST_KINDS.join(', ')}`,
          );
        }
        const listing = await workItems.list();
        if (listParam === null) {
          sendJson(res, 200, listing);
          return;
        }
        const wanted = listParam as WorkListKind;
        const empty = {
          parkingLot: { reviewing: [] as string[], untouched: [] as string[], someoneOnIt: [] as string[] },
          myWork: [] as string[],
          nextRelease: [] as string[],
          investigations: [] as string[],
          waitingForReview: [] as string[],
        };
        sendJson(res, 200, {
          ...listing,
          lists: { ...empty, [wanted]: listing.lists[wanted] },
          items: listing.items.filter((item) => item.lists.includes(wanted)),
        });
        return;
      }

      const addressed = parseWorkItemPath(parts.slice(1));

      /**
       * Phase 18 — "find the PRs of a ticket that has none", which is the user's normal case:
       * his teammates merge without cgremlin sessions, so nothing links the ticket to the
       * change and §8's gate can only refuse. ONE `gh pr list --search`, written straight into
       * the pr-state cache, and the REFRESHED item comes back with the answer so the panel
       * re-evaluates from the same response rather than guessing when to poll.
       */
      if (
        method === 'POST' &&
        addressed !== null &&
        addressed.parsed.kind === 'ticket' &&
        addressed.rest.length === 2 &&
        addressed.rest[0] === 'prs' &&
        addressed.rest[1] === 'discover'
      ) {
        if (!deps.qaDiscovery) {
          sendJson(res, 404, { error: 'qa discovery not configured' });
          return;
        }
        const parsed = addressed.parsed;
        const result = await deps.qaDiscovery.discover(parsed.key);
        const refreshed = await workItems.list();
        sendJson(res, 200, { ...result, item: findAddressedItem(refreshed.items, parsed) ?? null });
        return;
      }

      if (addressed !== null && (addressed.rest.length === 0 || addressed.rest.length === 1)) {
        const { parsed, rest } = addressed;
        const tail = rest[0];
        const listing = await workItems.list();
        // Phase 14 — a `session/:id` path resolves for ANY session the store
        // knows, even one that belongs to no list (a dismissed review of a PR
        // that merged and left the inventory). `getBySession` falls back to a
        // one-item grouping built from the session's own attention item; the
        // lists themselves are untouched.
        const item =
          parsed.kind === 'session'
            ? ((await workItems.getBySession(parsed.id)) ?? undefined)
            : findAddressedItem(listing.items, parsed);
        if (item === undefined || item === null) {
          sendJson(res, 404, { error: `No work item found for /${parts.join('/')}` });
          return;
        }

        if (method === 'GET' && tail === undefined) {
          const { ticket, ticketError } =
            item.ticket === null
              ? { ticket: null, ticketError: null }
              : ((await deps.ticketDetail?.detail(item.ticket.key)) ?? { ticket: null, ticketError: null });
          const artifacts: Record<string, ArtifactListing[]> = {};
          for (const agent of item.agents) {
            artifacts[agent.sessionId] = await lock.withLock(agent.sessionId, () =>
              collectArtifacts(deps, agent.sessionId),
            );
          }
          sendJson(res, 200, { item, ticket, ticketError, artifacts });
          return;
        }

        if (method === 'POST' && tail === 'ack') {
          if (!deps.attention) {
            sendJson(res, 404, { error: 'attention not configured' });
            return;
          }
          await handleItemAck(res, deps.attention, workItems, item);
          return;
        }

        // "I don't care about this one right now." Both are idempotent and
        // answer with the refreshed item, so a client never re-derives the
        // flag it just set.
        if (method === 'POST' && (tail === 'dismiss' || tail === 'undismiss')) {
          const updated =
            tail === 'dismiss' ? await workItems.dismiss(item.id) : await workItems.undismiss(item.id);
          if (updated === null) {
            sendJson(res, 404, { error: `No work item found for /${parts.join('/')}` });
            return;
          }
          sendJson(res, 200, { item: updated });
          return;
        }

        if (method === 'POST' && tail === 'agents') {
          const request = parseAgentsRequest(await readJsonBody(req));
          await handleItemAgents(req, res, deps, lock, item, request);
          return;
        }
      }

      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // The attention surface: the generic route plus the two named aliases.
    // Placed ahead of the /prs and /local gates so an unwired attention model
    // answers 'attention not configured' rather than another gate's message.
    const isAttentionRoute =
      parts[0] === 'attention' ||
      (parts[0] === 'sessions' && parts.length === 3 && parts[2] === 'ack') ||
      (parts[0] === 'prs' && parts.length === 5 && parts[4] === 'ack');
    if (isAttentionRoute) {
      if (!deps.attention) {
        sendJson(res, 404, { error: 'attention not configured' });
        return;
      }
      const attention = deps.attention;

      if (method === 'GET' && parts.length === 1 && parts[0] === 'attention') {
        const source = parseSourceFilter(url.searchParams.get('source'));
        const { evaluatedAt, items } = await attention.list({ all: url.searchParams.get('all') === '1' });
        sendJson(res, 200, {
          evaluatedAt,
          items: source === null ? items : items.filter((item) => item.source === source),
        });
        return;
      }

      if (method === 'POST' && parts.length === 2 && parts[0] === 'attention' && parts[1] === 'ack') {
        await handleAck(res, attention, parseAckBody(await readJsonBody(req)));
        return;
      }

      if (method === 'POST' && parts[0] === 'sessions') {
        await handleAck(res, attention, sessionRef(parts[1]));
        return;
      }

      if (method === 'POST' && parts[0] === 'prs') {
        await handleAck(res, attention, prRef(`${parts[1]}/${parts[2]}`, Number(parts[3])));
        return;
      }
    }

    if (method === 'GET' && parts.length === 1 && parts[0] === 'config') {
      if (!deps.config) {
        sendJson(res, 404, { error: 'config not available' });
        return;
      }
      sendJson(res, 200, { config: redactCoreConfig(deps.config) });
      return;
    }

    const localAction = localActionFor(parts);
    if (localAction !== null) {
      if (!deps.environment) {
        sendJson(res, 404, { error: 'environment not configured' });
        return;
      }
      const handled = await handleLocalRoute(
        req, res, deps, lock, deps.environment, url, method, localAction.id, localAction.action,
      );
      if (handled) return;
    }

    if (method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
      const body = await readJsonBody(req);
      await deps.sessionStore.save(body as never);
      sendJson(res, 201, { session: body });
      return;
    }

    if (method === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'investigations') {
      const body = await readJsonBody(req);
      const input = parseCreateInvestigationRequest(body);
      const session = await deps.pipeline.createInvestigationSession(input);
      sendJson(res, 201, { session });
      return;
    }

    if (method === 'POST' && parts.length === 2 && parts[0] === 'sessions' && parts[1] === 'developments') {
      const body = await readJsonBody(req);
      const input = parseCreateDevelopmentRequest(body);
      const session = await deps.pipeline.createDevelopmentSession(input);
      // 201 and nothing started: the develop turn is a separate, explicit
      // POST /sessions/:id/run (R16, MG-A11).
      sendJson(res, 201, { session });
      return;
    }

    // /transition, /run, /promote, /rereview, /retry, and /approve-plan are
    // NOT wrapped in lock.withLock here — PipelineService now owns per-session
    // locking for all of these itself (see the invariant documented atop
    // pipeline-service.ts). Wrapping them here too would nest a second
    // lock.withLock for the same session id inside the first and deadlock,
    // since KeyedLock is not re-entrant. Only /artifacts (a pure read) and
    // /stop (StageRunner.stop never touches the store) still lock here.
    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'transition') {
      const id = parts[1];
      const body = (await readJsonBody(req)) as { to: string };
      const updated = await deps.pipeline.transition(id, body.to, { by: 'human' });
      sendJson(res, 200, { session: updated });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'run') {
      const id = parts[1];
      const { stage, skipJiraCheck } = parseRunStageRequest(await readJsonBody(req));
      await respondAfterRunStarted(
        res, deps, id,
        deps.pipeline.runStage(id, stage, skipJiraCheck === undefined ? {} : { skipJiraCheck }),
      );
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'approve-plan') {
      const id = parts[1];
      const session: Session = await deps.pipeline.approvePlan(id);
      sendJson(res, 200, { session });
      return;
    }

    // The human's approval, and the ONLY pull request it can reach is the one
    // this session reviewed: the route takes a session id, the repo slug and
    // the number come out of `session.pr`, and a body that names a different
    // pull request is refused rather than honoured (../gh/pr-approval.ts).
    // The engine grows no "approve any PR" endpoint.
    if (
      method === 'POST' && parts.length === 3 && parts[0] === 'sessions' &&
      parts[2] === 'approve-pr' && deps.prApprover !== undefined
    ) {
      const id = parts[1];
      const session = await deps.sessionStore.load(id); // SessionNotFoundError -> 404
      const body = req.headers['content-length'] === undefined ? undefined : await readJsonBody(req);
      const resolved = resolveApprovalTarget(session, body);
      if (!resolved.ok) {
        if (resolved.kind === 'retargeted') throw new ValidationError(resolved.message);
        throw new UnsupportedStageError(resolved.message);
      }
      await deps.prApprover.approve(resolved.target);
      const updated = await deps.pipeline.transition(id, 'approved', { by: 'human' });
      sendJson(res, 200, { session: updated });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'promote') {
      const id = parts[1];
      await handlePromote(res, deps, id);
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'rereview') {
      const id = parts[1];
      await respondAfterRunStarted(res, deps, id, deps.pipeline.runRereview(id));
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'stop') {
      const id = parts[1];
      const stopped = await lock.withLock(id, () => deps.pipeline.stop(id));
      sendJson(res, 200, { stopped });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'retry') {
      const id = parts[1];
      await respondAfterRunStarted(res, deps, id, deps.pipeline.retry(id));
      return;
    }

    const conversationAction = conversationActionFor(parts, method);
    if (conversationAction !== null) {
      await handleConversationRoute(res, deps, conversationAction.id, conversationAction.action);
      return;
    }

    const changesSessionId = isSessionChangesRoute(parts, method);
    if (changesSessionId !== null) {
      await handleSessionChanges(res, deps, changesSessionId);
      return;
    }

    if (method === 'POST' && parts.length === 1 && parts[0] === 'workspaces') {
      const body = await readJsonBody(req);
      const params = parseCreateWorkspaceRequest(body);
      const mirrorPath = await deps.workspaceManager.createWorkspace(params);
      sendJson(res, 201, { mirrorPath });
      return;
    }

    if (method === 'DELETE' && parts.length === 1 && parts[0] === 'workspaces') {
      const params = parseRemoveWorkspaceRequest(await readJsonBody(req));
      const sessions = await deps.sessionStore.list();
      assertWorktreeNotInUse(sessions, params.worktreePath);
      await deps.workspaceManager.removeWorkspace(params.repoUrl, params.worktreePath, params.branchName);
      sendJson(res, 204, undefined);
      return;
    }

    // R17: the only way to review a PR in a repo the scan does not watch —
    // there is no InventoryEntry to address, so the PR URL is the input. The
    // factory and `me` live under `inventory`, hence the same guard /prs uses.
    if (method === 'POST' && parts.length === 1 && parts[0] === 'reviews') {
      if (!deps.inventory) {
        sendJson(res, 404, { error: 'inventory not configured' });
        return;
      }
      const inv = deps.inventory;
      const body = (await readJsonBody(req)) as { prUrl?: unknown } | undefined;
      if (typeof body?.prUrl !== 'string') {
        throw new ValidationError('Invalid review request: prUrl must be a string');
      }
      const ref = parsePrUrl(body.prUrl); // InvalidPrUrlError -> 400
      // The SAME lock key the inventory-originated route uses (below), so the
      // two entry points cannot create two sessions for one PR concurrently.
      await lock.withLock(`pr:${ref.slug}#${ref.number}`, async () => {
        const sessions = await deps.sessionStore.list();
        const existing = sessions.find(
          (s) =>
            s.mode === 'review' &&
            !TERMINAL_PHASES_BY_MODE.review.has(s.stageStatus) &&
            s.pr !== null &&
            s.pr.repo === ref.slug &&
            s.pr.number === ref.number,
        );
        if (existing) {
          // R23: identical semantics to the inventory-originated route for
          // the same session state — genuinely live/active already gets 200,
          // otherwise (queued/failed/orphaned-reviewing) it is restarted and
          // gets 202. A terminal session is not a match and falls through to
          // a fresh session below.
          await respondForExistingReviewSession(res, deps, existing);
          return;
        }
        const created = await inv.factory.createFromPrUrl(ref.url, { refuseAuthor: inv.config.me });
        const started = await awaitRunStart(deps.events, created.id, deps.pipeline.runReview(created.id));
        const session = await deps.sessionStore.load(created.id);
        sendJson(res, started ? 202 : 200, { session, created: true, started });
      });
      return;
    }

    if (parts[0] === 'prs') {
      if (!deps.inventory) {
        sendJson(res, 404, { error: 'inventory not configured' });
        return;
      }
      const inv = deps.inventory;

      if (method === 'GET' && parts.length === 1) {
        const inventory = await loadCurrentInventory(inv);
        if (!inventory) throw new NoScanYetError();
        const groups = inv.scanner.lastReport?.groups ?? groupInventory(inventory);
        sendJson(res, 200, { inventory, groups });
        return;
      }

      if (method === 'POST' && parts.length === 2 && parts[1] === 'scan') {
        const report = await inv.scheduler.runNow();
        sendJson(res, 200, report);
        return;
      }

      if (method === 'GET' && parts.length === 2 && parts[1] === 'status') {
        // Falls back to inventoryStore.load() when lastReport is null (e.g.
        // right after a process restart, before this process's first scan),
        // matching GET /prs's own source-of-truth preference exactly.
        const inventory = await loadCurrentInventory(inv);
        sendJson(res, 200, {
          running: inv.scheduler.isRunning(),
          lastScanAt: inventory?.scannedAt ?? null,
          lastError: inv.scheduler.lastError,
          skippedBeats: inv.scheduler.skippedBeats,
        });
        return;
      }

      if (method === 'GET' && parts.length === 4) {
        const repoSlug = `${parts[1]}/${parts[2]}`;
        const number = Number(parts[3]);
        const inventory = await loadCurrentInventory(inv);
        if (!inventory) throw new NoScanYetError();
        const entry = findEntry(inventory, repoSlug, number);
        if (!entry) {
          sendJson(res, 404, { error: `PR ${repoSlug}#${number} is not in the current inventory` });
          return;
        }
        sendJson(res, 200, { entry });
        return;
      }

      if (method === 'POST' && parts.length === 5 && parts[4] === 'review') {
        const repoSlug = `${parts[1]}/${parts[2]}`;
        const number = Number(parts[3]);
        await lock.withLock(`pr:${repoSlug}#${number}`, async () => {
          if (url.searchParams.get('refresh') === '1') {
            // A scheduler-driven tick could already be in flight; wait for it
            // to settle before starting our own rather than colliding with
            // TickInProgressError. A second collision (a new tick starting
            // in the gap between waitForIdle and runNow) can still 409 —
            // acceptable, and far rarer than the naive immediate-runNow race.
            await inv.scheduler.waitForIdle();
            await inv.scheduler.runNow();
          }
          await handleReviewStart(res, deps, inv, repoSlug, number);
        });
        return;
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const { status, body } = mapErrorToHttp(err);
    sendJson(res, status, body);
  }
}
