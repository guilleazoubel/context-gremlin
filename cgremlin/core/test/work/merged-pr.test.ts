/**
 * The merged-PR case, end to end through the GROUPING.
 *
 * Live defect (`aplaceformom/grace#2180`, merged 2026-09-11): the PR left the
 * open-PR inventory, so nothing said "merged"; the row kept offering review
 * verbs; and — because the inventory row that carried `ticketKeys` left with
 * it — the row lost HB-1489 and rendered as a bare PR.
 */
import { describe, expect, it } from 'vitest';
import { groupWorkItems, isLanded, workListsOf, type GroupWorkItemsInput } from '../../src/work/work-item';
import type { AttentionItem } from '../../src/attention/attention-service';
import { sessionRef } from '../../src/attention/item-ref';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { PrStateCache } from '../../src/gh/pr-state';
import { prStateKey } from '../../src/gh/pr-state';
import { PR_STATE_ENTRY_DEFAULTS } from '../support/pr-state-entry';

const ME = 'me-user';
const JIRA_ME = 'Guilherme Azoubel';
const REPO = 'aplaceformom/grace';
const TITLE = 'feat(HB-1489): add web-content read endpoint to the Grace backend';

/** The cache entry the pr-state leg writes for a merged PR the open list no longer has. */
function mergedCache(number = 2180, ticketKeys: string[] = ['HB-1489']): PrStateCache {
  return {
    [prStateKey(REPO, number)]: {
      ...PR_STATE_ENTRY_DEFAULTS,
      state: 'merged',
      title: TITLE,
      url: `https://github.com/${REPO}/pull/${number}`,
      mergedAt: '2026-09-11T13:34:00Z',
      closedAt: null,
      branch: 'HB-1489-web-content-read',
      ticketKeys,
      checkedAt: '2026-09-14T09:00:00.000Z',
    },
  };
}

function jira(over: Partial<JiraScanReport> = {}): JiraScanReport {
  return {
    scannedAt: '2026-09-14T09:00:00.000Z',
    me: JIRA_ME,
    kind: 'ok',
    error: null,
    issues: [
      {
        key: 'HB-1489',
        summary: 'Web-content read endpoint',
        status: 'UAT',
        statusCategory: 'In Progress',
        url: 'https://jira.invalid/browse/HB-1489',
        assignee: JIRA_ME,
        updated: '2026-09-13T10:00:00.000Z',
      },
    ],
    ...over,
  } as JiraScanReport;
}

/** The respond session still open on the merged PR (phase `addressing`), as attention sees it. */
function respondAgent(over: { ticket?: string | null; stageStatus?: string } = {}): AttentionItem {
  const id = 'respond-grace-2180-20260911-040030';
  return {
    source: 'session',
    ref: sessionRef(id),
    id,
    title: TITLE,
    repoOrContext: REPO,
    attention: { reasons: [], since: '2026-09-11T04:00:30.000Z', needsAttention: false, needsYou: false, acked: false },
    links: {
      sessionId: id,
      worktreePath: `/worktrees/${id}`,
      prRepo: REPO,
      prNumber: 2180,
      prUrl: `https://github.com/${REPO}/pull/2180`,
      ticket: over.ticket === undefined ? 'HB-1489' : over.ticket,
      primaryArtifact: null,
    },
    mode: 'respond',
    stageStatus: over.stageStatus ?? 'addressing',
    running: false,
    claimed: false,
  } as unknown as AttentionItem;
}

function input(over: Partial<GroupWorkItemsInput> = {}): GroupWorkItemsInput {
  return {
    items: [],
    inventory: null,
    jira: jira(),
    me: ME,
    watchAuthors: [],
    showAllRepoPrs: false,
    projectKeys: ['HB'],
    ...over,
  };
}

function entry(over: Partial<InventoryEntry> & { number: number }): InventoryEntry {
  return {
    ...PHASE9_ENTRY_DEFAULTS,
    repo: REPO,
    url: `https://github.com/${REPO}/pull/${over.number}`,
    title: `PR ${over.number}`,
    author: ME,
    isDraft: false,
    headSha: 'sha',
    baseRef: 'main',
    updatedAt: '2026-09-13T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    reviewDecision: '',
    isMine: true,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const inventoryOf = (entries: InventoryEntry[]): Inventory => ({
  scannedAt: '2026-09-14T09:00:00.000Z',
  repos: [REPO],
  entries,
  errors: [],
});

describe('a merged PR that left the open-PR inventory', () => {
  it("carries state 'merged' on the wire", () => {
    const items = groupWorkItems(input({ items: [respondAgent()], prStates: mergedCache() }));
    const item = items.find((i) => i.prs.length > 0)!;
    expect(item.prs[0].state).toBe('merged');
    expect(item.prs[0].number).toBe(2180);
    // The cache also restores the title and the branch the inventory took with it.
    expect(item.prs[0].title).toBe(TITLE);
  });

  it('groups with HB-1489 from the PR TITLE ALONE — no session, no lineage, no inventory row', () => {
    // Nothing references the PR except the cache: no attention item at all.
    const items = groupWorkItems(input({ items: [], prStates: mergedCache() }));
    const item = items.find((i) => i.ticket?.key === 'HB-1489')!;
    expect(item.id).toBe('ticket:HB-1489');
    expect(item.prs.map((p) => p.number)).toEqual([2180]);
    expect(item.prs[0].state).toBe('merged');
    expect(item.kind).toBe('pr+ticket');
  });

  it('keeps one item, with an id that does NOT flip, while the respond session is still open (R28)', () => {
    const items = groupWorkItems(input({ items: [respondAgent()], prStates: mergedCache() }));
    expect(items.filter((i) => i.prs.some((p) => p.number === 2180)).length).toBe(1);
    const item = items.find((i) => i.prs.some((p) => p.number === 2180))!;
    expect(item.id).toBe('ticket:HB-1489');
    expect(item.ticket?.key).toBe('HB-1489');
    expect(item.agents.map((a) => a.sessionId)).toEqual(['respond-grace-2180-20260911-040030']);
  });

  it("links through the session's lineage.ticket too, when the leg has not resolved the PR yet", () => {
    const items = groupWorkItems(input({ items: [respondAgent()] }));
    const item = items.find((i) => i.prs.some((p) => p.number === 2180))!;
    expect(item.id).toBe('ticket:HB-1489');
    // Unknown, NOT open: nothing has said what happened to it.
    expect(item.prs[0].state).toBeNull();
  });

  it('stays in My dev work while the ticket is live — that is the context worth keeping', () => {
    const items = groupWorkItems(input({ items: [], prStates: mergedCache() }));
    const item = items.find((i) => i.id === 'ticket:HB-1489')!;
    expect(item.lists).toContain('myWork');
    // And never in waitingForReview: a merged PR is not out with reviewers.
    expect(item.lists).not.toContain('waitingForReview');
  });

  it('LEAVES EVERY LIST when the merged PR was its only reason to exist', () => {
    // No live ticket (the JQL returns nothing), no session — just the cache.
    const items = groupWorkItems(
      input({ items: [], jira: jira({ issues: [] }), prStates: mergedCache() }),
    );
    // The cache DECORATES; it never creates an item, so there is nothing at all.
    expect(items.filter((i) => i.prs.some((p) => p.number === 2180))).toEqual([]);
  });

  it('a merged own PR still named by a live session is in no list a live PR would put it in', () => {
    const items = groupWorkItems(
      input({
        items: [respondAgent({ ticket: null })],
        jira: jira({ issues: [] }),
        prStates: mergedCache(),
      }),
    );
    const item = items.find((i) => i.prs.some((p) => p.number === 2180))!;
    // Jira is down / the JQL returned nothing, yet the row STILL says
    // HB-1489: the cache's title-derived key seeds the ticket candidate, so
    // the id does not flip with the ticket source's availability (R28).
    expect(item.id).toBe('ticket:HB-1489');
    expect(item.lists).not.toContain('waitingForReview');
    expect(item.lists).not.toContain('parkingLot');
    // The respond agent itself is still the user's own work until it closes.
    expect(item.lists).toEqual(['myWork']);
  });

  it('with the merged PR having NO ticket key at all, it stays a pr: item and leaves every list once its session ends', () => {
    const noKey = mergedCache(2180, []);
    const live = groupWorkItems(
      input({ items: [respondAgent({ ticket: null })], jira: jira({ issues: [] }), prStates: noKey }),
    ).find((i) => i.prs.some((p) => p.number === 2180))!;
    expect(live.id).toBe('pr:aplaceformom/grace#2180');
    expect(live.lists).toEqual(['myWork']);

    // The respond session has since closed, so attention no longer reports it.
    const after = groupWorkItems(input({ items: [], jira: jira({ issues: [] }), prStates: noKey }));
    expect(after.filter((i) => i.prs.some((p) => p.number === 2180))).toEqual([]);
  });
});

describe('landed work sinks', () => {
  const live = entry({ number: 4000, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' });

  function listsWith(): ReturnType<typeof workListsOf> {
    const items = groupWorkItems(
      input({ items: [], inventory: inventoryOf([live]), prStates: mergedCache() }),
    );
    return workListsOf(items);
  }

  it('isLanded is true only when EVERY pr on the item has landed', () => {
    const items = groupWorkItems(input({ items: [], prStates: mergedCache() }));
    expect(isLanded(items.find((i) => i.id === 'ticket:HB-1489')!)).toBe(true);
    const openItems = groupWorkItems(input({ items: [], inventory: inventoryOf([live]) }));
    expect(openItems.every((i) => !isLanded(i))).toBe(true);
  });

  it('myWork (needsYou-then-recent) puts the landed item last, even though it is the most recent', () => {
    const lists = listsWith();
    expect(lists.myWork.at(-1)).toBe('ticket:HB-1489');
    expect(lists.myWork.length).toBeGreaterThan(1);
  });

  it('waitingForReview (created-at ascending) never lists a landed PR at all', () => {
    expect(listsWith().waitingForReview).not.toContain('ticket:HB-1489');
  });
});

/**
 * Phase 14 — nothing on a merged PR's row may be blank where the cache has
 * the answer. The user's words: "I don't know who did it, I don't know that
 * it was already merged, I don't see the title or the jira ticket attached."
 */
describe('a merged PR decorates its row from the cache, not from the (departed) inventory', () => {
  function fullMergedCache(): PrStateCache {
    const base = mergedCache();
    const key = prStateKey(REPO, 2180);
    return {
      [key]: {
        ...base[key],
        author: 'gennaro',
        createdAt: '2026-09-09T08:00:00Z',
        changedFiles: 7,
        additions: 120,
        deletions: 30,
        isDraft: false,
        labels: ['backend'],
      },
    };
  }

  it('carries author, age, size tier, files +a/-d, title, labels and `merged`', () => {
    const items = groupWorkItems({
      items: [respondAgent()],
      inventory: null,
      jira: jira(),
      me: ME,
      watchAuthors: [],
      showAllRepoPrs: false,
      projectKeys: ['HB'],
      prStates: fullMergedCache(),
    });
    const pr = items.flatMap((i) => i.prs).find((p) => p.number === 2180);
    expect(pr).toMatchObject({
      repo: REPO,
      number: 2180,
      state: 'merged',
      title: TITLE,
      author: 'gennaro',
      createdAt: '2026-09-09T08:00:00Z',
      changedFiles: 7,
      additions: 120,
      deletions: 30,
      isDraft: false,
      labels: ['backend'],
    });
    expect(pr?.sizeTier).not.toBeNull();
  });
});
