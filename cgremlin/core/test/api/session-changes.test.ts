import { describe, expect, it } from 'vitest';
import { computeSessionChanges } from '../../src/api/session-changes';
import { FakeGitRunner } from '../support/fake-git-runner';

const CWD = '/worktrees/s1';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_BASE_SHA = 'b'.repeat(40);

describe('computeSessionChanges', () => {
  it('resolves merge-base, diffs mergeBase..HEAD for committed, and HEAD for the working tree', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' }); // rev-parse HEAD
    git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' }); // merge-base
    git.queueResponse({ stdout: '3\t1\tsrc/foo.ts\n5\t0\tsrc/bar.ts\n', stderr: '' }); // committed numstat
    git.queueResponse({ stdout: 'M\tsrc/foo.ts\nA\tsrc/bar.ts\n', stderr: '' }); // committed name-status
    git.queueResponse({ stdout: '', stderr: '' }); // workingTree numstat (clean)
    git.queueResponse({ stdout: '', stderr: '' }); // workingTree name-status (clean)

    const result = await computeSessionChanges(git, CWD, 'origin/main');

    expect(result.head).toBe(HEAD_SHA);
    expect(result.base).toBe('origin/main');
    expect(result.baseResolved).toBe(true);
    expect(result.committed).toEqual({
      files: 2,
      additions: 8,
      deletions: 1,
      entries: [
        { path: 'src/bar.ts', additions: 5, deletions: 0, status: 'A' },
        { path: 'src/foo.ts', additions: 3, deletions: 1, status: 'M' },
      ],
    });
    expect(result.workingTree).toEqual({ files: 0, additions: 0, deletions: 0, entries: [] });

    expect(git.calls[1].args).toEqual(['merge-base', 'origin/main', 'HEAD']);
    expect(git.calls[2].args).toEqual(['diff', '--no-renames', '--numstat', MERGE_BASE_SHA, 'HEAD']);
    expect(git.calls[3].args).toEqual(['diff', '--no-renames', '--name-status', MERGE_BASE_SHA, 'HEAD']);
    expect(git.calls[4].args).toEqual(['diff', '--no-renames', '--numstat', 'HEAD']);
    expect(git.calls[5].args).toEqual(['diff', '--no-renames', '--name-status', 'HEAD']);
  });

  it('falls back to a plain three-dot diff and reports baseResolved:false when merge-base fails', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' }); // rev-parse HEAD
    git.queueResponse(new Error('fatal: Not a valid object name origin/main')); // merge-base fails
    git.queueResponse({ stdout: '2\t0\tREADME.md\n', stderr: '' }); // committed numstat (fallback)
    git.queueResponse({ stdout: 'M\tREADME.md\n', stderr: '' }); // committed name-status (fallback)
    git.queueResponse({ stdout: '', stderr: '' }); // workingTree numstat
    git.queueResponse({ stdout: '', stderr: '' }); // workingTree name-status

    const result = await computeSessionChanges(git, CWD, 'origin/main');

    expect(result.baseResolved).toBe(false);
    expect(result.committed.files).toBe(1);
    expect(git.calls[2].args).toEqual(['diff', '--no-renames', '--numstat', 'origin/main...HEAD']);
    expect(git.calls[3].args).toEqual(['diff', '--no-renames', '--name-status', 'origin/main...HEAD']);
  });

  it('reports uncommitted working-tree changes separately from committed changes', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' }); // committed: clean
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse({ stdout: '1\t1\tsrc/dirty.ts\n', stderr: '' }); // workingTree numstat
    git.queueResponse({ stdout: 'M\tsrc/dirty.ts\n', stderr: '' }); // workingTree name-status

    const result = await computeSessionChanges(git, CWD, 'origin/main');

    expect(result.committed).toEqual({ files: 0, additions: 0, deletions: 0, entries: [] });
    expect(result.workingTree).toEqual({
      files: 1,
      additions: 1,
      deletions: 1,
      entries: [{ path: 'src/dirty.ts', additions: 1, deletions: 1, status: 'M' }],
    });
  });

  it('a binary file (numstat "-\\t-") counts as one file with zero additions/deletions', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    git.queueResponse({ stdout: '-\t-\tassets/logo.png\n', stderr: '' });
    git.queueResponse({ stdout: 'M\tassets/logo.png\n', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });

    const result = await computeSessionChanges(git, CWD, 'origin/main');

    expect(result.committed).toEqual({
      files: 1,
      additions: 0,
      deletions: 0,
      entries: [{ path: 'assets/logo.png', additions: 0, deletions: 0, status: 'M' }],
    });
  });
});
