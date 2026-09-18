export interface HttpError {
  status: number;
  body: { error: string };
}

export function mapErrorToHttp(err: unknown): HttpError {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'SessionNotFoundError':
      return { status: 404, body: { error: message } };
    case 'InvalidSessionIdError':
      return { status: 400, body: { error: message } };
    case 'IllegalTransitionError':
      return { status: 409, body: { error: message } };
    case 'SessionCorruptError':
      return { status: 500, body: { error: message } };
    // InvalidPrUrlError included: a PR URL the caller typed is a bad
    // request, not an engine failure.
    case 'ValidationError':
    case 'InvalidPrUrlError':
      return { status: 400, body: { error: message } };
    case 'PlanGateError':
    case 'RunInProgressError':
    case 'WorkspaceInUseError':
    case 'HumanTurnInProgressError':
    case 'UnsupportedStageError':
    case 'WorkspaceMissingError':
    case 'WorktreeGoneError': // its sibling: the worktree is gone, not unset — both are fixed by recreating the workspace.
    case 'TickInProgressError':
      return { status: 409, body: { error: message } };
    case 'ArtifactNotFoundError':
      return { status: 404, body: { error: message } };
    case 'OwnPrError':
    case 'NotMyPrError': // R51's mirror: respond mode refuses somebody else's PR.
    case 'PrNotMergedError': // R70: QA verification only runs on merged work.
      return { status: 409, body: { error: message } };
    case 'NoScanYetError':
      return { status: 404, body: { error: message } };
    // An attention ref that names no session, PR (or future source item).
    case 'ItemNotFoundError':
      return { status: 404, body: { error: message } };
    // Every local-app failure is a precondition the caller can act on (a busy
    // port, a missing sudo prereq, an app that never answered) — never a bug
    // in the engine, so 409 rather than 500.
    case 'LocalAppPortBusyError':
    case 'LocalAppPrereqError':
    case 'LocalAppUnhealthyError':
    case 'LocalAppSetupError':
      return { status: 409, body: { error: message } };
    default:
      return { status: 500, body: { error: message } };
  }
}
