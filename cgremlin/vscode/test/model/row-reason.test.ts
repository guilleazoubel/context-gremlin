/**
 * Round 3 §(d)/(the engine-field answer) — the collapsed row's state token is the REASON the
 * item is here, not the pipeline phase it happens to sit in.
 *
 * `◆ ready` is the whole complaint in two tokens: the glyph says which mode, the word says which
 * phase, and neither is an outcome. `attention.reasons` already carries WHY the item wants the
 * user (`review_ready`, `changes_requested`, `approved`, `run_failed`, …) and `reasonText`
 * already words it — that vocabulary was spent only on the needs-you strip. Rendering it as the
 * row's own token costs nothing and is a presentation change in the ONE composer.
 *
 * The phase survives on a RUNNING agent, where it is genuine progress, and on QA, whose token
 * (`qaStateText`) is already an outcome rather than a phase.
 */
import { describe, expect, it } from 'vitest';
import { rowMetaCells } from '../../src/model/row-composition';
import type { WorkItem, WorkItemAgent, WorkListKind } from '../../src/model/work-items';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const PARTS = { age: '23h', size: '—', tier: 'L', activity: '', repo: 'grace-frontend' };

function agent(over: Partial<WorkItemAgent> = {}): WorkItemAgent {
  return {
    sessionId: 's1',
    mode: 'review',
    phase: 'ready',
    running: false,
    needsYou: true,
    claimed: false,
    primaryArtifact: 'REVIEW.md',
    worktreePath: null,
    ref: 'session:s1',
    ...over,
  } as WorkItemAgent;
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'pr:acme/web#2140',
    kind: 'pr',
    lists: ['parkingLot'],
    demoted: false,
    parkingLotGroup: 'reviewing',
    title: 'register signup-remove-lambda',
    prs: [],
    ticket: null,
    agents: [agent()],
    needsYou: true,
    attention: { reasons: ['review_ready'], since: '', acked: false, refs: [] },
    dismissed: false,
    dismissedAt: null,
    ...over,
  } as WorkItem;
}

const textsOf = (it: WorkItem, list: WorkListKind = 'parkingLot'): string[] =>
  rowMetaCells(it, list, PARTS, NOW).map((cell) => cell.text);

describe('the collapsed row says why it is here, not which phase it is in', () => {
  it('replaces the finished agent phase with the attention reason', () => {
    const texts = textsOf(item());
    expect(texts).toContain('◈ review ready');
    expect(texts).not.toContain('◈ ready');
  });

  it('words an unknown reason rather than printing the raw token', () => {
    const texts = textsOf(
      item({ attention: { reasons: ['brand_new_reason'], since: '', acked: false, refs: [] } }),
    );
    expect(texts).toContain('◈ brand new reason');
  });

  it('keeps the phase where the item carries no reason at all', () => {
    const texts = textsOf(
      item({ needsYou: false, attention: { reasons: [], since: '', acked: false, refs: [] } }),
    );
    expect(texts).toContain('◈ ready');
  });

  it('says the reason ONCE — on the furthest finished agent, never on every one of them', () => {
    const two = item({
      agents: [
        agent({ sessionId: 's0', mode: 'investigation', phase: 'plan_ready' }),
        agent({ sessionId: 's1', mode: 'review', phase: 'ready' }),
      ],
    });
    const texts = textsOf(two, 'myWork');
    expect(texts.filter((text) => text.endsWith('review ready'))).toEqual(['◈ review ready']);
    expect(texts).toContain('∴ plan_ready');
  });

  it('leaves a RUNNING agent alone — the phase there is genuine progress', () => {
    const running = item({
      agents: [agent({ running: true, phase: 'reviewing' })],
    });
    expect(textsOf(running)).toContain('◈ reviewing');
  });
});
