/**
 * P2 — a collapse the user asked for outlives the window it was asked in.
 *
 * Collapse state lived in a `Map` on `PanelView`, so every reload reopened "someone is on it" and
 * reclosed whatever the user had opened. It belongs where the sorts already are: the host's
 * `globalState` (R64), keyed by §5's section key.
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

const sectionOf = (state: PanelState, key: string) => {
  const found = state.sections.find((section) => section.key === key);
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
};

describe('§5 collapse state', () => {
  it('starts with every section open and only "someone is on it" closed', () => {
    const { state } = build(new FakeHost());
    expect(state().sections.map((section) => section.collapsed)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it("closes a section on the panel's say-so, and still says what is behind it", () => {
    const { view, state } = build(new FakeHost());
    view.webview.emit({ type: 'toggleSection', key: 'myWork', collapsed: true });
    expect(sectionOf(state(), 'myWork').collapsed).toBe(true);
    // A closed section is not an empty one: the count is the reason to open it again.
    expect(sectionOf(state(), 'myWork').count).toBeGreaterThan(0);
  });

  it('remembers both kinds of collapse across a reload', () => {
    const host = new FakeHost();
    const first = build(host);
    first.view.webview.emit({ type: 'toggleSection', key: 'investigations', collapsed: true });
    first.view.webview.emit({
      type: 'toggleSection',
      key: 'parkingLot:someoneOnIt',
      collapsed: false,
    });
    expect(host.getState<unknown>(COLLAPSED_STATE_KEY)).toBeDefined();

    // A new window, the same `globalState`.
    const second = build(host);
    expect(sectionOf(second.state(), 'investigations').collapsed).toBe(true);
    expect(sectionOf(second.state(), 'parkingLot:someoneOnIt').collapsed).toBe(false);
  });

  it('ignores a persisted value that is not the shape it wrote', () => {
    const host = new FakeHost();
    void host.setState(COLLAPSED_STATE_KEY, 'not an object');
    const { state } = build(host);
    expect(state().sections.map((section) => section.collapsed)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});
