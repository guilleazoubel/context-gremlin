/**
 * The managed multi-root workspace file, and the plan for opening a session's worktree in it.
 *
 * Exactly **one** repo folder is ever present (R15): opening another session swaps it in a single
 * `updateWorkspaceFolders(0, removeCount, { uri })` call. There is no code path that appends a
 * second repo folder, which is what keeps the extension host from restarting (MG-B5, MG-B3).
 *
 * Pure module — Node stdlib only, no editor API (MG-B1).
 */
import path from 'node:path';

export type WorkspacePlan =
  | { kind: 'noop' }
  /** `requiresConfirm`: a dirty document lives inside a folder this swap removes (R-10a). */
  | { kind: 'swap'; uri: string; removeCount: number; requiresConfirm: boolean }
  | { kind: 'offer-open-managed'; managedPath: string; bootstrap: string };

export interface WorkspaceActionInput {
  /** The current window's `.code-workspace` file, or undefined for a folder/empty window. */
  workspaceFile: string | undefined;
  folders: readonly string[];
  worktreePath: string;
  managedPath: string;
  /** `workspace.textDocuments.filter(d => d.isDirty)`, read by the host and passed in. */
  dirtyPaths: readonly string[];
}

export function planWorkspaceAction(input: WorkspaceActionInput): WorkspacePlan {
  const { workspaceFile, folders, worktreePath, managedPath, dirtyPaths } = input;

  if (workspaceFile === undefined || !samePath(workspaceFile, managedPath)) {
    // Opening the managed workspace is a window reload — the one unavoidable restart — so it is
    // offered, never forced.
    return {
      kind: 'offer-open-managed',
      managedPath,
      bootstrap: managedWorkspaceContent(worktreePath, path.basename(worktreePath)),
    };
  }

  if (folders.length === 1 && samePath(folders[0], worktreePath)) {
    return { kind: 'noop' };
  }

  const removed = folders.filter((folder) => !samePath(folder, worktreePath));
  const requiresConfirm = dirtyPaths.some((dirty) => removed.some((folder) => contains(folder, dirty)));
  return { kind: 'swap', uri: worktreePath, removeCount: folders.length, requiresConfirm };
}

/** The managed file: one folder, always. */
export function managedWorkspaceContent(worktreePath: string, name: string): string {
  return `${JSON.stringify(
    { folders: [{ path: worktreePath, name }], settings: { 'cgremlin.managed': true } },
    null,
    2,
  )}\n`;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function contains(dir: string, candidate: string): boolean {
  const root = path.resolve(dir);
  const target = path.resolve(candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}
