import type { SessionMode } from './session';

export const INVESTIGATION_PHASES = [
  'findings',
  'planning',
  'plan_ready',
  'approved',
  'promoted_to_development',
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
] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

export type PhaseFor<M extends SessionMode> = M extends 'investigation'
  ? InvestigationPhase
  : M extends 'development'
    ? DevelopmentPhase
    : ReviewPhase;

const TRANSITIONS: Record<SessionMode, Record<string, readonly string[]>> = {
  investigation: {
    findings: ['planning'],
    planning: ['plan_ready'],
    plan_ready: ['approved'],
    approved: ['promoted_to_development'],
    promoted_to_development: [],
  },
  development: {
    active: ['pr_opened', 'abandoned'],
    pr_opened: ['superseded', 'abandoned'],
    superseded: ['merged', 'abandoned'],
    merged: [],
    abandoned: [],
  },
  review: {
    queued: ['reviewing'],
    reviewing: ['ready', 'dismissed'],
    ready: ['approved', 'changes_requested', 'dismissed'],
    changes_requested: ['reviewing', 'dismissed'],
    approved: [],
    dismissed: [],
  },
};

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
  return TRANSITIONS[mode][from]?.includes(to) ?? false;
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
