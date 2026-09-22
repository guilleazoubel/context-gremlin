/**
 * What a row opens into (round 3, Option A): the ANSWER first.
 *
 * It is a SIBLING of the row rather than a child of it. That is the whole reason "row height
 * changes only on that click, never on a refresh" can be true of the node the pointer is over: a
 * refresh may add or remove this block, and the row itself never changes shape.
 *
 * The order is fixed, and it is the order a person asks the questions in:
 *
 *   the verdict and its counts  →  ONE recommended verb  →  at most two supporting verbs
 *   →  the PR's facts in words  →  the ticket  →  one disclosure holding the machinery.
 *
 * What it replaces led with a workspace hint, a gate glued to a pipeline phase, and seven
 * identical buttons — and not one word the agent wrote. The verdict, the facts and the verbs all
 * arrive composed and placement-resolved (`model/row-composition`, `model/item-parts`); this file
 * lays them out and posts what they say. In particular it READS `placement`, which is the field
 * three modules computed and this one used to throw away.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { button, el } from './dom';
import {
  reconcile, setAttr, setClass, setDisabled, setHidden, setId, setTabStop, setText,
} from './reconcile';
import { child, commandOf } from './row';
import type { PanelActionView, PanelPartView, PanelRowView } from '../../model/panel-protocol';

export function expandedKey(rowKey: string): string {
  return `expanded:${rowKey}`;
}

/** The disclosure's label — the machinery, named as machinery. */
const DETAILS_LABEL = 'Agent worktree and housekeeping';

export function createExpanded(): HTMLElement {
  const node = el('div', 'expanded');
  // The engine went away while this row was open. Everything below is the snapshot's, and still
  // opens; this line is the only thing that changes about the row (P11).
  node.appendChild(el('div', 'expanded-offline'));
  node.appendChild(createVerdict());

  const verbs = el('div', 'verbs');
  verbs.setAttribute('role', 'group');
  verbs.setAttribute('aria-label', 'What to do about this');
  node.appendChild(verbs);
  node.appendChild(el('div', 'verb-reasons'));

  node.appendChild(el('div', 'facts'));
  node.appendChild(el('div', 'ticket-line'));

  node.appendChild(createDetails());
  return node;
}

/**
 * The block the whole round is about. Absent — not empty, ABSENT — whenever nothing parsed: a
 * fabricated `0 findings` would tell the user the change is clean, which is a claim the panel has
 * no evidence for (MG-12, MG-17j).
 */
function createVerdict(): HTMLElement {
  const node = el('div', 'verdict');
  node.appendChild(el('div', 'verdict-stale'));
  node.appendChild(el('div', 'verdict-notice'));
  node.appendChild(el('div', 'verdict-answer'));
  node.appendChild(el('div', 'verdict-sentence'));
  node.appendChild(el('div', 'verdict-counts'));
  return node;
}

function createDetails(): HTMLElement {
  const node = el('div', 'details');
  const toggle = button({
    className: 'details-toggle',
    label: DETAILS_LABEL,
    message: () => ({ type: 'toggleDetails', open: toggle.getAttribute('aria-expanded') !== 'true' }),
  });
  toggle.setAttribute('aria-expanded', 'false');
  node.appendChild(toggle);

  const body = el('div', 'details-body');
  const parts = el('div', 'parts');
  parts.setAttribute('role', 'group');
  parts.setAttribute('aria-label', 'Parts of this item');
  body.appendChild(parts);

  const changes = el('div', 'changes');
  changes.appendChild(el('div', 'change change-worktree'));
  changes.appendChild(el('div', 'change change-uncommitted'));
  body.appendChild(changes);

  const actions = el('div', 'actions');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Housekeeping');
  body.appendChild(actions);
  body.appendChild(el('div', 'action-reasons'));
  node.appendChild(body);
  return node;
}

export function patchExpanded(node: HTMLElement, row: PanelRowView, focusedKey: string | null): void {
  node.dataset.id = row.id;
  const offline = child(node, '.expanded-offline');
  setText(offline, row.detailNotice ?? '');
  setHidden(offline, row.detailNotice === null);

  patchVerdict(child(node, '.verdict'), row);
  patchVerbs(child(node, '.verbs'), node, row);
  patchReasons(child(node, '.verb-reasons'), row.verbs, 'row');
  patchFacts(child(node, '.facts'), row);
  const ticket = child(node, '.ticket-line');
  setText(ticket, row.ticketLine);
  setHidden(ticket, row.ticketLine === '');

  patchDetails(node, row, focusedKey);
}

function patchVerdict(node: HTMLElement, row: PanelRowView): void {
  const verdict = row.verdict;
  setHidden(node, verdict === null);
  // Ordering rule: staleness outranks the verdict, so it is the first thing read — a stale
  // approval is the one state that makes a user act WRONGLY rather than late.
  const stale = child(node, '.verdict-stale');
  setText(stale, verdict?.stale ?? '');
  setHidden(stale, (verdict?.stale ?? null) === null);
  const notice = child(node, '.verdict-notice');
  setText(notice, verdict?.notice ?? '');
  setHidden(notice, (verdict?.notice ?? null) === null);
  // "The agent says" is free and load-bearing: it marks the verdict as a CLAIM, which is what
  // makes disagreeing with it (the Chat beneath) an obvious thing to do.
  const answer = child(node, '.verdict-answer');
  setText(answer, verdict === null || verdict.label === '' ? '' : `The agent says: ${verdict.label}`);
  setHidden(answer, verdict === null || verdict.label === '');
  setAttr(node, 'data-tone', verdict?.tone ?? null);
  const sentence = child(node, '.verdict-sentence');
  setText(sentence, verdict?.sentence ?? '');
  setHidden(sentence, (verdict?.sentence ?? '') === '');
  const counts = child(node, '.verdict-counts');
  setText(counts, verdict?.counts ?? '');
  setHidden(counts, (verdict?.counts ?? '') === '');
}

function patchFacts(node: HTMLElement, row: PanelRowView): void {
  setHidden(node, row.facts.length === 0);
  reconcile(
    node,
    row.facts.map((fact, at) => ({ key: `fact:${at}`, data: fact })),
    () => el('div', 'fact'),
    (line, fact) => setText(line, fact),
  );
}

function keyOf(command: string, childId?: string): string {
  return `${command}:${childId ?? ''}`;
}

/**
 * §e.7 — the placements, READ. `primary` is the one full-width button, `inline` the pair beneath
 * it, `overflow` the disclosure's own group. The class carries the placement, so the stylesheet
 * says which is which without a second rule about labels.
 */
function patchVerbs(parent: HTMLElement, root: HTMLElement, row: PanelRowView): void {
  const shown = row.verbs.filter((verb) => verb.placement !== 'overflow');
  setHidden(parent, shown.length === 0);
  reconcile(
    parent,
    shown.map((action) => ({ key: keyOf(action.command, action.childId), data: action })),
    (action) => verbButton(root, action),
    (node, action) => {
      setClass(node, `row-verb ${action.placement}`);
      patchAction(node, action, 'row');
    },
  );
}

function verbButton(root: HTMLElement, action: PanelActionView): HTMLElement {
  return button({
    className: `row-verb ${action.placement}`,
    label: action.label,
    message: () =>
      action.command === 'cgremlin.openChild' && action.childId !== undefined
        ? { type: 'openChild', id: root.dataset.id ?? '', childId: action.childId }
        : commandOf(root, action.command, action.childId),
  });
}

/**
 * Phase 18 — the id of the line that says why THIS button is inert, so the button can point at
 * it with `aria-describedby`. A tooltip is not an option: a browser will not show one on a
 * disabled control, and the panel ships no `title` at all (§3).
 */
function reasonIdOf(scope: string, action: PanelActionView): string {
  return `action-reason-${scope}-${keyOf(action.command, action.childId).replace(/[^\w-]/g, '-')}`;
}

/** One button, enabled or not. `enabled: undefined` is enabled — the shape most actions have. */
function patchAction(node: HTMLElement, action: PanelActionView, scope: string): void {
  setText(node, action.label);
  const disabled = action.enabled === false;
  setDisabled(node, disabled);
  const described = disabled && action.reason !== undefined;
  setAttr(node, 'aria-describedby', described ? reasonIdOf(scope, action) : null);
}

/** The reasons under a group of buttons — ink, in the reading order of the buttons themselves. */
function patchReasons(parent: HTMLElement, actions: readonly PanelActionView[], scope: string): void {
  const reasons = actions.filter((a) => a.enabled === false && a.reason !== undefined);
  setHidden(parent, reasons.length === 0);
  reconcile(
    parent,
    reasons.map((action) => ({ key: keyOf(action.command, action.childId), data: action })),
    () => el('p', 'action-reason'),
    (node, action) => {
      setId(node, reasonIdOf(scope, action));
      setText(node, `${action.label}: ${action.reason ?? ''}`);
    },
  );
}

/**
 * The disclosure: the old object list, the agent's worktree diff and the housekeeping verbs.
 *
 * Its open state is the HOST's (like a section's collapse) rather than the DOM's, because the
 * keyboard tree is built from the state — a part inside a closed disclosure must be unreachable,
 * not merely invisible.
 */
function patchDetails(root: HTMLElement, row: PanelRowView, focusedKey: string | null): void {
  const node = child(root, '.details');
  const toggle = child(node, '.details-toggle');
  setAttr(toggle, 'aria-expanded', String(row.detailsOpen));
  const body = child(node, '.details-body');
  setHidden(body, !row.detailsOpen);
  patchParts(child(body, '.parts'), root, row, focusedKey);
  setText(child(body, '.change-worktree'), row.changes?.worktree ?? '');
  const uncommitted = child(body, '.change-uncommitted');
  setText(uncommitted, row.changes?.uncommitted ?? '');
  setHidden(uncommitted, (row.changes?.uncommitted ?? null) === null);
  const overflow = row.verbs.filter((verb) => verb.placement === 'overflow');
  patchActions(child(body, '.actions'), root, overflow);
  patchReasons(child(body, '.action-reasons'), overflow, 'overflow');
}

function patchActions(
  parent: HTMLElement,
  root: HTMLElement,
  actions: readonly PanelActionView[],
): void {
  setHidden(parent, actions.length === 0);
  reconcile(
    parent,
    actions.map((action) => ({ key: keyOf(action.command, action.childId), data: action })),
    (action) => verbButton(root, action),
    (node, action) => {
      setClass(node, 'row-action');
      patchAction(node, action, 'overflow');
    },
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
  setHidden(parent, part.actions.length === 0);
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
    (node, action) => patchAction(node, action, part.key),
  );
  patchReasons(child(partNode, '.part-reasons'), part.actions, part.key);
}

/**
 * One part. Round 3 deleted the 14px glyph column outright: it was a cost with no payoff, and it
 * was the direct cause of the stranded lone mark — flex line-breaking uses the max-content flex
 * base, so a long state string moved to line two and left the glyph alone on line one.
 */
function createPart(root: HTMLElement, part: PanelPartView, key: string): HTMLElement {
  const node = el('div', 'part');
  node.dataset.key = key;
  node.setAttribute('role', 'treeitem');
  node.setAttribute('aria-level', '2');
  const text = el('div', 'part-text');
  text.appendChild(el('div', 'part-name'));
  text.appendChild(el('div', 'part-state'));
  text.appendChild(el('div', 'part-detail'));
  node.appendChild(text);
  const actions = el('div', 'part-actions');
  node.appendChild(actions);
  // Phase 18 — the reason lives with the part whose verb it explains, under its buttons.
  node.appendChild(el('div', 'part-reasons'));
  node.addEventListener('click', () => {
    // A stage that never ran opens nothing: there is no session behind it to open (§4).
    const childId = node.dataset.childId ?? '';
    if (childId === '') return;
    post({ type: 'openChild', id: root.dataset.id ?? '', childId });
  });
  return node;
}
