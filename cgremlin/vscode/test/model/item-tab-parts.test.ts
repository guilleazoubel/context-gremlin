/**
 * Phase 17 task 7 — the item's parts, as ONE ordered list, and the focus that addresses one.
 *
 * The defect: `ItemFocusMessage` could address an agent, the ticket or a PR — never one artifact —
 * so the tab had no way to put a single document on screen and rendered them all into one scroll.
 * The union gains `{kind:'artifact'}`, and the part list is what the tablist draws.
 */
import { describe, expect, it } from 'vitest';
import { artifactRole, artifactTabLabel } from '../../src/model/artifact-labels';
import { partsOf } from '../../src/model/item-tab-parts';
import { parseWebviewMessage } from '../../src/model/item-tab-protocol';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

function agent(names: readonly string[]): TabAgent {
  return {
    sessionId: 's1',
    mode: 'review',
    phase: 'reviewing',
    running: false,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: 'REVIEW.md',
    artifacts: names.map((name) => ({ sessionId: 's1', name, mtime: '', text: null })),
  };
}

function state(one: TabAgent | null, extra: Partial<ItemTabState> = {}): ItemTabState {
  return {
    itemId: 'i',
    title: 't',
    needsYou: false,
    lists: [],
    chips: [],
    focus: { kind: 'ticket' },
    selectedSessionId: one === null ? null : one.sessionId,
    agents: one === null ? [] : [one],
    prs: [],
    ticket: null,
    ticketError: null,
    buttons: [],
    parts: [],
    ...extra,
  } as unknown as ItemTabState;
}

describe('DEVELOPMENT.md is a role of its own', () => {
  it('no longer falls to `other`', () => {
    expect(artifactRole('DEVELOPMENT.md')).toBe('development');
    expect(artifactTabLabel('DEVELOPMENT.md')).toBe('Development');
  });

  it('names every other role in one short word for a tab', () => {
    expect(artifactTabLabel('QA.md')).toBe('QA');
    expect(artifactTabLabel('RE-REVIEW.md')).toBe('Review');
    expect(artifactTabLabel('BRIEF.md')).toBe('Brief');
    expect(artifactTabLabel('NOTES.md')).toBe('NOTES.md');
  });
});

describe('partsOf — the selected agent’s artifacts, then the ticket, then one per PR', () => {
  // §1 cites `PRIMARY_ORDER`, "primary first, brief last" — so the answer the user came for
  // leads, which for a session that has been verified is the QA report, not the review.
  it('orders the artifacts primary-first and brief-last, then appends ticket and PR', () => {
    const one = state(agent(['BRIEF.md', 'REVIEW.md', 'QA.md']), {
      ticket: { key: 'HB-1489' } as never,
      prs: [{ repo: 'acme/web', number: 2180 } as never],
    });
    expect(partsOf(one).map((p) => p.label)).toEqual(['QA', 'Review', 'Brief', 'Ticket', '#2180']);
    expect(partsOf(one)[0].focus).toEqual({ kind: 'artifact', sessionId: 's1', name: 'QA.md' });
    expect(partsOf(one)[3].focus).toEqual({ kind: 'ticket' });
    expect(partsOf(one)[4].focus).toEqual({ kind: 'pr', repo: 'acme/web', number: 2180 });
  });

  it('gives every part a distinct key, so the tablist reconciles by identity', () => {
    const parts = partsOf(
      state(agent(['REVIEW.md']), { ticket: { key: 'HB-1' } as never }),
    );
    expect(new Set(parts.map((p) => p.key)).size).toBe(parts.length);
    expect(parts[0].key).toBe('artifact:s1/REVIEW.md');
    expect(parts[1].key).toBe('ticket');
  });

  it('is empty for an item with nothing to read', () => {
    expect(partsOf(state(null))).toEqual([]);
  });
});

describe('the focus union carries an artifact', () => {
  it('parses a well-formed artifact focus off the untrusted channel', () => {
    expect(
      parseWebviewMessage({
        type: 'setFocus',
        focus: { kind: 'artifact', sessionId: 's1', name: 'REVIEW.md', extra: 1 },
      }),
    ).toEqual({ type: 'setFocus', focus: { kind: 'artifact', sessionId: 's1', name: 'REVIEW.md' } });
  });

  it('refuses one with a missing or wrongly typed field', () => {
    for (const focus of [
      { kind: 'artifact', sessionId: 's1' },
      { kind: 'artifact', name: 'REVIEW.md' },
      { kind: 'artifact', sessionId: 's1', name: 12 },
      { kind: 'artifact', sessionId: '', name: 'REVIEW.md' },
    ]) {
      expect(parseWebviewMessage({ type: 'setFocus', focus })).toBeNull();
    }
  });
});
