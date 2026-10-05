/**
 * 0c Task 6 — the Item tab draws the preflight's reason as ink under the button row, and Run
 * anyway's hint as a line of its own (never a `title`: the webview assigns none, see
 * `no-tooltips.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemTabState } from '../../src/model/item-tab-protocol';

const JIRA = 'Jira HB-1 could not be loaded (auth error) — fix access or choose Run anyway';
const HINT = 'Runs without the ticket; the brief will say so';

function state(overrides: Partial<ItemTabState> = {}): ItemTabState {
  const base = {
    itemId: 'i',
    title: 'HB-1 — a ticket',
    needsYou: true,
    lists: [],
    chips: [],
    focus: { kind: 'ticket' },
    selectedSessionId: null,
    agents: [],
    prs: [],
    ticket: null,
    ticketError: null,
    buttons: [],
    parts: [],
  } as unknown as ItemTabState;
  const merged = { ...base, ...overrides } as ItemTabState;
  merged.parts = partsOf(merged);
  return merged;
}

const blockedLine = () => dom.document.body.byClass('blocked-reason')[0];
const reasonLines = () => dom.document.body.byClass('button-reason').map((el) => el.textContent);

describe('the blocked reason and the Run anyway hint', () => {
  it('draws the note and the hint, and points the button at its hint', () => {
    webview.render(
      state({
        blocked: { note: JIRA, runAnyway: true },
        buttons: [
          { id: 'cgremlin.runAnyway', label: 'Run anyway', enabled: true, placement: 'inline', hint: HINT },
        ],
      }),
    );
    expect(blockedLine()?.textContent).toBe(JIRA);
    expect(blockedLine()?.hidden).toBe(false);
    expect(reasonLines()).toContain(`Run anyway: ${HINT}`);
    const button = dom.document.body.find(
      (el) => el.tagName === 'BUTTON' && el.textContent === 'Run anyway',
    );
    expect(button?.getAttribute('aria-describedby')).toBe('button-reason-cgremlin-runAnyway');
  });

  it('hides the line again when the block is gone', () => {
    webview.render(state({ blocked: { note: JIRA, runAnyway: false } }));
    expect(blockedLine()?.textContent).toBe(JIRA);
    webview.render(state({ blocked: null }));
    expect(blockedLine()?.hidden).toBe(true);
    expect(reasonLines().some((line) => line.includes(HINT))).toBe(false);
  });
});
