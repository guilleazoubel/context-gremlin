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

export type PhaseFor<M extends SessionMode> = M extends 'investigation'
  ? InvestigationPhase
  : M extends 'development'
    ? DevelopmentPhase
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
  active: ['pr_opened', 'abandoned'],
  pr_opened: ['superseded', 'merged', 'abandoned'],
  superseded: ['merged', 'abandoned'],
  merged: [],
  abandoned: [],
};

const REVIEW_TRANSITIONS: Record<ReviewPhase, readonly ReviewPhase[]> = {
  queued: ['reviewing'],
  reviewing: ['ready', 'failed', 'dismissed'],
  ready: ['approved', 'changes_requested', 'reviewing', 'dismissed'],
  changes_requested: ['reviewing', 'dismissed'],
  failed: ['reviewing', 'dismissed'],
  approved: [],
  dismissed: [],
};

const TRANSITIONS = {
  investigation: INVESTIGATION_TRANSITIONS,
  development: DEVELOPMENT_TRANSITIONS,
  review: REVIEW_TRANSITIONS,
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
