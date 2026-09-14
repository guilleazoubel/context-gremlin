/**
 * One row: built once, patched forever (§2.1, §2.2, P0-4).
 *
 * The row carries its identifying data and NOTHING ELSE — title, signals, state. It holds no
 * button: the user said the per-row `⋯` popup "shows all the time and it is really annoying", and
 * he is right that a row which is only ever read does not need a verb attached to it. Every verb
 * now lives in the block the row opens into (`expanded.ts`), where the lifecycle already says
 * which one applies. So hover changes the BACKGROUND and nothing else, and a click selects and
 * opens the row — which is the one thing a collapsed row does.
 *
 * The row's own height is therefore fixed by its three lines. Expanding a row adds a sibling
 * block (see `expanded.ts`) rather than growing this node, which is what makes "row height
 * changes only on a click, never on a refresh" true of the node the pointer is actually over.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { patchCells } from './cells';
import { el } from './dom';
import { setAttr, setClass, setTabStop, setText } from './reconcile';
import type { PanelRowView } from '../../model/panel-protocol';

export interface RowContext {
  /** The `data-key` that currently holds the tree's single tab stop (R66). */
  focusedKey: string | null;
}

export function rowKey(row: PanelRowView): string {
  return `row:${row.list}:${row.id}`;
}

export function createRow(row: PanelRowView): HTMLElement {
  const node = el('div', 'row');
  node.dataset.key = rowKey(row);
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '1');

  const main = el('div', 'row-main');
  const title = el('div', 'row-title');
  title.appendChild(el('span', 'twisty'));
  title.appendChild(el('span', 'row-label'));
  main.appendChild(title);
  main.appendChild(el('div', 'row-meta'));
  node.appendChild(main);

  node.addEventListener('click', () => {
    post({ type: 'selectRow', id: node.dataset.id ?? '', list: node.dataset.list ?? '' });
  });
  return node;
}

export function patchRow(node: HTMLElement, row: PanelRowView, context: RowContext): void {
  node.dataset.id = row.id;
  node.dataset.list = row.list;
  const key = rowKey(row);
  // The list is a CLASS rather than a data attribute, because it is what the accent selects on
  // and every other row state is a class too.
  const classes = ['row', `section-${row.list}`];
  if (row.needsYou) classes.push('needs-you');
  if (row.demoted) classes.push('demoted');
  if (row.selected) classes.push('selected');
  setClass(node, classes.join(' '));
  setTabStop(node, context.focusedKey === key);
  setAttr(node, 'aria-selected', String(row.selected));
  setAttr(node, 'aria-expanded', String(row.expanded));

  setText(child(node, '.twisty'), row.expanded ? '▾' : '▸');
  setText(child(node, '.row-label'), row.label);
  patchCells(child(node, '.row-meta'), row.meta);
}

/** `instanceof HTMLElement` deliberately not used: this code is also driven against a fake DOM. */
export function child(node: HTMLElement, selector: string): HTMLElement {
  const found = node.querySelector(selector);
  if (found === null) throw new Error(`the row is missing ${selector}`);
  return found as HTMLElement;
}

/** The `command` message a row's own action posts, addressed to the row and — when the action is
 * about one of its parts — to that part (R26). Shared with the expanded block, which is now the
 * only place an action is rendered. */
export function commandOf(row: HTMLElement, command: string, childId?: string): unknown {
  return {
    type: 'command',
    command,
    id: row.dataset.id ?? '',
    ...(childId === undefined || childId === '' ? {} : { childId }),
  };
}
