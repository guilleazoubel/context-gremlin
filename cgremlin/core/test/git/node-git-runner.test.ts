import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeGitRunner } from '../../src/git/node-git-runner';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-git-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('NodeGitRunner', () => {
  it('runs a real git command and returns its stdout', async () => {
    const git = new NodeGitRunner();
    await git.run(['init'], { cwd: dir });
    const { stdout } = await git.run(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    expect(stdout.trim()).toBe('true');
  });

  it('rejects when the git command fails', async () => {
    const git = new NodeGitRunner();
    await expect(git.run(['not-a-real-git-command'], { cwd: dir })).rejects.toThrow();
  });
});
