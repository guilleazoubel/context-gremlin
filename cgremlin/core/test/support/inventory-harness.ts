import { createHarness, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW, type HarnessOptions, type PipelineHarness } from './pipeline-harness';
import { FakeGhRunner } from './fake-gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner, type InventoryScannerDeps, type ScanReport } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { DiscoveryScheduler } from '../../src/discovery/scheduler';
import { ReviewSessionFactory } from '../../src/pipeline/review-session-factory';
import type { GhRunner } from '../../src/gh/gh-runner';

export function inventoryScanConfig(
  overrides: Partial<InventoryScannerDeps['config']> = {},
): InventoryScannerDeps['config'] {
  return { repos: ['acme/app'], me: 'me-user', watchAuthors: [], prListLimit: 50, ...overrides };
}

export interface InventoryHarness {
  h: PipelineHarness;
  gh: FakeGhRunner;
  lock: KeyedLock;
  scanner: InventoryScanner;
  scheduler: DiscoveryScheduler<ScanReport>;
  factory: ReviewSessionFactory;
  inventoryStore: InventoryStore;
  config: InventoryScannerDeps['config'];
}

export function createInventoryHarness(
  configOverrides: Partial<InventoryScannerDeps['config']> = {},
  wrapGh: (gh: FakeGhRunner) => GhRunner = (gh) => gh,
  lock?: KeyedLock,
  /** 0c — e.g. a `tickets` port, so a session with a linked ticket passes the preflight. */
  harnessOptions: HarnessOptions = {},
): InventoryHarness {
  const h = createHarness(harnessOptions);
  // Share h's own lock — StageRunner/PipelineService (inside h), the
  // ReconciliationTick, and the API server must all use the SAME KeyedLock
  // instance for the per-session locking invariant (pipeline-service.ts) to
  // actually serialize anything between a scan and h.service's own calls.
  const sharedLock = lock ?? h.lock;
  const gh = new FakeGhRunner();
  const effectiveGh = wrapGh(gh);
  const config = inventoryScanConfig(configOverrides);
  const reconciliationTick = new ReconciliationTick({
    gh: effectiveGh, store: h.store, pipeline: h.service, events: h.events, lock: sharedLock,
  });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  const scanner = new InventoryScanner({
    gh: effectiveGh,
    store: h.store,
    inventoryStore,
    reconciler: { reconcile: () => reconciliationTick.run() },
    events: h.events,
    config,
    now: FIXED_NOW,
  });
  const scheduler = new DiscoveryScheduler<ScanReport>(scanner, 60_000);
  const factory = new ReviewSessionFactory({
    gh: effectiveGh, store: h.store, workspace: h.workspace, events: h.events,
    sessionsDir: SESSIONS_DIR, worktreesDir: WORKTREES_DIR, now: FIXED_NOW,
  });
  return { h, gh, lock: sharedLock, scanner, scheduler, factory, inventoryStore, config };
}
