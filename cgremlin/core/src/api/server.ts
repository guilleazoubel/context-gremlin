import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionStore } from '../engine/session-store';
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
import type { EnvironmentService, LocalAppStatus } from '../env/environment-service';
import { redactBypassUrls, redactCoreConfig, type CoreConfig } from '../config/core-config';
import { handleEventStream, type EventRing } from './event-stream';
import type { WorkItemService } from '../work/work-item-service';
import type { AttentionService } from '../attention/attention-service';
import { ITEM_SOURCES, parseItemRef, prRef, sessionRef, type ItemRef, type ItemSource } from '../attention/item-ref';
import { OwnPrError } from '../gh/own-pr-error';
import { parsePrUrl } from '../gh/pr-url';

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
}

/** The identity a running engine reports on `GET /version` and records in its `engine.json` lock. */
export interface EngineInfo {
  name: string;
  version: string;
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
  const isLive = deps.pipeline.activeSessionIds().includes(existing.id);
  if (!isLive) {
    if (existing.stageStatus === 'queued' || existing.stageStatus === 'failed') {
      await awaitRunStart(deps.events, existing.id, deps.pipeline.runReview(existing.id));
      const session = await deps.sessionStore.load(existing.id);
      sendJson(res, 202, { session, created: false, started: true });
      return;
    }
    if (existing.stageStatus === 'reviewing') {
      // No live run for a session that claims to be 'reviewing' means the
      // host crashed mid-run — the on-disk phase is stale. Mark it failed
      // (a legal transition from 'reviewing') before restarting, rather
      // than leaving it stuck forever or silently resuming as if nothing
      // happened.
      await deps.pipeline.transition(existing.id, 'failed');
      await awaitRunStart(deps.events, existing.id, deps.pipeline.runReview(existing.id));
      const session = await deps.sessionStore.load(existing.id);
      sendJson(res, 202, { session, created: false, started: true });
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
  if (entry.author.toLowerCase() === inv.config.me.toLowerCase()) {
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
    kind: 'review',
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
  await awaitRunStart(deps.events, created.id, deps.pipeline.runReview(created.id));
  const session = await deps.sessionStore.load(created.id);
  sendJson(res, 202, { session, created: true, started: true });
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
  await awaitRunStart(deps.events, id, guard);
  const session = await deps.sessionStore.load(id);
  sendJson(res, 202, { session });
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
  const content = await deps.fs.readFile(filePath);
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
    reason: status.reason === null ? null : redactBypassUrls(status.reason),
    logTail: status.logTail === null ? null : redactBypassUrls(status.logTail),
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
      const { name, version, pid, startedAt, socketPath } = deps.engineInfo;
      // R21: recomputed per request. Live StageRunner runs PLUS environment
      // preparations still in flight — a stage still preparing has no active
      // run for pipeline.stop() to find, yet a restart aborts it.
      const activeRuns = deps.pipeline.activeSessionIds().length + (deps.environment?.inFlightCount() ?? 0);
      sendJson(res, 200, { name, version, pid, startedAt, socketPath, activeRuns });
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
      const updated = await deps.pipeline.transition(id, body.to);
      sendJson(res, 200, { session: updated });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'run') {
      const id = parts[1];
      const { stage } = parseRunStageRequest(await readJsonBody(req));
      await respondAfterRunStarted(res, deps, id, deps.pipeline.runStage(id, stage));
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'approve-plan') {
      const id = parts[1];
      const session: Session = await deps.pipeline.approvePlan(id);
      sendJson(res, 200, { session });
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
        await awaitRunStart(deps.events, created.id, deps.pipeline.runReview(created.id));
        const session = await deps.sessionStore.load(created.id);
        sendJson(res, 202, { session, created: true, started: true });
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
