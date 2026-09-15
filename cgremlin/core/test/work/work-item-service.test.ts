import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkItemService } from '../../src/work/work-item-service';
import { AttentionService, PrSourceAdapter, SessionSourceAdapter } from '../../src/attention/attention-service';
import { AckStore } from '../../src/attention/ack-store';
import { DismissStore } from '../../src/attention/dismiss-store';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { createHarness, SESSIONS_DIR } from '../support/pipeline-harness';
import { KeyedLock } from '../../src/api/keyed-lock';

class LoggingLock extends KeyedLock {
  readonly calls: string[] = [];
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push(`lock.enter:${key}`);
    return super.withLock(key, fn);
  }
}
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import type { JiraScanReport } from '../../src/jira/jira-store';
import { migrateV1ToV2, type Session } from '../../src/schema/session';
import type { QaTriggerState } from '../../src/qa/qa-trigger-store';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const REPO = 'acme/app';

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

function reviewSession(id: string, number: number): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${REPO}.git`, worktreePath: `/wt/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'reviewing',
  }) as Session;
  return {
    ...v2,
    pr: {
      repo: REPO,
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      headSha: 'sha',
      reviewedSha: null,
      title: `PR ${number}`,
      author: 'bob',
    },
  } as Session;
}

const EMPTY_JIRA: JiraScanReport = {
  scannedAt: '2026-09-10T00:00:00.000Z',
  me: '712020:me',
  issues: [],
  error: null,
  kind: 'ok',
};

interface QaTriggerStub {
  load(): Promise<QaTriggerState>;
}

async function makeFixture(
  entries: InventoryEntry[],
  jira: JiraScanReport = EMPTY_JIRA,
  qaTrigger?: QaTriggerStub,
) {
  const lock = new LoggingLock();
  const h = createHarness({ lock });
  await h.fs.mkdir('/state', { recursive: true });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  const inv: Inventory = { scannedAt: '2026-09-04T00:00:00.000Z', repos: [REPO], entries, errors: [] };
  await inventoryStore.save(inv);
  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({
        store: h.store,
        fs: h.fs,
        sessionsDir: SESSIONS_DIR,
        isRunning: () => false,
        now: () => NOW,
      }),
      new PrSourceAdapter({ inventory: inventoryStore }),
    ],
    acks: new AckStore(h.fs, '/state/acks.json'),
    events: h.events,
    now: () => NOW,
  });
  const changed: Array<{ id: string; kind: string; changedFields?: string[] }> = [];
  h.events.on('item.changed', (e) => changed.push(e));
  const service = new WorkItemService({
    attention,
    inventory: inventoryStore,
    jira: { lastReport: async () => jira },
    dismissals: new DismissStore(h.fs, '/state/dismissals.json'),
    events: h.events,
    config: { me: 'me-user', watchAuthors: ['bob'], showAllRepoPrs: false, projectKeys: ['HB'] },
    ...(qaTrigger !== undefined ? { qaTrigger } : {}),
  });
  return { h, lock, service, changed, inventoryStore };
}

describe('WorkItemService.list', () => {
  it('returns the four lists, the items and ticketSource', async () => {
    const { service } = await makeFixture([entry({ number: 1 })]);
    const listing = await service.list();
    expect(Object.keys(listing.lists).sort()).toEqual([
      'investigations',
      'myWork',
      'parkingLot',
      'waitingForReview',
    ]);
    expect(listing.lists.parkingLot).toEqual({
      reviewing: [],
      untouched: ['pr:acme/app#1'],
      someoneOnIt: [],
    });
    expect(listing.ticketSource).toEqual({ kind: 'ok', error: null, scannedAt: EMPTY_JIRA.scannedAt });
    expect(listing.threadSource).toEqual({ error: null, scannedAt: null });
  });

  it('a review session on a teammate PR lands the item in parkingLot.reviewing, with the agent attached', async () => {
    const { h, service } = await makeFixture([entry({ number: 1 })]);
    await h.store.save(reviewSession('r1', 1));
    const listing = await service.list();
    expect(listing.lists.parkingLot.reviewing).toEqual(['pr:acme/app#1']);
    expect(listing.items[0].agents.map((a) => a.sessionId)).toEqual(['r1']);
  });

  it('get(id) finds an item by its own id and returns null for an unknown one', async () => {
    const { service } = await makeFixture([entry({ number: 1 })]);
    expect((await service.get('pr:acme/app#1'))?.id).toBe('pr:acme/app#1');
    expect(await service.get('ticket:HB-999')).toBeNull();
  });
});

describe('Gap 2 — abandoned QA verification attempts', () => {
  const TICKET_JIRA: JiraScanReport = {
    ...EMPTY_JIRA,
    issues: [
      {
        key: 'HB-1', summary: 'a ticket', status: 'UAT', statusCategory: 'In Progress',
        assignee: null, updated: '2026-09-10T00:00:00.000Z', url: 'https://example.atlassian.net/browse/HB-1',
      },
    ],
  };

  function triggerWith(outcome: 'create-failed' | 'unreachable', reservedAt: string): QaTriggerStub {
    return {
      load: async () => ({
        ok: true,
        tickets: {
          'HB-1': {
            lastStatus: 'UAT',
            lastObservedAt: reservedAt,
            ordinal: 1,
            attempts: [{ key: 'HB-1', identity: 'x', ordinal: 1, attempt: 1, reservedAt, sessionId: null, outcome }],
          },
        },
      }),
    };
  }

  function qaSession(id: string, ticket: string): Session {
    return {
      schemaVersion: 2,
      id,
      createdAt: '2026-09-10T08:00:00.000Z',
      mode: 'qa',
      stageStatus: 'verifying',
      workspace: { repoUrl: `git@github.com:${REPO}.git`, worktreePath: `/wt/${id}` },
      lineage: { pipelineId: id, parentSessionId: null, ticket },
      agent: null,
      lastRun: null,
      pr: null,
      qa: { verifiedSha: null, verdict: null },
    } as Session;
  }

  it('surfaces the trigger store’s last create-failed attempt when no QA session exists', async () => {
    const { service } = await makeFixture([], TICKET_JIRA, triggerWith('create-failed', '2026-09-10T09:00:00.000Z'));
    const item = (await service.list()).items.find((i) => i.id === 'ticket:HB-1')!;
    expect(item.qaAttempt).toEqual({ outcome: 'create-failed', at: '2026-09-10T09:00:00.000Z' });
  });

  it('is absent once a QA session exists for the item — a real session supersedes the signal', async () => {
    const { h, service } = await makeFixture([], TICKET_JIRA, triggerWith('create-failed', '2026-09-10T09:00:00.000Z'));
    await h.store.save(qaSession('qa-1', 'HB-1'));
    const item = (await service.list()).items.find((i) => i.id === 'ticket:HB-1')!;
    expect(item.qaAttempt ?? null).toBeNull();
  });

  /**
   * Phase 16 — merged is not deployed, and the row has to be able to say so.
   * The trigger store is the one source: its last record for the ticket is
   * either the build we are WAITING on or the build we VERIFIED against.
   */
  function triggerWithBuild(outcome: string, identity: string): QaTriggerStub {
    return {
      load: async () => ({
        ok: true,
        tickets: {
          'HB-1': {
            lastStatus: 'UAT',
            lastObservedAt: '2026-09-10T09:00:00.000Z',
            ordinal: 1,
            attempts: [
              {
                key: 'HB-1', identity, ordinal: 1, attempt: 1,
                reservedAt: '2026-09-10T09:00:00.000Z', sessionId: null, outcome,
              },
            ],
          },
        },
      }),
    } as QaTriggerStub;
  }

  const BUILD = '088ce5e07db734834e4948ad3365f4155cd1ae4e';

  it('says the change is awaiting a qa deploy, naming the build QA is serving', async () => {
    const { service } = await makeFixture([], TICKET_JIRA, triggerWithBuild('awaiting-deploy', `qa:${BUILD}`));
    const item = (await service.list()).items.find((i) => i.id === 'ticket:HB-1')!;
    expect(item.qaDeploy).toEqual({ state: 'awaiting', sha: BUILD });
  });

  it('says which build a verification ran against, even though a QA session exists', async () => {
    const { h, service } = await makeFixture([], TICKET_JIRA, triggerWithBuild('started', `qa:${BUILD}`));
    await h.store.save(qaSession('qa-1', 'HB-1'));
    const item = (await service.list()).items.find((i) => i.id === 'ticket:HB-1')!;
    expect(item.qaDeploy).toEqual({ state: 'verified', sha: BUILD });
  });

  it('is null for a repo whose QA names no build — the merge-keyed fallback', async () => {
    const { service } = await makeFixture([], TICKET_JIRA, triggerWithBuild('started', 'acme/app#1@abc123'));
    const item = (await service.list()).items.find((i) => i.id === 'ticket:HB-1')!;
    expect(item.qaDeploy).toBeNull();
  });
});

describe('MG-1 work-items-never-lock-a-session', () => {
  it('a full list() records ZERO lock.enter entries', async () => {
    const { h, lock, service } = await makeFixture([entry({ number: 1 })]);
    await h.store.save(reviewSession('r1', 1));
    lock.calls.length = 0;
    await service.list();
    expect(lock.calls).toEqual([]);
  });

  it('a source grep finds no session store, readFile or statMtime under src/work', () => {
    const dir = path.join(__dirname, '../../src/work');
    for (const name of readdirSync(dir)) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      expect(text).not.toContain('SessionStore');
      expect(text).not.toContain('readFile');
      expect(text).not.toContain('statMtime');
    }
  });
});

describe('item.changed (R41)', () => {
  it('fires on a real delta and carries NO item key — only id, kind and changedFields', async () => {
    const { h, service, changed } = await makeFixture([entry({ number: 1 })]);
    service.start();
    h.events.emit('inventory.updated', {
      inventory: { scannedAt: 'x', repos: [], entries: [], errors: [] },
    });
    await service.whenIdle();
    expect(changed.length).toBe(1);
    expect(Object.keys(changed[0]).sort()).toEqual(['id', 'kind']);
    expect(changed[0]).not.toHaveProperty('item');
    service.stop();
  });

  it('a burst for one item coalesces into ONE item.changed', async () => {
    const { h, service, changed } = await makeFixture([entry({ number: 1 })]);
    service.start();
    for (let i = 0; i < 5; i += 1) {
      h.events.emit('inventory.updated', { inventory: { scannedAt: 'x', repos: [], entries: [], errors: [] } });
    }
    await service.whenIdle();
    expect(changed.filter((c) => c.id === 'pr:acme/app#1').length).toBe(1);
    service.stop();
  });

  it('a recompute with no change emits nothing, and a real change names the fields', async () => {
    const { h, service, changed, inventoryStore } = await makeFixture([entry({ number: 1 })]);
    service.start();
    h.events.emit('inventory.updated', { inventory: { scannedAt: 'x', repos: [], entries: [], errors: [] } });
    await service.whenIdle();
    changed.length = 0;

    // nothing moved
    h.events.emit('inventory.updated', { inventory: { scannedAt: 'x', repos: [], entries: [], errors: [] } });
    await service.whenIdle();
    expect(changed).toEqual([]);

    // now the PR is demoted by a human reviewer
    await inventoryStore.save({
      scannedAt: '2026-09-05T00:00:00.000Z',
      repos: [REPO],
      entries: [
        entry({
          number: 1,
          humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-09-05T00:00:00.000Z' },
        }),
      ],
      errors: [],
    });
    h.events.emit('inventory.updated', { inventory: { scannedAt: 'y', repos: [], entries: [], errors: [] } });
    await service.whenIdle();
    expect(changed.length).toBe(1);
    expect(changed[0].changedFields).toContain('demoted');
    expect(changed[0].changedFields).toContain('parkingLotGroup');
    service.stop();
  });
});
