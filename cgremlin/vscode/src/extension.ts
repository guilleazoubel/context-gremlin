/**
 * The composition root — the only file in the extension that imports `vscode` besides
 * `settings.ts` (R14, MG-B1). Everything here is either an adapter from one real API to the
 * narrow {@link Host} member it backs, or one line of wiring; all behaviour lives in `ui/*`,
 * which is why this file has no unit test of its own and `ui/wiring.ts` has one.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as vscode from 'vscode';
import { CoreClient } from './core-client';
import { engineBundlePath, loadBridge, type EngineBridge } from './engine/bridge';
import { watchFileByRename } from './engine/file-watch';
import { EngineManager } from './engine/manager';
import { NodeEngineProcess, resolveLoginPath } from './engine/node-engine-process';
import { SseClient } from './sse';
import { readSettings } from './settings';
import { EngineSurface } from './ui/engine';
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
let engineSurface: EngineSurface | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('cgremlin');
  context.subscriptions.push(output);
  const host = buildHost(output, context.globalState);
  // The socket path is not a setting: it is derived from `core.json` by the engine's own loader
  // (MG-C6), and it reaches the client layer as a provider so a settings change can re-point it
  // without rebuilding the UI and releasing every chat claim (R7).
  const socketPath = (): string => engineSurface?.paths()?.socketPath ?? '';
  const client = new CoreClient(socketPath);
  const sse = new SseClient({ socketPath });
  stream = sse;

  let created: Ui | null = null;
  let bridge: EngineBridge;
  try {
    bridge = loadBridge(context.extensionPath);
  } catch (err) {
    // The build produces the engine bundle; only a half-built checkout gets here, and R9's message
    // says which command was missed. Failing loudly here beats registering commands that cannot
    // work, but it must not be a stack trace in the developer console.
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`cgremlin: ${message}`);
    void vscode.window.showWarningMessage(message);
    return;
  }
  const manager = new EngineManager({
    process: new NodeEngineProcess(),
    bundledVersion: bridge.ENGINE_VERSION,
    paths: () => {
      const resolved = engineSurface?.paths();
      return {
        configPath: resolved?.configPath ?? readSettings().configPath,
        socketPath: resolved?.socketPath ?? '',
        enginePidPath: resolved?.enginePidPath ?? '',
        engineLogPath: resolved?.engineLogPath ?? '',
      };
    },
    launch: () => ({
      // `process.execPath` is the editor's own Node host; `ELECTRON_RUN_AS_NODE` (set by the
      // adapter) is what makes it behave as Node.
      execPath: process.execPath,
      enginePath: engineBundlePath(context.extensionPath),
      cwd: os.homedir(),
    }),
    log: (line) => output.appendLine(line),
  });

  const surface = new EngineSurface({
    host,
    manager,
    bridge,
    configPath: () => readSettings().configPath,
    home: os.homedir(),
    execPath: process.execPath,
    enginePath: engineBundlePath(context.extensionPath),
    resolveLoginPath: () => resolveLoginPath(),
    reconnect: async () => {
      sse.stop();
      sse.start();
      await created?.connect();
    },
  });
  engineSurface = surface;

  created = createUi({
    host,
    client,
    // Read live, so changing the level takes effect without a reload.
    notificationLevel: () => readSettings().notificationLevel,
    engine: surface,
  });
  ui = created;

  const ready = created;
  // Every frame is a hint that something changed; the coordinator coalesces a burst into one
  // refetch, so the extension never trusts a frame's payload to be the whole truth.
  sse.on('frame', () => ready.coordinator.schedule());
  sse.on('resync', () => ready.coordinator.schedule());
  sse.on('open', () => ready.coordinator.schedule());
  sse.on('offline', () => void ready.offline());

  // R15: opening a window starts the engine. Everything that can go wrong on the way — a missing
  // `core.json`, a `ConfigError`, an engine that will not come up — is surfaced by the surface.
  void surface.bootstrap();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cgremlin')) void surface.settingsChanged();
    }),
  );
  context.subscriptions.push({ dispose: () => sse.stop() });
  // R30: the log tail and the config watcher are both `fs.watch` handles, and an undisposed watch
  // survives a window reload and tails into a dead channel.
  context.subscriptions.push({ dispose: () => surface.dispose() });
  context.subscriptions.push({
    dispose: () => {
      void ready.dispose();
    },
  });
}

export async function deactivate(): Promise<void> {
  stream?.stop();
  stream = null;
  // R16: no window owns the engine. Deactivation releases this window's claims and lets go of its
  // watches; it never stops a daemon every other window is also using.
  engineSurface?.dispose();
  engineSurface = null;
  const current = ui;
  ui = null;
  // Releases every conversation claim this window holds, and clears every heartbeat (R20).
  await current?.dispose();
}

function buildHost(output: vscode.OutputChannel, state: vscode.Memento): Host {
  const log = (line: string): void => output.appendLine(line);
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
        get warning() {
          return item.backgroundColor !== undefined;
        },
        set warning(value: boolean) {
          item.backgroundColor = value
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
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
    fileSize(path: string) {
      try {
        return fs.statSync(path).size;
      } catch {
        return 0;
      }
    },
    readFileSlice(path: string, from: number) {
      try {
        const buffer = fs.readFileSync(path);
        const slice = buffer.subarray(Math.min(from, buffer.byteLength));
        return { text: slice.toString('utf8'), end: buffer.byteLength };
      } catch {
        return { text: '', end: from };
      }
    },
    watchFile(path: string, callback: () => void) {
      return watchFileByRename(path, callback);
    },
    async chmod(path: string, mode: number) {
      await fs.promises.chmod(path, mode);
    },

    async openTextDocument(path: string) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document);
    },
    spawnCapture(command, args, options) {
      return new Promise((resolve) => {
        execFile(
          command,
          [...args],
          {
            cwd: options?.cwd,
            timeout: options?.timeoutMs,
            encoding: 'utf8',
            // The overrides are merged onto this process's own environment, never a replacement
            // for it: only `PATH` is ever supplied, and only to match the engine's spawn (R20).
            env: options?.env === undefined ? process.env : { ...process.env, ...options.env },
          },
          (err, stdout, stderr) => {
            const code =
              err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
            resolve({ code, stdout, stderr });
          },
        );
      });
    },

    getState<T>(key: string) {
      return state.get<T>(key);
    },
    setState(key: string, value: unknown) {
      return state.update(key, value);
    },

    appendOutput(line: string) {
      output.appendLine(line);
    },
    showOutput() {
      output.show(true);
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
