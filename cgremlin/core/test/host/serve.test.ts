import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '../../src/host/serve';
import type { EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { SocketInUseError } from '../../src/api/listen';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';

function requestOn(
  socketPath: string,
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

async function createInvestigation(socketPath: string): Promise<string> {
  const res = await requestOn(socketPath, 'POST', '/sessions/investigations', {
    repoUrl: '/origin/acme-app',
    ticket: 'APP-1',
    intent: 'investigate_only',
    driveToCompletion: false,
  });
  return (res.body as { session: { id: string } }).session.id;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-serve-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function testConfig(): CoreConfig {
  return resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      watchAuthors: ['bob'],
      sessionsDir: '/sessions',
      worktreesDir: '/worktrees',
      mirrorsDir: '/mirrors',
      socketPath: path.join(dir, 'engine.sock'),
    },
    '/home/e2e',
  );
}

function testAdapters(overrides: Partial<EngineAdapters> = {}): EngineAdapters {
  return {
    fs: new InMemoryFileSystem(),
    git: new FakeGitRunner(),
    gh: new FakeGhRunner(),
    runner: new FakeAgentRunner(),
    runnerKind: 'claude-code',
    clock: new FakeClock(),
    now: () => new Date('2026-09-04T12:00:00.000Z'),
    ...overrides,
  };
}

describe('serve', () => {
  it('answers GET /sessions over the configured socket', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    try {
      const res = await requestOn(handle.socketPath, 'GET', '/sessions');
      expect(res).toEqual({ status: 200, body: { sessions: [] } });
    } finally {
      await handle.close();
    }
  });

  it('close() stops the scheduler', async () => {
    const clock = new FakeClock();
    const handle = await serve(testConfig(), testAdapters({ clock }), { log: () => {} });
    expect(clock.isRunning).toBe(true);
    await handle.close();
    expect(clock.isRunning).toBe(false);
  });

  it("close() stops a running session's agent", async () => {
    const runner = new FakeAgentRunner();
    const handle = await serve(testConfig(), testAdapters({ runner }), { log: () => {} });
    try {
      const id = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
      await new Promise((r) => setTimeout(r, 20));
      const agentHandle = runner.lastHandle();
      expect(runner.isStopped(agentHandle)).toBe(false);
      await handle.close();
      expect(runner.isStopped(agentHandle)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('close() closes the server — a request afterwards fails', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    await handle.close();
    await expect(requestOn(handle.socketPath, 'GET', '/sessions')).rejects.toThrow();
  });

  it('close() removes the socket file', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    await handle.close();
    await expect(stat(handle.socketPath)).rejects.toThrow();
  });

  it('close() is idempotent — a second call is a no-op', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
  });

  it('a second serve() on the same socket while the first runs rejects with SocketInUseError', async () => {
    const config = testConfig();
    const handle = await serve(config, testAdapters(), { log: () => {} });
    try {
      await expect(serve(config, testAdapters(), { log: () => {} })).rejects.toThrow(SocketInUseError);
    } finally {
      await handle.close();
    }
  });

  it('logs one JSON line per engine event, including session.created and run.started', async () => {
    const lines: string[] = [];
    const handle = await serve(testConfig(), testAdapters(), { log: (line) => lines.push(line) });
    try {
      const id = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
      const parsed = lines.map((l) => JSON.parse(l) as { type: string; sessionId?: string });
      expect(parsed.some((e) => e.type === 'session.created' && e.sessionId === id)).toBe(true);
      expect(parsed.some((e) => e.type === 'run.started' && e.sessionId === id)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('onSignal triggers close() and removes the process signal handlers it registered', async () => {
    const before = process.listenerCount('SIGINT');
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    try {
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      handle.onSignal('SIGINT');
      await new Promise((r) => setTimeout(r, 20));
      expect(process.listenerCount('SIGINT')).toBe(before);
      await expect(stat(handle.socketPath)).rejects.toThrow(); // close() actually ran
    } finally {
      await handle.close();
    }
  });
});
