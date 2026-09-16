import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { KeyedLock } from '../../src/api/keyed-lock';
import { QaTriggerStore } from '../../src/qa/qa-trigger-store';
import { QaTriggerLeg, type QaTriggerDeps } from '../../src/qa/qa-trigger';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { PrStateResolver, PrStateStore, prStateKey } from '../../src/gh/pr-state';
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
    sessions: { existingFor: async () => null, isRunningNow: () => false },
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
    ['a session already running', { sessions: { existingFor: async () => ({ id: 'qa-HB-1', stageStatus: 'verifying' }), isRunningNow: (id: string) => id === 'qa-HB-1' } }],
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
      sessions: { existingFor: async () => ({ id: 'qa-live', stageStatus: 'verifying' }), isRunningNow: (id: string) => id === 'qa-live' },
    });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.created).toEqual([]);
  });

  it('a verifying session the engine died under does NOT block it', async () => {
    const h = harness({
      sessions: { existingFor: async () => ({ id: 'qa-dead', stageStatus: 'verifying' }), isRunningNow: () => false },
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

describe('MG-38 — the Done-category trap is surfaced, not silently fatal', () => {
  it('warns when a configured qaStatus resolves to statusCategory Done in the snapshot', async () => {
    const h = harness({
      items: [item({ ticket: ticket({ status: 'UAT', statusCategory: 'Done' }) })],
    });
    await h.leg.run();
    const warnings = h.leg.lastReport().warnings;
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('UAT');
    expect(warnings[0]).toContain('Done');
    expect(warnings[0]).toContain('never fire');
    // It is a warning, not a failure.
    expect(h.leg.lastReport().errors).toEqual([]);
  });

  it('warns once per status, not once per ticket', async () => {
    const h = harness({
      items: [
        item({ ticket: ticket({ key: 'HB-1', status: 'UAT', statusCategory: 'Done' }) }),
        item({ id: 'ticket:HB-2', ticket: ticket({ key: 'HB-2', status: 'UAT', statusCategory: 'Done' }) }),
      ],
    });
    await h.leg.run();
    expect(h.leg.lastReport().warnings.length).toBe(1);
  });

  it('is quiet when every qaStatus is outside the Done category', async () => {
    const h = harness();
    await h.leg.run();
    expect(h.leg.lastReport().warnings).toEqual([]);
  });
});

describe('E7/R78 — the Done close is not a bulldozer', () => {
  function doneItem(): WorkItem {
    return item({ ticket: ticket({ status: 'Done', statusCategory: 'Done' }) });
  }

  it('stops the run and transitions a live qa session to closed', async () => {
    const stopped: string[] = [];
    const closed: string[] = [];
    const h = harness({
      items: [doneItem()],
      sessions: { existingFor: async () => ({ id: 'qa-1', stageStatus: 'ready', claimed: false }), isRunningNow: () => false },
      stopSession: async (id) => {
        stopped.push(id);
      },
      closeSession: async (id) => {
        closed.push(id);
      },
    });
    await h.leg.run();
    expect(stopped).toEqual(['qa-1']);
    expect(closed).toEqual(['qa-1']);
  });

  it('leaves a CLAIMED session alone and reports it as skipped', async () => {
    const closed: string[] = [];
    const h = harness({
      items: [doneItem()],
      sessions: { existingFor: async () => ({ id: 'qa-1', stageStatus: 'ready', claimed: true }), isRunningNow: () => false },
      closeSession: async (id) => {
        closed.push(id);
      },
    });
    await h.leg.run();
    expect(closed).toEqual([]);
    expect(h.leg.lastReport().skipped.some((s) => s.why.includes('claim'))).toBe(true);
    expect(h.leg.lastReport().errors).toEqual([]);
  });

  it('a session with no ticket key is never auto-closed (MG-38)', async () => {
    const closed: string[] = [];
    const h = harness({
      items: [item({ ticket: null })],
      closeSession: async (id) => {
        closed.push(id);
      },
    });
    await h.leg.run();
    expect(closed).toEqual([]);
  });
});

describe('R84/E10 — the PR-less entry', () => {
  function prless(): WorkItem {
    return item({ prs: [] });
  }

  it('MG-31 — makes ONE gh pr list --search, and does not search again for the same ordinal', async () => {
    const h = harness({ items: [prless()], qaRepos: () => [REPO] });
    await h.store.observe('HB-1', 'In Progress');
    h.gh.queueResponse({
      stdout: JSON.stringify([{ number: 77, mergeCommit: { oid: MERGE_SHA }, mergedAt: '2026-09-14T00:00:00.000Z' }]),
    });
    await h.leg.run();
    // Phase 18 widens the projection to the whole pr-state row, so ONE search also FILLS the
    // cache — the manual leg needs the state, the title and the branch, not just the merge sha.
    expect(h.gh.calls[0].slice(0, 8)).toEqual([
      'pr', 'list', '--repo', REPO, '--search', 'HB-1', '--state', 'merged',
    ]);
    expect(h.gh.calls[0][9]).toContain('mergeCommit');
    expect(h.created).toEqual(['HB-1:acme/app#77']);
    await h.leg.run();
    expect(h.gh.calls.length).toBe(1);
  });

  it('zero matches is a skip with a reason, and the attempt is recorded', async () => {
    const h = harness({ items: [prless()], qaRepos: () => [REPO] });
    await h.store.observe('HB-1', 'In Progress');
    h.gh.queueResponse({ stdout: '[]' });
    await h.leg.run();
    expect(h.created).toEqual([]);
    expect(h.leg.lastReport().skipped[0].why).toContain('no merged pr for HB-1');
    expect((await h.store.load()).tickets['HB-1'].attempts.length).toBe(1);
  });

  it('no repo can be named ⇒ nothing is searched at all', async () => {
    const h = harness({ items: [prless()], qaRepos: () => [] });
    await h.store.observe('HB-1', 'In Progress');
    await h.leg.run();
    expect(h.gh.calls).toEqual([]);
    expect(h.created).toEqual([]);
  });
});

/**
 * Phase 16 item 2 — the flaw Phase 15 shipped with: it fired on MERGED, and
 * merging is not deploying. The change is verifiable only once the build QA is
 * serving actually contains it.
 */
describe('the change must be IN the qa build', () => {
  const DEPLOYED = '088ce5e07db734834e4948ad3365f4155cd1ae4e';

  async function seeded(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    await h.store.observe('HB-1', 'In Progress');
    return h;
  }

  it('a merged sha that is NOT in the deployed build starts nothing and records "awaiting"', async () => {
    const h = await seeded({ qaVersion: async () => DEPLOYED, isAncestor: async () => false });
    await tick(h);
    expect(h.created).toEqual([]);
    expect(h.leg.lastReport().skipped[0].why).toContain('not in the qa build yet');
    const attempts = (await h.store.load()).tickets['HB-1'].attempts;
    expect(attempts.map((a) => a.outcome)).toEqual(['awaiting-deploy']);
    expect(attempts[0].identity).toBe(`qa:${DEPLOYED}`);
  });

  it('the same undeployed build on a later tick costs no further gh call', async () => {
    const h = await seeded({ qaVersion: async () => DEPLOYED, isAncestor: async () => false });
    await tick(h);
    const after = h.gh.calls.length;
    await h.leg.run();
    expect(h.gh.calls.length).toBe(after);
    expect(h.created).toEqual([]);
  });

  it('once the merge IS an ancestor of the deployed sha, exactly one start, keyed on the BUILD', async () => {
    const h = await seeded({ qaVersion: async () => DEPLOYED, isAncestor: async () => true });
    await tick(h);
    expect(h.created).toEqual(['HB-1:acme/app#12']);
    expect((await h.store.load()).tickets['HB-1'].attempts.at(-1)!.identity).toBe(`qa:${DEPLOYED}`);
  });

  it('the same deployed sha on three more ticks starts nothing more', async () => {
    const h = await seeded({ qaVersion: async () => DEPLOYED, isAncestor: async () => true });
    await tick(h);
    await tick(h);
    await tick(h);
    expect(h.created).toEqual(['HB-1:acme/app#12']);
  });

  it('a repo with no version endpoint keeps the OLD merge-keyed behaviour, and says so ONCE', async () => {
    const lines: string[] = [];
    const h = await seeded({ qaVersion: async () => null, log: (line) => lines.push(line) });
    await tick(h);
    await tick(h);
    expect(h.created).toEqual(['HB-1:acme/app#12']);
    expect((await h.store.load()).tickets['HB-1'].attempts.at(-1)!.identity).toBe(`${REPO}#12@${MERGE_SHA}`);
    expect(lines.filter((l) => l.includes('acme/app')).length).toBe(1);
  });
});

/**
 * Phase 16 item 3 — a new QA cut is a NEW question. A later build can break
 * what an earlier one passed, so a ticket still sitting in a QA status
 * verifies again against the build that has just landed — re-running the
 * session it already has (which archives the previous QA.md) rather than
 * opening a second one.
 */
describe('a new qa build re-verifies', () => {
  const BUILD_1 = '088ce5e07db734834e4948ad3365f4155cd1ae4e';
  const BUILD_2 = 'b'.repeat(40);

  function rebuilding(builds: string[], over: Parameters<typeof harness>[0] = {}) {
    let existing: { id: string; stageStatus: string } | null = null;
    const h = harness({
      qaVersion: async () => builds[0],
      isAncestor: async () => true,
      sessions: { existingFor: async () => existing, isRunningNow: () => false },
      ...over,
    });
    return {
      h,
      cut: (sha: string) => {
        builds[0] = sha;
      },
      finish: (id: string, stageStatus: string) => {
        existing = { id, stageStatus };
      },
    };
  }

  it('the same build twice does nothing; a new build starts exactly one more run', async () => {
    const builds = [BUILD_1];
    const { h, cut, finish } = rebuilding(builds);
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    expect(h.ran).toEqual(['qa-HB-1']);
    finish('qa-HB-1', 'ready');
    await tick(h);
    expect(h.ran).toEqual(['qa-HB-1']);
    cut(BUILD_2);
    await tick(h);
    expect(h.ran).toEqual(['qa-HB-1', 'qa-HB-1']);
    // One session, two verifications — one per deployed build.
    expect(h.created).toEqual(['HB-1:acme/app#12']);
    expect((await h.store.load()).tickets['HB-1'].attempts.map((a) => a.identity)).toEqual([
      `qa:${BUILD_1}`,
      `qa:${BUILD_2}`,
    ]);
  });

  it('a run already in flight on that session still blocks the new build', async () => {
    const builds = [BUILD_1];
    const { h, cut } = rebuilding(builds, {
      sessions: {
        existingFor: async () => ({ id: 'qa-live', stageStatus: 'verifying' }),
        isRunningNow: (id: string) => id === 'qa-live',
      },
    });
    await h.store.observe('HB-1', 'In Progress');
    await tick(h);
    cut(BUILD_2);
    await tick(h);
    expect(h.ran).toEqual([]);
    expect(h.created).toEqual([]);
  });
});

/**
 * Phase 18 item 2 — R84's lookup, on the MANUAL path.
 *
 * A ticket in a QA status with no PR the engine has ever seen is the user's NORMAL case: his
 * teammates merge without cgremlin sessions, so nothing links the ticket to the change and the
 * QA verb has nothing to run on. The same per-entry search the automatic leg makes is now
 * reachable from the panel, bounded exactly as the automatic one is — once per (ticket,
 * ordinal), inside the scan budget, and never on a tick that has already spent its gh call.
 */
describe('Phase 18 — discovering the PRs of a ticket that has none', () => {
  const ROW = {
    number: 77,
    state: 'MERGED',
    mergeCommit: { oid: MERGE_SHA },
    mergedAt: '2026-09-14T00:00:00.000Z',
    headRefName: 'feature/HB-1-x',
    title: 'feat(HB-1): the landed change',
  };

  function discoverHarness(
    over: Omit<Partial<QaTriggerDeps>, 'items'> & { items?: WorkItem[] } = {},
  ) {
    const absorbed: Array<{ repo: string; stdout: string }> = [];
    const h = harness({
      items: [item({ prs: [] })],
      qaRepos: () => [REPO],
      absorbPrs: async (repo: string, stdout: string) => {
        absorbed.push({ repo, stdout });
      },
      ...over,
    });
    return { ...h, absorbed };
  }

  it('makes ONE gh pr list --search and writes what it found into the pr-state cache', async () => {
    const h = discoverHarness();
    h.gh.queueResponse({ stdout: JSON.stringify([ROW]) });
    const result = await h.leg.discover('HB-1');
    expect(h.gh.calls.length).toBe(1);
    expect(h.gh.calls[0].slice(0, 8)).toEqual([
      'pr', 'list', '--repo', REPO, '--search', 'HB-1', '--state', 'merged',
    ]);
    expect(result).toMatchObject({ searched: true, found: [{ repo: REPO, number: 77 }], reason: null });
    expect(h.absorbed).toEqual([{ repo: REPO, stdout: JSON.stringify([ROW]) }]);
  });

  it('says so, once, when nothing mentions the ticket', async () => {
    const h = discoverHarness();
    h.gh.queueResponse({ stdout: '[]' });
    const result = await h.leg.discover('HB-1');
    expect(result.found).toEqual([]);
    expect(result.reason).toBe('No merged pull request mentions HB-1.');
  });

  it('is not repeated for the same entry', async () => {
    const h = discoverHarness();
    h.gh.queueResponse({ stdout: '[]' });
    await h.leg.discover('HB-1');
    const again = await h.leg.discover('HB-1');
    expect(h.gh.calls.length).toBe(1);
    expect(again.searched).toBe(false);
    expect(again.reason).toContain('already');
  });

  it('searches again once the ticket re-enters QA on a new ordinal', async () => {
    const h = discoverHarness();
    h.gh.queueResponse({ stdout: '[]' });
    await h.leg.discover('HB-1');
    await h.store.enterQa('HB-1', 'UAT');
    h.gh.queueResponse({ stdout: JSON.stringify([ROW]) });
    expect((await h.leg.discover('HB-1')).found).toEqual([{ repo: REPO, number: 77 }]);
  });

  it('refuses while a scan is in flight rather than spending a second gh call', async () => {
    const h = discoverHarness({ jira: () => ({ ok: false, me: null }) });
    const flight = h.leg.run();
    const result = await h.leg.discover('HB-1');
    await flight;
    expect(result.searched).toBe(false);
    expect(h.gh.calls).toEqual([]);
  });

  it('searches nothing at all when no repo can be named', async () => {
    const h = discoverHarness({ qaRepos: () => [] });
    const result = await h.leg.discover('HB-1');
    expect(h.gh.calls).toEqual([]);
    expect(result).toMatchObject({ searched: false, found: [] });
    expect(result.reason).not.toBeNull();
  });
});

/**
 * Phase 18 — the discovery is only useful if what it finds SURVIVES: the whole point is that
 * `/items` re-evaluates the ticket, and it re-evaluates off the pr-state cache. This wires the
 * leg to the real resolver, so one search really does leave a merged PR behind.
 */
describe('Phase 18 — a discovered PR lands in the pr-state cache', () => {
  it('writes the row, state and ticket keys, with no second gh call', async () => {
    const fs = new InMemoryFileSystem();
    const gh = new FakeGhRunner();
    const resolver = new PrStateResolver({
      gh,
      store: new PrStateStore(fs, '/state/pr-states.json'),
      projectKeys: ['HB'],
      now: () => NOW,
    });
    const h = harness({
      items: [item({ prs: [] })],
      qaRepos: () => [REPO],
      gh,
      absorbPrs: async (repo, stdout) => {
        await resolver.absorbList(repo, stdout);
      },
    });
    gh.queueResponse({
      stdout: JSON.stringify([
        {
          number: 77, state: 'MERGED', mergeCommit: { oid: MERGE_SHA },
          mergedAt: '2026-09-14T00:00:00.000Z', closedAt: null,
          title: 'feat(HB-1): the landed change', url: `https://github.com/${REPO}/pull/77`,
          headRefName: 'feature/HB-1-x', author: { login: 'gennaro' },
          createdAt: '2026-09-01T00:00:00.000Z', changedFiles: 7, additions: 120, deletions: 30,
          isDraft: false, labels: [{ name: 'backend' }],
        },
      ]),
    });
    await h.leg.discover('HB-1');
    expect(gh.calls.length).toBe(1);
    const cached = (await resolver.cached())[prStateKey(REPO, 77)];
    expect(cached).toMatchObject({
      state: 'merged',
      title: 'feat(HB-1): the landed change',
      author: 'gennaro',
      ticketKeys: ['HB-1'],
      labels: ['backend'],
    });
  });
});
