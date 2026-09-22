/**
 * Defect 1 — a button must name the artifact it will actually OPEN.
 *
 * `inv-aplaceformom-grace-frontend-no-ticket-20260916-211103` was killed mid-flight and never
 * wrote a findings file. The core still names an artifact for it, because `pickPrimaryArtifact`
 * falls through to `WORK_FALLBACK = 'BRIEF.md'` — which is correct, there IS something to open.
 * The label was then chosen from the session's MODE instead of from the artifact that was picked,
 * so the row offered `Read the findings` and opened the agent's own orders.
 *
 * `hasRealOutput` had already been added for exactly this and the label path never asked it.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIEF_ONLY_NOTICE,
  briefOnlyNotice,
  readArtifactVerb,
} from '../../src/model/artifact-labels';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import type { WorkItem } from '../../src/model/work-items';
import { killedSession } from '../support/real-sessions';

const NOW = Date.parse('2026-09-22T14:00:00.000Z');

function partsOf(item: WorkItem) {
  const facts = itemActionFacts(item);
  return itemParts({
    item,
    list: 'investigations',
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions: rowActions(facts, 'investigations'),
    now: NOW,
  });
}

const investigationOf = (item: WorkItem) =>
  partsOf(item).find((part) => part.kind === 'investigation');

describe('the row names the artifact it opens', () => {
  it('never calls the brief `the findings` on a session that wrote none', () => {
    const part = investigationOf(killedSession());
    const labels = part?.actions.map((action) => action.label) ?? [];
    expect(labels.join(' ')).not.toMatch(/findings/i);
    expect(labels).toContain('Read the brief it was given');
  });

  it('still says `Read the findings` the moment there ARE findings', () => {
    const item = killedSession();
    item.agents[0].primaryArtifact = 'FINDINGS.md';
    expect(investigationOf(item)?.actions.map((a) => a.label)).toContain('Read the findings');
  });

  it('opens the session itself where the engine named no artifact at all', () => {
    const item = killedSession();
    item.agents[0].primaryArtifact = null;
    const labels = investigationOf(item)?.actions.map((a) => a.label) ?? [];
    expect(labels.join(' ')).not.toMatch(/findings|brief/i);
    expect(labels).toContain('Open the session');
  });

  it('the verb is one rule over the artifact, so no surface can word it differently', () => {
    expect(readArtifactVerb('BRIEF.md')).toBe('Read the brief it was given');
    expect(readArtifactVerb('FINDINGS.md')).toBe('Read the findings');
    expect(readArtifactVerb('PLAN.md')).toBe('Read the plan');
    expect(readArtifactVerb('REVIEW-v2.md')).toBe('Read the review');
    expect(readArtifactVerb('QA.md')).toBe('Read the QA result');
    expect(readArtifactVerb('NOTES.md')).toBe('Read NOTES.md');
    expect(readArtifactVerb(null)).toBe('Open the session');
  });
});

describe('the tab says which document it is showing', () => {
  it('names the findings this investigation never wrote, never a review', () => {
    const notice = briefOnlyNotice('investigation');
    expect(notice).toContain('findings');
    expect(notice).not.toMatch(/review/i);
    expect(notice).toContain('brief');
  });

  it('keeps the sentence a review session already had', () => {
    expect(briefOnlyNotice('review')).toBe(BRIEF_ONLY_NOTICE);
  });

  it('says `report` rather than guessing when the mode is one it does not know', () => {
    expect(briefOnlyNotice('something-new')).toContain('report');
  });
});
