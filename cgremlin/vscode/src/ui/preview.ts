/**
 * The worktree swap: make the managed workspace hold exactly one worktree (§5.5).
 *
 * R23 removed the other half of what used to live here — the markdown preview — because the Item
 * tab renders artifacts itself now. What is left is the part that must exist in exactly one
 * place: the plan, the dirty-editor modal, and the single `updateWorkspaceFolders` call.
 */
import path from 'node:path';
import { managedWorkspaceContent, planWorkspaceAction } from '../model/workspace-file';
import type { CoreConfigView } from '../model/items';
import type { Host } from './host';

export const MANAGED_WORKSPACE_NAME = 'cgremlin.code-workspace';
export const SWITCH_ANYWAY = 'Switch anyway';
export const OPEN_MANAGED = 'Open the cgremlin workspace';

export function managedWorkspacePath(stateDir: string): string {
  return `${stateDir}/${MANAGED_WORKSPACE_NAME}`;
}

export interface WorktreeSwapperDeps {
  host: Host;
  config: () => CoreConfigView | null;
}

export class WorktreeSwapper {
  constructor(private readonly deps: WorktreeSwapperDeps) {}

  /** No-ops when there is no config yet, or when the worktree is already the only folder. */
  async swapTo(id: string, worktreePath: string): Promise<void> {
    const config = this.deps.config();
    if (config === null) return;
    await applyWorkspace(this.deps.host, id, worktreePath, config);
  }
}

async function applyWorkspace(
  host: Host,
  id: string,
  worktreePath: string,
  config: CoreConfigView,
): Promise<void> {
  const plan = planWorkspaceAction({
    workspaceFile: host.workspaceFile(),
    folders: host.workspaceFolders(),
    worktreePath,
    managedPath: managedWorkspacePath(config.stateDir),
    dirtyPaths: host.dirtyPaths(),
  });
  if (plan.kind === 'noop') return;

  if (plan.kind === 'swap') {
    if (plan.requiresConfirm) {
      // Unsaved work is never closed by a click on a tree row (R-10a). Awaited, and awaited
      // *before* the swap: this is the one blocking dialog in the extension.
      const answer = await host.showWarningMessage(
        `Switching to '${id}' closes the editors of the current worktree, and you have unsaved changes there.`,
        { modal: true },
        SWITCH_ANYWAY,
      );
      if (answer !== SWITCH_ANYWAY) return;
    }
    host.updateWorkspaceFolders(0, plan.removeCount, {
      uri: host.fileUri(plan.uri),
      name: path.basename(plan.uri),
    });
    if (plan.removeCount > 0) {
      void host.showInformationMessage(
        `Opened '${id}'. VS Code closed the editors of the worktree it replaced.`,
        undefined,
      );
    }
    return;
  }

  // offer-open-managed: opening a workspace file reloads the window, the one unavoidable
  // restart, so it is offered and never forced.
  if (!host.fileExists(plan.managedPath)) {
    host.writeFile(plan.managedPath, plan.bootstrap);
  }
  const answer = await host.showInformationMessage(
    `cgremlin keeps one worktree open in ${MANAGED_WORKSPACE_NAME}. Open it? (This reloads the window.)`,
    undefined,
    OPEN_MANAGED,
  );
  if (answer === OPEN_MANAGED) {
    await host.executeCommand('vscode.openFolder', host.fileUri(plan.managedPath));
  }
}

/** Exported for the bootstrap the CLI-less first run needs; the plan lives in `model/`. */
export { managedWorkspaceContent };

