/**
 * The panel is never left blank.
 *
 * The defect: building `PanelState` touches every pure model there is, and an unexpected throw
 * anywhere in that chain reaches `refresh.ts`'s catch, which writes ONE line to an output channel
 * nobody has open. Nothing is posted to the webview, so a sidebar that has never rendered stays
 * empty — a blank panel beside a perfectly healthy engine, which is exactly what the user saw
 * and what 1013 green unit tests could not see, because every one of them builds the state from
 * deps that cannot fail.
 *
 * So the failure is INK, like every other one (Phase 8's lesson: silence is the bug).
 */
import { describe, expect, it } from 'vitest';
import { PanelView, PANEL_RENDER_FAILURE } from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelState } from '../../src/model/panel-protocol';

function build(qaRepos: () => readonly string[]): {
  host: FakeHost;
  view: FakeWebviewView;
  render(): PanelState | undefined;
} {
  const host = new FakeHost();
  const panel = new PanelView({
    host,
    assets: { scriptText: '/* panel */', styleText: '/* panel */' },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    now: () => Date.parse('2026-09-10T12:00:00.000Z'),
    nonce: () => 'test-nonce',
    qaRepos,
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems(JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse);
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  return {
    host,
    view,
    render: () =>
      ([...view.webview.posted].reverse().find((m) => (m as { type?: string }).type === 'render') as
        | { state: PanelState }
        | undefined)?.state,
  };
}

describe('a state the panel cannot build', () => {
  it('renders the lists when nothing throws', () => {
    const built = build(() => []);
    expect(built.render()?.sections.some((section) => section.rows.length > 0)).toBe(true);
  });

  it('says so, with the log and a reload, instead of posting nothing', () => {
    const built = build(() => {
      throw new Error('qaRepos exploded');
    });
    const state = built.render();
    expect(state).toBeDefined();
    expect(state?.trouble?.message).toBe(PANEL_RENDER_FAILURE);
    expect(state?.trouble?.command).toBe('cgremlin.engine.showLog');
    expect(state?.trouble?.secondary?.command).toBe('workbench.action.reloadWindow');
    // The lists are gone — they could not be built — and the panel says why rather than nothing.
    expect(state?.sections).toEqual([]);
    expect(built.host.logs.join('\n')).toContain('qaRepos exploded');
  });
});
