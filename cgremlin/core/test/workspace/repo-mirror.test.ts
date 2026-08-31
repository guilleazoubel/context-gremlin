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
  it('clones as bare, configures the fetch refspec, and fetches when the mirror does not exist yet', async () => {
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
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });

  it('only fetches when the mirror already has a HEAD file (already cloned)', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    await fs.writeFile('/mirrors/github.com-org-repo.git/HEAD', 'ref: refs/heads/master\n');
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['fetch', '--prune', 'origin'], cwd: '/mirrors/github.com-org-repo.git' },
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
