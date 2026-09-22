/**
 * Task 3 — "allow me to start a review anytime i want against qa once available".
 *
 * The standard this flow keeps failing: a verb either does what it names, or says in a sentence
 * why it cannot. Phase 18 already got most of the way — a gate that fails draws the verb DISABLED
 * with one actionable sentence — but two paths still withdrew it in silence, and both of them are
 * paths the user lands on:
 *
 *  - a verification ALREADY RUNNING. `pushQa` returned before the gate was even asked, so the row
 *    with a live verification on it offered nothing and explained nothing;
 *  - merged work with no Jira ticket. The engine needs a ticket for the session's lineage, and
 *    the gate answered `hidden` — the same silence as an item nobody ever proposed for QA.
 *
 * One silence is left, deliberately: an item that is in no QA status and has merged nothing is
 * not a QA failure, and drawing a disabled QA verb on every row in the panel would be noise.
 */
import { describe, expect, it } from 'vitest';
import {
  QA_NOTHING_MERGED_REASON,
  QA_NO_PR_REASON,
  QA_NO_TICKET_REASON,
  QA_RUNNING_REASON,
  QA_UNREACHABLE_REASON,
  itemActionFacts,
  qaNoEnvironmentReason,
  rowActions,
  type RowAction,
} from '../../src/model/row-actions';
import { hb1490, qaAgent, QA_REPOS, QA_STATUSES } from '../support/hb-1490';
import type { WorkItem } from '../../src/model/work-items';

function verbs(item: WorkItem, qaRepos: readonly string[] = QA_REPOS): RowAction[] {
  return rowActions(itemActionFacts(item, qaRepos, QA_STATUSES), 'myWork');
}

function verify(item: WorkItem, qaRepos: readonly string[] = QA_REPOS): RowAction | undefined {
  return verbs(item, qaRepos).find((action) => action.command === 'cgremlin.verifyInQa');
}

describe('the verb is offered wherever a verification can actually be started', () => {
  it('offers it, live, on the user’s real HB-1490: merged, in a QA repo, verified before', () => {
    const action = verify(hb1490());
    expect(action?.label).toBe('Verify in QA again');
    expect(action?.enabled).not.toBe(false);
  });
});

describe('and where it cannot be, it is disabled WITH a sentence — never withheld', () => {
  it('a verification already running says so, instead of offering nothing at all', () => {
    const live = hb1490({ agents: [qaAgent({ phase: 'verifying', running: true, qaVerdict: null })] });
    expect(verify(live)).toMatchObject({ enabled: false, reason: QA_RUNNING_REASON });
  });

  it('merged work with no ticket says which link the engine is missing', () => {
    const orphan = hb1490({ ticket: null });
    expect(verify(orphan)).toMatchObject({ enabled: false, reason: QA_NO_TICKET_REASON });
  });

  it('nothing merged yet says QA verifies code that has landed', () => {
    const open = hb1490({ prs: [{ ...hb1490().prs[0], state: 'open' }] as WorkItem['prs'] });
    expect(verify(open)).toMatchObject({ enabled: false, reason: QA_NOTHING_MERGED_REASON });
  });

  it('no pull request at all offers the search that would find one', () => {
    const none = hb1490({ prs: [], agents: [] });
    expect(verify(none)).toMatchObject({ enabled: false, reason: QA_NO_PR_REASON });
    expect(verbs(none).map((a) => a.command)).toContain('cgremlin.discoverPrs');
  });

  it('a repo with no QA url names the config key and opens the file', () => {
    const missing = verify(hb1490(), []);
    expect(missing).toMatchObject({
      enabled: false,
      reason: qaNoEnvironmentReason('aplaceformom/grace-frontend'),
    });
    expect(verbs(hb1490(), []).map((a) => a.command)).toContain('cgremlin.openCoreConfig');
  });

  it('a QA the last attempt could not reach says QA is unreachable', () => {
    const down = hb1490({ qaAttempt: { outcome: 'unreachable', at: '' } } as never);
    expect(verify(down)).toMatchObject({ enabled: false, reason: QA_UNREACHABLE_REASON });
  });

  it('never as the row’s one click: a disabled control is never the primary', () => {
    const live = hb1490({ agents: [qaAgent({ phase: 'verifying', running: true, qaVerdict: null })] });
    expect(verify(live)?.placement).not.toBe('primary');
  });
});

describe('the one silence that stays', () => {
  it('says nothing on an item nobody has proposed for QA', () => {
    const idle = hb1490({
      prs: [],
      agents: [],
      qaDeploy: null,
      ticket: { ...hb1490().ticket, status: 'In Progress' } as WorkItem['ticket'],
    });
    expect(verify(idle)).toBeUndefined();
  });
});
