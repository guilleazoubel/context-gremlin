/**
 * What a row opens into (§4): one list of the item's parts, then the size of the change.
 *
 * It is a SIBLING of the row rather than a child of it. That is the whole reason "row height
 * changes only on that click, never on a refresh" can be true of the node the pointer is over: a
 * refresh may add or remove this block, and the row itself never changes shape.
 *
 * What it replaces is "three lifecycle slots + parts + people": three fixed stages drawn on every
 * row, including the two that could only ever produce a nonsensical session on a teammate's PR.
 * The parts arrive already filtered and already carrying their own buttons (`model/item-parts`),
 * so nothing is decided here — this file lays them out and posts what they say.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { button, el } from './dom';
import { reconcile, setAttr, setClass, setHidden, setTabStop, setText } from './reconcile';
import { child, commandOf } from './row';
import type { PanelActionView, PanelPartView, PanelRowView } from '../../model/panel-protocol';

export function expandedKey(rowKey: string): string {
  return `expanded:${rowKey}`;
}

export function createExpanded(): HTMLElement {
  const node = el('div', 'expanded');
  // P10: the panel's notice, repeated where the user is actually reading. Text only — the notice
  // itself carries the buttons, and two Opens for one offer is the clutter this all replaces.
  node.appendChild(el('div', 'expanded-hint'));
  // The engine went away while this row was open. Everything below is the snapshot's, and still
  // opens; this line is the only thing that changes about the row (P11).
  node.appendChild(el('div', 'expanded-offline'));

  const parts = el('div', 'parts');
  parts.setAttribute('role', 'group');
  parts.setAttribute('aria-label', 'Parts of this item');
  node.appendChild(parts);

  const changes = el('div', 'changes');
  changes.appendChild(changeLine('committed', 'Committed'));
  changes.appendChild(changeLine('working', 'Working tree'));
  node.appendChild(changes);

  const actions = el('div', 'actions');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Actions');
  node.appendChild(actions);
  return node;
}

function changeLine(name: string, label: string): HTMLElement {
  const line = el('div', `change change-${name}`);
  line.appendChild(el('span', 'change-label', label));
  line.appendChild(el('span', `change-value ${name}-value`, '—'));
  return line;
}

export function patchExpanded(node: HTMLElement, row: PanelRowView, focusedKey: string | null): void {
  node.dataset.id = row.id;
  const hint = child(node, '.expanded-hint');
  setText(hint, row.hint ?? '');
  setHidden(hint, row.hint === null);
  const offline = child(node, '.expanded-offline');
  setText(offline, row.detailNotice ?? '');
  setHidden(offline, row.detailNotice === null);
  patchParts(child(node, '.parts'), node, row, focusedKey);
  // `—` whenever the engine has not answered — the row never shows a fabricated zero (MG-12).
  setText(child(node, '.committed-value'), row.changes?.committed ?? '—');
  setText(child(node, '.working-value'), row.changes?.workingTree ?? '—');
  patchActions(child(node, '.actions'), node, row);
}

function keyOf(command: string, childId?: string): string {
  return `${command}:${childId ?? ''}`;
}

/**
 * Everything the parts do not already offer. A verb said twice in one open row is the same
 * clutter the popover was, so every part's own buttons are subtracted rather than repeated —
 * which in practice leaves `Ack`, and only while something needs the user (§4).
 */
function leftoverActions(row: PanelRowView): PanelActionView[] {
  const taken = new Set<string>();
  for (const part of row.parts) {
    for (const action of part.actions) taken.add(keyOf(action.command, action.childId));
  }
  return row.actions.filter((action) => !taken.has(keyOf(action.command, action.childId)));
}

function patchActions(parent: HTMLElement, root: HTMLElement, row: PanelRowView): void {
  const left = leftoverActions(row);
  setHidden(parent, left.length === 0);
  reconcile(
    parent,
    left.map((action) => ({ key: keyOf(action.command, action.childId), data: action })),
    (action) =>
      button({
        className: 'row-action',
        label: action.label,
        message: () => commandOf(root, action.command, action.childId),
      }),
    (node, action) => setText(node, action.label),
  );
}

function patchParts(
  parent: HTMLElement,
  root: HTMLElement,
  row: PanelRowView,
  focusedKey: string | null,
): void {
  reconcile(
    parent,
    row.parts.map((part) => ({ key: `part:${row.id}:${part.key}`, data: part })),
    (part, key) => createPart(root, part, key),
    (node, part, key) => {
      setClass(node, `part part-${part.kind}`);
      node.dataset.state = part.state;
      node.dataset.childId = part.childId ?? '';
      setText(child(node, '.part-glyph'), part.glyph);
      setText(child(node, '.part-name'), part.name);
      setText(child(node, '.part-state'), part.stateText);
      const detail = child(node, '.part-detail');
      setText(detail, part.detail);
      setHidden(detail, part.detail === '');
      setAttr(node, 'aria-label', `${part.name} ${part.stateText}`);
      patchPartActions(child(node, '.part-actions'), root, node, part);
      setTabStop(node, focusedKey === key);
    },
  );
}

/** Each part's own buttons, by command — so a Start that stopped applying simply leaves. */
function patchPartActions(
  parent: HTMLElement,
  root: HTMLElement,
  partNode: HTMLElement,
  part: PanelPartView,
): void {
  reconcile(
    parent,
    part.actions.map((action) => ({ key: keyOf(action.command, action.childId), data: action })),
    (action) =>
      button({
        className: `part-action part-action-${action.command.split('.').pop() ?? ''}`,
        label: action.label,
        message: () =>
          action.command === 'cgremlin.openChild'
            ? {
                type: 'openChild',
                id: root.dataset.id ?? '',
                childId: partNode.dataset.childId ?? '',
              }
            : commandOf(root, action.command, action.childId),
      }),
    (node, action) => setText(node, action.label),
  );
}

function createPart(root: HTMLElement, part: PanelPartView, key: string): HTMLElement {
  const node = el('div', 'part');
  node.dataset.key = key;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '2');
  // Unicode, aria-hidden: the part's NAME is the accessible text, and the glyph is the mark that
  // makes the five kinds tellable apart at a glance (§8 — never an icon font).
  const mark = el('span', 'part-glyph');
  mark.setAttribute('aria-hidden', 'true');
  node.appendChild(mark);
  const text = el('div', 'part-text');
  text.appendChild(el('div', 'part-name'));
  text.appendChild(el('div', 'part-state'));
  text.appendChild(el('div', 'part-detail'));
  node.appendChild(text);
  const actions = el('div', 'part-actions');
  node.appendChild(actions);
  node.addEventListener('click', () => {
    // A stage that never ran opens nothing: there is no session behind it to open (§4).
    const childId = node.dataset.childId ?? '';
    if (childId === '') return;
    post({ type: 'openChild', id: root.dataset.id ?? '', childId });
  });
  return node;
}
