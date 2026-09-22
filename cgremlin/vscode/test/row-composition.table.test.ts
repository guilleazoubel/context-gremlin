/**
 * THE regression table (Phase 14).
 *
 * Every item shape the panel can be handed, crossed with every PR state, asserted line by line:
 * identity (L1), description (L2), and the L3 cells — repo, who, age, PR state, ticket status.
 *
 * Why it exists, in the user's words after a merged PR's row collapsed to a bare
 * `aplaceformom/grace-frontend#2061`: "I don't know who did it, I don't know that it was already
 * merged, I don't see the title or the jira ticket attached to it … make sure those items use DRY
 * concepts and we can keep them from regressing so it always shows the proper way."
 *
 * This is the file a future change to `model/row-composition` has to update DELIBERATELY. The
 * last case in every group is the same assertion said generally: nothing is blank where the data
 * to fill it exists.
 */
import { describe, expect, it } from 'vitest';
import { toRow, type WorkItem, type WorkItemAgent, type WorkItemPr } from '../src/model/work-items';

const NOW = Date.parse('2026-09-15T18:00:00.000Z');
const REPO = 'aplaceformom/grace-frontend';

function pr(over: Partial<WorkItemPr> = {}): WorkItemPr {
  return {
    repo: REPO,
    number: 2061,
    url: `https://github.com/${REPO}/pull/2061`,
    title: 'feat(HB-6210): the landed change',
    author: 'gennaro',
    branch: 'feature/HB-6210-x',
    isDraft: false,
    isMine: false,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: '2026-09-15T14:28:21Z',
    createdAt: '2026-09-09T08:00:00Z',
    changedFiles: 7,
    additions: 120,
    deletions: 30,
    ci: 'success',
    labels: ['backend'],
    sizeTier: 'M',
    state: 'open',
    ...over,
  } as WorkItemPr;
}

/** The degraded shape: a PR no inventory row describes and no pr-state cache has resolved yet. */
function bareP(): WorkItemPr {
  return pr({
    title: null, author: null, branch: null, isDraft: null, createdAt: null,
    changedFiles: null, additions: null, deletions: null, ci: null, labels: null,
    sizeTier: null, state: null,
  });
}

const TICKET = {
  key: 'HB-6210',
  summary: 'Web-content read endpoint',
  status: 'UAT',
  statusCategory: 'In Progress',
  url: 'https://jira.invalid/browse/HB-6210',
  assignee: 'guilherme',
  updatedAt: '2026-09-13T10:00:00.000Z',
};

function agent(over: Partial<WorkItemAgent> = {}): WorkItemAgent {
  return {
    sessionId: 'pr-grace-frontend-2061-20260915-160008',
    repo: REPO,
    mode: 'review',
    phase: 'dismissed',
    running: false,
    needsYou: false,
    claimed: false,
    primaryArtifact: 'BRIEF.md',
    worktreePath: null,
    ref: `session:s1`,
    ...over,
  } as WorkItemAgent;
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'pr:aplaceformom/grace-frontend#2061',
    kind: 'pr',
    lists: ['parkingLot'],
    demoted: false,
    parkingLotGroup: 'untouched',
    title: `${REPO}#2061 — feat(HB-6210): the landed change`,
    prs: [pr()],
    ticket: null,
    agents: [],
    needsYou: false,
    dismissed: false,
    dismissedAt: null,
    attention: { reasons: [], since: '2026-09-15T16:00:08.000Z', acked: false, refs: [] },
    ...over,
  } as WorkItem;
}

const cell = (row: ReturnType<typeof toRow>, kind: string): string | undefined =>
  row.meta.find((c) => c.kind === kind)?.text;

interface Case {
  name: string;
  item: WorkItem;
  list?: 'parkingLot' | 'myWork' | 'investigations' | 'waitingForReview';
  identity: string[];
  description: string;
  repo: string;
  age: string;
  /** The `merged`/`closed` token, or undefined when the PR has not landed. */
  prState?: string;
  /** `@login`, or undefined when an agent or an activity line outranks it. */
  author?: string;
  ticketStatus?: string;
  agentPhase?: string;
}

const CASES: Case[] = [
  {
    name: 'PR live (open), nobody on it',
    item: item(),
    // Round 3 §e.8: the ticket key is lifted out of the conventional-commit prefix onto L1, and
    // the prefix itself comes off L2 — it is chrome twice over.
    identity: ['HB-6210', '#2061'], description: 'the landed change',
    repo: 'grace-frontend', age: '6d', author: '@gennaro',
  },
  {
    name: 'PR draft',
    item: item({ prs: [pr({ state: 'draft', isDraft: true })] }),
    // Round 3 §e.8: the ticket key is lifted out of the conventional-commit prefix onto L1, and
    // the prefix itself comes off L2 — it is chrome twice over.
    identity: ['HB-6210', '#2061'], description: 'the landed change',
    repo: 'grace-frontend', age: '6d', author: '@gennaro',
  },
  {
    name: 'PR merged — decorated from the pr-state cache',
    item: item({ prs: [pr({ state: 'merged' })] }),
    // Round 3 §e.8: the ticket key is lifted out of the conventional-commit prefix onto L1, and
    // the prefix itself comes off L2 — it is chrome twice over.
    identity: ['HB-6210', '#2061'], description: 'the landed change',
    repo: 'grace-frontend', age: '6d', author: '@gennaro', prState: 'merged',
  },
  {
    name: 'PR closed without merging',
    item: item({ prs: [pr({ state: 'closed' })] }),
    // Round 3 §e.8: the ticket key is lifted out of the conventional-commit prefix onto L1, and
    // the prefix itself comes off L2 — it is chrome twice over.
    identity: ['HB-6210', '#2061'], description: 'the landed change',
    repo: 'grace-frontend', age: '6d', author: '@gennaro', prState: 'closed',
  },
  {
    name: 'PR absent from the inventory and not yet resolved — honest blanks, never a guess',
    item: item({ prs: [bareP()], title: `${REPO}#2061` }),
    identity: ['#2061'], description: '',
    repo: 'grace-frontend', age: '—',
  },
  {
    name: 'ticket only',
    item: item({ id: 'ticket:HB-6210', kind: 'ticket', prs: [], ticket: TICKET, title: 'HB-6210 — Web-content read endpoint', lists: ['myWork'] }),
    list: 'myWork',
    identity: ['HB-6210'], description: 'Web-content read endpoint',
    repo: '', age: '1h', ticketStatus: 'UAT',
  },
  {
    name: 'ticket + PR',
    item: item({ id: 'ticket:HB-6210', kind: 'pr+ticket', ticket: TICKET, prs: [pr({ state: 'merged' })], lists: ['myWork'] }),
    list: 'myWork',
    identity: ['HB-6210', '#2061'], description: 'Web-content read endpoint',
    repo: 'grace-frontend', age: '6d', prState: 'merged', ticketStatus: 'UAT',
  },
  {
    name: 'session only — the session title IS the identity',
    item: item({ id: 'session:s1', kind: 'session', prs: [], title: 'Why is the inbox slow', agents: [agent({ mode: 'investigation', phase: 'planning' })], lists: ['investigations'] }),
    list: 'investigations',
    identity: ['Why is the inbox slow'], description: '',
    repo: '', age: '1h', agentPhase: '∴ planning',
  },
  {
    name: 'PR + agent — the agent outranks the author',
    item: item({ agents: [agent()] }),
    // Round 3 §e.8: the ticket key is lifted out of the conventional-commit prefix onto L1, and
    // the prefix itself comes off L2 — it is chrome twice over.
    identity: ['HB-6210', '#2061'], description: 'the landed change',
    repo: 'grace-frontend', age: '6d', agentPhase: '◈ dismissed',
  },
  {
    name: 'ticket + merged PR + the review that was started on it deliberately',
    item: item({ id: 'ticket:HB-6210', kind: 'pr+ticket', ticket: TICKET, prs: [pr({ state: 'merged' })], agents: [agent()], lists: ['myWork'] }),
    list: 'myWork',
    identity: ['HB-6210', '#2061'], description: 'Web-content read endpoint',
    repo: 'grace-frontend', age: '6d', prState: 'merged', ticketStatus: 'UAT', agentPhase: '◈ dismissed',
  },
];

describe('the row composition table', () => {
  for (const c of CASES) {
    it(`${c.name}: renders every line the way it was agreed`, () => {
      const row = toRow(c.item, c.list ?? 'parkingLot', NOW);
      expect(row.identityKeys).toEqual(c.identity);
      expect(row.description).toBe(c.description);
      expect(cell(row, 'repo') ?? '').toBe(c.repo);
      expect(cell(row, 'age')).toBe(c.age);
      expect(cell(row, 'prState')).toBe(c.prState);
      expect(cell(row, 'author')).toBe(c.author);
      expect(cell(row, 'ticketStatus')).toBe(c.ticketStatus);
      expect(cell(row, 'agentPhase')).toBe(c.agentPhase);
    });
  }

  it('nothing is blank where the data to fill it exists', () => {
    for (const c of CASES) {
      const row = toRow(c.item, c.list ?? 'parkingLot', NOW);
      const primary = c.item.prs[0];
      expect(row.identityKeys.length).toBeGreaterThan(0);
      if (c.item.ticket !== null) expect(row.identityKeys).toContain(c.item.ticket.key);
      if (primary !== undefined) expect(row.identityKeys).toContain(`#${primary.number}`);
      // A description exists whenever ANY rung of the chain has text.
      const rungs = [c.item.ticket?.summary ?? '', primary?.title ?? '', primary?.branch ?? ''];
      if (rungs.some((r) => r !== '')) expect(row.description).not.toBe('');
      if (primary?.createdAt != null) expect(cell(row, 'age')).not.toBe('—');
      if (primary?.repo != null) expect(cell(row, 'repo')).not.toBe('');
      if (primary?.state === 'merged') expect(cell(row, 'prState')).toBe('merged');
      if (primary?.state === 'closed') expect(cell(row, 'prState')).toBe('closed');
      // In the parking lot — where the question is "who is on this?" — somebody is always named:
      // an agent of ours, the human activity line, or the PR's author.
      if (primary?.author != null && (c.list ?? 'parkingLot') === 'parkingLot') {
        expect(cell(row, 'author') ?? cell(row, 'agentPhase') ?? cell(row, 'activity')).toBeDefined();
      }
    }
  });
});
