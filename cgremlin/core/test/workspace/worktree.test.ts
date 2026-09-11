import { describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from '../../src/workspace/worktree';
import { FakeGitRunner } from '../support/fake-git-runner';

describe('createWorktree', () => {
  it('runs git worktree add with the branch and base ref, cwd at the mirror', async () => {
    const git = new FakeGitRunner();
    await createWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x', 'origin/main');
    expect(git.calls).toEqual([
      {
        args: ['worktree', 'add', '/work/inv-1', '-b', 'feature/x', 'origin/main'],
        cwd: '/mirrors/repo.git',
      },
    ]);
  });

  /**
   * R51 — the respond mode's branch is the PR's OWN head, which `clone --bare` has already put
   * in the mirror's `refs/heads/*`. `-b` fails there ("a branch named X already exists") and the
   * stale clone-time ref is not what should be checked out anyway, so `-B` resets it to the
   * fetched `origin/<branch>`.
   */
  it('uses -B, not -b, when the caller says the branch already exists (resetBranch)', async () => {
    const git = new FakeGitRunner();
    await createWorktree(git, '/mirrors/repo.git', '/work/respond-1', 'me/fix', 'origin/me/fix', {
      resetBranch: true,
    });
    expect(git.calls).toEqual([
      {
        args: ['worktree', 'add', '/work/respond-1', '-B', 'me/fix', 'origin/me/fix'],
        cwd: '/mirrors/repo.git',
      },
    ]);
  });

  it('propagates a worktree-add failure instead of swallowing it', async () => {
    const git = new FakeGitRunner();
    git.queueResponse(new Error('fatal: invalid reference: origin/main'));
    await expect(
      createWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x', 'origin/main'),
    ).rejects.toThrow('invalid reference');
  });
});

describe('removeWorktree', () => {
  it('runs git worktree remove --force, worktree prune, and branch -D, cwd at the mirror', async () => {
    const git = new FakeGitRunner();
    await removeWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x');
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', '/work/inv-1', '--force'], cwd: '/mirrors/repo.git' },
      { args: ['worktree', 'prune'], cwd: '/mirrors/repo.git' },
      { args: ['branch', '-D', 'feature/x'], cwd: '/mirrors/repo.git' },
    ]);
  });

  it('tolerates removing a worktree that was already removed (idempotent)', async () => {
    const git = new FakeGitRunner();
    git.queueResponse(new Error("fatal: '/work/inv-1' is not a working tree"));
    await removeWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x');
    expect(git.calls.map((c) => c.args[0])).toEqual(['worktree', 'worktree', 'branch']);
  });

  it('tolerates deleting a branch that was already deleted (idempotent)', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse(new Error("error: branch 'feature/x' not found"));
    await removeWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x');
    expect(git.calls).toHaveLength(3);
  });

  it('propagates an unexpected worktree-remove failure instead of swallowing it', async () => {
    const git = new FakeGitRunner();
    git.queueResponse(new Error('fatal: permission denied'));
    await expect(
      removeWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x'),
    ).rejects.toThrow('permission denied');
  });
});
