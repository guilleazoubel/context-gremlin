/**
 * Defect 1 — `done` was a FALLTHROUGH.
 *
 * Two real sessions on the user's machine proved it. One was KILLED three seconds in and wrote
 * nothing but the brief it was handed; the engine reported `running:false, needsYou:false,
 * runFailed:false`, so the panel called it **done** and offered the agent's own INPUT as its
 * output. The other FAILED with its findings complete, and read as **needs you** — the same words
 * an agent uses when it is politely asking a question.
 *
 * A slot state now derives from what the session PRODUCED and how the run ENDED.
 */
import { describe, expect, it } from 'vitest';
import { hasRealOutput, lifecycleSlots, type LifecycleAgent } from '../../src/model/lifecycle';
import { itemParts } from '../../src/model/item-parts';
import { itemActionFacts, rowActions, type ActionFacts } from '../../src/model/row-actions';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

const NOW = Date.parse('2026-09-22T14:00:00.000Z');

function agent(over: Partial<LifecycleAgent> & { mode: string }): LifecycleAgent {
  return {
    sessionId: `s-${over.mode}`,
    phase: 'findings',
    running: false,
    needsYou: false,
    primaryArtifact: null,
    ...over,
  };
}

function facts(agents: readonly LifecycleAgent[]): ActionFacts {
  return {
    agents: agents.map((a) => ({ ...a, claimed: false })),
    prs: [],
    ticketKey: null,
    needsYou: false,
  };
}

const slotsOf = (agents: readonly LifecycleAgent[]) =>
  lifecycleSlots({ agents, facts: facts(agents), now: NOW });

describe('a run that did not finish on its own', () => {
  /**
   * `inv-aplaceformom-grace-frontend-no-ticket-20260916-211103`: killed mid-run (exit 143), the
   * engine's own outcome is `stopped`, and the only file in the session dir is BRIEF.md.
   */
  it('renders a stopped run as stopped, never as done', () => {
    const killed = agent({
      mode: 'investigation',
      runOutcome: 'stopped',
      primaryArtifact: 'BRIEF.md',
    });
    const [investigation] = slotsOf([killed]);
    expect(investigation.state).toBe('stopped');
    expect(investigation.stateText).toBe('stopped · no output');
  });

  it('never calls a session done when the only artifact it has is its own brief', () => {
    const briefOnly = agent({ mode: 'investigation', primaryArtifact: 'BRIEF.md' });
    const [investigation] = slotsOf([briefOnly]);
    expect(investigation.state).not.toBe('done');
    expect(investigation.stateText).toBe('ended · no output');
    expect(hasRealOutput(briefOnly)).toBe(false);
    expect(hasRealOutput({ ...briefOnly, primaryArtifact: 'FINDINGS.md' })).toBe(true);
  });

  /**
   * `inv-aplaceformom-grace-frontend-HB-1492-20260922-135058`: the run failed, so `needsYou` is
   * true — and "needs you" is what an agent says when it is asking a question. A failure is not a
   * question; it is a thing that broke.
   */
  it('renders a failed run as failed, distinct from an agent asking a question', () => {
    const failed = agent({
      mode: 'investigation',
      runOutcome: 'failed',
      runFailed: true,
      needsYou: true,
      primaryArtifact: 'FINDINGS.md',
    });
    const asking = agent({ mode: 'investigation', needsYou: true, primaryArtifact: 'FINDINGS.md' });
    expect(slotsOf([failed])[0].state).toBe('failed');
    expect(slotsOf([failed])[0].stateText).toBe('failed · output written');
    expect(slotsOf([asking])[0].state).toBe('needsYou');
    expect(slotsOf([asking])[0].stateText).toBe('needs you');
  });

  it('still surfaces the artifact a failed run had already written', () => {
    const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
    const item = response.items.find((i) => i.id === 'ticket:HB-627') as WorkItem;
    item.agents = item.agents.map((a) =>
      a.mode === 'investigation'
        ? { ...a, needsYou: true, runFailed: true, runOutcome: 'failed', primaryArtifact: 'FINDINGS.md' }
        : a,
    );
    const rowFacts = itemActionFacts(item);
    const parts = itemParts({
      item,
      list: 'myWork',
      slots: lifecycleSlots({ agents: item.agents, facts: rowFacts, now: NOW }),
      actions: rowActions(rowFacts, 'myWork'),
      now: NOW,
    });
    const investigation = parts.find((part) => part.kind === 'investigation');
    expect(investigation?.state).toBe('failed');
    expect(investigation?.childId).toBe('agent:inv-hb-627');
    expect(investigation?.actions.map((a) => a.label)).toContain('Read the findings');
  });

  /** An engine older than this contract sends no outcome at all — and must not crash the panel. */
  it('degrades to today’s reading when the engine sends no outcome', () => {
    const finished = agent({ mode: 'investigation', primaryArtifact: 'FINDINGS.md' });
    const [slot] = lifecycleSlots({
      agents: [finished],
      facts: facts([finished]),
      artifactAt: { 's-investigation': '2026-09-22T12:00:00.000Z' },
      now: NOW,
    });
    expect(slot.state).toBe('done');
    expect(slot.stateText).toBe('done · 2h');

    const broke = agent({ mode: 'investigation', runFailed: true, needsYou: true, primaryArtifact: 'FINDINGS.md' });
    expect(slotsOf([broke])[0].state).toBe('failed');
  });
});
