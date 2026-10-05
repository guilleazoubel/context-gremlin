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
import { PR_STATE_ENTRY_DEFAULTS } from '../support/pr-state-entry';
import { JiraAuthError, JiraUnavailableError, type JiraIssueDetail, type JiraSource } from '../../src/jira/jira-source';

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
    qa: { scannedAt: null, started: [], skipped: [], errors: [], warnings: [] },
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
      const adapters = testAdapters({ gh });
      const engine = buildEngine(testConfig(), adapters);

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
      // The worktree has to be on disk: a stage run refuses a session whose
      // worktree is gone (WorktreeGoneError).
      await adapters.fs.mkdir(`/worktrees/${reviewId}`, { recursive: true });

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

describe('the QA brief context (qaContext)', () => {
  const REPO = 'acme/app';
  const MERGE_SHA = 'abc1234def567890abc1234def567890abc12345';

  async function seedQa(adapters: EngineAdapters, config: CoreConfig) {
    const fs = adapters.fs as InMemoryFileSystem;
    // A merged PR the open-PR inventory no longer has — exactly what the
    // pr-state leg caches.
    await fs.mkdir(config.stateDir, { recursive: true });
    await fs.writeFile(
      config.prStatesCachePath!,
      JSON.stringify({
        [`${REPO}#12`]: {
          ...PR_STATE_ENTRY_DEFAULTS,
          state: 'merged',
          title: 'feat(HB-1489): web content',
          url: `https://github.com/${REPO}/pull/12`,
          mergedAt: '2026-09-14T09:00:00.000Z',
          author: 'alice',
          changedFiles: 3,
          additions: 120,
          deletions: 4,
          ticketKeys: ['HB-1489'],
          branch: 'HB-1489-web-content',
          closedAt: null,
          checkedAt: '2026-09-15T09:00:00.000Z',
        },
      }),
    );
    // An earlier review session on the SAME ticket, with two of the four
    // artifacts actually written.
    const review = {
      schemaVersion: 2, id: 'rev-1', mode: 'review', createdAt: '2026-09-01T10:00:00.000Z',
      workspace: { repoUrl: `https://github.com/${REPO}.git` },
      lineage: { pipelineId: 'rev-1', parentSessionId: null, ticket: 'HB-1489', selfReview: false },
      agent: null, lastRun: null, pr: null, stageStatus: 'ready', reviewVersion: 1, lastRereviewSummary: null,
    };
    await fs.mkdir('/sessions/rev-1', { recursive: true });
    await fs.writeFile('/sessions/rev-1/session.json', JSON.stringify(review));
    await fs.writeFile('/sessions/rev-1/REVIEW.md', '# review');
    await fs.writeFile('/sessions/rev-1/FINDINGS.md', '# findings');

    const qa = {
      schemaVersion: 2, id: 'qa-1', mode: 'qa', createdAt: '2026-09-15T10:00:00.000Z',
      workspace: { repoUrl: `https://github.com/${REPO}.git`, worktreePath: '/worktrees/qa-1', branch: 'qa/HB-1489-abc1234' },
      lineage: { pipelineId: 'qa-1', parentSessionId: null, ticket: 'HB-1489', selfReview: false },
      agent: null, lastRun: null,
      pr: { repo: REPO, number: 12, url: `https://github.com/${REPO}/pull/12`, headSha: MERGE_SHA, reviewedSha: null, title: 'feat(HB-1489): web content', author: 'alice' },
      stageStatus: 'queued', qa: { verifiedSha: null, verdict: null },
    };
    await fs.mkdir('/sessions/qa-1', { recursive: true });
    await fs.writeFile('/sessions/qa-1/session.json', JSON.stringify(qa));
  }

  it('the brief names the ticket and its ACs, the merged PR, and every artifact that EXISTS', async () => {
    const config = testConfig();
    const adapters = testAdapters();
    await seedQa(adapters, config);
    const engine = buildEngine(config, adapters, {
      ticketDetail: {
        detail: async () => ({
          ticket: {
            key: 'HB-1489', summary: 'Web content', status: 'UAT',
            statusCategory: 'In Progress', assignee: 'Me Jira', assigneeName: 'Me Jira',
            updated: '2026-09-14T00:00:00.000Z',
            url: 'https://jira.invalid/browse/HB-1489',
            descriptionText: 'AC1: the block renders.\nAC2: the API returns 200.',
            comments: [{ author: 'bob', at: '2026-09-13T00:00:00.000Z', bodyText: 'ready for QA' }],
          },
          ticketError: null,
          ticketErrorKind: null,
        }),
      },
    });
    await engine.pipeline.prepareQaSession('qa-1');
    const brief = await (adapters.fs as InMemoryFileSystem).readFile('/sessions/qa-1/BRIEF.md');

    expect(brief).toContain('# QA VERIFICATION — HB-1489 (acme/app#12, merged abc1234)');
    expect(brief).toContain('## Ticket HB-1489 — Web content');
    expect(brief).toContain('AC1: the block renders.');
    expect(brief).toContain('AC2: the API returns 200.');
    expect(brief).toContain('## The change');
    expect(brief).toContain('feat(HB-1489): web content');
    expect(brief).toContain('3 files changed, +120/−4');
    expect(brief).toContain('## What we already know');
    expect(brief).toContain('/sessions/rev-1/REVIEW.md');
    expect(brief).toContain('/sessions/rev-1/FINDINGS.md');
    // Never a path to a file that is not there.
    expect(brief).not.toContain('PLAN.md');
    expect(brief).not.toContain('COMMENTS.md');
  });
});

describe('0c — the engine\'s ticket brief state (tickets.briefState / tickets.linking)', () => {
  const SENTINEL = 'SENTINEL-TOKEN-123';

  function jiraConfig(projectKeys: string[], apiToken: string | null = SENTINEL): CoreConfig {
    return resolveCoreConfig(
      {
        repos: ['acme/app'],
        me: 'me-user',
        watchAuthors: ['bob'],
        sessionsDir: '/sessions',
        worktreesDir: '/worktrees',
        mirrorsDir: '/mirrors',
        jira: {
          siteUrl: 'https://jira.invalid',
          email: 'me@example.invalid',
          ...(apiToken === null ? {} : { apiToken }),
          projectKeys,
        },
      },
      '/home/e2e',
    );
  }

  function detail(key: string): JiraIssueDetail {
    return {
      key, summary: 'Web content', status: 'UAT', statusCategory: 'indeterminate',
      assignee: null, assigneeName: null, updated: '2026-09-14T00:00:00.000Z',
      url: `https://jira.invalid/browse/${key}`, descriptionText: 'AC1', comments: [],
    };
  }

  function stubSource(error?: unknown): JiraSource {
    return {
      search: async () => [],
      whoami: async () => ({ accountId: 'x', displayName: 'x' }),
      issue: async (key) => {
        if (error !== undefined) throw error;
        return detail(key);
      },
    };
  }

  it('maps each failure to its not_loaded reason and never rejects; success is loaded', async () => {
    const cases: Array<[unknown, string]> = [
      [new JiraAuthError(`401 for ${SENTINEL}`, 401), 'auth'],
      [new JiraUnavailableError(`timeout ${SENTINEL}`), 'unavailable'],
      [new Error(`weird ${SENTINEL}`), 'unavailable'],
      ['a thrown string', 'unavailable'],
    ];
    for (const [error, reason] of cases) {
      const engine = buildEngine(jiraConfig(['HB']), testAdapters(), { jiraSource: stubSource(error) });
      const state = await engine.tickets.briefState('HB-1');
      expect(state).toEqual({ kind: 'not_loaded', key: 'HB-1', reason });
      expect(JSON.stringify(state)).not.toContain(SENTINEL);
    }
    const engine = buildEngine(jiraConfig(['HB']), testAdapters(), { jiraSource: stubSource() });
    const loaded = await engine.tickets.briefState('HB-1');
    expect(loaded).toEqual({
      kind: 'loaded',
      ticket: { key: 'HB-1', summary: 'Web content', status: 'UAT', url: 'https://jira.invalid/browse/HB-1', descriptionText: 'AC1', comments: [] },
    });
    expect(JSON.stringify(loaded)).not.toContain(SENTINEL);
  });

  it('a ticket reader that itself rejects is unavailable, not a rejection', async () => {
    const engine = buildEngine(jiraConfig(['HB']), testAdapters(), {
      ticketDetail: { detail: async () => { throw new Error(SENTINEL); } },
    });
    const state = await engine.tickets.briefState('HB-1');
    expect(state).toEqual({ kind: 'not_loaded', key: 'HB-1', reason: 'unavailable' });
    expect(JSON.stringify(state)).not.toContain(SENTINEL);
  });

  it('no Jira source (no jira block, or no apiToken) is not_configured', async () => {
    for (const config of [testConfig(), jiraConfig(['HB'], null)]) {
      const engine = buildEngine(config, testAdapters());
      expect(await engine.tickets.briefState('HB-1')).toEqual({ kind: 'not_loaded', key: 'HB-1', reason: 'not_configured' });
    }
  });

  it('linking is disabled iff jira.projectKeys is empty', () => {
    expect(buildEngine(jiraConfig([]), testAdapters(), { jiraSource: stubSource() }).tickets.linking).toBe('disabled');
    expect(buildEngine(testConfig(), testAdapters()).tickets.linking).toBe('disabled');
    expect(buildEngine(jiraConfig(['HB']), testAdapters(), { jiraSource: stubSource() }).tickets.linking).toBe('configured');
  });
});
