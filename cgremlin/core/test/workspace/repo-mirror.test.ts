import { describe, expect, it } from 'vitest';
import { mirrorDirName, ensureMirror } from '../../src/workspace/repo-mirror';
import { FakeGitRunner } from '../support/fake-git-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

describe('mirrorDirName', () => {
  it('converts an SSH-style git URL to a filesystem-safe mirror directory name', () => {
    expect(mirrorDirName('git@github.com:aplaceformom/grace-frontend.git')).toBe(
      'github.com-aplaceformom-grace-frontend.git',
    );
  });

  it('converts an HTTPS-style git URL to a filesystem-safe mirror directory name', () => {
    expect(mirrorDirName('https://github.com/aplaceformom/grace-frontend.git')).toBe(
      'github.com-aplaceformom-grace-frontend.git',
    );
  });

  it('strips a trailing slash before slugifying', () => {
    expect(mirrorDirName('https://github.com/org/repo/')).toBe('github.com-org-repo.git');
  });
});

describe('ensureMirror', () => {
  it('clones as bare, sets the heads refspec, adds the pull refspec, and fetches when the mirror does not exist yet', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
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
    ]);
  });

  it('adds the pull refspec once when an existing mirror only has the heads refspec', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    git.queueResponse({ stdout: '+refs/heads/*:refs/remotes/origin/*\n', stderr: '' });
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['config', '--get-all', 'remote.origin.fetch'], cwd: '/mirrors/github.com-org-repo.git' },
      {
        args: ['config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('does not add the pull refspec again when an existing mirror already has both refspecs', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    git.queueResponse({
      stdout: '+refs/heads/*:refs/remotes/origin/*\n+refs/pull/*/head:refs/remotes/origin/pr/*\n',
      stderr: '',
    });
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['config', '--get-all', 'remote.origin.fetch'], cwd: '/mirrors/github.com-org-repo.git' },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('adds the heads refspec once when an existing mirror only has the pulls refspec', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    git.queueResponse({ stdout: '+refs/pull/*/head:refs/remotes/origin/pr/*\n', stderr: '' });
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['config', '--get-all', 'remote.origin.fetch'], cwd: '/mirrors/github.com-org-repo.git' },
      {
        args: ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('tolerates an existing mirror with no fetch refspec configured at all, and adds both refspecs', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    const keyNotSetError = Object.assign(
      new Error('Command failed: git config --get-all remote.origin.fetch\n'),
      { code: 1, stderr: '' },
    );
    git.queueResponse(keyNotSetError);
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['config', '--get-all', 'remote.origin.fetch'], cwd: '/mirrors/github.com-org-repo.git' },
      {
        args: ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      {
        args: ['config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('propagates a config read failure that is not the missing-refspec-key case', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    git.queueResponse(new Error('fatal: not a git repository'));
    await expect(ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git')).rejects.toThrow(
      'fatal: not a git repository',
    );
    expect(git.calls).toEqual([
      { args: ['config', '--get-all', 'remote.origin.fetch'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('treats a directory without a HEAD file as not yet cloned, and attempts to clone', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(git.calls[0]).toEqual({
      args: ['clone', '--bare', 'git@github.com:org/repo.git', '/mirrors/github.com-org-repo.git'],
      cwd: '/mirrors',
    });
  });

  it('propagates a clone failure instead of swallowing it', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    git.queueResponse(new Error('clone failed: repository not found'));
    await expect(ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git')).rejects.toThrow(
      'clone failed',
    );
  });
});
