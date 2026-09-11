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
import { itemActionFacts, rowActions, type StageKind } from '../model/row-actions';
import {
  buildItemChildren,
  buildWorkLists,
  readSort,
  readSorts,
  ticketBanner,
  visibleRowCount,
  writeSort,
  type ItemsResponse,
  type ParkingLotGroup,
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
  type PanelChildView,
  type PanelListView,
  type PanelRowView,
  type PanelSlotView,
  type PanelState,
} from '../model/panel-protocol';
import {
  SHOW_LOG,
  troubleCommand,
  troubleMessage,
  type EngineTrouble,
  type SourceTrouble,
} from '../model/engine-trouble';
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
}

/** The extra the detail routes carry for the ONE expanded row (§4, amended). */
export interface ExpandedDetail {
  /** The latest artifact time per session id, for a slot's `done · 2h`. */
  artifactAt: Record<string, string | null>;
  changes: SessionChanges | null;
}

export const SELECTED_STATE_KEY = 'cgremlin.panel.selected';
export const EXPANDED_STATE_KEY = 'cgremlin.panel.expanded';

const START_COMMAND: Record<StageKind, string> = {
  investigation: 'cgremlin.startInvestigation',
  development: 'cgremlin.startDevelopment',
  review: 'cgremlin.startReview',
};

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
  private readonly collapsedGroups = new Map<string, boolean>();
  private sorts: Record<WorkListKind, WorkSortKind>;
  /** §3.3: `setConnected` + `setItems` + `setSourceTrouble` in one refresh are ONE post. */
  private batchDepth = 0;
  private batched = false;
  private lastPosted: string | null = null;

  constructor(private readonly deps: PanelViewDeps) {
    this.sorts = readSorts(deps.host);
    this.selectedId = deps.host.getState<string>(SELECTED_STATE_KEY) ?? null;
    this.expandedId = deps.host.getState<string>(EXPANDED_STATE_KEY) ?? null;
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
    return this.response?.items ?? [];
  }

  itemOf(id: string): WorkItem | undefined {
    return this.response?.items.find((item) => item.id === id);
  }

  childOf(id: string, childId: string): WorkChild | undefined {
    const item = this.itemOf(id);
    return item === undefined
      ? undefined
      : buildItemChildren(item).find((child) => child.id === childId);
  }

  state(): PanelState {
    const trouble = this.troubleView();
    return {
      lists: trouble === null ? this.lists() : [],
      banner:
        this.response === null
          ? null
          : ticketBanner(this.response.ticketSource, this.response.threadSource),
      trouble,
      connected: this.connected,
    };
  }

  private troubleView(): PanelState['trouble'] {
    if (this.trouble !== null) {
      return {
        message: troubleMessage(this.trouble),
        command: troubleCommand(this.trouble),
        actionLabel: this.trouble.kind === 'foreign' ? 'Start the engine' : SHOW_LOG,
      };
    }
    if (this.sourceTrouble !== null) {
      return {
        message: this.sourceTrouble.message,
        command: this.sourceTrouble.command,
        actionLabel: this.sourceTrouble.actionLabel,
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

  private lists(): PanelListView[] {
    if (this.response === null) return [];
    const built = buildWorkLists({
      response: this.response,
      sorts: this.sorts,
      now: this.deps.now?.(),
    });
    return (Object.keys(built) as WorkListKind[]).map((kind) => {
      const list = built[kind];
      const sections = list.sections.map((section) => ({
        group: section.group,
        title: section.title,
        count: section.count,
        collapsible: section.collapsible,
        collapsed: this.collapsed(kind, section.group, section.collapsed),
        rows: section.rows.map((row) => this.rowView(row)),
      }));
      return {
        kind,
        title: list.title,
        // P1: the USER's collapse state, not the default one, decides what the header may claim.
        count: visibleRowCount(sections),
        sort: list.sort,
        sorts: [...list.sorts],
        sections,
      };
    });
  }

  private collapsed(
    list: WorkListKind,
    group: ParkingLotGroup | null,
    fallback: boolean,
  ): boolean {
    if (group === null) return false;
    return this.collapsedGroups.get(`${list}:${group}`) ?? fallback;
  }

  private rowView(row: WorkRow): PanelRowView {
    const expanded = this.expandedId === row.id;
    const actions = actionsFor(row.item, row.list);
    return {
      id: row.id,
      list: row.list,
      label: row.label,
      description: row.description,
      badges: row.badges,
      chips: row.chips,
      age: row.age,
      size: row.size,
      ci: row.ci,
      meta: row.meta,
      stateLine: row.stateLine,
      tier: row.tier,
      demoted: row.demoted,
      needsYou: row.needsYou,
      // Every row expands now: what it expands INTO is the three lifecycle slots, which exist
      // whether or not the item has a second part to name (§4, amended).
      hasChildren: true,
      expanded,
      selected: this.selectedId === row.id,
      // The PARTS. The agents are the lifecycle slots instead, so they are not listed twice.
      children: expanded
        ? buildItemChildren(row.item)
            .filter((child) => child.kind !== 'agent')
            .map(childView)
        : [],
      lifecycle: expanded ? this.slotsOf(row, actions) : [],
      changes: expanded ? this.changesView(row.id) : null,
      actions,
    };
  }

  /**
   * The lifecycle slots, each carrying the Start the forward-only rule allows — taken from the
   * row's OWN actions, so a slot can never offer a verb the row's button refuses (P0-2).
   */
  private slotsOf(row: WorkRow, actions: PanelActionView[]): PanelSlotView[] {
    const detail = this.detail?.id === row.id ? this.detail.detail : null;
    return lifecycleSlots({
      agents: row.item.agents,
      facts: itemActionFacts(row.item),
      artifactAt: detail?.artifactAt,
      now: this.deps.now?.(),
    }).map((slot) => ({
      stage: slot.stage,
      title: slot.title,
      glyph: slot.glyph,
      state: slot.state,
      stateText: slot.stateText,
      sessionId: slot.sessionId,
      start: slot.next
        ? (actions.find((action) => action.command === START_COMMAND[slot.stage]) ?? null)
        : null,
    }));
  }

  /** `—` until the engine has answered, and `—` forever on an engine that has no such route. */
  private changesView(id: string): PanelChangesView {
    const changes = this.detail?.id === id ? this.detail.detail.changes : null;
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
        this.detail = { id, detail };
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
    const state = this.state();
    const encoded = JSON.stringify(state);
    if (encoded === this.lastPosted) return;
    this.lastPosted = encoded;
    this.post({ type: 'render', state });
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
      case 'toggleGroup':
        this.collapsedGroups.set(`${message.list}:${message.group}`, message.collapsed);
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
    this.selectedId = id;
    void this.deps.host.setState(SELECTED_STATE_KEY, id);
    // Clicking the row that is already open closes it: the accordion has a shut position, and
    // the selection stays where the user put it.
    this.setExpanded(this.expandedId === id ? null : id);
    this.render();
    this.refreshDetail();
    void this.deps.onSelect?.(id);
  }

  private setExpanded(id: string | null): void {
    if (this.expandedId !== id) this.detailSignature = null;
    this.expandedId = id;
    if (this.detail !== null && this.detail.id !== id) this.detail = null;
    void this.deps.host.setState(EXPANDED_STATE_KEY, id);
  }

  /** Re-reads the persisted sorts — used when the host state changed behind the panel's back. */
  reloadSorts(): void {
    for (const list of Object.keys(this.sorts) as WorkListKind[]) {
      this.sorts[list] = readSort(this.deps.host, list);
    }
    this.render();
  }
}

const GO_TO_LABEL: Record<WorkChild['kind'], string> = {
  agent: 'Resume',
  ticket: 'Open in Jira',
  pr: 'Open on GitHub',
};

function childView(child: WorkChild): PanelChildView {
  return {
    id: child.id,
    kind: child.kind,
    label: child.label,
    goToLabel: GO_TO_LABEL[child.kind],
  };
}

/**
 * The row's actions (R42, R50, R51, R26) — **which ones apply is a rule about the list**, so it
 * is asked of the one shared module (`model/row-actions`) rather than decided twice. The Item
 * tab's `buttonsFor` asks the same function, over the union of `item.lists`, so the panel and
 * the tab cannot disagree about what a click would do.
 */
export function actionsFor(item: WorkItem, list: WorkListKind): PanelActionView[] {
  return rowActions(itemActionFacts(item), list);
}
