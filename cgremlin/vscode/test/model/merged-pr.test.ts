/**
 * What the panel says about a PR that has already landed.
 *
 * Live defect (`aplaceformom/grace#2180`, merged 2026-09-11): the row read as
 * live work — no marker, review verbs still on offer, sorted above things
 * that had not landed — and the user's ask was the opposite: "show clear in
 * the list item that it was merged already and move to the bottom of the
 * list. I can still follow the jira ticket here."
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkLists,
  isLandedItem,
  isLandedPr,
  prState,
  repoTailOf,
  toRow,
  type ItemsResponse,
  type WorkItem,
  type WorkItemPr,
  type WorkListKind,
} from '../../src/model/work-items';
import { itemActionFacts, nextStages, rowActions } from '../../src/model/row-actions';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';

const NOW = Date.parse('2026-09-14T09:00:00.000Z');
const REPO = 'aplaceformom/grace';
const TITLE = 'feat(HB-1489): add web-content read endpoint to the Grace backend';

function pr(over: Partial<WorkItemPr> = {}): WorkItemPr {
  return {
    repo: REPO,
    number: 2180,
    url: `https://github.com/${REPO}/pull/2180`,
    title: TITLE,
    author: 'me-user',
    branch: 'HB-1489-web-content-read',
    isDraft: null,
    isMine: true,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: '2026-09-11T13:34:00Z',
    createdAt: '2026-09-09T09:00:00.000Z',
    changedFiles: null,
    additions: null,
    deletions: null,
    ci: null,
    labels: null,
    sizeTier: null,
    state: 'merged',
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'ticket:HB-1489',
    kind: 'pr+ticket',
    lists: ['myWork'],
    demoted: false,
    parkingLotGroup: null,
    title: 'HB-1489 — Web-content read endpoint',
    prs: [pr()],
    ticket: {
      key: 'HB-1489',
      summary: 'Web-content read endpoint',
      status: 'UAT',
      statusCategory: 'In Progress',
      url: 'https://jira.invalid/browse/HB-1489',
      assignee: 'accountid-guilherme',
      updatedAt: '2026-09-13T10:00:00.000Z',
    },
    agents: [],
    needsYou: false,
    attention: { reasons: [], since: '2026-09-11T04:00:30.000Z', acked: false, refs: [] },
    ...over,
  } as WorkItem;
}

const cellOf = (row: ReturnType<typeof toRow>, kind: string) =>
  row.meta.find((c) => c.kind === kind);

describe('the merged marker', () => {
  it("prState says `merged`, ahead of every review verdict it might also carry", () => {
    expect(prState(pr())).toBe('merged');
    expect(prState(pr({ reviewDecision: 'APPROVED' }))).toBe('merged');
    expect(prState(pr({ state: 'closed' }))).toBe('closed');
    // Unchanged for everything else, including an engine that sends no state.
    expect(prState(pr({ state: undefined, isDraft: true }))).toBe('draft');
    expect(prState(pr({ state: undefined, reviewDecision: 'APPROVED' }))).toBe('approved');
    expect(prState(pr({ state: undefined, isDraft: false, reviewDecision: null }))).toBe('open');
  });

  it('is on the COLLAPSED row, right after the repo, muted and wordless', () => {
    const row = toRow(item(), 'myWork', NOW);
    const kinds = row.meta.map((c) => c.kind);
    expect(kinds[0]).toBe('repo');
    expect(kinds[1]).toBe('prState');
    const cell = cellOf(row, 'prState')!;
    expect(cell.text).toBe('merged');
    expect(cell.tone).toBe('muted');
    expect(cell.label).toBe('PR merged');
  });

  it("reads `grace · merged · UAT · …` — the code is in, the ticket is not done yet", () => {
    const row = toRow(item(), 'myWork', NOW);
    const texts = row.meta.map((c) => c.text);
    expect(texts.slice(0, 3)).toEqual(['grace', 'merged', 'UAT']);
  });

  it('is absent on a live PR, so nothing new appears on the rows that already read correctly', () => {
    const row = toRow(item({ prs: [pr({ state: 'open' })] }), 'myWork', NOW);
    expect(cellOf(row, 'prState')).toBeUndefined();
  });

  it('a PR whose state the engine never sent is NOT marked merged', () => {
    const row = toRow(item({ prs: [pr({ state: undefined })] }), 'myWork', NOW);
    expect(cellOf(row, 'prState')).toBeUndefined();
  });

  it('mutes the PR part in the expanded row, and still opens it', () => {
    const it0 = item();
    const parts = itemParts({
      item: it0,
      list: 'myWork',
      slots: lifecycleSlots({ facts: itemActionFacts(it0), agents: it0.agents, now: NOW }),
      actions: rowActions(itemActionFacts(it0), 'myWork'),
    });
    const part = parts.find((p) => p.kind === 'pr')!;
    expect(part.state).toBe('merged');
    expect(part.stateText.startsWith('merged')).toBe(true);
    // Round 3 §e.4: a PR's one destination is GitHub, so it carries no local Open at all — the
    // part itself is still the click that opens its pane.
    expect(part.actions.map((a) => a.command)).toEqual(['cgremlin.openPr']);
    expect(part.childId).toBe('pr:aplaceformom/grace#2180');
  });
});

describe('a merged PR offers no forward verb', () => {
  const facts = (over: Partial<WorkItemPr> = {}) => itemActionFacts(item({ prs: [pr(over)] }));

  it('the forward-only ladder is empty once every PR has landed', () => {
    expect(nextStages(facts())).toEqual([]);
    expect(nextStages(facts({ state: 'closed' }))).toEqual([]);
    // Unchanged where the PR is still live.
    expect(nextStages(facts({ state: 'open' }))).toEqual(['review']);
  });

  it('myWork offers neither Start review nor Start self-review', () => {
    const offered = rowActions(facts(), 'myWork').map((a) => a.command);
    expect(offered).not.toContain('cgremlin.startReview');
  });

  it('waitingForReview offers no Address review comments — the merge took the comments with it', () => {
    const offered = rowActions(
      itemActionFacts(item({ prs: [pr({ isDraft: false })] })),
      'waitingForReview',
    ).map((a) => a.command);
    expect(offered).not.toContain('cgremlin.addressReview');
  });

  it('parkingLot offers no Start review on a merged teammate PR', () => {
    const offered = rowActions(
      itemActionFacts(item({ prs: [pr({ isMine: false, isDraft: false })] })),
      'parkingLot',
    ).map((a) => a.command);
    expect(offered).not.toContain('cgremlin.startReview');
  });

  it('the links and the ack survive — a landed row is still openable', () => {
    const offered = rowActions(facts(), 'myWork').map((a) => a.command);
    expect(offered).toContain('cgremlin.openPr');
    expect(offered).toContain('cgremlin.openTicket');
  });
});

describe('landed work sorts last, in every sort', () => {
  const live: WorkItem = item({
    id: 'ticket:HB-2000',
    title: 'HB-2000 — live',
    prs: [
      pr({
        number: 3000,
        state: 'open',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        changedFiles: 90,
        additions: 4000,
        deletions: 10,
      }),
    ],
    ticket: null,
    kind: 'pr',
  });

  function orderedWith(sort: string, list: WorkListKind = 'myWork'): string[] {
    // The landed row is the newest, the smallest and the most recently
    // updated: every selected sort would otherwise put it first.
    const response = {
      evaluatedAt: '2026-09-14T09:00:00.000Z',
      lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [], investigations: [], waitingForReview: [] },
      dismissed: [],
      items: [item(), live],
      ticketSource: { kind: 'ok', error: null, scannedAt: '2026-09-14T09:00:00.000Z' },
    } as unknown as ItemsResponse;
    response.lists[list === 'myWork' ? 'myWork' : 'waitingForReview'] = ['ticket:HB-1489', 'ticket:HB-2000'];
    const built = buildWorkLists({
      response,
      now: NOW,
      sorts: { [list]: sort } as never,
    });
    return built[list].sections.flatMap((s) => s.rows).map((r) => r.id);
  }

  it.each(['needsYouThenRecent', 'newest', 'oldest', 'smallestChange'])(
    'sort %s keeps the landed row below the live one',
    (sort) => {
      expect(orderedWith(sort)).toEqual(['ticket:HB-2000', 'ticket:HB-1489']);
    },
  );

  it('isLandedItem needs EVERY pr to have landed', () => {
    expect(isLandedItem(item())).toBe(true);
    expect(isLandedItem(item({ prs: [pr(), pr({ number: 9, state: 'open' })] }))).toBe(false);
    expect(isLandedItem(item({ prs: [] }))).toBe(false);
    expect(isLandedPr(undefined)).toBe(false);
  });
});

describe('the repo on a row with no PR', () => {
  it("falls back to the session's repo, still rendered as the tail alone", () => {
    const ticketOnly = item({
      kind: 'ticket',
      prs: [],
      agents: [
        {
          sessionId: 'inv-1',
          repo: 'aplaceformom/grace-frontend',
          mode: 'investigation',
          phase: 'findings',
          running: false,
          needsYou: false,
          claimed: false,
          primaryArtifact: null,
          worktreePath: null,
          ref: 'session:inv-1',
        },
      ],
    });
    expect(repoTailOf(ticketOnly)).toBe('grace-frontend');
    expect(toRow(ticketOnly, 'myWork', NOW).meta[0]).toMatchObject({
      kind: 'repo',
      text: 'grace-frontend',
    });
  });

  it('a ticket with neither a PR nor a session legitimately shows no repo, and the line still lays out', () => {
    const bare = item({ kind: 'ticket', prs: [], agents: [] });
    expect(repoTailOf(bare)).toBe('');
    const row = toRow(bare, 'myWork', NOW);
    expect(row.meta.find((c) => c.kind === 'repo')).toBeUndefined();
    expect(row.meta.length).toBeGreaterThan(0);
  });

  it('the merged-PR case keeps the PR’s repo, not a session’s', () => {
    const withAgent = item({
      agents: [
        {
          sessionId: 'respond-1',
          repo: 'aplaceformom/other',
          mode: 'respond',
          phase: 'addressing',
          running: false,
          needsYou: false,
          claimed: false,
          primaryArtifact: null,
          worktreePath: null,
          ref: 'session:respond-1',
        },
      ],
    });
    expect(repoTailOf(withAgent)).toBe('grace');
  });
});
