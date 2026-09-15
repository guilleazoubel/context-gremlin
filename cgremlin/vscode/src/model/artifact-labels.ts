/**
 * What an artifact IS, as opposed to what it is called (Phase 14).
 *
 * The defect this exists for: a review session that never got past its brief wrote exactly one
 * file, `BRIEF.md`, whose own first line is `# REVIEW — PR #2061` — because it is the brief FOR a
 * review. The tab labelled the block with the filename and a raw ISO mtime and rendered the
 * instructions under it, so the user read the agent's ORDERS as the agent's VERDICT: "it had
 * metadata and the review inside".
 *
 * So the tab names each artifact by its role, puts the real answer first, and says out loud when
 * all it has is the brief. Pure and DOM-free: the host composes the labels, the webview draws
 * them, and neither invents a second naming rule.
 */
export type ArtifactRole =
  | 'qa'
  | 'review'
  | 'findings'
  | 'plan'
  | 'development'
  | 'comments'
  | 'brief'
  | 'other';

const ROLE_LABELS: Record<Exclude<ArtifactRole, 'other'>, string> = {
  brief: 'Brief — the instructions this agent was given',
  qa: 'QA verification',
  review: 'Review',
  findings: 'Findings',
  plan: 'Plan',
  development: 'Development',
  comments: 'Comments',
};

/**
 * Phase 17 §1 — the one-word name a PART SWITCHER tab shows.
 *
 * The long labels above are headings for a pane; a tab is a word. An unrecognised file keeps its
 * filename here too, so the switcher never renames a document it did not recognise.
 */
const TAB_LABELS: Record<Exclude<ArtifactRole, 'other'>, string> = {
  brief: 'Brief',
  qa: 'QA',
  review: 'Review',
  findings: 'Findings',
  plan: 'Plan',
  development: 'Development',
  comments: 'Comments',
};

export function artifactTabLabel(name: string): string {
  const role = artifactRole(name);
  return role === 'other' ? name : TAB_LABELS[role];
}

/**
 * Matched on the STEM, so `REVIEW.md`, `REVIEW-v1.md` and `RE-REVIEW.md` are all one role. Order
 * matters: `RE-REVIEW` must not be read as a findings file, so the tests pin the shapes.
 */
export function artifactRole(name: string): ArtifactRole {
  const stem = name.replace(/\.[^.]+$/, '').toUpperCase();
  // Phase 15 §5: `QA.md`, and `QA-v2.md` once a re-verification has archived the last one.
  if (/^QA(-V\d+)?$/.test(stem)) return 'qa';
  if (/(^|-)RE-?REVIEW(-V\d+)?$/.test(stem) || /^REVIEW(-V\d+)?$/.test(stem)) return 'review';
  if (/^FINDINGS(-V\d+)?$/.test(stem)) return 'findings';
  if (/^PLAN(-V\d+)?$/.test(stem)) return 'plan';
  // Phase 17: `DEVELOPMENT.md` is served by the API already; only the naming rule was missing.
  if (/^DEVELOPMENT(-V\d+)?$/.test(stem)) return 'development';
  if (/^COMMENTS(-V\d+)?$/.test(stem)) return 'comments';
  if (/^BRIEF(-V\d+)?$/.test(stem)) return 'brief';
  return 'other';
}

/** The heading the tab shows above the body. An unrecognised file keeps its filename. */
export function artifactLabel(name: string): string {
  const role = artifactRole(name);
  return role === 'other' ? name : ROLE_LABELS[role];
}

/**
 * The answer the user came for, in preference order. Deliberately NOT mtime-ranked: the brief is
 * written first and is often the NEWEST thing a stalled session has, which is exactly how it came
 * to be shown as the review.
 */
const PRIMARY_ORDER: readonly ArtifactRole[] = [
  'qa',
  'review',
  'findings',
  'plan',
  'development',
  'comments',
  'other',
  'brief',
];

export function primaryArtifactName(names: readonly string[]): string | null {
  for (const role of PRIMARY_ORDER) {
    const match = names.find((name) => artifactRole(name) === role);
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * Phase 17 §1 — the FIXED tab order: role rank, ties broken by name.
 *
 * It replaces an order that hoisted the primary to index 0 and left same-role files in the mtime
 * order the host listed them in, so a tab's POSITION moved between items and between renders. A switcher is navigation, and navigation that relabels position 1 is unlearnable. The
 * OPENING pane is chosen separately (`primaryArtifactName`), which is what §1 actually asked for.
 */
export function orderArtifactTabs(names: readonly string[]): string[] {
  const rank = (name: string): number => PRIMARY_ORDER.indexOf(artifactRole(name));
  return [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** One sentence, no emoji (the tab's CSP sets `font-src 'none'`, so glyphs degrade to boxes). */
export const BRIEF_ONLY_NOTICE =
  'This agent has not written a review yet. What follows is the brief it was given, not its findings.';

/** True when the only thing this agent has produced is its own instructions. */
export function briefOnly(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => artifactRole(name) === 'brief');
}
