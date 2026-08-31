import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import type { Session } from '../../src/schema/session';

let dir: string;
let socketPath: string;
let server: http.Server;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-api-test-'));
  socketPath = path.join(dir, 'api.sock');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const fs = new InMemoryFileSystem();
  const git = new FakeGitRunner();
  const sessionStore = new SessionStore(fs, '/sessions');
  const workspaceManager = new WorkspaceManager(git, fs, '/mirrors');
  server = createApiServer({ sessionStore, workspaceManager });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(socketPath, { force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id: 'inv-test-1',
    mode: 'investigation',
    createdAt: '2026-08-28T10:00:00.000Z',
    workspace: { repoUrl: 'git@example.com:x/y.git' },
    lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
    stageStatus: 'findings',
    ...overrides,
  } as Session;
}

describe('API server', () => {
  it('GET /sessions returns an empty list initially', async () => {
    const res = await request('GET', '/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('POST /sessions creates a session, then GET /sessions/:id returns it', async () => {
    const session = makeSession();
    const createRes = await request('POST', '/sessions', session);
    expect(createRes.status).toBe(201);
    const getRes = await request('GET', `/sessions/${session.id}`);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { session: Session }).session).toEqual(session);
  });

  it('GET /sessions/:id returns 404 for an unknown id', async () => {
    const res = await request('GET', '/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /sessions/:id/transition applies a legal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'planning' });
    expect(res.status).toBe(200);
    expect((res.body as { session: Session }).session.stageStatus).toBe('planning');
  });

  it('POST /sessions/:id/transition returns 409 for an illegal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'approved' });
    expect(res.status).toBe(409);
  });

  it('unknown routes return 404', async () => {
    const res = await request('GET', '/nope');
    expect(res.status).toBe(404);
  });

  it('POST /workspaces creates a workspace via WorkspaceManager', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(res.status).toBe(201);
    expect((res.body as { mirrorPath: string }).mirrorPath).toBe(
      '/mirrors/github.com-org-repo.git',
    );
  });

  it('DELETE /workspaces tears down a workspace via WorkspaceManager', async () => {
    const res = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
    });
    expect(res.status).toBe(204);
  });

  it('concurrent transitions to the same target for the same session id are serialized: exactly one succeeds', async () => {
    const session = makeSession({ id: 'inv-race', stageStatus: 'findings' });
    await request('POST', '/sessions', session);
    const [r1, r2] = await Promise.all([
      request('POST', '/sessions/inv-race/transition', { to: 'planning' }),
      request('POST', '/sessions/inv-race/transition', { to: 'planning' }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });
});
