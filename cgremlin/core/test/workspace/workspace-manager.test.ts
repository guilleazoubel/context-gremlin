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
      {
        args: ['config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
      {
        args: ['worktree', 'add', '/work/inv-1', '-b', 'main', 'origin/main'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
    ]);
    const settings = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    expect(JSON.parse(settings).permissions.deny).toContain('Bash(gh pr comment:*)');
  });

  it('createWorkspace passes resetBranch through as -B (R51, the respond mode)', async () => {
    const git = new FakeGitRunner();
    const manager = new WorkspaceManager(git, new InMemoryFileSystem(), '/mirrors');
    await manager.createWorkspace({
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/respond-1',
      branchName: 'me/fix',
      baseRef: 'origin/me/fix',
      mode: 'respond',
      resetBranch: true,
    });
    expect(git.calls.at(-1)).toEqual({
      args: ['worktree', 'add', '/work/respond-1', '-B', 'me/fix', 'origin/me/fix'],
      cwd: '/mirrors/github.com-org-repo.git',
    });
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
      // Only the permission-settings write fails: the mirror's own
      // `info/exclude` write (phase 20) happens BEFORE the worktree exists,
      // and a failure there is not what this rollback is about.
      writeFile: async (path, content, options) => {
        if (path.includes('/.claude/')) throw new Error('disk full');
        return fs.writeFile(path, content, options);
      },
      statMode: (p) => fs.statMode(p),
      statMtimeMs: (p) => fs.statMtimeMs(p),
      remove: (p) => fs.remove(p),
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

/**
 * Phase 20 — the posting modes may not type a GitHub write verb at all, so the
 * engine installs BOTH scoped helpers for them. Every other mode posts nothing
 * and gets nothing.
 */
const HELPERS = ['.cgremlin/post-review', '.cgremlin/post-comment'] as const;

describe('WorkspaceManager writes the scoped posting helpers', () => {
  const pr = { repoSlug: 'acme/app', prNumber: 42 };

  async function create(mode: 'review' | 'respond' | 'qa' | 'development' | 'investigation') {
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(new FakeGitRunner(), fs, '/mirrors');
    await manager.createWorkspace({
      repoUrl: 'git@github.com:acme/app.git',
      worktreePath: `/work/${mode}-1`,
      branchName: 'b',
      baseRef: 'origin/b',
      mode,
      pr,
    });
    return fs;
  }

  it.each(['review', 'respond'] as const)('%s gets both executable helpers with its own PR baked in', async (mode) => {
    const fs = await create(mode);
    for (const helper of HELPERS) {
      const script = await fs.readFile(`/work/${mode}-1/${helper}`);
      expect(script).toContain('"acme/app"');
      expect(script).toContain('const PR = 42');
      expect(await fs.statMode(`/work/${mode}-1/${helper}`)).toBe(0o755);
    }
  });

  it.each(['qa', 'development', 'investigation'] as const)('%s gets no helper at all', async (mode) => {
    const fs = await create(mode);
    for (const helper of HELPERS) expect(await fs.exists(`/work/${mode}-1/${helper}`)).toBe(false);
  });

  it('writes no helper for a posting mode with no PR to post to', async () => {
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(new FakeGitRunner(), fs, '/mirrors');
    await manager.createWorkspace({
      repoUrl: 'git@github.com:acme/app.git',
      worktreePath: '/work/review-2',
      branchName: 'b',
      baseRef: 'origin/b',
      mode: 'review',
    });
    for (const helper of HELPERS) expect(await fs.exists(`/work/review-2/${helper}`)).toBe(false);
  });
});
