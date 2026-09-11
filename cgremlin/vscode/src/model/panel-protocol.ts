/**
 * The side panel's two message unions and their parser (R54).
 *
 * Same discipline as the Item tab's (R21): a fixed set of shapes, only the recognised fields are
 * copied, and anything else — including a `{"__proto__": …}` payload — is `null`. `ready` is
 * required before the first `render`, which is what stops the blank-first-open race (R39).
 *
 * Pure module — no editor API (MG-B1).
 */
import {
  SORT_OPTIONS,
  WORK_LIST_KINDS,
  type ParkingLotGroup,
  type WorkListKind,
  type WorkSortKind,
} from './work-items';

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
  needsYou: boolean;
  hasChildren: boolean;
  expanded: boolean;
  children: PanelChildView[];
  /** The row's own actions, already decided by the host (which ones apply is not the view's job). */
  actions: PanelActionView[];
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
  count: number;
  sort: WorkSortKind;
  sorts: WorkSortKind[];
  sections: PanelSectionView[];
}

export interface PanelState {
  lists: PanelListView[];
  /** A stale ticket or thread source, or the Jira auth failure (R35). */
  banner: { kind: 'stale' | 'auth'; message: string } | null;
  /** An engine this extension cannot use replaces the lists entirely (Phase 8). */
  trouble: { message: string; command: string } | null;
  connected: boolean;
}

export type HostToPanel =
  | { type: 'render'; state: PanelState }
  | { type: 'patch'; state: Partial<PanelState> };

export type PanelToHost =
  | { type: 'ready' }
  | { type: 'openItem'; id: string }
  | { type: 'openChild'; id: string; childId: string }
  | { type: 'setSort'; list: WorkListKind; sort: WorkSortKind }
  | { type: 'toggleGroup'; list: WorkListKind; group: ParkingLotGroup; collapsed: boolean }
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
