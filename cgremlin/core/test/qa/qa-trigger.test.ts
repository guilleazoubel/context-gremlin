import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { KeyedLock } from '../../src/api/keyed-lock';
import { QaTriggerStore } from '../../src/qa/qa-trigger-store';
import { QaTriggerLeg, type QaTriggerDeps } from '../../src/qa/qa-trigger';
import { FakeGhRunner } from '../support/fake-gh-runner';
import type { WorkItem, WorkItemPr, WorkItemTicket } from '../../src/work/work-item';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const REPO = 'acme/app';
const MERGE_SHA = 'abc1234def567890abc1234def567890abc12345';

function pr(over: Partial<WorkItemPr> = {}): WorkItemPr {
  return { repo: REPO, number: 12, url: '', title: 'PR 12', state: 'merged', ...over } as WorkItemPr;
}

function ticket(over: Partial<WorkItemTicket> = {}): WorkItemTicket {
  return {
    key: 'HB-1',
    summary: 's',
    status: 'UAT',
    statusCategory: 'In Progress',
    url: '',
    assignee: 'Me Jira',
    updatedAt: '2026-09-15T11:00:00.000Z',
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return { id: 'ticket:HB-1', prs: [pr()], ticket: ticket(), agents: [], ...over } as WorkItem;
}

function mergeViewJson(sha: string | null = MERGE_SHA): string {
  return JSON.stringify({ mergeCommit: sha === null ? null : { oid: sha }, mergedAt: '2026-09-14T00:00:00.000Z', state: 'MERGED' });
}

interface Harness {
  leg: QaTriggerLeg;
  gh: FakeGhRunner;
  store: QaTriggerStore;
  created: string[];
  ran: string[];
  fs: InMemoryFileSystem;
}

function harness(over: Omit<Partial<QaTriggerDeps>, 'items'> & { items?: WorkItem[]; jiraOk?: boolean } = {}): Harness {
  const fs = new InMemoryFileSystem();
  const store = new QaTriggerStore(fs, '/state/qa.json', () => NOW);
  const gh = new FakeGhRunner();
  const created: string[] = [];
  const ran: string[] = [];
  const { items: overItems, jiraOk, ...rest } = over;
  const items = overItems ?? [item()];
  const deps: QaTriggerDeps = {
    gh,
    store,
    lock: new KeyedLock(),
    items: () => items,
    jira: () => ({ ok: jiraOk ?? true, me: 'Me Jira' }),
    config: { autoVerify: true, maxAutoStartsPerTick: 1, maxAttemptsPerEntry: 1, scanBudgetMs: 20_000, backfillOnFirstRun: false, qaStatuses: ['QA', 'UAT'] },
    qaFor: () => ({ hasUrl: true, hasTestIdentity: true }),
    qaHealth: async () => ({ ok: true, reason: null }),
    sessions: { existingFor: async () => null, activeSessionIds: () => [] },
    createSession: async (ticketKey, slug, number) => {
      created.push(`${ticketKey}:${slug}#${number}`);
      return { id: `qa-${ticketKey}` };
    },
    startRun: async (id) => {
      ran.push(id);
    },
    now: () => NOW,
    ...rest,
  };
  return { leg: new QaTriggerLeg(deps), gh, store, created, ran, fs };
}

async function tick(h: Harness, views = 1): Promise<void> {
  for (let i = 0; i < views; i += 1) h.gh.queueResponse({ stdout: mergeViewJson() });
  await h.leg.run();
}

describe('E1 — a cold or corrupt store SEEDS ONLY', () => {
  it('a cold store with a ticket already in QA creates nothing and seeds the record', async () => {
    const h = harness();
    await tick(h);
    expect(h.created).toEqual([]);
    expect((await h.store.load()).tickets['HB-1']).toMatchObject({ lastStatus: 'UAT', ordinal: 0 });
    expect(h.leg.lastReport().skipped[0].why).toContain('seeded');
  });

  it('the NEXT observed transition fires exactly one', async () => {
    const h = harness({ items: [item({ ticket: ticket({ status: 'In Progress' }) })] });
    await tick(h);
    const h2 = harness();
    // the same store, now holding lastStatus 'In Progress'
    await h2.store.observe('HB-1', 'In Progress');
    await tick(h2);
    expect(h2.created).toEqual(['HB-1:acme/app#12']);
    expect(h2.ran).toEqual(['qa-HB-1']);
  });

  it('MG-34 — a corrupt store with N candidates starts 0 and seeds N', async () => {
    const h = harness({ items: [item(), item({ id: 'ticket:HB-2', ticket: ticket({ key: 'HB-2' }) })] });
    await h.fs.mkdir('/state', { recursive: true });
    await h.fs.writeFile('/state/qa.json', 'not json');
    await tick(h);
    expect(h.created).toEqual([]);
    expect(Object.keys((await h.store.load()).tickets).sort()).toEqual(['HB-1', 'HB-2']);
  });
});

describe('MG-22 — exactly once per (key, identity, ordinal)', () => {
  async function seeded(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    await h.store.observe('HB-1', 'In Progress');
    return h;
  }

  it('three ticks yield ONE create', async () => {
    const h = await seeded();
    await tick(h);
    await tick(h);
    await tick(h);
    expect(h.created).toEqual(['HB-1:acme/app#12']);
  });

  it('a new merge sha is a new identity and fires again', async () => {
    // A new merge TOUCHES the PR, which is what tells the leg to look again
    // without a gh call for every ticket merely sitting in QA.
    const h = await seeded({ items: [item({ prs: [pr({ updatedAt: '2099-01-01T00:00:00.000Z' })] })] });
    await tick(h);
    h.gh.queueResponse({ stdout: mergeViewJson('f'.repeat(40)) });
    await h.leg.run();
    expect(h.created.length).toBe(2);
  });
});

describe('the refusals are all skipped, never errors', () => {
  it.each([
    ['autoVerify:false', { config: { autoVerify: false, maxAutoStartsPerTick: 1, maxAttemptsPerEntry: 1, scanBudgetMs: 1000, backfillOnFirstRun: false, qaStatuses: ['UAT'] } }],
    ['no qa test account', { qaFor: () => ({ hasUrl: true, hasTestIdentity: false }) }],
    ['no qa url', { qaFor: () => ({ hasUrl: false, hasTestIdentity: false }) }],
    ['a jira outage', { jiraOk: false }],
    ['a closed PR', { items: [item({ prs: [pr({ state: 'closed' })] })] }],
    ['a session already running', { sessions: { existingFor: async () => ({ id: 'qa-HB-1', stageStatus: 'verifying' }), activeSessionIds: () => ['qa-HB-1'] } }],
  ])('%s creates nothing and files no error', async (_name, over) => {
    const h = harness(over as Parameters<typeof harness>[0]);
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual([]);
    expect(h.leg.lastReport().errors).toEqual([]);
  });

  it('MG-30 — an unreachable QA creates nothing and records the attempt', async () => {
    const h = harness({ qaHealth: async () => ({ ok: false, reason: 'ECONNREFUSED' }) });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual([]);
    expect(h.leg.lastReport().skipped[0].why).toContain('qa unreachable — ECONNREFUSED');
    expect((await h.store.load()).tickets['HB-1'].attempts[0].outcome).toBe('unreachable');
  });

  it('R80 — an item spanning two repos is skipped', async () => {
    const h = harness({ items: [item({ prs: [pr(), pr({ repo: 'acme/other', number: 3 })] })] });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual([]);
    expect(h.leg.lastReport().skipped[0].why).toContain('item spans repos');
  });
});

describe('E3b — selection is bounded BEFORE any network call', () => {
  it('MG-36 — six tickets entering QA on one tick cost exactly ONE gh call', async () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      item({ id: `ticket:HB-${i}`, ticket: ticket({ key: `HB-${i}` }), prs: [pr({ number: 100 + i })] }),
    );
    const h = harness({ items });
    for (const it of items) await h.store.observe(it.ticket!.key, 'In Progress');
    await tick(h);
    expect(h.gh.calls.length).toBe(1);
    expect(h.created.length).toBe(1);
  });

  it('MG-25 — the rest fire on later ticks, newest first', async () => {
    const items = [
      item({ id: 'ticket:HB-A', ticket: ticket({ key: 'HB-A', updatedAt: '2026-09-15T09:00:00.000Z' }), prs: [pr({ number: 1 })] }),
      item({ id: 'ticket:HB-B', ticket: ticket({ key: 'HB-B', updatedAt: '2026-09-15T11:00:00.000Z' }), prs: [pr({ number: 2 })] }),
    ];
    const h = harness({ items });
    for (const it of items) await h.store.observe(it.ticket!.key, 'In Progress');
    await tick(h);
    await tick(h);
    expect(h.created).toEqual(['HB-B:acme/app#2', 'HB-A:acme/app#1']);
  });
});

describe('E2 — reserve, then run', () => {
  it('MG-35 — a factory that throws yields ONE create attempt across ten ticks', async () => {
    const h = harness({
      createSession: async () => {
        throw new Error('boom');
      },
    });
    await h.store.observe('HB-1', 'In Progress');
    for (let i = 0; i < 10; i += 1) await tick(h);
    const attempts = (await h.store.load()).tickets['HB-1'].attempts;
    expect(attempts.length).toBe(1);
    expect(attempts[0]).toMatchObject({ key: 'HB-1', ordinal: 1, attempt: 1, outcome: 'create-failed' });
    expect(h.leg.lastReport().errors).toEqual([]);
  });

  it('the cap is DATA — maxAttemptsPerEntry:2 yields exactly two', async () => {
    const h = harness({
      config: { autoVerify: true, maxAutoStartsPerTick: 1, maxAttemptsPerEntry: 2, scanBudgetMs: 1000, backfillOnFirstRun: false, qaStatuses: ['UAT'] },
      createSession: async () => {
        throw new Error('boom');
      },
    });
    await h.store.observe('HB-1', 'In Progress');
    for (let i = 0; i < 10; i += 1) await tick(h);
    expect((await h.store.load()).tickets['HB-1'].attempts.length).toBe(2);
  });

  it('a successful start records the session id and outcome started', async () => {
    const h = harness();
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect((await h.store.load()).tickets['HB-1'].attempts[0]).toMatchObject({
      sessionId: 'qa-HB-1',
      outcome: 'started',
    });
    expect(h.leg.lastReport().started).toEqual(['qa-HB-1']);
  });
});

describe('E8 — a crashed verifying session is not coverage', () => {
  it('a non-terminal qa session whose run IS live blocks a second start', async () => {
    const h = harness({
      sessions: { existingFor: async () => ({ id: 'qa-live', stageStatus: 'verifying' }), activeSessionIds: () => ['qa-live'] },
    });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual([]);
  });

  it('a verifying session the engine died under does NOT block it', async () => {
    const h = harness({
      sessions: { existingFor: async () => ({ id: 'qa-dead', stageStatus: 'verifying' }), activeSessionIds: () => [] },
    });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual(['HB-1:acme/app#12']);
  });
});

describe('single-flight and drain', () => {
  it('a second run() while one is in flight returns the SAME promise', async () => {
    const h = harness();
    h.gh.queueResponse({ stdout: mergeViewJson() });
    const a = h.leg.run();
    const b = h.leg.run();
    expect(a).toBe(b);
    await a;
    expect(h.leg.inFlight()).toBe(null);
  });
});
