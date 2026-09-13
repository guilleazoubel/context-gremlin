/**
 * The side panel's two message unions and their parser (R54).
 *
 * Same discipline as the Item tab's (R21): a fixed set of shapes, only the recognised fields are
 * copied, and anything else — including a `{"__proto__": …}` payload — is `null`. `ready` is
 * required before the first `render`, which is what stops the blank-first-open race (R39).
 *
 * Pure module — no editor API (MG-B1).
 */
import type { SlotState } from './lifecycle';
import type { ActionPlacement, StageKind } from './row-actions';
import {
  SORT_OPTIONS,
  WORK_LIST_KINDS,
  type ParkingLotGroup,
  type RowMetaCell,
  type WorkListKind,
  type WorkSortKind,
} from './work-items';

export type { RowMetaCell } from './work-items';

export interface PanelRowView {
  id: string;
  list: WorkListKind;
  label: string;
  description: string;
  badges: string[];
  chips: string[];
  /** Rendered cells, already `—` where the field took its R45 default (MG-12). */
  age: string;
  size: string;
  ci: string;
  /** P0-3: the second line as cells, so the view lays them out instead of clipping a sentence. */
  meta: RowMetaCell[];
  /** P1-7: the third line, for `myWork`. Empty everywhere else. */
  stateLine: RowMetaCell[];
  /** P1-6: `S` | `M` | `L` | `XL` | `—`. */
  tier: string;
  /** R47: "someone is on it" — the core's answer, rendered as a dimmed row. */
  demoted: boolean;
  needsYou: boolean;
  hasChildren: boolean;
  expanded: boolean;
  /**
   * The persistent highlight (§4, amended). Distinct from focus: the roving tab stop moves with
   * the arrow keys, whereas the selection changes only on a click or an activation — and it is
   * the selection that says which worktree the workspace currently holds.
   */
  selected: boolean;
  /** The PARTS — the ticket and the PRs. The agents are the lifecycle slots instead. */
  children: PanelChildView[];
  /** Investigation → Development → Review. Empty unless the row is expanded. */
  lifecycle: PanelSlotView[];
  /** "Changes so far", or `null` until the engine has answered — the row then paints `—`. */
  changes: PanelChangesView | null;
  /** The row's own actions, already decided by the host (which ones apply is not the view's job). */
  actions: PanelActionView[];
}

/** One lifecycle slot of an expanded row (§4, amended). Built by `model/lifecycle`. */
export interface PanelSlotView {
  stage: StageKind;
  title: string;
  glyph: string;
  state: SlotState;
  stateText: string;
  /** The stage's session — what Open and Chat address. `null` when the stage never ran. */
  sessionId: string | null;
  /** The forward-only Start for this stage, when the rule allows one here. */
  start: PanelActionView | null;
}

export interface PanelChangesView {
  /** Already rendered — `8 files +240/−31`, or `—` (MG-12). */
  committed: string;
  workingTree: string;
}

export interface PanelChildView {
  id: string;
  kind: 'agent' | 'ticket' | 'pr';
  label: string;
  /** The secondary action's wording — "Open on GitHub", "Open in Jira", "Resume". */
  goToLabel: string;
}

export interface PanelActionView {
  command: string;
  label: string;
  /** Which part of the row the action is about, when the row has more than one (R26). */
  childId?: string;
  /** Where it renders: the one primary button, an inline button, or the `⋯` menu (P1-5). */
  placement: ActionPlacement;
}

export interface PanelSectionView {
  group: ParkingLotGroup | null;
  title: string;
  count: number;
  collapsible: boolean;
  collapsed: boolean;
  rows: PanelRowView[];
}

export interface PanelListView {
  kind: WorkListKind;
  title: string;
  /** P2: the list's own mark, in the fixed-width column the row's twisty sits in. */
  glyph: string;
  /** P2: the rows the tree paints right now — never the ones a closed group holds (P1). */
  count: number;
  /** P2: whether the user has closed the whole list. Persisted in the host's state (R64). */
  collapsed: boolean;
  sort: WorkSortKind;
  sorts: WorkSortKind[];
  sections: PanelSectionView[];
}

export interface PanelState {
  lists: PanelListView[];
  /** A stale ticket or thread source, or the Jira auth failure (R35). */
  banner: { kind: 'stale' | 'auth'; message: string } | null;
  /**
   * Something that replaces the lists entirely and says what to do about it: an engine this
   * extension cannot use (Phase 8), or an engine whose `/items` the extension cannot read.
   */
  trouble: { message: string; command: string; actionLabel: string } | null;
  connected: boolean;
}

export type HostToPanel =
  | { type: 'render'; state: PanelState }
  | { type: 'patch'; state: Partial<PanelState> };

export type PanelToHost =
  | { type: 'ready' }
  /**
   * One click on a row, which is **one** decision with three consequences (§4, amended): the row
   * becomes the selected one, it expands (accordion — the previously expanded row closes), and
   * the workspace swaps to that item's current worktree. They are one message because they are
   * one user act: three messages would let the panel end up selected on one row and swapped to
   * another if any of them were dropped.
   */
  | { type: 'selectRow'; id: string; list: WorkListKind }
  | { type: 'openItem'; id: string }
  | { type: 'openChild'; id: string; childId: string }
  | { type: 'setSort'; list: WorkListKind; sort: WorkSortKind }
  | { type: 'toggleGroup'; list: WorkListKind; group: ParkingLotGroup; collapsed: boolean }
  | { type: 'toggleList'; list: WorkListKind; collapsed: boolean }
  | { type: 'toggleRow'; id: string; expanded: boolean }
  | { type: 'command'; command: string; id: string; childId?: string };

const GROUPS: readonly ParkingLotGroup[] = ['reviewing', 'untouched', 'someoneOnIt'];

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function listKind(value: unknown): WorkListKind | null {
  return typeof value === 'string' && (WORK_LIST_KINDS as readonly string[]).includes(value)
    ? (value as WorkListKind)
    : null;
}

export function parsePanelMessage(raw: unknown): PanelToHost | null {
  const message = record(raw);
  if (message === null) return null;
  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'selectRow': {
      const id = text(message.id);
      const list = listKind(message.list);
      return id === null || list === null ? null : { type: 'selectRow', id, list };
    }
    case 'openItem': {
      const id = text(message.id);
      return id === null ? null : { type: 'openItem', id };
    }
    case 'openChild': {
      const id = text(message.id);
      const childId = text(message.childId);
      return id === null || childId === null ? null : { type: 'openChild', id, childId };
    }
    case 'setSort': {
      const list = listKind(message.list);
      if (list === null) return null;
      const sort = message.sort;
      // A list may only be sorted the ways it offers (R47) — the vocabulary is shared, the menus
      // are not.
      if (typeof sort !== 'string' || !(SORT_OPTIONS[list] as readonly string[]).includes(sort)) {
        return null;
      }
      return { type: 'setSort', list, sort: sort as WorkSortKind };
    }
    case 'toggleGroup': {
      const list = listKind(message.list);
      const group = message.group;
      const collapsed = message.collapsed;
      if (list === null || typeof group !== 'string' || typeof collapsed !== 'boolean') return null;
      if (!(GROUPS as readonly string[]).includes(group)) return null;
      return { type: 'toggleGroup', list, group: group as ParkingLotGroup, collapsed };
    }
    case 'toggleList': {
      const list = listKind(message.list);
      const collapsed = message.collapsed;
      return list === null || typeof collapsed !== 'boolean'
        ? null
        : { type: 'toggleList', list, collapsed };
    }
    case 'toggleRow': {
      const id = text(message.id);
      const expanded = message.expanded;
      return id === null || typeof expanded !== 'boolean'
        ? null
        : { type: 'toggleRow', id, expanded };
    }
    case 'command': {
      const command = text(message.command);
      const id = text(message.id);
      if (command === null || id === null) return null;
      const childId = text(message.childId);
      return childId === null
        ? { type: 'command', command, id }
        : { type: 'command', command, id, childId };
    }
    default:
      return null;
  }
}
