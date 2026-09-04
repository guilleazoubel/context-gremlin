import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeGitRunner } from '../../src/git/node-git-runner';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { ensureMirror, mirrorDirName } from '../../src/workspace/repo-mirror';
import { createWorktree } from '../../src/workspace/worktree';

let dir: string;
let originPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-workspace-test-'));
  const git = new NodeGitRunner();
  originPath = path.join(dir, 'origin');
  await git.run(['init', '-q', originPath], { cwd: dir });
  await git.run(['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: originPath });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureMirror + createWorktree against real git', () => {
  it('mirrors a repo and creates two session worktrees off origin/<default-branch> that both survive a re-fetch', async () => {
    const git = new NodeGitRunner();
    const fs = new NodeFileSystem();
    const mirrorsDir = path.join(dir, 'mirrors');
    const mirrorPath = await ensureMirror(git, fs, mirrorsDir, originPath);

    // Direct regression test for the mirror-push defect: `clone --mirror` sets
    // remote.origin.mirror=true in the shared bare-repo config, which turns an
    // ordinary `git push origin` from any worktree into a mirror push that
    // force-deletes remote branches. `git config --get` exits non-zero on an
    // unset key, so a rejection here means "unset", which is what we want.
    const { stdout: mirrorConfig } = await git
      .run(['config', '--get', 'remote.origin.mirror'], { cwd: mirrorPath })
      .catch((err: unknown) => ({ stdout: '', stderr: (err as Error).message }));
    expect(mirrorConfig.trim()).toBe('');

    const { stdout: branchOut } = await git.run(['branch', '--show-current'], { cwd: originPath });
    const defaultBranch = branchOut.trim();
    const baseRef = `origin/${defaultBranch}`;

    const work1 = path.join(dir, 'work1');
    const work2 = path.join(dir, 'work2');
    await createWorktree(git, mirrorPath, work1, 'session/one', baseRef);
    await createWorktree(git, mirrorPath, work2, 'session/two', baseRef);

    // Simulate a second session's ensureMirror call re-fetching the same mirror
    // — this is exactly the operation that deleted session branches when the
    // mirror used `clone --mirror` + `fetch --all --prune`.
    await ensureMirror(git, fs, mirrorsDir, originPath);

    const { stdout: refs } = await git.run(['for-each-ref', '--format=%(refname)'], {
      cwd: mirrorPath,
    });
    expect(refs).toContain('refs/heads/session/one');
    expect(refs).toContain('refs/heads/session/two');
  });

  it('adopts a pre-existing plain `--bare` clone that has no fetch refspec configured, adding both', async () => {
    const git = new NodeGitRunner();
    const fs = new NodeFileSystem();
    const mirrorsDir = path.join(dir, 'preexisting-mirrors');
    const mirrorPath = path.join(mirrorsDir, mirrorDirName(originPath));

    // A plain `git clone --bare` (unlike this module's own "new mirror" path,
    // and unlike `clone --mirror`) sets no remote.origin.fetch at all — this
    // reproduces a mirror created before ensureMirror existed, or by any
    // other means.
    await git.run(['clone', '--bare', '-q', originPath, mirrorPath], { cwd: dir });
    await expect(
      git.run(['config', '--get-all', 'remote.origin.fetch'], { cwd: mirrorPath }),
    ).rejects.toThrow();

    const resolvedPath = await ensureMirror(git, fs, mirrorsDir, originPath);
    expect(resolvedPath).toBe(mirrorPath);

    const { stdout: refspecs } = await git.run(['config', '--get-all', 'remote.origin.fetch'], {
      cwd: mirrorPath,
    });
    expect(refspecs).toContain('+refs/heads/*:refs/remotes/origin/*');
    expect(refspecs).toContain('+refs/pull/*/head:refs/remotes/origin/pr/*');

    const { stdout: branchOut } = await git.run(['branch', '--show-current'], { cwd: originPath });
    const defaultBranch = branchOut.trim();
    const { stdout: revParseOut } = await git.run(['rev-parse', `origin/${defaultBranch}`], {
      cwd: mirrorPath,
    });
    expect(revParseOut.trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
