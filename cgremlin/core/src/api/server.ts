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
  parseCreateInvestigationRequest,
  parseCreateWorkspaceRequest,
  parseRemoveWorkspaceRequest,
  parseRunStageRequest,
  ValidationError,
} from './validation';
import { assertWorktreeNotInUse, TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { ArtifactNotFoundError } from './artifacts';
import type { DiscoveryScheduler } from '../discovery/scheduler';
import { awaitRunStart } from '../pipeline/run-start';
import type { InventoryScanner, ScanReport } from '../inventory/inventory-scanner';
import type { InventoryStore } from '../inventory/inventory-store';
import { groupInventory, type Inventory, type InventoryEntry } from '../inventory/inventory';
import type { ReviewSessionFactory, CandidatePR } from '../pipeline/review-session-factory';

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
}

export class OwnPrError extends Error {
  constructor(repo: string, number: number) {
    super(`PR ${repo}#${number} is authored by the configured user; the engine never reviews its own PRs`);
    this.name = 'OwnPrError';
  }
}

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
    if (existing.stageStatus === 'queued' && !deps.pipeline.activeSessionIds().includes(existing.id)) {
      await awaitRunStart(deps.events, existing.id, deps.pipeline.runReview(existing.id));
      const session = await deps.sessionStore.load(existing.id);
      sendJson(res, 202, { session, created: false, started: true });
      return;
    }
    sendJson(res, 200, { session: existing, created: false, started: false });
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

    if (method === 'GET' && parts.length === 4 && parts[0] === 'sessions' && parts[2] === 'artifacts') {
      const id = parts[1];
      await lock.withLock(id, () => handleArtifactRead(res, deps, id, parts[3]));
      return;
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
        sendJson(res, 200, {
          running: inv.scheduler.isRunning(),
          // scanner.lastReport, not scheduler.lastReport: consistent with
          // GET /prs's own source-of-truth preference, and correct even when
          // a scan was triggered directly (e.g. in tests) rather than via
          // the scheduler.
          lastScanAt: inv.scanner.lastReport?.inventory.scannedAt ?? null,
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
