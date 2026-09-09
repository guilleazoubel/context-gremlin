export function repoSlugFromUrl(repoUrl: string): string {
  const m = repoUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : repoUrl.replace(/[^a-zA-Z0-9._-]/g, '-');
}
export { repoSlugFromUrl as repoSlug };
