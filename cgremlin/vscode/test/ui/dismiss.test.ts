/**
 * Phase 12 item 2 — "sometimes I may not care about some of the tickets."
 *
 * Dismissal is the CORE's state (`WorkItem.dismissed`, `POST /items/<path>/dismiss`), and the
 * lists it hands back already exclude a dismissed item — membership stays its answer (D2). What
 * the panel owns is the three things a user notices: the row leaves its section the instant he
 * clicks, a per-panel toggle reveals what he put aside, and a request that fails puts the row back
 * rather than leaving the panel lying about what the engine holds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeHarnesses, panelHarness } from '../support/panel-harness';
import { fixtures } from '../support/stub-server';
import { FakeHost } from '../support/fake-host';
import { SHOW_DISMISSED_STATE_KEY } from '../../src/model/work-items';
import type { StubRequest, StubResponse } from '../support/stub-server';

const ITEM = 'pr:acme/web#101';
const DISMISS_PATH = '/items/pr/acme/web/101/dismiss';
const UNDISMISS_PATH = '/items/pr/acme/web/101/undismiss';

afterEach(disposeHarnesses);

/** What the core answers once `pr:acme/web#101` has been dismissed: out of the lists, in `dismissed`. */
function withDismissed(options: { needsYou?: boolean; undismissed?: boolean } = {}): unknown {
  const body = JSON.parse(JSON.stringify(fixtures.items)) as {
    items: { id: string; dismissed?: boolean; dismissedAt?: string | null; needsYou?: boolean }[];
    lists: { parkingLot: { untouched: string[] } };
    dismissed?: string[];
  };
  const item = body.items.find((candidate) => candidate.id === ITEM);
  if (item === undefined) throw new Error('fixture');
  const lot = body.lists.parkingLot.untouched;
  if (options.undismissed === true) {
    // The core's auto-undismiss: something needs you, so it comes back on its own.
    item.dismissed = false;
    item.dismissedAt = null;
    item.needsYou = options.needsYou ?? false;
    body.dismissed = [];
    return body;
  }
  item.dismissed = true;
  item.dismissedAt = '2026-09-10T11:00:00.000Z';
  lot.splice(lot.indexOf(ITEM), 1);
  body.dismissed = [ITEM];
  return body;
}

function itemsHandler(body: () => unknown): (request: StubRequest) => StubResponse | undefined {
  return (request) =>
    request.method === 'GET' && request.path === '/items'
      ? { status: 200, body: body() }
      : undefined;
}

describe('item 2 — dismissing an item', () => {
  it('takes the row out of its section and into the dismissed one, before the engine answers', async () => {
    const h = await panelHarness();
    expect(h.sectionOf('parkingLot:untouched')?.rows.map((row) => row.id)).toContain(ITEM);

    await h.host.invoke('cgremlin.dismissItem', ITEM);

    expect(h.sectionOf('parkingLot:untouched')?.rows.map((row) => row.id)).not.toContain(ITEM);
    expect(h.state().dismissedCount).toBe(1);
    expect(h.server.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      `POST ${DISMISS_PATH}`,
    );
  });

  it('shows the dismissed section only while the toggle is on, and persists the toggle', async () => {
    const host = new FakeHost();
    const h = await panelHarness({ host });
    await h.host.invoke('cgremlin.dismissItem', ITEM);
    expect(h.sectionOf('dismissed')).toBeUndefined();

    h.toPanel({ type: 'setShowDismissed', show: true });
    const section = h.sectionOf('dismissed');
    expect(section?.rows.map((row) => row.id)).toEqual([ITEM]);
    expect(section?.count).toBe(1);
    expect(h.state().showDismissed).toBe(true);
    expect(host.getState<boolean>(SHOW_DISMISSED_STATE_KEY)).toBe(true);

    // The next window opens on the panel the user left behind (R64).
    const reopened = await panelHarness({ host, handler: itemsHandler(() => withDismissed()) });
    expect(reopened.state().showDismissed).toBe(true);
    expect(reopened.sectionOf('dismissed')?.rows.map((row) => row.id)).toEqual([ITEM]);
  });

  it('offers Undismiss on a dismissed row, and nothing that would start work on it', async () => {
    const h = await panelHarness({ handler: itemsHandler(() => withDismissed()) });
    h.toPanel({ type: 'setShowDismissed', show: true });
    const row = h.sectionOf('dismissed')?.rows[0];
    expect(row?.dismissed).toBe(true);
    expect(row?.actions.map((action) => action.command)).toEqual(['cgremlin.undismissItem']);
  });

  it('restores an undismissed row to its real section, which is the core’s answer', async () => {
    const dismissed = { yet: true };
    const h = await panelHarness({
      handler: itemsHandler(() => (dismissed.yet ? withDismissed() : fixtures.items)),
    });
    h.toPanel({ type: 'setShowDismissed', show: true });
    expect(h.sectionOf('dismissed')?.rows.map((row) => row.id)).toEqual([ITEM]);

    dismissed.yet = false;
    await h.host.invoke('cgremlin.undismissItem', ITEM);
    expect(h.server.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      `POST ${UNDISMISS_PATH}`,
    );
    await h.settle();

    expect(h.sectionOf('dismissed')?.rows ?? []).toEqual([]);
    expect(h.sectionOf('parkingLot:untouched')?.rows.map((row) => row.id)).toContain(ITEM);
  });

  it('brings a dismissed item back the moment it needs you, because the core undismissed it', async () => {
    const needsYou = { yet: false };
    const h = await panelHarness({
      handler: itemsHandler(() =>
        needsYou.yet ? withDismissed({ undismissed: true, needsYou: true }) : withDismissed(),
      ),
    });
    h.toPanel({ type: 'setShowDismissed', show: true });
    expect(h.sectionOf('dismissed')?.rows.map((row) => row.id)).toEqual([ITEM]);

    needsYou.yet = true;
    h.ui.handleFrame({ event: 'items.changed', data: {} });
    await h.settle();

    expect(h.sectionOf('dismissed')?.rows ?? []).toEqual([]);
    expect(h.rowOf(ITEM)?.needsYou).toBe(true);
    expect(h.state().needsYou.map((entry) => entry.id)).toContain(ITEM);
  });

  it('puts the row back and says why when the engine refuses the dismissal', async () => {
    const h = await panelHarness({
      handler: (request) =>
        request.method === 'POST' && request.path === DISMISS_PATH
          ? { status: 409, body: { error: 'that item is running' } }
          : undefined,
    });
    await h.host.invoke('cgremlin.dismissItem', ITEM);

    expect(h.sectionOf('parkingLot:untouched')?.rows.map((row) => row.id)).toContain(ITEM);
    expect(h.state().dismissedCount).toBe(0);
    expect(h.host.callsOf('showWarningMessage')[0]?.args[0]).toBe('that item is running');
  });
});
