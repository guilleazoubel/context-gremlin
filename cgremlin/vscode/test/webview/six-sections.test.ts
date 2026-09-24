/**
 * Phase 11 task 4 — six first-class sections, and one sticky header level.
 *
 * The parking lot's three groups were a second header level inside one list: one colour for all
 * three, an 11 px grey title, and a sticky offset stacked under the list header. They ARE three
 * different jobs (§1) — pick one up, track one I started, skip one somebody has — so they are
 * promoted to sections. Core membership is untouched: this is the view model flattening what
 * `item.parkingLotGroup` already says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import { PANEL_SECTIONS, sectionClassOf } from '../../src/model/work-items';
import { panelTreeNodes } from '../../src/model/panel-tree';
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

const headers = (): FakeElement[] => dom.root.byClass('section-header');
const titleOf = (node: FakeElement): string => node.byClass('section-title')[0]?.textContent ?? '';

describe('task 4 — the panel sections', () => {
  it('names them in the order §5 fixes, each with its own key', () => {
    expect(PANEL_SECTIONS.map((section) => section.key)).toEqual([
      'parkingLot:untouched',
      'parkingLot:reviewing',
      'parkingLot:someoneOnIt',
      'myWork',
      'nextRelease',
      'investigations',
      'waitingForReview',
    ]);
    expect(PANEL_SECTIONS.map((section) => section.title)).toEqual([
      'Parking lot',
      'Reviewing',
      'Someone is on it',
      'My dev work',
      'Next release',
      'Investigations',
      'Waiting for review',
    ]);
  });

  it('gives each one a glyph and a colour class of its own', () => {
    const glyphs = PANEL_SECTIONS.map((section) => section.glyph);
    expect(new Set(glyphs).size).toBe(7);
    expect(PANEL_SECTIONS.map((section) => sectionClassOf(section.key))).toEqual([
      'sec-parkingLot-untouched',
      'sec-parkingLot-reviewing',
      'sec-parkingLot-someoneOnIt',
      'sec-myWork',
      'sec-nextRelease',
      'sec-investigations',
      'sec-waitingForReview',
    ]);
  });

  it('paints one header per section, in that order, with its count', () => {
    panel.render(stateOf());
    expect(headers().map(titleOf)).toEqual([
      'Parking lot',
      'Reviewing',
      'Someone is on it',
      'My dev work',
      'Next release',
      'Investigations',
      'Waiting for review',
    ]);
    expect(headers().map((h) => h.byClass('section-count')[0].textContent)).toEqual([
      '3',
      '1',
      '1',
      '3',
      '0',
      '1',
      '3',
    ]);
  });

  it('carries the section class on the header and on every row of it', () => {
    panel.render(stateOf());
    expect(headers()[0].className.split(' ')).toContain('sec-parkingLot-untouched');
    const row = dom.root.byClass('row').find((n) => n.dataset.key === 'row:parkingLot:pr:acme/web#101');
    expect(row?.className.split(' ')).toContain('sec-parkingLot-untouched');
    const mine = dom.root.byClass('row').find((n) => n.dataset.key === 'row:myWork:ticket:HB-627');
    expect(mine?.className.split(' ')).toContain('sec-myWork');
  });

  it('is one disclosure button per header, and posts one toggle keyed by the section', () => {
    panel.render(stateOf());
    const someone = headers()[2];
    expect(someone.tagName).toBe('BUTTON');
    expect(someone.getAttribute('aria-expanded')).toBe('false');
    dom.posted.length = 0;
    someone.emit('click');
    expect(dom.posted).toEqual([
      { type: 'toggleSection', key: 'parkingLot:someoneOnIt', collapsed: false },
    ]);
  });

  it('walks the tree in the order the DOM paints it', () => {
    const state = stateOf();
    panel.render(state);
    const painted = dom.root
      .findAll((node) => node.getAttribute('role') === 'treeitem')
      .map((node) => node.dataset.key ?? '');
    expect(panelTreeNodes(state).map((node) => node.key)).toEqual(painted);
  });

  it('says so where a section holds nothing, rather than leaving a gap', () => {
    const state = stateOf();
    const empty: PanelState = {
      ...state,
      sections: state.sections.map((section) => ({ ...section, count: 0, rows: [] })),
    };
    panel.render(empty);
    expect(dom.root.byClass('section-empty')).toHaveLength(7);
    expect(dom.root.byClass('section-empty')[0].textContent).toBe('Nothing waiting for you');
  });
});
