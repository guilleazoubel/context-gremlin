import type { WorkItemPr } from './work-item';

export type SizeTier = 'S' | 'M' | 'L' | 'XL';

const TIER_ORDER: readonly SizeTier[] = ['S', 'M', 'L', 'XL'];

/**
 * Workshop doc (`2026-09-11-cgremlin-phase10-panel-workshop.md` §2.1 rule 6):
 * "From `changedFiles` and `additions+deletions`, whichever is larger:
 * S <= 3 files or <= 50 lines · M <= 10 or <= 300 · L <= 25 or <= 1000 · XL beyond."
 *
 * Read as: compute a tier independently from files and from lines, then take
 * the WORSE (larger) of the two — either dimension alone can push a PR to a
 * bigger tier. `null` whenever the underlying input is null (R45/MG-12: a
 * missing field is unknown, never a fabricated zero).
 */
function tierByBound(value: number, bounds: readonly [number, number, number]): SizeTier {
  const [s, m, l] = bounds;
  if (value <= s) return 'S';
  if (value <= m) return 'M';
  if (value <= l) return 'L';
  return 'XL';
}

export function sizeTierOf(pr: Pick<WorkItemPr, 'changedFiles' | 'additions' | 'deletions'>): SizeTier | null {
  const { changedFiles, additions, deletions } = pr;
  if (changedFiles === null || additions === null || deletions === null) return null;

  const tierByFiles = tierByBound(changedFiles, [3, 10, 25]);
  const tierByLines = tierByBound(additions + deletions, [50, 300, 1000]);

  return TIER_ORDER.indexOf(tierByFiles) >= TIER_ORDER.indexOf(tierByLines) ? tierByFiles : tierByLines;
}
