import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner, type InventoryScannerDeps } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { PR_INVENTORY_FIELDS, PR_INVENTORY_FIELDS_SCALARS, PR_INVENTORY_FIELDS_CONNECTIONS } from '../../src/gh/pr-view';
import { GhCommandError } from '../../src/gh/gh-runner';
import { SessionStore } from '../../src/engine/session-store';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { Inventory } from '../../src/inventory/inventory';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const fullListJson = readFileSync(path.join(fixturesDir, 'pr-list-full.json'), 'utf8');
const baseView = JSON.parse(readFileSync(path.join(fixturesDir, 'pr-view-open-approved.json'), 'utf8'));

const REPO = 'aplaceformom/grace-frontend';

function scannerConfig(overrides: Partial<InventoryScannerDeps['config']> = {}): InventoryScannerDeps['config'] {
  return { repos: [REPO], me: 'me-user', watchAuthors: [], prListLimit: 50, ...overrides };
}

function buildScanner(config: InventoryScannerDeps['config'] = scannerConfig()) {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const lock = new KeyedLock();
  const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  const scanner = new InventoryScanner({
    gh,
    store: h.store,
    inventoryStore,
    reconciler: { reconcile: () => reconciliationTick.run() },
    events: h.events,
    config,
    now: FIXED_NOW,
  });
  return { h, gh, lock, inventoryStore, scanner };
}

function reviewSession(overrides: {
  id?: string;
  repo?: string;
  number?: number;
  reviewedSha?: string | null;
} = {}): ReviewSession {
  const id = overrides.id ?? 'pr-app-2010-x';
  const repo = overrides.repo ?? REPO;
  const number = overrides.number ?? 2010;
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git`, worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'ready',
  }) as ReviewSession;
  return {
    ...v2,
    pr: {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      headSha: 'a'.repeat(40),
      reviewedSha: overrides.reviewedSha === undefined ? 'a'.repeat(40) : overrides.reviewedSha,
      title: 't',
      author: 'bob',
    },
  };
}

function viewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...baseView, ...overrides });
}

function inventoryItem(number: number, repo: string) {
  return {
    number, url: `https://github.com/${repo}/pull/${number}`, author: { login: 'bob' },
    isDraft: false, reviewDecision: '', headRefOid: 'a'.repeat(40), headRefName: 'feature',
    baseRefName: 'main', title: 't', updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [], reviews: [], comments: [],
  };
}

describe('InventoryScanner', () => {
  it('pins the gh pr list argv per repo using PR_INVENTORY_FIELDS', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    expect(gh.calls).toEqual([
      ['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50', '--json', PR_INVENTORY_FIELDS],
    ]);
  });

  it('mutation guard: a scan over 6 unreviewed PRs with no existing sessions creates zero sessions and starts zero runs', async () => {
    const { h, gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.entries.length).toBe(6);
    expect(await h.store.list()).toEqual([]);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('persists inventory.json equal to the report, and emits inventory.updated exactly once with the same inventory', async () => {
    const { h, gh, scanner, inventoryStore } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    const emitted: Inventory[] = [];
    h.events.on('inventory.updated', (e) => emitted.push(e.inventory));
    const report = await scanner.run();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toEqual(report.inventory);
    const loaded = await inventoryStore.load();
    expect(loaded).toEqual(report.inventory);
  });

  it('keeps the lastReport getter in sync with the most recent run', async () => {
    const { gh, scanner } = buildScanner();
    expect(scanner.lastReport).toBeNull();
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(scanner.lastReport).toEqual(report);
  });

  it('isolates a per-repo gh failure into inventory.errors without failing the whole scan', async () => {
    const { gh, scanner } = buildScanner(scannerConfig({ repos: ['acme/broken', REPO] }));
    gh.queueResponse(new Error('gh: rate limited'));
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.errors).toEqual([
      { repo: 'acme/broken', error: expect.stringContaining('rate limited') },
    ]);
    expect(report.inventory.entries.length).toBe(6);
    expect(report.inventory.repos).toEqual(['acme/broken', REPO]);
  });

  it('starts a rereview for a ready session with a new head sha, via the reconciler (existing behavior preserved)', async () => {
    const { h, gh, scanner } = buildScanner();
    const review = reviewSession({ reviewedSha: 'a'.repeat(40) });
    await h.store.save(review);
    await h.workspace.createWorkspace({
      repoUrl: `https://github.com/${REPO}.git`,
      worktreePath: `${WORKTREES_DIR}/${review.id}`,
      branchName: 'pr-2010',
      baseRef: 'origin/pr/2010',
      mode: 'review',
    });
    const newSha = 'c'.repeat(40);
    gh.queueResponse({
      stdout: viewJson({
        number: 2010, url: `https://github.com/${REPO}/pull/2010`, headRefOid: newSha, reviewDecision: '',
      }),
    });
    gh.queueResponse({ stdout: fullListJson });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // runRereview's rev-parse HEAD

    const report = await scanner.run();

    expect(report.reconciliation.actions).toContainEqual(
      expect.objectContaining({ type: 'rereview', sessionId: review.id }),
    );
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');

    // F5/M2: the scan's own store.list() must happen AFTER reconcile, so
    // this SAME tick's inventory reflects the fresh 'reviewing' phase — not
    // the stale 'ready' snapshot taken before the rereview transitioned it.
    const entry2010 = report.inventory.entries.find((e) => e.number === 2010);
    expect(entry2010?.ours.status).toBe('reviewing');
  });

  it('never throws when the fresh store.list() call rejects; the error lands in inventory.errors', async () => {
    class FailingStore extends SessionStore {
      list(): Promise<Session[]> {
        return Promise.reject(new Error('disk error'));
      }
    }
    const h = createHarness();
    const failingStore = new FailingStore(h.fs, SESSIONS_DIR);
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: failingStore, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    gh.queueResponse({ stdout: fullListJson });
    const scanner = new InventoryScanner({
      gh,
      store: failingStore,
      inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig(),
      now: FIXED_NOW,
    });

    const report = await scanner.run();

    expect(report.inventory.errors.some((e) => e.error.includes('disk error'))).toBe(true);
    expect(report.reconciliation.errors.some((e) => e.error.includes('disk error'))).toBe(true);
  });

  it('F1: a per-repo gh failure carries forward that repo\'s previous entries (with their old seenAt), not dropping them', async () => {
    const REPO2 = 'acme/other';
    let call = 0;
    const now = () => (call++ === 0 ? new Date('2026-09-04T18:00:00.000Z') : new Date('2026-09-04T19:00:00.000Z'));
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    const scanner = new InventoryScanner({
      gh, store: h.store, inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig({ repos: [REPO, REPO2] }),
      now,
    });

    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse({ stdout: JSON.stringify([inventoryItem(99, REPO2)]) });
    const report1 = await scanner.run();
    const first99 = report1.inventory.entries.find((e) => e.number === 99);
    expect(first99?.seenAt).toBe('2026-09-04T18:00:00.000Z');

    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse(new Error('gh: rate limited'));
    const report2 = await scanner.run();

    expect(report2.inventory.errors).toEqual([{ repo: REPO2, error: expect.stringContaining('rate limited') }]);
    const carried99 = report2.inventory.entries.find((e) => e.number === 99 && e.repo === REPO2);
    expect(carried99?.seenAt).toBe('2026-09-04T18:00:00.000Z'); // preserved, not overwritten
    const repoEntry = report2.inventory.entries.find((e) => e.repo === REPO && e.number === 1974);
    expect(repoEntry?.seenAt).toBe('2026-09-04T19:00:00.000Z'); // the healthy repo still gets the new timestamp
  });

  it('F3: never throws when inventoryStore.save rejects; the error lands in inventory.errors and inventory.updated still fires', async () => {
    class FailingInventoryStore extends InventoryStore {
      save(): Promise<void> {
        return Promise.reject(new Error('disk full'));
      }
    }
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const failingInventoryStore = new FailingInventoryStore(h.fs, '/state/inventory.json');
    gh.queueResponse({ stdout: fullListJson });
    const scanner = new InventoryScanner({
      gh, store: h.store, inventoryStore: failingInventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events, config: scannerConfig(), now: FIXED_NOW,
    });
    const emitted: Inventory[] = [];
    h.events.on('inventory.updated', (e) => emitted.push(e.inventory));

    const report = await scanner.run();

    expect(report.inventory.errors.some((e) => e.repo === '*' && e.error.includes('disk full'))).toBe(true);
    expect(emitted.length).toBe(1);
    expect(scanner.lastReport).toEqual(report);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A1 — R67: gh pr list can trip GitHub's GraphQL node limit.
// ---------------------------------------------------------------------------

describe('InventoryScanner: the node-limit fallback (R67)', () => {
  const scalarsJson = JSON.stringify([
    {
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      author: { login: 'bob' },
      isDraft: false,
      reviewDecision: '',
      headRefOid: 'a'.repeat(40),
      headRefName: 'feature/HB-7-x',
      baseRefName: 'main',
      title: 't',
      updatedAt: '2026-09-04T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00Z',
      changedFiles: 3,
      additions: 10,
      deletions: 1,
      labels: [{ name: 'bug' }],
      reviewRequests: [{ login: 'jane' }],
      body: 'nothing here',
    },
  ]);
  const connectionsJson = JSON.stringify([
    {
      number: 7,
      latestReviews: [],
      reviews: [{ author: { login: 'carol' }, state: 'COMMENTED', submittedAt: '2026-09-02T00:00:00Z' }],
      comments: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
  ]);

  it('issues exactly one gh pr list call on the happy path', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list').length).toBe(1);
  });

  it('a MAX_NODE_LIMIT_EXCEEDED stderr makes it issue exactly the two partitioned calls, joined on number', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'GraphQL: MAX_NODE_LIMIT_EXCEEDED something'));
    gh.queueResponse({ stdout: scalarsJson });
    gh.queueResponse({ stdout: connectionsJson });
    const report = await scanner.run();

    const listCalls = gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list');
    expect(listCalls.length).toBe(3);
    expect(listCalls[1][listCalls[1].indexOf('--json') + 1]).toBe(PR_INVENTORY_FIELDS_SCALARS);
    expect(listCalls[2][listCalls[2].indexOf('--json') + 1]).toBe(PR_INVENTORY_FIELDS_CONNECTIONS);

    expect(report.inventory.errors).toEqual([]);
    const [entry] = report.inventory.entries;
    expect(entry.number).toBe(7);
    expect(entry.changedFiles).toBe(3);
    expect(entry.ci).toBe('success');
    expect(entry.humanActivity.reviewedBy).toEqual(['carol']);
    expect(entry.reviewRequests).toEqual(['jane']);
    expect(entry.ticketKeys).toEqual([]);
  });

  it('a second limit error on the partitioned call falls back to the previous scan, and never issues a fourth call', async () => {
    const { gh, scanner, inventoryStore } = buildScanner();
    const previous: Inventory = {
      scannedAt: '2026-09-03T00:00:00.000Z',
      repos: [REPO],
      entries: [
        {
          repo: REPO,
          number: 99,
          url: `https://github.com/${REPO}/pull/99`,
          title: 'yesterday',
          author: 'bob',
          isDraft: false,
          headSha: 'a'.repeat(40),
          baseRef: 'main',
          updatedAt: '2026-09-03T00:00:00.000Z',
          reviewDecision: '',
          isMine: false,
          teamActivity: [],
          ours: { status: 'none' },
          seenAt: '2026-09-03T00:00:00.000Z',
          branch: null,
          ticketKeys: [],
          reviewRequests: [],
          humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
          createdAt: null,
          changedFiles: null,
          additions: null,
          deletions: null,
          ci: 'none',
          labels: [],
          reviewDecisionAt: null,
        },
      ],
      errors: [],
    };
    await inventoryStore.save(previous);
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'GraphQL: MAX_NODE_LIMIT_EXCEEDED'));
    gh.queueResponse({ stdout: scalarsJson });
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'exceeds the maximum node limit'));
    const report = await scanner.run();

    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list').length).toBe(3);
    expect(report.inventory.entries.map((e) => e.number)).toEqual([99]);
    expect(report.inventory.errors.length).toBe(1);
  });
});
