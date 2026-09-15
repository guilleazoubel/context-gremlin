import type { PrStateEntry } from '../../src/gh/pr-state';

/**
 * The row-shaped fields a pr-state entry carries (Phase 14), defaulted to
 * "unknown". Mirrors `PHASE9_ENTRY_DEFAULTS`: a fixture names only what its
 * assertion is about, and a future field added to `PrStateEntry` is one edit
 * here rather than one per fixture.
 */
export const PR_STATE_ENTRY_DEFAULTS: Pick<
  PrStateEntry,
  'author' | 'createdAt' | 'changedFiles' | 'additions' | 'deletions' | 'isDraft' | 'labels'
> = {
  author: null,
  createdAt: null,
  changedFiles: null,
  additions: null,
  deletions: null,
  isDraft: null,
  labels: [],
};
