/**
 * R66's keyboard model, taken from the same pure module the ARIA roles come from.
 *
 * `panel-tree` owns both — the sequence of `treeitem`s and the navigation those roles promise —
 * so "roles without keys" and "keys without roles" are not states this bundle can be in. What is
 * left here is the dispatch, and one decision: <kbd>Enter</kbd> on a row does exactly what a
 * click does, because a keyboard model that disagreed with the mouse would be a second model.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { handleKey, type PanelTreeNode } from '../../model/panel-tree';

export interface KeyboardPorts {
  /** The focusable sequence, as the tree model sees it right now. */
  nodes: () => readonly PanelTreeNode[];
  focusedKey: () => string | null;
  /** Move the single tab stop and put the caret on it. */
  focus: (key: string) => void;
  /** Whether there is anything to navigate at all. */
  ready: () => boolean;
}

export function onKeyDown(key: string, ports: KeyboardPorts): boolean {
  if (!ports.ready()) return false;
  const intent = handleKey(key, ports.nodes(), ports.focusedKey());
  if (intent === null) return false;
  if (intent.kind === 'focus') {
    ports.focus(intent.key);
    return true;
  }
  if (intent.kind === 'toggleRow') {
    post({ type: 'toggleRow', id: intent.id, expanded: intent.expanded });
    return true;
  }
  if (intent.kind === 'toggleGroup') {
    post({
      type: 'toggleGroup',
      list: intent.list,
      group: intent.group,
      collapsed: intent.collapsed,
    });
    return true;
  }
  return activate(intent.node);
}

/** The mouse model, verbatim: a row selects, expands and swaps; a part opens in the item tab. */
function activate(node: PanelTreeNode): boolean {
  if (node.kind === 'row' && node.id !== null) {
    post({ type: 'selectRow', id: node.id, list: node.list });
    return true;
  }
  if (node.kind === 'child' && node.id !== null && node.rowId !== null) {
    post({ type: 'openChild', id: node.rowId, childId: node.id });
    return true;
  }
  if (node.kind === 'group' && node.group !== null) {
    post({ type: 'toggleGroup', list: node.list, group: node.group, collapsed: node.expanded });
    return true;
  }
  return false;
}

export function installKeyboard(ports: KeyboardPorts): void {
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    // A button owns its own <kbd>Enter</kbd> and <kbd>Space</kbd> — the list header's disclosure,
    // a sort, a row's primary verb. Letting the tree act on them too would fire two things at
    // once, so the tree's keys apply only when the caret is not on a control (P2).
    const target = event.target as { tagName?: string } | null;
    if (target?.tagName === 'BUTTON') return;
    if (onKeyDown(event.key, ports)) event.preventDefault();
  });
}
