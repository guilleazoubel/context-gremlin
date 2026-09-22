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

/**
 * Round 3 §e.6 — the hint no longer floats inside the open row. It was the first line of every
 * expansion until it was dismissed, which is the line the verdict now owns, and it was a
 * sentence with no control attached to it. The header notice — which HAS its buttons — stands.
 */
describe('the hint does not follow the user into the open row', () => {
  const ROW = 'ticket:HB-627';

  it('draws the notice once, in the header, and nothing inside the expansion', () => {
    panel.render(withNotice(ROW));
    expect(dom.root.byClass('notice')).toHaveLength(1);
    expect(dom.root.byClass('expanded-hint')).toHaveLength(0);
    const open = dom.root.byClass('expanded');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((node) => !node.textContent.includes(NOTICE.message))).toBe(true);
  });
});
