import { describe, expect, it } from 'vitest';
import {
  groupWorkItems,
  parkingLotOrder,
  workListsOf,
  type GroupWorkItemsInput,
  type WorkItem,
} from '../../src/work/work-item';
import type { AttentionItem } from '../../src/attention/attention-service';
import { prRef, sessionRef } from '../../src/attention/item-ref';
import { derivePrReasons, evaluateAttention } from '../../src/attention/attention';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { JiraIssueSummary } from '../../src/jira/jira-source';
import type { SessionMode } from '../../src/schema/session';

const ME = 'me-user';
const REPO = 'acme/app';
const SEEN = '2026-09-04T00:00:00.000Z';

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
    seenAt: SEEN,
    ...over,
  };
}

/** The `source: 'pr'` AttentionItem the pre-dedupe list preserves (R27). */
function prAttention(e: InventoryEntry): AttentionItem {
  return {
    source: 'pr',
    ref: prRef(e.repo, e.number),
    id: `${e.repo}#${e.number}`,
    title: e.title,
    repoOrContext: e.repo,
    attention: evaluateAttention({ derived: derivePrReasons(e), fallbackSince: e.seenAt, ack: null }),
    links: {
      sessionId: e.ours.status === 'none' ? null : e.ours.sessionId,
      worktreePath: null,
      prRepo: e.repo,
      prNumber: e.number,
      prUrl: e.url,
      ticket: null,
      primaryArtifact: null,
    },
    mode: null,
    stageStatus: null,
    running: false,
    claimed: false,
  };
}

interface AgentOpts {
  id: string;
  mode: SessionMode;
  prRepo?: string;
  prNumber?: number;
  prUrl?: string;
  ticket?: string | null;
  needsYou?: boolean;
  stageStatus?: string;
  since?: string;
  title?: string;
  acked?: boolean;
}

function agentAttention(o: AgentOpts): AttentionItem {
  const reasons = o.needsYou === true ? (['needs_input'] as const) : ([] as const);
  const since = o.since ?? '2026-09-02T00:00:00.000Z';
  return {
    source: 'session',
    ref: sessionRef(o.id),
    id: o.id,
    title: o.title ?? o.id,
    repoOrContext: o.prRepo ?? REPO,
    attention: {
      needsAttention: reasons.length > 0 && o.acked !== true,
      needsYou: reasons.length > 0 && o.acked !== true,
      reasons: [...reasons],
      since,
      signature: `${reasons.join(',')}|${since}`,
      acked: o.acked === true,
    },
    links: {
      sessionId: o.id,
      worktreePath: `/wt/${o.id}`,
      prRepo: o.prRepo ?? null,
      prNumber: o.prNumber ?? null,
      prUrl: o.prUrl ?? (o.prRepo !== undefined ? `https://github.com/${o.prRepo}/pull/${o.prNumber}` : null),
      ticket: o.ticket ?? null,
      primaryArtifact: 'REVIEW.md',
    },
    mode: o.mode,
    stageStatus: o.stageStatus ?? 'reviewing',
    running: false,
    claimed: false,
  };
}

function jiraReport(issues: Partial<JiraIssueSummary>[], over: Partial<JiraScanReport> = {}): JiraScanReport {
  return {
    scannedAt: SEEN,
    me: '712020:me',
    issues: issues.map((i) => ({
      key: 'HB-627',
      summary: 'a ticket',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      assignee: null,
      updated: '2026-09-03T00:00:00.000Z',
      url: 'https://example.atlassian.net/browse/HB-627',
      ...i,
    })),
    error: null,
    kind: 'ok',
    ...over,
  };
}

function group(over: Partial<GroupWorkItemsInput> = {}): WorkItem[] {
  const entries = over.inventory?.entries ?? [];
  const inventory: Inventory | null =
    over.inventory === undefined ? null : { scannedAt: SEEN, repos: [REPO], entries, errors: [] };
  return groupWorkItems({
    items: over.items ?? [],
    inventory,
    jira: over.jira ?? null,
    me: over.me ?? ME,
    watchAuthors: over.watchAuthors ?? ['bob'],
    showAllRepoPrs: over.showAllRepoPrs ?? false,
    projectKeys: over.projectKeys ?? ['HB', 'GRAC'],
  });
}

function inv(entries: InventoryEntry[]): Inventory {
  return { scannedAt: SEEN, repos: [REPO], entries, errors: [] };
}

function listsOf(items: WorkItem[], id: string): string[] {
  return items.find((i) => i.id === id)?.lists ?? [];
}

// ---------------------------------------------------------------------------
// The D2 table, as re-scoped by R47–R50.
// ---------------------------------------------------------------------------

describe('groupWorkItems: list membership (R47–R50, MG-2)', () => {
  it("a teammate PR with no agent is ONLY in parkingLot, group 'untouched'", () => {
    const e = entry({ number: 1 });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items.length).toBe(1);
    expect(items[0].lists).toEqual(['parkingLot']);
    expect(items[0].parkingLotGroup).toBe('untouched');
    expect(items[0].kind).toBe('pr');
  });

  it("the same PR once we start a REVIEW stays in parkingLot, group 'reviewing', and is NOT in myWork", () => {
    const e = entry({ number: 1 });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e), agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 1 })],
    });
    expect(items.length).toBe(1);
    expect(items[0].lists).toEqual(['parkingLot']);
    expect(items[0].parkingLotGroup).toBe('reviewing');
    expect(items[0].agents.map((a) => a.mode)).toEqual(['review']);
  });

  it('the same PR with an INVESTIGATION instead is in parkingLot AND myWork', () => {
    const e = entry({ number: 1 });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e), agentAttention({ id: 'i1', mode: 'investigation', prRepo: REPO, prNumber: 1 })],
    });
    expect(items[0].lists.sort()).toEqual(['myWork', 'parkingLot']);
    expect(items[0].parkingLotGroup).toBe('untouched');
  });

  it('my own open non-draft PR is never in parkingLot, and is in BOTH waitingForReview and myWork', () => {
    const e = entry({ number: 2, isMine: true, author: ME });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].lists.sort()).toEqual(['myWork', 'waitingForReview']);
  });

  // Phase 10 self-review (POST /items/.../agents { mode:'review', selfReview:true }):
  // a review agent of ours on our OWN PR must not put the item in the parking
  // lot — R47's itemIsMine exclusion already guards this unconditionally,
  // regardless of what agents the item carries.
  it('Phase 10: a self-review agent on my OWN PR never puts the item in parkingLot', () => {
    const e = entry({ number: 70, isMine: true, author: ME });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e), agentAttention({ id: 'sr1', mode: 'review', prRepo: REPO, prNumber: 70 })],
    });
    expect(items[0].lists).not.toContain('parkingLot');
    expect(items[0].parkingLotGroup).toBeNull();
  });

  it("MG-2: a non-watched author's PR is in NO list with showAllRepoPrs false, and parkingLot with it true", () => {
    const e = entry({ number: 3, author: 'stranger' });
    expect(group({ inventory: inv([e]), items: [prAttention(e)] })[0].lists).toEqual([]);
    expect(group({ inventory: inv([e]), items: [prAttention(e)], showAllRepoPrs: true })[0].lists).toEqual([
      'parkingLot',
    ]);
  });

  it("R30: a non-watched author's PR whose reviewRequests include me is in parkingLot regardless", () => {
    const e = entry({ number: 3, author: 'stranger', reviewRequests: ['ME-USER'] });
    expect(group({ inventory: inv([e]), items: [prAttention(e)] })[0].lists).toEqual(['parkingLot']);
  });

  it('R47: a DRAFT PR — mine and a teammate\'s — is in NO list at all', () => {
    const teammate = entry({ number: 4, isDraft: true });
    const mine = entry({ number: 5, isDraft: true, isMine: true, author: ME });
    const items = group({ inventory: inv([teammate, mine]), items: [prAttention(teammate), prAttention(mine)] });
    expect(items.map((i) => i.lists)).toEqual([[], []]);
  });

  it('a ticket with no PR, assigned to me, is in myWork', () => {
    const items = group({ jira: jiraReport([{ key: 'HB-627', assignee: '712020:me' }]) });
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe('ticket');
    expect(items[0].id).toBe('ticket:HB-627');
    expect(items[0].lists).toEqual(['myWork']);
  });

  it('R49: an investigation session with neither PR nor ticket is in investigations and NOT myWork', () => {
    const items = group({ items: [agentAttention({ id: 'inv-1', mode: 'investigation', title: 'a stack trace' })] });
    expect(items[0].kind).toBe('session');
    expect(items[0].id).toBe('session:inv-1');
    expect(items[0].lists).toEqual(['investigations']);
  });

  it('R49: the same session WITH a ticket goes to myWork, not investigations', () => {
    const items = group({
      items: [agentAttention({ id: 'inv-1', mode: 'investigation', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    expect(items[0].lists).toEqual(['myWork']);
  });

  it('R49: an investigation PLUS a dev session on one item is myWork', () => {
    const items = group({
      items: [
        agentAttention({ id: 'inv-1', mode: 'investigation', ticket: 'HB-627' }),
        agentAttention({ id: 'dev-1', mode: 'development', ticket: 'HB-627' }),
      ],
    });
    expect(items.length).toBe(1);
    expect(items[0].lists).toEqual(['myWork']);
    expect(items[0].agents.length).toBe(2);
  });

  it('R25: a review agent whose PR has been merged is still kind pr, with nulls everywhere but repo/number/url', () => {
    const items = group({
      inventory: inv([]),
      items: [agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 99 })],
    });
    expect(items[0].kind).toBe('pr');
    expect(items[0].prs.length).toBe(1);
    expect(items[0].prs[0]).toEqual({
      repo: REPO,
      number: 99,
      url: `https://github.com/${REPO}/pull/99`,
      title: null,
      author: null,
      branch: null,
      isDraft: null,
      isMine: null,
      reviewDecision: null,
      humanActivity: null,
      reviewRequests: null,
      teamActivity: null,
      updatedAt: null,
      createdAt: null,
      changedFiles: null,
      additions: null,
      deletions: null,
      ci: null,
      labels: null,
      sizeTier: null,
      // Unknown, NOT open: the pr-state leg has not resolved this one.
      state: null,
    });
  });

  it('two agents on one item are both in agents, ordered review -> respond -> investigation -> development', () => {
    const e = entry({ number: 1 });
    const items = group({
      inventory: inv([e]),
      items: [
        prAttention(e),
        agentAttention({ id: 'd1', mode: 'development', prRepo: REPO, prNumber: 1 }),
        agentAttention({ id: 'i1', mode: 'investigation', prRepo: REPO, prNumber: 1 }),
        agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 1 }),
      ],
    });
    expect(items[0].agents.map((a) => a.mode)).toEqual(['review', 'investigation', 'development']);
  });

  it('needsYou rolls up from any agent', () => {
    const items = group({
      items: [
        agentAttention({ id: 'a', mode: 'investigation', ticket: 'HB-1' }),
        agentAttention({ id: 'b', mode: 'development', ticket: 'HB-1', needsYou: true }),
      ],
      projectKeys: ['HB'],
    });
    expect(items[0].needsYou).toBe(true);
  });
});

describe('groupWorkItems: the pr<->ticket merge (R4, R26, R46, R61)', () => {
  it('merges by branch, by title and by body into ONE row whose id is the TICKET', () => {
    for (const e of [
      entry({ number: 10, isMine: true, author: ME, branch: 'feature/HB-627-x', ticketKeys: ['HB-627'] }),
      entry({ number: 11, isMine: true, author: ME, title: 'HB-627 do the thing', ticketKeys: ['HB-627'] }),
      entry({ number: 12, isMine: true, author: ME, ticketKeys: ['HB-627'] }),
    ]) {
      const items = group({ inventory: inv([e]), items: [prAttention(e)], jira: jiraReport([{ key: 'HB-627' }]) });
      expect(items.length).toBe(1);
      expect(items[0].kind).toBe('pr+ticket');
      expect(items[0].id).toBe('ticket:HB-627');
    }
  });

  it('R26: one ticket with two of MY PRs is one row, prs.length 2, newest first, needsYou from either', () => {
    const older = entry({
      number: 20,
      isMine: true,
      author: ME,
      ticketKeys: ['HB-627'],
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = entry({
      number: 21,
      isMine: true,
      author: ME,
      ticketKeys: ['HB-627'],
      updatedAt: '2026-09-05T00:00:00.000Z',
      reviewDecision: 'CHANGES_REQUESTED',
      reviewDecisionAt: '2026-09-05T00:00:00.000Z',
    });
    const items = group({
      inventory: inv([older, newer]),
      items: [prAttention(older), prAttention(newer)],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    expect(items.length).toBe(1);
    expect(items[0].prs.map((p) => p.number)).toEqual([21, 20]);
    expect(items[0].needsYou).toBe(true);
    expect(items[0].attention.refs).toContain('pr:acme/app#20');
    expect(items[0].attention.refs).toContain('pr:acme/app#21');
  });

  it("R61: two TEAMMATES' PRs naming HB-627 stay two items with two ids", () => {
    const a = entry({ number: 30, ticketKeys: ['HB-627'] });
    const b = entry({ number: 31, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([a, b]),
      items: [prAttention(a), prAttention(b)],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    const prItems = items.filter((i) => i.id.startsWith('pr:'));
    expect(prItems.map((i) => i.id).sort()).toEqual(['pr:acme/app#30', 'pr:acme/app#31']);
    expect(prItems.every((i) => i.lists.includes('parkingLot'))).toBe(true);
  });

  it('R61: the same pair with one of them MINE produces the R26 two-PR row, and it is NOT a parking-lot row', () => {
    const mine = entry({ number: 30, isMine: true, author: ME, ticketKeys: ['HB-627'] });
    const theirs = entry({ number: 31, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([mine, theirs]),
      items: [prAttention(mine), prAttention(theirs)],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    const merged = items.find((i) => i.id === 'ticket:HB-627')!;
    expect(merged.prs.map((p) => p.number).sort()).toEqual([30, 31]);
    // R47/MG-17: the isMine exclusion is a property of the ITEM, not of one
    // `prs[]` entry. The teammate's PR rode into MY row, and a row of mine is
    // never a parking-lot candidate — otherwise `parkingLot` and
    // `waitingForReview`, which MG-17 requires to be disjoint, both hold it,
    // and `labelOf` relabels my ticket row after the teammate's PR.
    expect(merged.lists.sort()).toEqual(['myWork', 'waitingForReview']);
    expect(merged.parkingLotGroup).toBeNull();
    const lists = workListsOf(items);
    expect(parkingLotOrder(lists)).not.toContain('ticket:HB-627');
    expect(lists.waitingForReview).toContain('ticket:HB-627');
    expect(lists.myWork).toContain('ticket:HB-627');
  });

  it("R47/R61: a teammate's PR absorbed by MY ticket is in myWork, never in the parking lot", () => {
    const theirs = entry({ number: 31, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([theirs]),
      items: [prAttention(theirs)],
      jira: jiraReport([{ key: 'HB-627', assignee: '712020:me' }]),
    });
    const merged = items.find((i) => i.id === 'ticket:HB-627')!;
    expect(merged.lists).toEqual(['myWork']);
    expect(merged.parkingLotGroup).toBeNull();
  });

  it("R61: a ticket assigned to me absorbs a teammate's PR that names it", () => {
    const theirs = entry({ number: 31, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([theirs]),
      items: [prAttention(theirs)],
      jira: jiraReport([{ key: 'HB-627', assignee: '712020:me' }]),
    });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('ticket:HB-627');
  });

  it('R46: with projectKeys empty nothing merges — the PR keeps its own id', () => {
    const e = entry({ number: 40, isMine: true, author: ME, ticketKeys: [] });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e)],
      jira: jiraReport([{ key: 'HB-627' }]),
      projectKeys: [],
    });
    expect(items.some((i) => i.id === 'pr:acme/app#40')).toBe(true);
  });

  it('R29: a session whose lineage.ticket is SHA-256 joins nothing (filtered at group time)', () => {
    const items = group({ items: [agentAttention({ id: 's1', mode: 'investigation', ticket: 'SHA-256' })] });
    expect(items[0].id).toBe('session:s1');
    expect(items[0].ticket).toBeNull();
  });
});

describe('groupWorkItems: R28 — identity follows the link, not the snapshot', () => {
  it('named: "ticket leaves the JQL -> id unchanged"', () => {
    const e = entry({ number: 50, isMine: true, author: ME, ticketKeys: ['HB-627'] });
    const withIssue = group({
      inventory: inv([e]),
      items: [prAttention(e)],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    const withoutIssue = group({ inventory: inv([e]), items: [prAttention(e)], jira: jiraReport([]) });
    expect(withIssue[0].id).toBe('ticket:HB-627');
    expect(withoutIssue[0].id).toBe('ticket:HB-627');
    expect(withoutIssue[0].lists).toEqual(withIssue[0].lists);
    expect(withoutIssue[0].ticket?.key).toBe('HB-627');
    expect(withoutIssue[0].ticket?.summary).toBe('');
  });

  it('the same holds with ticketSource kind unavailable', () => {
    const e = entry({ number: 50, isMine: true, author: ME, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e)],
      jira: jiraReport([], { kind: 'unavailable', error: 'boom' }),
    });
    expect(items[0].id).toBe('ticket:HB-627');
  });

  it("a session's filtered lineage.ticket also seeds a ticket candidate", () => {
    const items = group({ items: [agentAttention({ id: 'd1', mode: 'development', ticket: 'GRAC-12' })] });
    expect(items[0].id).toBe('ticket:GRAC-12');
  });
});

describe('groupWorkItems: demoted and parkingLotGroup (R47, R47.1 REVERSED gh#2125, MG-17)', () => {
  const withReviewer = entry({ number: 60, humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-09-02T00:00:00.000Z' } });
  const withCommenter = entry({ number: 61, humanActivity: { reviewedBy: [], commentedBy: ['jane'], lastAt: '2026-09-02T00:00:00.000Z' } });
  const withThreadReply = entry({ number: 62, humanActivity: { reviewedBy: [], commentedBy: ['jane'], lastAt: '2026-09-02T00:00:00.000Z' } });

  it('the three human-activity signals set demoted true and leave the row LISTED', () => {
    for (const e of [withReviewer, withCommenter, withThreadReply]) {
      const items = group({ inventory: inv([e]), items: [prAttention(e)] });
      expect(items[0].demoted).toBe(true);
      expect(items[0].lists).toEqual(['parkingLot']);
      expect(items[0].parkingLotGroup).toBe('someoneOnIt');
    }
  });

  it('a review request to ME and nothing else is NOT demoted', () => {
    const e = entry({ number: 64, reviewRequests: ['me-user'] });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].demoted).toBe(false);
    expect(items[0].parkingLotGroup).toBe('untouched');
  });

  it('a bot-only review request is not demoting', () => {
    const e = entry({ number: 65, reviewRequests: ['dependabot[bot]'] });
    expect(group({ inventory: inv([e]), items: [prAttention(e)] })[0].demoted).toBe(false);
  });

  // R47.1 REVERSED (gh#2125): a pending review request to somebody else — a
  // USER or a TEAM slug — is no longer a demoting signal. reviewRequests is
  // used only for "requested of me -> parking lot" (R30) and for display.
  it("R47.1 reversed: a review request to a USER other than me does NOT demote", () => {
    const e = entry({ number: 63, reviewRequests: ['jane'] });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].demoted).toBe(false);
    expect(items[0].parkingLotGroup).toBe('untouched');
  });

  it('R47.1 reversed: a review request to a TEAM slug does NOT demote', () => {
    const e = entry({ number: 67, reviewRequests: ['aplaceformom/grace-b2b'] });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].demoted).toBe(false);
    expect(items[0].parkingLotGroup).toBe('untouched');
  });

  // gh#2125 itself: the PR's only "activity" is the author's own review
  // comments (already excluded upstream by buildHumanActivity), bot reviews
  // from gitstream-cm/github-actions, a bot comment from apfm-sonar, and
  // pending review requests to three teams. None of that should demote.
  it('gh#2125: author-only activity + bot reviews/comments + three team review requests is untouched', () => {
    const e = entry({
      number: 2125,
      humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
      reviewRequests: ['aplaceformom/grace-b2b', 'aplaceformom/grace-b2c', 'aplaceformom/grace-platform'],
    });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].prs[0].humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
    expect(items[0].demoted).toBe(false);
    expect(items[0].parkingLotGroup).toBe('untouched');
  });

  it('gh#2125 contrast: a TEAMMATE comment on the same shape of PR DOES demote to someoneOnIt', () => {
    const e = entry({
      number: 2126,
      humanActivity: { reviewedBy: [], commentedBy: ['ateammate'], lastAt: '2026-09-05T00:00:00.000Z' },
      reviewRequests: ['aplaceformom/grace-b2b', 'aplaceformom/grace-b2c', 'aplaceformom/grace-platform'],
    });
    const items = group({ inventory: inv([e]), items: [prAttention(e)] });
    expect(items[0].demoted).toBe(true);
    expect(items[0].parkingLotGroup).toBe('someoneOnIt');
  });

  it("a demoted PR that also carries a review agent is 'reviewing', not 'someoneOnIt'", () => {
    const items = group({
      inventory: inv([withReviewer]),
      items: [prAttention(withReviewer), agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 60 })],
    });
    expect(items[0].demoted).toBe(true);
    expect(items[0].parkingLotGroup).toBe('reviewing');
  });

  it('parkingLotGroup is null off the parking lot', () => {
    const mine = entry({ number: 66, isMine: true, author: ME });
    expect(group({ inventory: inv([mine]), items: [prAttention(mine)] })[0].parkingLotGroup).toBeNull();
  });
});

describe('groupWorkItems: R57 — open(pr) is isDraft !== true, and a live agent is always listed', () => {
  it('a WorkItemPr with isDraft null (an agent-only row) is listed, not dropped', () => {
    const items = group({ items: [agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 99 })] });
    expect(items[0].prs[0].isDraft).toBeNull();
    expect(items[0].lists).toEqual(['parkingLot']);
    expect(items[0].parkingLotGroup).toBe('reviewing');
  });

  it('a MERGED teammate PR that still carries our review agent is in parkingLot.reviewing', () => {
    const items = group({
      inventory: inv([]),
      items: [agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 99 })],
    });
    expect(items[0].lists).toEqual(['parkingLot']);
    expect(items[0].parkingLotGroup).toBe('reviewing');
  });

  it('a merged own PR with a development agent is still in myWork', () => {
    const items = group({
      inventory: inv([]),
      items: [agentAttention({ id: 'd1', mode: 'development', prRepo: REPO, prNumber: 98 })],
    });
    expect(items[0].lists).toContain('myWork');
  });

  it('a teammate DRAFT PR with a review agent is in NO list — the disjunct keeps the draft test', () => {
    const draft = entry({ number: 70, isDraft: true });
    const items = group({
      inventory: inv([draft]),
      items: [prAttention(draft), agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 70 })],
    });
    expect(items[0].lists).toEqual([]);
    expect(items[0].parkingLotGroup).toBeNull();
  });
});

describe('groupWorkItems: the four DEFAULT sort orders (R47, §4.1 step 5)', () => {
  it('parkingLot applies the sort WITHIN each of the three groups and never across them', () => {
    const untouchedOld = entry({ number: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    const untouchedNew = entry({ number: 2, createdAt: '2026-06-01T00:00:00.000Z' });
    const demotedOld = entry({
      number: 3,
      createdAt: '2025-01-01T00:00:00.000Z',
      humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-01-01T00:00:00.000Z' },
    });
    const reviewingNew = entry({ number: 4, createdAt: '2026-09-01T00:00:00.000Z' });
    const lists = workListsOf(
      group({
        inventory: inv([untouchedOld, untouchedNew, demotedOld, reviewingNew]),
        items: [
          prAttention(untouchedOld),
          prAttention(untouchedNew),
          prAttention(demotedOld),
          prAttention(reviewingNew),
          agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 4 }),
        ],
      }),
    );
    expect(lists.parkingLot.reviewing).toEqual(['pr:acme/app#4']);
    expect(lists.parkingLot.untouched).toEqual(['pr:acme/app#1', 'pr:acme/app#2']);
    expect(lists.parkingLot.someoneOnIt).toEqual(['pr:acme/app#3']);
    // reviewing first even though it is the NEWEST; the demoted one last
    // despite being the oldest.
    expect(parkingLotOrder(lists)).toEqual([
      'pr:acme/app#4',
      'pr:acme/app#1',
      'pr:acme/app#2',
      'pr:acme/app#3',
    ]);
  });

  it('the reviewing group sorts needsYou first, then createdAt ascending', () => {
    const a = entry({ number: 1, createdAt: '2026-01-01T00:00:00.000Z' });
    const b = entry({ number: 2, createdAt: '2026-06-01T00:00:00.000Z' });
    const lists = workListsOf(
      group({
        inventory: inv([a, b]),
        items: [
          prAttention(a),
          prAttention(b),
          agentAttention({ id: 'ra', mode: 'review', prRepo: REPO, prNumber: 1 }),
          agentAttention({ id: 'rb', mode: 'review', prRepo: REPO, prNumber: 2, needsYou: true }),
        ],
      }),
    );
    expect(lists.parkingLot.reviewing).toEqual(['pr:acme/app#2', 'pr:acme/app#1']);
  });

  it('waitingForReview is createdAt ascending', () => {
    const a = entry({ number: 1, isMine: true, author: ME, createdAt: '2026-06-01T00:00:00.000Z' });
    const b = entry({ number: 2, isMine: true, author: ME, createdAt: '2026-01-01T00:00:00.000Z' });
    const lists = workListsOf(group({ inventory: inv([a, b]), items: [prAttention(a), prAttention(b)] }));
    expect(lists.waitingForReview).toEqual(['pr:acme/app#2', 'pr:acme/app#1']);
  });

  it('a missing sort key sorts LAST, and ties break on id', () => {
    const noAge = entry({ number: 1, createdAt: null });
    const aged = entry({ number: 2, createdAt: '2026-06-01T00:00:00.000Z' });
    expect(
      workListsOf(group({ inventory: inv([noAge, aged]), items: [prAttention(noAge), prAttention(aged)] })).parkingLot
        .untouched,
    ).toEqual(['pr:acme/app#2', 'pr:acme/app#1']);

    const tieA = entry({ number: 7, createdAt: '2026-06-01T00:00:00.000Z' });
    const tieB = entry({ number: 8, createdAt: '2026-06-01T00:00:00.000Z' });
    expect(
      workListsOf(group({ inventory: inv([tieB, tieA]), items: [prAttention(tieB), prAttention(tieA)] })).parkingLot
        .untouched,
    ).toEqual(['pr:acme/app#7', 'pr:acme/app#8']);
  });

  it('myWork is needsYou first then most-recently-updated; investigations is most-recently-updated', () => {
    const investigations = workListsOf(
      group({
        items: [
          agentAttention({ id: 'i-old', mode: 'investigation', since: '2026-01-01T00:00:00.000Z' }),
          agentAttention({ id: 'i-new', mode: 'investigation', since: '2026-08-01T00:00:00.000Z' }),
        ],
      }),
    ).investigations;
    expect(investigations).toEqual(['session:i-new', 'session:i-old']);

    const a = entry({ number: 1, isMine: true, author: ME, updatedAt: '2026-09-01T00:00:00.000Z' });
    const b = entry({ number: 2, isMine: true, author: ME, updatedAt: '2026-01-01T00:00:00.000Z' });
    const lists = workListsOf(
      group({
        inventory: inv([a, b]),
        items: [
          prAttention(a),
          prAttention(b),
          agentAttention({ id: 'd2', mode: 'development', prRepo: REPO, prNumber: 2, needsYou: true }),
        ],
      }),
    );
    expect(lists.myWork).toEqual(['pr:acme/app#2', 'pr:acme/app#1']);
  });

  it('every id in lists.parkingLot appears in exactly ONE of its three groups (MG-17)', () => {
    const untouched = entry({ number: 1 });
    const demoted = entry({
      number: 2,
      humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-09-01T00:00:00.000Z' },
    });
    const reviewing = entry({ number: 3 });
    const items = group({
      inventory: inv([untouched, demoted, reviewing]),
      items: [
        prAttention(untouched),
        prAttention(demoted),
        prAttention(reviewing),
        agentAttention({ id: 'r3', mode: 'review', prRepo: REPO, prNumber: 3 }),
      ],
    });
    const lists = workListsOf(items);
    const all = parkingLotOrder(lists);
    expect(new Set(all).size).toBe(all.length);
    for (const item of items.filter((i) => i.lists.includes('parkingLot'))) {
      expect(lists.parkingLot[item.parkingLotGroup!]).toContain(item.id);
    }
  });

  it('reads no clock: two calls over the same input are byte-identical', () => {
    const e = entry({ number: 1 });
    const input = { inventory: inv([e]), items: [prAttention(e)] };
    expect(JSON.stringify(group(input))).toBe(JSON.stringify(group(input)));
  });
});

describe('groupWorkItems: the row label (R13, R47)', () => {
  it('prefers the ticket summary, falls back to the bare KEY', () => {
    const withSummary = group({ jira: jiraReport([{ key: 'HB-627', summary: 'Do the thing', assignee: '712020:me' }]) });
    expect(withSummary[0].title).toBe('HB-627 — Do the thing');
    const seeded = group({ items: [agentAttention({ id: 'd1', mode: 'development', ticket: 'HB-999' })] });
    expect(seeded[0].title).toBe('HB-999');
  });

  it('a PR with no ticket is "<repo>#<n> — <title>", and "<repo>#<n>" when the title is null', () => {
    const e = entry({ number: 1, title: 'Add thing' });
    expect(group({ inventory: inv([e]), items: [prAttention(e)] })[0].title).toBe('acme/app#1 — Add thing');
    const agentOnly = group({ items: [agentAttention({ id: 'r1', mode: 'review', prRepo: REPO, prNumber: 9 })] });
    expect(agentOnly[0].title).toBe('acme/app#9');
  });

  it('a session item uses the session title', () => {
    const items = group({ items: [agentAttention({ id: 's1', mode: 'investigation', title: 'a stack trace' })] });
    expect(items[0].title).toBe('a stack trace');
  });

  it("R47: a parkingLot row is always <repo>#<n> — title even when it carries a ticket key", () => {
    // R61 merges the teammate's PR into the ticket because a session of OURS
    // references it — the one route that still leaves a TICKET-bearing row in
    // the parking lot, now that a row whose ticket is assigned to me, or that
    // holds a PR of mine, is excluded from the list outright (R47).
    const e = entry({ number: 1, ticketKeys: ['HB-627'], title: 'Add thing' });
    const items = group({
      inventory: inv([e]),
      items: [
        prAttention(e),
        agentAttention({ id: 'i1', mode: 'investigation', ticket: 'HB-627' }),
      ],
      jira: jiraReport([{ key: 'HB-627', summary: 'Do the thing', assignee: null }]),
    });
    const row = items.find((i) => i.lists.includes('parkingLot'))!;
    expect(row.id).toBe('ticket:HB-627');
    expect(row.ticket?.key).toBe('HB-627');
    expect(row.title).toBe('acme/app#1 — Add thing');
  });
});

describe('groupWorkItems: attention roll-up (R3, R26, R31)', () => {
  it('attention.refs carries every agent ref AND every PR ref', () => {
    const e = entry({ number: 1, isMine: true, author: ME, ticketKeys: ['HB-627'] });
    const items = group({
      inventory: inv([e]),
      items: [prAttention(e), agentAttention({ id: 'd1', mode: 'development', prRepo: REPO, prNumber: 1 })],
      jira: jiraReport([{ key: 'HB-627' }]),
    });
    expect(items[0].attention.refs.sort()).toEqual(['pr:acme/app#1', 'session:d1']);
  });

  it('acked is true only when EVERY ref is acked', () => {
    const items = group({
      items: [
        agentAttention({ id: 'a', mode: 'development', ticket: 'HB-1', needsYou: true, acked: true }),
        agentAttention({ id: 'b', mode: 'investigation', ticket: 'HB-1', needsYou: true, acked: false }),
      ],
      projectKeys: ['HB'],
    });
    expect(items[0].attention.acked).toBe(false);

    const allAcked = group({
      items: [
        agentAttention({ id: 'a', mode: 'development', ticket: 'HB-1', needsYou: true, acked: true }),
        agentAttention({ id: 'b', mode: 'investigation', ticket: 'HB-1', needsYou: true, acked: true }),
      ],
      projectKeys: ['HB'],
    });
    expect(allAcked[0].attention.acked).toBe(true);
  });

  it('reasons are the union, in ATTENTION_REASONS order, with no sort', () => {
    const mine = entry({
      number: 1,
      isMine: true,
      author: ME,
      reviewDecision: 'APPROVED',
      reviewDecisionAt: '2026-09-05T00:00:00.000Z',
      humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-09-05T00:00:00.000Z' },
    });
    const items = group({
      inventory: inv([mine]),
      items: [prAttention(mine), agentAttention({ id: 'd1', mode: 'development', prRepo: REPO, prNumber: 1, needsYou: true })],
    });
    expect(items[0].attention.reasons).toEqual(['needs_input', 'review_arrived', 'approved']);
  });
});

describe('groupWorkItems: MG-17 totality and disjointness', () => {
  it('over a fixture covering every branch, the invariants hold', () => {
    const teammate = entry({ number: 1 });
    const teammateReviewed = entry({ number: 2 });
    const teammateDemoted = entry({
      number: 3,
      humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: '2026-09-02T00:00:00.000Z' },
    });
    const draft = entry({ number: 4, isDraft: true });
    const stranger = entry({ number: 5, author: 'stranger' });
    const mine = entry({ number: 6, isMine: true, author: ME });
    const items = group({
      inventory: inv([teammate, teammateReviewed, teammateDemoted, draft, stranger, mine]),
      items: [
        prAttention(teammate),
        prAttention(teammateReviewed),
        prAttention(teammateDemoted),
        prAttention(draft),
        prAttention(stranger),
        prAttention(mine),
        agentAttention({ id: 'r2', mode: 'review', prRepo: REPO, prNumber: 2 }),
        agentAttention({ id: 'inv-only', mode: 'investigation' }),
      ],
    });

    // every review-carrying teammate PR is in parkingLot exactly once, in 'reviewing'
    const reviewed = items.find((i) => i.prs[0]?.number === 2)!;
    expect(reviewed.lists.filter((l) => l === 'parkingLot').length).toBe(1);
    expect(reviewed.parkingLotGroup).toBe('reviewing');
    expect(reviewed.lists).not.toContain('myWork');

    // myWork never contains a review-only item
    for (const item of items.filter((i) => i.lists.includes('myWork'))) {
      expect(item.agents.every((a) => a.mode === 'review') && item.prs.every((p) => p.isMine !== true)).toBe(false);
    }

    // investigations never intersects myWork
    for (const item of items) {
      expect(item.lists.includes('investigations') && item.lists.includes('myWork')).toBe(false);
    }

    // deliberately in no list: the draft and the non-watched author's PR
    expect(listsOf(items, 'pr:acme/app#4')).toEqual([]);
    expect(listsOf(items, 'pr:acme/app#5')).toEqual([]);
    // everything else lands somewhere
    for (const item of items) {
      if (item.id === 'pr:acme/app#4' || item.id === 'pr:acme/app#5') continue;
      expect(item.lists.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// MG-17 — `four-lists-are-total-and-disjoint-where-they-must-be`, as a matrix
// rather than a hand-picked handful of rows: owner x PR draftness x agent x
// ticket linkage, 24 items, every one of them checked against the SAME
// invariants.
// ---------------------------------------------------------------------------

describe('MG-17: the four lists are total and disjoint where they must be', () => {
  const OWNERS = ['mine', 'teammate'] as const;
  const DRAFTS = ['open', 'draft'] as const;
  const AGENTS = ['none', 'review', 'dev'] as const;
  const TICKETS = ['myTicket', 'unlinked'] as const;

  interface Combo {
    owner: (typeof OWNERS)[number];
    draft: (typeof DRAFTS)[number];
    agent: (typeof AGENTS)[number];
    ticket: (typeof TICKETS)[number];
    id: string;
    key: string;
    number: number;
    name: string;
  }

  const combos: Combo[] = [];
  for (const owner of OWNERS) {
    for (const draft of DRAFTS) {
      for (const agent of AGENTS) {
        for (const ticket of TICKETS) {
          const n = 100 + combos.length;
          const key = `HB-${n}`;
          combos.push({
            owner,
            draft,
            agent,
            ticket,
            number: n,
            key,
            // A linked PR is merged into its ticket (R61 lets it, the ticket
            // is mine), so the resulting item's id follows the link.
            id: ticket === 'myTicket' ? `ticket:${key}` : `pr:${REPO}#${n}`,
            name: `${owner}/${draft}/${agent}/${ticket}`,
          });
        }
      }
    }
  }

  const entries = combos.map((c) =>
    entry({
      number: c.number,
      isDraft: c.draft === 'draft',
      ...(c.owner === 'mine' ? { isMine: true, author: ME } : { isMine: false, author: 'bob' }),
      ticketKeys: c.ticket === 'myTicket' ? [c.key] : [],
    }),
  );
  const agentItems = combos
    .filter((c) => c.agent !== 'none')
    .map((c) =>
      agentAttention({
        id: `a${c.number}`,
        mode: c.agent === 'review' ? 'review' : 'development',
        prRepo: REPO,
        prNumber: c.number,
      }),
    );
  const items = group({
    inventory: inv(entries),
    items: [...entries.map(prAttention), ...agentItems],
    jira: jiraReport(
      combos.filter((c) => c.ticket === 'myTicket').map((c) => ({ key: c.key, assignee: '712020:me' })),
    ),
  });

  const of = (c: Combo): WorkItem => {
    const found = items.find((i) => i.id === c.id);
    if (found === undefined) throw new Error(`no item for ${c.name} (${c.id})`);
    return found;
  };

  it('the matrix produces exactly one item per combination', () => {
    expect(items.length).toBe(combos.length);
    for (const c of combos) expect(of(c).prs.map((p) => p.number)).toEqual([c.number]);
  });

  it('every item that anything makes listable is in at least one list (R57)', () => {
    for (const c of combos) {
      const item = of(c);
      // The two deliberate non-members of every list: a DRAFT is in no list
      // (R47), and R57's totality disjunct keeps the draft test — so a
      // teammate's draft, even with a review agent, stays unlisted unless
      // something else lists it.
      const listable =
        c.agent === 'dev' ||
        c.ticket === 'myTicket' ||
        c.draft === 'open';
      if (listable) expect(item.lists.length, `${c.name} must be listed`).toBeGreaterThan(0);
      else expect(item.lists, `${c.name} is deliberately unlisted`).toEqual([]);
    }
  });

  it('parkingLot is disjoint from waitingForReview and from investigations', () => {
    for (const c of combos) {
      const l = of(c).lists;
      expect(l.includes('parkingLot') && l.includes('waitingForReview'), `${c.name}`).toBe(false);
      expect(l.includes('parkingLot') && l.includes('investigations'), `${c.name}`).toBe(false);
      expect(l.includes('investigations') && l.includes('myWork'), `${c.name}`).toBe(false);
    }
  });

  it('the ONLY parkingLot ∩ myWork overlap is a teammate PR carrying a non-review session (MG-17)', () => {
    for (const c of combos) {
      const item = of(c);
      if (!item.lists.includes('parkingLot') || !item.lists.includes('myWork')) continue;
      expect(c.owner, `${c.name}`).toBe('teammate');
      expect(c.ticket, `${c.name}`).toBe('unlinked');
      expect(item.agents.some((a) => a.mode !== 'review'), `${c.name}`).toBe(true);
    }
  });

  it('no item of MINE — my PR or my ticket — is ever a parking-lot candidate (R47)', () => {
    for (const c of combos) {
      const item = of(c);
      const mine = item.prs.some((p) => p.isMine === true) || item.ticket?.assignee === '712020:me';
      if (mine) expect(item.lists.includes('parkingLot'), `${c.name}`).toBe(false);
    }
  });

  it('a review agent alone never routes an item into myWork (R48)', () => {
    for (const c of combos.filter((x) => x.agent === 'review' && x.owner === 'teammate' && x.ticket === 'unlinked')) {
      expect(of(c).lists, c.name).not.toContain('myWork');
    }
  });

  it('every parkingLot id sits in exactly one group, matching its parkingLotGroup', () => {
    const lists = workListsOf(items);
    const { reviewing, untouched, someoneOnIt } = lists.parkingLot;
    const all = [...reviewing, ...untouched, ...someoneOnIt];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(items.filter((i) => i.lists.includes('parkingLot')).map((i) => i.id).sort());
    for (const id of reviewing) expect(items.find((i) => i.id === id)!.parkingLotGroup).toBe('reviewing');
    for (const id of untouched) expect(items.find((i) => i.id === id)!.parkingLotGroup).toBe('untouched');
    for (const id of someoneOnIt) expect(items.find((i) => i.id === id)!.parkingLotGroup).toBe('someoneOnIt');
  });
});
