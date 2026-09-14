import { describe, expect, it } from 'vitest';
import { sizeTierOf } from '../../src/work/size-tier';
import type { WorkItemPr } from '../../src/work/work-item';

/**
 * Workshop doc (`2026-09-11-cgremlin-phase10-panel-workshop.md` §2.1 rule 6):
 * tier is computed independently from `changedFiles` and `additions+deletions`,
 * then the WORSE (larger) of the two tiers wins.
 *   files:  S <= 3   M <= 10   L <= 25   else XL
 *   lines:  S <= 50  M <= 300  L <= 1000 else XL
 * `null` when either input is null.
 */
function pr(changedFiles: number | null, additions: number | null, deletions: number | null): WorkItemPr {
  return {
    repo: 'r',
    number: 1,
    url: 'https://github.com/r/pull/1',
    title: null,
    author: null,
    branch: null,
    isDraft: null,
    isMine: null,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: null,
    createdAt: null,
    changedFiles,
    additions,
    deletions,
    ci: null,
    labels: null,
    sizeTier: null,
    state: null,
  };
}

describe('sizeTierOf', () => {
  const cases: Array<{ name: string; files: number | null; additions: number | null; deletions: number | null; want: 'S' | 'M' | 'L' | 'XL' | null }> = [
    { name: 'boundary: 3 files, 50 lines -> S', files: 3, additions: 50, deletions: 0, want: 'S' },
    { name: 'boundary: 4 files, 50 lines -> M (files pushes past S)', files: 4, additions: 50, deletions: 0, want: 'M' },
    { name: 'boundary: 2 files, 301 lines -> L (lines pushes past M)', files: 2, additions: 301, deletions: 0, want: 'L' },
    { name: 'boundary: 26 files, 10 lines -> XL (files pushes past L)', files: 26, additions: 10, deletions: 0, want: 'XL' },
    { name: 'files null -> null', files: null, additions: 10, deletions: 0, want: null },
    { name: 'additions null -> null', files: 3, additions: null, deletions: 0, want: null },
    { name: 'deletions null -> null', files: 3, additions: 10, deletions: null, want: null },
    { name: 'all null -> null', files: null, additions: null, deletions: null, want: null },
    { name: '0 files, 0 lines -> S', files: 0, additions: 0, deletions: 0, want: 'S' },
    { name: '10 files, 300 lines -> M (both at M boundary)', files: 10, additions: 150, deletions: 150, want: 'M' },
    { name: '25 files, 1000 lines -> L (both at L boundary)', files: 25, additions: 500, deletions: 500, want: 'L' },
    { name: '1 file, 1001 lines -> XL (lines alone push past L)', files: 1, additions: 1000, deletions: 1, want: 'XL' },
    { name: '11 files, 0 lines -> L (files alone push past M)', files: 11, additions: 0, deletions: 0, want: 'L' },
  ];

  it.each(cases)('$name', ({ files, additions, deletions, want }) => {
    expect(sizeTierOf(pr(files, additions, deletions))).toBe(want);
  });
});
