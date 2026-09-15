/**
 * Phase 17 §2 / task 8 — the part switcher, asserted on the rendered DOM.
 *
 * The defect: every artifact AND the ticket were appended into one document, so reading a review
 * meant scrolling past a brief. The switcher is the only navigation that REMOVES content from the
 * screen, which is the actual complaint — so the assertions below are about what is NOT there as
 * much as what is.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

const REVIEW = '# PR Review: #12 — a title\n\n## Summary\n\nIt works.\n';
const QA = '# QA\n\n## Checks\n\nAll green.\n';

function agent(): TabAgent {
  return {
    sessionId: 's1',
    mode: 'review',
    phase: 'reviewing',
    running: false,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: 'REVIEW.md',
    artifacts: [
      { sessionId: 's1', name: 'REVIEW.md', mtime: 'm', text: REVIEW },
      { sessionId: 's1', name: 'QA.md', mtime: 'm', text: QA },
    ],
  };
}

function state(overrides: Partial<ItemTabState> = {}): ItemTabState {
  const one = agent();
  const base = {
    itemId: 'i',
    title: 'HB-1489 — Add web-content read endpoint',
    needsYou: false,
    lists: [],
    chips: [],
    focus: { kind: 'artifact', sessionId: 's1', name: 'QA.md' },
    selectedSessionId: 's1',
    agents: [one],
    prs: [{ repo: 'acme/web', number: 2180 }],
    ticket: {
      key: 'HB-1489',
      summary: 'Add web-content read endpoint',
      status: 'UAT',
      url: 'https://jira/HB-1489',
      assignee: 'acct',
      descriptionText: 'A read-only endpoint.',
      comments: [],
    },
    ticketError: null,
    buttons: [],
    parts: [],
  } as unknown as ItemTabState;
  const merged = { ...base, ...overrides } as ItemTabState;
  merged.parts = partsOf(merged);
  return merged;
}

const tablist = () => dom.document.body.find((el) => el.getAttribute('role') === 'tablist');
const tabs = () => dom.document.body.findAll((el) => el.getAttribute('role') === 'tab');
const panels = () => dom.document.body.findAll((el) => el.getAttribute('role') === 'tabpanel');
const posted = () => dom.posted.filter((m) => (m as { type?: string }).type === 'setFocus');

beforeEach(() => {
  dom.posted.length = 0;
});

describe('the parts are a real tablist', () => {
  it('draws one tab per part, in order, under the action row', () => {
    webview.render(state());
    expect(tablist()).toBeDefined();
    expect(tabs().map((t) => t.textContent)).toEqual(['QA', 'Review', 'Ticket', '#2180']);
  });

  it('marks exactly one tab selected and gives the strip exactly one tab stop', () => {
    webview.render(state());
    expect(tabs().filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(tabs().filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent).toBe('QA');
  });

  it('shows ONE pane, and it is the selected part — never the whole scroll', () => {
    webview.render(state());
    expect(panels()).toHaveLength(1);
    const pane = panels()[0];
    expect(pane.getAttribute('aria-labelledby')).toBe(
      tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.id,
    );
    expect(pane.tabIndex).toBe(-1);
    expect(pane.textContent).toContain('All green.');
    expect(pane.textContent).not.toContain('It works.');
  });
});

describe('the tablist survives a scroll', () => {
  it('draws the header, the action row and the tablist inside ONE sticky container', () => {
    webview.render(state());
    const chrome = dom.document.body.byClass('item-chrome')[0];
    expect(chrome).toBeDefined();
    expect(chrome.children.map((c) => c.className)).toEqual([
      'item-header',
      'button-group',
      'part-switcher',
    ]);
    expect(tablist()?.parentNode).toBe(chrome);
  });
});

describe('the selected tab is on screen at 400px', () => {
  it('scrolls it into view when the selection changes, and not otherwise', () => {
    webview.render(state({ focus: { kind: 'ticket' } }));
    const qa = () => tabs()[0];
    const before = qa().scrolledIntoView;
    webview.render(state());
    expect(qa().scrolledIntoView).toBe(before + 1);
    // A re-render over the same selection leaves a hand-scrolled strip where the user put it.
    webview.render(state());
    expect(qa().scrolledIntoView).toBe(before + 1);
  });
});

describe('the keyboard model is roving, and arrow-select acts', () => {
  it('ArrowRight moves to the next part and selects it', () => {
    webview.render(state());
    tablist()?.emit('keydown', { key: 'ArrowRight' });
    expect(posted()).toEqual([
      { type: 'setFocus', focus: { kind: 'artifact', sessionId: 's1', name: 'REVIEW.md' } },
    ]);
  });

  it('ArrowLeft from the first part stays put rather than wrapping off the end', () => {
    webview.render(state());
    tablist()?.emit('keydown', { key: 'ArrowLeft' });
    expect(posted()).toEqual([]);
  });

  it('Home and End jump to the first and the last part', () => {
    webview.render(state({ focus: { kind: 'ticket' } }));
    tablist()?.emit('keydown', { key: 'End' });
    tablist()?.emit('keydown', { key: 'Home' });
    expect(posted().map((m) => (m as { focus: { kind: string } }).focus.kind)).toEqual([
      'pr',
      'artifact',
    ]);
  });

  it('Enter and Space are no-ops — arrow-select already acted', () => {
    webview.render(state());
    tablist()?.emit('keydown', { key: 'Enter' });
    tablist()?.emit('keydown', { key: ' ' });
    expect(posted()).toEqual([]);
  });

  it('a click on a tab selects that part', () => {
    webview.render(state());
    tabs()[2].emit('click');
    expect(posted()).toEqual([{ type: 'setFocus', focus: { kind: 'ticket' } }]);
  });
});

describe('§6 the action row draws one filled button', () => {
  it('carries the placement the host decided onto the class', () => {
    webview.render(
      state({
        buttons: [
          { id: 'cgremlin.startReview', label: 'Start review', enabled: true, placement: 'primary' },
          { id: 'cgremlin.chat', label: 'Chat', enabled: true, placement: 'inline' },
        ],
      } as unknown as Partial<ItemTabState>),
    );
    expect(dom.document.body.byClass('buttons')[0].children.map((b) => b.className)).toEqual([
      'action primary',
      'action inline',
    ]);
  });
});

describe('MG-17e the same data mutates nothing', () => {
  it('renders twice over identical data and writes nothing at all', () => {
    webview.render(state());
    const focused = dom.document.activeElement;
    dom.document.clearLog();
    webview.render(state());
    expect(dom.document.writes).toEqual([]);
    expect(dom.document.activeElement).toBe(focused);
  });

  it('moves the caret onto the pane when the selected part changes', () => {
    webview.render(state());
    webview.render(state({ focus: { kind: 'ticket' } }));
    expect(dom.document.activeElement).toBe(panels()[0]);
  });
});
