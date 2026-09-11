/**
 * P0-4 — nothing moves under the pointer.
 *
 * The two defects, compounding: the panel did `container.textContent = ''` and rebuilt the whole
 * DOM on every render, and the stylesheet grew a row by a button line on `:hover`. So the row
 * under the cursor shrank, the rebuild killed `:hover`, and the button vanished mid-click.
 *
 * Asserted against an instrumented DOM: a render over identical data must produce an EMPTY
 * mutation log, and a change must patch exactly the leaves that changed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { itemsResponse, stateOf } from './state';
import type { PanelState } from '../../src/model/panel-protocol';

interface Panel {
  render(next: PanelState): void;
}

let dom: InstalledDom;
let panel: Panel;

beforeEach(async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  dom = installDom();
  panel = (await import('../../src/webview/panel')) as unknown as Panel;
});

afterEach(() => {
  dom.uninstall();
});

const rowNodes = (): FakeElement[] => dom.root.byClass('row');
const rowKeys = (): string[] => rowNodes().map((node) => node.dataset.key ?? '');

describe('P0-4 keyed reconciliation', () => {
  it('renders every visible row once, keyed by list and item id', () => {
    panel.render(stateOf());
    expect(rowKeys()).toContain('row:parkingLot:pr:acme/web#101');
    // The collapsed "someone is on it" group contributes its header and no rows (R47).
    expect(rowKeys()).not.toContain('row:parkingLot:pr:acme/api#55');
    expect(new Set(rowKeys()).size).toBe(rowKeys().length);
  });

  it('mutates NOTHING on a second render over identical data', () => {
    panel.render(stateOf());
    const before = rowNodes();
    dom.document.clearLog();
    panel.render(stateOf());
    expect(dom.document.log).toEqual([]);
    // …and the very same nodes are still there, so `:hover` and focus were never interrupted.
    expect(rowNodes().map((node, at) => node === before[at]).every(Boolean)).toBe(true);
  });

  it('patches only the row that changed, and reuses every other node', () => {
    panel.render(stateOf());
    const before = new Map(rowNodes().map((node) => [node.dataset.key ?? '', node]));
    dom.document.clearLog();

    const changed = itemsResponse();
    const item = changed.items.find((candidate) => candidate.id === 'ticket:HB-627');
    if (item?.ticket == null) throw new Error('fixture');
    item.ticket.status = 'In Review';
    panel.render(stateOf({ response: changed }));

    expect(dom.document.log.length).toBeGreaterThan(0);
    expect(dom.document.log.every((m) => m.kind === 'text')).toBe(true);
    for (const [key, node] of before) {
      expect(rowNodes().find((candidate) => candidate.dataset.key === key), key).toBe(node);
    }
  });

  it('inserts and removes only the rows that appeared or left', () => {
    panel.render(stateOf());
    const survivor = rowNodes().find((n) => n.dataset.key === 'row:parkingLot:pr:acme/web#101');
    dom.document.clearLog();

    const fewer = itemsResponse();
    fewer.lists.parkingLot.untouched = ['pr:acme/web#101'];
    panel.render(stateOf({ response: fewer }));

    expect(dom.document.log.filter((m) => m.kind === 'remove')).toHaveLength(1);
    expect(dom.document.log.filter((m) => m.kind === 'create')).toHaveLength(0);
    expect(rowNodes().find((n) => n.dataset.key === 'row:parkingLot:pr:acme/web#101')).toBe(
      survivor,
    );
  });

  it('survives fifty renders with focus and expansion intact (risk (a))', () => {
    panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    const row = rowNodes().find((n) => n.dataset.key === 'row:myWork:ticket:HB-627');
    if (row === undefined) throw new Error('no row');
    dom.document.emit('keydown', { key: 'ArrowDown' });
    const focusedBefore = dom.document.activeElement;
    expect(focusedBefore).not.toBeNull();

    for (let at = 0; at < 50; at += 1) panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    expect(rowNodes().find((n) => n.dataset.key === 'row:myWork:ticket:HB-627')).toBe(row);
    expect(dom.document.activeElement).toBe(focusedBefore);
    expect(dom.root.byClass('slot').length).toBeGreaterThan(0);
    expect(dom.root.byClass('part').length).toBeGreaterThan(0);
  });
});

describe('P0-4 the row keeps its height', () => {
  it('has its action gutter in the row whether or not the pointer is there', () => {
    panel.render(stateOf());
    const row = rowNodes().find((n) => n.dataset.key === 'row:parkingLot:pr:acme/web#101');
    expect(row?.byClass('row-gutter')).toHaveLength(1);
    expect(row?.byClass('row-gutter')[0].hidden).toBe(false);
  });

  it('opens into a SIBLING block, so the row node itself never changes shape', () => {
    panel.render(stateOf());
    const row = rowNodes().find((n) => n.dataset.key === 'row:myWork:ticket:HB-627');
    const shape = row?.children.map((c) => c.className);
    panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    expect(row?.children.map((c) => c.className)).toEqual(shape);
    // HB-627 is legitimately in two lists, and the expansion belongs to the ITEM, so it opens
    // under each of them — the same way the selection highlights both.
    expect(dom.root.byClass('expanded')).toHaveLength(2);
    expect(row?.byClass('expanded')).toEqual([]);
  });

  it('takes the block away again when the row closes, and creates no row', () => {
    panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    dom.document.clearLog();
    panel.render(stateOf());
    expect(dom.root.byClass('expanded')).toEqual([]);
    expect(dom.document.log.filter((m) => m.kind === 'create')).toEqual([]);
  });

  it('still shows the change counts the host has since read', () => {
    panel.render(stateOf({ expanded: 'ticket:HB-627' }));
    expect(dom.root.byClass('committed-value')[0].textContent).toBe('—');
    panel.render(
      stateOf({
        expanded: 'ticket:HB-627',
        changes: { committed: '8 files +240/−31', workingTree: '—' },
      }),
    );
    expect(dom.root.byClass('committed-value')[0].textContent).toBe('8 files +240/−31');
  });
});

describe('P0-4 the tree roles survive reconciliation (R66)', () => {
  it('keeps role, level and the single tab stop on the reused nodes', () => {
    panel.render(stateOf());
    panel.render(stateOf());
    const row = rowNodes()[0];
    expect(row.getAttribute('role')).toBe('treeitem');
    expect(row.getAttribute('aria-level')).toBe('1');
    expect(rowNodes().filter((n) => n.tabIndex === 0).length).toBeLessThanOrEqual(1);
  });

  it('marks the selected row as selected, and only that one', () => {
    panel.render(stateOf({ selected: 'ticket:HB-627' }));
    const selected = rowNodes().filter((n) => n.getAttribute('aria-selected') === 'true');
    expect(selected.map((n) => n.dataset.key)).toEqual([
      'row:myWork:ticket:HB-627',
      'row:waitingForReview:ticket:HB-627',
    ]);
  });
});
