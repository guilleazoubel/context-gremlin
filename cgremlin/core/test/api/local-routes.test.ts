import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { EnvironmentService, type LocalAppStatus } from '../../src/env/environment-service';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { createHarness, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import type { Session } from '../../src/schema/session';

const HOME = '/home/api-local';
const STATE_PATH = `${HOME}/.cgremlin/local-app.json`;
const REPO_URL = 'https://github.com/acme/app.git';
const SLUG = 'acme/app';
const WT = '/worktrees/s1';
const APP_URL = 'https://local.example.test';

function makeConfig(): CoreConfig {
  return resolveCoreConfig(
    {
      repos: [SLUG],
      me: 'me-user',
      environments: {
        [SLUG]: {
          localApp: { url: APP_URL, port: 8080, stages: ['develop'] },
          vercel: { scope: 'sc', project: 'pr', previewProject: 'pr', bypassSecret: 'S3CRET-VALUE' },
        },
      },
    },
    HOME,
  );
}

function devSession(id: string): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: { repoUrl: REPO_URL, worktreePath: WT, branch: 'feat/x' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'GS-1' },
    agent: null,
    lastRun: null,
    pr: null,
  };
}

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let local: FakeLocalAppRunner;
let environment: EnvironmentService;

function requestOn(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
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

async function startServer(withEnvironment: boolean): Promise<void> {
  local = new FakeLocalAppRunner();
  const gh = new FakeGhRunner();
  h = createHarness({
    environment: ({ fs, git, lock }) => {
      environment = new EnvironmentService({
        fs,
        gh,
        git,
        local,
        config: makeConfig(),
        sessionsDir: SESSIONS_DIR,
        statePath: STATE_PATH,
        lock,
        env: { HOME },
      });
      return environment;
    },
  });
  await h.fs.mkdir(WT, { recursive: true });
  await h.fs.writeFile(`${WT}/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));
  await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
  await h.fs.mkdir(`${WT}/node_modules`, { recursive: true });
  await h.store.save(devSession('s1'));

  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    ...(withEnvironment ? { environment } : {}),
  });
  socketPath = path.join(dir, `local-${Math.random().toString(36).slice(2)}.sock`);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-api-local-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('local-app API routes', () => {
  it('GET /sessions/:id/local returns 404 when no environment is configured', async () => {
    await startServer(false);
    const res = await requestOn('GET', '/sessions/s1/local');
    expect(res).toEqual({ status: 404, body: { error: 'environment not configured' } });
  });

  it('POST /sessions/:id/local/start returns 404 when no environment is configured', async () => {
    await startServer(false);
    const res = await requestOn('POST', '/sessions/s1/local/start');
    expect(res.status).toBe(404);
  });

  it('POST /sessions/:id/local/start starts the app and returns the running status', async () => {
    await startServer(true);
    const res = await requestOn('POST', '/sessions/s1/local/start');
    expect(res.status).toBe(200);
    const { status } = res.body as { status: LocalAppStatus };
    expect(status.state).toBe('running');
    expect(status.url).toBe(APP_URL);
    expect(status.pid).toBe(1234);
    expect(status.sessionId).toBe('s1');
    expect(local.startCalls).toHaveLength(1);
  });

  it('two concurrent POST …/local/start for one session start the app exactly once', async () => {
    await startServer(true);
    const [a, b] = await Promise.all([
      requestOn('POST', '/sessions/s1/local/start'),
      requestOn('POST', '/sessions/s1/local/start'),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(local.startCalls).toHaveLength(1);
  });

  it('POST …/local/start returns 409 with the reason when the port is held by a foreign process', async () => {
    await startServer(true);
    local.setPortListener(4242);
    const res = await requestOn('POST', '/sessions/s1/local/start');
    expect(res.status).toBe(409);
    const body = res.body as { error: string; status: LocalAppStatus };
    expect(body.error).toContain('port 8080 is held by pid 4242');
    expect(body.status.state).toBe('unavailable');
    expect(local.startCalls).toHaveLength(0);
  });

  it('POST …/local/start?fresh=1 forwards { fresh: true } to EnvironmentService.start', async () => {
    await startServer(true);
    const spy = vi.spyOn(environment, 'start');
    await requestOn('POST', '/sessions/s1/local/start?fresh=1');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), { fresh: true });
    spy.mockRestore();
  });

  it('POST …/local/stop stops the app and reports state stopped', async () => {
    await startServer(true);
    await requestOn('POST', '/sessions/s1/local/start');
    const res = await requestOn('POST', '/sessions/s1/local/stop');
    expect(res.status).toBe(200);
    expect((res.body as { status: LocalAppStatus }).status.state).toBe('stopped');
    expect(local.stopCalls).toHaveLength(1);
  });

  it('POST …/local/stop from a session that is not the owner kills nothing', async () => {
    await startServer(true);
    await h.store.save(devSession('s2'));
    await requestOn('POST', '/sessions/s1/local/start');
    const res = await requestOn('POST', '/sessions/s2/local/stop');
    expect(res.status).toBe(200);
    const { status } = res.body as { status: LocalAppStatus };
    expect(status.state).toBe('running');
    expect(status.sessionId).toBe('s1');
    expect(local.stopCalls).toHaveLength(0);
  });

  it('GET /sessions/:id/local returns the status with a redacted log tail', async () => {
    await startServer(true);
    local.setLogTail(
      `visit https://h/?x-vercel-protection-bypass=S3CRET-VALUE&x-vercel-set-bypass-cookie=true\nready\n`,
    );
    await requestOn('POST', '/sessions/s1/local/start');
    const res = await requestOn('GET', '/sessions/s1/local');
    expect(res.status).toBe(200);
    const { status } = res.body as { status: LocalAppStatus };
    expect(status.state).toBe('running');
    expect(status.logTail).toContain('x-vercel-protection-bypass=<redacted>');
    expect(JSON.stringify(res.body)).not.toContain('S3CRET-VALUE');
  });

  it('GET /sessions/:id/local asks for at most 40 log lines', async () => {
    await startServer(true);
    const tailSpy = vi.spyOn(local, 'tailLog');
    await requestOn('POST', '/sessions/s1/local/start');
    await requestOn('GET', '/sessions/s1/local');
    expect(tailSpy.mock.calls.every(([, lines]) => lines <= 40)).toBe(true);
    tailSpy.mockRestore();
  });

  it('GET /sessions/:id/local reports stopped before anything is started', async () => {
    await startServer(true);
    const res = await requestOn('GET', '/sessions/s1/local');
    expect(res.status).toBe(200);
    expect((res.body as { status: LocalAppStatus }).status.state).toBe('stopped');
  });

  it('every local route 404s for an unknown session id', async () => {
    await startServer(true);
    expect((await requestOn('GET', '/sessions/nope/local')).status).toBe(404);
    expect((await requestOn('POST', '/sessions/nope/local/start')).status).toBe(404);
    expect((await requestOn('POST', '/sessions/nope/local/stop')).status).toBe(404);
    expect(local.startCalls).toHaveLength(0);
  });

  it('GET /local and POST /local/stop address the current owner with no session id', async () => {
    await startServer(true);
    await requestOn('POST', '/sessions/s1/local/start');
    const status = await requestOn('GET', '/local');
    expect(status.status).toBe(200);
    expect((status.body as { status: LocalAppStatus }).status.sessionId).toBe('s1');
    const stopped = await requestOn('POST', '/local/stop');
    expect(stopped.status).toBe(200);
    expect((stopped.body as { status: LocalAppStatus }).status.state).toBe('stopped');
    expect(local.stopCalls).toHaveLength(1);
  });
});
