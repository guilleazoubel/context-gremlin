/**
 * The change storm: a scan that changes nothing must change nothing.
 *
 * Every 30 s tick re-ran the inventory and every one of them emitted `item.changed`
 * (`changedFields: ['attention']`) and `attention.changed` (`reasons: []`) for EVERY open PR,
 * although not one field of one PR had moved. The cause was a timestamp that moved on its own:
 * `InventoryEntry.seenAt` was the SCAN's clock, `PrSourceAdapter` feeds it to attention as
 * `fallbackSince`, and `since` is half of the attention signature — so the signature of every
 * reason-less PR was rewritten once a tick, and both delta detectors dutifully reported it.
 *
 * These cases drive the real scanner, the real `AttentionService` and the real `WorkItemService`
 * over one fake `gh`, on a clock that MOVES between scans — which is the whole point: a fixed
 * clock would have hidden the bug.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { AttentionService, PrSourceAdapter, SessionSourceAdapter } from '../../src/attention/attention-service';
import { AckStore } from '../../src/attention/ack-store';
import { WorkItemService } from '../../src/work/work-item-service';
import type { JiraScanReport } from '../../src/jira/jira-store';

const REPO = 'aplaceformom/grace-frontend';
const fullListJson = readFileSync(
  path.join(__dirname, '../fixtures/gh/pr-list-full.json'),
  'utf8',
);

const EMPTY_JIRA: JiraScanReport = {
  scannedAt: '2026-09-04T00:00:00.000Z',
  me: null,
  issues: [],
  error: null,
  kind: 'notConfigured',
};

/** Lets every fire-and-forget refresh and its scheduled recompute settle. */
async function settle(workItems: WorkItemService): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await workItems.whenIdle();
  }
}

function buildStack() {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const lock = new KeyedLock();
  const reconciliationTick = new ReconciliationTick({
    gh,
    store: h.store,
    pipeline: h.service,
    events: h.events,
    lock,
  });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  // The clock MOVES: one minute per scan, exactly as a 30 s scheduler does.
  let tick = 0;
  const now = (): Date => new Date(Date.parse('2026-09-04T12:00:00.000Z') + tick * 60_000);
  const scanner = new InventoryScanner({
    gh,
    store: h.store,
    inventoryStore,
    reconciler: { reconcile: () => reconciliationTick.run() },
    events: h.events,
    config: { repos: [REPO], me: 'me-user', watchAuthors: [], prListLimit: 50 },
    now,
  });
  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({
        store: h.store,
        fs: h.fs,
        sessionsDir: SESSIONS_DIR,
        isRunning: () => false,
        now,
      }),
      new PrSourceAdapter({ inventory: inventoryStore }),
    ],
    acks: new AckStore(h.fs, '/state/acks.json'),
    events: h.events,
    now,
  });
  const workItems = new WorkItemService({
    attention,
    inventory: inventoryStore,
    jira: { lastReport: async () => EMPTY_JIRA },
    events: h.events,
    config: { me: 'me-user', watchAuthors: [], showAllRepoPrs: false, projectKeys: [] },
  });
  attention.start();
  workItems.start();

  const itemChanged: Array<{ id: string; changedFields?: string[] }> = [];
  const attentionChanged: Array<{ ref: string; reasons: readonly string[] }> = [];
  h.events.on('item.changed', (e) => itemChanged.push(e));
  h.events.on('attention.changed', (e) =>
    attentionChanged.push({ ref: e.item.ref, reasons: e.item.attention.reasons }),
  );

  async function scan(listJson: string): Promise<void> {
    tick += 1;
    gh.queueResponse({ stdout: listJson });
    await scanner.run();
    await settle(workItems);
  }

  return { h, scan, itemChanged, attentionChanged, attention, workItems };
}

describe('a scan that changes nothing', () => {
  it('emits no item.changed and no attention.changed the second time round', async () => {
    const { scan, itemChanged, attentionChanged, attention, workItems } = buildStack();

    await scan(fullListJson);
    // The first scan is news by definition: nothing was known before it.
    expect(itemChanged.length).toBeGreaterThan(0);

    itemChanged.length = 0;
    attentionChanged.length = 0;
    await scan(fullListJson);

    expect(attentionChanged).toEqual([]);
    expect(itemChanged).toEqual([]);
    attention.stop();
    workItems.stop();
  });

  it('still reports the one PR whose reviewDecision really moved', async () => {
    const { scan, itemChanged, attention, workItems } = buildStack();
    await scan(fullListJson);

    const items = JSON.parse(fullListJson) as Array<Record<string, unknown>>;
    // #1974 is already CHANGES_REQUESTED in the fixture; APPROVED is a real move.
    const moved = items[0];
    expect(moved.number).toBe(1974);
    const changed = JSON.stringify([{ ...moved, reviewDecision: 'APPROVED' }, ...items.slice(1)]);

    itemChanged.length = 0;
    await scan(changed);

    expect(itemChanged).toHaveLength(1);
    expect(itemChanged[0].id).toBe(`pr:${REPO}#1974`);
    expect(itemChanged[0].changedFields).toContain('prs');
    attention.stop();
    workItems.stop();
  });
});
