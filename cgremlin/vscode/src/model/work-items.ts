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
export type WorkAgentMode = 'review' | 'investigation' | 'development' | 'respond';
export type CiStatus = 'success' | 'pending' | 'failure' | 'none';

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
}

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
  mode: WorkAgentMode;
  phase: string;
  running: boolean;
  needsYou: boolean;
  claimed: boolean;
  primaryArtifact: string | null;
  worktreePath: string | null;
  ref: string;
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
  lists: WorkListsWire;
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

export interface WorkRow {
  id: WorkItemId;
  list: WorkListKind;
  item: WorkItem;
  label: string;
  /** The dimmed second line, already joined. */
  description: string;
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
      count: sections.reduce((total, section) => total + section.rows.length, 0),
      sort,
      sorts: SORT_OPTIONS[kind],
      sections,
    };
  }
  return lists;
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
  const age = ageOf(primary?.createdAt ?? null, now);
  const size = sizeOf(primary);
  const ci = ciDot(primary?.ci ?? null);
  const activity = activityOf(primary);
  const badges = item.agents.map(badgeOf);
  const chips = item.prs.map((pr) => `${pr.repo}#${pr.number}`);
  const description = [
    primary?.author === null || primary?.author === undefined ? '' : `@${primary.author}`,
    age,
    size,
    activity,
    item.attention.reasons.join(', '),
  ]
    .filter((part) => part !== '' && part !== '—')
    .join(' · ');
  return {
    id: item.id,
    list,
    item,
    label: labelOf(item, list),
    description,
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

/** R13, plus R47's one addition: a parking-lot row is always named after its PR. */
export function labelOf(item: WorkItem, list: WorkListKind): string {
  const primary = item.prs[0];
  if (list === 'parkingLot' && primary !== undefined) return prLabel(primary);
  if (item.ticket !== null) {
    return item.ticket.summary === ''
      ? item.ticket.key
      : `${item.ticket.key} — ${item.ticket.summary}`;
  }
  if (primary !== undefined) return prLabel(primary);
  return item.title;
}

function prLabel(pr: WorkItemPr): string {
  const name = `${pr.repo}#${pr.number}`;
  return pr.title === null || pr.title === '' ? name : `${name} — ${pr.title}`;
}

const MODE_LETTER: Record<WorkAgentMode, string> = {
  review: 'R',
  respond: 'C',
  investigation: 'I',
  development: 'D',
};

const MODE_GLYPH: Record<WorkAgentMode, string> = {
  review: '🔎',
  respond: '💬',
  investigation: '🔍',
  development: '🔨',
};

const MODE_NAME: Record<WorkAgentMode, string> = {
  review: 'Review',
  respond: 'Respond',
  investigation: 'Investigation',
  development: 'Development',
};

/** Claim, then a live run, then the gate — the precedence the tree used before the panel (R18). */
export function agentGlyph(agent: WorkItemAgent): string {
  if (agent.claimed) return '👤';
  if (agent.running) return '🔄';
  if (agent.needsYou) return '❗';
  return '';
}

function badgeOf(agent: WorkItemAgent): string {
  return `${MODE_LETTER[agent.mode] ?? '?'}${agentGlyph(agent)}`;
}

const CI_DOTS: Record<CiStatus, string> = {
  success: '🟢',
  pending: '🟡',
  failure: '🔴',
  none: '',
};

export function ciDot(ci: CiStatus | null): string {
  return ci === null ? '' : (CI_DOTS[ci] ?? '');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** MG-12: a row whose `createdAt` took its R45 default renders `—`, never "opened today". */
export function ageOf(createdAt: string | null, now: number): string {
  if (createdAt === null) return '—';
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return '—';
  const elapsed = Math.max(0, now - at);
  const days = Math.floor(elapsed / DAY_MS);
  if (days >= 1) return `opened ${days}d ago`;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  return hours >= 1 ? `opened ${hours}h ago` : 'opened <1h ago';
}

/** MG-12 again: no fabricated `0 files`. */
export function sizeOf(pr: WorkItemPr | undefined): string {
  if (pr === undefined || pr.changedFiles === null) return '—';
  const files = `${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'}`;
  if (pr.additions === null && pr.deletions === null) return files;
  return `${files} +${pr.additions ?? 0}/−${pr.deletions ?? 0}`;
}

/** R47: who is already on it, as one chip. The core decided `demoted`; this only names it. */
export function activityOf(pr: WorkItemPr | undefined): string {
  if (pr === undefined) return '';
  const activity = pr.humanActivity;
  if (activity !== null && activity !== undefined) {
    if (activity.reviewedBy.length > 0) return `👤 @${activity.reviewedBy[0]} reviewed`;
    if (activity.commentedBy.length > 0) return `👤 @${activity.commentedBy[0]} commented`;
  }
  const requested = pr.reviewRequests ?? [];
  if (requested.length > 0) return `👤 @${requested[0]} requested`;
  return '';
}

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
  switch (sort) {
    case 'needsYouThenRecent':
      return byNeedsYou(a, b) || descending(recencyOf(a.item), recencyOf(b.item)) || byId(a, b);
    case 'needsYouThenOldest':
      return byNeedsYou(a, b) || ascending(openedAt(a.item), openedAt(b.item)) || byId(a, b);
    case 'smallestChange':
      return ascending(changedFilesOf(a.item), changedFilesOf(b.item)) || byId(a, b);
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
      label: `🎫 ${ticket.key}${summary} (${ticket.status})`,
      focus: { kind: 'ticket' },
      goTo: { kind: 'url', url: ticket.url },
      path: itemPathOf(`ticket:${ticket.key}`),
    });
  }
  for (const pr of item.prs) {
    const ci = ciDot(pr.ci);
    children.push({
      kind: 'pr',
      id: `pr:${pr.repo}#${pr.number}`,
      label: `🔀 ${pr.repo}#${pr.number} — ${prState(pr)}${ci === '' ? '' : ` · ${ci}`}`,
      focus: { kind: 'pr', repo: pr.repo, number: pr.number },
      goTo: { kind: 'url', url: pr.url },
      path: itemPathOf(`pr:${pr.repo}#${pr.number}`),
    });
  }
  return children;
}

export function prState(pr: WorkItemPr): string {
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
