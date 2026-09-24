/**
 * "after it triggers a new release retest the ACs, it should show me some tag like passed in qa
 * or failed in qa so i can spot and inspect what happened."
 *
 * Two things were missing, and they are different things. The row DID carry the verdict, but in
 * the contract's own words — `ready to deploy` — which is not what a person scanning for a pass
 * is looking for. And the verdict and the build it was reached against were two separate cells,
 * so they could be read apart: on a re-test, "which run is this?" had no answer on the line.
 *
 * So the verdict is a tag in the user's words, and the build is INSIDE it — one cell, which can
 * never come apart. A re-test is then visible as what it is: the same tag naming a different
 * build. Nothing is invented: there is no QA run time on the wire, which is exactly why the row
 * anchors on the build.
 */
import { describe, expect, it } from 'vitest';
import { toRow, type RowMetaCell, type WorkItem } from '../../src/model/work-items';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { hb1490, qaAgent, QA_REPOS, QA_STATUSES } from '../support/hb-1490';

const NOW = Date.parse('2026-09-22T20:00:00.000Z');
/** The build QA served for the run that passed, and the one a new release put in front of it. */
const FIRST = '0853456d769639e7cafd9ddd7fbbc99c14575409';
const RETEST = 'f31c0a29b7e4415d0cbbf1f0b1a4a72e0f9d1c22';

const cells = (item: WorkItem): RowMetaCell[] => toRow(item, 'nextRelease', NOW).meta;
const texts = (item: WorkItem): string[] => cells(item).map((cell) => cell.text);

function qaCell(item: WorkItem): RowMetaCell {
  const found = cells(item).find((cell) => cell.text.startsWith('⛋'));
  if (found === undefined) throw new Error(`no QA cell in: ${texts(item).join(' | ')}`);
  return found;
}

function qaPart(item: WorkItem): { stateText: string; actions: string[] } {
  const facts = itemActionFacts(item, QA_REPOS, QA_STATUSES);
  const parts = itemParts({
    item,
    list: 'nextRelease',
    qaRepos: QA_REPOS,
    qaStatuses: QA_STATUSES,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions: rowActions(facts, 'nextRelease'),
    now: NOW,
  });
  const qa = parts.find((part) => part.kind === 'qa');
  if (qa === undefined) throw new Error('no QA part');
  return { stateText: qa.stateText, actions: qa.actions.map((a) => a.label) };
}

describe('the verdict is a tag a person can spot', () => {
  it('says passed, in the word the user reads it as', () => {
    expect(qaCell(hb1490()).text).toBe('⛋ QA passed · build 0853456');
  });

  it('says failed where the verification came back not ready', () => {
    const bad = hb1490({ agents: [qaAgent({ phase: 'not_ready', qaVerdict: 'not_ready' })] });
    expect(qaCell(bad).text).toBe('⛋ QA failed · build 0853456');
    expect(qaCell(bad).tone).toBe('bad');
  });

  it('keeps the build INSIDE the tag, so no second cell can drift from it', () => {
    expect(texts(hb1490())).not.toContain('build 0853456');
    expect(texts(hb1490()).filter((t) => t.includes('0853456'))).toHaveLength(1);
  });
});

describe('a re-test is visible as a re-test', () => {
  const retested = hb1490({
    qaDeploy: { state: 'verified', sha: RETEST },
    agents: [qaAgent({ phase: 'ready', qaVerdict: 'ready' })],
  });

  it("names the build this run was about, and never the one before it", () => {
    expect(qaCell(retested).text).toBe('⛋ QA passed · build f31c0a2');
    expect(texts(retested).join(' ')).not.toContain(FIRST.slice(0, 7));
  });

  it('claims no verdict at all while the re-verification is still running', () => {
    const running = hb1490({
      qaDeploy: { state: 'verified', sha: RETEST },
      agents: [qaAgent({ phase: 'verifying', running: true, qaVerdict: null, runOutcome: 'running' })],
    });
    expect(qaCell(running).text).toBe('⛋ QA verifying');
    expect(qaCell(running).text).not.toContain('passed');
  });

  it('marks a verdict QA has since moved past, and does NOT name a build for it', () => {
    const stale = hb1490({ qaDeploy: { state: 'awaiting', sha: RETEST } });
    // `awaiting` names the build QA is SERVING, which is not the build this verdict was reached
    // against — so the tag says the one true thing it has, and no sha at all.
    expect(qaCell(stale).text).toBe('⛋ QA passed · older build');
    expect(qaCell(stale).tone).toBe('warn');
  });
});

describe('and the way in to what happened', () => {
  it('says the same words in the block the row opens into', () => {
    expect(qaPart(hb1490()).stateText).toBe('passed · build 0853456');
  });

  it('offers the report the verification wrote', () => {
    expect(qaPart(hb1490()).actions).toContain('Read the QA result');
  });
});
