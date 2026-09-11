import type { InventoryEntry } from '../../src/inventory/inventory';

/**
 * The Phase 9 half of an `InventoryEntry`, at its R45 defaults — what a row
 * scanned before Phase 9 (or by a `gh` that emitted none of the eight new
 * fields) looks like once `InventoryStore.load` has filled the blanks.
 */
export const PHASE9_ENTRY_DEFAULTS: Pick<
  InventoryEntry,
  | 'branch'
  | 'ticketKeys'
  | 'reviewRequests'
  | 'humanActivity'
  | 'createdAt'
  | 'changedFiles'
  | 'additions'
  | 'deletions'
  | 'ci'
  | 'labels'
  | 'reviewDecisionAt'
> = {
  branch: null,
  ticketKeys: [],
  reviewRequests: [],
  humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
  createdAt: null,
  changedFiles: null,
  additions: null,
  deletions: null,
  ci: 'none',
  labels: [],
  reviewDecisionAt: null,
};
