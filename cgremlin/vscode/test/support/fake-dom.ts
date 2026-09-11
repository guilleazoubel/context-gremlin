/**
 * A DOM small enough to install as a global, and instrumented enough to prove P0-4.
 *
 * The webview bundles run in a browser context and this package has no jsdom (and does not want
 * one: `environment: 'node'`, and the guard tests read `src/webview/**` as text). What P0-4 has
 * to assert is not "does it look right" but **"did anything move"** — so every write this DOM
 * accepts is recorded, and a render over identical data has to produce an empty log.
 */

export interface DomMutation {
  kind: 'create' | 'text' | 'class' | 'attr' | 'prop' | 'insert' | 'remove';
  tag: string;
  key: string;
  detail?: string;
}

export class FakeElement {
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  id = '';
  private ownText = '';
  private cls = '';
  private readonly attrs = new Map<string, string>();
  private readonly props = new Map<string, unknown>();

  constructor(
    readonly tagName: string,
    private readonly doc: FakeDocument,
  ) {}

  private log(kind: DomMutation['kind'], detail?: string): void {
    this.doc.log.push({ kind, tag: this.tagName, key: this.dataset.key ?? this.cls, detail });
  }

  get className(): string {
    return this.cls;
  }
  set className(value: string) {
    if (this.cls === value) return;
    this.log('class', value);
    this.cls = value;
  }

  get textContent(): string {
    return this.children.length > 0 ? this.children.map((c) => c.textContent).join('') : this.ownText;
  }
  set textContent(value: string) {
    if (this.children.length === 0 && this.ownText === value) return;
    this.log('text', value);
    for (const child of this.children.splice(0)) child.parentNode = null;
    this.ownText = value;
  }

  get tabIndex(): number {
    return (this.props.get('tabIndex') as number | undefined) ?? -1;
  }
  set tabIndex(value: number) {
    if (this.tabIndex === value) return;
    this.log('prop', `tabIndex=${value}`);
    this.props.set('tabIndex', value);
  }

  get title(): string {
    return (this.props.get('title') as string | undefined) ?? '';
  }
  set title(value: string) {
    if (this.title === value) return;
    this.log('prop', `title=${value}`);
    this.props.set('title', value);
  }

  get hidden(): boolean {
    return this.props.get('hidden') === true;
  }
  set hidden(value: boolean) {
    if (this.hidden === value) return;
    this.log('prop', `hidden=${value}`);
    this.props.set('hidden', value);
  }

  setAttribute(name: string, value: string): void {
    if (this.attrs.get(name) === value) return;
    this.log('attr', `${name}=${value}`);
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    if (!this.attrs.has(name)) return;
    this.log('attr', `-${name}`);
    this.attrs.delete(name);
  }

  appendChild(child: FakeElement): FakeElement {
    this.insertBefore(child, null);
    return child;
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    // A move that moves nothing is not a mutation: `insertBefore(child, before)` is a no-op
    // exactly when `child`'s next sibling is already `before` — which is what makes "a re-render
    // over identical data mutates NOTHING" a real assertion rather than an accident of ordering.
    if (child.parentNode === this) {
      const from = this.children.indexOf(child);
      if ((this.children[from + 1] ?? null) === before) return child;
    }
    child.parentNode?.detach(child);
    const target = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(target < 0 ? this.children.length : target, 0, child);
    child.parentNode = this;
    this.log('insert', child.tagName);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    this.detach(child);
    this.log('remove', child.tagName);
    return child;
  }

  private detach(child: FakeElement): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
  }

  get childNodes(): FakeElement[] {
    return this.children;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) this.listeners.set(type, [handler]);
    else existing.push(handler);
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  /** Fire one listener type, with a stub event. */
  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ stopPropagation: () => {}, preventDefault: () => {}, ...event });
    }
  }

  /** Every descendant, in document order. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  find(predicate: (el: FakeElement) => boolean): FakeElement | undefined {
    return this.descendants().find(predicate);
  }

  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return this.descendants().filter(predicate);
  }

  /** The one selector form the panel uses: a single class, searched depth-first. */
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) throw new Error(`unsupported selector: ${selector}`);
    return this.byClass(selector.slice(1))[0] ?? null;
  }

  byClass(name: string): FakeElement[] {
    return this.findAll((el) => el.className.split(' ').includes(name));
  }
}

export class FakeDocument {
  readonly log: DomMutation[] = [];
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    this.body = new FakeElement('BODY', this);
  }

  createElement(tag: string): FakeElement {
    const node = new FakeElement(tag.toUpperCase(), this);
    this.log.push({ kind: 'create', tag: node.tagName, key: '' });
    return node;
  }

  getElementById(id: string): FakeElement | null {
    return this.body.find((el) => el.id === id) ?? (this.body.id === id ? this.body : null);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) this.listeners.set(type, [handler]);
    else existing.push(handler);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ stopPropagation: () => {}, preventDefault: () => {}, ...event });
    }
  }

  clearLog(): void {
    this.log.length = 0;
  }
}

export interface InstalledDom {
  document: FakeDocument;
  root: FakeElement;
  posted: unknown[];
  /** Deliver a host message the way the editor's webview channel does. */
  send(message: unknown): void;
  uninstall(): void;
}

/**
 * Installs the globals `src/webview/panel.ts` reaches for, then hands back the handles a test
 * needs. The module must be imported AFTER this — it calls `acquireVsCodeApi()` at load.
 */
export function installDom(): InstalledDom {
  const document = new FakeDocument();
  const root = document.createElement('div');
  root.id = 'cgremlin-panel';
  document.body.appendChild(root);
  const posted: unknown[] = [];
  const windowListeners: ((event: unknown) => void)[] = [];

  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    document: globals.document,
    window: globals.window,
    acquireVsCodeApi: globals.acquireVsCodeApi,
  };
  globals.document = document;
  globals.window = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'message') windowListeners.push(handler);
    },
  };
  globals.acquireVsCodeApi = () => ({
    postMessage(message: unknown) {
      posted.push(message);
    },
  });

  return {
    document,
    root,
    posted,
    send: (message) => {
      for (const handler of windowListeners) handler({ data: message });
    },
    uninstall: () => {
      globals.document = saved.document;
      globals.window = saved.window;
      globals.acquireVsCodeApi = saved.acquireVsCodeApi;
    },
  };
}
