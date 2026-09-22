/**
 * Phase 12 item 2, as the panel draws it.
 *
 * The bin is one control and one section. The control sits beside the focus select — the two
 * questions "which area am I looking at" and "am I looking at what I put aside" belong on the same
 * line — and it carries the count, which is the entire reason to reach for it. The section is
 * drawn last, muted, and each of its rows offers exactly one verb.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import type { PanelState } from '../../src/model/panel-protocol';

interface Panel {
  render(next: PanelState): void;
}

const ITEM = 'pr:acme/web#101';

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

const toggle = (): FakeElement | undefined => dom.root.byClass('dismissed-toggle')[0];

describe('item 2 — the dismissed control', () => {
  it('is not drawn at all while the user has dismissed nothing', () => {
    panel.render(stateOf());
    expect(toggle()).toBeUndefined();
  });

  it('sits immediately after the focus control, and says how much is behind it', () => {
    panel.render(stateOf({ dismissed: [ITEM] }));
    expect(dom.root.children.map((node) => node.className).slice(0, 2)).toEqual([
      'focus',
      'dismissed-toggle',
    ]);
    expect(toggle()?.textContent).toBe('Dismissed (1)');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('posts one setShowDismissed for a click, and lets the host decide what happens next', () => {
    panel.render(stateOf({ dismissed: [ITEM] }));
    dom.posted.length = 0;
    toggle()?.emit('click', {});
    expect(dom.posted).toEqual([{ type: 'setShowDismissed', show: true }]);

    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
    dom.posted.length = 0;
    toggle()?.emit('click', {});
    expect(dom.posted).toEqual([{ type: 'setShowDismissed', show: false }]);
  });

  it('assigns nothing at all on a render over identical data', () => {
    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    dom.document.clearLog();
    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    expect(dom.document.writes).toEqual([]);
  });
});

describe('item 2 — the dismissed section', () => {
  const sections = (): string[] =>
    dom.root.byClass('section').map((node) => node.dataset.section ?? '');

  it('is drawn last, and only while the toggle is on', () => {
    panel.render(stateOf({ dismissed: [ITEM] }));
    expect(sections()).not.toContain('dismissed');

    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    expect(sections().at(-1)).toBe('dismissed');
  });

  it('carries its own muted accent, and the row wears the dismissed class', () => {
    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    const section = dom.root.byClass('section').at(-1);
    expect(section?.className).toBe('section sec-dismissed');
    const row = section?.byClass('row')[0];
    expect(row?.className.split(' ')).toContain('dismissed');
    expect(row?.dataset.id).toBe(ITEM);
  });

  it('takes the dismissed row out of the section it came from', () => {
    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true }));
    const lot = dom.root
      .byClass('section')
      .find((node) => node.dataset.section === 'parkingLot:untouched');
    expect(lot?.byClass('row').map((row) => row.dataset.id)).not.toContain(ITEM);
  });

  it('offers Undismiss, and nothing that would start work, in the row it opens into', () => {
    panel.render(stateOf({ dismissed: [ITEM], showDismissed: true, expanded: ITEM }));
    const expanded = dom.root.byClass('expanded').at(-1);
    // It is the row's ONE recommended verb, so it is the full-width primary rather than a
    // button in the housekeeping group (§e.7).
    expect(expanded?.byClass('row-verb').map((node) => node.textContent)).toEqual(['Undismiss']);
    expect(expanded?.byClass('row-action')).toEqual([]);
  });
});
