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
import {
  buildItemChildren,
  buildWorkLists,
  readSort,
  readSorts,
  ticketBanner,
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
  type PanelChildView,
  type PanelListView,
  type PanelRowView,
  type PanelState,
} from '../model/panel-protocol';
import { troubleCommand, troubleMessage, type EngineTrouble } from '../model/engine-trouble';
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
  nonce?: () => string;
  now?: () => number;
}

export class PanelView implements WebviewViewProviderLike {
  private view: WebviewViewLike | null = null;
  private subscription: DisposableLike | null = null;
  private ready = false;
  private response: ItemsResponse | null = null;
  private trouble: EngineTrouble | null = null;
  private connected = false;
  private readonly expanded = new Set<string>();
  private readonly collapsedGroups = new Map<string, boolean>();
  private sorts: Record<WorkListKind, WorkSortKind>;

  constructor(private readonly deps: PanelViewDeps) {
    this.sorts = readSorts(deps.host);
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
    this.render();
  }

  setTrouble(trouble: EngineTrouble | null): void {
    this.trouble = trouble;
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
    return {
      lists: this.trouble === null ? this.lists() : [],
      banner:
        this.response === null
          ? null
          : ticketBanner(this.response.ticketSource, this.response.threadSource),
      trouble:
        this.trouble === null
          ? null
          : { message: troubleMessage(this.trouble), command: troubleCommand(this.trouble) },
      connected: this.connected,
    };
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
      return {
        kind,
        title: list.title,
        count: list.count,
        sort: list.sort,
        sorts: [...list.sorts],
        sections: list.sections.map((section) => ({
          group: section.group,
          title: section.title,
          count: section.count,
          collapsible: section.collapsible,
          collapsed: this.collapsed(kind, section.group, section.collapsed),
          rows: section.rows.map((row) => this.rowView(row)),
        })),
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
    const expanded = this.expanded.has(row.id);
    return {
      id: row.id,
      list: row.list,
      label: row.label,
      description: row.description,
      badges: row.badges,
      chips: row.chips,
      ci: row.ci,
      needsYou: row.needsYou,
      hasChildren: row.hasChildren,
      expanded,
      children: expanded ? buildItemChildren(row.item).map(childView) : [],
      actions: actionsFor(row.item),
    };
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
    this.post({ type: 'render', state: this.state() });
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parsePanelMessage(raw);
    if (message === null) return;
    switch (message.type) {
      case 'ready':
        // R39's handshake: a render posted before the script was listening is dropped silently,
        // and the panel stays blank.
        this.ready = true;
        this.render();
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
        if (message.expanded) this.expanded.add(message.id);
        else this.expanded.delete(message.id);
        this.render();
        return;
      case 'command':
        await this.deps.onCommand(message.command, message.id, message.childId);
        return;
    }
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
 * The row's actions (R42, R50, R51, R26). Which ones apply is a rule about the work, so it is
 * decided here and the webview only renders what it is given:
 *  - **Start review** on a PR that is not mine and has no review agent — the core answers 409
 *    `OwnPrError` on my own, and a button whose only outcome is an error is what made the old
 *    panel untrustworthy;
 *  - **Address review comments** exactly on my own non-draft PR (R51), which is the click that
 *    creates AND starts the respond run (R56);
 *  - **Chat** only where there is an agent to chat to, and on a respond agent only once its run
 *    has finished — `addressing` or `ready` (R50);
 *  - **Open PR** once per entry in `prs` (R26).
 */
export function actionsFor(item: WorkItem): PanelActionView[] {
  const actions: PanelActionView[] = [];
  const primary = item.prs[0];
  const chatable = item.agents.find(
    (agent) => agent.mode !== 'respond' || agent.phase === 'addressing' || agent.phase === 'ready',
  );
  if (chatable !== undefined) actions.push({ command: 'cgremlin.chat', label: 'Chat' });
  if (primary !== undefined && primary.isMine !== true) {
    if (!item.agents.some((agent) => agent.mode === 'review')) {
      actions.push({ command: 'cgremlin.startReview', label: 'Start review' });
    }
  }
  if (primary !== undefined && primary.isMine === true && primary.isDraft === false) {
    actions.push({ command: 'cgremlin.addressReview', label: 'Address review comments' });
  }
  actions.push({ command: 'cgremlin.startInvestigation', label: 'Start investigation' });
  actions.push({ command: 'cgremlin.startDevelopment', label: 'Start development' });
  for (const pr of item.prs) {
    actions.push({
      command: 'cgremlin.openPr',
      label: `Open ${pr.repo}#${pr.number}`,
      childId: `pr:${pr.repo}#${pr.number}`,
    });
  }
  if (item.ticket !== null) {
    actions.push({
      command: 'cgremlin.openTicket',
      label: `Open ${item.ticket.key}`,
      childId: `ticket:${item.ticket.key}`,
    });
  }
  actions.push({ command: 'cgremlin.ack', label: 'Ack' });
  return actions;
}
