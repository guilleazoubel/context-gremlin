/**
 * Open item: preview the core-chosen primary artifact, then make the managed workspace hold this
 * session's worktree (§5.5).
 *
 * The two halves are independent on purpose. The built-in markdown preview creates its own
 * per-resource watcher, so the artifact does not need to be inside the workspace — which is why a
 * declined workspace offer, a dismissed swap modal, or a session with no worktree at all still
 * opens the document.
 */
import path from 'node:path';
import { engineErrorText, CoreHttpError, type CoreClient } from '../core-client';
import { managedWorkspaceContent, planWorkspaceAction } from '../model/workspace-file';
import type { CoreConfigView } from '../model/items';
import type { Host } from './host';

export const MANAGED_WORKSPACE_NAME = 'cgremlin.code-workspace';
export const SWITCH_ANYWAY = 'Switch anyway';
export const OPEN_MANAGED = 'Open the cgremlin workspace';

export interface OpenTarget {
  sessionId: string | null;
  title: string;
  worktreePath: string | null;
  prUrl: string | null;
}

/**
 * The worktree-swap half of "open item", on its own (R23).
 *
 * Phase 9 opens an Item tab rather than a markdown preview, but the swap — one managed folder, a
 * modal before unsaved work is closed — is unchanged and must stay in exactly one place, so the
 * tab and the older opener share this.
 */
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

export interface ItemOpenerDeps {
  host: Host;
  client: CoreClient;
  config: () => CoreConfigView | null;
  onOpened: (sessionId: string, worktreePath: string | null) => void;
}

export function managedWorkspacePath(stateDir: string): string {
  return `${stateDir}/${MANAGED_WORKSPACE_NAME}`;
}

export class ItemOpener {
  constructor(private readonly deps: ItemOpenerDeps) {}

  async open(target: OpenTarget): Promise<void> {
    const { host } = this.deps;
    if (target.sessionId === null) {
      // A parking-lot row is an inventory entry with no session, so it has no artifact of its own.
      // The PR itself is the only thing there is to open; starting a review is a separate command.
      if (target.prUrl !== null) await host.openExternal(target.prUrl);
      else void host.showWarningMessage(`'${target.title}' has nothing to open yet.`, undefined);
      return;
    }
    const config = this.deps.config();
    if (config === null) {
      void host.showWarningMessage('Not connected to the cgremlin engine yet.', undefined);
      return;
    }
    const id = target.sessionId;
    await this.preview(id, config);
    this.deps.onOpened(id, target.worktreePath);
    if (target.worktreePath !== null) {
      await applyWorkspace(this.deps.host, id, target.worktreePath, config);
    }
  }

  private async preview(id: string, config: CoreConfigView): Promise<void> {
    const { host, client } = this.deps;
    let primary: string | null = null;
    try {
      primary = (await client.artifacts(id)).primary;
    } catch (err) {
      void host.showWarningMessage(messageOf(err), undefined);
      return;
    }
    if (primary === null) {
      void host.showWarningMessage(`Session '${id}' has no artifact to preview yet.`, undefined);
      return;
    }
    await host.executeCommand(
      'markdown.showPreview',
      host.fileUri(`${config.sessionsDir}/${id}/${primary}`),
    );
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

function messageOf(err: unknown): string {
  if (err instanceof CoreHttpError) return engineErrorText(err.body);
  return err instanceof Error ? err.message : String(err);
}
