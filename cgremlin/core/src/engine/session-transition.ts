import type { Session } from '../schema/session';
import {
  transitionPhase,
  type DevelopmentPhase,
  type InvestigationPhase,
  type QaPhase,
  type RespondPhase,
  type ReviewPhase,
} from '../schema/pipeline';

export function applyTransition(session: Session, to: string): Session {
  switch (session.mode) {
    case 'investigation':
      return {
        ...session,
        stageStatus: transitionPhase('investigation', session.stageStatus, to as InvestigationPhase),
      };
    case 'development':
      return {
        ...session,
        stageStatus: transitionPhase('development', session.stageStatus, to as DevelopmentPhase),
      };
    case 'review':
      return {
        ...session,
        stageStatus: transitionPhase('review', session.stageStatus, to as ReviewPhase),
      };
    case 'respond':
      return {
        ...session,
        stageStatus: transitionPhase('respond', session.stageStatus, to as RespondPhase),
      };
    case 'qa':
      return {
        ...session,
        stageStatus: transitionPhase('qa', session.stageStatus, to as QaPhase),
      };
  }
}
