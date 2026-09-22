/**
 * The two sessions the user actually hit, as fixtures.
 *
 * Built by hand rather than added to `items.json`, because both are SESSION items in the
 * `investigations` list and appending one there moves every count the panel fixtures assert.
 *
 *  - `killedSession()` is `inv-aplaceformom-grace-frontend-no-ticket-20260916-211103`: the run was
 *    killed mid-findings (exit 143), the engine's own `lastRun.outcome` is `stopped`, and the only
 *    files in the session directory are AGENT_NOTE, AGENT_STATE, BRIEF.md and session.json — so
 *    `pickPrimaryArtifact` falls through to `WORK_FALLBACK` and the wire carries `BRIEF.md`.
 *  - `claimedSession()` is a session whose agent conversation a human holds right now (the claim
 *    `ChatSessions.open` takes, ten minutes on the engine's clock), which is the state that
 *    refuses every stage until somebody gives it back.
 */
import type { WorkItem, WorkItemAgent } from '../../src/model/work-items';

export const KILLED_SESSION_ID = 'inv-aplaceformom-grace-frontend-no-ticket-20260916-211103';
export const CLAIMED_SESSION_ID = 'inv-aplaceformom-grace-frontend-HB-1492-20260922-135058';

function sessionItem(agent: WorkItemAgent): WorkItem {
  return {
    id: `session:${agent.sessionId}`,
    kind: 'session',
    lists: ['investigations'],
    demoted: false,
    parkingLotGroup: null,
    title: agent.sessionId,
    prs: [],
    ticket: null,
    agents: [agent],
    needsYou: false,
    attention: {
      reasons: [],
      since: '2026-09-16T21:11:06.994Z',
      acked: false,
      refs: [`session:${agent.sessionId}`],
    },
    dismissed: false,
    dismissedAt: null,
    qaAttempt: null,
    qaDeploy: null,
  };
}

/** Exactly the `/items` entry the live engine (build c032b508455986b5) serves for it. */
export function killedSession(): WorkItem {
  return sessionItem({
    sessionId: KILLED_SESSION_ID,
    repo: 'aplaceformom/grace-frontend',
    mode: 'investigation',
    phase: 'findings',
    running: false,
    runFailed: false,
    needsYou: false,
    claimed: false,
    primaryArtifact: 'BRIEF.md',
    worktreePath: `/tmp/cgremlin-fixture/worktrees/${KILLED_SESSION_ID}`,
    pr: null,
    ref: `session:${KILLED_SESSION_ID}`,
    qaVerdict: null,
    runOutcome: 'stopped',
  });
}

/** The same shape, still holding its human turn and with its findings written. */
export function claimedSession(): WorkItem {
  return sessionItem({
    sessionId: CLAIMED_SESSION_ID,
    repo: 'aplaceformom/grace-frontend',
    mode: 'investigation',
    phase: 'findings',
    running: false,
    runFailed: false,
    needsYou: false,
    claimed: true,
    primaryArtifact: 'FINDINGS.md',
    worktreePath: `/tmp/cgremlin-fixture/worktrees/${CLAIMED_SESSION_ID}`,
    pr: null,
    ref: `session:${CLAIMED_SESSION_ID}`,
    qaVerdict: null,
    runOutcome: 'succeeded',
  });
}
