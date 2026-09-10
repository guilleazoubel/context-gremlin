import type { Session } from '../schema/session';

export class ArtifactNotFoundError extends Error {
  constructor(sessionId: string, name: string) {
    super(`Artifact '${name}' not found for session '${sessionId}'`);
    this.name = 'ArtifactNotFoundError';
  }
}

/** One row of `GET /sessions/:id/artifacts`: `mtime` is ISO, `size` is the byte length of the file. */
export interface ArtifactListing {
  name: string;
  mtime: string;
  size: number;
}

// Which artifact a client should open FIRST for a session — not which
// artifacts are readable. What is readable stays the single regex behind
// `parseArtifactName` (src/api/validation.ts); these two lists only rank the
// candidates that regex already admitted.
//
// A review session has a fixed answer (R11), so preference order alone decides.
const REVIEW_PREFERENCE = ['REVIEW.md', 'RE-REVIEW.md', 'BRIEF.md'] as const;
// An investigation/development session can hold several of these at once, and
// which one matters is "whatever the agent wrote last" — so mtime decides,
// with this order breaking a tie deterministically (R11).
const WORK_PREFERENCE = ['PLAN.md', 'DEVELOPMENT.md', 'FINDINGS.md'] as const;
const WORK_FALLBACK = 'BRIEF.md';

/**
 * R11: the core, not the UI, chooses the artifact a row opens. Pure over the
 * listing, so it never touches the filesystem itself.
 */
export function pickPrimaryArtifact(
  session: Session,
  // Only the name and the mtime rank a candidate, so a caller that must not
  // read every file (the attention adapter) can answer without a size.
  listing: readonly Pick<ArtifactListing, 'name' | 'mtime'>[],
): string | null {
  const byName = new Map(listing.map((a) => [a.name, a]));

  if (session.mode === 'review') {
    return REVIEW_PREFERENCE.find((name) => byName.has(name)) ?? null;
  }

  let best: { name: string; at: number } | null = null;
  for (const name of WORK_PREFERENCE) {
    const entry = byName.get(name);
    if (entry === undefined) continue;
    const at = Date.parse(entry.mtime);
    // Strictly greater, so an earlier entry in WORK_PREFERENCE wins a tie.
    if (best === null || at > best.at) best = { name, at };
  }
  if (best !== null) return best.name;
  return byName.has(WORK_FALLBACK) ? WORK_FALLBACK : null;
}
