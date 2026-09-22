/**
 * Task 1 — "it doesnt show the pr on the title either, just the jira number".
 *
 * The COLLAPSED ROW was never the defect: `identityKeysOf` already yields `['HB-1490', '#2037']`
 * and the row label reads `HB-1490 #2037 — Fetch Care Guide…` (pinned below so a regression there
 * is caught too). What the user was looking at is the ITEM TAB, whose title was the engine's raw
 * `WorkItem.title` — `HB-1490 — <ticket summary>`, a string that carries no pull request number
 * and never could.
 *
 * So there is one headline, composed once (`headlineOf`), and both surfaces read it.
 */
import { describe, expect, it } from 'vitest';
import { headlineOf, identityKeysOf } from '../../src/model/row-composition';
import { toRow } from '../../src/model/work-items';
import { hb1490 } from '../support/hb-1490';

const NOW = Date.parse('2026-09-22T20:00:00.000Z');

describe('the item headline carries the ticket key AND the pull request number', () => {
  it('is the row identity followed by the prose', () => {
    expect(headlineOf(hb1490())).toBe(
      'HB-1490 #2037 — Fetch Care Guide content through the Grace backend and reshape it to the guide contract',
    );
  });

  it('is the very line the collapsed row already draws', () => {
    const row = toRow(hb1490(), 'myWork', NOW);
    expect(row.identityKeys).toEqual(['HB-1490', '#2037']);
    expect(row.label).toBe(headlineOf(hb1490()));
  });

  it('keeps the engine title out of it: that title is the one with no PR number in it', () => {
    expect(hb1490().title).not.toContain('#2037');
    expect(headlineOf(hb1490())).toContain('#2037');
  });

  it('falls back to the identity alone where the item has no prose of its own', () => {
    const bare = hb1490({ ticket: null, title: 'aplaceformom/grace-frontend#2037' } as never);
    expect(headlineOf(bare)).toBe(
      'HB-1490 #2037 — feat(HB-1490): fetch Care Guide content through Grace and reshape to GuideContent'.replace(
        'feat(HB-1490): ',
        '',
      ),
    );
    expect(identityKeysOf(bare)).toEqual(['HB-1490', '#2037']);
  });
});
