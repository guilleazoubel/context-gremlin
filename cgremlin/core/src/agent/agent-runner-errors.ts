export class UnknownAgentHandleError extends Error {
  constructor(id: string) {
    super(`Unknown agent handle: '${id}'`);
    this.name = 'UnknownAgentHandleError';
  }
}
