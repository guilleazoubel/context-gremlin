/**
 * The engine never reviews its own PRs. This lives in its own leaf module so
 * both the API layer and `ReviewSessionFactory` can throw it without the
 * factory importing the server (`src/api/server.ts` re-exports it, exactly as
 * Phase 5 moved `repoSlugFromUrl` to `src/gh/repo-slug.ts`).
 */
export class OwnPrError extends Error {
  constructor(repo: string, number: number) {
    super(`PR ${repo}#${number} is authored by the configured user; the engine never reviews its own PRs`);
    this.name = 'OwnPrError';
  }
}
