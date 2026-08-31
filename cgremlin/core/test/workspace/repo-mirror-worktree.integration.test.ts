import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeGitRunner } from '../../src/git/node-git-runner';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { ensureMirror } from '../../src/workspace/repo-mirror';
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
});
