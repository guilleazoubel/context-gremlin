/**
 * Phase 17 §3 / task 10 — MG-17c, the verdict above the fold.
 *
 * A review carries a verdict, per-finding severities and a status per finding, and the tab
 * rendered all of it as undifferentiated markdown — the answer was somewhere in the scroll. The
 * strip lifts it to the first thing on the pane, and says NOTHING where it read nothing: an
 * absent strip means "unstructured", where a `0 findings` would mean "clean".
 */
import { describe, expect, it } from 'vitest';
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

const REVIEW = [
  '# PR Review: #2180 — Add web-content read endpoint',
  '**Verdict:** \u{1F504} Request changes — the endpoint ignores the locale parameter',
  '**Does it do what the ticket asked?** mostly',
  '',
  '## Details',
  '',
  '<a id="f1"></a>',
  '### 1. Locale parameter is dropped',
  '- **Severity:** \u{1F534} Critical',
  '- **Where:** `web-content.ts:88`',
  '',
  '<a id="f2"></a>',
  '### 2. Route and mapper mixed',
  '- **Severity:** \u{1F527} Maintainability',
  '',
  'See [1](#f1) for the blocking one.',
  '',
].join('\n');

const QA = ['# QA', '', '## QA Verdict', '', '- Verdict: ✅ Ready to deploy', ''].join('\n');
const PROSE = '# Notes\n\nI read the diff and it seemed fine.\n';

function agentWith(name: string, text: string): TabAgent {
  return {
    sessionId: 's1',
    mode: 'review',
    phase: 'reviewing',
    running: false,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: name,
    artifacts: [{ sessionId: 's1', name, mtime: 'm', text }],
  } as TabAgent;
}

function state(name: string, text: string): ItemTabState {
  const built = {
    itemId: 'i',
    title: 'PR Review: #2180 — Add web-content read endpoint',
    needsYou: false,
    lists: [],
    chips: [],
    focus: { kind: 'agent', sessionId: 's1' },
    selectedSessionId: 's1',
    agents: [agentWith(name, text)],
    prs: [],
    ticket: null,
    ticketError: null,
    buttons: [],
    parts: [],
  } as unknown as ItemTabState;
  built.parts = partsOf(built);
  built.focus = built.parts[0].focus;
  return built;
}

const pane = () => dom.document.body.byClass('artifact-pane')[0];
const strip = () => dom.document.body.byClass('verdict-strip')[0];

describe('MG-17c the verdict is the first thing on the pane', () => {
  it('lifts a review’s verdict, its sentence and its tone above the fold', () => {
    webview.render(state('REVIEW.md', REVIEW));
    // The dateline is one 11px line; the verdict is still the first BLOCK, and above the body.
    const order = pane().children.map((c) => c.className);
    expect(order[0]).toBe('artifact-meta');
    expect(order[1]).toContain('verdict-strip');
    expect(order.indexOf('artifact-body')).toBeGreaterThan(1);
    expect(strip().getAttribute('role')).toBe('status');
    expect(strip().hidden).toBe(false);
    expect(strip().className).toContain('tone-mixed');
    expect(dom.document.body.byClass('verdict-line')[0].textContent).toBe(
      'Request changes — the endpoint ignores the locale parameter',
    );
  });

  it('prints the ticket answer and the severity counts, zero counts omitted', () => {
    webview.render(state('REVIEW.md', REVIEW));
    const counts = dom.document.body.byClass('verdict-counts')[0];
    expect(counts.children.map((c) => c.textContent)).toEqual([
      'Ticket: mostly',
      '1 critical',
      '1 maintainability',
    ]);
    expect(counts.textContent).not.toContain('0 ');
  });

  it('gives the ticket answer no dot — `Ticket: mostly` is an answer, not a severity', () => {
    webview.render(state('REVIEW.md', REVIEW));
    const counts = dom.document.body.byClass('verdict-counts')[0];
    // The dot is drawn by `.verdict-count::before`, so the count of that class IS the dot count.
    expect(counts.byClass('verdict-count').map((c) => c.textContent)).toEqual([
      '1 critical',
      '1 maintainability',
    ]);
    expect(counts.byClass('verdict-answer')[0]?.textContent).toBe('Ticket: mostly');
  });

  it('lifts an old QA file’s frozen `- Verdict:` line the same way (MG-17j)', () => {
    webview.render(state('QA.md', QA));
    expect(strip().hidden).toBe(false);
    expect(strip().className).toContain('tone-pass');
    expect(dom.document.body.byClass('verdict-line')[0].textContent).toBe('Ready to deploy');
  });

  it('draws no strip and NO fabricated zero for an artifact it could not parse', () => {
    webview.render(state('REVIEW.md', PROSE));
    expect(strip().hidden).toBe(true);
    expect(dom.document.body.byClass('verdict-counts')[0].textContent).toBe('');
  });
});

describe('§5a the artifact’s own title is not a third copy of the item’s', () => {
  it('strips the leading `# ` line from the body', () => {
    webview.render(state('REVIEW.md', REVIEW));
    const body = dom.document.body.byClass('artifact-body')[0];
    expect(body.findAll((el) => el.tagName === 'H1')).toEqual([]);
    expect(body.textContent).not.toContain('Add web-content read endpoint');
  });
});

describe('§2 intra-report jumps stay inside the pane', () => {
  it('scrolls to the synthesised anchor instead of navigating', () => {
    webview.render(state('REVIEW.md', REVIEW));
    const body = dom.document.body.byClass('artifact-body')[0];
    const link = body.find((el) => el.tagName === 'A' && el.getAttribute('href') === '#f1');
    expect(link).toBeDefined();
    let prevented = false;
    link?.emit('click', { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(dom.document.body.find((el) => el.id === 'f1')?.scrolledIntoView).toBe(1);
    expect(dom.posted.filter((m) => (m as { type?: string }).type === 'openLink')).toEqual([]);
  });
});
