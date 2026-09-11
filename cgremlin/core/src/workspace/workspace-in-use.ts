import path from 'node:path';
import type { Session } from '../schema/session';

export const TERMINAL_PHASES_BY_MODE: Record<Session['mode'], ReadonlySet<string>> = {
  investigation: new Set(['promoted_to_development', 'abandoned']),
  development: new Set(['merged', 'abandoned']),
  review: new Set(['approved', 'dismissed']),
  respond: new Set(['closed', 'abandoned']),
};

function isTerminal(session: Session): boolean {
  return TERMINAL_PHASES_BY_MODE[session.mode].has(session.stageStatus);
}

export class WorkspaceInUseError extends Error {
  constructor(worktreePath: string, blockingSessionIds: readonly string[]) {
    super(`Worktree '${worktreePath}' is still in use by session(s): ${blockingSessionIds.join(', ')}`);
    this.name = 'WorkspaceInUseError';
  }
}

export function findSessionsUsingWorktree(
  sessions: readonly Session[],
  worktreePath: string,
  excludeSessionId?: string,
): Session[] {
  const target = path.resolve(worktreePath);
  return sessions.filter(
    (s) =>
      s.workspace.worktreePath !== undefined &&
      path.resolve(s.workspace.worktreePath) === target &&
      s.id !== excludeSessionId &&
      !isTerminal(s),
  );
}

export function assertWorktreeNotInUse(
  sessions: readonly Session[],
  worktreePath: string,
  excludeSessionId?: string,
): void {
  const blocking = findSessionsUsingWorktree(sessions, worktreePath, excludeSessionId);
  if (blocking.length > 0) {
    throw new WorkspaceInUseError(worktreePath, blocking.map((s) => s.id));
  }
}
