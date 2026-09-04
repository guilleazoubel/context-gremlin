import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '../../src/host/serve';
import type { EngineAdapters } from '../../src/host/build-engine';
import type { ScanReport } from '../../src/inventory/inventory-scanner';
import type { Tickable } from '../../src/discovery/scheduler';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { SocketInUseError } from '../../src/api/listen';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import { migrateV1ToV2 } from '../../src/schema/session';

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

function staleRunningSession(id: string) {
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'investigation',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: `/worktrees/${id}`, branch: 'investigate/STALE-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'STALE-1' },
    stageStatus: 'findings',
  });
  return {
    ...v2,
    lastRun: {
      stage: 'findings' as const,
      startedAt: '2026-09-04T10:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      signal: null,
      outcome: 'running' as const,
      error: null,
    },
  };
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

  it('close() waits for an in-flight discovery tick before it resolves', async () => {
    const clock = new FakeClock();
    let releaseTick: (() => void) | undefined;
    const tickHeld = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const fakeTickable: Tickable<ScanReport> = {
      run: async () => {
        await tickHeld;
        return {
          inventory: { scannedAt: '2026-09-04T12:00:00.000Z', repos: [], entries: [], errors: [] },
          groups: { unreviewed: [], teamOnIt: [], ours: [], mine: [] },
          reconciliation: { reconciled: 0, actions: [], skipped: [], errors: [] },
        };
      },
    };
    const handle = await serve(testConfig(), testAdapters({ clock }), {
      log: () => {},
      makeTickable: () => fakeTickable,
    });
    try {
      clock.fire();
      let closed = false;
      const closePromise = handle.close().then(() => {
        closed = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(closed).toBe(false); // the tick is still in flight
      releaseTick?.();
      await closePromise;
      expect(closed).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("close() stops only sessions the StageRunner actively tracks, leaving a stale on-disk 'running' session with no live process alone", async () => {
    const runner = new FakeAgentRunner();
    const handle = await serve(testConfig(), testAdapters({ runner }), { log: () => {} });
    try {
      await handle.engine.store.save(staleRunningSession('stale-1'));

      const liveId = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${liveId}/run`, { stage: 'findings' });
      await new Promise((r) => setTimeout(r, 20));

      const stopSpy = vi.spyOn(handle.engine.pipeline, 'stop');
      await handle.close();

      // Exactly the live session, never the stale on-disk one — a mutation
      // that iterated store.list()'s lastRun field unconditionally would
      // also call stop('stale-1') here.
      expect(stopSpy.mock.calls).toEqual([[liveId]]);
      expect(runner.isStopped(runner.lastHandle())).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('close() still completes cleanup when pipeline.stop rejects, then rethrows that error', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    const id = await createInvestigation(handle.socketPath);
    await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
    await new Promise((r) => setTimeout(r, 20));

    vi.spyOn(handle.engine.pipeline, 'stop').mockRejectedValue(new Error('stop boom'));

    await expect(handle.close()).rejects.toThrow('stop boom');
    await expect(stat(handle.socketPath)).rejects.toThrow();
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });

  it('a client holding an open connection does not block close()', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    // A raw, never-completed connection: the server never gets a full
    // request to respond to and close, so without closeAllConnections()
    // server.close() would wait for it (and this test's client) forever.
    const socket = net.createConnection(handle.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      const start = Date.now();
      await handle.close();
      expect(Date.now() - start).toBeLessThan(1000);
    } finally {
      socket.destroy();
    }
  });

  it('logs a shutdown.timeout line and still resolves close() if the server never finishes closing in time', async () => {
    const lines: string[] = [];
    const handle = await serve(testConfig(), testAdapters(), {
      log: (l) => lines.push(l),
      serverCloseTimeoutMs: 20,
    });
    const originalClose = handle.engine.server.close.bind(handle.engine.server);
    // Simulate a server.close() that never invokes its callback (e.g. a
    // connection that will never end) — never call cb.
    handle.engine.server.close = (() => handle.engine.server) as typeof handle.engine.server.close;
    try {
      await handle.close();
      const parsed = lines.map((l) => JSON.parse(l) as { type: string });
      expect(parsed.some((e) => e.type === 'shutdown.timeout')).toBe(true);
    } finally {
      handle.engine.server.close = originalClose;
      await new Promise<void>((resolve) => handle.engine.server.close(() => resolve()));
    }
  });
});
