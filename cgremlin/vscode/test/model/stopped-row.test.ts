/**
 * Defect 2 — the COLLAPSED row still reads a killed run as its stage name.
 *
 * A previous round put `runOutcome` on the wire and gave the panel a `stopped` state, and the
 * user is on both builds. The engine really does send it: `/items` for
 * `inv-aplaceformom-grace-frontend-no-ticket-20260916-211103` carries `runOutcome: "stopped"`,
 * and `WorkItemAgent` really does parse it.
 *
 * What was missed is WHERE. `lifecycleSlots` — the EXPANDED row — consults it; `phaseCell` in
 * `row-composition`, which composes the one token the collapsed row shows, has only ever had two
 * branches: an attention reason, else `agent.phase`. This session's `attention.reasons` is `[]`,
 * so the outcome is dropped on that line and the row says `∴ findings`, beside a `5d` age.
 */
import { describe, expect, it } from 'vitest';
import { rowMetaCells } from '../../src/model/row-composition';
import type { RowMetaCell, WorkItem } from '../../src/model/work-items';
import { killedSession } from '../support/real-sessions';

const NOW = Date.parse('2026-09-22T14:00:00.000Z');
const PARTS = { age: '5d', size: '—', tier: '', activity: '', repo: '' };

const texts = (item: WorkItem): string[] =>
  rowMetaCells(item, 'investigations', PARTS, NOW).map((cell: RowMetaCell) => cell.text);

describe('a run that was stopped says so on the collapsed row', () => {
  it('does not report the stage it was killed in as though it were a state', () => {
    const cells = texts(killedSession());
    expect(cells).not.toContain('∴ findings');
    expect(cells).toContain('∴ stopped');
  });

  it('says the same word about a failed run, and never invents one', () => {
    const item = killedSession();
    item.agents[0].runOutcome = 'failed';
    expect(texts(item)).toContain('∴ failed');
  });

  /** An engine older than the outcome contract sends none — and the row reads exactly as before. */
  it('degrades to the phase where the engine sent no outcome at all', () => {
    const item = killedSession();
    delete item.agents[0].runOutcome;
    expect(texts(item)).toContain('∴ findings');
  });

  it('leaves a RUNNING agent its phase: there the phase is genuine progress', () => {
    const item = killedSession();
    item.agents[0].running = true;
    item.agents[0].runOutcome = 'running';
    expect(texts(item)).toContain('∴ findings');
  });

  /** The attention reason still wins: it is what the item WANTS, not how the last run ended. */
  it('never displaces the reason the item is asking for the user', () => {
    const item = killedSession();
    item.attention.reasons = ['plan_ready'];
    expect(texts(item)).not.toContain('∴ stopped');
  });
});
