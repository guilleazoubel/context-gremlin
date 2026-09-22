/**
 * The in-panel replacement for the "open the cgremlin workspace?" popup.
 *
 * The complaint this pins down is literal: the toast fired on EVERY row click while the window
 * was not the managed workspace. What replaces it is a one-line notice inside the panel, with the
 * same hint repeated inside the expanded row, and a "Not now" that is remembered in the host's
 * global state — so it stays gone across a refresh, a new selection and a window reload.
 */
import { describe, expect, it } from 'vitest';
import {
  MANAGED_WORKSPACE_HINT,
  OPEN_MANAGED_COMMAND,
  PanelView,
  WORKSPACE_NOTICE_DISMISSED_KEY,
} from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const ROW = 'ticket:HB-627';
const OTHER = 'pr:acme/web#200';

function response(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

interface Built {
  host: FakeHost;
  panel: PanelView;
  view: FakeWebviewView;
  state(): PanelState;
  row(id: string): PanelRowView | undefined;
  click(id: string): void;
}

function build(host: FakeHost = new FakeHost()): Built {
  const panel = new PanelView({
    host,
    assets: { scriptText: '', styleText: '' },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    onSelect: () => {},
    now: () => NOW,
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems(response());
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  const state = (): PanelState => {
    const render = [...view.webview.posted]
      .reverse()
      .find((m) => (m as { type?: string }).type === 'render') as { state: PanelState } | undefined;
    if (render === undefined) throw new Error('nothing rendered');
    return render.state;
  };
  return {
    host,
    panel,
    view,
    state,
    row: (id) =>
      state()
        .sections.flatMap((section) => section.rows)
        .find((row) => row.id === id),
    click: (id) => view.webview.emit({ type: 'selectRow', id, list: 'myWork' }),
  };
}

describe('the offer to open the managed workspace', () => {
  it('is a panel notice, not a popup, and carries the command that performs the open', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    expect(h.state().notice).toEqual({
      message: MANAGED_WORKSPACE_HINT,
      actionLabel: 'Open the workspace',
      command: OPEN_MANAGED_COMMAND,
      dismissLabel: 'Not now',
    });
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });

  it('is absent until the swap actually asks for it', () => {
    const h = build();
    expect(h.state().notice).toBeNull();
  });

  /**
   * Round 3 §e.6 — the hint leaves the row. Until it was dismissed it occupied the FIRST line of
   * the expansion on every row, which is the exact position the verdict must own; and it is a
   * sentence with its verb amputated, since the row drew no control for it. The offer itself is
   * unchanged, in the panel header, where a panel-wide setting belongs.
   */
  it('keeps the offer in the header and puts nothing at all inside the open row', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    h.click(ROW);
    expect(h.state().notice?.message).toBe(MANAGED_WORKSPACE_HINT);
    expect(JSON.stringify(h.row(ROW))).not.toContain(MANAGED_WORKSPACE_HINT);
  });
});

describe('"Not now"', () => {
  it('hides the notice and the inline hint at once', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    h.click(ROW);
    h.view.webview.emit({ type: 'dismissNotice' });
    expect(h.state().notice).toBeNull();
    expect(JSON.stringify(h.row(ROW))).not.toContain(MANAGED_WORKSPACE_HINT);
  });

  it('is remembered in the host state, so a refresh does not bring it back', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    h.view.webview.emit({ type: 'dismissNotice' });
    expect(h.host.getState(WORKSPACE_NOTICE_DISMISSED_KEY)).toBe(true);
    h.panel.setItems(response());
    h.panel.setWorkspaceOffer(true);
    expect(h.state().notice).toBeNull();
  });

  it('stays gone when the user selects another item', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    h.view.webview.emit({ type: 'dismissNotice' });
    h.click(ROW);
    h.click(OTHER);
    expect(h.state().notice).toBeNull();
    expect(JSON.stringify(h.row(OTHER))).not.toContain(MANAGED_WORKSPACE_HINT);
  });

  it('survives a window reload — the flag is read back from global state', () => {
    const first = build();
    first.panel.setWorkspaceOffer(true);
    first.view.webview.emit({ type: 'dismissNotice' });

    const again = build(first.host);
    again.panel.setWorkspaceOffer(true);
    expect(again.state().notice).toBeNull();
  });

  it('is undone by the command, which is the user asking for it directly', () => {
    const h = build();
    h.panel.setWorkspaceOffer(true);
    h.view.webview.emit({ type: 'dismissNotice' });
    h.panel.clearWorkspaceNoticeDismissal();
    expect(h.host.getState(WORKSPACE_NOTICE_DISMISSED_KEY)).toBe(false);
    expect(h.state().notice).not.toBeNull();
  });
});
