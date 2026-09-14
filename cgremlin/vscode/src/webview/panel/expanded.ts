/**
 * What a row opens into (§4, amended): the lifecycle, then the parts, then the size of the change.
 *
 * It is a SIBLING of the row rather than a child of it. That is the whole reason "row height
 * changes only on that click, never on a refresh" can be true of the node the pointer is over: a
 * refresh may add or remove this block, and the row itself never changes shape.
 *
 * Since the row's gutter and its `⋯` popover are gone, this block is also the ONLY place a verb
 * lives — so it has to carry every one. The slots already own the ladder's Start and each stage's
 * Chat; what is left over is the rare stuff with nowhere else to go (Ack, Open on GitHub, Open in
 * Jira), and that goes on one line at the bottom rather than into a menu that pops up unasked.
 *
 * The three slots are a real sequence — investigation, then development, then review — so the
 * stylesheet draws them on a spine. That is structure carrying information, not decoration: the
 * one place in the panel where the shape of the content is worth drawing.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { button, el, glyph } from './dom';
import { reconcile, setHidden, setTabStop, setText } from './reconcile';
import { child, commandOf } from './row';
import type {
  PanelActionView,
  PanelChildView,
  PanelRowView,
  PanelSlotView,
} from '../../model/panel-protocol';

export function expandedKey(rowKey: string): string {
  return `expanded:${rowKey}`;
}

/** R48's secondary action: the browser for a PR or a ticket, the conversation for a session. */
const GO_TO: Record<PanelChildView['kind'], string> = {
  ticket: 'cgremlin.openTicket',
  pr: 'cgremlin.openPr',
  agent: 'cgremlin.chat',
};

export function createExpanded(): HTMLElement {
  const node = el('div', 'expanded');
  const slots = el('div', 'slots');
  slots.setAttribute('role', 'group');
  slots.setAttribute('aria-label', 'Lifecycle');
  node.appendChild(slots);
  node.appendChild(el('div', 'parts'));

  const changes = el('div', 'changes');
  changes.appendChild(el('div', 'changes-title', 'Changes so far'));
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
  patchSlots(child(node, '.slots'), node, row.lifecycle);
  patchParts(child(node, '.parts'), node, row, focusedKey);
  // `—` whenever the engine has not answered — the row never shows a fabricated zero (MG-12).
  setText(child(node, '.committed-value'), row.changes?.committed ?? '—');
  setText(child(node, '.working-value'), row.changes?.workingTree ?? '—');
  patchActions(child(node, '.actions'), node, row);
}

/**
 * Everything the slots above do not already offer. A verb said twice in one open row is the same
 * clutter the popover was, so the slots' own Start and Chat are subtracted rather than repeated.
 */
function leftoverActions(row: PanelRowView): PanelActionView[] {
  const taken = new Set<string>();
  for (const slot of row.lifecycle) {
    if (slot.start !== null) taken.add(keyOf(slot.start.command, slot.start.childId));
    if (slot.sessionId !== null) taken.add(keyOf('cgremlin.chat', `agent:${slot.sessionId}`));
  }
  return row.actions.filter((action) => !taken.has(keyOf(action.command, action.childId)));
}

function keyOf(command: string, childId?: string): string {
  return `${command}:${childId ?? ''}`;
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

function patchSlots(parent: HTMLElement, root: HTMLElement, slots: readonly PanelSlotView[]): void {
  reconcile(
    parent,
    slots.map((slot) => ({ key: slot.stage, data: slot })),
    (slot) => createSlot(root, slot),
    (node, slot) => {
      setText(child(node, '.slot-state'), slot.stateText);
      node.dataset.state = slot.state;
      const open = child(node, '.slot-open');
      const chat = child(node, '.slot-chat');
      node.dataset.session = slot.sessionId ?? '';
      setHidden(open, slot.sessionId === null);
      setHidden(chat, slot.sessionId === null);
      const start = child(node, '.slot-start');
      setHidden(start, slot.start === null);
      setText(start, slot.start?.label ?? '');
      start.dataset.command = slot.start?.command ?? '';
    },
  );
}

function createSlot(root: HTMLElement, slot: PanelSlotView): HTMLElement {
  const node = el('div', 'slot');
  node.appendChild(glyph(slot.glyph));
  const text = el('div', 'slot-text');
  text.appendChild(el('div', 'slot-title', slot.title));
  text.appendChild(el('div', 'slot-state'));
  node.appendChild(text);

  const actions = el('div', 'slot-actions');
  // "Open" is the item tab focused on that agent; "Chat" is that stage's own conversation, gated
  // exactly as it is everywhere else (R50) — a stage that never ran offers neither.
  actions.appendChild(
    button({
      className: 'slot-open',
      label: 'Open',
      message: () => ({ type: 'openChild', id: root.dataset.id ?? '', childId: agent(node) }),
    }),
  );
  actions.appendChild(
    button({
      className: 'slot-chat',
      label: 'Chat',
      message: () => ({
        type: 'command',
        command: 'cgremlin.chat',
        id: root.dataset.id ?? '',
        childId: agent(node),
      }),
    }),
  );
  actions.appendChild(
    button({
      className: 'slot-start',
      label: '',
      message: () => ({
        type: 'command',
        command: child(node, '.slot-start').dataset.command ?? '',
        id: root.dataset.id ?? '',
      }),
    }),
  );
  node.appendChild(actions);
  return node;
}

function agent(slot: HTMLElement): string {
  return `agent:${slot.dataset.session ?? ''}`;
}

/**
 * The parts, as the `treeitem`s R66's model already counts — the ticket and the PRs. The agents
 * are the slots above, so no session is named twice in one open row.
 */
function patchParts(
  parent: HTMLElement,
  root: HTMLElement,
  row: PanelRowView,
  focusedKey: string | null,
): void {
  reconcile(
    parent,
    row.children.map((part) => ({ key: `child:${row.id}:${part.id}`, data: part })),
    (part, key) => createPart(root, part, key),
    (node, part, key) => {
      setText(child(node, '.part-label'), part.label);
      setText(child(node, '.part-goto'), part.goToLabel);
      setTabStop(node, focusedKey === key);
    },
  );
}

function createPart(root: HTMLElement, part: PanelChildView, key: string): HTMLElement {
  const node = el('div', 'part');
  node.dataset.key = key;
  node.dataset.childId = part.id;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '2');
  node.appendChild(el('span', 'part-label'));
  node.appendChild(
    button({
      className: 'part-goto',
      label: '',
      message: () => ({
        type: 'command',
        command: GO_TO[part.kind],
        id: root.dataset.id ?? '',
        childId: part.id,
      }),
    }),
  );
  node.addEventListener('click', () => {
    post({ type: 'openChild', id: root.dataset.id ?? '', childId: part.id });
  });
  return node;
}
