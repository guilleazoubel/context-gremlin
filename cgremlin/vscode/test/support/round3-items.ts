/**
 * The two shapes round 3's expanded block can be WRONG about, as fixtures.
 *
 * `test/support/fixtures/items.json` is a golden fixture: section counts, the row table and the
 * tree order are all pinned against it, so a row added there ripples through a dozen tests that
 * are not about this. These two are built here instead, and both are real shapes:
 *
 *  - a ticket carrying TWO pull requests — mine, and a teammate's I am reviewing — where the
 *    most recently updated one (which is `prs[0]`, ordered by the core) is NOT the one the
 *    review is about;
 *  - an item whose investigation AND whose review have both finished, so two parts each offer a
 *    `primary`-placed "Read the …".
 */
import type { WorkItem, WorkItemAgent, WorkItemPr } from '../../src/model/work-items';

export function pr(over: Partial<WorkItemPr> & { number: number }): WorkItemPr {
  return {
    repo: 'acme/web',
    url: `https://github.com/acme/web/pull/${over.number}`,
    title: `PR ${over.number}`,
    author: 'dtorres',
    branch: null,
    isDraft: false,
    isMine: false,
    reviewDecision: null,
    humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
    reviewRequests: null,
    teamActivity: null,
    updatedAt: '2026-09-20T10:00:00.000Z',
    createdAt: '2026-09-18T10:00:00.000Z',
    changedFiles: 14,
    additions: 455,
    deletions: 51,
    ci: 'success',
    labels: null,
    sizeTier: 'L',
    state: 'open',
    newCommits: null,
    ...over,
  } as WorkItemPr;
}

export function agent(over: Partial<WorkItemAgent> & { sessionId: string }): WorkItemAgent {
  return {
    repo: 'acme/web',
    mode: 'review',
    phase: 'ready',
    running: false,
    needsYou: true,
    claimed: false,
    primaryArtifact: 'REVIEW.md',
    worktreePath: `/wt/${over.sessionId}`,
    ref: `session:${over.sessionId}`,
    pr: null,
    ...over,
  } as WorkItemAgent;
}

function item(over: Partial<WorkItem>): WorkItem {
  return {
    id: 'ticket:HB-1555',
    kind: 'pr+ticket',
    lists: ['myWork'],
    demoted: false,
    parkingLotGroup: null,
    title: 'HB-1555 — Register the signup lambda',
    ticket: {
      key: 'HB-1555',
      summary: 'Register the signup lambda',
      status: 'In Review',
      statusCategory: 'In Progress',
      url: 'https://jira.invalid/browse/HB-1555',
      assignee: 'me',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
    needsYou: true,
    attention: { reasons: ['review_ready'], since: '', acked: false, refs: [] },
    dismissed: false,
    dismissedAt: null,
    ...over,
  } as WorkItem;
}

/**
 * Two pull requests, most-recently-updated first (the core's own order). The REVIEW is about the
 * second one — the teammate's — and it is the stale one; `prs[0]` is mine and says nothing.
 */
export function twoPullRequests(over: { reviewedPrInList?: boolean } = {}): WorkItem {
  const mine = pr({ number: 500, isMine: true, updatedAt: '2026-09-22T09:00:00.000Z', newCommits: null });
  const reviewed = pr({
    number: 2140,
    isMine: false,
    author: 'dtorres',
    updatedAt: '2026-09-19T09:00:00.000Z',
    newCommits: true,
    changedFiles: 3,
    additions: 20,
    deletions: 4,
    sizeTier: 'S',
    ci: 'failure',
  });
  return item({
    prs: over.reviewedPrInList === false ? [mine] : [mine, reviewed],
    agents: [agent({ sessionId: 'rev-2140', mode: 'review', pr: { repo: 'acme/web', number: 2140 } })],
  });
}

/** An investigation that finished, and a review of the resulting PR that finished after it. */
export function twoFinishedStages(): WorkItem {
  return item({
    prs: [pr({ number: 2140, isMine: true, newCommits: false })],
    agents: [
      agent({
        sessionId: 'inv-1',
        mode: 'investigation',
        phase: 'ready',
        needsYou: false,
        primaryArtifact: 'FINDINGS.md',
        pr: null,
      }),
      agent({
        sessionId: 'rev-1',
        mode: 'review',
        phase: 'ready',
        primaryArtifact: 'REVIEW.md',
        pr: { repo: 'acme/web', number: 2140 },
      }),
    ],
  });
}
