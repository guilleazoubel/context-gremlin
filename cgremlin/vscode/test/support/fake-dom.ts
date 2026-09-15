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

  /**
   * Every ASSIGNMENT, whether or not it changed anything. This is the ledger the "identical data
   * mutates nothing" tests read: the browser does not deduplicate, so re-assigning the same
   * string to `textContent` still rebuilds the text node — collapsing a selection and cancelling
   * an IME composition — and a guard that stopped guarding would be invisible in `log` alone.
   */
  private wrote(kind: DomMutation['kind'], detail?: string): void {
    this.doc.writes.push({ kind, tag: this.tagName, key: this.dataset.key ?? this.cls, detail });
  }

  get className(): string {
    return this.cls;
  }
  set className(value: string) {
    this.wrote('class', value);
    if (this.cls === value) return;
    this.log('class', value);
    this.cls = value;
  }

  get textContent(): string {
    return this.children.length > 0 ? this.children.map((c) => c.textContent).join('') : this.ownText;
  }
  set textContent(value: string) {
    this.wrote('text', value);
    if (this.children.length === 0 && this.ownText === value) return;
    this.log('text', value);
    for (const child of this.children.splice(0)) child.parentNode = null;
    this.ownText = value;
  }

  get tabIndex(): number {
    return (this.props.get('tabIndex') as number | undefined) ?? -1;
  }
  set tabIndex(value: number) {
    this.wrote('prop', `tabIndex=${value}`);
    if (this.tabIndex === value) return;
    this.log('prop', `tabIndex=${value}`);
    this.props.set('tabIndex', value);
  }

  get title(): string {
    return (this.props.get('title') as string | undefined) ?? '';
  }
  set title(value: string) {
    this.wrote('prop', `title=${value}`);
    if (this.title === value) return;
    this.log('prop', `title=${value}`);
    this.props.set('title', value);
  }

  get hidden(): boolean {
    return this.props.get('hidden') === true;
  }
  set hidden(value: boolean) {
    this.wrote('prop', `hidden=${value}`);
    if (this.hidden === value) return;
    this.log('prop', `hidden=${value}`);
    this.props.set('hidden', value);
  }

  /**
   * Phase 14 — `innerHTML` PARSES.
   *
   * The item tab's one `innerHTML` assignment is the markdown-it output, and this DOM had no
   * `innerHTML` at all: the assignment landed on an untyped property, no test ever looked at it,
   * and "the artifact renders as markdown" was therefore unguarded — a regression that turned the
   * body back into plain text would have been invisible here. So the setter parses the rendered
   * fragment into real child elements, which is what lets a test assert a HEADING ELEMENT rather
   * than a string that happens to contain `<h1>`.
   *
   * It is a small parser on purpose: markdown-it's output is well-formed, tag-per-element HTML
   * with no attributes this DOM needs. Anything it cannot parse becomes text, never a throw.
   */
  get innerHTML(): string {
    return (this.props.get('innerHTML') as string | undefined) ?? '';
  }
  set innerHTML(value: string) {
    this.wrote('prop', 'innerHTML');
    if (this.innerHTML === value) return;
    this.log('prop', 'innerHTML');
    this.props.set('innerHTML', value);
    for (const child of this.children.splice(0)) child.parentNode = null;
    for (const node of parseFragment(value, this.doc)) this.appendChild(node);
  }

  setAttribute(name: string, value: string): void {
    this.wrote('attr', `${name}=${value}`);
    if (this.attrs.get(name) === value) return;
    this.log('attr', `${name}=${value}`);
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.wrote('attr', `-${name}`);
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

  /** Phase 17: the item tab scrolls an intra-report anchor into view; the count is the assertion. */
  scrolledIntoView = 0;
  scrollIntoView(): void {
    this.scrolledIntoView += 1;
  }

  get parentElement(): FakeElement | null {
    return this.parentNode;
  }

  /** Construction-time attribute write — the fragment parser, which mutates nothing on screen. */
  initAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
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

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)(\/?)>/g;
const ATTR = /([a-zA-Z-]+)="([^"]*)"/g;
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** Enough of an HTML parser for markdown-it output: elements, nesting and text. */
function parseFragment(html: string, doc: FakeDocument): FakeElement[] {
  const top: FakeElement[] = [];
  const stack: FakeElement[] = [];
  const put = (node: FakeElement): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) top.push(node);
    else parent.appendChild(node);
  };
  const text = (raw: string): void => {
    if (raw.trim() === '') return;
    const parent = stack[stack.length - 1];
    const node = doc.createElement('#text');
    node.textContent = unescape(raw);
    if (parent === undefined) top.push(node);
    else parent.appendChild(node);
  };
  let at = 0;
  for (let m = TAG.exec(html); m !== null; m = TAG.exec(html)) {
    text(html.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] === '/') {
      stack.pop();
      continue;
    }
    const node = doc.createElement(m[2]);
    // Attributes matter to phase 17: the tab reads `href` off a rendered anchor to keep an
    // intra-report jump inside the pane, and `id` off the synthesised footnote targets.
    for (let a = ATTR.exec(m[3]); a !== null; a = ATTR.exec(m[3])) {
      if (a[1] === 'id') node.id = unescape(a[2]);
      else node.initAttribute(a[1], unescape(a[2]));
    }
    put(node);
    if (m[4] !== '/' && !['br', 'hr', 'img', 'input'].includes(m[2].toLowerCase())) stack.push(node);
  }
  text(html.slice(at));
  return top;
}

export class FakeDocument {
  /** What actually changed. */
  readonly log: DomMutation[] = [];
  /** What was assigned, changed or not — see `FakeElement.wrote`. */
  readonly writes: DomMutation[] = [];
  activeElement: FakeElement | null = null;
  /** The webview writes `document.title`; this DOM must simply hold it. */
  title = '';
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
    this.writes.length = 0;
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
