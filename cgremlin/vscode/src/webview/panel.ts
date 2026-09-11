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

function rowNode(row: PanelRowView, level: number): HTMLElement {
  const node = el('div', row.needsYou ? 'row needs-you' : 'row');
  node.dataset.id = row.id;
  node.tabIndex = -1;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', String(level));
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

  node.addEventListener('click', () => post({ type: 'openItem', id: row.id }));
  return node;
}

function childNode(row: PanelRowView, child: PanelRowView['children'][number]): HTMLElement {
  const node = el('div', 'child');
  node.dataset.id = child.id;
  node.tabIndex = -1;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '2');
  node.appendChild(el('span', 'child-label', child.label));
  const goTo = document.createElement('button');
  goTo.className = 'child-goto';
  goTo.textContent = child.goToLabel;
  goTo.addEventListener('click', (event) => {
    event.stopPropagation();
    post({
      type: 'command',
      command: child.kind === 'ticket' ? 'cgremlin.openTicket' : 'cgremlin.openPr',
      id: row.id,
      childId: child.id,
    });
  });
  if (child.kind !== 'agent') node.appendChild(goTo);
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
      header.setAttribute('aria-expanded', String(!section.collapsed));
      header.tabIndex = -1;
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
    node.appendChild(rowNode(row, 1));
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
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPanel;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'render') render(message.state);
  else if (message.type === 'patch' && state !== null) render({ ...state, ...message.state });
});

// R39's handshake, for the same reason: a `render` posted before this listener exists is dropped
// silently and the panel stays blank.
post({ type: 'ready' });
