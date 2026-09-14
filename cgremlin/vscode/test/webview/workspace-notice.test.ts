/**
 * P10 — the panel paints the workspace offer, and "Not now" goes back to the HOST.
 *
 * The dismissal has to outlive this webview (and the window), so the button may not simply hide
 * its own node: the only correct answer to a click on it is one message on the channel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import type { PanelNoticeView, PanelState } from '../../src/model/panel-protocol';

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

const NOTICE: PanelNoticeView = {
  message: 'Open the cgremlin workspace to follow the code in the editor',
  actionLabel: 'Open',
  command: 'cgremlin.openManagedWorkspace',
  dismissLabel: 'Not now',
};

function withNotice(expanded?: string): PanelState {
  return { ...stateOf({ expanded }), notice: NOTICE };
}

describe('the workspace notice', () => {
  it('is not painted at all when nothing is offered', () => {
    panel.render(stateOf());
    expect(dom.root.byClass('notice')).toHaveLength(0);
  });

  it('paints one line with the offer, its action and its way out', () => {
    panel.render(withNotice());
    const notice = dom.root.byClass('notice')[0];
    expect(notice.children[0].textContent).toBe(NOTICE.message);
    expect(notice.children[1].textContent).toBe('Open');
    expect(notice.children[2].textContent).toBe('Not now');
  });

  it('runs the command when Open is clicked', () => {
    panel.render(withNotice());
    dom.posted.length = 0;
    dom.root.byClass('notice-open')[0].emit('click');
    expect(dom.posted).toEqual([
      { type: 'command', command: 'cgremlin.openManagedWorkspace', id: 'workspace' },
    ]);
  });

  it('tells the host about "Not now" rather than hiding itself', () => {
    panel.render(withNotice());
    dom.posted.length = 0;
    dom.root.byClass('notice-dismiss')[0].emit('click');
    expect(dom.posted).toEqual([{ type: 'dismissNotice' }]);
    // Still on screen: the host decides, and the next render is what removes it.
    expect(dom.root.byClass('notice')).toHaveLength(1);
    panel.render(stateOf());
    expect(dom.root.byClass('notice')).toHaveLength(0);
  });
});

describe('the same hint inside the expanded row', () => {
  const ROW = 'ticket:HB-627';

  it('carries the hint when the row is open and the offer stands', () => {
    const state = withNotice(ROW);
    for (const section of state.sections) {
      for (const row of section.rows) if (row.expanded) row.hint = NOTICE.message;
    }
    panel.render(state);
    // The fixture's row appears in more than one list; every open copy carries the same line.
    const hints = dom.root.byClass('expanded-hint').filter((node) => !node.hidden);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.every((node) => node.textContent === NOTICE.message)).toBe(true);
  });

  it('shows no hint line on an open row when there is nothing to offer', () => {
    panel.render(stateOf({ expanded: ROW }));
    expect(dom.root.byClass('expanded-hint').filter((node) => !node.hidden)).toHaveLength(0);
  });
});
