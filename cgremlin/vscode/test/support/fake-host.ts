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
  EventEmitterLike,
  Host,
  InputBoxOptionsLike,
  MessageOptionsLike,
  QuickPickOptionsLike,
  SpawnCaptureOptions,
  StatusBarItemLike,
  TerminalLike,
  TerminalOptionsLike,
  TreeDataProviderLike,
  TreeItemLike,
  UriLike,
} from '../../src/ui/host';

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

export class FakeHost implements Host {
  readonly calls: RecordedCall[] = [];
  readonly commands = new Map<string, (...args: unknown[]) => unknown>();
  readonly providers = new Map<string, TreeDataProviderLike<unknown>>();
  readonly terminals: FakeTerminal[] = [];
  readonly statusBarItems: FakeStatusBarItem[] = [];
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

  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProviderLike<T>): DisposableLike {
    this.record('registerTreeDataProvider', viewId);
    this.providers.set(viewId, provider as TreeDataProviderLike<unknown>);
    return { dispose: () => this.providers.delete(viewId) };
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
        this.record('treeDataChanged', data);
        for (const listener of listeners) listener(data);
      },
      dispose: () => listeners.clear(),
    };
    return emitter;
  }

  createTreeItem(label: string, collapsibleState: number): TreeItemLike {
    return { label, collapsibleState };
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

  async chmod(path: string, mode: number): Promise<void> {
    this.record('chmod', path, mode);
    if (this.chmodError !== null) throw this.chmodError;
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
