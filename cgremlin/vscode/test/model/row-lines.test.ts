/**
 * Phase 11 task 2 — the row's three lines, per list.
 *
 * The user's second complaint was "the titles are almost the same". They were: `labelOf` built
 * `grace-frontend#4821 — Fix pagination…`, fourteen identical characters of repo prefix followed
 * by the only difference, and the sidebar then ellipsised the differentiating tail. So identity
 * is KEYS ONLY on line one, the prose moves to line two, and the repo — reduced to its last path
 * segment — becomes the first, shrinkable token of the signals line.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkLists,
  descriptionOf,
  identityOf,
  repoTailOf,
  type WorkListKind,
  type WorkRow,
} from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function rows(): Map<string, WorkRow> {
  const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const built = buildWorkLists({ response, now: NOW });
  const out = new Map<string, WorkRow>();
  for (const kind of Object.keys(built) as WorkListKind[]) {
    for (const section of built[kind].sections) {
      for (const row of section.rows) out.set(`${kind}/${row.id}`, row);
    }
  }
  return out;
}

const lines = (row: WorkRow): [string, string, string[]] => [
  row.identity,
  row.description,
  row.meta.map((cell) => cell.text),
];

describe('task 2 — line one is keys, line two is prose, line three is signals', () => {
  it('names a teammate’s PR by its number alone, with the repo tail on line three', () => {
    expect(lines(rows().get('parkingLot/pr:acme/web#101') as WorkRow)).toEqual([
      '#101',
      'Add the retry budget',
      ['web', '@jane', '12d', 'M', '7 files +120/−30', ''],
    ]);
  });

  it('swaps the author for who is already on it, in the someone-is-on-it group', () => {
    expect(lines(rows().get('parkingLot/pr:acme/api#55') as WorkRow)).toEqual([
      '#55',
      'Split the scheduler',
      ['api', '@dana reviewed 43h', '9d', 'XL', '42 files +900/−120', 'CI pending'],
    ]);
  });

  it('says which phase my review agent is in, for a PR I have already started', () => {
    expect(lines(rows().get('parkingLot/pr:acme/web#102') as WorkRow)).toEqual([
      '#102',
      'Drop the legacy shim',
      ['web', '◈ review_ready', '5d', 'L', '3 files +20/−400', 'CI failing'],
    ]);
  });

  it('carries both keys on a ticket that has a PR, and the ticket summary as the description', () => {
    expect(lines(rows().get('myWork/ticket:HB-627') as WorkRow)).toEqual([
      'HB-627 #310',
      'Caregiver inbox reshuffle',
      [
        'web',
        'In Progress',
        '∴ plan_ready',
        '◆ developing',
        // P: a running agent is unmistakable on the collapsed row.
        'running',
        '6d',
        'L',
        '12 files +300/−80',
        '',
      ],
    ]);
  });

  it('lets an investigation’s title BE its identity, and gives it no description line', () => {
    expect(lines(rows().get('investigations/session:inv-stacktrace-1') as WorkRow)).toEqual([
      'Investigate the nightly crash',
      '',
      ['∴ investigating', '7h'],
    ]);
  });

  it('says what landed on my own PR, and from whom', () => {
    expect(lines(rows().get('waitingForReview/pr:acme/web#200') as WorkRow)).toEqual([
      '#200',
      'Tighten the socket timeout',
      ['web', '@jane requested changes', '4d', 'M', '4 files +60/−12', ''],
    ]);
  });

  it('keeps the — placeholders for a row whose fields all defaulted (MG-12)', () => {
    expect(lines(rows().get('parkingLot/pr:acme/legacy#9') as WorkRow)).toEqual([
      '#9',
      'Bump the toolchain',
      ['legacy', '@pat', '—', '—', '—'],
    ]);
  });
});

describe('task 2 — the three builders on their own', () => {
  it('never puts a repo path or an em dash in an identity', () => {
    for (const row of rows().values()) {
      expect(row.identity, row.id).not.toContain('/');
      expect(row.identity, row.id).not.toContain('—');
    }
  });

  it('reduces the repo to its last path segment, and to nothing without a PR', () => {
    const hb = rows().get('myWork/ticket:HB-627') as WorkRow;
    expect(repoTailOf(hb.item)).toBe('web');
    expect(repoTailOf((rows().get('investigations/session:inv-stacktrace-1') as WorkRow).item)).toBe('');
  });

  it('falls back from the ticket summary to the PR title to the item’s own prose', () => {
    const hb = rows().get('myWork/ticket:HB-627') as WorkRow;
    const bare = JSON.parse(JSON.stringify(hb.item)) as WorkRow['item'];
    if (bare.ticket !== null) bare.ticket.summary = '';
    expect(descriptionOf(bare)).toBe('HB-627 inbox reshuffle (web)');
    expect(identityOf(bare)).toBe('HB-627 #310');
    bare.prs = [];
    // Item 1: dropping the PRs does not empty L2 — the core's own title still names the work,
    // minus the `HB-627 — ` head that L1 already draws.
    expect(descriptionOf(bare)).toBe('Caregiver inbox reshuffle');
    expect(identityOf(bare)).toBe('HB-627');
  });
});
