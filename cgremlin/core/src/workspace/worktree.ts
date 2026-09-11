import type { GitRunner } from '../git/git-runner';

export interface CreateWorktreeOptions {
  /**
   * `-B` instead of `-b`. R51's respond session checks out the PR's OWN head branch, and a bare
   * mirror already carries `refs/heads/<that branch>` from `clone --bare` — so `-b` fails with
   * "a branch named X already exists" on the very first respond run. `-B` creates the branch or
   * resets it to `baseRef` (`origin/<head branch>`), which is also the only way the worktree gets
   * the FETCHED head: `fetch --prune` updates `refs/remotes/origin/*`, never the mirror's own
   * `refs/heads/*`.
   *
   * Off by default, because every other mode invents a branch name of its own (`review/<n>`,
   * `investigate/<ticket>`, `feature/<ticket>`): a clash there is a real collision and must keep
   * failing loudly rather than silently resetting somebody's branch.
   */
  resetBranch?: boolean;
}

export async function createWorktree(
  git: GitRunner,
  mirrorPath: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
  opts: CreateWorktreeOptions = {},
): Promise<void> {
  await git.run(
    ['worktree', 'add', worktreePath, opts.resetBranch === true ? '-B' : '-b', branchName, baseRef],
    { cwd: mirrorPath },
  );
}

export async function removeWorktree(
  git: GitRunner,
  mirrorPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  try {
    await git.run(['worktree', 'remove', worktreePath, '--force'], { cwd: mirrorPath });
  } catch (err) {
    if (!/is not a working tree/.test((err as Error).message)) {
      throw err;
    }
  }
  await git.run(['worktree', 'prune'], { cwd: mirrorPath });
  try {
    await git.run(['branch', '-D', branchName], { cwd: mirrorPath });
  } catch (err) {
    if (!/not found/.test((err as Error).message)) {
      throw err;
    }
  }
}
