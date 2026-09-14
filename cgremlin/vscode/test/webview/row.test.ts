/**
 * The row, on its own: what it says without being hovered, and what it does not do when it is.
 *
 * The two defects this pins down are both about the node surviving. A row that is rebuilt on
 * every refresh loses `:hover` mid-click; a row whose height depends on hover moves the thing the
 * user was aiming at. Both are assertions about the mutation log, not about markup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRow, patchRow, rowKey } from '../../src/webview/panel/row';
import { setSink } from '../../src/webview/panel/channel';
import { FakeDocument, type FakeElement } from '../support/fake-dom';
import type { PanelRowView } from '../../src/model/panel-protocol';

/** The section accent the row is rendered inside (§5). */
const ACCENT = 'sec-parkingLot-untouched';

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
    hint: null,
    detailNotice: null,
    id: 'pr:acme/web#101',
    list: 'parkingLot',
    label: '#101 — Fix hydration on /communities',
    identity: '#101',
    identityKeys: ['#101'],
    description: 'Fix hydration on /communities',
    descriptionIsOwn: false,
    badges: [],
    chips: [],
    age: '12d',
    size: '8 files +240/−31',
    ci: '',
    meta: [
      { kind: 'repo', text: 'web' },
      { kind: 'author', text: '@jdoe' },
      { kind: 'age', text: '12d' },
      { kind: 'tier', text: 'M' },
      { kind: 'size', text: '8 files +240/−31' },
      { kind: 'ci', text: '', tone: 'good', label: 'CI passing' },
    ],
    tier: 'M',
    demoted: false,
    dismissed: false,
    needsYou: false,
    hasChildren: true,
    expanded: false,
    selected: false,
    parts: [],
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
  patchRow(node as unknown as HTMLElement, view, ACCENT, { focusedKey: null });
  doc.clearLog();
  return node;
}

/** Every `<button>` anywhere under the row — a walk, because the fake DOM has no selectors. */
function buttonsIn(node: FakeElement): FakeElement[] {
  const found: FakeElement[] = [];
  const walk = (at: FakeElement): void => {
    if (at.tagName === 'BUTTON') found.push(at);
    for (const child of at.children) walk(child);
  };
  walk(node);
  return found;
}

describe('§2 — three lines, fixed order, fixed meaning', () => {
  it('puts the keys on line one, one span each, and never the prose', () => {
    const node = build({ identity: 'HB-627 #310', identityKeys: ['HB-627', '#310'] });
    const keys = node.byClass('id-key');
    expect(keys.map((key) => key.textContent)).toEqual(['HB-627', '#310']);
  });

  it('advertises on line one that the row opens, and which way it is', () => {
    // Lost in Phase 10 with the old twisty: `aria-expanded` said the row opened and nothing on
    // screen did. A collapsed row has to look like something that can be opened.
    expect(build().byClass('row-twisty')[0].textContent).toBe('▸');
    expect(build({ expanded: true }).byClass('row-twisty')[0].textContent).toBe('▾');
    expect(build().byClass('row-twisty')[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the description on line two, as one text node', () => {
    const node = build();
    const desc = node.byClass('row-desc')[0];
    expect(desc.textContent).toBe('Fix hydration on /communities');
    expect(desc.hidden).toBe(false);
  });

  it('marks line two as the user’s own when he wrote it — in a word, never a pictogram', () => {
    const derived = build().byClass('row-desc-mark')[0];
    expect(derived.textContent).toBe('');
    expect(derived.hidden).toBe(true);

    const own = build({ description: 'The one nobody owns', descriptionIsOwn: true });
    expect(own.byClass('row-desc-text')[0].textContent).toBe('The one nobody owns');
    expect(own.byClass('row-desc-mark')[0].textContent).toBe('yours');
    expect(own.byClass('row-desc-mark')[0].hidden).toBe(false);
  });

  it('does not render line two as a blank gap when there is nothing to say', () => {
    const node = build({ description: '' });
    const desc = node.byClass('row-desc')[0];
    expect(desc.textContent).toBe('');
    expect(desc.hidden).toBe(true);
  });

  it('puts every signal on line three, as its own cell, repo first', () => {
    const cells = build().byClass('row-signals')[0].children;
    expect(cells.map((cell) => cell.className)).toEqual([
      'cell cell-repo',
      'cell cell-author',
      'cell cell-age',
      'cell cell-tier',
      'cell cell-size',
      'cell cell-ci tone-good',
    ]);
    // The CI cell is a dot: it says its state in an aria-label, because a coloured dot alone is
    // not an accessible signal — and because a tooltip is not a way of saying anything (§3).
    expect(cells[5].getAttribute('aria-label')).toBe('CI passing');
    expect(cells[2].getAttribute('aria-label')).toBeNull();
  });

  it('renders no buttons at all — a collapsed row is purely informational', () => {
    const node = build();
    expect(buttonsIn(node)).toEqual([]);
    expect(node.byClass('row-gutter')).toEqual([]);
  });

  it('marks needs-you, demoted and selected as classes, not as extra content', () => {
    const node = build({ needsYou: true, demoted: true, selected: true });
    expect(node.className).toBe(`row ${ACCENT} needs-you demoted selected`);
    expect(node.getAttribute('aria-selected')).toBe('true');
  });
});

/**
 * §2's truncation rule, which is a CSS rule and therefore asserted against the stylesheet: on
 * every line EXACTLY ONE child may shrink, and every other child is `flex: 0 0 auto`. Two
 * shrinkable children is how the old row ellipsised both the size and the age at 300 px.
 */
describe('§2 — one shrinkable child per line', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

  it('lets the repo GROW as well as shrink, so the right-hand cluster packs right', () => {
    // `.row-signals > .cell { flex: 0 0 auto }` is specificity 0,2,0 and beat `.cell-repo`, so the
    // repo could not shrink at all and the line overflowed at 300 px.
    expect(css).toMatch(/\.row-signals > \.cell:not\(\.cell-repo\)\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.cell-repo\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it('hides the size token below a 380px container, and nothing else responds to width', () => {
    expect(css).toMatch(/#cgremlin-panel\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/@container \(max-width: 380px\)\s*\{\s*\.cell-size\s*\{\s*display: none;?\s*\}/);
    expect(css.match(/@container/g)).toHaveLength(1);
  });

  it('declares min-width:0 on the description and on the repo token, and on no other row part', () => {
    const shrinkable = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .map(([, selector, body]) => [selector.trim(), body] as const)
      .filter(([selector]) => /^\.(row|cell|id-key)/.test(selector))
      .filter(([, body]) => /min-width:\s*0\s*;/.test(body))
      .map(([selector]) => selector);
    // `.id-keys` is a wrapper, not a token: it may shrink so that the line can, but nothing in
    // it ever truncates (L1 is ≤14 characters by construction).
    expect(shrinkable).toEqual(['.id-keys', '.row-desc', '.row-desc-text', '.cell-repo']);
  });


});

describe('what a patch does to a row that is already on screen', () => {
  it('writes nothing at all when the data is identical', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView(), ACCENT, { focusedKey: null });
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });

  it('writes only the cell that changed', () => {
    const node = build();
    const meta = rowView().meta;
    meta[2] = { kind: 'age', text: '13d' };
    patchRow(node as unknown as HTMLElement, rowView({ meta }), ACCENT, { focusedKey: null });
    expect(doc.log).toEqual([{ kind: 'text', tag: 'SPAN', key: 'cell cell-age', detail: '13d' }]);
  });

  it('turns aria-expanded and the twisty when the row opens, and nothing else', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView({ expanded: true }), ACCENT, { focusedKey: null });
    // The twisty is one character in a fixed-width box, so turning it moves no text (§7).
    expect(doc.log.map((m) => m.detail)).toEqual(['aria-expanded=true', '▾']);
  });

  it('moves the single tab stop without touching the row it left (R66)', () => {
    const node = build();
    patchRow(node as unknown as HTMLElement, rowView(), ACCENT, { focusedKey: rowKey(rowView()) });
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
});
