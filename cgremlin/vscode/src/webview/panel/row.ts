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
import { reconcile, setAttr, setClass, setHidden, setTabStop, setText } from './reconcile';
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

  // Three lines, fixed order, fixed meaning (§2): the keys, the prose, the signals. No twisty:
  // the row's state is said by the block it opens into, and a chevron on every line of a 300 px
  // sidebar is a column of punctuation.
  const id = el('div', 'row-id');
  // The disclosure, back on screen: `aria-expanded` said the row opened and nothing visible did.
  // One character in a fixed-width box, so turning it moves no text (§7).
  const twisty = el('span', 'row-twisty');
  twisty.setAttribute('aria-hidden', 'true');
  id.appendChild(twisty);
  id.appendChild(el('div', 'id-keys'));
  node.appendChild(id);
  node.appendChild(el('div', 'row-desc'));
  node.appendChild(el('div', 'row-signals'));

  node.addEventListener('click', () => {
    post({ type: 'selectRow', id: node.dataset.id ?? '', list: node.dataset.list ?? '' });
  });
  return node;
}

export function patchRow(
  node: HTMLElement,
  row: PanelRowView,
  accent: string,
  context: RowContext,
): void {
  node.dataset.id = row.id;
  node.dataset.list = row.list;
  const key = rowKey(row);
  // The section is a CLASS rather than a data attribute, because it is what the accent selects
  // on and every other row state is a class too (§5).
  const classes = ['row', accent];
  if (row.needsYou) classes.push('needs-you');
  if (row.demoted) classes.push('demoted');
  if (row.selected) classes.push('selected');
  setClass(node, classes.join(' '));
  setTabStop(node, context.focusedKey === key);
  setAttr(node, 'aria-selected', String(row.selected));
  setAttr(node, 'aria-expanded', String(row.expanded));

  setAttr(node, 'aria-label', row.label);
  setText(child(node, '.row-twisty'), row.expanded ? '▾' : '▸');
  patchKeys(child(node, '.id-keys'), row.identityKeys);
  const desc = child(node, '.row-desc');
  setText(desc, row.description);
  // An empty description is not a blank line: the row is two lines tall and says so (§2).
  setHidden(desc, row.description === '');
  patchCells(child(node, '.row-signals'), row.meta);
}

/** One span per key, keyed by position so a ticket that grows a PR patches rather than rebuilds. */
function patchKeys(parent: HTMLElement, keys: readonly string[]): void {
  reconcile(
    parent,
    keys.map((key, index) => ({ key: `${index}`, data: key })),
    () => el('span', 'id-key'),
    (node, key) => setText(node, key),
  );
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
