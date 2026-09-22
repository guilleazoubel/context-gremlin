/**
 * Task 2 — "how do i see if they ran? … i would like … to be able to see if they passed."
 *
 * HB-1490's collapsed row said `⛋ ready`. `ready` is the word EVERY finished agent's phase reads
 * as — a review at `ready` draws `◈ ready` — so the one row that had a QA verdict on it looked
 * exactly like a row that had merely finished something. It was also silent about the two things
 * that decide whether the verdict still holds: which QA build it is about, and whether that build
 * is the one QA is serving. Four re-verifications against four builds is the normal case here.
 *
 * So the row says the verdict in words, names the build beside it, and marks a verdict that is
 * about an older build than the one QA now serves. Nothing is invented: `qaVerdict`, `qaDeploy`
 * and `runOutcome` are all already on the wire (verified against the live engine).
 */
import { describe, expect, it } from 'vitest';
import { toRow, type RowMetaCell, type WorkItem } from '../../src/model/work-items';
import { itemActionFacts } from '../../src/model/row-actions';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { rowActions } from '../../src/model/row-actions';
import { hb1490, qaAgent, QA_REPOS, QA_STATUSES } from '../support/hb-1490';

const NOW = Date.parse('2026-09-22T20:00:00.000Z');
const AWAITING = { state: 'awaiting', sha: 'abcdef1234567890' } as WorkItem['qaDeploy'];

function cells(item: WorkItem): RowMetaCell[] {
  return toRow(item, 'myWork', NOW).meta;
}

function qaCell(item: WorkItem): RowMetaCell {
  const found = cells(item).find((cell) => cell.text.startsWith('⛋'));
  if (found === undefined) throw new Error(`no QA cell in: ${cells(item).map((c) => c.text).join(' | ')}`);
  return found;
}

function qaPartText(item: WorkItem): string {
  const facts = itemActionFacts(item, QA_REPOS, QA_STATUSES);
  const parts = itemParts({
    item,
    list: 'myWork',
    qaRepos: QA_REPOS,
    qaStatuses: QA_STATUSES,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions: rowActions(facts, 'myWork'),
    now: NOW,
  });
  const qa = parts.find((part) => part.kind === 'qa');
  if (qa === undefined) throw new Error('no QA part');
  return qa.stateText;
}

describe('a verification that passed reads as passed, with the build it is about', () => {
  it('says the verdict in words rather than the phase every agent shares', () => {
    expect(qaCell(hb1490()).text).toBe('⛋ QA ready to deploy');
  });

  it('names the QA build the verdict is for, on the same line', () => {
    expect(cells(hb1490()).map((cell) => cell.text)).toContain('build 0853456');
  });

  it('says the same words in the block the row opens into', () => {
    expect(qaPartText(hb1490())).toBe('ready to deploy');
  });
});

describe('a verdict about an older build never reads as a verdict about this one', () => {
  const stale = hb1490({ qaDeploy: AWAITING });

  it('marks the verdict as being about an older build', () => {
    expect(qaCell(stale).text).toBe('⛋ QA ready to deploy · older build');
    expect(qaCell(stale).tone).toBe('warn');
  });

  it('and the expanded block says it too', () => {
    expect(qaPartText(stale)).toBe('ready to deploy · older build');
  });
});

describe('the other four states a person has to tell apart', () => {
  it('a verification in flight reads as running', () => {
    const live = hb1490({
      agents: [qaAgent({ phase: 'verifying', running: true, qaVerdict: null, runOutcome: 'running' })],
    });
    expect(qaCell(live).text).toBe('⛋ QA verifying');
    expect(qaCell(live).tone).toBe('active');
  });

  it('an item nothing has ever verified says so, rather than saying nothing', () => {
    const never = hb1490({ agents: [], qaDeploy: null });
    expect(qaCell(never).text).toBe('⛋ QA not verified');
  });

  it('a verification that came back not ready says not ready', () => {
    const bad = hb1490({
      agents: [qaAgent({ phase: 'not_ready', qaVerdict: 'not_ready' })],
    });
    expect(qaCell(bad).text).toBe('⛋ QA not ready');
    expect(qaCell(bad).tone).toBe('bad');
  });

  it('a verification the agent could not perform reads as blocked, not as not-ready', () => {
    const blocked = hb1490({ agents: [qaAgent({ phase: 'not_ready', qaVerdict: 'blocked' })] });
    expect(qaCell(blocked).text).toBe('⛋ QA blocked');
    expect(qaCell(blocked).tone).toBe('bad');
  });

  it('a run that DIED claims no verdict at all', () => {
    const dead = hb1490({
      agents: [qaAgent({ phase: 'verifying', qaVerdict: null, runOutcome: 'failed', runFailed: true })],
    });
    expect(qaCell(dead).text).toBe('⛋ QA run failed');
    expect(qaCell(dead).tone).toBe('bad');
  });

  it('a run that was KILLED claims no verdict either', () => {
    const killed = hb1490({
      agents: [qaAgent({ phase: 'verifying', qaVerdict: null, runOutcome: 'stopped' })],
    });
    expect(qaCell(killed).text).toBe('⛋ QA run stopped');
  });
});
