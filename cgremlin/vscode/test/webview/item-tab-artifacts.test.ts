/**
 * Phase 14 — the artifact pane, asserted on the RENDERED DOM.
 *
 * Two regressions this file exists to catch, both of which were invisible before it:
 *  1. an artifact rendered as PLAIN TEXT instead of markdown. `innerHTML` did not exist on the
 *     fake DOM at all, so nothing ever looked at the one place markdown-it's output lands. The
 *     assertions below are about ELEMENTS — a real `H1` node — never about a string that happens
 *     to contain `<h1>`.
 *  2. the BRIEF presented as if it were the REVIEW. A brief's own first line is
 *     `# REVIEW — PR #2061`, so a block labelled only `BRIEF.md · <iso>` reads as the verdict.
 */
import { describe, expect, it } from 'vitest';
// Import order matters: this installs the DOM globals the webview module reaches for at load.
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { BRIEF_ONLY_NOTICE } from '../../src/model/artifact-labels';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

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

function state(one: TabAgent): ItemTabState {
  return {
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
    focus: { kind: 'agent', sessionId: 's1' },
  } as unknown as ItemTabState;
}

const bodyOf = (name: string) =>
  dom.document.body.find((el) => el.className === 'artifact-body' && (el.parentNode?.id ?? '').endsWith(name));

describe('an artifact renders as MARKDOWN, not as text', () => {
  it('a REVIEW.md body contains a real heading ELEMENT, not a text node', () => {
    webview.render(state(agent(['REVIEW.md'], { 'REVIEW.md': REVIEW })));
    const body = bodyOf('REVIEW.md');
    expect(body).toBeDefined();
    expect(body?.children.map((c) => c.tagName)).toContain('H1');
    expect(body?.find((c) => c.tagName === 'H2')?.textContent).toBe('Findings');
    // The characters `# Review` must NOT survive anywhere as literal text.
    expect(body?.textContent).not.toContain('# Review');
  });

  it('a BRIEF.md body renders as markdown too', () => {
    webview.render(state(agent(['BRIEF.md'], { 'BRIEF.md': BRIEF })));
    const body = bodyOf('BRIEF.md');
    expect(body?.children.map((c) => c.tagName)).toContain('H1');
    expect(body?.find((c) => c.tagName === 'STRONG')?.textContent).toBe('ticket');
  });
});

describe('the tab never presents the brief as the review', () => {
  it('labels each artifact by what it IS', () => {
    webview.render(
      state(agent(['BRIEF.md', 'REVIEW.md'], { 'BRIEF.md': BRIEF, 'REVIEW.md': REVIEW })),
    );
    const labels = dom.document.body.byClass('artifact-label').map((el) => el.textContent);
    expect(labels).toEqual(['Review', 'Brief — the instructions this agent was given']);
  });

  it('puts the review first even when the brief is listed first', () => {
    webview.render(
      state(agent(['BRIEF.md', 'REVIEW.md'], { 'BRIEF.md': BRIEF, 'REVIEW.md': REVIEW })),
    );
    const ids = dom.document.body.byClass('artifact').map((el) => el.id);
    expect(ids[0]).toContain('REVIEW.md');
  });

  it('says so, above the brief, when the brief is all there is', () => {
    webview.render(state(agent(['BRIEF.md'], { 'BRIEF.md': BRIEF })));
    const notice = dom.document.body.byClass('artifact-notice')[0];
    expect(notice?.textContent).toBe(BRIEF_ONLY_NOTICE);
    const focus = dom.document.body.byClass('agent-focus')[0];
    const order = (focus?.children ?? []).map((c) => c.className);
    expect(order.indexOf('artifact-notice')).toBeLessThan(order.indexOf('artifact'));
  });

  it('does not say it once a review exists', () => {
    webview.render(
      state(agent(['BRIEF.md', 'REVIEW.md'], { 'BRIEF.md': BRIEF, 'REVIEW.md': REVIEW })),
    );
    expect(dom.document.body.byClass('artifact-notice')).toEqual([]);
  });
});
