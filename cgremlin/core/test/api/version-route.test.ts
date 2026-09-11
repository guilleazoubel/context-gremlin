import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiServerDeps } from '../../src/api/server';
import type { PipelineService } from '../../src/pipeline/pipeline-service';
import type { EnvironmentService } from '../../src/env/environment-service';
import { ENGINE_BUILD_ID, ENGINE_BUILD_TIME, ENGINE_NAME, ENGINE_VERSION } from '../../src/version';

function requestOn(socketPath: string, method: string, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const STARTED_AT = '2026-09-10T12:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-version-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Counters {
  active?: () => string[];
  inFlight?: () => number;
}

/** A server with the required `pipeline` dep and `engineInfo`, and nothing else — the probe property. */
async function bareServer(counters: Counters = {}) {
  const sock = path.join(dir, 'engine.sock');
  const pipeline = { activeSessionIds: counters.active ?? (() => []) } as unknown as PipelineService;
  const environment =
    counters.inFlight === undefined
      ? undefined
      : ({ inFlightCount: counters.inFlight } as unknown as EnvironmentService);
  const deps = {
    pipeline,
    ...(environment ? { environment } : {}),
    engineInfo: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      buildId: ENGINE_BUILD_ID,
      buildTime: ENGINE_BUILD_TIME,
      pid: process.pid,
      startedAt: STARTED_AT,
      socketPath: sock,
    },
  } as unknown as ApiServerDeps;
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
  return {
    sock,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('ENGINE_BUILD_ID', () => {
  /**
   * MG-C5's other half. Two engines can carry the same version string and be different builds —
   * they were, all through Phases 8 and 9, because the version is the package's and it did not
   * move — so the handshake the extension makes needs a second, content-addressed half. Outside
   * the bundle there is nothing to address, and `dev` is the honest answer for that.
   */
  it('is a non-empty identifier, and `dev` when the engine was not bundled', () => {
    expect(ENGINE_BUILD_ID).not.toBe('');
    expect(ENGINE_BUILD_ID).toBe('dev');
  });

  /**
   * The id says WHICH build; only the time says which of two is NEWER, and without that two
   * windows on two builds both read "not mine" and restarted the engine at each other for ever.
   * An engine that was never bundled has no time, and orders as older than one that has.
   */
  it('has no build time outside the bundle', () => {
    expect(ENGINE_BUILD_TIME).toBeNull();
  });
});

describe('ENGINE_VERSION', () => {
  it('equals the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      version: string;
      name: string;
    };
    expect(ENGINE_VERSION).toBe(pkg.version);
    expect(ENGINE_NAME).toBe('cgremlin-core');
  });
});

describe('GET /version', () => {
  it('answers 200 on a server built with no other deps, while GET /config on the same server 404s', async () => {
    const srv = await bareServer();
    try {
      const version = await requestOn(srv.sock, 'GET', '/version');
      expect(version.status).toBe(200);
      expect(version.body).toEqual({
        name: 'cgremlin-core',
        version: ENGINE_VERSION,
        buildId: ENGINE_BUILD_ID,
        buildTime: ENGINE_BUILD_TIME,
        pid: process.pid,
        startedAt: STARTED_AT,
        socketPath: srv.sock,
        activeRuns: 0,
      });
      const config = await requestOn(srv.sock, 'GET', '/config');
      expect(config.status).toBe(404);
      expect(config.body).toEqual({ error: 'config not available' });
    } finally {
      await srv.close();
    }
  });

  it('reports pid, socketPath and a stable startedAt across two calls', async () => {
    const srv = await bareServer();
    try {
      const a = (await requestOn(srv.sock, 'GET', '/version')).body as Record<string, unknown>;
      const b = (await requestOn(srv.sock, 'GET', '/version')).body as Record<string, unknown>;
      expect(a.pid).toBe(process.pid);
      expect(a.socketPath).toBe(srv.sock);
      expect(Number.isNaN(Date.parse(String(a.startedAt)))).toBe(false);
      expect(b.startedAt).toBe(a.startedAt);
    } finally {
      await srv.close();
    }
  });

  it('activeRuns counts live pipeline runs, in-flight environment preparations, and both together', async () => {
    const cases: Array<{ counters: Counters; expected: number }> = [
      { counters: {}, expected: 0 },
      { counters: { active: () => ['s1'] }, expected: 1 },
      // The W4 case: a stage still PREPARING its environment has no active run.
      { counters: { active: () => [], inFlight: () => 1 }, expected: 1 },
      { counters: { active: () => ['s1'], inFlight: () => 1 }, expected: 2 },
    ];
    for (const { counters, expected } of cases) {
      const srv = await bareServer(counters);
      try {
        const body = (await requestOn(srv.sock, 'GET', '/version')).body as { activeRuns: number };
        expect(body.activeRuns).toBe(expected);
      } finally {
        await srv.close();
      }
      await rm(path.join(dir, 'engine.sock'), { force: true });
    }
  });

  it('recomputes activeRuns per request, so it changes between two calls on one server', async () => {
    let active: string[] = [];
    const srv = await bareServer({ active: () => active });
    try {
      expect(((await requestOn(srv.sock, 'GET', '/version')).body as { activeRuns: number }).activeRuns).toBe(0);
      active = ['s1', 's2'];
      expect(((await requestOn(srv.sock, 'GET', '/version')).body as { activeRuns: number }).activeRuns).toBe(2);
    } finally {
      await srv.close();
    }
  });
});
