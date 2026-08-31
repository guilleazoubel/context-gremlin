import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';

export function mirrorDirName(repoUrl: string): string {
  const slug = repoUrl
    .replace(/\/+$/, '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@/i, '')
    .replace(/[:/]/g, '-')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${slug}.git`;
}

// A --bare clone does NOT populate refs/remotes/origin/* on its own, and
// does not set remote.origin.mirror — unlike --mirror, which does both
// (breaking `worktree add ... origin/<branch>` and turning `fetch --prune`
// and `push` into destructive mirror operations). Set the fetch refspec
// explicitly so ordinary remote-tracking refs exist and fetch --prune only
// ever prunes refs/remotes/origin/*, never the session branches living in
// refs/heads/*.
const ORIGIN_FETCH_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';

export async function ensureMirror(
  git: GitRunner,
  fs: SessionFileSystem,
  mirrorsDir: string,
  repoUrl: string,
): Promise<string> {
  const mirrorPath = `${mirrorsDir}/${mirrorDirName(repoUrl)}`;
  // A bare repo always has a top-level HEAD file; checking for it (rather
  // than just directory existence) means an interrupted/partial clone is
  // retried instead of being treated as valid forever. This does not
  // delete a leftover broken directory first (SessionFileSystem has no
  // delete primitive yet) — a non-empty stale directory will still make
  // the retried clone fail, but with a clear, attributable clone error
  // instead of a permanently confusing "not a git repository" fetch error.
  const isValidMirror = await fs.exists(`${mirrorPath}/HEAD`);
  if (!isValidMirror) {
    await fs.mkdir(mirrorsDir, { recursive: true });
    await git.run(['clone', '--bare', repoUrl, mirrorPath], { cwd: mirrorsDir });
    await git.run(['config', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC], { cwd: mirrorPath });
  }
  await git.run(['fetch', '--prune', 'origin'], { cwd: mirrorPath });
  return mirrorPath;
}
