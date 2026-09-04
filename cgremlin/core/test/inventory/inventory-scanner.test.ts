import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner, type InventoryScannerDeps } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { PR_INVENTORY_FIELDS } from '../../src/gh/pr-view';
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
});
