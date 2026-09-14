import { describe, expect, it } from 'vitest';
import { WorkItemService } from '../../src/work/work-item-service';
import { AttentionService, PrSourceAdapter, SessionSourceAdapter } from '../../src/attention/attention-service';
import { AckStore } from '../../src/attention/ack-store';
import { DismissStore } from '../../src/attention/dismiss-store';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { createHarness, SESSIONS_DIR } from '../support/pipeline-harness';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import type { JiraScanReport } from '../../src/jira/jira-store';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const REPO = 'acme/app';
const PR_ID = 'pr:acme/app#1';

const EMPTY_JIRA: JiraScanReport = {
  scannedAt: '2026-09-10T00:00:00.000Z',
  me: '712020:me',
  issues: [],
  error: null,
  kind: 'ok',
};

function entry(over: Partial<InventoryEntry> & { number: number }): InventoryEntry {
  return {
    ...PHASE9_ENTRY_DEFAULTS,
    repo: REPO,
    url: `https://github.com/${REPO}/pull/${over.number}`,
    title: `PR ${over.number}`,
    author: 'bob',
    isDraft: false,
    headSha: 'sha',
    baseRef: 'main',
    updatedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    reviewDecision: '',
    isMine: false,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

async function makeFixture(entries: InventoryEntry[]) {
  const h = createHarness({});
  await h.fs.mkdir('/state', { recursive: true });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  const save = async (next: InventoryEntry[]): Promise<void> => {
    const inv: Inventory = { scannedAt: '2026-09-04T00:00:00.000Z', repos: [REPO], entries: next, errors: [] };
    await inventoryStore.save(inv);
  };
  await save(entries);
  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({ store: h.store, fs: h.fs, sessionsDir: SESSIONS_DIR, isRunning: () => false, now: () => NOW }),
      new PrSourceAdapter({ inventory: inventoryStore }),
    ],
    acks: new AckStore(h.fs, '/state/acks.json'),
    events: h.events,
    now: () => NOW,
  });
  const changed: Array<{ id: string; kind: string; changedFields?: string[] }> = [];
  h.events.on('item.changed', (e) => changed.push(e));
  const logs: string[] = [];
  const dismissals = new DismissStore(h.fs, '/state/dismissals.json');
  let jira = EMPTY_JIRA;
  let now = NOW;
  const service = new WorkItemService({
    attention,
    inventory: inventoryStore,
    jira: { lastReport: async () => jira },
    events: h.events,
    dismissals,
    log: (line) => logs.push(line),
    now: () => now,
    config: { me: 'me-user', watchAuthors: ['bob'], showAllRepoPrs: false, projectKeys: ['HB'] },
  });
  return {
    h,
    service,
    changed,
    logs,
    dismissals,
    save,
    setJira: (r: JiraScanReport) => (jira = r),
    setNow: (d: Date) => (now = d),
  };
}

describe('dismissal', () => {
  it('a dismissed item leaves every list, stays in items, and is reported in `dismissed`', async () => {
    const { service } = await makeFixture([entry({ number: 1 })]);
    const item = await service.dismiss(PR_ID);
    expect(item?.dismissed).toBe(true);
    expect(item?.dismissedAt).toBe(NOW.toISOString());

    const listing = await service.list();
    expect(listing.lists.parkingLot.untouched).toEqual([]);
    expect(listing.items.map((i) => i.id)).toEqual([PR_ID]);
    expect(listing.dismissed).toEqual([PR_ID]);
  });

  it('an undismissed item is back in its list, and both routes are idempotent', async () => {
    const { service } = await makeFixture([entry({ number: 1 })]);
    await service.dismiss(PR_ID);
    const again = await service.dismiss(PR_ID);
    expect(again?.dismissed).toBe(true);
    expect(await service.undismiss(PR_ID)).toMatchObject({ dismissed: false, dismissedAt: null });
    expect((await service.undismiss(PR_ID))?.dismissed).toBe(false);
    const listing = await service.list();
    expect(listing.lists.parkingLot.untouched).toEqual([PR_ID]);
    expect(listing.dismissed).toEqual([]);
  });

  it('an unknown item is null, never an invented one', async () => {
    const { service } = await makeFixture([entry({ number: 1 })]);
    expect(await service.dismiss('pr:acme/app#9')).toBeNull();
    expect(await service.undismiss('ticket:HB-1')).toBeNull();
  });

  it('a dismissal SURVIVES the item id changing shape, because it is keyed by every ref too', async () => {
    const { service, save } = await makeFixture([entry({ number: 1 })]);
    await service.dismiss(PR_ID);
    // The PR is later recognised as mine AND linked to HB-999: the item's id
    // becomes `ticket:HB-999`, and the dismissal has to follow it.
    await save([entry({ number: 1, isMine: true, ticketKeys: ['HB-999'] })]);
    const listing = await service.list();
    expect(listing.items.map((i) => i.id)).toEqual(['ticket:HB-999']);
    expect(listing.dismissed).toEqual(['ticket:HB-999']);
    expect(listing.items[0].dismissed).toBe(true);
  });

  it('an item that comes to need me is AUTO-UNDISMISSED, and says so once', async () => {
    const { service, save, logs, dismissals } = await makeFixture([entry({ number: 1, isMine: true })]);
    await service.dismiss(PR_ID);
    await save([
      entry({ number: 1, isMine: true, reviewDecision: 'CHANGES_REQUESTED', reviewDecisionAt: '2026-09-09T00:00:00.000Z' }),
    ]);
    const listing = await service.list();
    expect(listing.items[0].needsYou).toBe(true);
    expect(listing.items[0].dismissed).toBe(false);
    expect(listing.dismissed).toEqual([]);
    expect(await dismissals.load()).toEqual({});
    expect(logs.filter((l) => l.includes(PR_ID)).length).toBe(1);
  });

  it('item.changed fires with changedFields [dismissed] on both transitions', async () => {
    const { service, changed } = await makeFixture([entry({ number: 1 })]);
    await service.list();
    changed.length = 0;
    await service.dismiss(PR_ID);
    expect(changed).toEqual([{ id: PR_ID, kind: 'pr', changedFields: ['dismissed'] }]);
    changed.length = 0;
    await service.undismiss(PR_ID);
    expect(changed).toEqual([{ id: PR_ID, kind: 'pr', changedFields: ['dismissed'] }]);
    changed.length = 0;
    await service.dismiss(PR_ID);
    await service.dismiss(PR_ID);
    expect(changed.length).toBe(1);
  });

  it('`dismissed` is newest dismissal first', async () => {
    const { service, setNow } = await makeFixture([entry({ number: 1 }), entry({ number: 2 })]);
    await service.dismiss('pr:acme/app#1');
    setNow(new Date('2026-09-10T12:05:00.000Z'));
    await service.dismiss('pr:acme/app#2');
    const listing = await service.list();
    expect(listing.dismissed).toEqual(['pr:acme/app#2', 'pr:acme/app#1']);
  });
});
