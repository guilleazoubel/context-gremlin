/**
 * P0-3 — the signals the user decides on are ON the row, as structured cells.
 *
 * The defect: `age` and `size` were already on the wire and already computed, then joined into
 * one `description` string that `media/panel.css:106-112` clips after the author in a 300 px
 * sidebar. This pins the *model*: one cell per signal, so the view can lay them out instead of
 * ellipsising a sentence.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkLists,
  compactAge,
  landedOf,
  stateLineOf,
  tierOf,
  type ItemsResponse,
  type RowMetaCell,
  type WorkItemPr,
  type WorkLists,
} from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function lists(): WorkLists {
  return buildWorkLists({
    response: JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse,
    now: NOW,
  });
}

function rowOf(built: WorkLists, list: keyof WorkLists, id: string) {
  const row = built[list].sections.flatMap((s) => s.rows).find((r) => r.id === id);
  if (row === undefined) throw new Error(`no ${list} row ${id}`);
  return row;
}

const kinds = (cells: readonly RowMetaCell[]): string[] => cells.map((c) => c.kind);
const texts = (cells: readonly RowMetaCell[]): string[] => cells.map((c) => c.text);

function pr(over: Partial<WorkItemPr>): WorkItemPr {
  return {
    repo: 'acme/web',
    number: 1,
    url: 'https://example.invalid',
    title: null,
    author: null,
    branch: null,
    isDraft: false,
    isMine: false,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: null,
    createdAt: null,
    changedFiles: null,
    additions: null,
    deletions: null,
    ci: null,
    labels: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('P0-3 compact age (§2.2 rule 7)', () => {
  const at = (iso: string) => compactAge(iso, NOW);

  it('drops the word "opened" and reads in one glance', () => {
    expect(at('2026-09-10T10:00:00.000Z')).toBe('2h');
    expect(at('2026-09-07T12:00:00.000Z')).toBe('3d');
    expect(at('2026-08-13T12:00:00.000Z')).toBe('4w');
  });

  it('never fabricates a zero, and never renders a future date as negative', () => {
    expect(compactAge(null, NOW)).toBe('—');
    expect(compactAge('not a date', NOW)).toBe('—');
    expect(at('2026-09-10T11:59:00.000Z')).toBe('<1h');
    expect(at('2026-09-11T12:00:00.000Z')).toBe('<1h');
  });
});

describe('P1-6 the size tier (§2.2 rule 6)', () => {
  it('takes the harsher of the file count and the line count', () => {
    expect(tierOf(pr({ changedFiles: 2, additions: 10, deletions: 10 }))).toBe('S');
    expect(tierOf(pr({ changedFiles: 2, additions: 200, deletions: 50 }))).toBe('M');
    expect(tierOf(pr({ changedFiles: 20, additions: 10, deletions: 0 }))).toBe('L');
    expect(tierOf(pr({ changedFiles: 3, additions: 900, deletions: 900 }))).toBe('XL');
    expect(tierOf(pr({ changedFiles: 40, additions: 0, deletions: 0 }))).toBe('XL');
  });

  it('renders — rather than a fabricated S when the size is unknown (MG-12)', () => {
    expect(tierOf(pr({}))).toBe('—');
    expect(tierOf(undefined)).toBe('—');
  });

  it('prefers the core’s own `sizeTier` when the engine sends one, and tolerates its absence', () => {
    expect(tierOf(pr({ changedFiles: 1, additions: 1, deletions: 0, sizeTier: 'XL' }))).toBe('XL');
    expect(tierOf(pr({ changedFiles: 1, additions: 1, deletions: 0, sizeTier: null }))).toBe('S');
  });

  it('agrees with the smallest-change sort, inside each parking-lot group', () => {
    const order = ['S', 'M', 'L', 'XL', '—'];
    const sections = buildWorkLists({
      response: JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse,
      sorts: { parkingLot: 'smallestChange' },
      now: NOW,
    }).parkingLot.sections;
    expect(sections.flatMap((section) => section.rows).length).toBeGreaterThan(2);
    for (const section of sections) {
      const seen = section.rows.map((r) => order.indexOf(r.tier));
      expect([...seen].sort((a, b) => a - b), section.group ?? '').toEqual(seen);
    }
  });
});

describe('P0-3 the parking-lot signals line', () => {
  it('renders @author · age · tier · n files +a/−d, plus the CI dot and the review chip', () => {
    const row = rowOf(lists(), 'parkingLot', 'pr:acme/web#101');
    expect(kinds(row.meta)).toEqual(['author', 'age', 'tier', 'size', 'ci', 'review']);
    expect(texts(row.meta).slice(0, 4)).toEqual(['@jane', '12d', 'M', '7 files +120/−30']);
    const ci = row.meta.find((c) => c.kind === 'ci');
    expect(ci?.tone).toBe('good');
    expect(ci?.title).toContain('success');
    expect(row.meta.find((c) => c.kind === 'review')?.text).toBe('review required');
  });

  it('keeps every signal for a row whose fields all defaulted, as — (MG-12)', () => {
    const row = rowOf(lists(), 'parkingLot', 'pr:acme/legacy#9');
    expect(texts(row.meta.filter((c) => c.kind === 'age' || c.kind === 'tier'))).toEqual(['—', '—']);
    expect(kinds(row.meta)).not.toContain('ci');
    expect(texts(row.meta)).not.toContain('0 files');
  });

  it('names who is already on it, and marks the row demoted', () => {
    const built = lists();
    const row = rowOf(built, 'parkingLot', 'pr:acme/api#55');
    expect(row.demoted).toBe(true);
    expect(row.meta.find((c) => c.kind === 'activity')?.text).toBe(
      '👤 @dana reviewed (changes requested) 43h ago',
    );
    expect(rowOf(built, 'parkingLot', 'pr:acme/web#101').demoted).toBe(false);
  });

  it('keeps the "someone is on it" group collapsed by default, with its count', () => {
    const section = lists().parkingLot.sections.find((s) => s.group === 'someoneOnIt');
    expect(section?.collapsed).toBe(true);
    expect(section?.collapsible).toBe(true);
    expect(section?.count).toBe(1);
  });
});

describe('P0-3/P1-8 waiting for review says what landed', () => {
  it('names the reviewer and the verdict', () => {
    expect(
      landedOf(pr({ reviewDecision: 'CHANGES_REQUESTED', humanActivity: { reviewedBy: ['jane'], commentedBy: [], lastAt: null } })),
    ).toBe('💬 @jane requested changes');
    expect(landedOf(pr({ reviewDecision: 'APPROVED', humanActivity: { reviewedBy: ['dana'], commentedBy: [], lastAt: null } }))).toBe(
      '💬 @dana approved',
    );
    expect(landedOf(pr({ humanActivity: { reviewedBy: ['kim'], commentedBy: [], lastAt: null } }))).toBe(
      '💬 @kim review arrived',
    );
    expect(landedOf(pr({}))).toBe('');
  });

  it('puts it on the row, with the needs-you flag', () => {
    const row = rowOf(lists(), 'waitingForReview', 'pr:acme/web#200');
    expect(texts(row.meta)).toContain('💬 @jane requested changes');
    expect(row.needsYou).toBe(true);
  });
});

describe('P0-3/P1-7 my work reads as state', () => {
  it('renders ticket status · PR state · agent phase without expanding', () => {
    const cells = stateLineOf(
      JSON.parse(JSON.stringify(itemsFixture)).items.find(
        (i: { id: string }) => i.id === 'ticket:HB-627',
      ),
    );
    expect(kinds(cells)).toEqual(['ticketStatus', 'prState', 'prState', 'agentPhase', 'agentPhase']);
    expect(texts(cells)[0]).toBe('🎫 In Progress');
    expect(texts(cells)[1]).toBe('🔀 acme/web#310 approved');
    expect(texts(cells)[3]).toBe('🔍 plan_ready');
  });

  it('is on the my-work row and empty on a parking-lot row', () => {
    const built = lists();
    expect(rowOf(built, 'myWork', 'ticket:HB-627').stateLine.length).toBeGreaterThan(0);
    expect(rowOf(built, 'parkingLot', 'pr:acme/web#101').stateLine).toEqual([]);
  });
});

describe('P0-3 investigations', () => {
  it('reads phase then age, and takes its age from the work when there is no PR', () => {
    const row = rowOf(lists(), 'investigations', 'session:inv-stacktrace-1');
    expect(kinds(row.meta)).toEqual(['agentPhase', 'age']);
    expect(texts(row.meta)).toEqual(['🔍 investigating', '7h']);
  });
});
