import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager, CreateWorkspaceParams } from '../workspace/workspace-manager';
import { KeyedLock } from './keyed-lock';
import { mapErrorToHttp } from './http-errors';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
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
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const lock = new KeyedLock();
  return http.createServer((req, res) => {
    void handleRequest(req, res, deps, lock);
  });
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

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const sessions = await deps.sessionStore.list();
      sendJson(res, 200, { sessions });
      return;
    }

    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'sessions') {
      const session = await deps.sessionStore.load(parts[1]);
      sendJson(res, 200, { session });
      return;
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
      const body = await readJsonBody(req);
      await deps.sessionStore.save(body as never);
      sendJson(res, 201, { session: body });
      return;
    }

    if (
      req.method === 'POST' &&
      parts.length === 3 &&
      parts[0] === 'sessions' &&
      parts[2] === 'transition'
    ) {
      const id = parts[1];
      const body = (await readJsonBody(req)) as { to: string };
      const updated = await lock.withLock(id, () => deps.sessionStore.transition(id, body.to));
      sendJson(res, 200, { session: updated });
      return;
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'workspaces') {
      const body = (await readJsonBody(req)) as CreateWorkspaceParams;
      const mirrorPath = await deps.workspaceManager.createWorkspace(body);
      sendJson(res, 201, { mirrorPath });
      return;
    }

    if (req.method === 'DELETE' && parts.length === 1 && parts[0] === 'workspaces') {
      const body = (await readJsonBody(req)) as {
        repoUrl: string;
        worktreePath: string;
        branchName: string;
      };
      await deps.workspaceManager.removeWorkspace(body.repoUrl, body.worktreePath, body.branchName);
      sendJson(res, 204, undefined);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const { status, body } = mapErrorToHttp(err);
    sendJson(res, status, body);
  }
}
