/**
 * The composition root — the only file in the extension that imports `vscode` besides
 * `settings.ts` (R14, MG-B1). Everything here is either an adapter from one real API to the
 * narrow {@link Host} member it backs, or one line of wiring; all behaviour lives in `ui/*`,
 * which is why this file has no unit test of its own and `ui/wiring.ts` has one.
 */
import fs from 'node:fs';
import * as vscode from 'vscode';
import { CoreClient } from './core-client';
import { SseClient } from './sse';
import { readSettings } from './settings';
import { createUi, type Ui } from './ui/wiring';
import type {
  DisposableLike,
  EventEmitterLike,
  Host,
  InputBoxOptionsLike,
  QuickPickOptionsLike,
  StatusBarItemLike,
  TerminalLike,
  TerminalOptionsLike,
  TreeDataProviderLike,
  TreeItemLike,
  UriLike,
} from './ui/host';

let ui: Ui | null = null;
let stream: SseClient | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('cgremlin');
  context.subscriptions.push(output);
  const settings = readSettings();
  const host = buildHost((line) => output.appendLine(line));
  const client = new CoreClient(settings.socketPath);

  const created = createUi({
    host,
    client,
    // Read live, so changing the level takes effect without a reload.
    notificationLevel: () => readSettings().notificationLevel,
    configPath: () => readSettings().configPath,
  });
  ui = created;

  const sse = new SseClient({ socketPath: settings.socketPath });
  stream = sse;
  // Every frame is a hint that something changed; the coordinator coalesces a burst into one
  // refetch, so the extension never trusts a frame's payload to be the whole truth.
  sse.on('frame', () => created.coordinator.schedule());
  sse.on('resync', () => created.coordinator.schedule());
  sse.on('open', () => created.coordinator.schedule());
  sse.on('offline', () => void created.offline());

  void created.connect();
  // The stream retries with backoff regardless of whether the first connect succeeded.
  sse.start();

  context.subscriptions.push({ dispose: () => sse.stop() });
  context.subscriptions.push({
    dispose: () => {
      void created.dispose();
    },
  });
}

export async function deactivate(): Promise<void> {
  stream?.stop();
  stream = null;
  const current = ui;
  ui = null;
  // Releases every conversation claim this window holds, and clears every heartbeat (R20).
  await current?.dispose();
}

function buildHost(log: (line: string) => void): Host {
  return {
    async showInformationMessage(message, options, ...items) {
      return await vscode.window.showInformationMessage(message, options ?? {}, ...items);
    },
    async showWarningMessage(message, options, ...items) {
      return await vscode.window.showWarningMessage(message, options ?? {}, ...items);
    },
    async showQuickPick(pickItems: readonly string[], options?: QuickPickOptionsLike) {
      return await vscode.window.showQuickPick([...pickItems], options);
    },
    async showInputBox(options: InputBoxOptionsLike) {
      return await vscode.window.showInputBox(options);
    },

    async executeCommand(command, ...args) {
      return await vscode.commands.executeCommand(command, ...args);
    },
    registerCommand(id, callback) {
      return vscode.commands.registerCommand(id, (...args: unknown[]) => callback(...args));
    },
    registerTreeDataProvider<T>(viewId: string, provider: TreeDataProviderLike<T>): DisposableLike {
      return vscode.window.registerTreeDataProvider<T>(viewId, {
        onDidChangeTreeData: provider.onDidChangeTreeData as
          | vscode.Event<T | undefined>
          | undefined,
        getTreeItem: (element: T) => toTreeItem(provider.getTreeItem(element)),
        getChildren: (element?: T) => provider.getChildren(element),
      });
    },
    createEventEmitter<T>(): EventEmitterLike<T> {
      return new vscode.EventEmitter<T>();
    },
    createTreeItem(label: string, collapsibleState: number): TreeItemLike {
      return { label, collapsibleState };
    },
    createStatusBarItem(): StatusBarItemLike {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      return {
        get text() {
          return item.text;
        },
        set text(value: string) {
          item.text = value;
        },
        get tooltip() {
          return typeof item.tooltip === 'string' ? item.tooltip : undefined;
        },
        set tooltip(value: string | undefined) {
          item.tooltip = value;
        },
        get command() {
          return typeof item.command === 'string' ? item.command : undefined;
        },
        set command(value: string | undefined) {
          item.command = value;
        },
        show: () => item.show(),
        hide: () => item.hide(),
        dispose: () => item.dispose(),
      };
    },

    createTerminal(options: TerminalOptionsLike): TerminalLike {
      return vscode.window.createTerminal(options);
    },
    onDidCloseTerminal(listener) {
      return vscode.window.onDidCloseTerminal((terminal) => listener(terminal));
    },

    async openExternal(url: string) {
      return await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    fileUri(fsPath: string): UriLike {
      return vscode.Uri.file(fsPath);
    },
    workspaceFile() {
      return vscode.workspace.workspaceFile?.fsPath;
    },
    workspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    },
    dirtyPaths() {
      return vscode.workspace.textDocuments
        .filter((document) => document.isDirty)
        .map((document) => document.uri.fsPath);
    },
    updateWorkspaceFolders(start, deleteCount, ...add) {
      return vscode.workspace.updateWorkspaceFolders(
        start,
        deleteCount,
        ...add.map((entry) => ({ uri: entry.uri as vscode.Uri, name: entry.name })),
      );
    },

    fileExists(path: string) {
      return fs.existsSync(path);
    },
    writeFile(path: string, content: string) {
      fs.writeFileSync(path, content, 'utf8');
    },

    setInterval(callback, ms) {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    },
    setTimeout(callback, ms) {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },

    log,
  };
}

function toTreeItem(like: TreeItemLike): vscode.TreeItem {
  const item = new vscode.TreeItem(like.label ?? '', like.collapsibleState ?? 0);
  item.id = like.id;
  item.description = like.description;
  item.tooltip = like.tooltip;
  item.contextValue = like.contextValue;
  item.command = like.command;
  return item;
}
