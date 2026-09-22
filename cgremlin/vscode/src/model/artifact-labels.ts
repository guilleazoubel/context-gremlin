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
import { reportNoun } from './row-composition';
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

/**
 * Defect 1 — the verb a surface puts on the button that OPENS this artifact.
 *
 * It is keyed on the artifact the core actually picked (`WorkItemAgent.primaryArtifact`), never
 * on the session's mode: a killed investigation's only file is the brief it was HANDED, and a
 * mode-keyed label called that file `the findings`. A button now names what it opens or it names
 * the session — there is no third case, and `null` is not a reason to say nothing.
 */
const READ_VERBS: Record<Exclude<ArtifactRole, 'other'>, string> = {
  brief: 'Read the brief it was given',
  qa: 'Read the QA result',
  review: 'Read the review',
  findings: 'Read the findings',
  plan: 'Read the plan',
  development: 'Read the development notes',
  comments: 'Read the replies',
};

/** The session's own tab, for an agent the engine named no artifact for at all. */
export const OPEN_SESSION_VERB = 'Open the session';

export function readArtifactVerb(name: string | null): string {
  if (name === null || name === '') return OPEN_SESSION_VERB;
  const role = artifactRole(name);
  return role === 'other' ? `Read ${name}` : READ_VERBS[role];
}

/**
 * One sentence, no emoji (the tab's CSP sets `font-src 'none'`, so glyphs degrade to boxes).
 *
 * Defect 1 — it named a REVIEW, because that is the session the phase-14 case was about. On
 * `inv-aplaceformom-grace-frontend-no-ticket-20260916-211103` the tab therefore told an
 * investigation it had not written a review, which is a document nobody ever asked it for. The
 * noun comes from the one composer that already owns it (`reportNoun`).
 */
export function briefOnlyNotice(mode: string | null): string {
  return (
    `This agent has not written its ${reportNoun(mode)} yet. ` +
    'What follows is the brief it was given.'
  );
}

/** The review wording, kept as the constant the phase-14 surfaces already import. */
export const BRIEF_ONLY_NOTICE = briefOnlyNotice('review');

/** True when the only thing this agent has produced is its own instructions. */
export function briefOnly(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => artifactRole(name) === 'brief');
}
