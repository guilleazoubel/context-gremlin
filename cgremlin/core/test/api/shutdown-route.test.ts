/**
 * `POST /shutdown` — the stop the engine is allowed to REFUSE.
 *
 * A SIGTERM cannot be argued with: whoever sends it wins, including a window running an extension
 * build older than the engine it is signalling. That asymmetry is what let two windows trade
 * restarts at each other. This route is the answer — the engine compares the requester's build
 * time with its own and says no to anyone who cannot prove they are newer, and a person asking
 * for a stop is always honoured.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiServerDeps } from '../../src/api/server';
import {
  decideShutdown,
  ENGINE_IS_NEWER,
  ShutdownController,
  type ShutdownRequest,
} from '../../src/api/shutdown';
import type { PipelineService } from '../../src/pipeline/pipeline-service';
import { ENGINE_NAME, ENGINE_VERSION } from '../../src/version';

function requestOn(
  socketPath: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath, path: urlPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const ENGINE_BUILT = '2026-09-10T09:00:00.000Z';
const OLDER = '2026-09-09T09:00:00.000Z';
const NEWER = '2026-09-11T09:00:00.000Z';

function ask(over: Partial<ShutdownRequest> = {}): ShutdownRequest {
  return {
    requesterBuildTime: NEWER,
    requesterBuildId: 'requester-build',
    reason: 'restart',
    ...over,
  };
}

let dir: string;
/** Unix socket paths are capped at ~104 bytes, so these stay SHORT and unique per server. */
let nextSocket = 0;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cg-shutdown-'));
  nextSocket = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Served {
  sock: string;
  closes: number;
  logs: { type: string; payload: Record<string, unknown> }[];
  close(): Promise<void>;
}

/** A server with `engineInfo` and a shutdown controller, and nothing else — the probe property. */
async function bareServer(
  opts: { engineBuildTime?: string | null; install?: boolean } = {},
): Promise<Served> {
  nextSocket += 1;
  const sock = path.join(dir, `e${nextSocket}.sock`);
  const shutdown = new ShutdownController(
    opts.engineBuildTime === undefined ? ENGINE_BUILT : opts.engineBuildTime,
  );
  const served: Served = { sock, closes: 0, logs: [], close: async () => {} };
  if (opts.install !== false) {
    shutdown.install({
      close: async () => {
        served.closes += 1;
      },
      log: (type, payload) => served.logs.push({ type, payload }),
    });
  }
  const deps = {
    pipeline: { activeSessionIds: () => [] } as unknown as PipelineService,
    shutdown,
    engineInfo: {
      name: ENGINE_NAME,
      version: ENGINE_VERSION,
      buildId: 'engine-build',
      buildTime: opts.engineBuildTime === undefined ? ENGINE_BUILT : opts.engineBuildTime,
      pid: process.pid,
      startedAt: '2026-09-10T12:00:00.000Z',
      socketPath: sock,
    },
  } as unknown as ApiServerDeps;
  const server = createApiServer(deps);
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
  served.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return served;
}

/** The response is flushed before `close()` runs, so the answer needs a tick to be observed. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('decideShutdown', () => {
  it('accepts a requester that is strictly newer than the engine', () => {
    expect(decideShutdown(ask({ requesterBuildTime: NEWER }), ENGINE_BUILT)).toEqual({
      accepted: true,
    });
  });

  it('refuses an older, an equal and an unknown requester asking for a restart', () => {
    for (const requesterBuildTime of [OLDER, ENGINE_BUILT, null]) {
      expect(decideShutdown(ask({ requesterBuildTime }), ENGINE_BUILT)).toEqual({
        accepted: false,
        reason: ENGINE_IS_NEWER,
        engineBuildTime: ENGINE_BUILT,
      });
    }
  });

  it("honours a person's stop whatever the build order says", () => {
    for (const requesterBuildTime of [OLDER, ENGINE_BUILT, null]) {
      expect(decideShutdown(ask({ requesterBuildTime, reason: 'user' }), ENGINE_BUILT)).toEqual({
        accepted: true,
      });
    }
  });

  it('refuses an automatic stop from a window that cannot prove it is newer', () => {
    expect(decideShutdown(ask({ requesterBuildTime: OLDER, reason: 'stop' }), ENGINE_BUILT)).toEqual(
      { accepted: false, reason: ENGINE_IS_NEWER, engineBuildTime: ENGINE_BUILT },
    );
  });

  /** An engine that cannot say when it was built orders as older than one that can — the same
   * rule the extension's own `classify()` applies, so the two sides can never disagree. */
  it('accepts any dated requester when the engine itself has no build time', () => {
    expect(decideShutdown(ask({ requesterBuildTime: OLDER }), null)).toEqual({ accepted: true });
    expect(decideShutdown(ask({ requesterBuildTime: null }), null)).toEqual({
      accepted: false,
      reason: ENGINE_IS_NEWER,
      engineBuildTime: null,
    });
  });
});

describe('POST /shutdown', () => {
  it('answers 202 and performs the graceful close, once, after the response', async () => {
    const srv = await bareServer();
    try {
      const res = await requestOn(srv.sock, 'POST', '/shutdown', ask());
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
      await settle();
      expect(srv.closes).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('answers 409 to a requester it is newer than, and closes nothing', async () => {
    const srv = await bareServer();
    try {
      const res = await requestOn(srv.sock, 'POST', '/shutdown', ask({ requesterBuildTime: OLDER }));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        accepted: false,
        reason: ENGINE_IS_NEWER,
        engineBuildTime: ENGINE_BUILT,
      });
      await settle();
      expect(srv.closes).toBe(0);
      // The engine is still there to answer — a refusal is not a shutdown.
      expect((await requestOn(srv.sock, 'GET', '/version')).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("honours a person's stop from a window older than the engine", async () => {
    const srv = await bareServer();
    try {
      const res = await requestOn(
        srv.sock,
        'POST',
        '/shutdown',
        ask({ requesterBuildTime: null, reason: 'user' }),
      );
      expect(res.status).toBe(202);
      await settle();
      expect(srv.closes).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('logs exactly one line per decision, naming who asked and what was decided', async () => {
    const srv = await bareServer();
    try {
      await requestOn(srv.sock, 'POST', '/shutdown', ask({ requesterBuildTime: OLDER }));
      await requestOn(srv.sock, 'POST', '/shutdown', ask());
      await settle();
      expect(srv.logs.map((l) => l.type)).toEqual(['shutdown.refused', 'shutdown.accepted']);
      expect(srv.logs[0].payload).toMatchObject({
        reason: 'restart',
        requesterBuildId: 'requester-build',
        requesterBuildTime: OLDER,
        engineBuildTime: ENGINE_BUILT,
      });
    } finally {
      await srv.close();
    }
  });

  it('rejects a body that is not a shutdown request, and closes nothing', async () => {
    const srv = await bareServer();
    try {
      for (const body of [{}, { ...ask(), reason: 'because' }, { ...ask(), requesterBuildId: 7 }]) {
        const res = await requestOn(srv.sock, 'POST', '/shutdown', body);
        expect(res.status).toBe(400);
      }
      await settle();
      expect(srv.closes).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('404s on an engine with nothing wired to close it, while /version still answers', async () => {
    const srv = await bareServer({ install: false });
    try {
      const res = await requestOn(srv.sock, 'POST', '/shutdown', ask());
      expect(res.status).toBe(404);
      expect((await requestOn(srv.sock, 'GET', '/version')).status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});
