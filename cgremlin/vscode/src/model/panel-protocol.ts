/**
 * The side panel's two message unions and their parser (R54).
 *
 * Same discipline as the Item tab's (R21): a fixed set of shapes, only the recognised fields are
 * copied, and anything else — including a `{"__proto__": …}` payload — is `null`. `ready` is
 * required before the first `render`, which is what stops the blank-first-open race (R39).
 *
 * Pure module — no editor API (MG-B1).
 */
import type { NeedsYouEntry } from './needs-you';
import type { ActionPlacement } from './row-actions';
import {
  FOCUS_ALL,
  PANEL_SECTIONS,
  SORT_OPTIONS,
  WORK_LIST_KINDS,
  type ParkingLotGroup,
  type RowMetaCell,
  type WorkListKind,
  type WorkSortKind,
} from './work-items';

export type { RowMetaCell } from './work-items';
export type { NeedsYouEntry } from './needs-you';

export interface PanelRowView {
  id: string;
  list: WorkListKind;
  /** The accessible name for the whole row. */
  label: string;
  /** §2 L1 — keys only. */
  identity: string;
  /** L1 renders one span per key (§8), so the split is the model's rather than the view's. */
  identityKeys: string[];
  /** §2 L2 — the prose, or empty when the line is not drawn at all. */
  description: string;
  badges: string[];
  chips: string[];
  /** Rendered cells, already `—` where the field took its R45 default (MG-12). */
  age: string;
  size: string;
  ci: string;
  /** §2 L3 — the signals, as cells, so the view lays them out instead of clipping a sentence. */
  meta: RowMetaCell[];
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
  /**
   * §4 — the item's own parts, in a fixed order, each with its own state and its own buttons.
   * Empty unless the row is expanded. What replaced "three lifecycle slots + parts + people".
   */
  parts: PanelPartView[];
  /** "Changes so far", or `null` until the engine has answered — the row then paints `—`. */
  changes: PanelChangesView | null;
  /** The row's own actions, already decided by the host (which ones apply is not the view's job). */
  actions: PanelActionView[];
  /**
   * P10: the panel's one-line notice, repeated where the user is actually looking. Non-null only
   * on the EXPANDED row, and only while the notice itself stands — a hint on every line would be
   * the toast again, in ink.
   */
  hint: string | null;
}

/** One part of an expanded row (§4). Built by `model/item-parts`. */
export interface PanelPartView {
  /** `investigation` | `development` | `review` | `ticket:<KEY>` | `pr:<repo>#<n>` (§8). */
  key: string;
  kind: string;
  name: string;
  glyph: string;
  /** The lifecycle state, for the stylesheet. Empty for a ticket or a PR. */
  state: string;
  stateText: string;
  /** A second line, where the part has one. */
  detail: string;
  /** What `openChild` addresses, `null` for a stage that never ran. */
  childId: string | null;
  actions: PanelActionView[];
}

export interface PanelChangesView {
  /** Already rendered — `8 files +240/−31`, or `—` (MG-12). */
  committed: string;
  workingTree: string;
}

export interface PanelActionView {
  command: string;
  label: string;
  /** Which part of the row the action is about, when the row has more than one (R26). */
  childId?: string;
  /** Where it renders: the one primary button, an inline button, or the `⋯` menu (P1-5). */
  placement: ActionPlacement;
}

/**
 * §5 — one of the panel's six sections. There is no list level above it any more: the parking
 * lot's three groups are sections of their own, so the panel has ONE header level and one sticky
 * offset. `list` is still here because a sort and every row action are rules about the list.
 */
export interface PanelSectionView {
  /** `myWork`, or `parkingLot:someoneOnIt` (§5). Also the collapse key the host persists. */
  key: string;
  list: WorkListKind;
  group: ParkingLotGroup | null;
  title: string;
  /** The section's own mark, coloured with its own token. */
  glyph: string;
  /** How many rows it holds — which is what the user expands the header to see. */
  count: number;
  collapsed: boolean;
  sort: WorkSortKind;
  sorts: WorkSortKind[];
  /**
   * Whether THIS section draws the list's sort control. The parking lot's three sections share
   * one sort, so one of them draws it — three identical controls is the clutter being removed.
   */
  showsSort: boolean;
  rows: PanelRowView[];
}

/**
 * P10: what used to be a popup on every row click — the offer to open the managed workspace.
 * One line, one action, one "Not now" that the host remembers for good.
 */
export interface PanelNoticeView {
  message: string;
  /** The affirmative action's wording, and the command it runs. */
  actionLabel: string;
  command: string;
  dismissLabel: string;
}

/** One entry of §6's focus control: `All areas (17)`, then the six sections with their counts. */
export interface PanelFocusOption {
  key: string;
  title: string;
  count: number;
}

export interface PanelState {
  sections: PanelSectionView[];
  /** §6: `all`, or the one section key the panel is narrowed to. */
  focus: string;
  /** Every area the control offers, with its own count — including the ones not on screen. */
  focusOptions: PanelFocusOption[];
  /** P3: what wants the user, as a strip at the top of the panel instead of a toast. */
  needsYou: NeedsYouEntry[];
  /** A stale ticket or thread source, or the Jira auth failure (R35). */
  banner: { kind: 'stale' | 'auth'; message: string } | null;
  /**
   * Something that replaces the lists entirely and says what to do about it: an engine this
   * extension cannot use (Phase 8), or an engine whose `/items` the extension cannot read.
   */
  trouble: {
    message: string;
    command: string;
    actionLabel: string;
    /**
     * The second, quieter offer — the log, beside a Start that is the actual way out. Absent or
     * `null` when the trouble has only one thing to offer.
     */
    secondary?: { command: string; actionLabel: string } | null;
  } | null;
  /** P10: the dismissible offer to open the managed workspace. `null` once it is not owed. */
  notice: PanelNoticeView | null;
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
  | { type: 'toggleSection'; key: string; collapsed: boolean }
  /** §6: narrow the panel to one area, or back to all of them. Persisted by the host (R64). */
  | { type: 'setFocus'; focus: string }
  | { type: 'toggleRow'; id: string; expanded: boolean }
  /** P10's "Not now": remembered in the host's global state, not in the webview. */
  | { type: 'dismissNotice' }
  | { type: 'command'; command: string; id: string; childId?: string };

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
    case 'dismissNotice':
      return { type: 'dismissNotice' };
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
    case 'setFocus': {
      const focus = message.focus;
      if (typeof focus !== 'string') return null;
      if (focus !== FOCUS_ALL && !PANEL_SECTIONS.some((section) => section.key === focus)) {
        return null;
      }
      return { type: 'setFocus', focus };
    }
    case 'toggleSection': {
      // Only a key the panel itself draws (§5) — a hand-crafted key would write a collapse state
      // for a section that does not exist.
      const key = message.key;
      const collapsed = message.collapsed;
      if (typeof key !== 'string' || typeof collapsed !== 'boolean') return null;
      if (!PANEL_SECTIONS.some((section) => section.key === key)) return null;
      return { type: 'toggleSection', key, collapsed };
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
