import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { InventoryScanner, type ScanReport } from '../../src/inventory/inventory-scanner';
import type { Tickable } from '../../src/discovery/scheduler';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import { migrateV1ToV2 } from '../../src/schema/session';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { EnvironmentService } from '../../src/env/environment-service';
import { AttentionService } from '../../src/attention/attention-service';

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

  it('wires the default InventoryScanner from CoreConfig, runnable with no errors', async () => {
    const engine = buildEngine(testConfig(), testAdapters());
    expect(engine.scanner).toBeInstanceOf(InventoryScanner);
    expect(engine.scanner.lastReport).toBeNull();
    const report = await engine.scanner.run();
    expect(report.inventory.errors).toEqual([]);
    expect(report.reconciliation.errors).toEqual([]);
  });

  it('an injected makeTickable overrides what the scheduler ticks, while engine.scanner stays the real InventoryScanner', async () => {
    const fakeReport: ScanReport = {
      inventory: { scannedAt: '2026-09-04T12:00:00.000Z', repos: [], entries: [], errors: [] },
      groups: { unreviewed: [], teamOnIt: [], ours: [], mine: [] },
      reconciliation: { reconciled: 0, actions: [], skipped: [], errors: [] },
      jira: { scannedAt: '2026-09-04T12:00:00.000Z', me: null, issues: [], error: null, kind: 'notConfigured' },
      threads: { scannedAt: null, error: null, fetched: 0 },
    qa: { scannedAt: null, started: [], skipped: [], errors: [] },
    };
    const fakeTickable: Tickable<ScanReport> = { run: async () => fakeReport };
    const engine = buildEngine(testConfig(), testAdapters(), { makeTickable: () => fakeTickable });
    expect(engine.scanner).toBeInstanceOf(InventoryScanner);
    const report = await engine.scheduler.runNow();
    expect(report).toBe(fakeReport);
  });

  it(
    "the default reconciler wired into the scanner is a REAL ReconciliationTick — a 'ready' review session with a " +
      'new head sha on gh becomes reviewing after scheduler.runNow()',
    async () => {
      const gh = new FakeGhRunner();
      const engine = buildEngine(testConfig(), testAdapters({ gh }));

      const reviewId = 'pr-app-1-x';
      const oldSha = 'a'.repeat(40);
      const newSha = 'b'.repeat(40);
      const review = migrateV1ToV2({
        schemaVersion: 1,
        id: reviewId,
        mode: 'review',
        createdAt: '2026-09-04T10:00:00.000Z',
        workspace: { repoUrl: 'u', worktreePath: `/worktrees/${reviewId}`, branch: 'pr-1' },
        lineage: { pipelineId: reviewId, parentSessionId: null, ticket: null },
        stageStatus: 'ready',
      });
      if (review.mode !== 'review') throw new Error('mode changed');
      review.pr = {
        repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1',
        headSha: oldSha, reviewedSha: oldSha, title: 't', author: 'bob',
      };
      await engine.store.save(review);

      // Consumed in order: the tick's own `gh pr view` (reconciler.reconcile()
      // runs before the inventory's `pr list` scan — see InventoryScanner.run()).
      gh.queueResponse({ stdout: JSON.stringify({
        number: 1, title: 't', author: { login: 'bob' }, headRefName: 'pr-1', headRefOid: newSha,
        baseRefName: 'main', url: 'https://github.com/acme/app/pull/1', state: 'OPEN', isDraft: false,
        reviewDecision: '', mergedAt: null, closedAt: null, latestReviews: [], statusCheckRollup: [],
      }) });
      gh.queueResponse({ stdout: '[]' }); // the inventory scan's own pr-list call for acme/app

      const report = await engine.scheduler.runNow();
      expect(report.reconciliation.actions).toContainEqual(
        expect.objectContaining({ type: 'rereview', sessionId: reviewId }),
      );
      const updated = await engine.store.load(reviewId);
      expect(updated.stageStatus).toBe('reviewing');
    },
  );

  it('wires no EnvironmentService at all when there is no localApp adapter', () => {
    const engine = buildEngine(testConfig(), testAdapters());
    expect(engine.environment).toBeNull();
  });

  it('builds an EnvironmentService from the localApp adapter, sharing the engine KeyedLock', async () => {
    const localApp = new FakeLocalAppRunner();
    const fs = new InMemoryFileSystem();
    const config = testConfig();
    const engine = buildEngine(config, testAdapters({ localApp, fs }));
    expect(engine.environment).toBeInstanceOf(EnvironmentService);
    await fs.mkdir('/home/e2e/.cgremlin-core', { recursive: true });
    await fs.writeFile(
      config.localAppStatePath!,
      JSON.stringify({
        sessionId: 's1', repoSlug: 'acme/app', url: 'http://x', port: 8080,
        pid: 5, pgid: 5, logPath: '/l', startedAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    // The SAME lock: hold `local-app:8080` on engine.lock and the service's
    // own stop() must queue behind it rather than using a private lock.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPromise = engine.lock.withLock('local-app:8080', () => held);
    let stopped = false;
    const stopPromise = engine.environment!.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await lockPromise;
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it('the EnvironmentService reads and writes the configured localAppStatePath', async () => {
    const localApp = new FakeLocalAppRunner();
    const fs = new InMemoryFileSystem();
    const config = testConfig();
    const engine = buildEngine(config, testAdapters({ localApp, fs }));
    await fs.mkdir('/home/e2e/.cgremlin-core', { recursive: true });
    await fs.writeFile(
      config.localAppStatePath!,
      JSON.stringify({
        sessionId: 's1', repoSlug: 'acme/app', url: 'http://x', port: 8080,
        pid: 5, pgid: 5, logPath: '/l', startedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    const status = await engine.environment!.status();
    expect(status.state).toBe('running');
    expect(status.sessionId).toBe('s1');
  });

  it('the API server serves the local routes when an environment is wired', async () => {
    const localApp = new FakeLocalAppRunner();
    const engine = buildEngine(testConfig(), testAdapters({ localApp }));
    const dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-build-engine-local-'));
    const socketPath = path.join(dir, 'x.sock');
    await new Promise<void>((resolve) => engine.server.listen(socketPath, resolve));
    try {
      const res = await requestOn(socketPath, 'GET', '/local');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: expect.objectContaining({ state: 'stopped' }) });
    } finally {
      await new Promise<void>((resolve) => engine.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wires an AttentionService the API server serves GET /attention from', async () => {
    const engine = buildEngine(testConfig(), testAdapters());
    expect(engine.attention).toBeInstanceOf(AttentionService);
    const session = await engine.pipeline.createInvestigationSession({
      repoUrl: '/origin/acme-app',
      ticket: 'APP-2',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-build-engine-attention-'));
    const socketPath = path.join(dir, 'x.sock');
    await new Promise<void>((resolve) => engine.server.listen(socketPath, resolve));
    try {
      const res = await requestOn(socketPath, 'GET', '/attention?all=1');
      expect(res.status).toBe(200);
      const body = res.body as { items: { ref: string }[] };
      expect(body.items.map((i) => i.ref)).toEqual([`session:${session.id}`]);
    } finally {
      await new Promise<void>((resolve) => engine.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the pipeline gets the same EnvironmentService instance the engine exposes', () => {
    const localApp = new FakeLocalAppRunner();
    const engine = buildEngine(testConfig(), testAdapters({ localApp }));
    const wired = (engine.pipeline as unknown as { deps: { environment?: unknown } }).deps.environment;
    expect(wired).toBeInstanceOf(EnvironmentService);
    expect(wired).toBe(engine.environment);
  });
});
