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
const ORIGIN_FETCH_HEADS_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
// A second refspec so PR head commits (which live in refs/pull/*/head on
// GitHub, not refs/heads/*) are fetchable as remote-tracking refs too —
// review sessions branch from origin/pr/<n> without ever needing a fork
// remote.
const ORIGIN_FETCH_PULLS_REFSPEC = '+refs/pull/*/head:refs/remotes/origin/pr/*';

// `git config --get-all` exits 1 with empty stdout/stderr when the key is
// simply unset — true for any mirror not created (or not yet touched) by
// this module's own "new mirror" branch below. That is the one failure mode
// worth tolerating here; anything else (e.g. a corrupt repo, a missing
// binary) must keep propagating instead of being silently treated as "no
// refspecs configured".
function isMissingConfigKeyError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === 1 &&
    (err as { stderr?: unknown }).stderr === ''
  );
}

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
    await git.run(['config', 'remote.origin.fetch', ORIGIN_FETCH_HEADS_REFSPEC], { cwd: mirrorPath });
    await git.run(['config', '--add', 'remote.origin.fetch', ORIGIN_FETCH_PULLS_REFSPEC], { cwd: mirrorPath });
  } else {
    let existingRefspecs: string[];
    try {
      const { stdout } = await git.run(['config', '--get-all', 'remote.origin.fetch'], { cwd: mirrorPath });
      existingRefspecs = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      if (!isMissingConfigKeyError(err)) {
        throw err;
      }
      existingRefspecs = [];
    }
    if (!existingRefspecs.includes(ORIGIN_FETCH_HEADS_REFSPEC)) {
      await git.run(['config', '--add', 'remote.origin.fetch', ORIGIN_FETCH_HEADS_REFSPEC], { cwd: mirrorPath });
    }
    if (!existingRefspecs.includes(ORIGIN_FETCH_PULLS_REFSPEC)) {
      await git.run(['config', '--add', 'remote.origin.fetch', ORIGIN_FETCH_PULLS_REFSPEC], { cwd: mirrorPath });
    }
  }
  await git.run(['fetch', '--prune', 'origin'], { cwd: mirrorPath });
  return mirrorPath;
}
