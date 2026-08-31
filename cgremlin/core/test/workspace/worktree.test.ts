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
});

describe('removeWorktree', () => {
  it('runs git worktree remove --force, cwd at the mirror', async () => {
    const git = new FakeGitRunner();
    await removeWorktree(git, '/mirrors/repo.git', '/work/inv-1');
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', '/work/inv-1', '--force'], cwd: '/mirrors/repo.git' },
    ]);
  });
});
