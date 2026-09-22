/**
 * The side panel, as a `WebviewViewProvider` (R54).
 *
 * It replaces the old tree provider outright: a tree cannot render two-line card rows, badges,
 * a collapsible group or an inline sort control. What it owns is *view* state — which rows are
 * expanded, which groups are collapsed, which sort each list is on (persisted through the host's
 * `globalState`, R64) — and nothing else. **Membership, grouping and `demoted` are the core's
 * answer** (D2): the panel reads `item.lists` and `item.parkingLotGroup` and renders them.
 *
 * Row content crosses the message channel as *data*, never as markup, so there is no HTML built
 * here at all: the script sets every string with `textContent` (MG-B7). The script and the
 * stylesheet arrive as injected text (R62), so this module reads no file.
 *
 * Takes its editor surface as a parameter (no editor import).
 */
import crypto from 'node:crypto';
import { changeSummary, type SessionChanges } from '../model/changes';
import { detailSignatureOf, lifecycleSlots } from '../model/lifecycle';
import { itemParts } from '../model/item-parts';
import { prFactLines, ticketLineOf, verdictView, type RowVerdict } from '../model/row-composition';
import { readTitle } from '../model/item-title';
import { itemActionFacts, rowActions } from '../model/row-actions';
import {
  buildItemChildren,
  buildWorkLists,
  isDismissed,
  readCollapsed,
  readFocus,
  readShowDismissed,
  readSort,
  readSorts,
  ticketBanner,
  toRow,
  withPendingStart,
  writeCollapsed,
  writeFocus,
  writeShowDismissed,
  writeSort,
  COLLAPSE_STATE_KEY,
  DISMISSED_SECTION_GLYPH,
  DISMISSED_SECTION_KEY,
  DISMISSED_SECTION_TITLE,
  FOCUS_ALL,
  PANEL_SECTIONS,
  type CollapseState,
  type ItemsResponse,
  type WorkAgentMode,
  type WorkChild,
  type WorkItem,
  type WorkListKind,
  type WorkRow,
  type WorkSortKind,
} from '../model/work-items';
import {
  parsePanelMessage,
  type HostToPanel,
  type PanelActionView,
  type PanelChangesView,
  type PanelFocusOption,
  type PanelPartView,
  type PanelRowView,
  type PanelSectionView,
  type PanelState,
  type PanelNoticeView,
} from '../model/panel-protocol';
import {
  troubleActionLabel,
  troubleCommand,
  troubleMessage,
  troubleSecondary,
  type EngineTrouble,
  type SourceTrouble,
} from '../model/engine-trouble';
import { badgeTooltip, needsYouEntries } from '../model/needs-you';
import { cspFor } from './item-tab';
import type {
  DisposableLike,
  Host,
  WebviewViewLike,
  WebviewViewProviderLike,
} from './host';

/** Must match `contributes.views`, which now carries `"type": "webview"` (R54). */
export const PANEL_VIEW_ID = 'cgremlin.items';

export interface PanelViewDeps {
  host: Host;
  /** R62: the bundled script and the stylesheet, as text. */
  assets: { scriptText: string; styleText: string };
  /** The extension's asset directory, for `localResourceRoots` alone. */
  mediaPath: string;
  onOpenItem: (id: string) => void | Promise<void>;
  onOpenChild: (id: string, childId: string) => void | Promise<void>;
  onCommand: (command: string, id: string, childId?: string) => void | Promise<void>;
  /**
   * One click on a row is one decision (§4, amended): select, expand, and put the item's own
   * worktree in the workspace. The first two are this module's own state; the swap is the host's,
   * so it arrives as a callback rather than as a second editor surface here.
   */
  onSelect?: (id: string) => void | Promise<void>;
  /**
   * What an expanded row needs and a list response does not carry: the artifact times behind each
   * slot's `done`, and "changes so far". Optional — a panel with no loader paints `—`.
   */
  loadExpanded?: (item: WorkItem) => Promise<ExpandedDetail | null>;
  nonce?: () => string;
  now?: () => number;
  /**
   * Phase 15 §8: the repos with a `qa.url` (`model/items.qaReposOf` over `GET /config`). A
   * thunk, because the config resolves after the panel is constructed — and an empty answer
   * simply means the two QA verbs are not offered yet.
   */
  qaRepos?: () => readonly string[];
  /** Phase 18 — `jira.qaStatuses` (`model/items.qaStatusesOf`), for the same gate's other half. */
  qaStatuses?: () => readonly string[];
  /**
   * Round 3 §e.9 — the user's own login (`CoreConfigView.me`), through the same thunk pattern
   * `qaRepos` uses: the config resolves after the panel is constructed, and an empty answer
   * simply means the people line keeps every handle, exactly as it did before.
   */
  me?: () => string;
}

/** The extra the detail routes carry for the ONE expanded row (§4, amended). */
export interface ExpandedDetail {
  /** The latest artifact time per session id, for a slot's `done · 2h`. */
  artifactAt: Record<string, string | null>;
  changes: SessionChanges | null;
  /**
   * Round 3 §e.1 — the primary artifact of the agent whose conclusion the row is reporting, as
   * TEXT. The parse is the model's (`verdictView`); the host only fetches. Absent means there was
   * nothing to fetch, which says nothing at all — `unreadable` is the different case where the
   * report exists and did not arrive.
   */
  artifact?: { mode: string; text: string | null; unreadable: boolean } | null;
  /**
   * Ruling 3 — the engine's OWN answer to "has the PR moved since the agent looked"
   * (`InventoryEntry.ours.newCommits`, `core/src/inventory/inventory.ts:153`). Never re-derived
   * here: a second derivation of a freshness bit is how two surfaces come to disagree.
   */
  newCommits?: boolean;
  /**
   * P11: the read found no engine on the socket. The row still opens — everything it shows comes
   * out of the snapshot — and the block carries one line saying the detail is the last one that
   * loaded. Any OTHER failure (a 404 from an engine with no such route) is not this: it paints
   * `—` and says nothing, exactly as it always did.
   */
  offline?: boolean;
}

export const SELECTED_STATE_KEY = 'cgremlin.panel.selected';

/**
 * How many `/items` frames an unconfirmed start survives. Two: one frame can
 * legitimately predate the session the engine has just created, and by the
 * third the panel would be asserting something nobody has corroborated.
 */
const PENDING_START_FRAMES = 2;
/** P2: which headers the user has closed, lists and parking-lot groups alike (R64). */
export const COLLAPSED_STATE_KEY = COLLAPSE_STATE_KEY;
export const EXPANDED_STATE_KEY = 'cgremlin.panel.expanded';
/**
 * P10: "Not now", remembered for good. The offer to open the managed workspace used to be a popup
 * on every row click; the notice that replaces it is dismissed once, in the host's global state,
 * and only `cgremlin.openManagedWorkspace` brings it back — the user asking for it again.
 */
export const WORKSPACE_NOTICE_DISMISSED_KEY = 'cgremlin.panel.workspaceNoticeDismissed';
export const OPEN_MANAGED_COMMAND = 'cgremlin.openManagedWorkspace';
export const MANAGED_WORKSPACE_HINT =
  'Open the cgremlin workspace to follow the code in the editor';
/** P11: the one line an expanded row gains when there is no engine to re-read it from. */
export const OFFLINE_DETAIL = 'Engine offline — showing what was last loaded';
const OPEN_MANAGED_LABEL = 'Open';
const DISMISS_LABEL = 'Not now';
/**
 * What the panel says when it could not build its own state. The sentence names the two ways out
 * and nothing else: the exception's own text is ours, not the user's, so it goes to the log.
 */
export const PANEL_RENDER_FAILURE =
  'cgremlin could not draw your work. The log says what went wrong, and reloading the window is ' +
  'the way back.';

export class PanelView implements WebviewViewProviderLike {
  private view: WebviewViewLike | null = null;
  private subscription: DisposableLike | null = null;
  private ready = false;
  private response: ItemsResponse | null = null;
  private trouble: EngineTrouble | null = null;
  /** The engine answered, but not with work items (a 404 from an older engine, or worse). */
  private sourceTrouble: SourceTrouble | null = null;
  private connected = false;
  /** Accordion: at most one row is open, and it survives a reload (§4, amended). */
  private expandedId: string | null;
  private selectedId: string | null;
  private detail: { id: string; detail: ExpandedDetail } | null = null;
  private loading: string | null = null;
  /** What the open row looked like when its detail was last asked for (§3.3's storm guard). */
  private detailSignature: string | null = null;
  /** An engine frame named the open row, or one of its sessions, since the last read. */
  private detailStale = false;
  /** §5: which of the six sections the user has closed, by section key. */
  private collapsed: CollapseState;
  /** The swap asked for the managed workspace and could not do it itself (P10). */
  private offerManaged = false;
  private noticeDismissed: boolean;
  /** §6: `all`, or the one section key the panel is narrowed to (R64). */
  private focus: string;
  /** Item 2: whether the bin is open. Persisted, because it is a way of working (R64). */
  private showDismissed: boolean;
  /**
   * Item 2's optimism: what THIS window has just asked the engine to dismiss (or restore), until
   * the engine's own answer arrives and agrees. A click has to move the row now — the refresh is
   * a round trip away — and a request that fails has to move it back, which is what this remembers.
   */
  private readonly pendingDismissal = new Map<string, boolean>();
  /**
   * The same optimism for a START. The user clicked `Start review`, the engine
   * accepted it, and the row silently moved to another section with nothing
   * saying the work had begun — "nothing happened". Until `/items` carries the
   * real agent, the row wears a pending one of that mode.
   *
   * `frames` is the safety catch: an engine that accepted a start and then
   * never reported the session (it failed instantly, or the item changed
   * shape) must not leave the panel claiming something is running forever.
   */
  private readonly pendingStart = new Map<string, { mode: WorkAgentMode; frames: number }>();
  private sorts: Record<WorkListKind, WorkSortKind>;
  /** §3.3: `setConnected` + `setItems` + `setSourceTrouble` in one refresh are ONE post. */
  private batchDepth = 0;
  private batched = false;
  private lastPosted: string | null = null;

  constructor(private readonly deps: PanelViewDeps) {
    this.sorts = readSorts(deps.host);
    this.collapsed = readCollapsed(deps.host);
    this.selectedId = deps.host.getState<string>(SELECTED_STATE_KEY) ?? null;
    this.expandedId = deps.host.getState<string>(EXPANDED_STATE_KEY) ?? null;
    this.noticeDismissed = deps.host.getState<boolean>(WORKSPACE_NOTICE_DISMISSED_KEY) === true;
    this.focus = readFocus(deps.host);
    this.showDismissed = readShowDismissed(deps.host);
  }

  /**
   * Item 2: the row leaves (or rejoins) its section on the click, not on the refresh that follows.
   * The engine is still the owner — this only holds the gap, and `setItems` drops each entry the
   * moment the engine says the same thing.
   */
  setPendingDismissal(id: string, dismissed: boolean): void {
    this.pendingDismissal.set(id, dismissed);
    this.render();
  }

  /**
   * A start this window has just had accepted. The row shows the stage
   * `running` at once, and `setItems` hands it back to the wire the moment the
   * engine names the real session.
   */
  setPendingStart(id: string, mode: WorkAgentMode): void {
    this.pendingStart.set(id, { mode, frames: 0 });
    this.render();
  }

  /** The start was refused (or never left): the panel stops claiming it began. */
  clearPendingStart(id: string): void {
    if (!this.pendingStart.delete(id)) return;
    this.render();
  }

  /** The request failed: the panel stops claiming something the engine never accepted. */
  clearPendingDismissal(id: string): void {
    if (!this.pendingDismissal.delete(id)) return;
    this.render();
  }

  private dismissedFor(item: WorkItem): boolean {
    return this.pendingDismissal.get(item.id) ?? isDismissed(item);
  }

  /** The swap's report: this window is not the managed workspace, so the notice is owed. */
  setWorkspaceOffer(offer: boolean): void {
    if (this.offerManaged === offer) return;
    this.offerManaged = offer;
    this.render();
  }

  /** The command ran, so the user has said what "Not now" once said the opposite of. */
  clearWorkspaceNoticeDismissal(): void {
    if (!this.noticeDismissed) return;
    this.noticeDismissed = false;
    void this.deps.host.setState(WORKSPACE_NOTICE_DISMISSED_KEY, false);
    this.render();
  }

  /** Shown at most once per window, and never again after a "Not now" (P10). */
  private noticeView(): PanelNoticeView | null {
    if (!this.offerManaged || this.noticeDismissed) return null;
    return {
      message: MANAGED_WORKSPACE_HINT,
      actionLabel: OPEN_MANAGED_LABEL,
      command: OPEN_MANAGED_COMMAND,
      dismissLabel: DISMISS_LABEL,
    };
  }

  /**
   * Everything one refresh changes, as one render. Three posts per refresh is three reconciles
   * in the webview and three chances for the order to move under the pointer (§3.3).
   */
  batch(apply: () => void): void {
    this.batchDepth += 1;
    try {
      apply();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batched) {
        this.batched = false;
        this.flush();
      }
    }
  }

  /** The editor creates the view; a re-created one re-posts `ready` and gets a fresh render. */
  resolveWebviewView(view: WebviewViewLike): void {
    this.subscription?.dispose();
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.deps.mediaPath],
    };
    view.webview.html = this.html();
    this.subscription = view.webview.onDidReceiveMessage((raw) => {
      void this.handle(raw);
    });
    view.onDidDispose(() => {
      this.subscription?.dispose();
      this.subscription = null;
      this.view = null;
      this.ready = false;
    });
  }

  setItems(response: ItemsResponse | null): void {
    this.response = response;
    // An optimistic flag outlives exactly one round trip: the moment the engine's own answer says
    // the same thing (or the item is gone), the panel goes back to reading the wire.
    for (const [id, dismissed] of [...this.pendingDismissal]) {
      const item = response?.items.find((candidate) => candidate.id === id);
      if (item === undefined || isDismissed(item) === dismissed) this.pendingDismissal.delete(id);
    }
    // The same rule for a start: the engine's own agent supersedes the
    // optimistic one, and a start the engine never reports is given a few
    // frames and then dropped rather than left claiming forever.
    for (const [id, pending] of [...this.pendingStart]) {
      const item = response?.items.find((candidate) => candidate.id === id);
      const real = item?.agents.some((agent) => agent.mode === pending.mode) === true;
      if (item === undefined || real || pending.frames >= PENDING_START_FRAMES) {
        this.pendingStart.delete(id);
      } else {
        this.pendingStart.set(id, { ...pending, frames: pending.frames + 1 });
      }
    }
    this.refreshDetail();
    this.render();
  }

  /**
   * An engine frame that names the open row, or one of its sessions. `artifact.changed` is the
   * case a snapshot comparison cannot see — an artifact is rewritten with no field of the item
   * moving, and that artifact's time is exactly what dates a slot's `done`.
   */
  noteFrame(itemId: string | null, sessionId: string | null): void {
    const id = this.expandedId;
    if (id === null) return;
    if (itemId !== null && itemId === id) {
      this.detailStale = true;
      return;
    }
    if (sessionId === null) return;
    if (this.itemOf(id)?.agents.some((agent) => agent.sessionId === sessionId) === true) {
      this.detailStale = true;
    }
  }

  /**
   * Every SSE frame schedules a refresh, so a burst about somebody else's PR would otherwise cost
   * two engine round trips per frame for a row that did not move. The open row is re-read only
   * when what its detail is built from actually changed, or when a frame named it.
   */
  private refreshDetail(): void {
    const id = this.expandedId;
    if (id === null) return;
    const item = this.itemOf(id);
    if (item === undefined) return;
    const signature = detailSignatureOf(item);
    if (!this.detailStale && signature === this.detailSignature) return;
    this.detailStale = false;
    this.detailSignature = signature;
    this.loadDetail();
  }

  setTrouble(trouble: EngineTrouble | null): void {
    this.trouble = trouble;
    this.render();
  }

  /**
   * An engine that cannot answer `GET /items`. Shown only when the engine itself is not already
   * in trouble — one explanation at a time, and the engine's own is the more fundamental.
   */
  setSourceTrouble(trouble: SourceTrouble | null): void {
    this.sourceTrouble = trouble;
    this.render();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.render();
  }

  items(): WorkItem[] {
    return (this.response?.items ?? []).map((item) => this.withOptimism(item));
  }

  itemOf(id: string): WorkItem | undefined {
    const found = this.response?.items.find((item) => item.id === id);
    return found === undefined ? undefined : this.withOptimism(found);
  }

  /** The one place this window's in-flight start is folded onto an item. */
  private withOptimism(item: WorkItem): WorkItem {
    const pending = this.pendingStart.get(item.id);
    return pending === undefined ? item : withPendingStart(item, pending.mode);
  }

  childOf(id: string, childId: string): WorkChild | undefined {
    const item = this.itemOf(id);
    return item === undefined
      ? undefined
      : buildItemChildren(item).find((child) => child.id === childId);
  }

  state(): PanelState {
    const trouble = this.troubleView();
    const all = this.sections();
    // P11: a trouble row REPLACES the lists only when there are no lists to replace. An engine
    // that died did not delete the work — the last snapshot is still true, its rows still expand
    // from it, and the external links in them (a PR, a Jira page) never needed an engine at all.
    const keepsLists = trouble === null || all.some((section) => section.rows.length > 0);
    const sections = keepsLists ? all : [];
    // §6: the control lists every area with its count; the panel paints only the focused one,
    // so the keyboard cannot reach a row that is not on screen.
    const shown =
      this.focus === FOCUS_ALL ? sections : sections.filter((s) => s.key === this.focus);
    // Item 2: the bin is not an area of the work, so it is not filtered by the focus — it is
    // drawn below whatever is on screen, and only while the toggle is on. It keeps the last
    // snapshot exactly as the lists do, and goes away with them when they go.
    const dismissed = keepsLists ? this.dismissedSection() : null;
    return {
      sections: this.showDismissed && dismissed !== null ? [...shown, dismissed] : shown,
      focus: this.focus,
      focusOptions: focusOptionsOf(sections),
      dismissedCount: dismissed?.count ?? 0,
      showDismissed: this.showDismissed,
      // P3: the strip survives a trouble state — what wants the user is still true while the
      // engine is explaining itself, and it is the one thing worth carrying across.
      needsYou: needsYouEntries(this.items()),
      banner:
        this.response === null
          ? null
          : ticketBanner(this.response.ticketSource, this.response.threadSource),
      trouble,
      notice: this.noticeView(),
      connected: this.connected,
    };
  }

  private troubleView(): PanelState['trouble'] {
    if (this.trouble !== null) {
      return {
        message: troubleMessage(this.trouble),
        command: troubleCommand(this.trouble),
        actionLabel: troubleActionLabel(this.trouble),
        secondary: troubleSecondary(this.trouble),
      };
    }
    if (this.sourceTrouble !== null) {
      return {
        message: this.sourceTrouble.message,
        command: this.sourceTrouble.command,
        actionLabel: this.sourceTrouble.actionLabel,
        secondary: null,
      };
    }
    return null;
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.view = null;
  }

  // --- internals -----------------------------------------------------------

  /**
   * §5 — the six sections, flat. `buildWorkLists` still answers per list (membership is the
   * core's, D2); this walks `PANEL_SECTIONS` and takes each one's rows out of the list it belongs
   * to, so the parking lot's three groups arrive as sections without the core knowing.
   */
  private sections(): PanelSectionView[] {
    if (this.response === null) return [];
    const built = buildWorkLists({
      response: { ...this.response, items: this.items() },
      sorts: this.sorts,
      now: this.deps.now?.(),
    });
    return PANEL_SECTIONS.map((spec, index) => {
      const list = built[spec.list];
      const source = list.sections.find((section) => section.group === spec.group);
      // A row this window has just dismissed leaves its section now; the engine's own lists
      // already exclude the ones it knows about (D2).
      const rows = (source?.rows ?? [])
        .filter((row) => !this.dismissedFor(row.item))
        .map((row) => this.rowView(row));
      return {
        key: spec.key,
        list: spec.list,
        group: spec.group,
        title: spec.title,
        glyph: spec.glyph,
        // What the header claims is what the section holds — the count IS the reason to open it,
        // and there is no second level underneath it left to hide anything (P1).
        count: rows.length,
        collapsed: this.collapsed[spec.key] ?? spec.collapsed,
        sort: list.sort,
        sorts: [...list.sorts],
        // One sort control per LIST, on the first section of it (the parking lot's three share
        // one sort, and three copies of one control is noise).
        showsSort: PANEL_SECTIONS.findIndex((other) => other.list === spec.list) === index,
        rows,
      };
    });
  }

  /**
   * Item 2's bin. Its rows come from `dismissed` — the core's own order, newest first — with
   * whatever this window has just put aside in front of it, because that is the newest of all.
   *
   * A dismissed item is NOT in any list, so there is no `WorkRow` to take: each one is built
   * against the first list it claims to belong to, which is what its row actions are a rule about.
   */
  private dismissedSection(): PanelSectionView | null {
    if (this.response === null) return null;
    const optimistic = [...this.pendingDismissal]
      .filter(([, dismissed]) => dismissed)
      .map(([id]) => id)
      .reverse();
    const ids = [...new Set([...optimistic, ...(this.response.dismissed ?? [])])];
    const now = this.deps.now?.() ?? Date.now();
    const rows = ids.flatMap((id) => {
      const item = this.itemOf(id);
      if (item === undefined || !this.dismissedFor(item)) return [];
      return [this.rowView(toRow(item, item.lists[0] ?? 'parkingLot', now))];
    });
    return {
      key: DISMISSED_SECTION_KEY,
      // Only so the section has one: it draws no sort control, and nothing it offers is a rule
      // about a list — a dismissed row's one action is to stop being dismissed.
      list: 'parkingLot',
      group: null,
      title: DISMISSED_SECTION_TITLE,
      glyph: DISMISSED_SECTION_GLYPH,
      count: rows.length,
      collapsed: this.collapsed[DISMISSED_SECTION_KEY] ?? false,
      sort: this.sorts.parkingLot,
      sorts: [],
      showsSort: false,
      rows,
    };
  }

  /** One write per toggle, so the next window opens on the panel the user left behind (R64). */
  private setCollapsed(key: string, collapsed: boolean): void {
    this.collapsed = { ...this.collapsed, [key]: collapsed };
    writeCollapsed(this.deps.host, this.collapsed);
    this.render();
  }

  private rowView(row: WorkRow): PanelRowView {
    const expanded = this.expandedId === row.id;
    const dismissed = this.dismissedFor(row.item);
    const actions = actionsFor(
      row.item, row.list, dismissed, this.deps.qaRepos?.() ?? [], this.deps.qaStatuses?.() ?? [],
    );
    // Item 1: the user's own title wins over everything derived, and the row says so — in the
    // accessible name here, and as a mark beside L2 in the webview.
    const own = readTitle(this.deps.host, row.item);
    const description = own === '' ? row.description : own;
    const label = [row.identity, description].filter((part) => part !== '').join(' — ');
    return {
      id: row.id,
      list: row.list,
      label: own === '' ? label : `${label} (your title)`,
      identity: row.identity,
      identityKeys: row.identityKeys,
      description,
      descriptionIsOwn: own !== '',
      badges: row.badges,
      chips: row.chips,
      age: row.age,
      size: row.size,
      ci: row.ci,
      meta: row.meta,
      tier: row.tier,
      demoted: row.demoted,
      dismissed,
      needsYou: row.needsYou,
      // Every row expands now: what it expands INTO is the three lifecycle slots, which exist
      // whether or not the item has a second part to name (§4, amended).
      hasChildren: true,
      expanded,
      selected: this.selectedId === row.id,
      // §4: the item's OWN parts, each already carrying only the buttons the list allows.
      parts: expanded ? this.partsOf(row, actions) : [],
      // Round 3 — the ANSWER, above every button, and only on the row that is open.
      verdict: expanded ? this.verdictOf(row) : null,
      facts: expanded ? prFactLines(row.item.prs[0], this.deps.me?.() ?? '') : [],
      ticketLine: expanded ? ticketLineOf(row.item.ticket) : '',
      changes: expanded ? this.changesView(row.id) : null,
      actions,
      // The notice again, where the user is actually looking — the open row, and only it.
      hint: expanded && this.noticeView() !== null ? MANAGED_WORKSPACE_HINT : null,
      detailNotice: expanded && this.detailOf(row.id)?.offline === true ? OFFLINE_DETAIL : null,
    };
  }

  /**
   * §4's parts. The lifecycle slots still say the state wording (`model/lifecycle`), and
   * `itemParts` decides which of them belong on THIS row in THIS list and hands each one the
   * buttons the row's own actions already allow — so a part can never offer a verb the row
   * refuses (P0-2).
   */
  private partsOf(row: WorkRow, actions: PanelActionView[]): PanelPartView[] {
    const detail = this.detailOf(row.id);
    const qaRepos = this.deps.qaRepos?.() ?? [];
    const qaStatuses = this.deps.qaStatuses?.() ?? [];
    const facts = itemActionFacts(row.item, qaRepos, qaStatuses);
    return itemParts({
      item: row.item,
      list: row.list,
      qaRepos,
      qaStatuses,
      me: this.deps.me?.() ?? '',
      slots: lifecycleSlots({
        agents: row.item.agents,
        facts,
        artifactAt: detail?.artifactAt,
        now: this.deps.now?.(),
      }),
      actions,
      now: this.deps.now?.(),
    });
  }

  /**
   * Round 3 §e.1 — the verdict block, or `null` for no block at all.
   *
   * Nothing is composed here: the fetched text and the engine's freshness bit go to the ONE
   * composer, which is also the only module allowed to decide that there is nothing to say.
   */
  private verdictOf(row: WorkRow): RowVerdict | null {
    const detail = this.detailOf(row.id);
    if (detail === null) return null;
    const artifact = detail.artifact ?? null;
    return verdictView({
      text: artifact?.text ?? null,
      unreadable: artifact?.unreadable === true,
      newCommits: detail.newCommits === true,
      mode: artifact?.mode ?? null,
    });
  }

  /** The detail held for `id`, or `null` — the one place the id guard is written. */
  private detailOf(id: string): ExpandedDetail | null {
    return this.detail?.id === id ? this.detail.detail : null;
  }

  /** `—` until the engine has answered, and `—` forever on an engine that has no such route. */
  private changesView(id: string): PanelChangesView {
    const changes = this.detailOf(id)?.changes ?? null;
    return {
      committed: changeSummary(changes?.committed),
      workingTree: changeSummary(changes?.workingTree),
    };
  }

  /**
   * The one expanded row's detail. Re-read on every refresh — "changes so far" is the number that
   * moves while an agent works — but never twice at once, and never applied to a row the user has
   * meanwhile collapsed or moved off.
   */
  private loadDetail(): void {
    const id = this.expandedId;
    const load = this.deps.loadExpanded;
    if (id === null || load === undefined || this.loading === id) return;
    const item = this.itemOf(id);
    if (item === undefined) return;
    this.loading = id;
    void load(item)
      .then((detail) => {
        if (this.expandedId !== id || detail === null) return;
        // P11: a read that found no engine keeps what was last loaded rather than blanking the
        // row — "showing what was last loaded" has to be true of the row as well as of the line.
        const previous = this.detailOf(id);
        this.detail = {
          id,
          detail: detail.offline && previous !== null ? { ...previous, offline: true } : detail,
        };
        this.render();
      })
      .catch((err: unknown) => {
        this.deps.host.log(`cgremlin: could not read the expanded row's detail: ${String(err)}`);
      })
      .finally(() => {
        if (this.loading === id) this.loading = null;
      });
  }

  private html(): string {
    const nonce = this.deps.nonce?.() ?? crypto.randomBytes(16).toString('base64');
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      `<meta http-equiv="Content-Security-Policy" content="${cspFor(nonce)}">`,
      '<title>cgremlin</title>',
      `<style nonce="${nonce}">`,
      this.deps.assets.styleText,
      '</style>',
      '</head>',
      '<body>',
      '<div id="cgremlin-panel"></div>',
      `<script nonce="${nonce}">`,
      this.deps.assets.scriptText,
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  private post(message: HostToPanel): void {
    if (this.view === null || !this.ready) return;
    void this.view.webview.postMessage(message);
  }

  private render(): void {
    if (this.batchDepth > 0) {
      this.batched = true;
      return;
    }
    this.flush();
  }

  /**
   * A render that would say exactly what the last one said is not sent at all. The webview would
   * reconcile it to nothing anyway; not sending it is what makes "one render per refresh" true
   * rather than merely harmless.
   */
  private flush(): void {
    const state = this.drawableState();
    this.paintBadge(state.needsYou.length);
    const encoded = JSON.stringify(state);
    if (encoded === this.lastPosted) return;
    this.lastPosted = encoded;
    this.post({ type: 'render', state });
  }

  /**
   * `state()`, and a state that SAYS SO when it cannot be built.
   *
   * Building it touches every pure model there is, and an unexpected throw anywhere in that chain
   * used to travel up through `setItems` into `refresh.ts`'s catch, which writes one line to an
   * output channel nobody has open. Nothing reached the webview, so a panel that had never
   * rendered stayed empty: a blank sidebar beside a healthy engine, explaining nothing. Silence
   * is the bug (Phase 8), so the failure is ink — here, on the same trouble row an unusable
   * engine already uses.
   */
  private drawableState(): PanelState {
    try {
      return this.state();
    } catch (err) {
      this.deps.host.log(`cgremlin: the panel could not be drawn: ${String(err)}`);
      return {
        sections: [],
        focus: FOCUS_ALL,
        focusOptions: [],
        needsYou: [],
        dismissedCount: 0,
        showDismissed: false,
        banner: null,
        trouble: {
          message: PANEL_RENDER_FAILURE,
          command: 'cgremlin.engine.showLog',
          actionLabel: 'Show log',
          secondary: { command: 'workbench.action.reloadWindow', actionLabel: 'Reload window' },
        },
        notice: null,
        connected: this.connected,
      };
    }
  }

  /**
   * P3: the count on the view container — `WebviewView.badge` (VS Code 1.72; this package's
   * engine floor is 1.85). Zero REMOVES the badge rather than painting a `0`: a badge that says
   * nothing is due is still a mark on the activity bar, which is the interruption this replaces.
   */
  private paintBadge(count: number): void {
    if (this.view === null) return;
    this.view.badge = count === 0 ? undefined : { value: count, tooltip: badgeTooltip(count) };
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parsePanelMessage(raw);
    if (message === null) return;
    switch (message.type) {
      case 'ready':
        // R39's handshake: a render posted before the script was listening is dropped silently,
        // and the panel stays blank. A re-created view has seen nothing, so the de-duplication
        // memory is cleared rather than swallowing the first render.
        this.ready = true;
        this.lastPosted = null;
        this.render();
        return;
      case 'selectRow':
        this.select(message.id);
        return;
      case 'dismissNotice':
        this.dismissNotice();
        return;
      case 'openItem':
        await this.deps.onOpenItem(message.id);
        return;
      case 'openChild':
        await this.deps.onOpenChild(message.id, message.childId);
        return;
      case 'setSort':
        this.sorts = { ...this.sorts, [message.list]: message.sort };
        writeSort(this.deps.host, message.list, message.sort);
        this.render();
        return;
      case 'toggleSection':
        this.setCollapsed(message.key, message.collapsed);
        return;
      case 'setFocus':
        this.focus = message.focus;
        writeFocus(this.deps.host, message.focus);
        // Choosing an area is asking to SEE it, so a section that starts closed (R47's "someone
        // is on it") opens rather than answering the choice with an empty header.
        if (message.focus !== FOCUS_ALL && this.collapsed[message.focus] !== false) {
          this.setCollapsed(message.focus, false);
          return;
        }
        this.render();
        return;
      case 'setShowDismissed':
        this.showDismissed = message.show;
        writeShowDismissed(this.deps.host, message.show);
        this.render();
        return;
      case 'toggleRow':
        // The keyboard's way of opening a row, and it reads the detail for the same reason a
        // click does: an expand is the one moment the row is certainly worth a round trip.
        this.setExpanded(message.expanded ? message.id : null);
        this.render();
        this.refreshDetail();
        return;
      case 'command':
        await this.deps.onCommand(message.command, message.id, message.childId);
        return;
    }
  }

  /**
   * One click, three consequences (§4, amended). The order matters: the panel repaints from its
   * own state first, so the highlight and the expansion are on screen before the swap — which may
   * put a modal in front of the user — is even asked for.
   */
  private select(id: string): void {
    // A row the user is being SENT to — from the needs-you strip, or from a command's reveal —
    // must end up on screen. A filter that silently swallowed it would make the strip a dead end,
    // so the focus widens rather than the selection disappearing (§6).
    this.widenTo(id);
    this.selectedId = id;
    void this.deps.host.setState(SELECTED_STATE_KEY, id);
    // Clicking the row that is already open closes it: the accordion has a shut position, and
    // the selection stays where the user put it.
    this.setExpanded(this.expandedId === id ? null : id);
    this.render();
    this.refreshDetail();
    void this.deps.onSelect?.(id);
  }

  /**
   * The row a command acted on, brought into view: selected and OPEN. Deliberately not `select`
   * — that toggles, and a Start clicked from an already-open row must never answer by shutting
   * it. The workspace swap is the caller's (the Item tab follows the new agent's worktree, R22),
   * so this stays what it says it is: the panel's own highlight and accordion.
   */
  reveal(id: string): void {
    this.widenTo(id);
    this.uncollapseFor(id);
    this.selectedId = id;
    void this.deps.host.setState(SELECTED_STATE_KEY, id);
    this.setExpanded(id);
    this.render();
    this.refreshDetail();
  }

  /**
   * A started row usually CHANGES SECTION — a parking-lot PR becomes a
   * `Reviewing` row — and the section it lands in may be one the user has
   * closed. Revealing into a collapsed section is the same dead end as
   * revealing into a filtered-out one, so it opens.
   */
  private uncollapseFor(id: string): void {
    const holder = this.sections().find((section) => section.rows.some((row) => row.id === id));
    if (holder === undefined || !holder.collapsed) return;
    this.collapsed = { ...this.collapsed, [holder.key]: false };
    writeCollapsed(this.deps.host, this.collapsed);
  }

  /** Widens the panel back to all areas when `id` is not a row of the focused one (§6). */
  private widenTo(id: string): void {
    if (this.focus === FOCUS_ALL) return;
    const focused = this.sections().find((section) => section.key === this.focus);
    if (focused?.rows.some((row) => row.id === id) === true) return;
    this.focus = FOCUS_ALL;
    writeFocus(this.deps.host, FOCUS_ALL);
  }

  /** P10: the dismissal outlives the window, so it is written before the repaint. */
  private dismissNotice(): void {
    if (this.noticeDismissed) return;
    this.noticeDismissed = true;
    void this.deps.host.setState(WORKSPACE_NOTICE_DISMISSED_KEY, true);
    this.render();
  }

  private setExpanded(id: string | null): void {
    if (this.expandedId !== id) this.detailSignature = null;
    this.expandedId = id;
    if (this.detail !== null && this.detail.id !== id) this.detail = null;
    void this.deps.host.setState(EXPANDED_STATE_KEY, id);
  }

  /**
   * Item 1: the user has written (or cleared) his own title for an item. It lives in the host's
   * global state rather than on the wire, so nothing refetches — the rows are simply rebuilt.
   */
  reloadTitles(): void {
    this.render();
  }

  /** Re-reads the persisted sorts — used when the host state changed behind the panel's back. */
  reloadSorts(): void {
    for (const list of Object.keys(this.sorts) as WorkListKind[]) {
      this.sorts[list] = readSort(this.deps.host, list);
    }
    this.render();
  }
}

/**
 * The row's actions (R42, R50, R51, R26) — **which ones apply is a rule about the list**, so it
 * is asked of the one shared module (`model/row-actions`) rather than decided twice. The Item
 * tab's `buttonsFor` asks the same function, over the union of `item.lists`, so the panel and
 * the tab cannot disagree about what a click would do.
 */
/** `All areas (17)`, then the six with their own counts — including the ones off screen (§6). */
function focusOptionsOf(sections: readonly PanelSectionView[]): PanelFocusOption[] {
  const total = sections.reduce((sum, section) => sum + section.count, 0);
  return [
    { key: FOCUS_ALL, title: 'All areas', count: total },
    ...sections.map((section) => ({
      key: section.key,
      title: section.title,
      count: section.count,
    })),
  ];
}

export function actionsFor(
  item: WorkItem,
  list: WorkListKind,
  dismissed = isDismissed(item),
  qaRepos: readonly string[] = [],
  qaStatuses: readonly string[] = [],
): PanelActionView[] {
  // Item 2: a row the user has put aside offers exactly one verb — stop putting it aside. Every
  // other verb would start work on something he has just said he does not care about.
  if (dismissed) {
    return [{ command: 'cgremlin.undismissItem', label: 'Undismiss', placement: 'inline' }];
  }
  // §4: `Ack` renders only while something needs you AND you have not already said so. The rule
  // table cannot see the acknowledgement, so the one field it lacks is applied here.
  const actions = rowActions(itemActionFacts(item, qaRepos, qaStatuses), list).filter(
    (action) => action.command !== 'cgremlin.ack' || !item.attention.acked,
  );
  // Item 1: naming a row is never a rule about a list, which is why it is added here rather than
  // in the shared table — the Item tab's buttons are about the WORK, and this is about the panel.
  actions.push({ command: 'cgremlin.renameItem', label: 'Rename', placement: 'inline' });
  actions.push({ command: 'cgremlin.dismissItem', label: 'Dismiss', placement: 'inline' });
  return actions;
}
