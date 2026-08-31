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
    default:
      return { status: 500, body: { error: message } };
  }
}
