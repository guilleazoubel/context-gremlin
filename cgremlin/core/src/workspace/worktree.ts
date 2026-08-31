import type { GitRunner } from '../git/git-runner';

export async function createWorktree(
  git: GitRunner,
  mirrorPath: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
): Promise<void> {
  await git.run(['worktree', 'add', worktreePath, '-b', branchName, baseRef], {
    cwd: mirrorPath,
  });
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
