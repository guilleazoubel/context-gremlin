import { describe, expect, it } from 'vitest';
import { managedWorkspaceContent, planWorkspaceAction, type WorkspacePlan } from '../src/model/workspace-file';

const managedPath = '/home/me/.cgremlin/cgremlin.code-workspace';
const worktreePath = '/home/me/.cgremlin/worktrees/pr-acme-web-102';
const otherWorktree = '/home/me/.cgremlin/worktrees/inv-acme-web-7f3';

function plan(overrides: Partial<Parameters<typeof planWorkspaceAction>[0]> = {}): WorkspacePlan {
  return planWorkspaceAction({
    workspaceFile: managedPath,
    folders: [otherWorktree],
    worktreePath,
    managedPath,
    dirtyPaths: [],
    ...overrides,
  });
}

describe('planWorkspaceAction', () => {
  it('does nothing when the managed workspace already holds exactly this worktree', () => {
    expect(plan({ folders: [worktreePath] })).toEqual({ kind: 'noop' });
  });

  it('swaps the single folder of the managed workspace', () => {
    expect(plan()).toEqual({ kind: 'swap', uri: worktreePath, removeCount: 1, requiresConfirm: false });
  });

  it('adds the folder when the managed workspace has none', () => {
    expect(plan({ folders: [] })).toEqual({
      kind: 'swap',
      uri: worktreePath,
      removeCount: 0,
      requiresConfirm: false,
    });
  });

  it('offers the managed workspace when this window is not it', () => {
    const undefinedFile = plan({ workspaceFile: undefined });
    expect(undefinedFile).toMatchObject({ kind: 'offer-open-managed', managedPath });
    const otherFile = plan({ workspaceFile: '/home/me/projects/other.code-workspace' });
    expect(otherFile).toMatchObject({ kind: 'offer-open-managed', managedPath });
    if (undefinedFile.kind !== 'offer-open-managed') throw new Error('expected an offer');
    expect(JSON.parse(undefinedFile.bootstrap).folders).toEqual([
      { path: worktreePath, name: 'pr-acme-web-102' },
    ]);
  });

  describe('R-10a — unsaved work is never closed by a click', () => {
    it('requires confirmation for a dirty document inside a folder being removed', () => {
      const result = plan({ dirtyPaths: [`${otherWorktree}/src/app.ts`] });
      expect(result).toMatchObject({ kind: 'swap', requiresConfirm: true });
    });

    it('does not for a dirty document in the incoming worktree, outside every folder, or none at all', () => {
      expect(plan({ dirtyPaths: [`${worktreePath}/src/app.ts`] })).toMatchObject({ requiresConfirm: false });
      expect(plan({ dirtyPaths: ['/tmp/scratch.md'] })).toMatchObject({ requiresConfirm: false });
      expect(plan({ dirtyPaths: [] })).toMatchObject({ requiresConfirm: false });
    });

    it('never carries requiresConfirm on a plan that removes nothing', () => {
      const noop = plan({ folders: [worktreePath], dirtyPaths: [`${worktreePath}/src/app.ts`] });
      expect(noop).toEqual({ kind: 'noop' });
      expect('requiresConfirm' in noop).toBe(false);
    });

    it('is not fooled by a sibling folder whose path merely shares a prefix', () => {
      const sibling = `${otherWorktree}-2`;
      const result = plan({ folders: [sibling], dirtyPaths: [`${otherWorktree}/src/app.ts`] });
      expect(result).toMatchObject({ requiresConfirm: false });
    });
  });
});

describe('MG-B5 one-worktree-folder-at-a-time', () => {
  const cases: { folders: string[]; dirtyPaths?: string[]; workspaceFile?: string | undefined }[] = [
    { folders: [] },
    { folders: [otherWorktree] },
    { folders: [worktreePath] },
    { folders: [otherWorktree, worktreePath] },
    { folders: [otherWorktree, '/home/me/projects/thing'] },
    { folders: [otherWorktree], dirtyPaths: [`${otherWorktree}/a.ts`] },
    { folders: [otherWorktree], workspaceFile: undefined },
  ];

  it('every swap removes every folder it found, so two repo folders can never coexist', () => {
    for (const input of cases) {
      const result = plan(input);
      if (result.kind === 'swap') {
        expect(result.removeCount).toBe(input.folders.length);
        expect(result.uri).toBe(worktreePath);
      }
    }
  });

  it('never returns an add plan', () => {
    for (const input of cases) {
      expect(plan(input).kind).not.toBe('add');
    }
  });

  it('bootstraps a managed file with exactly one folder', () => {
    const parsed = JSON.parse(managedWorkspaceContent(worktreePath, 'pr-acme-web-102'));
    expect(parsed.folders).toHaveLength(1);
    expect(parsed.folders[0]).toEqual({ path: worktreePath, name: 'pr-acme-web-102' });
    expect(parsed.settings).toEqual({ 'cgremlin.managed': true });
  });
});

describe('MG-B3 no-extension-host-restart', () => {
  it('offers the managed workspace rather than mutating a single-folder window', () => {
    expect(plan({ workspaceFile: undefined, folders: ['/home/me/projects/thing'] }).kind).toBe(
      'offer-open-managed',
    );
    expect(plan({ workspaceFile: '/home/me/projects/other.code-workspace' }).kind).toBe(
      'offer-open-managed',
    );
  });
});
