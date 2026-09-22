/**
 * Round 3 §(d) — the PR's facts, in words, above the disclosure.
 *
 * Defect 10 was pushed back on as a collapsed-row defect: at 300px a letter and a dot are the
 * cheapest honest signals there are. The real fault is that `L` and `●` are spelled out NOWHERE,
 * and this is where they are spelled out. Defect 3 too: exactly ONE size measurement stands
 * above the disclosure, and it is the PR's own — the change actually under judgement.
 *
 * MG-12 throughout: a fact the engine did not send is absent, never a zero and never a guess.
 */
import { describe, expect, it } from 'vitest';
import { prFactLines, ticketLineOf } from '../../src/model/row-composition';
import type { WorkItemPr, WorkItemTicket } from '../../src/model/work-items';

function pr(over: Partial<WorkItemPr> = {}): WorkItemPr {
  return {
    repo: 'aplaceformom/grace-frontend',
    number: 2140,
    url: 'https://example.invalid',
    isMine: true,
    isDraft: false,
    state: 'open',
    changedFiles: 14,
    additions: 455,
    deletions: 51,
    ci: 'success',
    createdAt: '2026-09-21T09:00:00.000Z',
    humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
    ...over,
  } as WorkItemPr;
}

describe('the PR facts, spelled out', () => {
  it('says whose it is, its state, its one size, its tier, its CI and when it opened', () => {
    const lines = prFactLines(pr(), '');
    expect(lines[0]).toBe('Your PR, open · 14 files +455/−51');
    // The date is formatted in the HOST's locale, so the assertion is on the parts, not the order.
    expect(lines[1]).toMatch(/^Large · CI passing · opened /);
    expect(lines[1]).toContain('21');
    expect(lines[2]).toBe('Nobody else has reviewed it yet');
    expect(lines).toHaveLength(3);
  });

  it("names a teammate's PR as theirs", () => {
    const lines = prFactLines(pr({ isMine: false, author: 'dtorres' }), '');
    expect(lines[0]).toBe("@dtorres's PR, open · 14 files +455/−51");
  });

  it('spells CI out when it is the thing worth acting on', () => {
    expect(prFactLines(pr({ ci: 'failure' }), '')[1]).toContain('CI failing');
    expect(prFactLines(pr({ ci: 'pending' }), '')[1]).toContain('CI pending');
  });

  it('omits every fact the engine did not send, rather than inventing one', () => {
    const bare = prFactLines(
      pr({ changedFiles: null, additions: null, deletions: null, ci: null, createdAt: null, sizeTier: null }),
      '',
    );
    expect(bare[0]).toBe('Your PR, open');
    expect(bare.join(' ')).not.toContain('0 files');
    expect(bare.join(' ')).not.toContain('—');
  });

  it('is empty on a row with no PR at all', () => {
    expect(prFactLines(undefined, '')).toEqual([]);
  });

  it('puts the ticket and its status on one line, and nothing where there is no ticket', () => {
    expect(ticketLineOf({ key: 'HB-1555', status: 'In Review' } as WorkItemTicket)).toBe(
      'HB-1555 · In Review',
    );
    expect(ticketLineOf(null)).toBe('');
  });
});
