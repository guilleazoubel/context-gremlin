/**
 * A hand-written recording `Host`.
 *
 * This is deliberately not a module mock: `src/ui/*` takes its editor surface as a parameter
 * object, so the whole extension-host wiring is exercised here with no `vscode` module and no
 * an Electron test harness. Every call lands in one ordered `calls` log, because several of the
 * behaviours under test are about *order* (the modal before the swap, claim before the terminal).
 */
import type {
  DisposableLike,
  WebviewLike,
  WebviewOptionsLike,
  WebviewPanelLike,
  WebviewPanelOptionsLike,
  WebviewViewLike,
  WebviewViewProviderLike,
  EventEmitterLike,
  Host,
  InputBoxOptionsLike,
  MessageOptionsLike,
  QuickPickOptionsLike,
  SpawnCaptureOptions,
  StatusBarItemLike,
  TerminalLike,
  TerminalOptionsLike,
  UriLike,
} from '../../src/ui/host';

import { createHash } from 'node:crypto';

export interface RecordedCall {
  kind: string;
  args: unknown[];
}

interface FakeTimer {
  kind: 'interval' | 'timeout';
  callback: () => void;
  ms: number;
  cancelled: boolean;
  dueAt: number;
}

export class FakeTerminal implements TerminalLike {
  readonly sent: string[] = [];
  shown = 0;
  disposed = 0;
  constructor(
    readonly name: string,
    readonly options: TerminalOptionsLike,
  ) {}
  sendText(text: string): void {
    this.sent.push(text);
  }
  show(): void {
    this.shown += 1;
  }
  dispose(): void {
    this.disposed += 1;
  }
}

/**
 * A recording webview. The tests drive it from the webview's side — `emit` is the script posting
 * a message — and read `posted` and `html` from the host's side.
 */
export class FakeWebview implements WebviewLike {
  html = '';
  options: WebviewOptionsLike | undefined;
  readonly posted: unknown[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];

  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return true;
  }

  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const at = this.listeners.indexOf(listener);
        if (at >= 0) this.listeners.splice(at, 1);
      },
    };
  }

  /** The script posting to the host. */
  emit(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  /** Every `render` the host has posted, in order. */
  renders(): unknown[] {
    return this.posted.filter((m) => (m as { type?: string }).type === 'render');
  }
}

export class FakeWebviewPanel implements WebviewPanelLike {
  readonly webview = new FakeWebview();
  title: string;
  revealed = 0;
  disposed = 0;
  private readonly disposeListeners: (() => void)[] = [];

  constructor(readonly options: WebviewPanelOptionsLike) {
    this.title = options.title;
  }

  reveal(): void {
    this.revealed += 1;
  }

  onDidDispose(listener: () => void): DisposableLike {
    this.disposeListeners.push(listener);
    return { dispose: () => undefined };
  }

  dispose(): void {
    this.disposed += 1;
    for (const listener of [...this.disposeListeners]) listener();
  }
}

/** The side panel's view, as the editor would hand it to a provider (R54). */
export class FakeWebviewView implements WebviewViewLike {
  readonly webview = new FakeWebview();
  title: string | undefined;
  private readonly disposeListeners: (() => void)[] = [];

  onDidDispose(listener: () => void): DisposableLike {
    this.disposeListeners.push(listener);
    return { dispose: () => undefined };
  }

  dispose(): void {
    for (const listener of [...this.disposeListeners]) listener();
  }
}

export class FakeHost implements Host {
  readonly calls: RecordedCall[] = [];
  readonly commands = new Map<string, (...args: unknown[]) => unknown>();
  readonly providers = new Map<string, WebviewViewProviderLike>();
  readonly views: FakeWebviewView[] = [];
  readonly terminals: FakeTerminal[] = [];
  readonly statusBarItems: FakeStatusBarItem[] = [];
  readonly panels: FakeWebviewPanel[] = [];
  readonly files = new Map<string, string>();
  readonly logs: string[] = [];
  /** The output channel's lines, kept apart from `logs` so a test can tell them apart. */
  readonly output: string[] = [];
  readonly outputShown: number[] = [];
  /** Watches by path, so a test can fire the one it means. */
  readonly watches = new Map<string, { callback: () => void; disposed: number }>();
  /** Answers handed to the next `spawnCapture` calls, keyed by the command. */
  spawnResults = new Map<string, { code: number; stdout: string; stderr: string }>();
  /** Set to make `chmod` reject. */
  chmodError: Error | null = null;
  /** Permission bits per path; a file with no entry reads as 0600. */
  readonly modes = new Map<string, number>();
  /** Run inside `chmod`, after the mode is recorded — a test fires the watch from here. */
  chmodHook: ((path: string, mode: number) => void) | null = null;
  /** Answers handed to the next `showQuickPick` / `showInputBox` / message, in order. */
  quickPickAnswers: (string | undefined)[] = [];
  inputBoxAnswers: (string | undefined)[] = [];
  messageAnswers: (string | undefined)[] = [];
  /** The last `validateInput` an input box was opened with. */
  lastValidateInput: ((value: string) => string | null | undefined) | undefined;
  workspaceFilePath: string | undefined;
  folders: string[] = [];
  dirty: string[] = [];
  private readonly closeTerminalListeners: ((terminal: TerminalLike) => void)[] = [];
  private readonly timers: FakeTimer[] = [];
  private clock = 0;

  private record(kind: string, ...args: unknown[]): void {
    this.calls.push({ kind, args });
  }

  kinds(): string[] {
    return this.calls.map((c) => c.kind);
  }

  callsOf(kind: string): RecordedCall[] {
    return this.calls.filter((c) => c.kind === kind);
  }

  // --- messages -------------------------------------------------------------

  async showInformationMessage(
    message: string,
    options: MessageOptionsLike | undefined,
    ...items: string[]
  ): Promise<string | undefined> {
    this.record('showInformationMessage', message, options, items);
    return this.messageAnswers.shift();
  }

  async showWarningMessage(
    message: string,
    options: MessageOptionsLike | undefined,
    ...items: string[]
  ): Promise<string | undefined> {
    this.record('showWarningMessage', message, options, items);
    return this.messageAnswers.shift();
  }

  async showQuickPick(
    items: readonly string[],
    options?: QuickPickOptionsLike,
  ): Promise<string | undefined> {
    this.record('showQuickPick', [...items], options);
    return this.quickPickAnswers.shift();
  }

  async showInputBox(options: InputBoxOptionsLike): Promise<string | undefined> {
    this.record('showInputBox', options);
    this.lastValidateInput = options.validateInput;
    return this.inputBoxAnswers.shift();
  }

  // --- commands and views ---------------------------------------------------

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    this.record('executeCommand', command, ...args);
    const local = this.commands.get(command);
    if (local !== undefined) return await local(...args);
    return undefined;
  }

  registerCommand(id: string, callback: (...args: unknown[]) => unknown): DisposableLike {
    this.record('registerCommand', id);
    this.commands.set(id, callback);
    return { dispose: () => this.commands.delete(id) };
  }

  /** Invokes a registered command the way the editor would, without recording an executeCommand. */
  async invoke(id: string, ...args: unknown[]): Promise<unknown> {
    const callback = this.commands.get(id);
    if (callback === undefined) throw new Error(`No command registered as '${id}'`);
    return await callback(...args);
  }

  registerWebviewViewProvider(
    viewId: string,
    provider: WebviewViewProviderLike,
    options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
  ): DisposableLike {
    this.record('registerWebviewViewProvider', viewId, options);
    this.providers.set(viewId, provider);
    return { dispose: () => this.providers.delete(viewId) };
  }

  /** Simulates the editor creating the view for a registered provider. */
  resolveView(viewId: string): FakeWebviewView {
    const provider = this.providers.get(viewId);
    if (provider === undefined) throw new Error(`no provider registered for '${viewId}'`);
    const view = new FakeWebviewView();
    provider.resolveWebviewView(view);
    this.views.push(view);
    return view;
  }

  createEventEmitter<T>(): EventEmitterLike<T> {
    const listeners = new Set<(e: T) => unknown>();
    const emitter: EventEmitterLike<T> & { fired: number } = {
      fired: 0,
      event: (listener: (e: T) => unknown) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      fire: (data: T) => {
        emitter.fired += 1;
        this.record('eventFired', data);
        for (const listener of listeners) listener(data);
      },
      dispose: () => listeners.clear(),
    };
    return emitter;
  }

  createWebviewPanel(options: WebviewPanelOptionsLike): WebviewPanelLike {
    this.record('createWebviewPanel', options);
    const panel = new FakeWebviewPanel(options);
    this.panels.push(panel);
    return panel;
  }

  createStatusBarItem(): StatusBarItemLike {
    const item = new FakeStatusBarItem();
    this.statusBarItems.push(item);
    return item;
  }

  // --- terminals ------------------------------------------------------------

  createTerminal(options: TerminalOptionsLike): TerminalLike {
    this.record('createTerminal', options);
    const terminal = new FakeTerminal(options.name, options);
    this.terminals.push(terminal);
    return terminal;
  }

  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike {
    this.closeTerminalListeners.push(listener);
    return {
      dispose: () => {
        const at = this.closeTerminalListeners.indexOf(listener);
        if (at >= 0) this.closeTerminalListeners.splice(at, 1);
      },
    };
  }

  /** Simulates the user killing a terminal. */
  closeTerminal(terminal: TerminalLike): void {
    for (const listener of [...this.closeTerminalListeners]) listener(terminal);
  }

  // --- workspace ------------------------------------------------------------

  async openExternal(url: string): Promise<boolean> {
    this.record('openExternal', url);
    return true;
  }

  fileUri(fsPath: string): UriLike {
    return { fsPath, toString: () => `file://${fsPath}` };
  }

  workspaceFile(): string | undefined {
    return this.workspaceFilePath;
  }

  workspaceFolders(): string[] {
    return [...this.folders];
  }

  dirtyPaths(): string[] {
    return [...this.dirty];
  }

  updateWorkspaceFolders(
    start: number,
    deleteCount: number,
    ...add: { uri: UriLike; name?: string }[]
  ): boolean {
    this.record(
      'updateWorkspaceFolders',
      start,
      deleteCount,
      add.map((a) => ({ uri: a.uri.fsPath, name: a.name })),
    );
    this.folders = [
      ...this.folders.slice(0, start),
      ...add.map((a) => a.uri.fsPath),
      ...this.folders.slice(start + deleteCount),
    ];
    return true;
  }

  fileExists(path: string): boolean {
    return this.files.has(path);
  }

  writeFile(path: string, content: string): void {
    this.record('writeFile', path, content);
    this.files.set(path, content);
  }

  fileSize(path: string): number {
    return Buffer.byteLength(this.files.get(path) ?? '', 'utf8');
  }

  readFileSlice(path: string, from: number): { text: string; end: number } {
    const buffer = Buffer.from(this.files.get(path) ?? '', 'utf8');
    const slice = buffer.subarray(Math.min(from, buffer.byteLength));
    return { text: slice.toString('utf8'), end: buffer.byteLength };
  }

  fileDigest(path: string): string | null {
    const content = this.files.get(path);
    if (content === undefined) return null;
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /** A file with no recorded mode reads as 0600 — the mode the engine writes `core.json` with. */
  fileMode(path: string): number | null {
    if (!this.files.has(path)) return null;
    return this.modes.get(path) ?? 0o600;
  }

  watchFile(path: string, callback: () => void): DisposableLike {
    this.record('watchFile', path);
    const entry = { callback, disposed: 0 };
    this.watches.set(path, entry);
    return {
      dispose: () => {
        entry.disposed += 1;
        this.record('disposeWatch', path);
        if (this.watches.get(path) === entry) this.watches.delete(path);
      },
    };
  }

  /** Simulates the file changing on disk. */
  touch(path: string, content?: string): void {
    if (content !== undefined) this.files.set(path, content);
    this.watches.get(path)?.callback();
  }

  /** Simulates the engine appending to its log. */
  append(path: string, text: string): void {
    this.files.set(path, (this.files.get(path) ?? '') + text);
    this.watches.get(path)?.callback();
  }

  /**
   * Records the new mode, then runs {@link chmodHook} — which is how a test reproduces the macOS
   * fact this whole watcher is written against: a `chmod` on the watched file fires the watch,
   * whether or not it changed anything.
   */
  async chmod(path: string, mode: number): Promise<void> {
    this.record('chmod', path, mode);
    if (this.chmodError !== null) throw this.chmodError;
    this.modes.set(path, mode);
    this.chmodHook?.(path, mode);
  }

  async openTextDocument(path: string): Promise<void> {
    this.record('openTextDocument', path);
  }

  async spawnCapture(
    command: string,
    args: readonly string[],
    options?: SpawnCaptureOptions,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    this.record('spawnCapture', command, [...args], options);
    return this.spawnResults.get(command) ?? { code: 0, stdout: '', stderr: '' };
  }

  /** The in-memory stand-in for `globalState` (R64). */
  readonly state = new Map<string, unknown>();

  getState<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  async setState(key: string, value: unknown): Promise<void> {
    this.record('setState', key, value);
    this.state.set(key, value);
  }

  appendOutput(line: string): void {
    this.record('appendOutput', line);
    this.output.push(line);
  }

  showOutput(): void {
    this.record('showOutput');
    this.outputShown.push(this.output.length);
  }

  // --- timers ---------------------------------------------------------------

  setInterval(callback: () => void, ms: number): () => void {
    const timer: FakeTimer = {
      kind: 'interval',
      callback,
      ms,
      cancelled: false,
      dueAt: this.clock + ms,
    };
    this.timers.push(timer);
    this.record('setInterval', ms);
    return () => {
      timer.cancelled = true;
      this.record('clearInterval', ms);
    };
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer: FakeTimer = {
      kind: 'timeout',
      callback,
      ms,
      cancelled: false,
      dueAt: this.clock + ms,
    };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** The delays of every timeout still waiting, so a test can pin the window it was given. */
  pendingTimeouts(): number[] {
    return this.timers.filter((t) => t.kind === 'timeout' && !t.cancelled).map((t) => t.ms);
  }

  /** Runs every due timeout (and no interval) — the coalescing window. */
  flushTimeouts(): void {
    for (const timer of [...this.timers]) {
      if (timer.kind !== 'timeout' || timer.cancelled) continue;
      timer.cancelled = true;
      timer.callback();
    }
  }

  /** Advances the fake clock, firing each live interval as often as it is due. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (due === undefined) break;
      this.clock = due.dueAt;
      if (due.kind === 'timeout') due.cancelled = true;
      else due.dueAt += due.ms;
      due.callback();
    }
    this.clock = target;
  }

  log(line: string): void {
    this.logs.push(line);
  }
}

export class FakeStatusBarItem implements StatusBarItemLike {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  warning = false;
  shown = 0;
  hidden = 0;
  disposed = 0;
  show(): void {
    this.shown += 1;
  }
  hide(): void {
    this.hidden += 1;
  }
  dispose(): void {
    this.disposed += 1;
  }
}
