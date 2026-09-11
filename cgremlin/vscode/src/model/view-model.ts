/**
 * The panel's view model: four lists over one `AttentionItem[]`.
 *
 * Two properties are load-bearing and guarded (R18):
 *  - the panel is driven by an ordered array of {@link ListDescriptor}s, so a fifth source is one
 *    array entry plus one `build`, never a restructuring;
 *  - no `build` branches on `item.source`. Selection happens on `mode`, `stageStatus`, `attention`
 *    and `links` — fields every source carries (nullable).
 *
 * Pure module — no editor API (MG-B1).
 */
import { displayTitle } from './items';
import type {
  AttentionItem,
  InventoryEntry,
  InventoryGroups,
  ListItem,
  ListKind,
  SessionMode,
  SessionView,
} from './items';

/**
 * Mirrors the core's `TERMINAL_PHASES_BY_MODE` (`src/workspace/workspace-in-use.ts`), pinned
 * against that literal by a test. Note `changes_requested` is **not** terminal: the core's review
 * table transitions it back to `reviewing`, which is how a re-review reaches such a PR.
 */
export const TERMINAL_PHASES_BY_MODE: Record<SessionMode, readonly string[]> = {
  investigation: ['promoted_to_development', 'abandoned'],
  development: ['merged', 'abandoned'],
  review: ['approved', 'dismissed'],
  respond: ['closed', 'abandoned'],
};

export function isTerminalPhase(mode: SessionMode | null, stageStatus: string | null): boolean {
  if (mode === null || stageStatus === null) return false;
  return TERMINAL_PHASES_BY_MODE[mode]?.includes(stageStatus) ?? false;
}

export interface ViewModelInput {
  /** Straight from `GET /attention?all=1` — the only required input. */
  items: AttentionItem[];
  /** Optional enrichment (titles, newCommits); null before the first scan. */
  groups: InventoryGroups | null;
  sessions: SessionView[];
}

export interface ListDescriptor {
  kind: ListKind;
  title: string;
  build(input: ViewModelInput): ListItem[];
}

/** Indicator precedence: claim, then a live run, then the gates in severity order. */
export function indicatorFor(item: AttentionItem): ListItem['indicator'] {
  if (item.claimed) return '👤';
  if (item.running) return '🔄';
  const reasons = new Set(item.attention.reasons);
  if (reasons.has('blocked')) return '🛑';
  if (reasons.has('run_failed')) return '❗';
  if (reasons.has('needs_input')) return '⏸️';
  if (
    reasons.has('plan_ready') ||
    reasons.has('review_ready') ||
    reasons.has('rereview_ready') ||
    reasons.has('changes_requested')
  ) {
    return '✅';
  }
  return '';
}

function allEntries(groups: InventoryGroups | null): InventoryEntry[] {
  if (groups === null) return [];
  return [...groups.unreviewed, ...groups.teamOnIt, ...groups.ours, ...groups.mine];
}

function entryFor(input: ViewModelInput, item: AttentionItem): InventoryEntry | undefined {
  const { prRepo, prNumber } = item.links;
  if (prRepo === null || prNumber === null) return undefined;
  return allEntries(input.groups).find((e) => e.repo === prRepo && e.number === prNumber);
}

/** The item that speaks for an inventory row when no session covers it. */
function unsessionedItemFor(input: ViewModelInput, entry: InventoryEntry): AttentionItem | undefined {
  return input.items.find(
    (i) => i.mode === null && i.links.prRepo === entry.repo && i.links.prNumber === entry.number,
  );
}

function describe(item: AttentionItem, entry: InventoryEntry | undefined): string {
  const parts: string[] = [];
  parts.push(
    item.links.prNumber === null ? item.repoOrContext : `${item.repoOrContext}#${item.links.prNumber}`,
  );
  if (item.stageStatus !== null) parts.push(item.stageStatus);
  if (entry !== undefined && entry.ours.status !== 'none' && entry.ours.newCommits) parts.push('new commits');
  if (item.attention.reasons.length > 0) parts.push(item.attention.reasons.join(', '));
  return parts.join(' · ');
}

function toListItem(kind: ListKind, item: AttentionItem, entry: InventoryEntry | undefined): ListItem {
  return {
    kind,
    item,
    label: displayTitle(item),
    description: describe(item, entry),
    indicator: indicatorFor(item),
    contextValue: `${kind}:${item.source}:${item.mode ?? 'none'}`,
  };
}

/** Every non-terminal item of one session mode, in `items` order. */
function liveSessions(input: ViewModelInput, mode: SessionMode): AttentionItem[] {
  return input.items.filter((i) => i.mode === mode && !isTerminalPhase(i.mode, i.stageStatus));
}

export const LIST_ORDER: readonly ListDescriptor[] = [
  {
    kind: 'parking',
    title: 'Parking lot',
    build: (input) =>
      (input.groups?.unreviewed ?? []).flatMap((entry) => {
        const item = unsessionedItemFor(input, entry);
        return item === undefined ? [] : [toListItem('parking', item, entry)];
      }),
  },
  {
    kind: 'reviewing',
    title: 'PRs we are reviewing',
    build: (input) =>
      // Session-sourced, not `groups.ours`: an off-config PR reviewed from its URL has no
      // inventory entry at all, and would otherwise be invisible while its agent runs (MG-B6).
      liveSessions(input, 'review').map((item) => toListItem('reviewing', item, entryFor(input, item))),
  },
  {
    kind: 'investigations',
    title: 'Investigations',
    build: (input) =>
      liveSessions(input, 'investigation').map((item) =>
        toListItem('investigations', item, entryFor(input, item)),
      ),
  },
  {
    kind: 'devwork',
    title: 'My dev work',
    build: (input) => {
      const live = liveSessions(input, 'development');
      const rows = live.map((item) => toListItem('devwork', item, entryFor(input, item)));
      for (const entry of input.groups?.mine ?? []) {
        const covered = live.some(
          (i) => i.links.prRepo === entry.repo && i.links.prNumber === entry.number,
        );
        if (covered) continue;
        const item = unsessionedItemFor(input, entry);
        if (item !== undefined) rows.push(toListItem('devwork', item, entry));
      }
      return rows;
    },
  },
];

/** Iterates the descriptor array, so the key set is always exactly what `order` declares. */
export function buildLists(
  input: ViewModelInput,
  order: readonly ListDescriptor[] = LIST_ORDER,
): Record<ListKind, ListItem[]> {
  const lists = {} as Record<ListKind, ListItem[]>;
  for (const descriptor of order) {
    lists[descriptor.kind] = descriptor.build(input);
  }
  return lists;
}
