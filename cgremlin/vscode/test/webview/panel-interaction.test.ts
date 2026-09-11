/**
 * What the panel does to the user's hands: the order does not move under the pointer, one click
 * is one message, and the keys do exactly what the mouse does (§2.2 rules 3–4, §4, R66).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { itemsResponse, stateOf } from './state';
import type { PanelState } from '../../src/model/panel-protocol';

interface Panel {
  render(next: PanelState): void;
}

let dom: InstalledDom;
let panel: Panel;

beforeEach(async () => {
  vi.resetModules();
  dom = installDom();
  panel = (await import('../../src/webview/panel')) as unknown as Panel;
});

afterEach(() => {
  dom.uninstall();
});

const rowKeys = (): string[] => dom.root.byClass('row').map((node) => node.dataset.key ?? '');
const rowOf = (key: string): FakeElement => {
  const found = dom.root.byClass('row').find((node) => node.dataset.key === key);
  if (found === undefined) throw new Error(`no row ${key}`);
  return found;
};

describe('§2.2 rule 4 — the order is frozen while the pointer is inside the list', () => {
  it('keeps the sequence until the pointer leaves, then applies the one that was queued', () => {
    panel.render(stateOf());
    const order = rowKeys();
    const tree = dom.root.byClass('tree')[0];
    tree.emit('pointerenter');

    // A real re-order: the parking lot is sorted oldest-first, and this PR turns out to predate
    // the one above it. That is exactly the refresh that used to move a row mid-click.
    const reordered = itemsResponse();
    const legacy = reordered.items.find((item) => item.id === 'pr:acme/legacy#9');
    if (legacy === undefined) throw new Error('fixture');
    legacy.prs[0].createdAt = '2026-08-20T12:00:00.000Z';
    panel.render(stateOf({ response: reordered }));
    expect(rowKeys()).toEqual(order);

    tree.emit('pointerleave');
    expect(rowKeys()).not.toEqual(order);
    expect(rowKeys().indexOf('row:parkingLot:pr:acme/legacy#9')).toBeLessThan(
      rowKeys().indexOf('row:parkingLot:pr:acme/web#101'),
    );
  });

  it('still lands a change of state while the order is frozen', () => {
    panel.render(stateOf());
    dom.root.byClass('tree')[0].emit('pointerenter');
    const changed = itemsResponse();
    const item = changed.items.find((candidate) => candidate.id === 'ticket:HB-627');
    if (item?.ticket == null) throw new Error('fixture');
    item.ticket.status = 'In Review';
    panel.render(stateOf({ response: changed }));
    expect(rowOf('row:myWork:ticket:HB-627').byClass('row-state')[0].textContent).toContain(
      'In Review',
    );
  });

  it('does not re-render on a pointer leave that had nothing queued', () => {
    panel.render(stateOf());
    const tree = dom.root.byClass('tree')[0];
    tree.emit('pointerenter');
    dom.document.clearLog();
    tree.emit('pointerleave');
    expect(dom.document.log).toEqual([]);
  });
});

describe('§4 — one click is one message', () => {
  it('posts a single selectRow, and nothing else, for a click on the row', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    rowOf('row:myWork:ticket:HB-627').emit('click');
    expect(dom.posted).toEqual([
      { type: 'selectRow', id: 'ticket:HB-627', list: 'myWork' },
    ]);
  });

  it('posts the verb alone when the click was on the row’s own button', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    rowOf('row:parkingLot:pr:acme/web#101').byClass('row-primary')[0].emit('click');
    expect(dom.posted).toEqual([
      { type: 'command', command: 'cgremlin.startReview', id: 'pr:acme/web#101' },
    ]);
  });

  it('collapses a group from its header', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    const header = dom.root
      .byClass('section-header')
      .find((node) => node.dataset.key === 'group:parkingLot:someoneOnIt');
    header?.emit('click');
    expect(dom.posted).toEqual([
      { type: 'toggleGroup', list: 'parkingLot', group: 'someoneOnIt', collapsed: false },
    ]);
  });

  it('changes a sort from its button', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    dom.root.byClass('sorts')[0].children[2].emit('click');
    expect(dom.posted).toEqual([
      { type: 'setSort', list: 'parkingLot', sort: 'smallestChange' },
    ]);
  });
});

describe('R66 — the keys do what the mouse does', () => {
  it('moves the single tab stop with the arrows, and focuses what it moved to', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'ArrowDown' });
    const first = dom.document.activeElement;
    dom.document.emit('keydown', { key: 'ArrowDown' });
    expect(dom.document.activeElement).not.toBe(first);
    const stops = dom.root.findAll((node) => node.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(dom.document.activeElement);
  });

  it('selects a row on Enter, exactly as a click does', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'Home' });
    dom.posted.length = 0;
    dom.document.emit('keydown', { key: 'Enter' });
    expect(dom.posted).toEqual([
      { type: 'selectRow', id: 'pr:acme/web#102', list: 'parkingLot' },
    ]);
  });

  it('opens a row with ArrowRight rather than pretending to expand it locally', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'End' });
    dom.posted.length = 0;
    dom.document.emit('keydown', { key: 'ArrowRight' });
    expect(dom.posted).toEqual([
      { type: 'toggleRow', id: 'pr:acme/api#77', expanded: true },
    ]);
  });

  it('opens a part from the keyboard once its row is open', () => {
    panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    dom.document.emit('keydown', { key: 'Home' });
    for (let at = 0; at < 40; at += 1) dom.document.emit('keydown', { key: 'ArrowDown' });
    dom.posted.length = 0;
    dom.document.emit('keydown', { key: 'Enter' });
    expect(dom.posted).toHaveLength(1);
  });

  it('ignores a key before anything has rendered', async () => {
    vi.resetModules();
    const fresh = installDom();
    await import('../../src/webview/panel');
    fresh.document.emit('keydown', { key: 'ArrowDown' });
    expect(fresh.posted.filter((m) => (m as { type?: string }).type !== 'ready')).toEqual([]);
    fresh.uninstall();
  });
});
