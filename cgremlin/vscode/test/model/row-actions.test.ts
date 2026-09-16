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
    const offered = rowActions(investigating, 'investigations').map((a) => a.command);
    expect(offered).toContain('cgremlin.startDevelopment');
    expect(offered).not.toContain('cgremlin.startInvestigation');
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
    expect(chat?.reason).toBe(
      'The agent is working on this now — chat opens when it finishes.',
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
