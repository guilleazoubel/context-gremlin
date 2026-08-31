import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { FakeGitRunner } from '../support/fake-git-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { SessionFileSystem } from '../../src/fs/session-file-system';

describe('WorkspaceManager', () => {
  it('createWorkspace ensures the mirror, creates the worktree, and writes permission settings', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(git, fs, '/mirrors');
    const mirrorPath = await manager.createWorkspace({
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      {
        args: ['clone', '--bare', 'git@github.com:org/repo.git', '/mirrors/github.com-org-repo.git'],
        cwd: '/mirrors',
      },
      {
        args: ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
      {
        args: ['worktree', 'add', '/work/inv-1', '-b', 'main', 'origin/main'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
    ]);
    const settings = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    expect(JSON.parse(settings).permissions.allow).toContain('Bash(cgremlin --plan-start *)');
  });

  it('removeWorkspace runs worktree remove/prune/branch-delete against the derived mirror path', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(git, fs, '/mirrors');
    await manager.removeWorkspace('git@github.com:org/repo.git', '/work/inv-1', 'main');
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', '/work/inv-1', '--force'], cwd: '/mirrors/github.com-org-repo.git' },
      { args: ['worktree', 'prune'], cwd: '/mirrors/github.com-org-repo.git' },
      { args: ['branch', '-D', 'main'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('createWorkspace rolls back the worktree and branch if writing permission settings fails', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const failingFs: SessionFileSystem = {
      readFile: (p) => fs.readFile(p),
      writeFile: async () => {
        throw new Error('disk full');
      },
      rename: (a, b) => fs.rename(a, b),
      readdir: (p) => fs.readdir(p),
      mkdir: (p, o) => fs.mkdir(p, o),
      exists: (p) => fs.exists(p),
    };
    const manager = new WorkspaceManager(git, failingFs, '/mirrors');
    await expect(
      manager.createWorkspace({
        repoUrl: 'git@github.com:org/repo.git',
        worktreePath: '/work/inv-1',
        branchName: 'main',
        baseRef: 'origin/main',
        mode: 'investigation',
      }),
    ).rejects.toThrow('disk full');
    const removeCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    const branchDeleteCall = git.calls.find((c) => c.args[0] === 'branch' && c.args[1] === '-D');
    expect(removeCall).toBeDefined();
    expect(branchDeleteCall).toBeDefined();
  });
});
