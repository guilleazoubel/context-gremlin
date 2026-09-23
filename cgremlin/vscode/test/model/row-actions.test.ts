/**
 * P0-2 — the actions a row offers are a rule about the LIST it is in, not about the item alone.
 *
 * The defect this pins: `actionsFor` took no list and pushed `Start investigation` and
 * `Start development` on every row of every list (`panel-view.ts:372-373`), plus an unconditional
 * `Ack` (`:388`). One table-driven test per cell of the workshop's §3.4 rule table, plus the
 * forward-only stage ladder the design amendment added.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_BUSY_REASON,
  DEVELOPMENT_NEEDS_APPROVAL_REASON,
  furthestStage,
  itemActionFacts,
  nextStages,
  rowActions,
  rowActionsForLists,
  type ActionFacts,
} from '../../src/model/row-actions';
import type { ItemsResponse, WorkItem, WorkListKind } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

function fixture(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

function itemOf(id: string): WorkItem {
  const found = fixture().items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no fixture item ${id}`);
  return found;
}

function commands(item: WorkItem, list: WorkListKind): string[] {
  return rowActions(itemActionFacts(item), list).map((a) => a.command);
}

function facts(over: Partial<ActionFacts> = {}): ActionFacts {
  return { agents: [], prs: [], ticketKey: null, needsYou: false, ...over };
}

const agent = (mode: string, over: Record<string, unknown> = {}) => ({
  sessionId: `s-${mode}`,
  mode,
  phase: 'running',
  running: false,
  claimed: false,
  ...over,
});

const teammatePr = { repo: 'acme/web', number: 1, isMine: false, isDraft: false };
const myPr = { repo: 'acme/web', number: 2, isMine: true, isDraft: false };

// ---------------------------------------------------------------------------

describe('P0-2 the hard list: what may never be offered', () => {
  it('never offers Start development or Start investigation on a parking-lot row', () => {
    for (const id of ['pr:acme/web#101', 'pr:acme/web#102', 'pr:acme/api#55', 'pr:acme/legacy#9']) {
      const offered = commands(itemOf(id), 'parkingLot');
      expect(offered, id).not.toContain('cgremlin.startDevelopment');
      expect(offered, id).not.toContain('cgremlin.startInvestigation');
    }
  });

  it('never offers Start development or Start investigation on a waiting-for-review row', () => {
    for (const id of ['pr:acme/web#200', 'ticket:HB-627', 'pr:acme/api#77']) {
      const offered = commands(itemOf(id), 'waitingForReview');
      expect(offered, id).not.toContain('cgremlin.startDevelopment');
      expect(offered, id).not.toContain('cgremlin.startInvestigation');
    }
  });

  it('never offers Start investigation anywhere a PR exists (R49)', () => {
    for (const list of ['parkingLot', 'myWork', 'investigations', 'waitingForReview'] as const) {
      for (const item of fixture().items.filter((i) => i.prs.length > 0)) {
        expect(commands(item, list), `${item.id}/${list}`).not.toContain(
          'cgremlin.startInvestigation',
        );
      }
    }
  });

  it('never offers a second Start review when a review agent already exists', () => {
    const withReview = facts({ prs: [teammatePr], agents: [agent('review')] });
    expect(rowActions(withReview, 'parkingLot').map((a) => a.command)).not.toContain(
      'cgremlin.startReview',
    );
  });

  it('offers Ack only where the item needs you', () => {
    for (const list of ['parkingLot', 'myWork', 'investigations', 'waitingForReview'] as const) {
      for (const item of fixture().items) {
        const offered = commands(item, list);
        expect(offered.includes('cgremlin.ack'), `${item.id}/${list}`).toBe(item.needsYou);
      }
    }
  });
});

describe('P0-2 §3.4 — the parking lot', () => {
  it('offers Start review as the primary on a teammate PR with no review agent', () => {
    const actions = rowActions(itemActionFacts(itemOf('pr:acme/web#101')), 'parkingLot');
    const start = actions.find((a) => a.command === 'cgremlin.startReview');
    expect(start?.placement).toBe('primary');
    expect(actions.map((a) => a.command)).toEqual([
      'cgremlin.startReview',
      'cgremlin.openPr',
    ]);
  });

  it('never offers Start review on my own PR', () => {
    expect(rowActions(facts({ prs: [myPr] }), 'parkingLot').map((a) => a.command)).not.toContain(
      'cgremlin.startReview',
    );
  });

  it('falls back to Chat as the primary once a review agent is on it', () => {
    const actions = rowActions(itemActionFacts(itemOf('pr:acme/web#102')), 'parkingLot');
    expect(actions.find((a) => a.placement === 'primary')?.command).toBe('cgremlin.chat');
    expect(actions.find((a) => a.command === 'cgremlin.chat')?.childId).toBe(
      'agent:pr-acme-web-102',
    );
  });

  it('puts Open PR and Open ticket in the overflow', () => {
    const withTicket = facts({ prs: [teammatePr], ticketKey: 'HB-1' });
    const actions = rowActions(withTicket, 'parkingLot');
    expect(actions.find((a) => a.command === 'cgremlin.openPr')?.placement).toBe('overflow');
    expect(actions.find((a) => a.command === 'cgremlin.openTicket')?.placement).toBe('overflow');
  });
});

describe('P0-2 §3.4 — waiting for review', () => {
  it('offers Address review comments as the primary on my own non-draft PR with no respond agent', () => {
    const actions = rowActions(facts({ prs: [myPr] }), 'waitingForReview');
    expect(actions.find((a) => a.placement === 'primary')?.command).toBe(
      'cgremlin.addressReview',
    );
  });

  it('offers none of it on a draft, or on a PR that is not mine', () => {
    const draft = rowActions(facts({ prs: [{ ...myPr, isDraft: true }] }), 'waitingForReview');
    expect(draft.map((a) => a.command)).not.toContain('cgremlin.addressReview');
    const theirs = rowActions(facts({ prs: [teammatePr] }), 'waitingForReview');
    expect(theirs.map((a) => a.command)).not.toContain('cgremlin.addressReview');
  });

  it('hands the primary to Chat once the respond agent is past triaging (R50)', () => {
    const triaging = facts({
      prs: [myPr],
      agents: [agent('respond', { phase: 'triaging', running: true })],
    });
    expect(rowActions(triaging, 'waitingForReview').map((a) => a.command)).not.toContain(
      'cgremlin.chat',
    );
    expect(rowActions(triaging, 'waitingForReview').map((a) => a.command)).not.toContain(
      'cgremlin.addressReview',
    );
    const addressing = facts({
      prs: [myPr],
      agents: [agent('respond', { phase: 'addressing' })],
    });
    const actions = rowActions(addressing, 'waitingForReview');
    expect(actions.find((a) => a.placement === 'primary')?.command).toBe('cgremlin.chat');
  });

  it('falls back to Open PR as the primary on a quiet row', () => {
    const quiet = facts({
      prs: [myPr],
      agents: [agent('respond', { phase: 'triaging', running: true })],
    });
    expect(rowActions(quiet, 'waitingForReview').find((a) => a.placement === 'primary')?.command).toBe(
      'cgremlin.openPr',
    );
  });
});

describe('P0-2 the forward-only stage ladder (design amendment §4)', () => {
  it('reads the furthest stage reached, counting a PR as the development stage', () => {
    expect(furthestStage(facts())).toBe('none');
    expect(furthestStage(facts({ agents: [agent('investigation')] }))).toBe('investigation');
    expect(furthestStage(facts({ prs: [myPr] }))).toBe('development');
    expect(furthestStage(facts({ agents: [agent('development')] }))).toBe('development');
    expect(
      furthestStage(facts({ agents: [agent('investigation'), agent('review')] })),
    ).toBe('review');
    // A respond agent is not a stage of its own — it answers the review.
    expect(furthestStage(facts({ agents: [agent('respond')] }))).toBe('none');
  });

  it('offers only the stage after the furthest one reached', () => {
    expect(nextStages(facts())).toEqual(['investigation', 'development']);
    expect(nextStages(facts({ agents: [agent('investigation')] }))).toEqual(['development']);
    expect(nextStages(facts({ agents: [agent('development')] }))).toEqual(['review']);
    expect(nextStages(facts({ agents: [agent('review')] }))).toEqual([]);
  });

  it('my work, ticket only and no agent: Start development is the primary, investigation the spare', () => {
    const ticketOnly = facts({ ticketKey: 'HB-9' });
    const actions = rowActions(ticketOnly, 'myWork');
    expect(actions.find((a) => a.placement === 'primary')?.command).toBe(
      'cgremlin.startDevelopment',
    );
    expect(actions.find((a) => a.command === 'cgremlin.startInvestigation')?.placement).toBe(
      'inline',
    );
  });

  it('promotes an investigation to development, and never back to investigation', () => {
    const investigating = facts({ agents: [agent('investigation')] });
    const actions = rowActions(investigating, 'investigations');
    // Phase 21 — the ladder's next rung is still `Start development`; which ROUTE that verb takes
    // is the chaining rule's business, asserted on its own below.
    expect(actions.map((a) => a.label)).toContain('Start development');
    expect(actions.map((a) => a.command)).not.toContain('cgremlin.startInvestigation');
  });

  it('offers a self-review once development has produced a PR of mine, and nothing after a review', () => {
    const developed = rowActions(facts({ prs: [myPr] }), 'myWork');
    const selfReview = developed.find((a) => a.command === 'cgremlin.startReview');
    expect(selfReview?.label).toBe('Start self-review');
    expect(selfReview?.placement).toBe('primary');
    const reviewed = rowActions(
      facts({ prs: [myPr], agents: [agent('review')] }),
      'myWork',
    ).map((a) => a.command);
    expect(reviewed).not.toContain('cgremlin.startReview');
    expect(reviewed).not.toContain('cgremlin.startDevelopment');
  });
});

describe('P0-2 the Item tab shares the rule', () => {
  it('takes the union over the lists the item is in, keeping one primary', () => {
    const item = itemOf('ticket:HB-627');
    const union = rowActionsForLists(itemActionFacts(item), item.lists);
    expect(union.filter((a) => a.placement === 'primary')).toHaveLength(1);
    // In `waitingForReview` it earns Address review comments; in `myWork` nothing earlier.
    expect(union.map((a) => a.command)).toContain('cgremlin.addressReview');
    expect(union.map((a) => a.command)).not.toContain('cgremlin.startInvestigation');
  });

  it('offers nothing list-scoped for an item that is in no list at all', () => {
    const orphan = rowActionsForLists(facts({ prs: [teammatePr] }), []);
    expect(orphan.map((a) => a.command)).toEqual(['cgremlin.openPr']);
  });

  it('never repeats an action the union saw twice', () => {
    const item = itemOf('pr:acme/api#77');
    const union = rowActionsForLists(itemActionFacts(item), item.lists);
    const keys = union.map((a) => `${a.command}:${a.childId ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * Phase 19 — the user's actual complaint: an investigation was genuinely in flight, he clicked
 * Chat, and the engine answered the raw sentence `session '…' already has a stage run in
 * progress` — no explanation, no next step ("I cant do anything"). The refusal was correct; the
 * silence was the bug. Chat must never reach the engine for this case at all: it is disabled,
 * with a sentence the user can act on, using the same disabled + `reason` mechanism the QA verbs
 * already use (`aria-describedby` is wired generically off `enabled === false` — see
 * `webview/panel/expanded.ts`).
 */
describe('P0-2 — Chat while a run is live on the target session', () => {
  it('disables Chat, with the exact sentence, while its target session is running', () => {
    const running = facts({
      prs: [teammatePr],
      agents: [agent('review', { running: true })],
    });
    const chat = rowActions(running, 'parkingLot').find((a) => a.command === 'cgremlin.chat');
    expect(chat?.enabled).toBe(false);
    // Defect 4 — the sentence ends with the way through it can offer, because reading a run is
    // not interrupting it. Defect 5 — it now names the rule as well: the agent cannot be
    // answered mid-run, it stops and asks when it needs the human, and Stop keeps the work
    // already on disk. The refusal itself is unchanged: Chat is still disabled.
    expect(chat?.reason).toBe(
      'The agent is working on this now and cannot be interrupted or answered mid-run. ' +
        'You can watch what it is doing; if it needs you it stops and asks, and chat opens here ' +
        'with the full history. Stop ends the run and keeps whatever it has already written to files.',
    );
    expect(chat?.reason).toBe(CHAT_BUSY_REASON);
  });

  it('leaves Chat enabled, with no reason, when nothing is running', () => {
    const idle = facts({
      prs: [teammatePr],
      agents: [agent('review', { running: false })],
    });
    const chat = rowActions(idle, 'parkingLot').find((a) => a.command === 'cgremlin.chat');
    expect(chat?.enabled).toBeUndefined();
    expect(chat?.reason).toBeUndefined();
  });
});

/**
 * Phase 19 — a way forward while an agent works: beside the disabled Chat, `Stop` is offered
 * through the very same rule table (not a second site), on any list the busy agent's row appears
 * in, and disappears the moment nothing is running.
 */
describe('P0-2 — Stop beside a live run', () => {
  it('offers Stop, targeting the running session, while a run is live', () => {
    const running = facts({
      prs: [teammatePr],
      agents: [agent('review', { running: true })],
    });
    const stop = rowActions(running, 'parkingLot').find((a) => a.command === 'cgremlin.stop');
    expect(stop).toBeDefined();
    expect(stop?.childId).toBe('agent:s-review');
  });

  it('offers no Stop when nothing is running', () => {
    const idle = facts({
      prs: [teammatePr],
      agents: [agent('review', { running: false })],
    });
    expect(rowActions(idle, 'parkingLot').map((a) => a.command)).not.toContain('cgremlin.stop');
  });

  it('offers Stop through the Item tab union too', () => {
    const running = facts({
      prs: [myPr],
      agents: [agent('respond', { phase: 'addressing', running: true })],
    });
    const union = rowActionsForLists(running, ['waitingForReview']);
    expect(union.map((a) => a.command)).toContain('cgremlin.stop');
  });
});

// ---------------------------------------------------------------------------

/**
 * The handoff (Phase 21). The engine has had `approve-plan` and `promote` since Phase 2, and the
 * panel reached neither: `approvePlan` was a registered command no row ever offered. "Before i
 * would say to the agent approve and it would start the development session" — this is that
 * sentence, as a button.
 */
describe('the handoff: approving an investigation plan', () => {
  const investigation = (phase: string, over: Record<string, unknown> = {}) =>
    agent('investigation', { phase, ...over });

  it('makes the approve verb the row PRIMARY at plan_ready, and nothing else claims primary', () => {
    const actions = rowActions(facts({ agents: [investigation('plan_ready')] }), 'investigations');
    const approve = actions.find((a) => a.command === 'cgremlin.approvePlan');
    expect(approve).toBeDefined();
    expect(approve?.placement).toBe('primary');
    expect(approve?.label).toBe('Approve the plan');
    // R26: the verb names the session it approves, so a second agent cannot steal the click.
    expect(approve?.childId).toBe('agent:s-investigation');
    expect(actions.filter((a) => a.placement === 'primary')).toHaveLength(1);
  });

  it('offers nothing to approve before the plan is ready', () => {
    for (const phase of ['findings', 'planning', 'approved', 'promoted_to_development']) {
      const offered = rowActions(
        facts({ agents: [investigation(phase)] }),
        'investigations',
      ).map((a) => a.command);
      expect(offered, phase).not.toContain('cgremlin.approvePlan');
    }
  });

  it('never offers it for a non-investigation session at the same phase', () => {
    const offered = rowActions(
      facts({ agents: [agent('development', { phase: 'plan_ready' })] }),
      'myWork',
    ).map((a) => a.command);
    expect(offered).not.toContain('cgremlin.approvePlan');
  });
});

/**
 * The handoff, second half. `cgremlin.startDevelopment` starts a FRESH, self-rooted development
 * session (`POST /items/… {mode:'development'}`), so an item with an investigation behind it lost
 * the plan and the findings on the way over — the user's exact complaint. Where there is an
 * investigation to continue from, the verb keeps its wording and changes its route.
 */
describe('the handoff: Start development continues from the investigation', () => {
  const investigation = (phase: string, over: Record<string, unknown> = {}) =>
    agent('investigation', { phase, ...over });

  it('chains through promote, addressed at the investigation, once its plan is approved', () => {
    const actions = rowActions(facts({ agents: [investigation('approved')] }), 'investigations');
    const start = actions.find((a) => a.label === 'Start development');
    expect(start?.command).toBe('cgremlin.promoteToDevelopment');
    expect(start?.childId).toBe('agent:s-investigation');
    expect(start?.placement).toBe('primary');
    expect(start?.enabled).toBeUndefined();
    // The fresh, self-rooted start is exactly what must NOT be reachable here.
    expect(actions.map((a) => a.command)).not.toContain('cgremlin.startDevelopment');
  });

  it('still starts FRESH when there is no investigation to chain from', () => {
    const actions = rowActions(facts({ ticketKey: 'HB-1' }), 'myWork');
    const start = actions.find((a) => a.label === 'Start development');
    expect(start?.command).toBe('cgremlin.startDevelopment');
    expect(start?.childId).toBeUndefined();
    expect(start?.placement).toBe('primary');
  });

  it('draws the verb DISABLED, never fresh, while the investigation is not approved yet', () => {
    for (const phase of ['findings', 'planning', 'plan_ready']) {
      const actions = rowActions(facts({ agents: [investigation(phase)] }), 'investigations');
      const start = actions.find((a) => a.label === 'Start development');
      expect(start?.command, phase).toBe('cgremlin.promoteToDevelopment');
      expect(start?.enabled, phase).toBe(false);
      expect(start?.reason, phase).toBe(DEVELOPMENT_NEEDS_APPROVAL_REASON);
      expect(start?.placement, phase).not.toBe('primary');
      expect(actions.map((a) => a.command), phase).not.toContain('cgremlin.startDevelopment');
    }
  });

  it('leaves Approve the plan as the one primary at plan_ready', () => {
    const actions = rowActions(facts({ agents: [investigation('plan_ready')] }), 'investigations');
    const primaries = actions.filter((a) => a.placement === 'primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].command).toBe('cgremlin.approvePlan');
  });

  it('withdraws the chained verb while the investigation is mid-run', () => {
    const actions = rowActions(
      facts({ agents: [investigation('approved', { running: true })] }),
      'investigations',
    );
    const start = actions.find((a) => a.label === 'Start development');
    expect(start?.enabled).toBe(false);
  });
});

/**
 * Phase 21 — a finished artifact behind a failed run. The live wedge:
 * `inv-…-HB-1492` has `stageStatus: 'findings'`, `lastRun.outcome: 'failed'` and a complete 30 KB
 * FINDINGS.md. The findings run died AFTER writing its artifact, so the plan stage never chained;
 * the session can never reach `plan_ready`, so nothing in the approve/promote flow can rescue it.
 * `Retry` would re-run the stage that failed — throwing away findings that are already right.
 * The way out is the stage that never ran, against the artifact that is already there.
 */
describe('the handoff: recovering an investigation wedged behind a failed findings run', () => {
  const wedged = (over: Record<string, unknown> = {}) =>
    agent('investigation', {
      phase: 'findings',
      runFailed: true,
      primaryArtifact: 'FINDINGS.md',
      ...over,
    });

  it('offers Continue to plan as the row primary, ahead of Retry', () => {
    const actions = rowActions(facts({ agents: [wedged()] }), 'investigations');
    const resume = actions.find((a) => a.command === 'cgremlin.continueToPlan');
    expect(resume?.label).toBe('Continue to plan');
    expect(resume?.placement).toBe('primary');
    expect(resume?.childId).toBe('agent:s-investigation');
    // Retry survives — re-running findings is still a legitimate ask — but never as the one click.
    const retry = actions.find((a) => a.command === 'cgremlin.retry');
    expect(retry?.placement).toBe('inline');
  });

  it('offers only Retry when the failed run left no findings behind', () => {
    const actions = rowActions(
      facts({ agents: [wedged({ primaryArtifact: null })] }),
      'investigations',
    );
    expect(actions.map((a) => a.command)).not.toContain('cgremlin.continueToPlan');
    expect(actions.find((a) => a.command === 'cgremlin.retry')?.placement).toBe('primary');
  });

  it('offers nothing to continue where the run did not fail, or the stage has moved on', () => {
    for (const over of [{ runFailed: false }, { phase: 'planning' }, { running: true }]) {
      const offered = rowActions(facts({ agents: [wedged(over)] }), 'investigations').map(
        (a) => a.command,
      );
      expect(offered, JSON.stringify(over)).not.toContain('cgremlin.continueToPlan');
    }
  });

  it('never offers it for a development session sitting on the same artifact', () => {
    const offered = rowActions(
      facts({
        agents: [
          agent('development', { phase: 'findings', runFailed: true, primaryArtifact: 'FINDINGS.md' }),
        ],
      }),
      'myWork',
    ).map((a) => a.command);
    expect(offered).not.toContain('cgremlin.continueToPlan');
  });
});

/**
 * An agent may never approve — the helper refuses the event and the brief no longer names it.
 * The approval is the human's, so the human needs a verb for it, and it must read as theirs:
 * the label says "yourself", and it is never the row's one automatic click, because approving
 * before reading the review is exactly the thing being fixed.
 */
describe('the human’s approve verb', () => {
  const reviewed = (over: Record<string, unknown> = {}) =>
    facts({ agents: [agent('review', { phase: 'ready', ...over })], prs: [teammatePr] });

  const approveOf = (f: ActionFacts, list: WorkListKind = 'parkingLot') =>
    rowActions(f, list).find((a) => a.command === 'cgremlin.approvePr');

  it('is offered on a reviewed pull request, and names the approval as the user’s own', () => {
    const action = approveOf(reviewed());
    expect(action).toBeDefined();
    expect(action?.label).toBe('Approve this PR yourself');
  });

  it('is never the row’s primary action', () => {
    for (const list of ['parkingLot', 'myWork', 'waitingForReview'] as WorkListKind[]) {
      const action = approveOf(reviewed(), list);
      if (action === undefined) continue;
      expect(action.placement, list).not.toBe('primary');
    }
  });

  it('is pinned to the review session that reviewed it', () => {
    expect(approveOf(reviewed())?.childId).toBe('agent:s-review');
  });

  it('is not offered before the review is written, nor while it is running', () => {
    for (const over of [{ phase: 'queued' }, { phase: 'reviewing' }, { phase: 'ready', running: true }]) {
      expect(approveOf(reviewed(over)), JSON.stringify(over)).toBeUndefined();
    }
  });

  it('is not offered where no review agent has been near the row', () => {
    expect(approveOf(facts({ prs: [teammatePr] }))).toBeUndefined();
    expect(approveOf(facts({ agents: [agent('development')], prs: [teammatePr] }))).toBeUndefined();
  });

  it('is not offered once the pull request has landed', () => {
    const landed = facts({
      agents: [agent('review', { phase: 'ready' })],
      prs: [{ ...teammatePr, state: 'merged' }],
    });
    expect(approveOf(landed)).toBeUndefined();
  });

  it('is not offered once GitHub already has the approval', () => {
    expect(approveOf(reviewed({ phase: 'approved' }))).toBeUndefined();
  });
});
