import type { SessionMode } from './session-mode';

export const INVESTIGATION_PHASES = [
  'findings',
  'planning',
  'plan_ready',
  'approved',
  'promoted_to_development',
  'abandoned',
] as const;
export type InvestigationPhase = (typeof INVESTIGATION_PHASES)[number];

export const DEVELOPMENT_PHASES = [
  'active',
  'pr_opened',
  'superseded',
  'merged',
  'abandoned',
] as const;
export type DevelopmentPhase = (typeof DEVELOPMENT_PHASES)[number];

export const REVIEW_PHASES = [
  'queued',
  'reviewing',
  'ready',
  'approved',
  'changes_requested',
  'dismissed',
  'failed',
] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/**
 * R51 — `triaging`: the agent is classifying the live threads into
 * COMMENTS.md. `addressing`: working the entries (fixes, reply drafts).
 * `ready`: every entry has a verdict and the local fixes are committed — the
 * HUMAN is what it is waiting on. `closed`/`abandoned`: done.
 */
export const RESPOND_PHASES = ['triaging', 'addressing', 'ready', 'closed', 'abandoned'] as const;
export type RespondPhase = (typeof RESPOND_PHASES)[number];

/**
 * R69 — seven phases. `ready` is NOT terminal: a terminal session may lose
 * its worktree and leaves the live filters, but the user keeps chatting and
 * keeps following the ticket until it is deployed. Terminal is
 * `closed`/`abandoned` only.
 */
export const QA_PHASES = [
  'queued',
  'verifying',
  'ready',
  'not_ready',
  'failed',
  'closed',
  'abandoned',
] as const;
export type QaPhase = (typeof QA_PHASES)[number];

/** The phases a verification run may start from. */
export const QA_RUNNABLE_FROM: readonly QaPhase[] = ['queued', 'ready', 'not_ready', 'failed'];

export type PhaseFor<M extends SessionMode> = M extends 'investigation'
  ? InvestigationPhase
  : M extends 'development'
    ? DevelopmentPhase
    : M extends 'respond'
      ? RespondPhase
      : M extends 'qa'
        ? QaPhase
        : ReviewPhase;

const INVESTIGATION_TRANSITIONS: Record<InvestigationPhase, readonly InvestigationPhase[]> = {
  findings: ['planning', 'abandoned'],
  planning: ['plan_ready', 'abandoned'],
  plan_ready: ['approved', 'promoted_to_development', 'abandoned'],
  approved: ['promoted_to_development', 'abandoned'],
  promoted_to_development: [],
  abandoned: [],
};

const DEVELOPMENT_TRANSITIONS: Record<DevelopmentPhase, readonly DevelopmentPhase[]> = {
  active: ['pr_opened', 'merged', 'abandoned'],
  pr_opened: ['superseded', 'merged', 'abandoned'],
  superseded: ['merged', 'abandoned'],
  merged: [],
  abandoned: [],
};

// An external approval or a merge/close on GitHub is a fact regardless of
// our local phase — legacy applied these unconditionally, so 'approved' and
// 'dismissed' are reachable from every non-terminal review phase, not just
// the ones our own review loop would naturally pass through.
const REVIEW_TRANSITIONS: Record<ReviewPhase, readonly ReviewPhase[]> = {
  queued: ['reviewing', 'approved', 'dismissed'],
  reviewing: ['ready', 'failed', 'dismissed'],
  ready: ['approved', 'changes_requested', 'reviewing', 'dismissed'],
  changes_requested: ['reviewing', 'dismissed', 'approved'],
  failed: ['reviewing', 'dismissed', 'approved'],
  approved: [],
  dismissed: [],
};

// R51: a new review arriving sends a `ready` respond session back to
// `addressing`, which is why `ready` is not terminal.
//
// `closed` is reachable from EVERY non-terminal phase for the same reason
// `dismissed` is on the review table: a merge on GitHub is a fact regardless
// of our local phase. The live defect was a respond session stuck at
// `addressing` on a PR that had merged three days earlier, keeping the whole
// item looking like work in flight.
const RESPOND_TRANSITIONS: Record<RespondPhase, readonly RespondPhase[]> = {
  triaging: ['addressing', 'closed', 'abandoned'],
  addressing: ['ready', 'closed', 'abandoned'],
  ready: ['addressing', 'closed', 'abandoned'],
  closed: [],
  abandoned: [],
};

// R69 — `closed` and `abandoned` are reachable from EVERY non-terminal
// phase, for respond's reason: a ticket reaching Done (R78), or a human
// giving up, is a fact regardless of our local phase. `queued` cannot jump
// straight to a verdict — only a run produces one.
const QA_TRANSITIONS: Record<QaPhase, readonly QaPhase[]> = {
  queued: ['verifying', 'closed', 'abandoned'],
  verifying: ['ready', 'not_ready', 'failed', 'closed', 'abandoned'],
  ready: ['verifying', 'not_ready', 'closed', 'abandoned'],
  not_ready: ['verifying', 'ready', 'closed', 'abandoned'],
  failed: ['verifying', 'closed', 'abandoned'],
  closed: [],
  abandoned: [],
};

const TRANSITIONS = {
  investigation: INVESTIGATION_TRANSITIONS,
  development: DEVELOPMENT_TRANSITIONS,
  review: REVIEW_TRANSITIONS,
  respond: RESPOND_TRANSITIONS,
  qa: QA_TRANSITIONS,
} as const;

export class IllegalTransitionError extends Error {
  constructor(mode: SessionMode, from: string, to: string) {
    super(`Cannot transition ${mode} session from '${from}' to '${to}'`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition<M extends SessionMode>(
  mode: M,
  from: PhaseFor<M>,
  to: PhaseFor<M>,
): boolean {
  const table = TRANSITIONS[mode] as Record<string, readonly string[]> | undefined;
  return table?.[from]?.includes(to) ?? false;
}

export function transitionPhase<M extends SessionMode>(
  mode: M,
  from: PhaseFor<M>,
  to: PhaseFor<M>,
): PhaseFor<M> {
  if (!canTransition(mode, from, to)) {
    throw new IllegalTransitionError(mode, from, to);
  }
  return to;
}
