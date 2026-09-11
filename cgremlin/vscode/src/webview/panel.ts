/**
 * The side panel's webview entry (R54).
 *
 * It owns no data and builds no markup out of strings: every label crosses the channel as data
 * and is set with `textContent`, so a PR title carrying `<script>` is inert by construction
 * (MG-B7). It posts `ready` on load and renders only what the host sends back (R39).
 *
 * esbuild bundles this into `media/panel.js`; the host inlines that text under R38's CSP. It runs
 * in a browser context, so it never imports the editor module.
 */
import { handleKey, panelTreeNodes, type PanelTreeNode } from '../model/panel-tree';
import type {
  HostToPanel,
  PanelListView,
  PanelRowView,
  PanelSectionView,
  PanelState,
} from '../model/panel-protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

export function post(message: unknown): void {
  api.postMessage(message);
}

let state: PanelState | null = null;
/** Which `role="treeitem"` has focus. The tree is one tab stop; the keys move within it (R66). */
let focusedKey: string | null = null;
let nodes: PanelTreeNode[] = [];

export function current(): PanelState | null {
  return state;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function root(): HTMLElement {
  let node = document.getElementById('cgremlin-panel');
  if (node === null) {
    node = el('div');
    node.id = 'cgremlin-panel';
    document.body.appendChild(node);
  }
  return node;
}

function rowNode(row: PanelRowView, list: PanelListView): HTMLElement {
  const key = `row:${list.kind}:${row.id}`;
  const node = el('div', row.needsYou ? 'row needs-you' : 'row');
  node.dataset.key = key;
  node.tabIndex = focusedKey === key ? 0 : -1;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '1');
  node.setAttribute('aria-selected', String(focusedKey === key));
  if (row.hasChildren) node.setAttribute('aria-expanded', String(row.expanded));

  const line1 = el('div', 'row-line1');
  if (row.hasChildren) {
    const twisty = el('span', 'twisty', row.expanded ? '▾' : '▸');
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      post({ type: 'toggleRow', id: row.id, expanded: !row.expanded });
    });
    line1.appendChild(twisty);
  }
  line1.appendChild(el('span', 'row-label', row.label));
  for (const badge of row.badges) line1.appendChild(el('span', 'badge', badge));
  if (row.ci !== '') line1.appendChild(el('span', 'ci', row.ci));
  if (row.needsYou) line1.appendChild(el('span', 'badge needs-you-badge', '❗'));
  node.appendChild(line1);

  const line2 = el('div', 'row-line2', row.description);
  node.appendChild(line2);

  if (row.actions.length > 0) {
    const actions = el('div', 'row-actions');
    for (const action of row.actions) {
      const button = document.createElement('button');
      button.className = 'row-action';
      button.textContent = action.label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        post({
          type: 'command',
          command: action.command,
          id: row.id,
          ...(action.childId === undefined ? {} : { childId: action.childId }),
        });
      });
      actions.appendChild(button);
    }
    node.appendChild(actions);
  }

  node.addEventListener('click', () => {
    focusedKey = key;
    post({ type: 'openItem', id: row.id });
  });
  return node;
}

function childNode(row: PanelRowView, child: PanelRowView['children'][number]): HTMLElement {
  const key = `child:${row.id}:${child.id}`;
  const node = el('div', 'child');
  node.dataset.key = key;
  node.tabIndex = focusedKey === key ? 0 : -1;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '2');
  node.setAttribute('aria-selected', String(focusedKey === key));
  node.appendChild(el('span', 'child-label', child.label));
  const goTo = document.createElement('button');
  goTo.className = 'child-goto';
  goTo.textContent = child.goToLabel;
  // R48's secondary action: the browser for a PR or a ticket, and the conversation for a
  // session — which is the chat terminal's own path, claim and all (R42).
  const GO_TO: Record<string, string> = {
    ticket: 'cgremlin.openTicket',
    pr: 'cgremlin.openPr',
    agent: 'cgremlin.chat',
  };
  goTo.addEventListener('click', (event) => {
    event.stopPropagation();
    post({ type: 'command', command: GO_TO[child.kind], id: row.id, childId: child.id });
  });
  node.appendChild(goTo);
  node.addEventListener('click', () =>
    post({ type: 'openChild', id: row.id, childId: child.id }),
  );
  return node;
}

function sectionNode(list: PanelListView, section: PanelSectionView): HTMLElement {
  const node = el('div', 'section');
  if (section.group !== null) {
    const header = el('div', 'section-header', `${section.title} (${section.count})`);
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-level', '1');
    if (section.collapsible) {
      const key = `group:${list.kind}:${section.group}`;
      header.dataset.key = key;
      header.setAttribute('aria-expanded', String(!section.collapsed));
      header.setAttribute('aria-selected', String(focusedKey === key));
      header.tabIndex = focusedKey === key ? 0 : -1;
      header.addEventListener('click', () =>
        post({
          type: 'toggleGroup',
          list: list.kind,
          group: section.group,
          collapsed: !section.collapsed,
        }),
      );
    }
    node.appendChild(header);
  }
  if (section.collapsed) return node;
  for (const row of section.rows) {
    node.appendChild(rowNode(row, list));
    if (!row.expanded) continue;
    for (const child of row.children) node.appendChild(childNode(row, child));
  }
  return node;
}

function listNode(list: PanelListView): HTMLElement {
  const node = el('div', 'list');
  const header = el('div', 'list-header');
  header.appendChild(el('span', 'list-title', `${list.title} (${list.count})`));

  const sorts = el('div', 'sorts');
  sorts.setAttribute('role', 'group');
  sorts.setAttribute('aria-label', `Sort ${list.title}`);
  for (const sort of list.sorts) {
    const button = document.createElement('button');
    button.className = sort === list.sort ? 'sort selected' : 'sort';
    button.textContent = SORT_LABELS[sort] ?? sort;
    button.setAttribute('aria-pressed', String(sort === list.sort));
    button.addEventListener('click', () => post({ type: 'setSort', list: list.kind, sort }));
    sorts.appendChild(button);
  }
  header.appendChild(sorts);
  node.appendChild(header);

  const tree = el('div', 'tree');
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', list.title);
  for (const section of list.sections) tree.appendChild(sectionNode(list, section));
  node.appendChild(tree);
  return node;
}

const SORT_LABELS: Record<string, string> = {
  untouchedFirstThenOldest: 'untouched',
  oldest: 'oldest',
  newest: 'newest',
  smallestChange: 'smallest',
  needsYouThenRecent: 'needs you',
};

export function render(next: PanelState): void {
  state = next;
  nodes = panelTreeNodes(next);
  if (focusedKey !== null && !nodes.some((node) => node.key === focusedKey)) {
    // The node the user was on is gone (a group closed, a row left the list): fall back to the
    // first one rather than losing the tab stop entirely.
    focusedKey = nodes[0]?.key ?? null;
  }
  const container = root();
  container.textContent = '';

  if (next.trouble !== null) {
    const trouble = el('div', 'trouble');
    trouble.appendChild(el('p', undefined, next.trouble.message));
    const button = document.createElement('button');
    button.textContent = 'Fix it';
    const command = next.trouble.command;
    button.addEventListener('click', () => post({ type: 'command', command, id: 'engine' }));
    trouble.appendChild(button);
    container.appendChild(trouble);
    return;
  }

  if (next.banner !== null) {
    container.appendChild(el('div', `banner ${next.banner.kind}`, next.banner.message));
  }
  if (!next.connected) {
    container.appendChild(el('div', 'banner stale', 'The cgremlin engine is not reachable.'));
  }
  for (const list of next.lists) container.appendChild(listNode(list));
  restoreFocus();
}

function restoreFocus(): void {
  if (focusedKey === null) return;
  const node = document.querySelector(`[data-key="${cssEscape(focusedKey)}"]`);
  if (node instanceof HTMLElement) node.focus({ preventScroll: false });
}

/** The keys are `list:id` strings we built ourselves, so only the quoting has to be handled. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * R66: the keyboard model the ARIA roles promise, taken from the same pure module the roles come
 * from — so roles without keys, or keys without roles, is not a state this file can be in.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (state === null) return;
  const intent = handleKey(event.key, nodes, focusedKey);
  if (intent === null) return;
  event.preventDefault();
  if (intent.kind === 'focus') {
    focusedKey = intent.key;
    document.querySelectorAll('[data-key]').forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const selected = node.dataset.key === focusedKey;
      node.tabIndex = selected ? 0 : -1;
      node.setAttribute('aria-selected', String(selected));
    });
    restoreFocus();
    return;
  }
  if (intent.kind === 'toggleRow') {
    post({ type: 'toggleRow', id: intent.id, expanded: intent.expanded });
    return;
  }
  if (intent.kind === 'toggleGroup') {
    post({
      type: 'toggleGroup',
      list: intent.list,
      group: intent.group,
      collapsed: intent.collapsed,
    });
    return;
  }
  const node = intent.node;
  if (node.kind === 'row' && node.id !== null) post({ type: 'openItem', id: node.id });
  else if (node.kind === 'child' && node.id !== null && node.rowId !== null) {
    post({ type: 'openChild', id: node.rowId, childId: node.id });
  } else if (node.kind === 'group' && node.group !== null) {
    post({ type: 'toggleGroup', list: node.list, group: node.group, collapsed: node.expanded });
  }
}

document.addEventListener('keydown', onKeyDown);

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPanel;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'render') render(message.state);
  else if (message.type === 'patch' && state !== null) render({ ...state, ...message.state });
});

// R39's handshake, for the same reason: a `render` posted before this listener exists is dropped
// silently and the panel stays blank.
post({ type: 'ready' });
