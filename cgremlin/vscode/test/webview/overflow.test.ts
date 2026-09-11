/**
 * The `⋯` popover has to be dismissible, and there has to be at most one of it.
 *
 * A menu that only closes when its own trigger is clicked again is a menu the user gets stuck in:
 * Escape does nothing, clicking the row behind it selects that row *through* the open menu, and
 * scrolling leaves it floating over a row it no longer belongs to. All three, plus "one at a
 * time", are asserted here against the fake DOM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, type FakeElement } from '../support/fake-dom';

type Overflow = typeof import('../../src/webview/panel/overflow');

let doc: FakeDocument;
let overflow: Overflow;

beforeEach(async () => {
  vi.resetModules();
  doc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = doc;
  overflow = await import('../../src/webview/panel/overflow');
  overflow.installOverflowDismissal();
});

interface Menu {
  menu: FakeElement;
  trigger: FakeElement;
  item: FakeElement;
  row: FakeElement;
}

function menuIn(parent: FakeElement): Menu {
  const row = doc.createElement('div');
  const trigger = doc.createElement('button');
  const menu = doc.createElement('div');
  const item = doc.createElement('button');
  menu.hidden = true;
  menu.appendChild(item);
  row.appendChild(trigger);
  row.appendChild(menu);
  parent.appendChild(row);
  return { menu, trigger, item, row };
}

const open = (m: Menu): void =>
  overflow.toggleOverflow(m.menu as unknown as HTMLElement, m.trigger as unknown as HTMLElement);

describe('closing the ⋯ popover', () => {
  it('opens on its trigger and closes on the next click of it', () => {
    const m = menuIn(doc.body);
    open(m);
    expect(m.menu.hidden).toBe(false);
    open(m);
    expect(m.menu.hidden).toBe(true);
  });

  it('closes on Escape and puts the caret back on the trigger', () => {
    const m = menuIn(doc.body);
    open(m);
    doc.activeElement = m.item;
    doc.emit('keydown', { key: 'Escape' });
    expect(m.menu.hidden).toBe(true);
    expect(doc.activeElement).toBe(m.trigger);
  });

  it('leaves other keys alone, and Escape with nothing open', () => {
    const m = menuIn(doc.body);
    open(m);
    doc.emit('keydown', { key: 'ArrowDown' });
    expect(m.menu.hidden).toBe(false);
    doc.emit('keydown', { key: 'Escape' });
    doc.emit('keydown', { key: 'Escape' });
    expect(m.menu.hidden).toBe(true);
  });

  it('closes on a pointerdown anywhere outside it', () => {
    const m = menuIn(doc.body);
    const elsewhere = doc.createElement('div');
    doc.body.appendChild(elsewhere);
    open(m);
    doc.emit('pointerdown', { target: elsewhere });
    expect(m.menu.hidden).toBe(true);
  });

  it('stays open for a pointerdown on its own item, or on its trigger', () => {
    const m = menuIn(doc.body);
    open(m);
    doc.emit('pointerdown', { target: m.item });
    expect(m.menu.hidden).toBe(false);
    doc.emit('pointerdown', { target: m.trigger });
    expect(m.menu.hidden).toBe(false);
  });

  it('closes when the list it floats over scrolls', () => {
    const tree = doc.createElement('div');
    doc.body.appendChild(tree);
    overflow.dismissOnScroll(tree as unknown as HTMLElement);
    const m = menuIn(tree);
    open(m);
    tree.emit('scroll');
    expect(m.menu.hidden).toBe(true);
  });

  it('keeps at most one open — a second trigger closes the first', () => {
    const first = menuIn(doc.body);
    const second = menuIn(doc.body);
    open(first);
    open(second);
    expect(first.menu.hidden).toBe(true);
    expect(second.menu.hidden).toBe(false);
  });

  it('forgets a menu whose row is being rebuilt, without touching another one', () => {
    const first = menuIn(doc.body);
    const second = menuIn(doc.body);
    open(first);
    overflow.forgetOverflow(second.menu as unknown as HTMLElement);
    expect(first.menu.hidden).toBe(false);
    overflow.forgetOverflow(first.menu as unknown as HTMLElement);
    expect(first.menu.hidden).toBe(true);
  });

  it('writes nothing when there is nothing open to close', () => {
    doc.clearLog();
    doc.emit('keydown', { key: 'Escape' });
    doc.emit('pointerdown', { target: doc.body });
    expect(doc.writes).toEqual([]);
  });
});
