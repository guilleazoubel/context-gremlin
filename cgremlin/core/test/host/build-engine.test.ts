import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters, type ScannerLike } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';

function testConfig(): CoreConfig {
  return resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      watchAuthors: ['bob'],
      sessionsDir: '/sessions',
      worktreesDir: '/worktrees',
      mirrorsDir: '/mirrors',
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

describe('buildEngine', () => {
  it('shares one EngineEvents instance between the returned engine and the internal pipeline', async () => {
    const engine = buildEngine(testConfig(), testAdapters());
    const seen: string[] = [];
    engine.events.on('session.created', (e) => seen.push(e.session.id));
    const session = await engine.pipeline.createInvestigationSession({
      repoUrl: '/origin/acme-app',
      ticket: 'APP-1',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    expect(seen).toEqual([session.id]);
  });

  it('shares one KeyedLock between the API server routes and the returned engine.lock', async () => {
    const engine = buildEngine(testConfig(), testAdapters());
    const dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-build-engine-'));
    const socketPath = path.join(dir, 'x.sock');
    await new Promise<void>((resolve) => engine.server.listen(socketPath, resolve));
    try {
      const session = await engine.pipeline.createInvestigationSession({
        repoUrl: '/origin/acme-app',
        ticket: 'APP-2',
        intent: 'investigate_only',
        driveToCompletion: false,
      });

      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockPromise = engine.lock.withLock(session.id, () => held);

      let responded = false;
      const reqPromise = requestOn(socketPath, 'POST', `/sessions/${session.id}/transition`, { to: 'planning' }).then(
        (r) => {
          responded = true;
          return r;
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(responded).toBe(false); // the API route is queued behind the externally-held lock

      release();
      await lockPromise;
      await reqPromise;
      expect(responded).toBe(true);
    } finally {
      await new Promise<void>((resolve) => engine.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wires the default ReconciliationTick-based scanner from CoreConfig, runnable with no errors', async () => {
    const engine = buildEngine(testConfig(), testAdapters());
    expect(engine.scanner.lastReport).toBeNull();
    const report = await engine.scanner.run();
    expect(report.errors).toEqual([]);
  });

  it('uses an injected makeTickable instead of the default ReconciliationTick-based one', () => {
    const fakeScanner: ScannerLike = {
      run: async () => ({ reconciled: 0, actions: [], skipped: [], created: [], started: [], ignoredOwn: 0, errors: [] }),
      lastReport: 'stub',
    };
    const engine = buildEngine(testConfig(), testAdapters(), { makeTickable: () => fakeScanner });
    expect(engine.scanner).toBe(fakeScanner);
  });
});
