/**
 * Defect 3 — a claim the user takes without knowing, cannot see, and cannot give back.
 *
 * Opening Chat claims the agent conversation for ten minutes (R20), which is RIGHT: it is what
 * stops an agent writing underneath a human mid-conversation. What was wrong is everything
 * around it. The row said nothing, so forty-three seconds later `Continue to plan` came back with
 * `Session '…': a human holds the agent conversation; release it before running a stage` — and
 * the only thing that could have cleared it, `POST /sessions/:id/conversation/release`, had no
 * button anywhere in the extension.
 *
 * So: the claim is a state the row SAYS, and releasing it is a verb — from `row-actions`, like
 * every other verb, so both surfaces can offer it and neither can invent it.
 */
import { describe, expect, it } from 'vitest';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import { CLAIM_HELD_TEXT, rowMetaCells } from '../../src/model/row-composition';
import type { RowMetaCell, WorkItem, WorkListKind } from '../../src/model/work-items';
import { CLAIMED_SESSION_ID, claimedSession, killedSession } from '../support/real-sessions';

const NOW = Date.parse('2026-09-22T14:00:00.000Z');
const PARTS = { age: '2m', size: '—', tier: '', activity: '', repo: '' };
const RELEASE = 'cgremlin.releaseConversation';

const texts = (item: WorkItem): string[] =>
  rowMetaCells(item, 'investigations', PARTS, NOW).map((cell: RowMetaCell) => cell.text);

function partsOf(item: WorkItem, list: WorkListKind = 'investigations') {
  const facts = itemActionFacts(item);
  return itemParts({
    item,
    list,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions: rowActions(facts, list),
    now: NOW,
  });
}

describe('holding the conversation is visible', () => {
  it('says so on the row, over the phase the session is parked in', () => {
    const cells = texts(claimedSession());
    expect(cells).toContain(`∴ ${CLAIM_HELD_TEXT}`);
    expect(cells).not.toContain('∴ findings');
  });

  it('outranks even a live run — the claim is what will refuse the next stage', () => {
    const item = claimedSession();
    item.agents[0].running = true;
    expect(texts(item)).toContain(`∴ ${CLAIM_HELD_TEXT}`);
  });

  it('says nothing of the sort about a session nobody holds', () => {
    expect(texts(killedSession()).join(' ')).not.toContain(CLAIM_HELD_TEXT);
  });
});

describe('releasing it is reachable', () => {
  it('offers the release as a verb of the row, addressed at the session that holds it', () => {
    const item = claimedSession();
    const action = rowActions(itemActionFacts(item), 'investigations').find(
      (candidate) => candidate.command === RELEASE,
    );
    expect(action?.label).toBe('Release the conversation');
    expect(action?.childId).toBe(`agent:${CLAIMED_SESSION_ID}`);
    expect(action?.placement).not.toBe('overflow');
  });

  it('puts it on the part for that very session, beside the work it is blocking', () => {
    const part = partsOf(claimedSession()).find((candidate) => candidate.kind === 'investigation');
    expect(part?.actions.map((action) => action.command)).toContain(RELEASE);
  });

  it('is not offered at all where no claim is held', () => {
    const commands = rowActions(itemActionFacts(killedSession()), 'investigations').map(
      (action) => action.command,
    );
    expect(commands).not.toContain(RELEASE);
  });

  it('is offered on every list a claimed session can appear in', () => {
    const item = claimedSession();
    for (const list of ['myWork', 'waitingForReview', 'parkingLot'] as WorkListKind[]) {
      const commands = rowActions(itemActionFacts(item), list).map((action) => action.command);
      expect(commands, list).toContain(RELEASE);
    }
  });
});
