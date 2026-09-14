/**
 * §5 — every section is a disclosure the user can close, and an empty one says so.
 *
 * Six sections stacked in a 300 px sidebar is a lot of vertical space for work somebody is not
 * doing today, and until Phase 11 only one of the parking lot's three groups could be closed at
 * all — with no chevron to say it was closed, which is how P1's eleven rows went missing. So: a
 * chevron and a count on every header, a click (or <kbd>Enter</kbd> on the header button) to
 * toggle, and a muted line where a section has nothing in it, because a blank space is no answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import { PANEL_SECTIONS } from '../../src/model/work-items';
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

function sectionNode(key: string): FakeElement {
  const found = dom.root.byClass('section').find((node) => node.dataset.section === key);
  if (found === undefined) throw new Error(`no section ${key}`);
  return found;
}

function one(node: FakeElement, className: string): FakeElement {
  const found = node.byClass(className)[0];
  if (found === undefined) throw new Error(`no .${className}`);
  return found;
}

function emptyState(state: PanelState): PanelState {
  return {
    ...state,
    sections: state.sections.map((section) => ({
      ...section,
      count: 0,
      rows: [],
      collapsed: false,
    })),
  };
}

describe('§5 the section header is a disclosure', () => {
  it('carries a chevron, the section glyph, the title and the count', () => {
    panel.render(stateOf());
    const header = one(sectionNode('parkingLot:untouched'), 'section-header');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(one(header, 'section-chevron').textContent).toBe('▾');
    expect(one(header, 'section-glyph').textContent).toBe(PANEL_SECTIONS[0].glyph);
    expect(one(header, 'section-title').textContent).toBe('Parking lot');
    expect(one(header, 'section-count').textContent).toBe('3');
  });

  it('posts one toggle per click, and the host decides what happens next', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    one(sectionNode('myWork'), 'section-header').emit('click');
    expect(dom.posted).toEqual([{ type: 'toggleSection', key: 'myWork', collapsed: true }]);
  });

  it('hides the tree and turns the chevron when the host says the section is closed', () => {
    panel.render(stateOf({ collapsed: { 'parkingLot:untouched': true } }));
    const section = sectionNode('parkingLot:untouched');
    expect(one(section, 'tree').hidden).toBe(true);
    expect(one(section, 'section-chevron').textContent).toBe('▸');
    expect(one(section, 'section-header').getAttribute('aria-expanded')).toBe('false');
    expect(section.byClass('row').length).toBe(0);
    // A closed section says how much is behind it — that is the whole point of closing it.
    expect(one(section, 'section-count').textContent).toBe('3');
    dom.posted.length = 0;
    one(section, 'section-header').emit('click');
    expect(dom.posted).toEqual([
      { type: 'toggleSection', key: 'parkingLot:untouched', collapsed: false },
    ]);
  });

  it('does not re-post a toggle on a render that changed nothing', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    panel.render(stateOf());
    expect(dom.posted).toEqual([]);
  });

  it('starts "someone is on it" closed, and nothing else', () => {
    panel.render(stateOf());
    const shut = dom.root
      .byClass('section-header')
      .filter((header) => header.getAttribute('aria-expanded') === 'false');
    expect(shut).toHaveLength(1);
    expect(one(shut[0], 'section-title').textContent).toBe('Someone is on it');
  });
});

describe('§5 an empty section says so', () => {
  it('paints one muted line instead of nothing', () => {
    panel.render(emptyState(stateOf()));
    for (const spec of PANEL_SECTIONS) {
      const empty = one(sectionNode(spec.key), 'section-empty');
      expect(empty.hidden, spec.key).toBe(false);
      expect(empty.textContent).toBe('Nothing waiting for you');
    }
  });

  it('says nothing of the sort while the section has rows', () => {
    panel.render(stateOf());
    expect(one(sectionNode('parkingLot:untouched'), 'section-empty').hidden).toBe(true);
  });

  it('does not claim a collapsed section is empty', () => {
    panel.render(stateOf({ collapsed: { 'parkingLot:untouched': true } }));
    expect(one(sectionNode('parkingLot:untouched'), 'section-empty').hidden).toBe(true);
  });
});

describe('§5 the keyboard', () => {
  it('leaves Enter and Space alone while the caret is on a header button', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'ArrowDown' });
    dom.posted.length = 0;
    // The browser turns this into the button's own click; the tree must not also act on it.
    dom.document.emit('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
    expect(dom.posted).toEqual([]);
  });

  it('never lands on a row of a closed section', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'End' });
    const last = dom.root.findAll((node) => node.tabIndex === 0)[0];
    expect(last?.dataset.key).not.toContain('pr:acme/api#55');
  });
});

/**
 * The sort chips sat beside the title on the same line, and at 300 px they squeezed `Parking lot`
 * down to `Par…` — the header being the one thing that must stay readable. They move to a line of
 * their own, and the parking lot's three sections share ONE control, because they share one sort.
 */
describe('§5 the sort control', () => {
  it('renders once per list, on the first section of it', () => {
    panel.render(stateOf());
    const withSorts = dom.root
      .byClass('section')
      .filter((node) => node.byClass('sort').length > 0)
      .map((node) => node.dataset.section);
    expect(withSorts).toEqual([
      'parkingLot:untouched',
      'myWork',
      'investigations',
      'waitingForReview',
    ]);
  });

  it('sits under the header rather than beside the title', () => {
    panel.render(stateOf());
    const section = sectionNode('parkingLot:untouched');
    expect(section.children.map((node) => node.className)).toEqual([
      'section-bar',
      'sorts',
      'section-empty',
      'tree',
    ]);
    expect(one(section, 'section-bar').byClass('sort')).toEqual([]);
  });

  it('still sorts the whole list from that one control', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    sectionNode('parkingLot:untouched').byClass('sort')[2].emit('click');
    expect(dom.posted).toEqual([{ type: 'setSort', list: 'parkingLot', sort: 'smallestChange' }]);
  });
});
