/**
 * 0c Task 6 — the engine's preflight refused to start a headless run, and said why in one line
 * of `AGENT_NOTE` (`Jira …` or `GitHub …`). The panel used to word that as the bare
 * "needs input", and a blocked review left at `ready` kept reading as ready.
 *
 * The note is the reason wherever the item is actually in `needs_input` — and nowhere else: a
 * later run leaves a stale note on disk, and the engine sends it only during needs-input.
 */
import { describe, expect, it } from 'vitest';
import itemsFixture from '../support/fixtures/items.json';
import { needsYouEntries, preflightBlockOf } from '../../src/model/needs-you';
import { rowMetaCells } from '../../src/model/row-composition';
import { lifecycleSlots } from '../../src/model/lifecycle';
import type { ActionFacts } from '../../src/model/row-actions';
import type { ItemsResponse, WorkItem, WorkItemAgent } from '../../src/model/work-items';

const JIRA = 'Jira HB-627 could not be loaded (auth error) — fix access or choose Run anyway';
const GITHUB = 'GitHub is not usable: gh api user failed (exit 1)';
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const PARTS = { age: '2h', size: 'S', tier: 'S', activity: '', repo: 'web' };

function fixtureItem(id: string): WorkItem {
  const all = (JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse).items;
  const found = all.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no fixture item ${id}`);
  return found;
}

/** `pr:acme/web#102` with its one review agent finished at `ready` and the given note. */
function blockedReview(
  note: string | null,
  agent: Partial<WorkItemAgent> = {},
  reasons: string[] = ['needs_input', 'review_ready'],
): WorkItem {
  const item = fixtureItem('pr:acme/web#102');
  item.attention = { ...item.attention, reasons: reasons as WorkItem['attention']['reasons'] };
  item.agents = [{ ...item.agents[0], phase: 'ready', needsYou: true, agentNote: note, ...agent }];
  return item;
}

const texts = (item: WorkItem): string[] =>
  rowMetaCells(item, 'parkingLot', PARTS, NOW).map((cell) => cell.text);

describe('the needs-you strip says the preflight reason', () => {
  it('uses a `Jira …` note as the reason text', () => {
    expect(needsYouEntries([blockedReview(JIRA)])[0].reason).toBe(JIRA);
  });

  it('uses a `GitHub …` note as the reason text', () => {
    expect(needsYouEntries([blockedReview(GITHUB)])[0].reason).toBe(GITHUB);
  });

  it('keeps the bare reason when there is no note (behaviour unchanged)', () => {
    expect(needsYouEntries([blockedReview(null)])[0].reason).toBe('needs input');
    // An engine older than the field sends none at all.
    const old = blockedReview(null);
    delete (old.agents[0] as { agentNote?: unknown }).agentNote;
    expect(needsYouEntries([old])[0].reason).toBe('needs input');
  });

  it('ignores a note that is not the preflight’s (an agent’s own needs-input line)', () => {
    const own = blockedReview('plan review stuck — needs your input');
    expect(needsYouEntries([own])[0].reason).toBe('needs input');
  });

  it('ignores a note when the item is not in needs_input (a stale note)', () => {
    const stale = blockedReview(JIRA, {}, ['review_ready']);
    expect(needsYouEntries([stale])[0].reason).toBe('review ready');
    expect(preflightBlockOf(stale)).toBeNull();
  });

  it('ignores a note on an agent that is running again', () => {
    expect(preflightBlockOf(blockedReview(JIRA, { running: true }))).toBeNull();
  });
});

describe('preflightBlockOf — "Run anyway" re-issues the ENGINE\'s stage, and only for Jira', () => {
  it('the stage is the engine\'s `blockedStage`, never a guess from the phase', () => {
    expect(preflightBlockOf(blockedReview(JIRA, { blockedStage: 'rereview' }))).toEqual({
      sessionId: 'pr-acme-web-102',
      note: JIRA,
      stage: 'rereview',
      runAnyway: true,
    });
    // The wrong-stage scenario: a re-review that FAILED, retried, then blocked. Its phase is
    // `failed`, which a guess would have read as `review` — overwriting REVIEW.md.
    expect(
      preflightBlockOf(blockedReview(JIRA, { phase: 'failed', blockedStage: 'rereview' }))?.stage,
    ).toBe('rereview');
    expect(
      preflightBlockOf(blockedReview(JIRA, { mode: 'qa', phase: 'ready', blockedStage: 'verify' }))
        ?.stage,
    ).toBe('verify');
  });

  it('no blockedStage (an older engine, or the agent\'s own `Jira …` line): reason, no Run anyway', () => {
    for (const phase of ['ready', 'queued', 'failed']) {
      const block = preflightBlockOf(blockedReview(JIRA, { phase }));
      expect(block?.note).toBe(JIRA);
      expect(block?.stage).toBeNull();
      expect(block?.runAnyway).toBe(false);
    }
  });

  it('a stage the preflight never gates is dropped', () => {
    const block = preflightBlockOf(blockedReview(JIRA, { blockedStage: 'develop' as never }));
    expect(block?.stage).toBeNull();
    expect(block?.runAnyway).toBe(false);
  });

  it('a GitHub block is never skippable, even with a stage', () => {
    const block = preflightBlockOf(blockedReview(GITHUB, { blockedStage: 'review' }));
    expect(block?.note).toBe(GITHUB);
    expect(block?.runAnyway).toBe(false);
  });
});

describe('a linked-but-unavailable item never reads as ready', () => {
  it('the row cell says the note, not the phase or `review ready`', () => {
    const cells = texts(blockedReview(JIRA));
    expect(cells).toContain(`◈ ${JIRA}`);
    expect(cells.some((text) => /\bready\b/.test(text))).toBe(false);
  });

  it('a QA agent with an earlier passing verdict does not read `passed` while blocked', () => {
    const item = blockedReview(JIRA, { mode: 'qa', phase: 'ready', qaVerdict: 'ready' });
    const cells = texts(item);
    expect(cells.some((text) => text.includes('passed'))).toBe(false);
    expect(cells.some((text) => text.endsWith(JIRA))).toBe(true);
  });

  it('the bad tone marks the cell', () => {
    const cell = rowMetaCells(blockedReview(GITHUB), 'parkingLot', PARTS, NOW).find((c) =>
      c.text.endsWith(GITHUB),
    );
    expect(cell?.tone).toBe('bad');
  });

  it('with no note the cell is what it always was', () => {
    expect(texts(blockedReview(null))).toContain('◈ needs input');
  });

  it('the lifecycle slot says needs you, never done, even once the item is acked', () => {
    const agent = { ...blockedReview(JIRA).agents[0], needsYou: false, primaryArtifact: 'REVIEW.md' };
    const slots = lifecycleSlots({ agents: [agent], facts: { agents: [agent], prs: [], ticketKey: null, needsYou: false } as ActionFacts, now: NOW });
    const review = slots.find((slot) => slot.stage === 'review');
    expect(review?.state).toBe('needsYou');
    expect(review?.stateText).toBe('needs you');
  });
});
