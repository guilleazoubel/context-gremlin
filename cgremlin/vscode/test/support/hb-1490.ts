/**
 * The live item this work is about, as `GET /items` really sent it on 22 Sep 2026.
 *
 * HB-1490 is the user's own case: a Jira ticket, ONE merged pull request, and a `qa` agent that
 * has verified the change four times against four successive QA builds. Every field below was
 * copied off the running engine's socket — nothing here is invented, so a test that passes
 * against it is a test that passes against his screen.
 */
import type { WorkItem, WorkItemAgent } from '../../src/model/work-items';

export const QA_REPOS = ['aplaceformom/grace-frontend', 'aplaceformom/grace'] as const;
export const QA_STATUSES = ['QA', 'UAT', 'Ready for QA'] as const;

export function qaAgent(over: Partial<WorkItemAgent> = {}): WorkItemAgent {
  return {
    sessionId: 'qa-grace-frontend-HB-1490-20260915-200744',
    repo: 'aplaceformom/grace-frontend',
    mode: 'qa',
    phase: 'ready',
    running: false,
    runFailed: false,
    needsYou: false,
    claimed: false,
    primaryArtifact: 'QA.md',
    worktreePath: '/tmp/worktrees/qa-grace-frontend-HB-1490-20260915-200744',
    pr: { repo: 'aplaceformom/grace-frontend', number: 2037 },
    ref: 'session:qa-grace-frontend-HB-1490-20260915-200744',
    qaVerdict: 'ready',
    runOutcome: 'succeeded',
    ...over,
  };
}

export function hb1490(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'ticket:HB-1490',
    kind: 'pr+ticket',
    lists: ['myWork'],
    demoted: false,
    parkingLotGroup: null,
    title:
      'HB-1490 — Fetch Care Guide content through the Grace backend and reshape it to the guide contract',
    prs: [
      {
        repo: 'aplaceformom/grace-frontend',
        number: 2037,
        url: 'https://github.com/aplaceformom/grace-frontend/pull/2037',
        title: 'feat(HB-1490): fetch Care Guide content through Grace and reshape to GuideContent',
        author: 'guilleazoubel',
        branch: 'feature/HB-1490',
        isDraft: false,
        isMine: null,
        reviewDecision: null,
        humanActivity: null,
        reviewRequests: null,
        teamActivity: null,
        updatedAt: null,
        createdAt: '2026-09-09T17:13:03Z',
        changedFiles: 14,
        additions: 4684,
        deletions: 0,
        ci: null,
        labels: ['30 min review'],
        sizeTier: 'XL',
        state: 'merged',
        newCommits: null,
      },
    ],
    ticket: {
      key: 'HB-1490',
      summary:
        'Fetch Care Guide content through the Grace backend and reshape it to the guide contract',
      status: 'UAT',
      statusCategory: 'indeterminate',
      url: 'https://aplaceformom.atlassian.net/browse/HB-1490',
      assignee: '712020:f0acd024',
      updatedAt: '',
    },
    agents: [qaAgent()],
    needsYou: false,
    dismissed: false,
    dismissedAt: null,
    attention: {
      reasons: [],
      since: '2026-09-15T20:07:44.425Z',
      acked: false,
      refs: ['session:qa-grace-frontend-HB-1490-20260915-200744'],
    },
    qaAttempt: null,
    qaDeploy: { state: 'verified', sha: '0853456d769639e7cafd9ddd7fbbc99c14575409' },
    ...over,
  } as unknown as WorkItem;
}
