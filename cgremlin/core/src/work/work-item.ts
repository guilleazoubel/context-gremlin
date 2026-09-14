import type { AttentionItem } from '../attention/attention-service';
import type { ItemRef } from '../attention/item-ref';
import { ATTENTION_REASONS, NEEDS_YOU_REASONS, type AttentionReason } from '../attention/attention';
import type { CiStatus } from '../gh/pr-view';
import { isLandedState, prStateKey, type PrState, type PrStateCache, type PrStateEntry } from '../gh/pr-state';
import type { Inventory, InventoryEntry, TeamActivity } from '../inventory/inventory';
import type { JiraScanReport } from '../jira/jira-store';
import type { SessionMode } from '../schema/session';
import { sizeTierOf, type SizeTier } from './size-tier';
import { workItemIdOf, type WorkItemId } from './work-item-id';

/**
 * R1 — a `WorkItem` is a GROUPING over `AttentionItem`s, never a second
 * derivation. Nothing in this module reads a session, an AGENT_STATE file or
 * an artifact mtime: `deriveSessionReasons`/`evaluateAttention` is the one
 * place the "does this want me" rule lives, and a second reader of session
 * state would be a second copy of that rule AND a second thing that could
 * take a session lock (MG-1).
 *
 * `groupWorkItems` is PURE: no clock, no I/O. Every order below is total,
 * deterministic and stable, with ties broken on `id`.
 */

// R25: 'session' is a real kind — an agent with neither a PR nor a ticket.
export type WorkItemKind = 'pr' | 'ticket' | 'pr+ticket' | 'session';

/**
 * R47: FOUR lists. `reviewing` is superseded as a LIST — a PR with a review
 * agent of ours stays in `parkingLot`, in its `'reviewing'` group, and never
 * lands in `myWork` (coordinator override, 2026-09-10).
 */
export type WorkListKind = 'parkingLot' | 'myWork' | 'investigations' | 'waitingForReview';

export type ParkingLotGroup = 'reviewing' | 'untouched' | 'someoneOnIt';

/**
 * R25: only `repo`, `number` and `url` are guaranteed. Everything else is
 * nullable, because a merged or closed PR that still has a live agent leaves
 * the open-PR inventory while its work item must survive — the agent, not
 * the inventory row, keeps the item alive.
 */
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
  humanActivity: { reviewedBy: string[]; commentedBy: string[]; lastAt: string | null } | null;
  reviewRequests: string[] | null;
  teamActivity: TeamActivity[] | null;
  updatedAt: string | null;
  // R53 — the fields the re-scope's rows are made of.
  createdAt: string | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  ci: CiStatus | null;
  labels: string[] | null;
  /** Workshop phase 10 §2.1: pure arithmetic on `changedFiles`/`additions`/`deletions`, null when either is null. */
  sizeTier: SizeTier | null;
  /**
   * What the PR IS — `open`/`draft` from the open-PR inventory, `merged`/
   * `closed` from the pr-state cache. `null` means genuinely unknown (the
   * PR is not in the inventory and the leg has not resolved it yet), NEVER
   * "open": an unknown state must not read as live work.
   *
   * Additive on the wire, and a client older than this contract simply does
   * not read it.
   */
  state: PrState | null;
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
  /**
   * The session's own repo slug (`owner/name`), so a ticket-led row with no
   * PR still says which repo the work is in. Taken from the attention item's
   * `repoOrContext`, which is the session's `workspace.repoUrl` — never
   * parsed back out of a worktree path. `null` only where the source has no
   * repo at all.
   */
  repo: string | null;
  mode: SessionMode;
  phase: string;
  running: boolean;
  needsYou: boolean;
  claimed: boolean;
  primaryArtifact: string | null;
  worktreePath: string | null;
  /** The AttentionItem it came from — the ack key stays the ref (R3). */
  ref: ItemRef;
}

export interface WorkItem {
  id: WorkItemId;
  kind: WorkItemKind;
  /** Computed by the CORE (D2); the extension does not re-derive membership. */
  lists: WorkListKind[];
  /** R47: "somebody is already on this PR" — true when any of `prs` satisfies `someoneIsOnIt`. */
  demoted: boolean;
  /** R47: which of the parking lot's three ordered groups this row is in; null off the list. */
  parkingLotGroup: ParkingLotGroup | null;
  title: string;
  /** R26: a ticket with two PRs is ONE item with two PRs, most-recently-updated first. */
  prs: WorkItemPr[];
  ticket: WorkItemTicket | null;
  agents: WorkItemAgent[];
  needsYou: boolean;
  /**
   * "I don't care about this one right now" — persisted per item in the
   * state dir by `DismissStore` and applied by `WorkItemService`, never
   * derived here (`groupWorkItems` stays pure). A dismissed item is in NO
   * list, but it is still in `items`, so a client can render "show
   * dismissed" without a refetch.
   */
  dismissed: boolean;
  dismissedAt: string | null;
  attention: { reasons: AttentionReason[]; since: string; acked: boolean; refs: ItemRef[] };
}

export interface GroupWorkItemsInput {
  /** The PRE-dedupe list (R27): both the session item and its `source: 'pr'` item. */
  items: readonly AttentionItem[];
  inventory: Inventory | null;
  jira: JiraScanReport | null;
  me: string;
  watchAuthors: readonly string[];
  showAllRepoPrs: boolean;
  /** R29/R46 — what filters a session's `lineage.ticket` AT GROUP TIME. */
  projectKeys: readonly string[];
  botLogins?: readonly string[];
  /** Optional: lets a ticket seeded by R28 (never seen by the JQL) still carry a browse URL. */
  jiraSiteUrl?: string;
  /**
   * The pr-state leg's cache. It answers two questions the open-PR inventory
   * cannot: what happened to a PR that left it, and which ticket that PR
   * named. It DECORATES items and never creates one — see step 3b.
   */
  prStates?: PrStateCache;
}

const MODE_RANK: Record<string, number> = { review: 0, respond: 1, investigation: 2, development: 3 };

const TICKET_KEY = /^([A-Z][A-Z0-9]+)-\d+$/;

/**
 * R29, the scan-time/group-time ASYMMETRY, stated: a PR's `ticketKeys` were
 * filtered by `projectKeys` at SCAN time and persisted already-filtered, but
 * a session's `lineage.ticket` was written UNFILTERED by `extractTicketKey`
 * at session-creation time and may predate the config. So it is filtered
 * again, here, and ignored when it does not pass. Phase 9 does not rewrite
 * sessions; it just declines to join on a `SHA-256`.
 */
function filteredTicket(raw: string | null, projectKeys: readonly string[]): string | null {
  if (raw === null || projectKeys.length === 0) return null;
  const match = TICKET_KEY.exec(raw);
  if (match === null) return null;
  return projectKeys.includes(match[1]) ? raw : null;
}

function prFromEntry(e: InventoryEntry): WorkItemPr {
  return {
    repo: e.repo,
    number: e.number,
    url: e.url,
    title: e.title,
    author: e.author,
    branch: e.branch,
    isDraft: e.isDraft,
    isMine: e.isMine,
    reviewDecision: e.reviewDecision,
    humanActivity: e.humanActivity,
    reviewRequests: e.reviewRequests,
    teamActivity: e.teamActivity,
    updatedAt: e.updatedAt,
    createdAt: e.createdAt,
    changedFiles: e.changedFiles,
    additions: e.additions,
    deletions: e.deletions,
    ci: e.ci,
    labels: e.labels,
    sizeTier: sizeTierOf({ changedFiles: e.changedFiles, additions: e.additions, deletions: e.deletions }),
    // The inventory lists `--state open` only, so every row in it is open;
    // draftness is the one distinction it carries.
    state: e.isDraft ? 'draft' : 'open',
  };
}

/** R25's nullability half: the PR left the open-PR inventory but its agent keeps the item alive. */
function prFromAgentLinks(
  repo: string,
  number: number,
  url: string | null,
  cached: PrStateEntry | undefined,
): WorkItemPr {
  return {
    repo,
    number,
    url: cached?.url ?? url ?? `https://github.com/${repo}/pull/${number}`,
    title: cached?.title ?? null,
    author: null,
    branch: cached?.branch ?? null,
    isDraft: null,
    isMine: null,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: null,
    createdAt: null,
    changedFiles: null,
    additions: null,
    deletions: null,
    ci: null,
    labels: null,
    sizeTier: null,
    state: cached?.state ?? null,
  };
}

/** The same shape, for a landed PR that no live session names any more — the cache is all that is left of it. */
function prFromCache(repo: string, number: number, cached: PrStateEntry): WorkItemPr {
  return prFromAgentLinks(repo, number, cached.url, cached);
}

const PR_CACHE_KEY = /^(.+)#(\d+)$/;

interface Candidate {
  id: WorkItemId;
  ticketKey: string | null;
  ticket: WorkItemTicket | null;
  prs: WorkItemPr[];
  agents: WorkItemAgent[];
  /** Every AttentionItem that contributes reasons and a ref to this candidate. */
  contributors: AttentionItem[];
  sessionTitle: string | null;
}

const prKeyOf = (repo: string, number: number): string => `${repo}#${number}`;

export function groupWorkItems(input: GroupWorkItemsInput): WorkItem[] {
  const meLower = input.me.toLowerCase();
  const bots = input.botLogins ?? [];
  const jiraMe = input.jira?.me ?? null;

  const prStates: PrStateCache = input.prStates ?? {};
  /**
   * The ticket a PR names when the INVENTORY no longer does. R29's filter is
   * already applied at fetch time for the cache (the resolver is given the
   * same `projectKeys`), so this only has to honour "linking disabled".
   */
  const cachedTicketKeyOf = (repo: string, number: number): string | undefined =>
    input.projectKeys.length === 0 ? undefined : prStates[prStateKey(repo, number)]?.ticketKeys[0];

  const byId = new Map<WorkItemId, Candidate>();
  const candidateOfPr = new Map<string, Candidate>();
  const candidateOfTicket = new Map<string, Candidate>();

  const candidate = (id: WorkItemId, seed: Partial<Candidate> = {}): Candidate => {
    const existing = byId.get(id);
    if (existing !== undefined) return existing;
    const created: Candidate = {
      id,
      ticketKey: null,
      ticket: null,
      prs: [],
      agents: [],
      contributors: [],
      sessionTitle: null,
      ...seed,
    };
    byId.set(id, created);
    return created;
  };

  const ticketCandidate = (key: string): Candidate => {
    const existing = candidateOfTicket.get(key);
    if (existing !== undefined) return existing;
    // R28's second half: a key the JQL never returned may still have been
    // fetched individually into `seeded`. It describes the row and NOTHING
    // else — step 1 makes candidates out of `issues` alone, so a stale
    // seeded key can never invent a ticket item.
    const issue =
      input.jira?.issues.find((i) => i.key === key) ?? input.jira?.seeded?.find((i) => i.key === key) ?? null;
    // R28: a candidate seeded from the LINK carries the key alone, and the
    // tab fills the rest on demand. Seeding from the snapshot only would let
    // an item's id flip the moment Jira goes down or a ticket leaves the JQL.
    const ticket: WorkItemTicket =
      issue !== null
        ? {
            key: issue.key,
            summary: issue.summary,
            status: issue.status,
            statusCategory: issue.statusCategory,
            url: issue.url,
            assignee: issue.assignee,
            updatedAt: issue.updated,
          }
        : {
            key,
            summary: '',
            status: '',
            statusCategory: '',
            url: input.jiraSiteUrl !== undefined ? `${input.jiraSiteUrl.replace(/\/+$/, '')}/browse/${key}` : '',
            assignee: null,
            updatedAt: '',
          };
    const created = candidate(workItemIdOf({ kind: 'ticket', key }), { ticketKey: key, ticket });
    candidateOfTicket.set(key, created);
    return created;
  };

  // ---- step 1: one candidate per Jira issue -------------------------------
  for (const issue of input.jira?.issues ?? []) ticketCandidate(issue.key);

  // R61's "or a session of ours references the ticket" needs to be known
  // BEFORE step 2 decides whether a merge would produce a mine item.
  const sessionTicketKeys = new Set<string>();
  for (const item of input.items) {
    if (item.mode === null) continue;
    const key = filteredTicket(item.links.ticket, input.projectKeys);
    if (key !== null) sessionTicketKeys.add(key);
  }

  // R61: the merge happens ONLY when the RESULTING ITEM would be mine, and
  // mine-ness is a property of the ticket, not of one PR — once any evidence
  // makes `HB-627` mine, every PR naming it belongs on that one row (MG-17).
  // Two TEAMMATES' PRs naming one key stay two items: merging them hides one
  // behind the other and makes "how many file changes" meaningless, and in
  // the parking lot the user is choosing between PRs to READ.
  const keyOfEntry = (e: InventoryEntry): string | undefined =>
    input.projectKeys.length === 0 ? undefined : e.ticketKeys[0];
  const mineTicketKeys = new Set<string>(sessionTicketKeys);
  for (const issue of input.jira?.issues ?? []) {
    if (jiraMe !== null && issue.assignee === jiraMe) mineTicketKeys.add(issue.key);
  }
  for (const e of input.inventory?.entries ?? []) {
    const key = keyOfEntry(e);
    if (key !== undefined && e.isMine) mineTicketKeys.add(key);
  }
  // A PR a session of ours names is by definition work of ours, so the ticket
  // its title carries is mine too — this is what keeps `HB-1489 #2180` ONE
  // row after the PR merged and left the inventory with its `ticketKeys`.
  for (const item of input.items) {
    const { prRepo, prNumber } = item.links;
    if (prRepo === null || prNumber === null) continue;
    const key = cachedTicketKeyOf(prRepo, prNumber);
    if (key !== undefined) mineTicketKeys.add(key);
  }

  // ---- steps 1-2: a candidate per inventory entry, merged into its ticket -
  for (const e of input.inventory?.entries ?? []) {
    const key = keyOfEntry(e);
    const cand =
      key !== undefined && mineTicketKeys.has(key)
        ? ticketCandidate(key)
        : candidate(workItemIdOf({ kind: 'pr', repo: e.repo, number: e.number }));
    cand.prs.push(prFromEntry(e));
    candidateOfPr.set(prKeyOf(e.repo, e.number), cand);
  }

  // ---- step 3: attach every agent ----------------------------------------
  for (const item of input.items) {
    if (item.mode === null) continue;
    const { prRepo, prNumber, prUrl, ticket } = item.links;
    let cand: Candidate | undefined;
    if (prRepo !== null && prNumber !== null) {
      cand = candidateOfPr.get(prKeyOf(prRepo, prNumber));
      if (cand === undefined) {
        // R25: a merged or closed PR still under review. The item stays
        // kind 'pr' and does NOT silently become a session item under the
        // user — its id must not change.
        //
        // R28's other half: the PR↔ticket link ALSO comes from the session's
        // own `lineage.ticket` and from the pr-state cache (parsed out of the
        // PR title at fetch time). Without it a merged PR renders as a PR row
        // with no ticket, which is the "it doesn't show the jira ticket" bug:
        // the inventory row that carried `ticketKeys` left with the PR.
        // The CACHE first, and on its own merits: its `ticketKeys` were
        // parsed from the PR's branch and title exactly as the inventory
        // parses an open PR's, so a merged PR keeps its ticket with no
        // dependence on a session at all. The session's `lineage.ticket` is
        // an additive second source, for a PR the leg has not resolved yet.
        const key =
          cachedTicketKeyOf(prRepo, prNumber) ?? filteredTicket(ticket, input.projectKeys) ?? null;
        cand =
          key !== null && mineTicketKeys.has(key)
            ? ticketCandidate(key)
            : candidate(workItemIdOf({ kind: 'pr', repo: prRepo, number: prNumber }));
        cand.prs.push(prFromAgentLinks(prRepo, prNumber, prUrl, prStates[prStateKey(prRepo, prNumber)]));
        candidateOfPr.set(prKeyOf(prRepo, prNumber), cand);
      }
    } else {
      const key = filteredTicket(ticket, input.projectKeys);
      cand = key !== null ? ticketCandidate(key) : candidate(workItemIdOf({ kind: 'session', id: item.id }));
    }
    cand.agents.push({
      sessionId: item.id,
      repo: item.repoOrContext === '' ? null : item.repoOrContext,
      mode: item.mode,
      phase: item.stageStatus ?? '',
      running: item.running,
      needsYou: item.attention.needsYou,
      claimed: item.claimed,
      primaryArtifact: item.links.primaryArtifact,
      worktreePath: item.links.worktreePath,
      ref: item.ref,
    });
    cand.contributors.push(item);
    cand.sessionTitle ??= item.title;
  }

  // ---- step 3b: the cache DECORATES; it never creates an item -----------
  // A landed PR whose session has ENDED has no attention item of its own and
  // no inventory row, so nothing above would ever mention it. It is attached
  // to its ticket's item when that item already exists — and only then: a
  // cache that could seed candidates would resurrect every PR ever merged,
  // and "an item whose only reason to exist was the merged PR leaves every
  // list" is exactly the behaviour the user asked for.
  for (const [key, cached] of Object.entries(prStates)) {
    if (!isLandedState(cached.state)) continue;
    if (candidateOfPr.has(key)) continue;
    const match = PR_CACHE_KEY.exec(key);
    if (match === null) continue;
    const ticketKey = input.projectKeys.length === 0 ? undefined : cached.ticketKeys[0];
    const cand = ticketKey === undefined ? undefined : candidateOfTicket.get(ticketKey);
    if (cand === undefined) continue;
    cand.prs.push(prFromCache(match[1], Number(match[2]), cached));
    candidateOfPr.set(key, cand);
  }

  // An AttentionItem with `mode === null` — the `source: 'pr'` row the
  // pre-dedupe list now preserves — contributes its attention and its ref to
  // the PR's candidate and creates no item of its own.
  for (const item of input.items) {
    if (item.mode !== null) continue;
    const { prRepo, prNumber } = item.links;
    if (prRepo === null || prNumber === null) continue;
    candidateOfPr.get(prKeyOf(prRepo, prNumber))?.contributors.push(item);
  }

  // ---- step 4: shape and membership --------------------------------------
  // Step 5's ORDER is per list and lives in `workListsOf`: one array cannot
  // carry four different orders at once, so `items` is a set keyed by id and
  // `lists` carries the order (spec §4.3).
  const items = [...byId.values()].map((cand) => finish(cand, { meLower, bots, jiraMe, input }));
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

interface FinishContext {
  meLower: string;
  bots: readonly string[];
  jiraMe: string | null;
  input: GroupWorkItemsInput;
}

function finish(cand: Candidate, ctx: FinishContext): WorkItem {
  const prs = [...cand.prs].sort((a, b) => compareNullableDesc(a.updatedAt, b.updatedAt) || a.number - b.number);
  const agents = [...cand.agents].sort(
    (a, b) => (MODE_RANK[a.mode] ?? 99) - (MODE_RANK[b.mode] ?? 99) || a.sessionId.localeCompare(b.sessionId),
  );

  const kind: WorkItemKind =
    cand.ticket !== null ? (prs.length > 0 ? 'pr+ticket' : 'ticket') : prs.length > 0 ? 'pr' : 'session';

  const lists = membership(prs, agents, cand.ticket, ctx);
  const demoted = prs.some((pr) => someoneIsOnIt(pr));
  const parkingLotGroup: ParkingLotGroup | null = !lists.includes('parkingLot')
    ? null
    : agents.some((a) => a.mode === 'review')
      ? 'reviewing'
      : demoted
        ? 'someoneOnIt'
        : 'untouched';

  const reasons: AttentionReason[] = [];
  for (const reason of ATTENTION_REASONS) {
    if (cand.contributors.some((c) => c.attention.reasons.includes(reason))) reasons.push(reason);
  }
  const sinceCandidates = cand.contributors.map((c) => c.attention.since).sort();
  const refs = cand.contributors.map((c) => c.ref);
  // R3: an ack keyed to the VIEW would silently un-ack when the view changes
  // shape, so the item is acked only when every contributing ref is.
  const acked = cand.contributors.length > 0 && cand.contributors.every((c) => c.attention.acked);

  return {
    id: cand.id,
    kind,
    lists,
    demoted,
    parkingLotGroup,
    title: labelOf(cand, prs, lists),
    prs,
    ticket: cand.ticket,
    agents,
    needsYou:
      agents.some((a) => a.needsYou) ||
      cand.contributors.some(
        (c) => c.mode === null && c.attention.needsAttention && c.attention.reasons.some((r) => NEEDS_YOU_REASONS.includes(r)),
      ),
    // Overlaid by WorkItemService from the dismissal store; the grouping
    // itself has no I/O and therefore no opinion about it.
    dismissed: false,
    dismissedAt: null,
    attention: { reasons, since: sinceCandidates[0] ?? '', acked, refs },
  };
}

/**
 * R47: `open(pr)` is `isDraft !== true` (R57), NOT `=== false` — an unknown
 * draft state is treated as not-a-draft.
 *
 * Plus the state test: a MERGED or CLOSED PR is not open work. A `null`
 * state (the leg has not resolved it yet) is deliberately NOT landed — an
 * unresolved PR keeps behaving exactly as it did before this field existed.
 */
const open = (pr: WorkItemPr): boolean => pr.isDraft !== true && !isLandedState(pr.state);

/**
 * "The code is in." An item every one of whose PRs has merged or closed —
 * the ticket may well still be live, which is why this SINKS a row rather
 * than hiding it.
 */
export function isLanded(item: WorkItem): boolean {
  return item.prs.length > 0 && item.prs.every((pr) => isLandedState(pr.state));
}

/** The one secondary key every list order carries, ahead of its own: landed work sits below live work. */
function byLanded(a: WorkItem, b: WorkItem): number {
  return Number(isLanded(a)) - Number(isLanded(b));
}

/**
 * R47.1 REVERSED (gh#2125, coordinator ruling): a pending review request —
 * to a user OR a team slug — never contributes to "someone is on it". A
 * live false positive demoted a PR purely because it carried open team
 * review requests with zero human activity: `reviewRequests` mixes user
 * logins and team slugs with no marker distinguishing them, and treating an
 * unclaimed team request as "somebody is already on it" is backwards —
 * nobody named has picked it up yet. `reviewRequests` still drives R30
 * ("requested of me -> parking lot regardless") and display; only actual
 * human review/comment activity (`humanActivity.lastAt`) demotes.
 */
function someoneIsOnIt(pr: WorkItemPr): boolean {
  return (pr.humanActivity?.lastAt ?? null) !== null;
}

function membership(
  prs: readonly WorkItemPr[],
  agents: readonly WorkItemAgent[],
  ticket: WorkItemTicket | null,
  ctx: FinishContext,
): WorkListKind[] {
  const { meLower, input } = ctx;
  const watch = new Set(input.watchAuthors.map((a) => a.toLowerCase()));
  const lists: WorkListKind[] = [];

  // R47's isMine exclusion is a property of the ITEM, not of one `prs[]`
  // entry. R61 merges a PR into a ticket candidate ONLY when the result would
  // be MINE, so a row can hold a teammate's PR and still be my work: my ticket
  // with their PR on it, or my PR beside theirs. Reading the exclusion per PR
  // put such a row in `parkingLot` AND `waitingForReview`, which MG-17 requires
  // to be disjoint, and let `labelOf` relabel my ticket row after their PR.
  // The coordinator override is untouched: a teammate's PR carrying a review
  // agent of ours has neither a PR of mine nor a ticket of mine, so it stays.
  const itemIsMine =
    prs.some((pr) => pr.isMine === true) ||
    (ticket !== null && ctx.jiraMe !== null && ticket.assignee === ctx.jiraMe);

  const inParkingLot =
    !itemIsMine &&
    (prs.some(
      (pr) =>
        open(pr) &&
        pr.isMine !== true &&
        // showAllRepoPrs drops the watchAuthors clause; the isMine exclusion
        // is NEVER dropped (MG-2 — this is the 58-row regression).
        (input.showAllRepoPrs ||
          (pr.author !== null && watch.has(pr.author.toLowerCase())) ||
          // R30: a review requested from ME outranks the watch list.
          (pr.reviewRequests ?? []).some((r) => r.toLowerCase() === meLower)),
    ) ||
    // R57's totality disjunct: a MERGED or closed teammate PR that still
    // carries our review agent is still listed. It drops the state test but
    // KEEPS the draft test — R47's "open PRs, not drafts" holds whether or
    // not we have an agent on it.
      (prs.some((pr) => pr.isMine !== true && pr.isDraft !== true) && agents.some((a) => a.mode === 'review')));
  if (inParkingLot) lists.push('parkingLot');

  if (prs.some((pr) => pr.isMine === true && open(pr))) lists.push('waitingForReview');

  // R49: literally "the sessions I only have investigation for" — no PR, no
  // ticket, investigation agents only. A ticket-linked investigation is a
  // commitment to deliver, which is myWork.
  const inInvestigations =
    prs.length === 0 && ticket === null && agents.length > 0 && agents.every((a) => a.mode === 'investigation');
  if (inInvestigations) lists.push('investigations');

  const inMyWork =
    !inInvestigations &&
    ((ticket !== null && ctx.jiraMe !== null && ticket.assignee === ctx.jiraMe) ||
      // A draft is in NO list (R47), mine included: `open()` gates the
      // PR clause here too, so a draft own PR appears only once it carries an
      // agent of ours (R57's invariant) or its ticket is assigned to me.
      prs.some((pr) => pr.isMine === true && open(pr)) ||
      // R48 (coordinator override): a review agent NEVER routes an item into
      // myWork. A teammate's PR we are reviewing is a teammate's PR, and it
      // belongs at the top of the parking lot.
      agents.some((a) => a.mode !== 'review'));
  if (inMyWork) lists.push('myWork');

  return lists;
}

/** R13, plus R47's one addition. */
function labelOf(cand: Candidate, prs: readonly WorkItemPr[], lists: readonly WorkListKind[]): string {
  const primary = prs[0];
  const prLabel =
    primary === undefined
      ? null
      : primary.title === null || primary.title === ''
        ? `${primary.repo}#${primary.number}`
        : `${primary.repo}#${primary.number} — ${primary.title}`;
  // R47: in the parking lot the user is choosing between PRs to READ, and
  // `repo#n` is how a PR is named everywhere else. The ticket key is still
  // shown, as a chip.
  if (lists.includes('parkingLot') && prLabel !== null) return prLabel;
  if (cand.ticket !== null) {
    return cand.ticket.summary === '' ? cand.ticket.key : `${cand.ticket.key} — ${cand.ticket.summary}`;
  }
  if (prLabel !== null) return prLabel;
  return cand.sessionTitle ?? cand.id;
}

// ---------------------------------------------------------------------------
// Ordering. Every comparator is total and stable, a missing key sorts LAST,
// and ties break on `id`, so `cgremlin-core` and any future client agree.
// ---------------------------------------------------------------------------

function compareNullableAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function compareNullableDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

const createdAtOf = (item: WorkItem): string | null => item.prs[0]?.createdAt ?? null;

/** The newest of the item's PR `updatedAt`s, its ticket's `updated` and its agents' attention age. */
function recencyOf(item: WorkItem): string | null {
  let newest: string | null = null;
  const bump = (value: string | null | undefined): void => {
    if (value === null || value === undefined || value === '') return;
    if (newest === null || value > newest) newest = value;
  };
  for (const pr of item.prs) bump(pr.updatedAt);
  bump(item.ticket?.updatedAt);
  bump(item.attention.since);
  return newest;
}

const GROUP_ORDER: readonly ParkingLotGroup[] = ['reviewing', 'untouched', 'someoneOnIt'];

/**
 * Step 5's DEFAULT orders. The core returns every list in its default order
 * and that order is total, deterministic and stable (a missing key sorts
 * LAST, ties break on `id`), so `cgremlin-core` and any future client agree;
 * the extension may re-sort with the user's selection, which is presentation.
 */
function byCreatedAtAscending(a: WorkItem, b: WorkItem): number {
  return byLanded(a, b) || compareNullableAsc(createdAtOf(a), createdAtOf(b)) || a.id.localeCompare(b.id);
}

function byNeedsYouThenRecent(a: WorkItem, b: WorkItem): number {
  const landed = byLanded(a, b);
  if (landed !== 0) return landed;
  if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
  return compareNullableDesc(recencyOf(a), recencyOf(b)) || a.id.localeCompare(b.id);
}

function byRecency(a: WorkItem, b: WorkItem): number {
  return byLanded(a, b) || compareNullableDesc(recencyOf(a), recencyOf(b)) || a.id.localeCompare(b.id);
}

/** The per-list id arrays the wire carries (spec §4.3), derived from the SAME `lists`/`parkingLotGroup` the items carry. */
export interface WorkLists {
  parkingLot: { reviewing: WorkItemId[]; untouched: WorkItemId[]; someoneOnIt: WorkItemId[] };
  myWork: WorkItemId[];
  investigations: WorkItemId[];
  waitingForReview: WorkItemId[];
}

export const WORK_LIST_KINDS: readonly WorkListKind[] = [
  'parkingLot',
  'myWork',
  'investigations',
  'waitingForReview',
];

export function workListsOf(items: readonly WorkItem[]): WorkLists {
  const inList = (list: WorkListKind): WorkItem[] => items.filter((i) => i.lists.includes(list));
  const parking = inList('parkingLot');
  const group = (name: ParkingLotGroup): WorkItemId[] =>
    parking
      .filter((i) => i.parkingLotGroup === name)
      // The parking lot's sort is applied WITHIN each group and never across
      // them; inside 'reviewing', a review that wants me outranks an old one.
      .sort(
        (a, b) =>
          byLanded(a, b) ||
          (name === 'reviewing' && a.needsYou !== b.needsYou
            ? a.needsYou
              ? -1
              : 1
            : byCreatedAtAscending(a, b)),
      )
      .map((i) => i.id);
  return {
    parkingLot: { reviewing: group('reviewing'), untouched: group('untouched'), someoneOnIt: group('someoneOnIt') },
    myWork: inList('myWork').sort(byNeedsYouThenRecent).map((i) => i.id),
    investigations: inList('investigations').sort(byRecency).map((i) => i.id),
    waitingForReview: inList('waitingForReview').sort(byCreatedAtAscending).map((i) => i.id),
  };
}

/** The parking lot's three groups, concatenated in their fixed order — what a flat renderer walks. */
export function parkingLotOrder(lists: WorkLists): WorkItemId[] {
  return GROUP_ORDER.flatMap((name) => lists.parkingLot[name]);
}
