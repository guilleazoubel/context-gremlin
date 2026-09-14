/**
 * Phase 11 task 6 — "overwhelmed / narrow to one area".
 *
 * Six sections and everything in them, always, was the state the user described as overwhelming.
 * §6 adds one control at the very top: a native `<select>`. Decided over segmented tabs (seven
 * targets do not fit 300 px) and chips (they wrap to three rows, which is the clutter being
 * removed) — a select is one line at any width, the platform gives it keyboard and screen-reader
 * behaviour for free, and it needs no popup of our own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import { FakeHost } from '../support/fake-host';
import { PanelView } from '../../src/ui/panel-view';
import { FakeWebviewView } from '../support/fake-host';
import { FOCUS_STATE_KEY, readFocus } from '../../src/model/work-items';
import { panelTreeNodes } from '../../src/model/panel-tree';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
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

const select = (): FakeElement => {
  const found = dom.root.byClass('focus')[0];
  if (found === undefined) throw new Error('no focus control');
  return found;
};

describe('§6 the focus control, as the panel draws it', () => {
  it('is a native select, first in the panel, above the needs-you strip', () => {
    panel.render(stateOf());
    expect(select().tagName).toBe('SELECT');
    expect(dom.root.children[0].className).toBe('focus');
    expect(select().getAttribute('aria-label')).toBe('Narrow the panel to one area');
  });

  it('lists All areas and the six sections, each with its own count', () => {
    panel.render(stateOf());
    expect(select().children.map((option) => option.textContent)).toEqual([
      'All areas (12)',
      'Parking lot (3)',
      'Reviewing (1)',
      'Someone is on it (1)',
      'My dev work (3)',
      'Investigations (1)',
      'Waiting for review (3)',
    ]);
    expect(select().children.map((option) => option.getAttribute('value'))).toEqual([
      'all',
      'parkingLot:untouched',
      'parkingLot:reviewing',
      'parkingLot:someoneOnIt',
      'myWork',
      'investigations',
      'waitingForReview',
    ]);
  });

  it('posts one setFocus for a change, and lets the host decide what happens next', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    select().emit('change', { target: { value: 'myWork' } });
    expect(dom.posted).toEqual([{ type: 'setFocus', focus: 'myWork' }]);
  });

  it('assigns nothing at all on a render over identical data', () => {
    panel.render(stateOf());
    dom.document.clearLog();
    panel.render(stateOf());
    expect(dom.document.writes).toEqual([]);
  });
});

describe('§6 the focus control, as the host applies it', () => {
  function build(host: FakeHost) {
    const panelView = new PanelView({
      host,
      assets: { scriptText: 'x', styleText: 'y' },
      mediaPath: '/ext/media',
      onOpenItem: () => {},
      onOpenChild: () => {},
      onCommand: () => {},
      now: () => Date.parse('2026-09-10T12:00:00.000Z'),
      nonce: () => 'test-nonce',
    });
    const view = new FakeWebviewView();
    panelView.resolveWebviewView(view);
    panelView.setItems(JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse);
    panelView.setConnected(true);
    view.webview.emit({ type: 'ready' });
    return { panelView, view, state: () => panelView.state() };
  }

  it('renders all six areas until the user narrows it', () => {
    const { state } = build(new FakeHost());
    expect(state().focus).toBe('all');
    expect(state().sections).toHaveLength(6);
    expect(state().focusOptions.map((option) => option.key)).toHaveLength(7);
  });

  it('renders ONLY the chosen area, and keeps the keyboard out of the others', () => {
    const { view, state } = build(new FakeHost());
    view.webview.emit({ type: 'setFocus', focus: 'myWork' });
    expect(state().sections.map((section) => section.key)).toEqual(['myWork']);
    // The tree cannot reach a row the panel is not painting (§6).
    expect(panelTreeNodes(state()).every((node) => node.list === 'myWork')).toBe(true);
    // …and the other areas still say how much is in them, which is why the select is worth using.
    expect(state().focusOptions.find((option) => option.key === 'investigations')?.count).toBe(1);
  });

  it('survives closing and reopening the window', () => {
    const host = new FakeHost();
    build(host).view.webview.emit({ type: 'setFocus', focus: 'investigations' });
    expect(host.getState<string>(FOCUS_STATE_KEY)).toBe('investigations');
    expect(build(host).state().sections.map((section) => section.key)).toEqual(['investigations']);
  });

  it('falls back to all areas on a stored value it does not recognise', () => {
    const host = new FakeHost();
    void host.setState(FOCUS_STATE_KEY, 'parkingLot:whatever');
    expect(readFocus(host)).toBe('all');
    expect(build(host).state().sections).toHaveLength(6);
    void host.setState(FOCUS_STATE_KEY, { not: 'a string' });
    expect(readFocus(host)).toBe('all');
  });

  it('opens the section it is narrowed to, so the choice is never an empty header', () => {
    const { view, state } = build(new FakeHost());
    // "Someone is on it" starts closed (R47). Choosing it deliberately is asking to see it.
    view.webview.emit({ type: 'setFocus', focus: 'parkingLot:someoneOnIt' });
    expect(state().sections.map((section) => [section.key, section.collapsed, section.count])).toEqual(
      [['parkingLot:someoneOnIt', false, 1]],
    );
  });

  it('widens back to all areas when the user is sent to a row outside the focused one', () => {
    const { view, state } = build(new FakeHost());
    view.webview.emit({ type: 'setFocus', focus: 'myWork' });
    // The needs-you strip is a shortcut INTO the panel: a row it names must end up on screen,
    // and a filter that silently swallowed it would make the strip a dead end.
    view.webview.emit({ type: 'selectRow', id: 'pr:acme/web#102', list: 'parkingLot' });
    expect(state().focus).toBe('all');
    expect(state().sections).toHaveLength(6);
    expect(
      state()
        .sections.flatMap((section) => section.rows)
        .filter((row) => row.selected)
        .map((row) => row.id),
    ).toEqual(['pr:acme/web#102']);
  });

  it('keeps the focus where it is when the selected row is already in it', () => {
    const { view, state } = build(new FakeHost());
    view.webview.emit({ type: 'setFocus', focus: 'myWork' });
    view.webview.emit({ type: 'selectRow', id: 'ticket:HB-627', list: 'myWork' });
    expect(state().focus).toBe('myWork');
  });

  it('still says Nothing waiting for you where the one focused area is empty', () => {
    const host = new FakeHost();
    const { view, state } = build(host);
    view.webview.emit({ type: 'setFocus', focus: 'myWork' });
    panel.render({ ...state(), sections: state().sections.map((s) => ({ ...s, rows: [], count: 0 })) });
    expect(dom.root.byClass('section-empty')).toHaveLength(1);
    expect(dom.root.byClass('section-empty')[0].hidden).toBe(false);
  });
});
