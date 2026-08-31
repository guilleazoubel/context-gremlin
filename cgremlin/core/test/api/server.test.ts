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
import type { SessionFileSystem } from '../../src/fs/session-file-system';

let dir: string;
let socketPath: string;
let server: http.Server;

function requestOn(
  targetSocketPath: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: targetSocketPath,
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

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return requestOn(socketPath, method, urlPath, body);
}

/**
 * Wraps a SessionFileSystem and injects a real timer delay on every
 * operation, forcing genuine event-loop interleaving between concurrent
 * requests. InMemoryFileSystem alone resolves everything via microtasks,
 * so two "concurrent" HTTP requests never actually overlap without this —
 * which is exactly how the lock's effect went untested before this fix.
 */
class DelayedFileSystem implements SessionFileSystem {
  constructor(
    private readonly inner: SessionFileSystem,
    private readonly delayMs = 5,
  ) {}

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async readFile(path: string): Promise<string> {
    await this.delay();
    return this.inner.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.delay();
    return this.inner.writeFile(path, content);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.delay();
    return this.inner.rename(from, to);
  }

  async readdir(path: string): Promise<string[]> {
    await this.delay();
    return this.inner.readdir(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delay();
    return this.inner.mkdir(path, options);
  }

  async exists(path: string): Promise<boolean> {
    await this.delay();
    return this.inner.exists(path);
  }
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

  it('POST /workspaces returns 400 for an invalid mode', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'bogus',
    });
    expect(res.status).toBe(400);
  });

  it('POST /workspaces returns 400 for a missing required field', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: '/sessions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (r) => {
          r.on('data', () => undefined);
          r.on('end', () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.write('{not valid json');
      req.end();
    });
    expect(res.status).toBe(400);
  });

  it('concurrent transitions to the same target for the same session id are serialized: exactly one succeeds', async () => {
    const delayedFs = new DelayedFileSystem(new InMemoryFileSystem());
    const git = new FakeGitRunner();
    const delayedStore = new SessionStore(delayedFs, '/sessions');
    const delayedWorkspaceManager = new WorkspaceManager(git, delayedFs, '/mirrors');
    const delayedServer = createApiServer({
      sessionStore: delayedStore,
      workspaceManager: delayedWorkspaceManager,
    });
    const delayedSocketPath = path.join(dir, 'concurrency.sock');
    await new Promise<void>((resolve) => delayedServer.listen(delayedSocketPath, resolve));

    try {
      const session = makeSession({ id: 'inv-race', stageStatus: 'findings' });
      await requestOn(delayedSocketPath, 'POST', '/sessions', session);
      const [r1, r2] = await Promise.all([
        requestOn(delayedSocketPath, 'POST', '/sessions/inv-race/transition', { to: 'planning' }),
        requestOn(delayedSocketPath, 'POST', '/sessions/inv-race/transition', { to: 'planning' }),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
    } finally {
      await new Promise<void>((resolve) => delayedServer.close(() => resolve()));
      await rm(delayedSocketPath, { force: true });
    }
  });
});
