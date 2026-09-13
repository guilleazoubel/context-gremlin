/**
 * P2 — a collapse the user asked for outlives the window it was asked in.
 *
 * Collapse state lived in a `Map` on `PanelView`, so every reload reopened "someone is on it" and
 * reclosed whatever the user had opened. It belongs where the sorts already are: the host's
 * `globalState` (R64), keyed per list and per group.
 */
import { describe, expect, it } from 'vitest';
import { PanelView, COLLAPSED_STATE_KEY } from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelState } from '../../src/model/panel-protocol';

const SCRIPT = 'globalThis.__cgremlin_panel = 1;';
const STYLE = '.row {}';

function build(host: FakeHost): { panel: PanelView; view: FakeWebviewView; state: () => PanelState } {
  const panel = new PanelView({
    host,
    assets: { scriptText: SCRIPT, styleText: STYLE },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    now: () => Date.parse('2026-09-10T12:00:00.000Z'),
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems(JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse);
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  return { panel, view, state: () => panel.state() };
}

const listOf = (state: PanelState, kind: string) => {
  const found = state.lists.find((list) => list.kind === kind);
  if (found === undefined) throw new Error(`no ${kind}`);
  return found;
};

describe('P2 collapse state', () => {
  it('starts with every list open and only "someone is on it" closed', () => {
    const { state } = build(new FakeHost());
    expect(state().lists.map((list) => list.collapsed)).toEqual([false, false, false, false]);
    expect(listOf(state(), 'parkingLot').sections.map((s) => s.collapsed)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('closes a list on the panel\'s say-so, and counts only what is left on screen', () => {
    const { view, state } = build(new FakeHost());
    view.webview.emit({ type: 'toggleList', list: 'myWork', collapsed: true });
    expect(listOf(state(), 'myWork').collapsed).toBe(true);
    // The list still says how much is behind it; a closed list is not an empty one.
    expect(listOf(state(), 'myWork').count).toBeGreaterThan(0);
  });

  it('remembers both kinds of collapse across a reload', () => {
    const host = new FakeHost();
    const first = build(host);
    first.view.webview.emit({ type: 'toggleList', list: 'investigations', collapsed: true });
    first.view.webview.emit({
      type: 'toggleGroup',
      list: 'parkingLot',
      group: 'someoneOnIt',
      collapsed: false,
    });
    expect(host.getState<unknown>(COLLAPSED_STATE_KEY)).toBeDefined();

    // A new window, the same `globalState`.
    const second = build(host);
    expect(listOf(second.state(), 'investigations').collapsed).toBe(true);
    expect(listOf(second.state(), 'parkingLot').sections[2].collapsed).toBe(false);
  });

  it('ignores a persisted value that is not the shape it wrote', () => {
    const host = new FakeHost();
    void host.setState(COLLAPSED_STATE_KEY, 'not an object');
    const { state } = build(host);
    expect(state().lists.map((list) => list.collapsed)).toEqual([false, false, false, false]);
  });
});
