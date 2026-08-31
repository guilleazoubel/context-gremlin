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
): Promise<void> {
  await git.run(['worktree', 'remove', worktreePath, '--force'], { cwd: mirrorPath });
}
