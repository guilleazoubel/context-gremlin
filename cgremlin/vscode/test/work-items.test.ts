/**
 * B1 — the work-item wire mirror, the four lists, their sorts and the row children.
 *
 * Everything here runs over the committed `GET /items` fixture (`test/support/fixtures/items.json`),
 * which is the contract Stream A is being built against; C1 is what proves the two agree.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import itemsFixture from './support/fixtures/items.json';
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  WORK_LIST_KINDS,
  WORK_SORT_KINDS,
  agentChildId,
  agentOfChildId,
  buildItemChildren,
  buildWorkLists,
  chatTargetOf,
  itemPathOf,
  readSort,
  readSorts,
  sortStateKey,
  ticketBanner,
  ticketTrouble,
  writeSort,
  type ItemsResponse,
  type SortStore,
  type WorkItem,
  type WorkListKind,
  type WorkSortKind,
} from '../src/model/work-items';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function response(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

function lists(over: Partial<{ response: ItemsResponse; sorts: Partial<Record<WorkListKind, WorkSortKind>> }> = {}) {
  return buildWorkLists({ response: over.response ?? response(), sorts: over.sorts, now: NOW });
}

function rowIds(list: ReturnType<typeof lists>[WorkListKind]): string[] {
  return list.sections.flatMap((section) => section.rows.map((row) => row.id));
}

function itemOf(res: ItemsResponse, id: string): WorkItem {
  const found = res.items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no fixture item ${id}`);
  return found;
}

class FakeState implements SortStore {
  readonly values = new Map<string, unknown>();
  getState<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  setState(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

// ---------------------------------------------------------------------------

describe('MG-B8 buildWorkLists returns exactly the four lists', () => {
  it('has the four R47 keys and no reviewing list', () => {
    const built = lists();
    expect(Object.keys(built).sort()).toEqual(
      ['investigations', 'myWork', 'parkingLot', 'waitingForReview'].sort(),
    );
    expect(Object.keys(built)).not.toContain('reviewing');
    expect([...WORK_LIST_KINDS]).toEqual([
      'parkingLot',
      'myWork',
      'investigations',
      'waitingForReview',
    ]);
  });

  it('takes the membership from the wire and never re-derives it', () => {
    const built = lists();
    expect(rowIds(built.myWork).sort()).toEqual([
      'pr:acme/api#77',
      'pr:acme/web#200',
      'ticket:HB-627',
    ]);
    expect(rowIds(built.investigations)).toEqual(['session:inv-stacktrace-1']);
    expect(rowIds(built.waitingForReview).sort()).toEqual([
      'pr:acme/api#77',
      'pr:acme/web#200',
      'ticket:HB-627',
    ]);
  });

  it('has no membership rule of its own in the source (D2)', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/model/work-items.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/humanActivity\s*[.!?]?\s*\.?lastAt\s*!==\s*null/);
    expect(source).not.toMatch(/mode === 'review'/);
  });
});

describe('R13/R47 the row label', () => {
  it('labels a parking-lot row repo#n — title even when it carries a ticket key', () => {
    const res = response();
    const item = itemOf(res, 'pr:acme/web#101');
    item.ticket = {
      key: 'HB-900',
      summary: 'A ticket the PR names',
      status: 'To Do',
      statusCategory: 'new',
      url: 'https://jira/browse/HB-900',
      assignee: null,
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const row = lists({ response: res }).parkingLot.sections
      .flatMap((s) => s.rows)
      .find((r) => r.id === 'pr:acme/web#101');
    expect(row?.label).toBe('acme/web#101 — Add the retry budget');
  });

  it('prefers the ticket summary elsewhere, and falls back to the bare key', () => {
    const res = response();
    const hb = (r: ItemsResponse) =>
      lists({ response: r }).myWork.sections[0].rows.find((row) => row.id === 'ticket:HB-627');
    expect(hb(res)?.label).toBe('HB-627 — Caregiver inbox reshuffle');

    const bare = response();
    itemOf(bare, 'ticket:HB-627').ticket!.summary = '';
    expect(hb(bare)?.label).toBe('HB-627');
  });

  it('falls back to repo#n for a null PR title and to the session title for a session item', () => {
    const res = response();
    itemOf(res, 'pr:acme/legacy#9').prs[0].title = null;
    const built = lists({ response: res });
    const legacy = built.parkingLot.sections
      .flatMap((s) => s.rows)
      .find((r) => r.id === 'pr:acme/legacy#9');
    expect(legacy?.label).toBe('acme/legacy#9');
    expect(built.investigations.sections[0].rows[0].label).toBe('Investigate the nightly crash');
  });
});

describe('MG-B8 the row description', () => {
  it('carries agent badges, a chip per PR, age, size, the CI dot and the activity summary', () => {
    const built = lists();
    const hb = built.myWork.sections[0].rows.find((r) => r.id === 'ticket:HB-627');
    if (hb === undefined) throw new Error('no HB-627 row');
    expect(hb.badges).toEqual(['I❗', 'D🔄']);
    expect(hb.chips).toEqual(['acme/web#310', 'acme/api#88']);
    // §2.2 rule 7: compact. "opened … ago" cost seven characters in a 300 px sidebar.
    expect(hb.age).toBe('6d');
    expect(hb.size).toBe('12 files +300/−80');
    expect(hb.ci).toBe('🟢');
    expect(hb.activity).toBe('👤 @dana reviewed');
    expect(hb.description).toContain('6d');
    expect(hb.description).toContain('12 files +300/−80');
  });

  it('badges a respond agent C and a claimed agent with the claim glyph', () => {
    const built = lists();
    const respond = built.waitingForReview.sections[0].rows.find(
      (r) => r.id === 'pr:acme/web#200',
    );
    expect(respond?.badges).toEqual(['C🔄']);
    expect(built.investigations.sections[0].rows[0].badges).toEqual(['I👤']);
  });

  it('summarises human activity as reviewed, commented or requested', () => {
    const built = lists();
    const someoneOnIt = built.parkingLot.sections.find((s) => s.group === 'someoneOnIt');
    expect(someoneOnIt?.rows.map((r) => r.activity)).toEqual([
      '👤 @dana reviewed',
      '👤 @dana requested',
    ]);
    const untouched = built.parkingLot.sections.find((s) => s.group === 'untouched');
    expect(untouched?.rows[0].activity).toBe('');
  });

  it('renders no draft marker and no no-human-review badge anywhere (R47)', () => {
    const built = lists();
    const all = WORK_LIST_KINDS.flatMap((kind) => built[kind].sections.flatMap((s) => s.rows));
    for (const row of all) {
      expect(row.description).not.toMatch(/draft/i);
      expect(row.description).not.toMatch(/no human/i);
    }
  });
});

describe('MG-12 defaults render as unknown', () => {
  it('renders — for age and size and no CI dot on a defaulted row', () => {
    const row = lists()
      .parkingLot.sections.flatMap((s) => s.rows)
      .find((r) => r.id === 'pr:acme/legacy#9');
    expect(row?.age).toBe('—');
    expect(row?.size).toBe('—');
    expect(row?.ci).toBe('');
    expect(row?.description).not.toContain('0 files');
    expect(row?.description).not.toContain('opened today');
  });

  it('sorts the defaulted row last under oldest and under smallestChange', () => {
    for (const sort of ['oldest', 'smallestChange'] as const) {
      const built = lists({ sorts: { parkingLot: sort } });
      const untouched = built.parkingLot.sections.find((s) => s.group === 'untouched');
      expect(untouched?.rows.map((r) => r.id).at(-1)).toBe('pr:acme/legacy#9');
    }
  });
});

describe('R47 the sorts', () => {
  it('declares the documented union and the per-list defaults', () => {
    expect([...WORK_SORT_KINDS]).toEqual([
      'untouchedFirstThenOldest',
      'oldest',
      'newest',
      'smallestChange',
      'needsYouThenRecent',
    ]);
    expect(DEFAULT_SORT).toEqual({
      parkingLot: 'untouchedFirstThenOldest',
      waitingForReview: 'oldest',
      myWork: 'needsYouThenRecent',
      investigations: 'newest',
    });
    expect(SORT_OPTIONS.parkingLot).toEqual([
      'untouchedFirstThenOldest',
      'oldest',
      'smallestChange',
      'newest',
    ]);
    for (const kind of ['myWork', 'investigations', 'waitingForReview'] as const) {
      expect(SORT_OPTIONS[kind][0]).toBe(DEFAULT_SORT[kind]);
      expect(SORT_OPTIONS[kind]).toContain('oldest');
      expect(SORT_OPTIONS[kind]).toContain('newest');
    }
  });

  it('reproduces the core default order for every list', () => {
    const built = lists();
    // parkingLot: three groups in fixed order, oldest first inside each.
    expect(built.parkingLot.sections.map((s) => s.group)).toEqual([
      'reviewing',
      'untouched',
      'someoneOnIt',
    ]);
    expect(rowIds(built.parkingLot)).toEqual([
      'pr:acme/web#102',
      'pr:acme/web#101',
      'pr:acme/legacy#9',
      'pr:acme/api#55',
      'pr:acme/api#56',
    ]);
    // waitingForReview: createdAt ascending.
    expect(rowIds(built.waitingForReview)).toEqual([
      'ticket:HB-627',
      'pr:acme/web#200',
      'pr:acme/api#77',
    ]);
    // myWork: needsYou first, then most recently updated — #77 needs nobody, so it is last.
    expect(rowIds(built.myWork)).toEqual([
      'pr:acme/web#200',
      'ticket:HB-627',
      'pr:acme/api#77',
    ]);
  });

  it('sorts within each parking-lot group and never across them', () => {
    const built = lists({ sorts: { parkingLot: 'smallestChange' } });
    expect(built.parkingLot.sections.map((s) => s.group)).toEqual([
      'reviewing',
      'untouched',
      'someoneOnIt',
    ]);
    expect(rowIds(built.parkingLot)).toEqual([
      'pr:acme/web#102',
      'pr:acme/web#101',
      'pr:acme/legacy#9',
      'pr:acme/api#56',
      'pr:acme/api#55',
    ]);
  });

  it('sorts oldest and newest on the row date, nulls last', () => {
    const oldest = rowIds(lists({ sorts: { waitingForReview: 'oldest' } }).waitingForReview);
    expect(oldest).toEqual(['ticket:HB-627', 'pr:acme/web#200', 'pr:acme/api#77']);
    const newest = rowIds(lists({ sorts: { waitingForReview: 'newest' } }).waitingForReview);
    expect(newest).toEqual(['pr:acme/web#200', 'ticket:HB-627', 'pr:acme/api#77']);
  });

  it('breaks ties on id, so the order is total and stable', () => {
    const res = response();
    const a = itemOf(res, 'pr:acme/web#101');
    const twin = JSON.parse(JSON.stringify(a)) as WorkItem;
    twin.id = 'pr:acme/web#100';
    twin.attention = { ...twin.attention, refs: ['pr:acme/web#100'] };
    res.items.push(twin);
    res.lists.parkingLot.untouched = ['pr:acme/web#101', 'pr:acme/web#100', 'pr:acme/legacy#9'];
    const untouched = lists({ response: res, sorts: { parkingLot: 'oldest' } })
      .parkingLot.sections.find((s) => s.group === 'untouched')
      ?.rows.map((r) => r.id);
    expect(untouched).toEqual(['pr:acme/web#100', 'pr:acme/web#101', 'pr:acme/legacy#9']);
  });
});

describe('R64 the sort selection round-trips through the state store', () => {
  it('keys on cgremlin.sort.<list> and falls back to the default', () => {
    const store = new FakeState();
    expect(sortStateKey('parkingLot')).toBe('cgremlin.sort.parkingLot');
    expect(readSort(store, 'parkingLot')).toBe('untouchedFirstThenOldest');
    writeSort(store, 'parkingLot', 'smallestChange');
    expect(store.values.get('cgremlin.sort.parkingLot')).toBe('smallestChange');
    expect(readSort(store, 'parkingLot')).toBe('smallestChange');
  });

  it('falls back to the default on an unknown or wrongly typed persisted value', () => {
    const store = new FakeState();
    store.values.set('cgremlin.sort.myWork', 'byVibes');
    store.values.set('cgremlin.sort.investigations', 42);
    expect(readSort(store, 'myWork')).toBe('needsYouThenRecent');
    expect(readSort(store, 'investigations')).toBe('newest');
    expect(readSorts(store)).toEqual(DEFAULT_SORT);
  });

  it('refuses a sort a list does not offer', () => {
    const store = new FakeState();
    store.values.set('cgremlin.sort.investigations', 'smallestChange');
    expect(readSort(store, 'investigations')).toBe('newest');
  });
});

describe('R47 the parking lot renders three ordered groups', () => {
  it('names and counts them, and collapses only "someone is on it"', () => {
    const built = lists();
    expect(built.parkingLot.sections.map((s) => [s.title, s.count, s.collapsed])).toEqual([
      ['Reviewing', 1, false],
      ['Untouched', 2, false],
      ['Someone is on it', 2, true],
    ]);
  });

  it('reads parkingLotGroup off the item, not a rule of its own', () => {
    const res = response();
    // The wire says `reviewing` even though this row is demoted and has no agent: the panel obeys.
    itemOf(res, 'pr:acme/api#55').parkingLotGroup = 'reviewing';
    res.lists.parkingLot = {
      reviewing: ['pr:acme/api#55'],
      untouched: ['pr:acme/web#101'],
      someoneOnIt: [],
    };
    const built = lists({ response: res });
    expect(built.parkingLot.sections.find((s) => s.group === 'reviewing')?.rows.map((r) => r.id)).toEqual([
      'pr:acme/api#55',
    ]);
  });
});

describe('R35 the ticket source', () => {
  it('shows the stale banner for unavailable and keeps myWork populated', () => {
    const res = response();
    res.ticketSource = { kind: 'unavailable', error: 'ETIMEDOUT', scannedAt: null };
    const built = lists({ response: res });
    expect(built.myWork.sections[0].rows.length).toBeGreaterThan(0);
    expect(ticketBanner(res.ticketSource, res.threadSource)?.kind).toBe('stale');
    expect(ticketTrouble(res.ticketSource)).toBeNull();
  });

  it('gives auth the engine-trouble treatment, naming the command', () => {
    const source = { kind: 'auth' as const, error: 'Unauthorized', scannedAt: null };
    const trouble = ticketTrouble(source);
    expect(trouble?.message).toContain('cgremlin-core config check-jira');
    expect(ticketBanner(source, { error: null, scannedAt: null })?.kind).toBe('auth');
  });

  it('says nothing at all when Jira is not configured', () => {
    const source = { kind: 'notConfigured' as const, error: null, scannedAt: null };
    expect(ticketBanner(source, { error: null, scannedAt: null })).toBeNull();
    expect(ticketTrouble(source)).toBeNull();
  });

  it('treats a thread-source error as stale, not empty', () => {
    const banner = ticketBanner(
      { kind: 'ok', error: null, scannedAt: null },
      { error: 'gh exploded', scannedAt: null },
    );
    expect(banner?.kind).toBe('stale');
    expect(banner?.message).toContain('review threads');
  });
});

describe('R25/R65 item paths', () => {
  it('maps each id form to its route path', () => {
    expect(itemPathOf('ticket:HB-627')).toBe('ticket/HB-627');
    expect(itemPathOf('pr:acme/web#101')).toBe('pr/acme/web/101');
    expect(itemPathOf('session:inv-stacktrace-1')).toBe('session/inv-stacktrace-1');
  });

  it('refuses a malformed id rather than building a broken path', () => {
    expect(itemPathOf('nonsense')).toBeNull();
    expect(itemPathOf('pr:acme/web')).toBeNull();
    expect(itemPathOf('pr:acme/web#abc')).toBeNull();
  });

  it('opens a session item at its own session path', () => {
    const built = lists();
    expect(built.investigations.sections[0].rows[0].path).toBe('session/inv-stacktrace-1');
  });
});

describe('finding 1 — chatTargetOf', () => {
  const res = response();

  it('skips a respond agent still triaging and takes the eligible one', () => {
    expect(chatTargetOf(itemOf(res, 'pr:acme/api#77'))).toBe('dev-acme-api-77');
  });

  it('is null when the only agent is triaging, and null with no agent at all', () => {
    expect(chatTargetOf(itemOf(res, 'pr:acme/web#200'))).toBeNull();
    expect(chatTargetOf(itemOf(res, 'pr:acme/web#101'))).toBeNull();
  });

  it('takes a respond agent once it is addressing or ready', () => {
    for (const phase of ['addressing', 'ready']) {
      const item = JSON.parse(JSON.stringify(itemOf(res, 'pr:acme/web#200'))) as WorkItem;
      item.agents[0].phase = phase;
      expect(chatTargetOf(item)).toBe('respond-acme-web-200');
    }
  });

  it('prefers a running agent, then a claimed one, then the core’s order', () => {
    const item = JSON.parse(JSON.stringify(itemOf(res, 'ticket:HB-627'))) as WorkItem;
    expect(chatTargetOf(item)).toBe('dev-hb-627'); // the running one
    item.agents[1].running = false;
    item.agents[1].claimed = true;
    expect(chatTargetOf(item)).toBe('dev-hb-627'); // the claimed one
    item.agents[1].claimed = false;
    expect(chatTargetOf(item)).toBe('inv-hb-627'); // first in the core's order
  });

  it('round-trips the child id the row action carries', () => {
    expect(agentOfChildId(agentChildId('dev-hb-627'))).toBe('dev-hb-627');
    expect(agentOfChildId('pr:acme/web#310')).toBeNull();
    expect(agentOfChildId(undefined)).toBeNull();
  });
});

describe('R48/MG-15 the children are the item parts', () => {
  const res = response();
  const item = itemOf(res, 'ticket:HB-627');

  it('returns agents in wire order, then the ticket, then the PRs', () => {
    const children = buildItemChildren(item);
    expect(children.map((c) => c.kind)).toEqual(['agent', 'agent', 'ticket', 'pr', 'pr']);
    expect(children.map((c) => c.label)).toEqual([
      '🔍 Investigation · plan_ready',
      '🔨 Development · developing',
      '🎫 HB-627 — Caregiver inbox reshuffle (In Progress)',
      '🔀 acme/web#310 — approved · 🟢',
      '🔀 acme/api#88 — open · 🟡',
    ]);
  });

  it('grows by one child when a fourth agent appears, with no view-model edit', () => {
    const grown = JSON.parse(JSON.stringify(item)) as WorkItem;
    grown.agents.push({
      sessionId: 'respond-hb-627',
      mode: 'respond',
      phase: 'ready',
      running: false,
      needsYou: true,
      claimed: false,
      primaryArtifact: 'COMMENTS.md',
      worktreePath: '/tmp/wt/respond-hb-627',
      ref: 'session:respond-hb-627',
    });
    const children = buildItemChildren(grown);
    expect(children).toHaveLength(6);
    expect(children[2].label).toBe('💬 Respond · ready');
  });

  it('drops exactly one child when the ticket goes, and reports none for a bare item', () => {
    const ticketless = JSON.parse(JSON.stringify(item)) as WorkItem;
    ticketless.ticket = null;
    expect(buildItemChildren(ticketless)).toHaveLength(buildItemChildren(item).length - 1);
    // A PR-only row's single part IS the row, so it is listed but never earns an expander.
    expect(buildItemChildren(itemOf(res, 'pr:acme/web#101')).map((c) => c.kind)).toEqual(['pr']);
  });

  it('gives every child its Info focus and its Go-to target', () => {
    const children = buildItemChildren(item);
    expect(children[0].focus).toEqual({ kind: 'agent', sessionId: 'inv-hb-627' });
    expect(children[0].goTo).toEqual({
      kind: 'session',
      sessionId: 'inv-hb-627',
      worktreePath: '/tmp/cgremlin-fixture/worktrees/inv-hb-627',
    });
    expect(children[2].focus).toEqual({ kind: 'ticket' });
    expect(children[2].goTo).toEqual({
      kind: 'url',
      url: 'https://aplaceformom.atlassian.net/browse/HB-627',
    });
    expect(children[3].focus).toEqual({ kind: 'pr', repo: 'acme/web', number: 310 });
    expect(children[3].goTo).toEqual({ kind: 'url', url: 'https://github.com/acme/web/pull/310' });
  });

  it('R65 — a PR child of a ticket-id item carries its OWN path', () => {
    const children = buildItemChildren(item);
    expect(item.id).toBe('ticket:HB-627');
    expect(children[3].path).toBe('pr/acme/web/310');
    expect(children[2].path).toBe('ticket/HB-627');
    expect(children[0].path).toBe('session/inv-hb-627');
  });

  it('marks a row expandable only when it has more than the one part the row already is', () => {
    const built = lists();
    const myWork = built.myWork.sections[0].rows;
    expect(myWork.find((r) => r.id === 'ticket:HB-627')?.hasChildren).toBe(true);
    const untouched = built.parkingLot.sections.find((s) => s.group === 'untouched');
    expect(untouched?.rows.map((r) => r.hasChildren)).toEqual([false, false]);
    expect(built.investigations.sections[0].rows[0].hasChildren).toBe(false);
    const reviewing = built.parkingLot.sections.find((s) => s.group === 'reviewing');
    expect(reviewing?.rows[0].hasChildren).toBe(true);
  });
});
