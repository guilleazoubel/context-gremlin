import type { InvestigationSession, Session } from '../schema/session';

export class PlanGateError extends Error {
  constructor(message: string) { super(message); this.name = 'PlanGateError'; }
}

export function canPromote(session: Session): boolean {
  if (session.mode !== 'investigation') return false;
  return (
    session.stageStatus === 'approved' ||
    (session.driveToCompletion && session.stageStatus === 'plan_ready')
  );
}

export function assertCanPromote(session: Session): asserts session is InvestigationSession {
  if (!canPromote(session)) {
    const detail =
      session.mode !== 'investigation'
        ? `session '${session.id}' is a ${session.mode} session`
        : `phase is '${session.stageStatus}', driveToCompletion=${session.driveToCompletion}`;
    throw new PlanGateError(`Cannot promote to development: ${detail} — approve the plan first`);
  }
}
