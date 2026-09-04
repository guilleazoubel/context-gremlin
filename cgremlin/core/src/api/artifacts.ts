export class ArtifactNotFoundError extends Error {
  constructor(sessionId: string, name: string) {
    super(`Artifact '${name}' not found for session '${sessionId}'`);
    this.name = 'ArtifactNotFoundError';
  }
}
