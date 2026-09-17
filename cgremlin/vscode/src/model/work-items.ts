/**
 * The `GET /items` wire mirror and the panel's four-list view model (R47).
 *
 * Two rules shape this file, and both are guarded:
 *  - **membership is the core's answer** (D2). Nothing here re-derives which list a row belongs to,
 *    whether somebody is already on a PR, or which of the parking lot's three groups a row is in:
 *    it reads `item.lists`, `item.demoted` and `item.parkingLotGroup` and renders them.
 *  - **ordering, badges and the user-selected sort are presentation** (§6), so they live here. The
 *    core hands every list back in its default order; a selected sort re-orders the same ids.
 *
 * Pure module — no editor API (MG-B1). The one clock it needs (for "opened 12d ago") is injected.
 */

// ---------------------------------------------------------------------------
// The wire (core `src/work/work-item.ts`, spec §4.3)
// ---------------------------------------------------------------------------

export type WorkItemKind = 'pr' | 'ticket' | 'pr+ticket' | 'session';
export type WorkListKind = 'parkingLot' | 'myWork' | 'investigations' | 'waitingForReview';
export type ParkingLotGroup = 'reviewing' | 'untouched' | 'someoneOnIt';
export type WorkAgentMode = 'review' | 'investigation' | 'development' | 'respond' | 'qa';
/** The wire's `QA_VERDICTS` (core `schema/session.ts`), mirrored — Gap 1. */
export type QaVerdict = 'ready' | 'not_ready' | 'blocked';
export type CiStatus = 'success' | 'pending' | 'failure' | 'none';
export type SizeTier = 'S' | 'M' | 'L' | 'XL';

/** `ticket:HB-627` | `pr:owner/repo#12` | `session:<id>` (R14, R25). Opaque to the panel. */
export type WorkItemId = string;

export interface WorkItemHumanActivity {
  reviewedBy: string[];
  commentedBy: string[];
  lastAt: string | null;
}

/** R25: only `repo`, `number` and `url` are guaranteed; every other field may be null. */
export interface WorkItemPr {
  repo: string;
  number: number;
  url: string;
  title: string | null;
  author: string | null;
  branch: string | null;
  isDraft: boolean | null;
  isMine: boolean | null;
  reviewDecision: '' | 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED' | null;
  humanActivity: WorkItemHumanActivity | null;
  reviewRequests: string[] | null;
  teamActivity: unknown[] | null;
  updatedAt: string | null;
  createdAt: string | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  ci: CiStatus | null;
  labels: string[] | null;
  /**
   * P1-6: the core's own S/M/L/XL verdict (`WorkItemPr.sizeTier`). **Optional**: an engine older
   * than Phase 10 does not send it, and the panel derives the same tier locally rather than
   * rendering nothing.
   */
  sizeTier?: SizeTier | null;
  /**
   * R48's PR focus wants per-reviewer summaries, the open-thread count and the CI checks by
   * name. They are **optional** on the wire: the list response has no use for them, and the tab
   * renders what it is given rather than insisting the detail route carries them.
   */
  reviews?: { login: string; state: string; body: string | null }[] | null;
  checks?: { name: string; state: string; detailsUrl: string | null }[] | null;
  openThreads?: number | null;
  /**
   * What the PR IS: `open`/`draft` from the open-PR inventory, `merged`/`closed`
   * from the engine's pr-state cache. **Optional**: an engine older than this
   * contract sends nothing, which reads as "unknown" — never as merged, and
   * never as open either (`isLanded` and `prState` both fall back to the old
   * draft/reviewDecision wording).
   */
  state?: PrState | null;
}

export type PrState = 'open' | 'draft' | 'merged' | 'closed';


export interface WorkItemTicket {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  url: string;
  assignee: string | null;
  updatedAt: string;
}

export interface WorkItemAgent {
  sessionId: string;
  /**
   * The session's own repo slug (`owner/name`). **Optional**: an engine older
   * than this contract sends none, and a ticket-led row then simply has no
   * repo token, exactly as before.
   */
  repo?: string | null;
  mode: WorkAgentMode;
  phase: string;
  running: boolean;
  /**
   * Phase 18 — this session's last run failed (the engine's own `run_failed`
   * reason). **Optional**: an engine older than this contract sends none, and
   * the row then offers no Retry, exactly as before.
   */
  runFailed?: boolean;
  needsYou: boolean;
  claimed: boolean;
  primaryArtifact: string | null;
  worktreePath: string | null;
  ref: string;
  /**
   * Gap 1 — the same parse `evaluateQa` ran, straight off the wire.
   * **Optional**: an engine older than Gap 1 sends none, and a `not_ready`
   * QA row then falls back to today's default wording, per `qaStateText`
   * (the ONE composer this module never spells the words of itself).
   */
  qaVerdict?: QaVerdict | null;
  /**
   * Phase 19 — the session's own `lastRun.stage` and `lastRun.startedAt` (`items.ts`'s
   * `LastRunView`), mirrored so a live run can say WHICH stage it is in and for how long, rather
   * than the bare `running` that told the user nothing ("session already has a stage run in
   * progress" — with no explanation and no next step — was the raw engine sentence this silence
   * produced). **Optional**: an engine older than Phase 19 sends none, and the row falls back to
   * the generic word it drew before, exactly as it did.
   */
  lastRun?: { stage: string; startedAt: string } | null;
  /**
   * PANEL-LOCAL optimism, never on the wire: this window has just asked the
   * engine to start this stage and has not yet seen it in `/items`. It makes
   * the row say so at once — the defect it answers is a click on `Start
   * review` that silently moved the row to another section with nothing
   * saying the work had begun ("nothing happened").
   *
   * A pending agent is INERT everywhere a real session id is required: no
   * chat target, no child row, no `openChild`.
   */
  pending?: boolean;
}

/** The synthetic agent a just-started stage wears until `/items` carries the real one. */
export function pendingAgentOf(mode: WorkAgentMode): WorkItemAgent {
  return {
    sessionId: '',
    repo: null,
    mode,
    phase: 'starting',
    running: true,
    needsYou: false,
    claimed: false,
    primaryArtifact: null,
    worktreePath: null,
    ref: '',
    pending: true,
  };
}

/**
 * The item as the panel should draw it while a start is in flight. A no-op
 * once a REAL agent of that mode is on the item — which is how the optimism
 * reconciles itself the moment `/items` catches up.
 */
export function withPendingStart(item: WorkItem, mode: WorkAgentMode): WorkItem {
  if (item.agents.some((agent) => agent.mode === mode)) return item;
  // Only the AGENTS change. `lists` and `parkingLotGroup` are the core's
  // answer (D2, guarded by MG-B8) and are left exactly as they came: the row
  // says what has begun where it already is, and moves when the engine moves
  // it — selected and expanded, because the command revealed it.
  return { ...item, agents: [...item.agents, pendingAgentOf(mode)] };
}

export interface WorkItem {
  id: WorkItemId;
  kind: WorkItemKind;
  lists: WorkListKind[];
  demoted: boolean;
  parkingLotGroup: ParkingLotGroup | null;
  title: string;
  prs: WorkItemPr[];
  ticket: WorkItemTicket | null;
  agents: WorkItemAgent[];
  needsYou: boolean;
  attention: { reasons: string[]; since: string; acked: boolean; refs: string[] };
  /**
   * Item 2: the user has put this one aside. The CORE owns it — it is persisted there, the lists
   * below already exclude it, and an item that comes to need you is undismissed by the core
   * itself. An engine older than this contract sends neither field, which reads as "not dismissed"
   * rather than as an error (`isDismissed`).
   */
  dismissed: boolean;
  dismissedAt: string | null;
  /**
   * Gap 2 — the trigger store's own record that an automatic verification
   * reserved an attempt and then never reached a session (a create failed,
   * or QA was unreachable). Read from the LAST such attempt for this item's
   * ticket, and ONLY while no QA session currently exists for it — a real
   * session supersedes the signal. **Optional**: an engine older than Gap 2
   * sends neither field, which reads as "nothing abandoned".
   */
  qaAttempt?: { outcome: 'create-failed' | 'unreachable'; at: string } | null;
  /**
   * Phase 16 — which BUILD this item's change is measured against: `awaiting`
   * while the PRs are merged but the build QA is serving does not contain them
   * yet, `verified` naming the build a verification actually ran against.
   * **Optional**: an engine that predates Phase 16, or a repo whose QA names
   * no build, sends nothing and the row says nothing.
   */
  qaDeploy?: { state: 'awaiting' | 'verified'; sha: string } | null;
}

/** Tolerant of an engine that predates item 2: an absent field is not a dismissal. */
export function isDismissed(item: WorkItem): boolean {
  return item.dismissed === true;
}

export type TicketSourceKind = 'notConfigured' | 'auth' | 'unavailable' | 'ok';

export interface TicketSource {
  kind: TicketSourceKind;
  error: string | null;
  scannedAt: string | null;
}

/** R52: review threads carry no credential of their own, so an error is the whole story. */
export interface ThreadSource {
  error: string | null;
  scannedAt: string | null;
}

export interface WorkListsWire {
  /** R47: three ordered id arrays, not a flat list. */
  parkingLot: { reviewing: WorkItemId[]; untouched: WorkItemId[]; someoneOnIt: WorkItemId[] };
  myWork: WorkItemId[];
  investigations: WorkItemId[];
  waitingForReview: WorkItemId[];
}

export interface ItemsResponse {
  evaluatedAt: string;
  /** R47: the lists EXCLUDE what the user dismissed; `items` still carries every one of them. */
  lists: WorkListsWire;
  /** The ids of the dismissed items, newest dismissal first — not in `lists`, but still in `items`. */
  dismissed: WorkItemId[];
  items: WorkItem[];
  ticketSource: TicketSource;
  threadSource: ThreadSource;
}

/** R33: text only — there is no `*Html` field anywhere on this boundary (MG-10). */
export interface TicketDetail {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  assignee: string | null;
  updated: string;
  url: string;
  descriptionText: string | null;
  comments: { author: string; at: string; bodyText: string | null }[];
}

export interface ItemArtifactListing {
  name: string;
  mtime: string;
  size: number;
}

/** `GET /items/<path>` (spec §4.3). */
export interface ItemDetailResponse {
  item: WorkItem;
  ticket: TicketDetail | null;
  ticketError: string | null;
  artifacts: Record<string, ItemArtifactListing[]>;
}

// ---------------------------------------------------------------------------
// Sorts (R47, R64)
// ---------------------------------------------------------------------------

export const WORK_LIST_KINDS = [
  'parkingLot',
  'myWork',
  'investigations',
  'waitingForReview',
] as const;

export const WORK_SORT_KINDS = [
  'untouchedFirstThenOldest',
  'oldest',
  'newest',
  'smallestChange',
  'needsYouThenRecent',
] as const;
export type WorkSortKind = (typeof WORK_SORT_KINDS)[number];

export const DEFAULT_SORT: Record<WorkListKind, WorkSortKind> = {
  parkingLot: 'untouchedFirstThenOldest',
  myWork: 'needsYouThenRecent',
  investigations: 'newest',
  waitingForReview: 'oldest',
};

/** Each list offers its own default first, then the alternatives R47 names. */
export const SORT_OPTIONS: Record<WorkListKind, readonly WorkSortKind[]> = {
  parkingLot: ['untouchedFirstThenOldest', 'oldest', 'smallestChange', 'newest'],
  myWork: ['needsYouThenRecent', 'oldest', 'newest'],
  investigations: ['newest', 'oldest'],
  waitingForReview: ['oldest', 'newest'],
};

export const LIST_TITLES: Record<WorkListKind, string> = {
  parkingLot: 'Parking lot',
  myWork: 'My dev work',
  investigations: 'Investigations',
  waitingForReview: 'PRs waiting for review',
};

/**
 * §5 — the panel's six sections, in the one order they are ever drawn in.
 *
 * The parking lot's three groups are PROMOTED here rather than nested: they answer three
 * different questions (§1), and one colour and an 11 px grey title for all three was the "can't
 * separate the sections" complaint. Membership is still the core's answer (D2) — this table only
 * says which of `item.parkingLotGroup`'s values gets which header.
 *
 * The glyphs are unicode, never an icon font — `font-src 'none'` (R38) drops one silently. A
 * diamond is a PR: hollow means nobody has it, nested means I am inside it, half-filled means
 * somebody else is, and filled means it is my own work. An investigation gets the mark a
 * conclusion gets, and a PR of mine that is out with reviewers gets a clock.
 */
export interface PanelSectionSpec {
  /** `myWork`, or `parkingLot:someoneOnIt` for one of the promoted groups. */
  key: string;
  list: WorkListKind;
  group: ParkingLotGroup | null;
  title: string;
  glyph: string;
  /** Whether it starts closed. Only "someone is on it" does (R47). */
  collapsed: boolean;
}

export const PANEL_SECTIONS: readonly PanelSectionSpec[] = [
  { key: 'parkingLot:untouched', list: 'parkingLot', group: 'untouched', title: 'Parking lot', glyph: '◇', collapsed: false },
  { key: 'parkingLot:reviewing', list: 'parkingLot', group: 'reviewing', title: 'Reviewing', glyph: '◈', collapsed: false },
  { key: 'parkingLot:someoneOnIt', list: 'parkingLot', group: 'someoneOnIt', title: 'Someone is on it', glyph: '◐', collapsed: true },
  { key: 'myWork', list: 'myWork', group: null, title: 'My dev work', glyph: '◆', collapsed: false },
  { key: 'investigations', list: 'investigations', group: null, title: 'Investigations', glyph: '∴', collapsed: false },
  { key: 'waitingForReview', list: 'waitingForReview', group: null, title: 'Waiting for review', glyph: '◷', collapsed: false },
];

/** The class the stylesheet colours: a key is `a:b`, and a class may not carry the colon. */
export function sectionClassOf(key: string): string {
  return `sec-${key.replace(':', '-')}`;
}

/**
 * The narrow slice of the editor's `globalState` this module needs (R64). The real `Host`
 * satisfies it structurally, which is what keeps this module free of the editor API.
 */
export interface SortStore {
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): unknown;
}

export function sortStateKey(list: WorkListKind): string {
  return `cgremlin.sort.${list}`;
}

/** An unknown, wrongly typed or not-offered persisted value falls back to the list's default. */
export function readSort(store: SortStore, list: WorkListKind): WorkSortKind {
  const stored = store.getState<unknown>(sortStateKey(list));
  if (typeof stored === 'string' && (SORT_OPTIONS[list] as readonly string[]).includes(stored)) {
    return stored as WorkSortKind;
  }
  return DEFAULT_SORT[list];
}

export function readSorts(store: SortStore): Record<WorkListKind, WorkSortKind> {
  const sorts = {} as Record<WorkListKind, WorkSortKind>;
  for (const list of WORK_LIST_KINDS) sorts[list] = readSort(store, list);
  return sorts;
}

export function writeSort(store: SortStore, list: WorkListKind, sort: WorkSortKind): void {
  store.setState(sortStateKey(list), sort);
}

// ---------------------------------------------------------------------------
// P2: which headers the user has closed
// ---------------------------------------------------------------------------

/** A section key (§5): `myWork`, or `parkingLot:someoneOnIt`. */
export type CollapseKey = string;
export type CollapseState = Record<CollapseKey, boolean>;

export const COLLAPSE_STATE_KEY = 'cgremlin.panel.collapsed';

/**
 * A persisted value the panel did not write — a hand-edited `globalState`, or a shape from an
 * older build — is not half-read: every key that is not a boolean is dropped, and a value that is
 * not an object at all reads as "nothing was closed".
 */
export function readCollapsed(store: SortStore): CollapseState {
  const stored = store.getState<unknown>(COLLAPSE_STATE_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const out: CollapseState = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (key !== '__proto__' && typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function writeCollapsed(store: SortStore, state: CollapseState): void {
  store.setState(COLLAPSE_STATE_KEY, { ...state });
}

// ---------------------------------------------------------------------------
// §6: which area the panel is narrowed to
// ---------------------------------------------------------------------------

/** `all`, or one of the six section keys. */
export type PanelFocus = string;

export const FOCUS_ALL = 'all';
export const FOCUS_STATE_KEY = 'cgremlin.panel.focus';

/**
 * Read with the same defensive shape as `readSort`: a value this panel did not write — a
 * hand-edited `globalState`, a section key from a build that named them differently — falls back
 * to `all` rather than narrowing the panel to nothing and leaving the user with a blank column.
 */
export function readFocus(store: SortStore): PanelFocus {
  const stored = store.getState<unknown>(FOCUS_STATE_KEY);
  if (typeof stored !== 'string') return FOCUS_ALL;
  if (stored === FOCUS_ALL) return FOCUS_ALL;
  return PANEL_SECTIONS.some((section) => section.key === stored) ? stored : FOCUS_ALL;
}

export function writeFocus(store: SortStore, focus: PanelFocus): void {
  store.setState(FOCUS_STATE_KEY, focus);
}

// ---------------------------------------------------------------------------
// Item 2: what the user has put aside
// ---------------------------------------------------------------------------

/**
 * The dismissed section's key. Deliberately NOT one of `PANEL_SECTIONS`: it is not an area of the
 * work, it is the bin beside it — it never appears in the focus control, and it is drawn below
 * whichever areas the focus is showing rather than instead of them.
 */
export const DISMISSED_SECTION_KEY = 'dismissed';
export const DISMISSED_SECTION_TITLE = 'Dismissed';
/** The same typographic vocabulary the six sections use (§8) — never an icon font, never emoji. */
export const DISMISSED_SECTION_GLYPH = '⊘';

export const SHOW_DISMISSED_STATE_KEY = 'cgremlin.panel.showDismissed';

/** Read with the same defensive shape as every other persisted view state: hidden unless `true`. */
export function readShowDismissed(store: SortStore): boolean {
  return store.getState<unknown>(SHOW_DISMISSED_STATE_KEY) === true;
}

export function writeShowDismissed(store: SortStore, show: boolean): void {
  store.setState(SHOW_DISMISSED_STATE_KEY, show);
}

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

export type ItemFocus =
  | { kind: 'agent'; sessionId: string }
  | { kind: 'ticket' }
  | { kind: 'pr'; repo: string; number: number };

export type GoToTarget =
  | { kind: 'url'; url: string }
  | { kind: 'session'; sessionId: string; worktreePath: string | null };

export type WorkChildKind = 'agent' | 'ticket' | 'pr';

export interface WorkChild {
  kind: WorkChildKind;
  /** Stable within the row, so expansion state survives a re-render. */
  id: string;
  label: string;
  /** Default click: the one Item tab, focused on this part (R48). */
  focus: ItemFocus;
  /** Secondary action: the browser for a PR or a ticket, the worktree for a session. */
  goTo: GoToTarget;
  /** R65: a child addresses the engine by its OWN path, never by the item's id. */
  path: string | null;
}

/**
 * One signal on a row's second line. P0-3: the panel used to join these into a sentence and
 * then clip it after the author in a 300 px sidebar — so they cross as CELLS and the view lays
 * them out (the `·` separators are CSS, §2.3).
 */
export type RowMetaKind =
  | 'repo'
  | 'author'
  | 'age'
  | 'tier'
  | 'size'
  | 'ci'
  | 'review'
  | 'activity'
  | 'landed'
  | 'ticketStatus'
  | 'prState'
  | 'agentPhase'
  | 'running'
  /** Gap 2 — an abandoned auto-verify attempt, muted, alongside the row's other tokens. */
  | 'qaAttempt'
  /** Phase 16 — which qa build the row's change is measured against, muted. */
  | 'qaDeploy';

export interface RowMetaCell {
  kind: RowMetaKind;
  /** Empty only for a passing CI, which is a green dot and needs no word (§3). */
  text: string;
  /**
   * The accessible name, for a cell whose text is not the whole story. **Never a tooltip**: the
   * panel assigns no DOM `title` at all (§3), so this reaches the reader through `aria-label`.
   */
  label?: string;
  tone?: 'good' | 'warn' | 'bad' | 'muted' | 'active';
}

export interface WorkRow {
  id: WorkItemId;
  list: WorkListKind;
  item: WorkItem;
  /** The accessible name for the whole row: its identity and its description, in that order. */
  label: string;
  /** §2 L1 — KEYS only: `#4821`, `HB-627`, `HB-627 #4821`, or an investigation's own title. */
  identity: string;
  /** The same thing, one entry per key, because L1 renders one span per key (§8). */
  identityKeys: string[];
  /** §2 L2 — the ticket summary, else the PR title, else empty (the line is then not drawn). */
  description: string;
  /** §2 L3 — the signals, repo tail first and every other token fixed-width. */
  meta: RowMetaCell[];
  /** P1-6: `S` | `M` | `L` | `XL` | `—`. */
  tier: string;
  /** R47: the core's own answer, so "someone is on it" can be dimmed without re-deriving it. */
  demoted: boolean;
  badges: string[];
  chips: string[];
  age: string;
  size: string;
  ci: string;
  activity: string;
  needsYou: boolean;
  acked: boolean;
  reasons: string[];
  /**
   * Whether the row expands. A row whose only part is the PR (or the session) it already names
   * would expand into a copy of itself, so the expander appears from the second part on.
   */
  hasChildren: boolean;
  /** `GET|POST /items/<path>` for this row (R65). */
  path: string | null;
}

export interface WorkSection {
  group: ParkingLotGroup | null;
  title: string;
  count: number;
  /** Only "someone is on it" is collapsible, and it starts collapsed (R47). */
  collapsible: boolean;
  collapsed: boolean;
  rows: WorkRow[];
}

export interface WorkList {
  kind: WorkListKind;
  title: string;
  count: number;
  sort: WorkSortKind;
  sorts: readonly WorkSortKind[];
  sections: WorkSection[];
}

export type WorkLists = Record<WorkListKind, WorkList>;

export interface WorkListsInput {
  response: ItemsResponse;
  sorts?: Partial<Record<WorkListKind, WorkSortKind>>;
  /** Only "opened 12d ago" needs it; injected so the tests are clock-free. */
  now?: number;
}

const PARKING_SECTIONS: { group: ParkingLotGroup; title: string; collapsible: boolean }[] = [
  { group: 'reviewing', title: 'Reviewing', collapsible: false },
  { group: 'untouched', title: 'Untouched', collapsible: false },
  { group: 'someoneOnIt', title: 'Someone is on it', collapsible: true },
];

export function buildWorkLists(input: WorkListsInput): WorkLists {
  const { response } = input;
  const now = input.now ?? Date.now();
  const byId = new Map(response.items.map((item) => [item.id, item]));
  const lists = {} as WorkLists;

  for (const kind of WORK_LIST_KINDS) {
    const sort = input.sorts?.[kind] ?? DEFAULT_SORT[kind];
    const sections =
      kind === 'parkingLot'
        ? PARKING_SECTIONS.map((section) => {
            const rows = order(
              rowsOf(response.lists.parkingLot[section.group], byId, kind, now),
              sort,
              section.group,
            );
            return {
              group: section.group,
              title: section.title,
              count: rows.length,
              collapsible: section.collapsible,
              collapsed: section.collapsible,
              rows,
            };
          })
        : [
            {
              group: null,
              title: LIST_TITLES[kind],
              count: 0,
              collapsible: false,
              collapsed: false,
              rows: order(rowsOf(response.lists[kind], byId, kind, now), sort, null),
            },
          ];
    for (const section of sections) section.count = section.rows.length;
    lists[kind] = {
      kind,
      title: LIST_TITLES[kind],
      count: visibleRowCount(sections),
      sort,
      sorts: SORT_OPTIONS[kind],
      sections,
    };
  }
  return lists;
}

/**
 * P1: what the list header may claim.
 *
 * The header used to sum every section, INCLUDING the one the panel collapses by default — so a
 * parking lot that was entirely "someone is on it" read `Parking lot (11)` over an empty tree,
 * and nothing on screen said where the eleven had gone. A header counts the rows the tree under
 * it actually paints; a collapsed group carries its own count on its own header, which is the
 * thing the user expands.
 */
export function visibleRowCount(
  sections: readonly { collapsed: boolean; rows: readonly unknown[] }[],
): number {
  return sections.reduce((total, section) => total + (section.collapsed ? 0 : section.rows.length), 0);
}

function rowsOf(
  ids: readonly WorkItemId[] | undefined,
  byId: Map<string, WorkItem>,
  list: WorkListKind,
  now: number,
): WorkRow[] {
  return (ids ?? []).flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [toRow(item, list, now)];
  });
}

export function toRow(item: WorkItem, list: WorkListKind, now: number): WorkRow {
  const primary = item.prs[0];
  // A row with no PR is as old as the work behind it; a PR row whose `createdAt` defaulted says
  // `—` rather than borrowing the attention timestamp and implying a date it does not have.
  const openedIso = primary === undefined ? item.attention.since : primary.createdAt;
  const age = compactAge(openedIso, now);
  const size = sizeOf(primary);
  const tier = tierOf(primary);
  const ci = ciDot(primary?.ci ?? null);
  const activity = humanActivitySummary(primary, now);
  const identityKeys = identityKeysOf(item);
  const identity = identityKeys.join(' ');
  const description = descriptionOf(item);
  const badges = item.agents.map(agentBadge);
  const chips = item.prs.map(prLabel);
  const meta = rowMetaCells(item, list, { age, size, tier, activity, repo: repoTailOf(item) }, now);
  return {
    id: item.id,
    list,
    item,
    label: [identity, description].filter((part) => part !== '').join(' — '),
    identity,
    identityKeys,
    description,
    meta,
    tier,
    demoted: item.demoted,
    badges,
    chips,
    age,
    size,
    ci,
    activity,
    needsYou: item.needsYou,
    acked: item.attention.acked,
    reasons: [...item.attention.reasons],
    hasChildren: buildItemChildren(item).length > 1,
    path: itemPathOf(item.id),
  };
}

// ---------------------------------------------------------------------------
// The row composer lives in `./row-composition` (Phase 14). Re-exported here so
// every existing import site is unchanged, and so there is exactly ONE
// definition of each of these.
// ---------------------------------------------------------------------------
export {
  MODE_GLYPH,
  MODE_LETTER,
  MODE_NAME,
  agentBadge,
  agentGlyph,
  ciCell,
  ciDot,
  compactAge,
  descriptionOf,
  humanActivitySummary,
  humanInteractions,
  identityKeysOf,
  identityOf,
  isLandedItem,
  isLandedPr,
  landedOf,
  prLabel,
  prRefOf,
  qaStateText,
  repoTailOf,
  rowMetaCells,
  sizeOf,
  tierOf,
  titleProse,
} from './row-composition';
import {
  MODE_GLYPH,
  MODE_NAME,
  agentBadge,
  ciDot,
  compactAge,
  descriptionOf,
  humanActivitySummary,
  identityKeysOf,
  isLandedItem,
  prLabel,
  prRefOf,
  repoTailOf,
  rowMetaCells,
  sizeOf,
  tierOf,
} from './row-composition';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function order(rows: WorkRow[], sort: WorkSortKind, group: ParkingLotGroup | null): WorkRow[] {
  const effective =
    sort === 'untouchedFirstThenOldest'
      ? group === 'reviewing'
        ? 'needsYouThenOldest'
        : 'oldest'
      : sort;
  return [...rows].sort((a, b) => compare(a, b, effective));
}

type EffectiveSort = WorkSortKind | 'needsYouThenOldest';

function compare(a: WorkRow, b: WorkRow, sort: EffectiveSort): number {
  // R72 (Phase 15) — in `needsYouThenRecent` ONLY, `needsYou` is asked BEFORE the landed/live
  // split, mirroring the core's own `byNeedsYouThenRecent`. A not-ready QA verdict sits on
  // merged work by definition, and sinking it under everything still in flight is exactly the
  // row the user would never see. The same minimal rule also lifts a landed `run_failed` or
  // `comments_ready` row, which is right; every other sort keeps landed work at the bottom.
  if (sort === 'needsYouThenRecent') {
    const first = byNeedsYou(a, b);
    if (first !== 0) return first;
  }
  // Ahead of every selected sort, and a KEY rather than a filter: landed work
  // stays on the list (its ticket may still be live) but never above work
  // that has not landed.
  const landed = Number(isLandedItem(a.item)) - Number(isLandedItem(b.item));
  if (landed !== 0) return landed;
  switch (sort) {
    case 'needsYouThenRecent':
      return byNeedsYou(a, b) || descending(recencyOf(a.item), recencyOf(b.item)) || byId(a, b);
    case 'needsYouThenOldest':
      return byNeedsYou(a, b) || ascending(openedAt(a.item), openedAt(b.item)) || byId(a, b);
    case 'smallestChange':
      // P1-6's acceptance criterion: the chips must agree with the order, so the tier leads and
      // the raw file count only breaks ties inside one tier. Sorting on `changedFiles` alone put
      // a one-file, 900-line XL above a seven-file M.
      return (
        ascending(tierRankOf(a.item), tierRankOf(b.item)) ||
        ascending(changedFilesOf(a.item), changedFilesOf(b.item)) ||
        byId(a, b)
      );
    case 'newest':
      return descending(recencyOf(a.item), recencyOf(b.item)) || byId(a, b);
    case 'untouchedFirstThenOldest':
    case 'oldest':
    default:
      return ascending(openedAt(a.item), openedAt(b.item)) || byId(a, b);
  }
}

function byNeedsYou(a: WorkRow, b: WorkRow): number {
  return Number(b.needsYou) - Number(a.needsYou);
}

function byId(a: WorkRow, b: WorkRow): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A missing key sorts last in both directions, so every order is total. */
function ascending(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function descending(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function time(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** A PR row is as old as its PR; a ticket or session row as old as the work behind it. */
export function openedAt(item: WorkItem): number | null {
  return time(item.prs[0]?.createdAt) ?? time(item.ticket?.updatedAt) ?? time(item.attention.since);
}

export function recencyOf(item: WorkItem): number | null {
  const candidates = [
    ...item.prs.map((pr) => time(pr.updatedAt)),
    time(item.ticket?.updatedAt),
    time(item.attention.since),
  ].filter((value): value is number => value !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

function changedFilesOf(item: WorkItem): number | null {
  return item.prs[0]?.changedFiles ?? null;
}

const TIER_RANK: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3 };

/** `null` for an unknown size, which `ascending` already sorts last in both directions. */
function tierRankOf(item: WorkItem): number | null {
  return TIER_RANK[tierOf(item.prs[0])] ?? null;
}

/**
 * Which agent a Chat click opens, or `null` when the row has none to open (R50).
 *
 * A respond agent is chat-eligible only from `addressing` onwards — chatting into a session
 * whose `BRIEF.md` is still being written is the failure R50's ordering prevents — so an item
 * whose only agent is a triaging respond agent offers no Chat at all. Among several eligible
 * agents the most recently active one wins: a running agent, then a claimed one, then the
 * first in the core's order (which is already review → respond → investigation → development,
 * then by phase age). Every caller uses THIS, so the button and the click can never disagree.
 */
export function chatTargetOf(item: WorkItem): string | null {
  return chatTargetOfAgents(item.agents);
}

/**
 * The same rule over the agent list alone, so the Item tab — which holds `TabAgent`s rather than
 * `WorkItemAgent`s — asks the one function rather than growing a second copy of R50's gate.
 */
export function chatTargetOfAgents(
  agents: readonly { sessionId: string; mode: string; phase: string; running: boolean; claimed: boolean }[],
): string | null {
  const eligible = agents.filter(
    (agent) =>
      // A pending agent has no session to talk to yet: it is this window's
      // own optimism, not something the engine has named.
      (agent as { pending?: boolean }).pending !== true &&
      (agent.mode !== 'respond' || agent.phase === 'addressing' || agent.phase === 'ready'),
  );
  if (eligible.length === 0) return null;
  const best =
    eligible.find((agent) => agent.running) ??
    eligible.find((agent) => agent.claimed) ??
    eligible[0];
  return best.sessionId;
}

/** The `childId` an agent-targeting row action carries, so the click needs no second rule. */
export function agentChildId(sessionId: string): string {
  return `agent:${sessionId}`;
}

/** The session an `agent:` child id names, or `null` when it names something else. */
export function agentOfChildId(childId: string | null | undefined): string | null {
  if (typeof childId !== 'string' || !childId.startsWith('agent:')) return null;
  const sessionId = childId.slice('agent:'.length);
  return sessionId === '' ? null : sessionId;
}

// ---------------------------------------------------------------------------
// Children (R48, MG-15)
// ---------------------------------------------------------------------------

/**
 * The row's parts, in R2's order: every agent, then the ticket, then every PR. Derived from the
 * item and from nothing else, so a fifth agent mode renders with no edit here (MG-15).
 */
export function buildItemChildren(item: WorkItem): WorkChild[] {
  const children: WorkChild[] = [];
  for (const agent of item.agents) {
    // A pending agent has no session yet: a child row for it would address
    // the engine with an id it has never heard of.
    if (agent.pending === true) continue;
    children.push({
      kind: 'agent',
      id: `agent:${agent.sessionId}`,
      label: `${MODE_GLYPH[agent.mode] ?? '•'} ${MODE_NAME[agent.mode] ?? agent.mode} · ${agent.phase}`,
      focus: { kind: 'agent', sessionId: agent.sessionId },
      goTo: { kind: 'session', sessionId: agent.sessionId, worktreePath: agent.worktreePath },
      path: itemPathOf(`session:${agent.sessionId}`),
    });
  }
  if (item.ticket !== null) {
    const ticket = item.ticket;
    const summary = ticket.summary === '' ? '' : ` — ${ticket.summary}`;
    children.push({
      kind: 'ticket',
      id: `ticket:${ticket.key}`,
      label: `▣ ${ticket.key}${summary} (${ticket.status})`,
      focus: { kind: 'ticket' },
      goTo: { kind: 'url', url: ticket.url },
      path: itemPathOf(`ticket:${ticket.key}`),
    });
  }
  for (const pr of item.prs) {
    const ci = ciDot(pr.ci);
    children.push({
      kind: 'pr',
      id: prRefOf(pr),
      label: `◇ ${prLabel(pr)} — ${prState(pr)}${ci === '' ? '' : ` · ${ci}`}`,
      focus: { kind: 'pr', repo: pr.repo, number: pr.number },
      goTo: { kind: 'url', url: pr.url },
      path: itemPathOf(prRefOf(pr)),
    });
  }
  return children;
}

export function prState(pr: WorkItemPr): string {
  // The terminal states outrank everything: a merged PR that was approved is
  // merged, and saying `approved` there is what kept offering a review of it.
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.isDraft === true) return 'draft';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  return 'open';
}

// ---------------------------------------------------------------------------
// Ids and paths (R14, R25, R65)
// ---------------------------------------------------------------------------

const TICKET_ID = /^ticket:([A-Za-z0-9._-]+)$/;
const PR_ID = /^pr:([\w.-]+)\/([\w.-]+)#(\d+)$/;
const SESSION_ID = /^session:([\w.:@-]+)$/;

/**
 * The item's own route path. The engine never takes a raw id in a path (R14), and a child uses
 * *its* path rather than the item's, which may be a `ticket:` id (R65).
 */
export function itemPathOf(id: WorkItemId): string | null {
  const ticket = TICKET_ID.exec(id);
  if (ticket !== null) return `ticket/${ticket[1]}`;
  const pr = PR_ID.exec(id);
  if (pr !== null) return `pr/${pr[1]}/${pr[2]}/${pr[3]}`;
  const session = SESSION_ID.exec(id);
  if (session !== null) return `session/${session[1]}`;
  return null;
}

// ---------------------------------------------------------------------------
// The ticket source (R35)
// ---------------------------------------------------------------------------

export const JIRA_AUTH_MESSAGE =
  'Jira rejected the credentials. Run `cgremlin-core config check-jira` to see Jira’s own message.';

export interface SourceBanner {
  kind: 'stale' | 'auth';
  message: string;
}

/**
 * What the panel says above the lists about the two background sources. `notConfigured` says
 * nothing at all — a permanent red banner for somebody mid-setup is the failure R35 names.
 */
export function ticketBanner(
  tickets: TicketSource,
  threads: ThreadSource | null | undefined,
): SourceBanner | null {
  if (tickets.kind === 'auth') return { kind: 'auth', message: JIRA_AUTH_MESSAGE };
  if (tickets.kind === 'unavailable') {
    const detail = tickets.error === null ? '' : ` (${tickets.error})`;
    return {
      kind: 'stale',
      message: `The ticket source is unavailable${detail} — showing the last tickets that were scanned.`,
    };
  }
  if (threads != null && threads.error !== null) {
    return {
      kind: 'stale',
      message: `The review threads could not be refreshed (${threads.error}) — showing the last ones that were scanned.`,
    };
  }
  return null;
}

export interface TicketTrouble {
  message: string;
  statusText: string;
}

/** R35: `auth` earns the engine-trouble treatment — a row **and** a status-bar state. */
export function ticketTrouble(tickets: TicketSource): TicketTrouble | null {
  if (tickets.kind !== 'auth') return null;
  return { message: JIRA_AUTH_MESSAGE, statusText: '$(warning) cgremlin: jira rejected the token' };
}
