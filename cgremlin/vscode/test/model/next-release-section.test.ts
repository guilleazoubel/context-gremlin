/**
 * "we should be able to differentiate on the screen between my dev work that is in QA or with me."
 *
 * The section the core's `nextRelease` list is drawn as. Membership is NOT re-derived here — the
 * panel reads `lists.nextRelease` and `item.lists`, exactly as it does for the other five (D2).
 * What this pins is that the section exists, sits where the reading order wants it, and that a
 * row does not LOSE anything by moving into it: the QA verb and the ticket status are the two
 * things the user goes to a handed-on row for.
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_SECTIONS,
  buildWorkLists,
  toRow,
  type ItemsResponse,
  type WorkItem,
} from '../../src/model/work-items';
import { itemActionFacts, showsQa } from '../../src/model/row-actions';
import { hb1490, QA_REPOS, QA_STATUSES } from '../support/hb-1490';

const NOW = Date.parse('2026-09-22T20:00:00.000Z');

function response(item: WorkItem, list: 'nextRelease' | 'myWork'): ItemsResponse {
  return {
    evaluatedAt: '2026-09-22T20:00:00.000Z',
    lists: {
      parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] },
      myWork: list === 'myWork' ? [item.id] : [],
      nextRelease: list === 'nextRelease' ? [item.id] : [],
      investigations: [],
      waitingForReview: [],
    },
    dismissed: [],
    items: [item],
    ticketSource: { kind: 'ok', error: null, scannedAt: '2026-09-22T20:00:00.000Z' },
    threadSource: { error: null, scannedAt: null },
  };
}

describe('the Next release section', () => {
  it('is drawn, titled, and sits directly after My dev work', () => {
    const keys = PANEL_SECTIONS.map((s) => s.key);
    expect(keys.indexOf('nextRelease')).toBe(keys.indexOf('myWork') + 1);
    const spec = PANEL_SECTIONS.find((s) => s.key === 'nextRelease');
    expect(spec?.title).toBe('Next release');
    expect(spec?.list).toBe('nextRelease');
    // The user asked to SEE this work: it must not start folded away.
    expect(spec?.collapsed).toBe(false);
  });

  it("puts the core's nextRelease ids under it, and leaves My dev work empty", () => {
    const item = hb1490({ lists: ['nextRelease'] });
    const built = buildWorkLists({ response: response(item, 'nextRelease'), now: NOW });
    expect(built.nextRelease.sections.flatMap((s) => s.rows.map((r) => r.id))).toEqual(['ticket:HB-1490']);
    expect(built.myWork.sections.flatMap((s) => s.rows)).toEqual([]);
    expect(built.nextRelease.title).toBe('Next release');
  });

  it('keeps the QA verb on a handed-on row — it is the row QA is actually about', () => {
    const item = hb1490({ lists: ['nextRelease'] });
    expect(showsQa(itemActionFacts(item, QA_REPOS, QA_STATUSES), 'nextRelease')).toBe(true);
  });

  it('keeps the ticket status on the row, which is what says WHICH stage it is at', () => {
    const item = hb1490({ lists: ['nextRelease'] });
    const texts = toRow(item, 'nextRelease', NOW).meta.map((cell) => cell.text);
    expect(texts).toContain('UAT');
  });
});
