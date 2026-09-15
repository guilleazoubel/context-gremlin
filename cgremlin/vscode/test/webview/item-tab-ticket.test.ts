/**
 * Phase 17 §5a/§5b / task 9 — MG-17a and MG-17b, on the rendered DOM.
 *
 * Two defects the user saw in one screenshot. The title was printed three times: the header's
 * `h1`, the ticket section's own `h2`, and the artifact's `# ` first line. And the description
 * was a grey monospace box — not a rendering decision, a literal `el('pre','ticket-description')`
 * where `renderInline` had existed, unused, all along.
 */
import { describe, expect, it } from 'vitest';
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemFocusMessage, ItemTabState, TabTicket } from '../../src/model/item-tab-protocol';

const SAME = 'HB-1489 — Add web-content read endpoint';

function ticket(over: Partial<TabTicket> = {}): TabTicket {
  return {
    key: 'HB-1489',
    summary: 'Add web-content read endpoint',
    status: 'UAT',
    url: 'https://jira/HB-1489',
    assignee: '712020:f0ac',
    assigneeName: 'Guilherme Azoubel',
    descriptionText: 'A read-only endpoint.\n\n- Must accept a locale\n- Must 404 on a bad slug\n',
    comments: [
      { author: 'Ana Silva', at: '12 Aug', bodyText: 'Please keep the slug **case-sensitive**.' },
      { author: 'Bo', at: '11 Aug', bodyText: 'earlier one' },
      { author: 'Cy', at: '10 Aug', bodyText: 'earlier two' },
    ],
    ...over,
  } as TabTicket;
}

function state(one: TabTicket, focus?: ItemFocusMessage): ItemTabState {
  const built = {
    itemId: 'i',
    title: SAME,
    needsYou: false,
    lists: [],
    chips: [],
    focus: { kind: 'ticket' },
    selectedSessionId: null,
    agents: [],
    prs: [],
    ticket: one,
    ticketError: null,
    buttons: [],
    parts: [],
  } as unknown as ItemTabState;
  built.parts = partsOf(built);
  built.focus = focus ?? { kind: 'ticket' };
  return built;
}

const description = () => dom.document.body.byClass('ticket-description')[0];
const hasPreAncestor = (node: { parentNode: unknown; tagName: string } | undefined): boolean => {
  let at = node as { parentNode: { tagName: string; parentNode: unknown } | null } | undefined;
  while (at?.parentNode != null) {
    if (at.parentNode.tagName === 'PRE') return true;
    at = at.parentNode as never;
  }
  return false;
};

describe('MG-17a the title appears exactly once', () => {
  it('prints one element carrying the title, not three', () => {
    webview.render(state(ticket()));
    const carriers = dom.document.body.findAll(
      (el) => el.children.length === 0 && el.textContent === SAME,
    );
    expect(carriers).toHaveLength(1);
    expect(carriers[0].className).toBe('item-title-text');
  });

  it('gives the ticket pane no heading of its own — the tab names it', () => {
    webview.render(state(ticket()));
    const pane = dom.document.body.byClass('ticket-pane')[0];
    expect(pane.findAll((el) => el.tagName === 'H2')).toEqual([]);
  });
});

describe('MG-17b the ticket prose is prose', () => {
  it('renders the description as markdown, with no PRE ancestor', () => {
    webview.render(state(ticket()));
    expect(description().tagName).toBe('DIV');
    expect(hasPreAncestor(description())).toBe(false);
    expect(description().findAll((el) => el.tagName === 'LI')).toHaveLength(2);
  });

  it('still renders a fenced code sample as code, and only as code', () => {
    webview.render(state(ticket({ descriptionText: 'see:\n\n```\nGET /x\n```\n' })));
    const pres = description().findAll((el) => el.tagName === 'PRE');
    expect(pres).toHaveLength(1);
    expect(pres[0].textContent).toContain('GET /x');
  });

  it('renders a comment body as prose too', () => {
    webview.render(state(ticket()));
    // The newest comment reads LAST, under the collapsed earlier ones, so the column runs
    // oldest to newest the way a thread does.
    const body = dom.document.body.byClass('newest-comment')[0].byClass('ticket-comment-body')[0];
    expect(body.tagName).toBe('DIV');
    expect(body.find((el) => el.tagName === 'STRONG')?.textContent).toBe('case-sensitive');
  });
});

describe('§5d the assignee has a name, and the id is the honest fallback', () => {
  it('prints the display name when the wire carries one', () => {
    webview.render(state(ticket()));
    expect(dom.document.body.byClass('ticket-meta')[0].textContent).toBe(
      'UAT · Guilherme Azoubel',
    );
  });

  it('falls back to the account id rather than hiding who it is', () => {
    webview.render(state(ticket({ assigneeName: null })));
    expect(dom.document.body.byClass('ticket-meta')[0].textContent).toBe('UAT · 712020:f0ac');
  });
});

describe('§1 the newest comment is open and the rest are behind one disclosure', () => {
  it('collapses comments 2..n and counts them', () => {
    webview.render(state(ticket()));
    const disclosure = dom.document.body.byClass('earlier-comments')[0];
    expect(disclosure.tagName).toBe('DETAILS');
    expect(disclosure.find((el) => el.tagName === 'SUMMARY')?.textContent).toBe(
      '2 earlier comments',
    );
    expect(disclosure.getAttribute('open')).toBeNull();
    expect(dom.document.body.byClass('ticket-comment')).toHaveLength(3);
  });

  it('draws no disclosure at all when there is only one comment', () => {
    webview.render(state(ticket({ comments: [{ author: 'A', at: 'x', bodyText: 'only' }] })));
    expect(dom.document.body.byClass('earlier-comments')[0].hidden).toBe(true);
  });
});

/**
 * The PM/designer review: `ticketError` reached the state and was rendered NOWHERE, so a failed
 * Jira read dropped the Ticket tab with no explanation — the item simply had one part fewer.
 * The error IS the pane: the tab is still there, and it says what went wrong.
 */
describe('a failed ticket read is a Ticket pane, not a missing tab', () => {
  const failed = (message: string): ItemTabState => {
    const built = {
      itemId: 'i',
      title: SAME,
      needsYou: false,
      lists: [],
      chips: [],
      focus: { kind: 'ticket' },
      selectedSessionId: null,
      agents: [],
      prs: [],
      ticket: null,
      ticketError: message,
      buttons: [],
      parts: [],
    } as unknown as ItemTabState;
    built.parts = partsOf(built);
    return built;
  };

  it('keeps the Ticket tab and puts the message on screen', () => {
    webview.render(failed('Jira refused the read: 401 Unauthorized.'));
    const tabs = dom.document.body.findAll((el) => el.getAttribute('role') === 'tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Ticket']);
    const error = dom.document.body.byClass('error')[0];
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe('Jira refused the read: 401 Unauthorized.');
  });

  it('says nothing where the read succeeded', () => {
    webview.render(state(ticket()));
    expect(dom.document.body.byClass('error')[0]?.hidden).toBe(true);
  });
});
