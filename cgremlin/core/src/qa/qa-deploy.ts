import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import { ensureMirror, mirrorDirName } from '../workspace/repo-mirror';

export interface DeployAncestryDeps {
  git: GitRunner;
  fs: SessionFileSystem;
  mirrorsDir: string;
}

/**
 * Phase 16 — "is this merge commit inside the build QA is serving?", answered
 * by the repo mirror the engine already keeps, through the existing
 * `GitRunner`.
 *
 * `git merge-base --is-ancestor <merge> <deployed>` is the whole question: it
 * exits 0 when the change is in that build and 1 when it is not. The only
 * other outcome worth handling is a sha the mirror has never seen (a build cut
 * from a commit we have not fetched): that is FETCHED ONCE and re-asked, and
 * if it is still unknown the answer is NOT-YET-DEPLOYED rather than an error.
 * Nothing here may throw into a scan: an unanswerable question is a ticket
 * that waits, never a leg that stops.
 */
export class DeployAncestry {
  constructor(private readonly deps: DeployAncestryDeps) {}

  async isAncestor(slug: string, sha: string, deployedSha: string): Promise<boolean> {
    const repoUrl = `https://github.com/${slug}.git`;
    const mirrorPath = `${this.deps.mirrorsDir}/${mirrorDirName(repoUrl)}`;
    const first = await this.ask(mirrorPath, sha, deployedSha);
    if (first !== 'unknown') return first;
    try {
      // The ONE fetch: it clones the mirror when it is missing and always
      // fetches, which is exactly "learn the shas we do not have, once".
      await ensureMirror(this.deps.git, this.deps.fs, this.deps.mirrorsDir, repoUrl);
    } catch {
      return false;
    }
    const second = await this.ask(mirrorPath, sha, deployedSha);
    return second === true;
  }

  private async ask(
    mirrorPath: string,
    sha: string,
    deployedSha: string,
  ): Promise<boolean | 'unknown'> {
    try {
      await this.deps.git.run(['merge-base', '--is-ancestor', sha, deployedSha], { cwd: mirrorPath });
      return true;
    } catch (err) {
      // Exit 1 with nothing on stderr is git's own "no, it is not an
      // ancestor". Anything else — a sha we do not have, a missing mirror —
      // is a question we cannot answer yet.
      const code = (err as { code?: unknown }).code;
      const stderr = String((err as { stderr?: unknown }).stderr ?? '');
      return code === 1 && stderr.trim() === '' ? false : 'unknown';
    }
  }
}
