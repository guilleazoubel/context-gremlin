import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOriginRepo, startEngine, type Engine } from '../support/e2e-harness';
import type { Session } from '../../src/schema/session';

function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface ChangesBody {
  base: string;
  baseResolved: boolean;
  head: string;
  committed: { files: number; additions: number; deletions: number; entries: unknown[] };
  workingTree: { files: number; additions: number; deletions: number; entries: unknown[] };
}

describe.skipIf(!hasGit())('GET /sessions/:id/changes end-to-end against a real git worktree', () => {
  let root: string;
  let worktreePath: string;
  let engine: Engine;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-e2e-changes-'));
    const originPath = await createOriginRepo(root);
    engine = await startEngine(root);

    // A real clone, so `origin/main` is a real remote-tracking ref that
    // `git merge-base origin/main HEAD` can resolve.
    worktreePath = path.join(root, 'wt');
    gitRun(['clone', '-q', originPath, worktreePath], root);
    gitRun(['config', 'user.email', 'e2e@example.com'], worktreePath);
    gitRun(['config', 'user.name', 'e2e'], worktreePath);

    const session: Session = {
      schemaVersion: 2,
      id: 'changes-e2e',
      createdAt: '2026-09-01T00:00:00.000Z',
      mode: 'development',
      stageStatus: 'active',
      workspace: { repoUrl: originPath, worktreePath, branch: 'main' },
      lineage: { pipelineId: 'changes-e2e', parentSessionId: null, ticket: null, selfReview: false },
      agent: null,
      lastRun: null,
      pr: null,
    };
    const created = await engine.request('POST', '/sessions', session);
    expect(created.status).toBe(201);
  }, 20_000);

  afterAll(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it('counts a real commit under `committed` and a real uncommitted edit under `workingTree`', async () => {
    await writeFile(path.join(worktreePath, 'added.ts'), 'export const x = 1;\n', 'utf8');
    gitRun(['add', 'added.ts'], worktreePath);
    gitRun(['commit', '-q', '-m', 'add a file'], worktreePath);

    const res = await engine.request('GET', '/sessions/changes-e2e/changes');
    expect(res.status).toBe(200);
    const body = res.body as ChangesBody;
    expect(body.base).toBe('origin/main');
    expect(body.baseResolved).toBe(true);
    expect(body.head).toBe(gitRun(['rev-parse', 'HEAD'], worktreePath).trim());
    expect(body.committed.files).toBe(1);
    expect(body.committed.entries).toEqual([{ path: 'added.ts', additions: 1, deletions: 0, status: 'A' }]);
    expect(body.workingTree.files).toBe(0);

    // Now dirty a tracked file without committing it.
    await writeFile(path.join(worktreePath, 'README.md'), '# e2e\nedited\n', 'utf8');

    const after = (await engine.request('GET', '/sessions/changes-e2e/changes')).body as ChangesBody;
    expect(after.committed.files).toBe(1);
    expect(after.workingTree.files).toBe(1);
    expect(after.workingTree.entries).toEqual([{ path: 'README.md', additions: 1, deletions: 0, status: 'M' }]);
  }, 20_000);
});
