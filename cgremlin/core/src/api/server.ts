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
import { assertWorktreeNotInUse } from '../workspace/workspace-in-use';
import { ArtifactNotFoundError } from './artifacts';
import type { DiscoveryScheduler } from '../discovery/scheduler';
import type { DiscoveryConfig } from '../discovery/discovery-config';
import { awaitRunStart } from '../pipeline/run-start';

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
  discovery?: { scheduler: DiscoveryScheduler; config: DiscoveryConfig };
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const lock = new KeyedLock();
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

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'transition') {
      const id = parts[1];
      const body = (await readJsonBody(req)) as { to: string };
      const updated = await lock.withLock(id, () => deps.pipeline.transition(id, body.to));
      sendJson(res, 200, { session: updated });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'run') {
      const id = parts[1];
      const { stage } = parseRunStageRequest(await readJsonBody(req));
      await lock.withLock(id, () => respondAfterRunStarted(res, deps, id, deps.pipeline.runStage(id, stage)));
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'approve-plan') {
      const id = parts[1];
      const session: Session = await lock.withLock(id, () => deps.pipeline.approvePlan(id));
      sendJson(res, 200, { session });
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'promote') {
      const id = parts[1];
      await lock.withLock(id, () => handlePromote(res, deps, id));
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'rereview') {
      const id = parts[1];
      await lock.withLock(id, () => respondAfterRunStarted(res, deps, id, deps.pipeline.runRereview(id)));
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
      await lock.withLock(id, () => respondAfterRunStarted(res, deps, id, deps.pipeline.retry(id)));
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

    if (parts.length === 2 && parts[0] === 'discovery' && ['tick', 'config', 'status'].includes(parts[1])) {
      if (!deps.discovery) {
        sendJson(res, 404, { error: 'discovery not configured' });
        return;
      }
      const { scheduler, config } = deps.discovery;

      if (method === 'POST' && parts[1] === 'tick') {
        const report = await scheduler.runNow();
        sendJson(res, 200, report);
        return;
      }

      if (method === 'GET' && parts[1] === 'config') {
        sendJson(res, 200, config);
        return;
      }

      if (method === 'GET' && parts[1] === 'status') {
        sendJson(res, 200, {
          running: scheduler.isRunning(),
          lastReport: scheduler.lastReport,
          skippedBeats: scheduler.skippedBeats,
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
