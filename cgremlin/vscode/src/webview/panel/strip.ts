/**
 * P3 — the needs-you strip, which is where the toast went.
 *
 * It leads the panel, it is one line per item, and every line is a button that puts the user on
 * that row — the same `selectRow` the row itself posts, so the strip is a shortcut into the panel
 * rather than a second way of doing anything. It survives a trouble state: what wants the user is
 * still true while the engine is explaining itself.
 *
 * It is the one thing allowed to interrupt reading order, so it earns that by being short. No
 * actions, no badges, no second line — the row it lands on has all of those.
 *
 * Runs in a browser context (R40).
 */
import { button, el } from './dom';
import { reconcile, setAttr, setText } from './reconcile';
import type { NeedsYouEntry } from '../../model/panel-protocol';

export function createStrip(): HTMLElement {
  const node = el('div', 'attention');
  node.setAttribute('role', 'region');
  const title = el('div', 'attention-title');
  node.appendChild(title);
  node.appendChild(el('div', 'attention-items'));
  return node;
}

export function patchStrip(node: HTMLElement, entries: readonly NeedsYouEntry[]): void {
  const title = node.childNodes[0] as HTMLElement;
  setText(title, entries.length === 1 ? '1 needs you' : `${entries.length} need you`);
  setAttr(node, 'aria-label', title.textContent ?? '');
  reconcile(
    node.childNodes[1] as HTMLElement,
    entries.map((entry) => ({ key: entry.id, data: entry })),
    () => createItem(),
    (item, entry) => patchItem(item, entry),
  );
}

function createItem(): HTMLElement {
  const item = button({
    className: 'attention-item',
    label: '',
    message: () => ({
      type: 'selectRow',
      id: item.dataset.id ?? '',
      list: item.dataset.list ?? '',
    }),
  });
  item.appendChild(el('span', 'attention-label'));
  item.appendChild(el('span', 'attention-reason'));
  return item;
}

function patchItem(item: HTMLElement, entry: NeedsYouEntry): void {
  item.dataset.id = entry.id;
  item.dataset.list = entry.list;
  setText(item.childNodes[0] as HTMLElement, entry.label);
  setText(item.childNodes[1] as HTMLElement, entry.reason);
}
