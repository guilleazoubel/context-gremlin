/**
 * P3 — the strip that replaced the toast.
 *
 * It sits above everything else in the panel, says what wants the user and why, and puts them on
 * the row in one click. It is the only thing in the panel that is allowed to interrupt reading
 * order, which is why it is one line per item and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import type { NeedsYouEntry, PanelState } from '../../src/model/panel-protocol';

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

const ENTRIES: NeedsYouEntry[] = [
  { id: 'pr:acme/web#102', list: 'parkingLot', label: 'acme/web#102 — Drop the legacy shim', reason: 'review ready' },
  { id: 'ticket:HB-627', list: 'myWork', label: 'HB-627 — Caregiver inbox reshuffle', reason: 'plan ready' },
];

const withStrip = (entries: NeedsYouEntry[] = ENTRIES): PanelState => ({
  ...stateOf(),
  needsYou: entries,
});

const strip = (): FakeElement | undefined => dom.root.byClass('attention')[0];
const items = (): FakeElement[] => dom.root.byClass('attention-item');

describe('P3 the needs-you strip', () => {
  it('leads the panel, above the lists', () => {
    panel.render(withStrip());
    expect(dom.root.childNodes[0]?.className).toBe('attention');
  });

  it('says how many, then one line per item with its reason', () => {
    panel.render(withStrip());
    expect(strip()?.byClass('attention-title')[0]?.textContent).toBe('2 need you');
    expect(items().map((node) => node.byClass('attention-label')[0]?.textContent)).toEqual([
      'acme/web#102 — Drop the legacy shim',
      'HB-627 — Caregiver inbox reshuffle',
    ]);
    expect(items().map((node) => node.byClass('attention-reason')[0]?.textContent)).toEqual([
      'review ready',
      'plan ready',
    ]);
  });

  it('says "1 needs you" for one', () => {
    panel.render(withStrip([ENTRIES[0]]));
    expect(strip()?.byClass('attention-title')[0]?.textContent).toBe('1 needs you');
  });

  it('puts the user on the row in one click — the same message the row itself posts', () => {
    panel.render(withStrip());
    dom.posted.length = 0;
    items()[1].emit('click');
    expect(dom.posted).toEqual([{ type: 'selectRow', id: 'ticket:HB-627', list: 'myWork' }]);
  });

  it('is not there at all when nothing wants the user', () => {
    panel.render(withStrip([]));
    expect(strip()).toBeUndefined();
  });

  it('survives a trouble state, because what wants the user is still true', () => {
    panel.render({
      ...withStrip(),
      lists: [],
      trouble: { message: 'The engine is not one this extension can use.', command: 'cgremlin.engine.start', actionLabel: 'Start the engine' },
    });
    expect(items().length).toBe(2);
  });

  it('mutates nothing on a second render over identical data', () => {
    panel.render(withStrip());
    dom.document.clearLog();
    panel.render(withStrip());
    expect(dom.document.log).toEqual([]);
    expect(dom.document.writes).toEqual([]);
  });
});
