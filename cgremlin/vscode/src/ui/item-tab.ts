/**
 * The Item tab: one `WebviewPanel` for the whole extension (R19, MG-B9).
 *
 * What the tab owns: the panel's lifecycle, the HTML (R38's CSP, a fresh nonce per render), the
 * `ready` handshake (R39), which agent is selected, which focus is shown (R48), the artifact
 * bodies it fetches and relays, and the worktree swap that follows the selected agent (R22).
 *
 * What it deliberately does NOT own: a claim. Selecting an item or switching agents is browsing;
 * only the chat terminal ever claims (R42). And it reads no file at all — the script and the
 * style arrive as injected text from `extension.ts` (R62), which is why this file's tests do not
 * need the bundler.
 *
 * Takes its editor surface as a parameter (no editor import).
 */
import crypto from 'node:crypto';
import { CoreHttpError, engineErrorText, type CoreClient } from '../core-client';
import { ciDot, itemPathOf, type WorkItem, type WorkItemPr, prState } from '../model/work-items';
import {
  parseWebviewMessage,
  type HostToWebview,
  type ItemFocusMessage,
  type ItemTabState,
  type TabAgent,
  type TabButton,
  type TabPr,
} from '../model/item-tab-protocol';
import type { ItemDetailResponse } from '../model/work-items';
import { rowActionsForLists, type ActionFacts } from '../model/row-actions';
import type { CoreConfigView } from '../model/items';
import type { WorktreeSwapper } from './preview';
import type { DisposableLike, Host, WebviewPanelLike } from './host';

export const ITEM_TAB_VIEW_TYPE = 'cgremlin.item';

/** R38, verbatim. `<n>` is a fresh 128-bit base64 nonce per render. */
export function cspFor(nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
    `img-src 'none'; font-src 'none'`
  );
}

export interface ItemTabAssets {
  scriptText: string;
  styleText: string;
}

export interface ItemTabDeps {
  host: Host;
  client: CoreClient;
  config: () => CoreConfigView | null;
  /** R62: the bundled script and the stylesheet, as text. `extension.ts` is what reads them. */
  assets: ItemTabAssets;
  /** The extension's asset directory, for `localResourceRoots` alone: nothing loads by URI. */
  mediaPath: string;
  swapper: WorktreeSwapper;
  /** Tells the status bar which agent the window is on (R43). */
  onOpened: (sessionId: string | null, worktreePath: string | null) => void;
  nonce?: () => string;
}

export class ItemTab {
  private panel: WebviewPanelLike | null = null;
  private subscription: DisposableLike | null = null;
  private ready = false;
  private detail: ItemDetailResponse | null = null;
  private path: string | null = null;
  private focus: ItemFocusMessage = { kind: 'ticket' };
  private selected: string | null = null;
  /** Artifact bodies already fetched, keyed `<sessionId>/<name>` — never refetched on a redraw. */
  private readonly bodies = new Map<string, string>();
  private pending: Promise<unknown>[] = [];

  constructor(private readonly deps: ItemTabDeps) {}

  itemId(): string | null {
    return this.detail?.item.id ?? null;
  }

  /** Opens (or re-points) the one panel at `path`, optionally focused on one of its parts. */
  async open(path: string, focus?: ItemFocusMessage): Promise<void> {
    let detail: ItemDetailResponse;
    try {
      detail = await this.deps.client.item(path);
    } catch (err) {
      void this.deps.host.showWarningMessage(messageOf(err), undefined);
      return;
    }
    this.path = path;
    this.detail = detail;
    this.focus = resolveFocus(detail.item, focus);
    this.selected = selectedFor(detail.item, this.focus);
    this.show();
    this.render();
    this.track(this.loadArtifacts());
    await this.followWorktree();
  }

  /** The agent switcher. It re-points the worktree and never touches a claim (R42). */
  async selectAgent(sessionId: string): Promise<void> {
    if (this.detail === null) return;
    if (!this.detail.item.agents.some((agent) => agent.sessionId === sessionId)) return;
    this.selected = sessionId;
    this.focus = { kind: 'agent', sessionId };
    this.render();
    this.track(this.loadArtifacts());
    await this.followWorktree();
  }

  /** R41: the frame's `id` is an address. A different item is somebody else's business. */
  itemChanged(id: string): Promise<void> {
    const work = this.reload(id);
    this.track(work);
    return work;
  }

  /** One artifact of one of this item's agents, refetched and patched in place. */
  artifactChanged(sessionId: string, name: string): Promise<void> {
    const work = this.reloadArtifact(sessionId, name);
    this.track(work);
    return work;
  }

  private async reload(id: string): Promise<void> {
    if (this.detail === null || this.path === null || this.detail.item.id !== id) return;
    try {
      this.detail = await this.deps.client.item(this.path);
    } catch {
      return; // a transient read failure leaves the tab as it was, rather than blanking it
    }
    this.render();
  }

  private async reloadArtifact(sessionId: string, name: string): Promise<void> {
    if (this.detail === null) return;
    if (!this.detail.item.agents.some((agent) => agent.sessionId === sessionId)) return;
    const listing = (this.detail.artifacts[sessionId] ?? []).find((a) => a.name === name);
    const text = await this.readArtifact(sessionId, name);
    if (text === null) return;
    this.post({
      type: 'patch',
      artifact: { sessionId, name, mtime: listing?.mtime ?? '', text },
    });
  }

  /** Outstanding artifact reads — the tab dispatches them and does not block the click on them. */
  async settled(): Promise<void> {
    while (this.pending.length > 0) {
      const outstanding = this.pending;
      this.pending = [];
      await Promise.allSettled(outstanding);
    }
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
    this.panel?.dispose();
    this.panel = null;
  }

  // --- internals -----------------------------------------------------------

  private track(work: Promise<unknown>): void {
    this.pending.push(work);
  }

  private show(): void {
    if (this.panel !== null) {
      this.panel.title = this.detail?.item.title ?? 'cgremlin';
      this.panel.reveal(true);
      return;
    }
    const panel = this.deps.host.createWebviewPanel({
      viewType: ITEM_TAB_VIEW_TYPE,
      title: this.detail?.item.title ?? 'cgremlin',
      enableScripts: true,
      // R39: the tab keeps its artifacts and its scroll position across a tab switch.
      retainContextWhenHidden: true,
      localResourceRoots: [this.deps.mediaPath],
    });
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.html();
    this.subscription = panel.webview.onDidReceiveMessage((raw) => {
      void this.handle(raw);
    });
    panel.onDidDispose(() => {
      this.subscription?.dispose();
      this.subscription = null;
      this.panel = null;
      this.ready = false;
    });
  }

  private html(): string {
    const nonce = this.deps.nonce?.() ?? crypto.randomBytes(16).toString('base64');
    // Everything is inlined: with `img-src 'none'` and `font-src 'none'` there is nothing else to
    // fetch, and inlining sidesteps the question of what a nonce authorises on a `src` (R38).
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
      '<div id="cgremlin-item"></div>',
      `<script nonce="${nonce}">`,
      this.deps.assets.scriptText,
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (message === null) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.render();
        this.flushArtifacts();
        return;
      case 'selectAgent':
        await this.selectAgent(message.sessionId);
        return;
      case 'setFocus':
        this.focus = message.focus;
        this.selected = selectedFor(this.detail?.item, this.focus) ?? this.selected;
        this.render();
        return;
      case 'openLink':
        await this.deps.host.openExternal(message.url);
        return;
      case 'command': {
        // Chat is per *agent*; everything else is per item.
        const arg =
          message.command === 'cgremlin.chat' ? this.selected : (message.arg ?? this.itemId());
        if (arg === null) return;
        await this.deps.host.executeCommand(message.command, arg);
        return;
      }
    }
  }

  private post(message: HostToWebview): void {
    if (this.panel === null || !this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  private render(): void {
    if (this.detail === null) return;
    this.post({ type: 'render', state: this.state(this.detail) });
  }

  private state(detail: ItemDetailResponse): ItemTabState {
    const item = detail.item;
    const state: ItemTabState = {
      itemId: item.id,
      title: item.title,
      needsYou: item.needsYou,
      chips: [
        ...(item.ticket === null ? [] : [{ label: item.ticket.key, url: item.ticket.url }]),
        ...item.prs.map((pr) => ({ label: `${pr.repo}#${pr.number}`, url: pr.url })),
      ],
      focus: this.focus,
      selectedSessionId: this.selected,
      agents: item.agents.map((agent) => this.agentView(detail, agent.sessionId)),
      prs: item.prs.map((pr) => prView(pr)),
      ticket:
        detail.ticket === null
          ? null
          : {
              key: detail.ticket.key,
              summary: detail.ticket.summary,
              status: detail.ticket.status,
              url: detail.ticket.url,
              assignee: detail.ticket.assignee,
              descriptionText: detail.ticket.descriptionText,
              comments: detail.ticket.comments,
            },
      ticketError: detail.ticketError,
      lists: [...item.lists],
      buttons: [],
    };
    state.buttons = buttonsFor(state);
    return state;
  }

  private agentView(detail: ItemDetailResponse, sessionId: string): TabAgent {
    const agent = detail.item.agents.find((a) => a.sessionId === sessionId);
    const listings = [...(detail.artifacts[sessionId] ?? [])].sort((a, b) =>
      a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0,
    );
    return {
      sessionId,
      mode: agent?.mode ?? 'review',
      phase: agent?.phase ?? '',
      running: agent?.running ?? false,
      needsYou: agent?.needsYou ?? false,
      claimed: agent?.claimed ?? false,
      glyph: agent === undefined ? '' : glyphOf(agent),
      primaryArtifact: agent?.primaryArtifact ?? null,
      artifacts: listings.map((listing) => ({
        sessionId,
        name: listing.name,
        mtime: listing.mtime,
        text: this.bodies.get(`${sessionId}/${listing.name}`) ?? null,
      })),
    };
  }

  /** The selected agent's artifacts, newest first — content over the channel, never a URI. */
  private async loadArtifacts(): Promise<void> {
    const detail = this.detail;
    const sessionId = this.selected;
    if (detail === null || sessionId === null) return;
    const listings = [...(detail.artifacts[sessionId] ?? [])].sort((a, b) =>
      a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0,
    );
    for (const listing of listings) {
      const key = `${sessionId}/${listing.name}`;
      if (this.bodies.has(key)) {
        this.postArtifact(sessionId, listing.name, listing.mtime);
        continue;
      }
      const text = await this.readArtifact(sessionId, listing.name);
      if (text !== null) this.postArtifact(sessionId, listing.name, listing.mtime);
    }
  }

  private postArtifact(sessionId: string, name: string, mtime: string): void {
    const text = this.bodies.get(`${sessionId}/${name}`) ?? null;
    this.post({ type: 'patch', artifact: { sessionId, name, mtime, text } });
  }

  /** A webview that was not listening yet gets the bodies as soon as it says `ready`. */
  private flushArtifacts(): void {
    const sessionId = this.selected;
    const detail = this.detail;
    if (detail === null || sessionId === null) return;
    for (const listing of detail.artifacts[sessionId] ?? []) {
      if (this.bodies.has(`${sessionId}/${listing.name}`)) {
        this.postArtifact(sessionId, listing.name, listing.mtime);
      }
    }
  }

  private async readArtifact(sessionId: string, name: string): Promise<string | null> {
    try {
      const text = await this.deps.client.artifactText(sessionId, name);
      this.bodies.set(`${sessionId}/${name}`, text);
      return text;
    } catch (err) {
      this.deps.host.log(`cgremlin: could not read ${sessionId}/${name}: ${messageOf(err)}`);
      return null;
    }
  }

  /**
   * R22: the workspace follows the selected agent's worktree, and an item with no agent swaps
   * nothing at all.
   */
  private async followWorktree(): Promise<void> {
    const agent = this.detail?.item.agents.find((a) => a.sessionId === this.selected);
    if (agent === undefined) {
      this.deps.onOpened(null, null);
      return;
    }
    this.deps.onOpened(agent.sessionId, agent.worktreePath);
    if (agent.worktreePath === null) return;
    await this.deps.swapper.swapTo(agent.sessionId, agent.worktreePath);
  }
}

/** Claim, then a live run, then the gate — the same precedence the rows use (R18). */
function glyphOf(agent: { claimed: boolean; running: boolean; needsYou: boolean }): string {
  if (agent.claimed) return '👤';
  if (agent.running) return '🔄';
  if (agent.needsYou) return '❗';
  return '';
}

function prView(pr: WorkItemPr): TabPr {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: prState(pr),
    reviewDecision: pr.reviewDecision,
    ci: ciDot(pr.ci),
    isMine: pr.isMine,
    isDraft: pr.isDraft,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    reviewers: pr.reviews ?? [],
    checks: pr.checks ?? [],
    openThreads: pr.openThreads ?? null,
  };
}

/** An unknown focus falls back to the primary agent rather than rendering blank (R48). */
function resolveFocus(item: WorkItem, requested?: ItemFocusMessage): ItemFocusMessage {
  if (requested !== undefined) {
    if (requested.kind === 'agent') {
      if (item.agents.some((agent) => agent.sessionId === requested.sessionId)) return requested;
    } else if (requested.kind === 'pr') {
      if (item.prs.some((pr) => pr.repo === requested.repo && pr.number === requested.number)) {
        return requested;
      }
    } else if (item.ticket !== null) {
      return requested;
    }
  }
  const primary = item.agents[0];
  if (primary !== undefined) return { kind: 'agent', sessionId: primary.sessionId };
  const pr = item.prs[0];
  if (pr !== undefined) return { kind: 'pr', repo: pr.repo, number: pr.number };
  return { kind: 'ticket' };
}

function selectedFor(item: WorkItem | undefined, focus: ItemFocusMessage): string | null {
  if (item === undefined) return null;
  if (focus.kind === 'agent') return focus.sessionId;
  return item.agents[0]?.sessionId ?? null;
}

/**
 * The button row, as a rule rather than a style (R42, R50, R51) — and the **same** rule the
 * panel rows use: `model/row-actions` decides which verbs apply, over the union of the lists the
 * item is in, so the tab can never offer a verb a row would refuse (or the reverse).
 *
 * The one thing the tab decides for itself is **Chat**, because here it is about the *selected*
 * agent rather than about the item: a respond agent still at `triaging` renders a disabled
 * button with R50's reason, where a row simply has no Chat at all.
 */
export function buttonsFor(state: ItemTabState): TabButton[] {
  const selected = state.agents.find((agent) => agent.sessionId === state.selectedSessionId);
  const triaging =
    selected !== undefined && selected.mode === 'respond' && selected.phase === 'triaging';
  const buttons: TabButton[] = [
    {
      id: 'cgremlin.chat',
      label: 'Chat',
      enabled: selected !== undefined && !triaging,
      ...(triaging
        ? {
            reason:
              'The respond agent is still triaging the review threads — chat opens once it has written them up.',
          }
        : {}),
    },
  ];
  const facts: ActionFacts = {
    agents: state.agents,
    prs: state.prs,
    ticketKey: state.ticket?.key ?? null,
    needsYou: state.needsYou,
  };
  for (const action of rowActionsForLists(facts, state.lists)) {
    if (action.command === 'cgremlin.chat') continue;
    buttons.push({ id: action.command, label: action.label, enabled: true });
  }
  return buttons;
}

/** The path an item id is addressed at, re-exported so callers never build one by hand (R65). */
export { itemPathOf };

function messageOf(err: unknown): string {
  if (err instanceof CoreHttpError) return engineErrorText(err.body);
  return err instanceof Error ? err.message : String(err);
}
