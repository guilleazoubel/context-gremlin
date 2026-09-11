/**
 * The row, on its own: what it says without being hovered, and what it does not do when it is.
 *
 * The two defects this pins down are both about the node surviving. A row that is rebuilt on
 * every refresh loses `:hover` mid-click; a row whose height depends on hover moves the thing the
 * user was aiming at. Both are assertions about the mutation log, not about markup.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRow, patchRow, rowKey } from '../../src/webview/panel/row';
import { setSink } from '../../src/webview/panel/channel';
import { FakeDocument, type FakeElement } from '../support/fake-dom';
import type { PanelRowView } from '../../src/model/panel-protocol';

let doc: FakeDocument;
let posted: unknown[];

beforeEach(() => {
  doc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = doc;
  posted = [];
  setSink((message) => posted.push(message));
});

function rowView(over: Partial<PanelRowView> = {}): PanelRowView {
  return {
    id: 'pr:acme/web#101',
    list: 'parkingLot',
    label: 'acme/web#101 — Fix hydration on /communities',
    description: '',
    badges: [],
    chips: [],
    age: '12d',
    size: '8 files +240/−31',
    ci: '',
    meta: [
      { kind: 'author', text: '@jdoe' },
      { kind: 'age', text: '12d', title: '2026-08-30T09:00:00.000Z' },
      { kind: 'tier', text: 'M' },
      { kind: 'size', text: '8 files +240/−31' },
      { kind: 'ci', text: '', title: 'CI: success', tone: 'good' },
    ],
    stateLine: [],
    tier: 'M',
    demoted: false,
    needsYou: false,
    hasChildren: true,
    expanded: false,
    selected: false,
    children: [],
    lifecycle: [],
    changes: null,
    actions: [
      { command: 'cgremlin.startReview', label: 'Start review', placement: 'primary' },
      { command: 'cgremlin.openPr', label: 'Open acme/web#101', placement: 'overflow' },
      { command: 'cgremlin.ack', label: 'Ack', placement: 'overflow' },
    ],
    ...over,
  };
}

function build(over: Partial<PanelRowView> = {}): FakeElement {
  const view = rowView(over);
  const node = createRow(view) as unknown as FakeElement;
  patchRow(node as unknown as HTMLElement, view, { focusedKey: null });
  doc.clearLog();
  return node;
}

const textOf = (node: FakeElement, cls: string): string => node.byClass(cls)[0]?.textContent ?? '';

describe('what the row says without being hovered', () => {
  it('carries its title and every signal as its own cell', () => {
    const node = build();
    expect(textOf(node, 'row-label')).toBe('acme/web#101 — Fix hydration on /communities');
    const cells = node.byClass('row-meta')[0].children;
    expect(cells.map((cell) => cell.className)).toEqual([
      'cell cell-author',
      'cell cell-age',
      'cell cell-tier',
      'cell cell-size',
      'cell cell-ci tone-good',
    ]);
    // The CI cell is a dot: it says its state in the title, because a coloured dot alone is not
    // an accessible signal (§2.2 rule 9).
    expect(cells[4].title).toBe('CI: success');
    expect(cells[1].title).toBe('2026-08-30T09:00:00.000Z');
  });

  it('reserves the action gutter whether or not the pointer is there (§2.2 rule 1)', () => {
    const node = build();
    const gutter = node.byClass('row-gutter')[0];
    expect(gutter).toBeDefined();
    expect(gutter.hidden).toBe(false);
    expect(textOf(node, 'row-primary')).toBe('Start review');
  });

  it('keeps the third line as a slot, so a row that grows one does not change shape', () => {
    expect(build().byClass('row-state')).toHaveLength(1);
  });

  it('marks needs-you, demoted and selected as classes, not as extra content', () => {
    const node = build({ needsYou: true, demoted: true, selected: true });
    expect(node.className).toBe('row needs-you demoted selected');
    expect(node.getAttribute('aria-selected')).toBe('true');
  });
});

describe('what a patch does to a row that is already on screen', () => {
  it('writes nothing at all when the data is identical', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView(), { focusedKey: null });
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });

  it('writes only the cell that changed', () => {
    const node = build();
    const meta = rowView().meta;
    meta[1] = { kind: 'age', text: '13d', title: '2026-08-30T09:00:00.000Z' };
    patchRow(node as unknown as HTMLElement, rowView({ meta }), { focusedKey: null });
    expect(doc.log).toEqual([{ kind: 'text', tag: 'SPAN', key: 'cell cell-age', detail: '13d' }]);
  });

  it('keeps the primary button’s node while its verb changes', () => {
    const node = build();
    const primary = node.byClass('row-primary')[0];
    patchRow(
      node as unknown as HTMLElement,
      rowView({
        actions: [{ command: 'cgremlin.chat', label: 'Chat', placement: 'primary' }],
      }),
      { focusedKey: null },
    );
    expect(node.byClass('row-primary')[0]).toBe(primary);
    expect(primary.textContent).toBe('Chat');
  });

  it('turns the twisty and aria-expanded when the row opens, and nothing else', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView({ expanded: true }), { focusedKey: null });
    expect(doc.log.map((m) => m.detail)).toEqual(['aria-expanded=true', '▾']);
  });

  it('moves the single tab stop without touching the row it left (R66)', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView(), { focusedKey: rowKey(rowView()) });
    expect(node.tabIndex).toBe(0);
    expect(doc.log).toEqual([
      { kind: 'prop', tag: 'DIV', key: 'row:parkingLot:pr:acme/web#101', detail: 'tabIndex=0' },
    ]);
  });
});

describe('what the row posts', () => {
  it('posts one selectRow for one click, naming the row it is now', () => {
    const node = build();
    node.emit('click');
    expect(posted).toEqual([
      { type: 'selectRow', id: 'pr:acme/web#101', list: 'parkingLot' },
    ]);
  });

  it('posts the primary verb, and does not also select the row', () => {
    const node = build();
    node.byClass('row-primary')[0].emit('click');
    expect(posted).toEqual([
      { type: 'command', command: 'cgremlin.startReview', id: 'pr:acme/web#101' },
    ]);
  });

  it('keeps Ack and the browser links behind the overflow, closed until asked', () => {
    const node = build();
    const menu = node.byClass('row-overflow')[0];
    expect(menu.hidden).toBe(true);
    expect(menu.children.map((item) => item.textContent)).toEqual(['Open acme/web#101', 'Ack']);

    node.byClass('row-more')[0].emit('click');
    expect(menu.hidden).toBe(false);
    menu.children[1].emit('click');
    expect(posted).toEqual([{ type: 'command', command: 'cgremlin.ack', id: 'pr:acme/web#101' }]);
    expect(menu.hidden).toBe(true);
  });

  it('hides the overflow trigger on a row with nothing behind it', () => {
    const node = build({
      actions: [{ command: 'cgremlin.chat', label: 'Chat', placement: 'primary' }],
    });
    expect(node.byClass('row-more')[0].hidden).toBe(true);
  });
});
