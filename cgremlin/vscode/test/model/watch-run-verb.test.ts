/**
 * Defect 4, the verb — the busy Chat refusal stops being a dead end.
 *
 * "i should be able to see the planning chat right?" The refusal was right and the silence was
 * the bug: `already has a stage run in progress` answers "you may not INTERRUPT this", and the
 * user was asking "may I SEE it". Two different rules; one check was answering both.
 *
 * So the disabled Chat now names the thing it CAN offer, and the verb beside it comes from the
 * rule table like every other verb — it was never going to be shipped as a button with nothing
 * behind it, which is the whole standard this flow has been failing.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_BUSY_REASON,
  WATCH_RUN_LABEL,
  itemActionFacts,
  rowActions,
} from '../../src/model/row-actions';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import type { WorkItem, WorkListKind } from '../../src/model/work-items';

const NOW = Date.parse('2026-09-22T14:00:00.000Z');
const SESSION = 'inv-grace-plan';
const WATCH = 'cgremlin.watchRun';

function item(running: boolean): WorkItem {
  return {
    id: `session:${SESSION}`,
    kind: 'session',
    lists: ['investigations'],
    demoted: false,
    parkingLotGroup: null,
    title: SESSION,
    prs: [],
    ticket: null,
    agents: [
      {
        sessionId: SESSION, mode: 'investigation', phase: 'plan', running, claimed: false,
        runFailed: false, needsYou: false, primaryArtifact: null, worktreePath: null,
        ref: `session:${SESSION}`, qaVerdict: null,
        lastRun: { stage: 'plan', startedAt: '2026-09-22T13:52:00.000Z' },
      },
    ],
    needsYou: false,
    attention: { reasons: [], since: '2026-09-22T13:52:00.000Z', acked: false, refs: [] },
    dismissed: false,
    dismissedAt: null,
  } as WorkItem;
}

const actionsOf = (running: boolean, list: WorkListKind = 'investigations') =>
  rowActions(itemActionFacts(item(running)), list);

describe('a run in flight offers the watch it CAN give', () => {
  it('draws the verb beside the Chat it had to refuse, at the session that is running', () => {
    const actions = actionsOf(true);
    const chat = actions.find((action) => action.command === 'cgremlin.chat');
    const watch = actions.find((action) => action.command === WATCH);
    // The refusal itself is untouched: Chat stays disabled while a run is live.
    expect(chat?.enabled).toBe(false);
    expect(watch?.label).toBe(WATCH_RUN_LABEL);
    expect(watch?.childId).toBe(`agent:${SESSION}`);
    expect(watch?.enabled).not.toBe(false);
  });

  it('says so in the refusal, rather than naming a way through the user has to find', () => {
    expect(CHAT_BUSY_REASON).toMatch(/watch/i);
  });

  it('is not offered when nothing is running — there is nothing to watch', () => {
    expect(actionsOf(false).map((action) => action.command)).not.toContain(WATCH);
  });

  it('is offered on every list a running session can appear in', () => {
    for (const list of ['myWork', 'investigations', 'parkingLot', 'waitingForReview'] as WorkListKind[]) {
      expect(actionsOf(true, list).map((action) => action.command), list).toContain(WATCH);
    }
  });

  it('reaches the stage part, beside the work it is about', () => {
    const one = item(true);
    const facts = itemActionFacts(one);
    const parts = itemParts({
      item: one,
      list: 'investigations',
      slots: lifecycleSlots({ agents: one.agents, facts, now: NOW }),
      actions: rowActions(facts, 'investigations'),
      now: NOW,
    });
    const investigation = parts.find((part) => part.kind === 'investigation');
    expect(investigation?.actions.map((action) => action.command)).toContain(WATCH);
  });
});
