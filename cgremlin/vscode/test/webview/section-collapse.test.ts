/**
 * P2 — every section is a disclosure the user can close, and an empty one says so.
 *
 * Four lists stacked in a 300 px sidebar is a lot of vertical space for work somebody is not
 * doing today, and until now only one of the parking lot's three groups could be closed at all —
 * with no chevron to say it was closed, which is how P1's eleven rows went missing. So: a chevron
 * and a count on every header, a click (or <kbd>Enter</kbd> on the header button) to toggle, and
 * a muted line where a list has nothing in it, because a blank space is not an answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import { LIST_GLYPHS } from '../../src/model/work-items';
import type { PanelListView, PanelState } from '../../src/model/panel-protocol';

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

function listNode(kind: string): FakeElement {
  const found = dom.root.byClass('list').find((node) => node.dataset.kind === kind);
  if (found === undefined) throw new Error(`no list ${kind}`);
  return found;
}

function one(node: FakeElement, className: string): FakeElement {
  const found = node.byClass(className)[0];
  if (found === undefined) throw new Error(`no .${className}`);
  return found;
}

/** The state with one list closed, as the host would post it back after a toggle. */
function withCollapsedList(state: PanelState, kind: string): PanelState {
  return {
    ...state,
    lists: state.lists.map((list): PanelListView =>
      list.kind === kind ? { ...list, collapsed: true } : list,
    ),
  };
}

function emptyState(state: PanelState): PanelState {
  return {
    ...state,
    lists: state.lists.map((list): PanelListView => ({
      ...list,
      count: 0,
      sections: list.sections.map((section) => ({ ...section, count: 0, rows: [] })),
    })),
  };
}

describe('P2 the list header is a disclosure', () => {
  it('carries a chevron, the section glyph, the title and the count', () => {
    panel.render(stateOf());
    const header = one(listNode('parkingLot'), 'list-toggle');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(one(header, 'list-chevron').textContent).toBe('▾');
    expect(one(header, 'list-glyph').textContent).toBe(LIST_GLYPHS.parkingLot);
    expect(one(header, 'list-title').textContent).toBe('Parking lot');
    expect(one(header, 'list-count').textContent).toBe('4');
  });

  it('posts one toggle per click, and the host decides what happens next', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    one(listNode('myWork'), 'list-toggle').emit('click');
    expect(dom.posted).toEqual([{ type: 'toggleList', list: 'myWork', collapsed: true }]);
  });

  it('hides the tree and turns the chevron when the host says the list is closed', () => {
    panel.render(withCollapsedList(stateOf(), 'parkingLot'));
    const list = listNode('parkingLot');
    expect(one(list, 'tree').hidden).toBe(true);
    expect(one(list, 'list-chevron').textContent).toBe('▸');
    expect(one(list, 'list-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(list.byClass('row').length).toBe(0);
    // A closed list says how much is behind it — that is the whole point of closing it.
    expect(one(list, 'list-count').textContent).toBe('4');
    // …and it asks for one toggle back open.
    dom.posted.length = 0;
    one(list, 'list-toggle').emit('click');
    expect(dom.posted).toEqual([{ type: 'toggleList', list: 'parkingLot', collapsed: false }]);
  });

  it('does not re-post a toggle on a render that changed nothing', () => {
    panel.render(stateOf());
    dom.posted.length = 0;
    panel.render(stateOf());
    expect(dom.posted).toEqual([]);
  });
});

describe('P2 the parking lot groups', () => {
  it('carry a chevron and their own count, and drop the ones with nothing in them', () => {
    panel.render(stateOf());
    const lot = listNode('parkingLot');
    const titles = lot.byClass('section-title').map((node) => node.textContent);
    expect(titles).toEqual(['Reviewing', 'Untouched', 'Someone is on it']);
    expect(lot.byClass('section-count').map((node) => node.textContent)).toEqual(['1', '3', '1']);
    const someone = lot.byClass('section-header')[2];
    expect(one(someone, 'section-chevron').textContent).toBe('▸');
    expect(someone.getAttribute('aria-expanded')).toBe('false');
  });

  it('drops a group header that holds nothing at all', () => {
    const state = stateOf();
    const lot = state.lists.find((list) => list.kind === 'parkingLot');
    if (lot === undefined) throw new Error('fixture');
    lot.sections[0] = { ...lot.sections[0], count: 0, rows: [] };
    panel.render(state);
    expect(listNode('parkingLot').byClass('section-title').map((n) => n.textContent)).toEqual([
      'Untouched',
      'Someone is on it',
    ]);
  });
});

describe('P2 an empty list says so', () => {
  it('paints one muted line instead of nothing', () => {
    panel.render(emptyState(stateOf()));
    for (const kind of ['parkingLot', 'myWork', 'investigations', 'waitingForReview']) {
      const empty = one(listNode(kind), 'list-empty');
      expect(empty.hidden, kind).toBe(false);
      expect(empty.textContent).toBe('Nothing waiting for you');
    }
  });

  it('says nothing of the sort while the list has rows', () => {
    panel.render(stateOf());
    expect(one(listNode('parkingLot'), 'list-empty').hidden).toBe(true);
  });

  it('does not claim a collapsed list is empty', () => {
    panel.render(withCollapsedList(stateOf(), 'parkingLot'));
    expect(one(listNode('parkingLot'), 'list-empty').hidden).toBe(true);
  });
});

describe('P2 the keyboard', () => {
  it('toggles a group with Enter, exactly as a click on its header does', () => {
    panel.render(stateOf());
    const header = listNode('parkingLot').byClass('section-header')[2];
    // One row in Reviewing, three in Untouched, then the group header that holds the rest.
    for (let at = 0; at < 5; at += 1) dom.document.emit('keydown', { key: 'ArrowDown' });
    dom.posted.length = 0;
    dom.document.emit('keydown', { key: 'Enter' });
    expect(dom.posted).toEqual([
      // It starts shut (R47), so Enter opens it — the same message its header's click posts.
      { type: 'toggleGroup', list: 'parkingLot', group: 'someoneOnIt', collapsed: false },
    ]);
    expect(header.dataset.key).toBe('group:parkingLot:someoneOnIt');
  });

  it('leaves Enter and Space alone while the caret is on a header button', () => {
    panel.render(stateOf());
    dom.document.emit('keydown', { key: 'ArrowDown' });
    dom.posted.length = 0;
    // The browser turns this into the button's own click; the tree must not also act on it.
    dom.document.emit('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
    expect(dom.posted).toEqual([]);
  });
});
