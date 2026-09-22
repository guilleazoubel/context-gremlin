/**
 * Phase 12 item 1, the half the user drives — `cgremlin.renameItem`.
 *
 * "We should be able to see the title or to create a title for it." The derived chain answers the
 * first half; this is the second. The name is the user's, so it wins over everything derived, it
 * is marked as his on the row, and an empty input gives the derived line back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeHarnesses, panelHarness } from '../support/panel-harness';
import { titleStateKey } from '../../src/model/item-title';
import { fixtures } from '../support/stub-server';

const PARKING_ITEM = 'pr:acme/web#101';
const HB_ITEM = 'ticket:HB-627';

afterEach(disposeHarnesses);

describe('item 1 — the title the user writes', () => {
  it('draws the derived description, and says it is not the user’s', async () => {
    const h = await panelHarness();
    const row = h.rowOf(PARKING_ITEM);
    expect(row?.description).toBe('Add the retry budget');
    expect(row?.descriptionIsOwn).toBe(false);
  });

  it('offers renaming in the disclosure of every row, named by its effect', async () => {
    const h = await panelHarness();
    expect(h.rowOf(PARKING_ITEM)?.actions).toContainEqual({
      command: 'cgremlin.renameItem',
      label: 'Rename this item',
      placement: 'overflow',
    });
  });

  it('puts the user’s title on L2 in place of the derived one, marked as his', async () => {
    const h = await panelHarness();
    h.host.inputBoxAnswers.push('The retry budget nobody owns');
    await h.host.invoke('cgremlin.renameItem', PARKING_ITEM);

    const row = h.rowOf(PARKING_ITEM);
    expect(row?.description).toBe('The retry budget nobody owns');
    expect(row?.descriptionIsOwn).toBe(true);
    // The row's accessible name says whose title it is, because the mark beside it is a glyph.
    expect(row?.label).toBe('#101 — The retry budget nobody owns (your title)');
  });

  it('offers the current title back for editing, and the derived one as the placeholder', async () => {
    const h = await panelHarness();
    h.host.inputBoxAnswers.push('Inbox, second attempt');
    await h.host.invoke('cgremlin.renameItem', HB_ITEM);
    h.host.inputBoxAnswers.push(undefined);
    await h.host.invoke('cgremlin.renameItem', HB_ITEM);

    const options = h.host.callsOf('showInputBox').at(-1)?.args[0] as {
      value?: string;
      placeHolder?: string;
    };
    expect(options.value).toBe('Inbox, second attempt');
    expect(options.placeHolder).toBe('Caregiver inbox reshuffle');
    // A cancelled input changes nothing at all.
    expect(h.rowOf(HB_ITEM)?.description).toBe('Inbox, second attempt');
  });

  it('restores the derived description when the user empties the input', async () => {
    const h = await panelHarness();
    h.host.inputBoxAnswers.push('Inbox, second attempt');
    await h.host.invoke('cgremlin.renameItem', HB_ITEM);
    h.host.inputBoxAnswers.push('');
    await h.host.invoke('cgremlin.renameItem', HB_ITEM);

    const row = h.rowOf(HB_ITEM);
    expect(row?.description).toBe('Caregiver inbox reshuffle');
    expect(row?.descriptionIsOwn).toBe(false);
  });

  it('keeps the title when the item gains a ticket and changes its id', async () => {
    // The next scan links that PR to a ticket: a new id, a new title, the same work. The PR ref
    // is the one name that did not move, and the override is keyed by it.
    const linked = { yet: false };
    const h = await panelHarness({
      handler: (request) => {
        if (request.method !== 'GET' || request.path !== '/items' || !linked.yet) return undefined;
        return { status: 200, body: withTicket() };
      },
    });
    h.host.inputBoxAnswers.push('The retry budget nobody owns');
    await h.host.invoke('cgremlin.renameItem', PARKING_ITEM);

    linked.yet = true;
    h.ui.handleFrame({ event: 'items.changed', data: {} });
    await h.settle();

    const row = h.rowOf('ticket:HB-900');
    expect(row?.description).toBe('The retry budget nobody owns');
    expect(row?.descriptionIsOwn).toBe(true);
    expect(h.host.getState<string>(titleStateKey('pr:acme/web#101'))).toBe(
      'The retry budget nobody owns',
    );
  });
});

/** The fixture, with `pr:acme/web#101` re-keyed as the ticket the scan has just linked it to. */
function withTicket(): unknown {
  const body = JSON.parse(JSON.stringify(fixtures.items)) as {
    items: { id: string; kind: string; ticket: unknown; title: string }[];
    lists: { parkingLot: { untouched: string[] } };
  };
  const item = body.items.find((candidate) => candidate.id === PARKING_ITEM);
  if (item === undefined) throw new Error('fixture');
  item.id = 'ticket:HB-900';
  item.kind = 'pr+ticket';
  item.title = 'HB-900 — Retry budget';
  item.ticket = {
    key: 'HB-900',
    summary: 'Retry budget',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    url: 'https://jira.example/HB-900',
    assignee: 'me',
    updatedAt: '2026-09-10T07:00:00.000Z',
  };
  const lot = body.lists.parkingLot.untouched;
  lot.splice(lot.indexOf(PARKING_ITEM), 1, 'ticket:HB-900');
  return body;
}
