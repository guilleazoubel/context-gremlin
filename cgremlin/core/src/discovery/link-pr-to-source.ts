import type { ReviewSession, Session } from '../schema/session';

export interface LinkResult {
  source: Session | null;
  linked: ReviewSession;
  supersede: boolean;
}

type CandidateSession = Extract<Session, { mode: 'development' | 'investigation' }>;

// Not importing TERMINAL_PHASES_BY_MODE from src/workspace/workspace-in-use.ts here: that
// module lives on the other stream and hasn't landed in this worktree yet.
const CANDIDATE_TERMINAL_PHASES: Record<'investigation' | 'development', ReadonlySet<string>> = {
  investigation: new Set(['promoted_to_development', 'abandoned']),
  development: new Set(['merged', 'abandoned']),
};

function isNonTerminalCandidate(s: Session): s is CandidateSession {
  return (
    (s.mode === 'development' || s.mode === 'investigation') &&
    !CANDIDATE_TERMINAL_PHASES[s.mode].has(s.stageStatus)
  );
}

function mostRecent(sessions: readonly CandidateSession[]): CandidateSession {
  return sessions.reduce((latest, current) => (current.createdAt > latest.createdAt ? current : latest));
}

export function linkPrToSource(review: ReviewSession, sessions: readonly Session[]): LinkResult {
  const pr = review.pr;
  if (pr === null) {
    return { source: null, linked: review, supersede: false };
  }

  const candidates = sessions.filter(isNonTerminalCandidate);

  const pass1 = candidates.filter((s) => s.pr?.repo === pr.repo && s.pr?.number === pr.number);

  const ticket = review.lineage.ticket;
  const pass2 = pass1.length === 0 && ticket !== null
    ? candidates.filter((s) => s.lineage.ticket === ticket)
    : [];

  const matches = pass1.length > 0 ? pass1 : pass2;
  if (matches.length === 0) {
    return { source: null, linked: review, supersede: false };
  }

  const source = mostRecent(matches);
  const linked: ReviewSession = {
    ...review,
    lineage: {
      pipelineId: source.lineage.pipelineId,
      parentSessionId: source.id,
      ticket: source.lineage.ticket ?? review.lineage.ticket,
    },
  };
  const supersede = source.mode === 'development' && source.stageStatus === 'pr_opened';

  return { source, linked, supersede };
}
