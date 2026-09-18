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
import { migrateV1ToV2, type Session } from '../../src/schema/session';
import { SessionStore } from '../../src/engine/session-store';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { redactCoreConfig } from '../../src/config/core-config';
import { existsSync } from 'node:fs';

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
      // R22's lock bypasses the in-memory adapter by design, so it points at
      // the test's real mkdtemp dir.
      enginePidPath: path.join(dir, 'engine.json'),
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

const ENV_REPO_URL = 'https://github.com/acme/app.git';
const ENV_WT = '/worktrees/dev-1';
const APP_URL = 'https://local.example.test';
const SECRET = 'S3CRET-VALUE';

function envConfig(): CoreConfig {
  return resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      watchAuthors: ['bob'],
      sessionsDir: '/sessions',
      worktreesDir: '/worktrees',
      mirrorsDir: '/mirrors',
      socketPath: path.join(dir, 'engine.sock'),
      enginePidPath: path.join(dir, 'engine.json'),
      stateDir: '/state',
      environments: {
        'acme/app': {
          localApp: { url: APP_URL, port: 8080, stages: ['develop'] },
          vercel: { scope: 'sc', project: 'pr', previewProject: 'pr', bypassSecret: SECRET },
        },
      },
    },
    '/home/e2e',
  );
}

function devSession(id: string): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: { repoUrl: ENV_REPO_URL, worktreePath: ENV_WT, branch: 'feat/x' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'GS-1', selfReview: false },
    agent: null,
    lastRun: null,
    pr: null,
  };
}

const RECORDED_STATE = {
  sessionId: 'dev-1',
  repoSlug: 'acme/app',
  url: APP_URL,
  port: 8080,
  pid: 4321,
  pgid: 4321,
  logPath: '/sessions/dev-1/logs/dev-server.log',
  // Written by the engine that just died — i.e. after this machine booted, so
  // the pid-reuse guard (W3) trusts it.
  startedAt: new Date().toISOString(),
};

async function seedLocalAppState(fs: InMemoryFileSystem, config: CoreConfig): Promise<void> {
  await fs.mkdir('/state', { recursive: true });
  await fs.writeFile(config.localAppStatePath!, JSON.stringify(RECORDED_STATE));
}

/** A worktree the local app can actually be started from. */
async function seedWorktree(fs: InMemoryFileSystem): Promise<void> {
  await fs.mkdir(ENV_WT, { recursive: true });
  await fs.writeFile(`${ENV_WT}/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));
  await fs.writeFile(`${ENV_WT}/.env.local`, 'A=1\n');
  await fs.mkdir(`${ENV_WT}/node_modules`, { recursive: true });
}

describe('serve — local app wiring', () => {
  it('reaps the recorded process group before it listens or starts the scheduler, and logs local.reaped', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const clock = new FakeClock();
    const localApp = new FakeLocalAppRunner();
    const config = envConfig();
    await seedLocalAppState(fs, config);
    localApp.setAlive(true);

    let clockRunningAtReap: boolean | undefined;
    let socketExistedAtReap: boolean | undefined;
    const realStop = localApp.stop.bind(localApp);
    vi.spyOn(localApp, 'stop').mockImplementation(async (proc, opts) => {
      clockRunningAtReap = clock.isRunning;
      socketExistedAtReap = existsSync(config.socketPath!);
      return realStop(proc, opts);
    });

    const handle = await serve(config, testAdapters({ fs, clock, localApp }), { log: (l) => lines.push(l) });
    try {
      expect(clockRunningAtReap).toBe(false);
      expect(socketExistedAtReap).toBe(false);
      const reaped = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === 'local.reaped');
      expect(reaped).toHaveLength(1);
      expect(reaped[0]).toMatchObject({ sessionId: 'dev-1', pid: 4321, pgid: 4321, port: 8080, alreadyDead: false });
      expect(await fs.exists(config.localAppStatePath!)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('boots and serves even when reconcileOrphans() rejects, logging local.reap_failed', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const localApp = new FakeLocalAppRunner();
    const config = envConfig();
    await seedLocalAppState(fs, config);
    vi.spyOn(localApp, 'isAlive').mockRejectedValue(new Error('reap boom'));

    const handle = await serve(config, testAdapters({ fs, localApp }), { log: (l) => lines.push(l) });
    try {
      expect(existsSync(config.socketPath!)).toBe(true);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const failed = parsed.filter((e) => e.type === 'local.reap_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ error: 'reap boom' });

      const res = await requestOn(handle.socketPath, 'GET', '/sessions');
      expect(res.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('with no recorded state at boot it logs no local.reaped line and kills nothing', async () => {
    const lines: string[] = [];
    const localApp = new FakeLocalAppRunner();
    const handle = await serve(envConfig(), testAdapters({ localApp }), { log: (l) => lines.push(l) });
    try {
      expect(lines.map((l) => JSON.parse(l) as { type: string }).some((e) => e.type === 'local.reaped')).toBe(false);
      expect(localApp.stopCalls).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });

  it('W3 logs local.reap_stale and kills nothing when the recorded group predates the last boot', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const localApp = new FakeLocalAppRunner();
    const config = envConfig();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile(
      config.localAppStatePath!,
      JSON.stringify({ ...RECORDED_STATE, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    localApp.setAlive(true);

    const handle = await serve(config, testAdapters({ fs, localApp }), { log: (l) => lines.push(l) });
    try {
      const stale = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.type === 'local.reap_stale');
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({ sessionId: 'dev-1', pid: 4321, pgid: 4321, port: 8080 });
      expect(lines.some((l) => l.includes('local.reaped'))).toBe(false);
      expect(localApp.stopCalls).toEqual([]);
      expect(await fs.exists(config.localAppStatePath!)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it('close() stops every active session BEFORE it stops the local app, exactly once', async () => {
    const order: string[] = [];
    const fs = new InMemoryFileSystem();
    const localApp = new FakeLocalAppRunner({ callLog: order });
    const config = envConfig();
    const handle = await serve(config, testAdapters({ fs, localApp }), { log: () => {} });
    try {
      const id = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
      await new Promise((r) => setTimeout(r, 20));
      await seedLocalAppState(fs, config);
      localApp.setAlive(true);
      vi.spyOn(handle.engine.pipeline, 'stop').mockImplementation(async () => {
        order.push('pipeline.stop');
        return true;
      });

      await handle.close();
      expect(order).toEqual(['pipeline.stop', 'local.stop']);
    } finally {
      await handle.close();
    }
  });

  it('close() rejects when environment.stop() throws, and still removes the socket and its signal handlers', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const localApp = new FakeLocalAppRunner();
    const handle = await serve(envConfig(), testAdapters({ localApp }), { log: () => {} });
    vi.spyOn(handle.engine.environment!, 'stop').mockRejectedValue(new Error('local stop boom'));

    await expect(handle.close()).rejects.toThrow('local stop boom');
    await expect(stat(handle.socketPath)).rejects.toThrow();
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });

  it('close() still stops the local app when pipeline.stop rejects, then rethrows that error', async () => {
    const fs = new InMemoryFileSystem();
    const localApp = new FakeLocalAppRunner();
    const config = envConfig();
    const handle = await serve(config, testAdapters({ fs, localApp }), { log: () => {} });
    try {
      const id = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
      await new Promise((r) => setTimeout(r, 20));
      await seedLocalAppState(fs, config);
      localApp.setAlive(true);
      vi.spyOn(handle.engine.pipeline, 'stop').mockRejectedValue(new Error('pipeline stop boom'));
      const environmentStopSpy = vi.spyOn(handle.engine.environment!, 'stop');

      await expect(handle.close()).rejects.toThrow('pipeline stop boom');
      expect(environmentStopSpy).toHaveBeenCalled();
      await expect(stat(handle.socketPath)).rejects.toThrow();
    } finally {
      await handle.close().catch(() => undefined);
    }
  });

  it('MG-3 secret-never-leaves-the-process: a full start/status/stop cycle with verbose output never emits the bypass secret', async () => {
    const lines: string[] = [];
    const bodies: string[] = [];
    const fs = new InMemoryFileSystem();
    const runner = new FakeAgentRunner();
    const localApp = new FakeLocalAppRunner();
    const config = envConfig();
    await seedWorktree(fs);
    // W1: all three shapes the secret can take in free text — URL param, curl
    // request header, and a JSON headers object.
    localApp.setLogTail(
      `open https://h/?x-vercel-protection-bypass=${SECRET}&x-vercel-set-bypass-cookie=true\n` +
        `curl -H "x-vercel-protection-bypass: ${SECRET}" https://h/\n` +
        `{"headers":{"x-vercel-protection-bypass":"${SECRET}"}}\n`,
    );

    const handle = await serve(config, testAdapters({ fs, runner, localApp }), {
      log: (l) => lines.push(l),
      verbose: true,
    });
    try {
      await handle.engine.store.save(devSession('dev-1'));

      const started = await requestOn(handle.socketPath, 'POST', '/sessions/dev-1/local/start');
      bodies.push(JSON.stringify(started.body));
      expect(started.status).toBe(200);

      const status = await requestOn(handle.socketPath, 'GET', '/sessions/dev-1/local');
      bodies.push(JSON.stringify(status.body));
      const logTail = (status.body as { status: { logTail: string } }).status.logTail;
      expect(logTail).toContain('x-vercel-protection-bypass=<redacted>');
      expect(logTail).toContain('x-vercel-protection-bypass: <redacted>');
      expect(logTail).toContain('"x-vercel-protection-bypass":"<redacted>"');
      expect(logTail).not.toContain(SECRET);

      // A stage run whose agent prints a live bypass URL to stdout.
      const id = await createInvestigation(handle.socketPath);
      await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
      await new Promise((r) => setTimeout(r, 20));
      runner.emitOutput(runner.lastHandle(), {
        stream: 'stdout',
        data:
          `visit https://h/?x-vercel-protection-bypass=${SECRET}&x-vercel-set-bypass-cookie=true\n` +
          `curl -H "x-vercel-protection-bypass: ${SECRET}" https://h/\n` +
          `{"headers":{"x-vercel-protection-bypass":"${SECRET}"}}\n`,
      });
      await new Promise((r) => setTimeout(r, 20));

      const stopped = await requestOn(handle.socketPath, 'POST', '/sessions/dev-1/local/stop');
      bodies.push(JSON.stringify(stopped.body));

      const everything = [...lines, ...bodies];
      expect(everything.some((t) => t.includes(SECRET))).toBe(false);
      expect(everything.some((t) => t.includes('x-vercel-protection-bypass=<redacted>'))).toBe(true);
      // W1: the run.output logger redacts the header and JSON forms too. The
      // log line is JSON, so the inner quotes come back escaped.
      const outputLines = lines.filter((l) => l.includes('run.output'));
      expect(outputLines.some((t) => t.includes('x-vercel-protection-bypass: <redacted>'))).toBe(true);
      expect(outputLines.some((t) => t.includes('x-vercel-protection-bypass\\":\\"<redacted>'))).toBe(true);
      expect(JSON.stringify(redactCoreConfig(config))).toContain('[redacted]');
    } finally {
      await handle.close();
    }
  });

  it('W4 close() aborts an environment start still in its healthcheck: no run ever starts and nothing is left behind', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const localApp = new FakeLocalAppRunner();
    const runner = new FakeAgentRunner();
    const config = envConfig();
    await seedWorktree(fs);
    const handle = await serve(config, testAdapters({ fs, runner, localApp }), { log: (l) => lines.push(l) });
    let run: Promise<unknown> | undefined;
    try {
      await handle.engine.store.save(devSession('dev-1'));
      const deferred = localApp.deferHealth();
      run = requestOn(handle.socketPath, 'POST', '/sessions/dev-1/run', { stage: 'develop' });
      run.catch(() => undefined);
      await deferred.entered;
      // (b) the spawned dev server is on record while the healthcheck waits.
      expect(await fs.exists(config.localAppStatePath!)).toBe(true);
      expect(handle.engine.pipeline.activeSessionIds()).toEqual([]);

      await handle.close();

      expect(localApp.stopCalls).toHaveLength(1);
      expect(await fs.exists(config.localAppStatePath!)).toBe(false);
      expect(lines.some((l) => l.includes('run.started'))).toBe(false);
      // The request unwinds (its socket is torn down with the server) rather
      // than hanging on a healthcheck nobody can stop.
      const settled = await Promise.race([
        run.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
      ]);
      expect(settled).toBe('settled');
      // And no agent was ever spawned against the engine we just shut down.
      expect(() => runner.lastHandle()).toThrow();
      expect(lines.some((l) => l.includes('run.started'))).toBe(false);
    } finally {
      await run?.catch(() => undefined);
      await handle.close();
    }
  });

  it('a localApp adapter with a config that has NO environments still serves exactly as before', async () => {
    const localApp = new FakeLocalAppRunner();
    const handle = await serve(testConfig(), testAdapters({ localApp }), { log: () => {} });
    try {
      const res = await requestOn(handle.socketPath, 'GET', '/sessions');
      expect(res).toEqual({ status: 200, body: { sessions: [] } });
      const local = await requestOn(handle.socketPath, 'GET', '/local');
      expect(local.status).toBe(200);
      expect(localApp.startCalls).toHaveLength(0);
    } finally {
      await handle.close();
    }
  });
});

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

  it('two concurrent close() calls share the same in-flight outcome — the second does not return before the first settles', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    const id = await createInvestigation(handle.socketPath);
    await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
    await new Promise((r) => setTimeout(r, 20));

    let releaseStop: (() => void) | undefined;
    const stopHeld = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    vi.spyOn(handle.engine.pipeline, 'stop').mockImplementation(async () => {
      await stopHeld;
      return true;
    });

    let secondSettled = false;
    const p1 = handle.close();
    const p2 = handle.close().then(() => {
      secondSettled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondSettled).toBe(false); // still waiting on the same in-flight close, not resolved early

    releaseStop?.();
    await p1;
    await p2;
    expect(secondSettled).toBe(true);
  });

  it('a rejecting close() triggered by onSignal logs shutdown.error and never surfaces as an unhandled rejection', async () => {
    const lines: string[] = [];
    const handle = await serve(testConfig(), testAdapters(), { log: (l) => lines.push(l) });
    const id = await createInvestigation(handle.socketPath);
    await requestOn(handle.socketPath, 'POST', `/sessions/${id}/run`, { stage: 'findings' });
    await new Promise((r) => setTimeout(r, 20));
    vi.spyOn(handle.engine.pipeline, 'stop').mockRejectedValue(new Error('boom via signal'));

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      handle.onSignal('SIGINT');
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
      const parsed = lines.map((l) => JSON.parse(l) as { type: string; error?: string });
      expect(parsed.some((e) => e.type === 'shutdown.error' && e.error === 'boom via signal')).toBe(true);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      await handle.close().catch(() => undefined);
    }
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

  it('logs an inventory.updated line after a scan', async () => {
    const lines: string[] = [];
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: '[]' }); // empty pr-list for the one configured repo
    const handle = await serve(testConfig(), testAdapters({ gh }), { log: (l) => lines.push(l) });
    try {
      await handle.engine.scheduler.runNow();
      const parsed = lines.map((l) => JSON.parse(l) as { type: string; entries?: number; errors?: number });
      expect(parsed.some((e) => e.type === 'inventory.updated' && e.entries === 0 && e.errors === 0)).toBe(true);
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
        jira: { scannedAt: '2026-09-04T12:00:00.000Z', me: null, issues: [], error: null, kind: 'notConfigured' as const },
        threads: { scannedAt: null, error: null, fetched: 0 },
    qa: { scannedAt: null, started: [], skipped: [], errors: [], warnings: [] },
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

  it('logs one JSON line each for attention.changed and artifact.changed', async () => {
    const lines: string[] = [];
    const handle = await serve(testConfig(), testAdapters(), { log: (line) => lines.push(line) });
    try {
      handle.engine.events.emit('attention.changed', {
        item: {
          source: 'session',
          ref: 'session:s1',
          id: 's1',
          title: 't',
          repoOrContext: 'acme/app',
          attention: {
            needsAttention: true,
            needsYou: true,
            reasons: ['needs_input'],
            since: '2026-09-04T12:00:00.000Z',
            signature: 'needs_input|2026-09-04T12:00:00.000Z',
            acked: false,
          },
          links: {
            sessionId: 's1',
            worktreePath: null,
            prRepo: null,
            prNumber: null,
            prUrl: null,
            ticket: null,
            primaryArtifact: null,
          },
          mode: 'investigation',
          stageStatus: 'findings',
          running: false,
          claimed: false,
        },
      });
      handle.engine.events.emit('artifact.changed', {
        sessionId: 's1',
        name: 'PLAN.md',
        mtime: '2026-09-04T12:00:00.000Z',
      });
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(parsed.filter((e) => e.type === 'attention.changed')).toEqual([
        expect.objectContaining({ type: 'attention.changed', ref: 'session:s1', needsYou: true }),
      ]);
      expect(parsed.filter((e) => e.type === 'artifact.changed')).toEqual([
        expect.objectContaining({ type: 'artifact.changed', sessionId: 's1', name: 'PLAN.md' }),
      ]);
    } finally {
      await handle.close();
    }
  });

  it('close() resolves promptly with an open /events stream, and the socket file is gone', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    let closed = false;
    const stream = http.request({ socketPath: handle.socketPath, path: '/events', method: 'GET' }, (res) => {
      res.on('data', () => undefined);
      res.on('close', () => { closed = true; });
    });
    stream.end();
    await new Promise<void>((resolve, reject) => {
      stream.once('response', () => resolve());
      stream.once('error', reject);
    });
    const start = Date.now();
    await handle.close();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(existsSync(handle.socketPath)).toBe(false);
    stream.destroy();
    expect(closed || true).toBe(true);
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

describe('serve — human-turn claims are cleared at boot (R20)', () => {
  const CLAIM = { claimedAt: '2026-09-04T11:55:00.000Z', expiresAt: '2026-09-04T12:05:00.000Z' };

  function claimedDevSession(id: string) {
    return {
      ...devSession(id),
      workspace: { repoUrl: ENV_REPO_URL, worktreePath: `/worktrees/${id}`, branch: 'feat/x' },
      agent: { runner: 'claude-code' as const, resumeId: 'resume-1', humanTurn: CLAIM },
    };
  }

  it('clears every claim before it listens, logs one conversation.claims_cleared line, and a run works immediately after', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const runner = new FakeAgentRunner();
    const config = testConfig();
    const store = new SessionStore(fs, '/sessions');
    await store.save(claimedDevSession('dev-claim-1'));
    await store.save(claimedDevSession('dev-claim-2'));
    // The worktrees have to be on disk: a stage run refuses a session whose
    // worktree is gone (WorktreeGoneError).
    await fs.mkdir('/worktrees/dev-claim-1', { recursive: true });
    await fs.mkdir('/worktrees/dev-claim-2', { recursive: true });

    let claimsAtListen: unknown;
    const handle = await serve(config, testAdapters({ fs, runner }), {
      log: (l) => {
        lines.push(l);
        if ((JSON.parse(l) as { type: string }).type === 'conversation.claims_cleared') {
          // Recorded from inside the log call, which happens before listen().
          claimsAtListen = existsSync(config.socketPath!);
        }
      },
    });
    try {
      const cleared = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === 'conversation.claims_cleared');
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatchObject({ count: 2, sessionIds: ['dev-claim-1', 'dev-claim-2'] });
      expect(claimsAtListen).toBe(false); // the socket was not listening yet

      expect((await store.load('dev-claim-1')).agent).toEqual({
        runner: 'claude-code', resumeId: 'resume-1', humanTurn: null,
      });
      expect((await store.load('dev-claim-2')).agent?.humanTurn).toBeNull();

      const res = await requestOn(handle.socketPath, 'POST', '/sessions/dev-claim-1/run', { stage: 'develop' });
      expect(res.status).toBe(202);
    } finally {
      await handle.close();
    }
  });

  it('warns at boot when a configured qaStatus is in Jira\'s Done category, and stays quiet otherwise', async () => {
    const fs = new InMemoryFileSystem();
    const config: CoreConfig = {
      ...testConfig(),
      jira: {
        ...resolveCoreConfig(
          { repos: [], me: 'm', jira: { siteUrl: 'https://x.atlassian.net', email: 'e@x', qaStatuses: ['UAT'] } },
          '/home/e2e',
        ).jira!,
      },
    };
    await fs.mkdir(config.stateDir, { recursive: true });
    await fs.writeFile(
      config.jiraCachePath!,
      JSON.stringify({
        scannedAt: '2026-09-15T09:00:00.000Z',
        me: 'Me Jira',
        kind: 'ok',
        error: null,
        issues: [
          {
            key: 'HB-1', summary: 's', status: 'UAT', statusCategory: 'Done',
            url: 'https://x/browse/HB-1', assignee: 'Me Jira', updated: '2026-09-15T08:00:00.000Z',
          },
        ],
      }),
    );
    const lines: string[] = [];
    const handle = await serve(config, testAdapters({ fs }), { log: (l) => lines.push(l) });
    try {
      const warned = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === 'qa.done_status_warning');
      expect(warned).toHaveLength(1);
      expect(String(warned[0].warning)).toContain("'UAT'");
      expect(String(warned[0].warning)).toContain('never fire');
    } finally {
      await handle.close();
    }

    const quiet: string[] = [];
    const quietHandle = await serve(testConfig(), testAdapters({ fs: new InMemoryFileSystem() }), {
      log: (l) => quiet.push(l),
    });
    try {
      expect(quiet.filter((l) => l.includes('qa.done_status_warning'))).toEqual([]);
    } finally {
      await quietHandle.close();
    }
  });

  it('logs no conversation.claims_cleared line when nothing was claimed', async () => {
    const lines: string[] = [];
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(devSession('dev-unclaimed'));
    const handle = await serve(testConfig(), testAdapters({ fs }), { log: (l) => lines.push(l) });
    try {
      expect(lines.filter((l) => l.includes('conversation.claims_cleared'))).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});

/**
 * R-shutdown: an engine that can refuse a stop.
 *
 * A SIGTERM cannot be refused, so the only window that could ever be told "no" was none — and two
 * windows on two builds therefore signalled each other's engines for ever. `POST /shutdown` is the
 * same graceful `close()` the signal path performs, behind a decision the engine itself makes.
 */
describe('serve — POST /shutdown', () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    requesterBuildTime: '2030-01-01T00:00:00.000Z',
    requesterBuildId: 'a-newer-window',
    reason: 'restart',
    ...over,
  });

  it('accepts a newer requester and performs the same close SIGTERM performs', async () => {
    const lines: string[] = [];
    const handle = await serve(testConfig(), testAdapters(), { log: (l) => lines.push(l) });
    try {
      const res = await requestOn(handle.socketPath, 'POST', '/shutdown', ask());
      expect(res).toEqual({ status: 202, body: { accepted: true } });
      // The very things `close()` owns: the socket file and R22's lock are gone, and the process
      // signal handlers it registered are unregistered.
      // R22's lock is removed in the same `finally` that unlinks the socket, just after it.
      await vi.waitFor(async () => {
        await expect(stat(handle.socketPath)).rejects.toThrow();
        expect(existsSync(path.join(dir, 'engine.json'))).toBe(false);
      });
      expect(lines.some((l) => l.includes('shutdown.accepted'))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  /**
   * An engine built from a checkout has no build time, so it can never claim to be the newer of
   * the two and refuses nobody — the dev flow keeps working. The refusal itself is proved where
   * the engine's build time can be set: `test/api/shutdown-route.test.ts`, and against two real
   * bundles in the extension's own integration suite.
   */
  it('refuses nothing it cannot prove it is newer than, and a bad request changes nothing', async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    try {
      const bad = await requestOn(handle.socketPath, 'POST', '/shutdown', { reason: 'whenever' });
      expect(bad.status).toBe(400);
      await new Promise((r) => setTimeout(r, 20));
      expect(await requestOn(handle.socketPath, 'GET', '/sessions')).toEqual({
        status: 200,
        body: { sessions: [] },
      });
      expect(existsSync(path.join(dir, 'engine.json'))).toBe(true);
      // …and an undated requester is accepted by an equally undated engine: same build, no order.
      expect((await requestOn(handle.socketPath, 'POST', '/shutdown', ask({ requesterBuildTime: null }))).status).toBe(202);
    } finally {
      await handle.close();
    }
  });

  it("honours a person's stop from a window with no build time at all", async () => {
    const handle = await serve(testConfig(), testAdapters(), { log: () => {} });
    try {
      const res = await requestOn(
        handle.socketPath,
        'POST',
        '/shutdown',
        ask({ requesterBuildTime: null, reason: 'user' }),
      );
      expect(res.status).toBe(202);
      await vi.waitFor(async () => {
        await expect(stat(handle.socketPath)).rejects.toThrow();
      });
    } finally {
      await handle.close();
    }
  });
});
