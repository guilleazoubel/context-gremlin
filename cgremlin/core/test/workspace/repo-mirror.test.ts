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
});

describe('ensureMirror', () => {
  it('clones the mirror when it does not exist yet', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      {
        args: ['clone', '--mirror', 'git@github.com:org/repo.git', '/mirrors/github.com-org-repo.git'],
        cwd: '/mirrors',
      },
    ]);
  });

  it('fetches instead of cloning when the mirror already exists', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['fetch', '--all', '--prune'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });
});
