/**
 * The panel's render loop: one pass per message, in place (§3.3, P0-4).
 *
 * It owns no data. Every label crosses the channel as data and is set with `textContent`, so a PR
 * title carrying `<script>` is inert by construction (MG-B7), and there is no `innerHTML` in the
 * bundle at all.
 *
 * Two pieces of view state live here and nowhere else, because they are about the *screen* rather
 * than about the work: which node holds the tree's single tab stop (R66), and whether the pointer
 * is currently inside a list — which freezes the order until it leaves (§2.2 rule 4).
 *
 * No rate limiter: the host already coalesces a refresh into one post and drops a render that
 * would say what the last one said, so a trailing timer here would only delay the render that
 * matters.
 *
 * Runs in a browser context (R40): no editor module, no Node.
 */
import { freezeOrder, panelTreeNodes, paintedOrderOf, type PaintedOrder, type PanelTreeNode } from '../../model/panel-tree';
import { post, setSink } from './channel';
import { button, el } from './dom';
import { installKeyboard } from './keyboard';
import { createList, patchList, type ListContext } from './list';
import { reconcile, setClass, setHidden, setText } from './reconcile';
import { createStrip, patchStrip } from './strip';
import type { HostToPanel, PanelState } from '../../model/panel-protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

let state: PanelState | null = null;
let nodes: PanelTreeNode[] = [];
let focusedKey: string | null = null;
/** The sequence actually on screen, and the newest state that has not been allowed to reorder. */
let painted: PaintedOrder = new Map();
let pointerInside = false;
let pending: PanelState | null = null;
/** Every `[data-key]` node currently rendered, so focus never needs a selector. */
const keyed = new Map<string, HTMLElement>();

export function current(): PanelState | null {
  return state;
}

function root(): HTMLElement {
  const existing = document.getElementById('cgremlin-panel');
  if (existing !== null) return existing;
  const node = el('div');
  node.id = 'cgremlin-panel';
  document.body.appendChild(node);
  return node;
}

export function render(next: PanelState): void {
  pending = next;
  // §2.2 rule 4: while the pointer is inside a list the CONTENT still lands and the SEQUENCE does
  // not, so the row under the cursor cannot slide out from under it.
  state = pointerInside ? freezeOrder(next, painted) : next;
  painted = paintedOrderOf(state);
  nodes = panelTreeNodes(state);
  if (focusedKey !== null && !nodes.some((node) => node.key === focusedKey)) {
    // The node the user was on is gone (a group closed, a row left the list): fall back to the
    // first one rather than losing the tab stop entirely.
    focusedKey = nodes[0]?.key ?? null;
  }
  paint(state);
}

function paint(next: PanelState): void {
  const container = root();
  const context: ListContext = { focusedKey, onPointer };
  // Whether the panel HAD the caret, decided before the reconcile. A refresh must put focus back
  // where it was, and must not take it from the editor the user has since typed into.
  const held = heldFocus();
  reconcile(
    container,
    entriesOf(next),
    (entry) => create(entry, context),
    (node, entry) => patch(node, entry, context),
  );
  keyed.clear();
  collectKeys(container);
  if (held) restoreFocus();
}

function heldFocus(): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  for (const node of keyed.values()) if (node === active) return true;
  return false;
}

/**
 * The `[data-key]` index, rebuilt from the tree itself rather than from a selector: the panel is
 * also driven against a stand-in DOM, and a walk needs nothing but `childNodes`.
 */
function collectKeys(node: HTMLElement): void {
  const children = node.childNodes;
  for (let at = 0; at < children.length; at += 1) {
    const element = children[at] as HTMLElement;
    if (element.dataset === undefined) continue;
    const key = element.dataset.key;
    if (key !== undefined) keyed.set(key, element);
    collectKeys(element);
  }
}

type Entry =
  | { kind: 'trouble'; state: PanelState }
  | { kind: 'strip'; state: PanelState }
  | { kind: 'banner'; text: string; tone: string }
  | { kind: 'notice'; state: PanelState }
  | { kind: 'list'; index: number; state: PanelState };

function entriesOf(next: PanelState): { key: string; data: Entry }[] {
  const entries: { key: string; data: Entry }[] = [];
  // P3: the strip leads the panel and outlives a trouble state — what wants the user is still
  // true while the engine is explaining itself.
  if (next.needsYou.length > 0) {
    entries.push({ key: 'needsYou', data: { kind: 'strip', state: next } });
  }
  if (next.trouble !== null) {
    entries.push({ key: 'trouble', data: { kind: 'trouble', state: next } });
    return entries;
  }
  if (next.banner !== null) {
    entries.push({
      key: 'banner',
      data: { kind: 'banner', text: next.banner.message, tone: next.banner.kind },
    });
  }
  // P10: the offer to open the managed workspace, where the popup used to be. Below the banner
  // and above the lists — it is an offer, not an interruption.
  if (next.notice !== null) {
    entries.push({ key: 'notice', data: { kind: 'notice', state: next } });
  }
  if (!next.connected) {
    entries.push({
      key: 'offline',
      data: { kind: 'banner', text: 'The cgremlin engine is not reachable.', tone: 'stale' },
    });
  }
  next.lists.forEach((_, index) =>
    entries.push({ key: `list:${index}`, data: { kind: 'list', index, state: next } }),
  );
  return entries;
}

function create(entry: Entry, context: ListContext): HTMLElement {
  if (entry.kind === 'list') return createList(entry.state.lists[entry.index], context);
  if (entry.kind === 'strip') return createStrip();
  if (entry.kind === 'banner') return el('div', 'banner');
  if (entry.kind === 'notice') return createNotice();
  const node = el('div', 'trouble');
  node.appendChild(el('p', 'trouble-message'));
  node.appendChild(
    button({
      className: 'trouble-action',
      label: '',
      message: () => ({
        type: 'command',
        command: node.dataset.command ?? '',
        id: 'engine',
      }),
    }),
  );
  return node;
}

function patch(node: HTMLElement, entry: Entry, context: ListContext): void {
  if (entry.kind === 'list') {
    patchList(node, entry.state.lists[entry.index], context);
    return;
  }
  if (entry.kind === 'strip') {
    patchStrip(node, entry.state.needsYou);
    return;
  }
  if (entry.kind === 'banner') {
    setClass(node, `banner ${entry.tone}`);
    setText(node, entry.text);
    return;
  }
  if (entry.kind === 'notice') {
    patchNotice(node, entry.state);
    return;
  }
  const trouble = entry.state.trouble;
  node.dataset.command = trouble?.command ?? '';
  setText(node.children[0] as HTMLElement, trouble?.message ?? '');
  setText(node.children[1] as HTMLElement, trouble?.actionLabel ?? '');
  setHidden(node.children[1] as HTMLElement, trouble === null);
}

/**
 * One line, one action, one way out. "Not now" posts back to the host rather than hiding the node
 * here: the dismissal has to outlive this webview, and only the host can write global state.
 */
function createNotice(): HTMLElement {
  const node = el('div', 'notice');
  node.setAttribute('role', 'note');
  node.appendChild(el('span', 'notice-text'));
  node.appendChild(
    button({
      className: 'notice-open',
      label: '',
      message: () => ({
        type: 'command',
        command: node.dataset.command ?? '',
        id: 'workspace',
      }),
    }),
  );
  node.appendChild(
    button({
      className: 'notice-dismiss',
      label: '',
      message: () => ({ type: 'dismissNotice' }),
    }),
  );
  return node;
}

function patchNotice(node: HTMLElement, state: PanelState): void {
  const notice = state.notice;
  node.dataset.command = notice?.command ?? '';
  setText(node.children[0] as HTMLElement, notice?.message ?? '');
  setText(node.children[1] as HTMLElement, notice?.actionLabel ?? '');
  setText(node.children[2] as HTMLElement, notice?.dismissLabel ?? '');
}

function onPointer(inside: boolean): void {
  pointerInside = inside;
  // The order that was queued while the pointer was inside is applied the moment it leaves.
  if (!inside && pending !== null && pending !== state) render(pending);
}

function focus(key: string): void {
  focusedKey = key;
  for (const [candidate, node] of keyed) {
    const selected = candidate === key;
    if (node.tabIndex !== (selected ? 0 : -1)) node.tabIndex = selected ? 0 : -1;
  }
  restoreFocus();
}

function restoreFocus(): void {
  if (focusedKey === null) return;
  keyed.get(focusedKey)?.focus();
}

installKeyboard({
  nodes: () => nodes,
  focusedKey: () => focusedKey,
  focus,
  ready: () => state !== null,
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPanel;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'render') render(message.state);
  else if (message.type === 'patch' && state !== null) render({ ...state, ...message.state });
});

export function connect(): void {
  const api = acquireVsCodeApi();
  setSink((message) => api.postMessage(message));
  // R39's handshake: a `render` posted before this listener existed is dropped silently and the
  // panel stays blank.
  post({ type: 'ready' });
}
