/**
 * The editor surface, as an interface.
 *
 * `src/extension.ts` is the only file that builds one of these from the real `vscode` namespace;
 * every other `ui/*` module takes it as a parameter. That is what makes the whole extension-host
 * wiring unit-testable with a hand-written fake and no Electron test harness (R14, MG-B1) — and
 * it is why this file, like the rest of `ui/*`, imports nothing.
 *
 * Each member mirrors one real API, deliberately narrowed:
 *  - message calls take their `MessageOptions` explicitly, because "was this modal?" is a
 *    behaviour under test (R-10a) and not a detail;
 *  - `setInterval`/`setTimeout` hand back a canceller rather than a handle, so a caller cannot
 *    forget to pass the handle back (the classic leaked-timer bug, R21's SSE lesson applied here);
 *  - the two filesystem members exist because the managed workspace file is written by the host,
 *    and "written once, not rewritten when present" is asserted.
 */

export interface DisposableLike {
  dispose(): void;
}

export interface UriLike {
  readonly fsPath: string;
  toString(): string;
}

export interface MessageOptionsLike {
  modal?: boolean;
  detail?: string;
}

export interface QuickPickOptionsLike {
  title?: string;
  placeHolder?: string;
  ignoreFocusOut?: boolean;
}

export interface InputBoxOptionsLike {
  title?: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
  ignoreFocusOut?: boolean;
  validateInput?: (value: string) => string | null | undefined;
}

export interface TerminalOptionsLike {
  name: string;
  /**
   * Optional only because the engine terminal (`cgremlin-core serve`) has no meaningful directory.
   * The chat terminal always passes it, and MG-B4 is what holds that: the transcript store is
   * cwd-keyed, so a chat terminal opened anywhere else resumes nothing.
   */
  cwd?: string;
}

export interface TerminalLike {
  readonly name: string;
  sendText(text: string, addNewLine?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface StatusBarItemLike {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export type EventLike<T> = (listener: (e: T) => unknown) => DisposableLike;

export interface EventEmitterLike<T> {
  readonly event: EventLike<T>;
  fire(data: T): void;
  dispose(): void;
}

export interface TreeItemLike {
  label?: string;
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  collapsibleState?: number;
  command?: { command: string; title: string; arguments?: unknown[] };
}

export interface TreeDataProviderLike<T> {
  onDidChangeTreeData?: EventLike<T | undefined>;
  getTreeItem(element: T): TreeItemLike;
  getChildren(element?: T): T[];
}

/** `vscode.TreeItemCollapsibleState`, mirrored (None/Collapsed/Expanded). */
export const COLLAPSIBLE_NONE = 0;
export const COLLAPSIBLE_COLLAPSED = 1;
export const COLLAPSIBLE_EXPANDED = 2;

export interface Host {
  showInformationMessage(
    message: string,
    options: MessageOptionsLike | undefined,
    ...items: string[]
  ): Promise<string | undefined>;
  showWarningMessage(
    message: string,
    options: MessageOptionsLike | undefined,
    ...items: string[]
  ): Promise<string | undefined>;
  showQuickPick(items: readonly string[], options?: QuickPickOptionsLike): Promise<string | undefined>;
  showInputBox(options: InputBoxOptionsLike): Promise<string | undefined>;

  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  registerCommand(id: string, callback: (...args: unknown[]) => unknown): DisposableLike;
  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProviderLike<T>): DisposableLike;
  createEventEmitter<T>(): EventEmitterLike<T>;
  createTreeItem(label: string, collapsibleState: number): TreeItemLike;
  createStatusBarItem(): StatusBarItemLike;

  createTerminal(options: TerminalOptionsLike): TerminalLike;
  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike;

  openExternal(url: string): Promise<boolean>;
  fileUri(fsPath: string): UriLike;
  workspaceFile(): string | undefined;
  workspaceFolders(): string[];
  /** `workspace.textDocuments.filter(d => d.isDirty).map(d => d.uri.fsPath)` (R-10a). */
  dirtyPaths(): string[];
  updateWorkspaceFolders(
    start: number,
    deleteCount: number,
    ...add: { uri: UriLike; name?: string }[]
  ): boolean;

  fileExists(path: string): boolean;
  writeFile(path: string, content: string): void;

  /** Returns the canceller, not a handle. */
  setInterval(callback: () => void, ms: number): () => void;
  setTimeout(callback: () => void, ms: number): () => void;

  log(line: string): void;
}

/**
 * Work the host started but must not block on.
 *
 * Several editor calls resolve only when the *user* acts — a popup's promise settles when it is
 * dismissed, which can be never. So the surfaces below dispatch such work and return, and
 * `settled()` exists for tests (and `dispose`) to wait for whatever is genuinely outstanding.
 */
export class PendingWork {
  private readonly outstanding = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): void {
    const tracked = work.finally(() => this.outstanding.delete(tracked));
    this.outstanding.add(tracked);
  }

  async settled(): Promise<void> {
    while (this.outstanding.size > 0) {
      await Promise.allSettled([...this.outstanding]);
    }
  }
}
