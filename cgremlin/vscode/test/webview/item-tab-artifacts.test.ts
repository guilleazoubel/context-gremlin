/**
 * Phase 14, re-stated for phase 17's reading layout — the artifact PANE, on the rendered DOM.
 *
 * Rewritten rather than amended: phase 17 deleted the `<details>` accordion this file used to
 * assert on, because an artifact is a pane now and one part is on screen at a time. The two
 * regressions it exists to catch are unchanged, and both still matter:
 *  1. an artifact rendered as PLAIN TEXT instead of markdown. The assertions are about ELEMENTS —
 *     a real heading node — never about a string that happens to contain `<h1>`.
 *  2. the BRIEF presented as if it were the REVIEW. A brief's own first line is
 *     `# REVIEW — PR #2061`, so a pane that said nothing would read as the verdict.
 */
import { describe, expect, it } from 'vitest';
// Import order matters: this installs the DOM globals the webview module reaches for at load.
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { BRIEF_ONLY_NOTICE } from '../../src/model/artifact-labels';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemFocusMessage, ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

const BRIEF = '# REVIEW — PR #2061\n\nTIER 0 — Intent gate. Read the **ticket** first.\n';
const REVIEW = '# Review\n\n## Findings\n\n- one thing\n';

function agent(names: readonly string[], bodies: Record<string, string>): TabAgent {
  return {
    sessionId: 's1',
    mode: 'review',
    phase: 'dismissed',
    running: false,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: null,
    artifacts: names.map((name) => ({
      sessionId: 's1',
      name,
      mtime: '2026-09-15T16:00:08.000Z',
      text: bodies[name] ?? null,
    })),
  } as TabAgent;
}

function state(one: TabAgent, focus?: ItemFocusMessage): ItemTabState {
  const built = {
    itemId: 'session:s1',
    title: 'PR #2061',
    needsYou: false,
    chips: [],
    buttons: [],
    agents: [one],
    selectedSessionId: 's1',
    prs: [],
    ticket: null,
    ticketError: null,
    lists: [],
    parts: [],
    focus: { kind: 'agent', sessionId: 's1' },
  } as unknown as ItemTabState;
  built.parts = partsOf(built);
  // The host opens on the primary part; a test that wants another one names it.
  built.focus = focus ?? built.parts[0].focus;
  return built;
}

const pane = () => dom.document.body.byClass('artifact-body')[0];
const tabLabels = () =>
  dom.document.body.findAll((el) => el.getAttribute('role') === 'tab').map((el) => el.textContent);

describe('an artifact renders as MARKDOWN, not as text', () => {
  it('a REVIEW.md body contains a real heading ELEMENT, not a text node', () => {
    webview.render(state(agent(['REVIEW.md'], { 'REVIEW.md': REVIEW })));
    expect(pane()).toBeDefined();
    expect(pane().children.map((c) => c.tagName)).toContain('H1');
    expect(pane().find((c) => c.tagName === 'H2')?.textContent).toBe('Findings');
    // The characters `# Review` must NOT survive anywhere as literal text.
    expect(pane().textContent).not.toContain('# Review');
  });

  it('a BRIEF.md body renders as markdown too', () => {
    webview.render(state(agent(['BRIEF.md'], { 'BRIEF.md': BRIEF })));
    expect(pane().children.map((c) => c.tagName)).toContain('H1');
    expect(pane().find((c) => c.tagName === 'STRONG')?.textContent).toBe('ticket');
  });
});

describe('the tab never presents the brief as the review', () => {
  const both = { 'BRIEF.md': BRIEF, 'REVIEW.md': REVIEW };

  it('names each part by what it IS, in one word', () => {
    webview.render(state(agent(['BRIEF.md', 'REVIEW.md'], both)));
    expect(tabLabels()).toEqual(['Review', 'Brief']);
  });

  it('opens on the review even when the brief is listed first', () => {
    webview.render(state(agent(['BRIEF.md', 'REVIEW.md'], both)));
    expect(pane().textContent).toContain('one thing');
    expect(pane().textContent).not.toContain('Intent gate');
  });

  it('says so, above the body, when the brief is all there is', () => {
    webview.render(state(agent(['BRIEF.md'], { 'BRIEF.md': BRIEF })));
    const notice = dom.document.body.byClass('artifact-notice')[0];
    expect(notice.textContent).toBe(BRIEF_ONLY_NOTICE);
    expect(notice.hidden).toBe(false);
    const parent = notice.parentNode;
    const order = (parent?.children ?? []).map((c) => c.className);
    expect(order.indexOf('artifact-notice')).toBeLessThan(order.indexOf('artifact-body'));
  });

  it('does not say it once a review exists', () => {
    webview.render(state(agent(['BRIEF.md', 'REVIEW.md'], both)));
    expect(dom.document.body.byClass('artifact-notice')[0].hidden).toBe(true);
  });

  it('shows ONE artifact at a time — the other is not in the document', () => {
    webview.render(state(agent(['BRIEF.md', 'REVIEW.md'], both)));
    expect(dom.document.body.byClass('artifact-body')).toHaveLength(1);
  });
});
