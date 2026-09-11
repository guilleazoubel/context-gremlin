/**
 * One row: built once, patched forever (§2.1, §2.2, P0-4).
 *
 * The row carries its identifying data by default — title, signals, state — because the user
 * decides from those and a sidebar has no room for a hover-only reveal. So hover changes the
 * BACKGROUND and nothing else, and the only thing the gutter's opacity hides is chrome that was
 * already occupying its space.
 *
 * The row's own height is therefore fixed by its three lines. Expanding a row adds a sibling
 * block (see `expanded.ts`) rather than growing this node, which is what makes "row height
 * changes only on a click, never on a refresh" true of the node the pointer is actually over.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { patchCells } from './cells';
import { button, el } from './dom';
import { closeOverflow, forgetOverflow, toggleOverflow } from './overflow';
import { reconcile, setAttr, setClass, setHidden, setTabStop, setText } from './reconcile';
import type { PanelActionView, PanelRowView } from '../../model/panel-protocol';

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
  main.appendChild(el('div', 'row-state'));
  node.appendChild(main);

  // §2.2 rule 1: the gutter is part of the row's structure at every moment. It is reserved
  // whether or not the pointer is there, so nothing it contains can change the row's height.
  const gutter = el('div', 'row-gutter');
  // The primary keeps its node for the life of the row and reads its verb out of its own dataset
  // at click time — a button rebuilt under the pointer is the click that lands on nothing.
  const primary = button({
    className: 'row-primary',
    label: '',
    message: () => commandOf(node, primary.dataset.command ?? '', primary.dataset.childId),
  });
  gutter.appendChild(primary);
  const more = el('button', 'row-more', '⋯');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-label', 'More actions');
  more.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    toggleOverflow(child(node, '.row-overflow'), more);
  });
  gutter.appendChild(more);
  const menu = el('div', 'row-overflow');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  gutter.appendChild(menu);
  node.appendChild(gutter);

  node.addEventListener('click', () => {
    post({ type: 'selectRow', id: node.dataset.id ?? '', list: node.dataset.list ?? '' });
  });
  return node;
}

export function patchRow(node: HTMLElement, row: PanelRowView, context: RowContext): void {
  node.dataset.id = row.id;
  node.dataset.list = row.list;
  const key = rowKey(row);
  const classes = ['row'];
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
  patchCells(child(node, '.row-state'), row.stateLine);
  patchActions(node, row);
}

/** `instanceof HTMLElement` deliberately not used: this code is also driven against a fake DOM. */
export function child(node: HTMLElement, selector: string): HTMLElement {
  const found = node.querySelector(selector);
  if (found === null) throw new Error(`the row is missing ${selector}`);
  return found as HTMLElement;
}

/**
 * One visible verb, everything else behind `⋯` (P1-5). The primary keeps its node across a
 * patch — a button that is rebuilt under the pointer is the click that lands on nothing.
 */
function patchActions(node: HTMLElement, row: PanelRowView): void {
  const primary = row.actions.find((action) => action.placement === 'primary');
  const rest = row.actions.filter((action) => action.placement !== 'primary');
  const first = child(node, '.row-primary');
  setText(first, primary?.label ?? '');
  setHidden(first, primary === undefined);
  first.dataset.command = primary?.command ?? '';
  first.dataset.childId = primary?.childId ?? '';

  const menu = child(node, '.row-overflow');
  setHidden(child(node, '.row-more'), rest.length === 0);
  // A row that lost its overflow must not stay "the open one". A row that still has one keeps it
  // open across a refresh on purpose: a menu that closed under the pointer would be the very
  // defect P0-4 is about.
  if (rest.length === 0) forgetOverflow(menu);
  reconcile(
    menu,
    rest.map((action) => ({ key: `${action.command}:${action.childId ?? ''}`, data: action })),
    (action) => menuItem(node, action),
    (item, action) => setText(item, action.label),
  );
}

function menuItem(row: HTMLElement, action: PanelActionView): HTMLElement {
  const item = button({
    className: 'row-overflow-item',
    label: action.label,
    message: () => commandOf(row, action.command, action.childId),
  });
  item.setAttribute('role', 'menuitem');
  item.addEventListener('click', () => closeOverflow(false));
  return item;
}

export function commandOf(row: HTMLElement, command: string, childId?: string): unknown {
  return {
    type: 'command',
    command,
    id: row.dataset.id ?? '',
    ...(childId === undefined || childId === '' ? {} : { childId }),
  };
}
