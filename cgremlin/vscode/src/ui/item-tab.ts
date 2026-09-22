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
import nodePath from 'node:path';
import { CoreHttpError, engineErrorText, type CoreClient } from '../core-client';
import { ciDot, itemPathOf, type WorkItem, type WorkItemPr, prState } from '../model/work-items';
import { headlineOf, prLabel } from '../model/row-composition';
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
import { qaReposOf, qaStatusesOf } from '../model/items';
import { partsOf } from '../model/item-tab-parts';
import { primaryArtifactName } from '../model/artifact-labels';
import { RunOutputStore, type RunOutputView } from '../model/run-output';
import type { CoreConfigView } from '../model/items';
import { withEngineRetry, type EngineRevival } from './engine-retry';
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
  /**
   * Defect 4 — the set of watched sessions changed, so the SSE client must re-ask the engine for
   * (or stop asking it for) `run.output`. Optional: a host that does not stream simply never
   * renegotiates, and the pane then shows only what the frames it already gets carry.
   */
  onWatchChanged?: () => void;
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
  /** Defect 4 — the live-output buffers. Empty is the normal state; see `model/run-output`. */
  private readonly runOutput = new RunOutputStore();
  private pending: Promise<unknown>[] = [];

  constructor(private readonly deps: ItemTabDeps) {}

  itemId(): string | null {
    return this.detail?.item.id ?? null;
  }

  /**
   * Opens (or re-points) the one panel at `path`, optionally focused on one of its parts.
   *
   * `revive` is how a user command asks for an engine that is not there (`ui/engine-retry`): the
   * fetch is sent again after a user-triggered start, and only a second failure is reported.
   */
  async open(path: string, focus?: ItemFocusMessage, revive?: EngineRevival): Promise<void> {
    let detail: ItemDetailResponse;
    try {
      detail = await withEngineRetry(revive, () => this.deps.client.item(path));
    } catch (err) {
      void this.deps.host.showWarningMessage(messageOf(err), undefined);
      return;
    }
    // A different item is a different run: the buffers belong to the pane that showed them.
    if (this.detail !== null && this.detail.item.id !== detail.item.id) this.stopWatching();
    this.path = path;
    this.detail = detail;
    this.focus = resolveFocus(detail.item, artifactNamesOf(detail), focus);
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
    this.focus =
      this.detail === null
        ? { kind: 'agent', sessionId }
        : resolveFocus(this.detail.item, artifactNamesOf(this.detail), { kind: 'agent', sessionId });
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
    this.stopWatching();
  }

  // --- Defect 4: watching a live run ---------------------------------------

  /** Whether any pane is watching, which is exactly when the SSE include belongs on. */
  watching(): boolean {
    return this.runOutput.watching();
  }

  /** What the pane for `sessionId` is holding, or `null` when nothing is watching it. */
  runOutputOf(sessionId: string): RunOutputView | null {
    return this.runOutput.viewOf(sessionId);
  }

  /**
   * Open the Output pane on a session and start listening.
   *
   * `alreadyRunning` is read from the agent the engine last reported: a run in flight when the
   * buffer opens has a beginning this window can never recover, and the pane says so rather than
   * showing a partial stream as though it were the whole one.
   */
  async watchRun(sessionId: string): Promise<void> {
    const agent = this.detail?.item.agents.find((one) => one.sessionId === sessionId);
    const live = agent?.running === true;
    this.runOutput.open(sessionId, {
      alreadyRunning: live,
      stage: agent?.lastRun?.stage ?? null,
      live,
    });
    this.selected = sessionId;
    this.focus = { kind: 'runOutput', sessionId };
    this.show();
    this.render();
    this.deps.onWatchChanged?.();
    await Promise.resolve();
  }

  /** One `run.output` chunk — the ONE frame payload read as content (the R41 exception). */
  noteRunOutput(sessionId: string, data: string): void {
    if (this.runOutput.viewOf(sessionId) === null) return;
    this.runOutput.append(sessionId, data);
    this.render();
  }

  /** The run stopped underneath a watcher: the pane freezes and the include comes back off. */
  noteRunFinished(sessionId: string, outcome: string | null): void {
    if (this.runOutput.viewOf(sessionId) === null) return;
    this.runOutput.finish(sessionId, { outcome });
    this.render();
    this.deps.onWatchChanged?.();
  }

  private stopWatching(): void {
    // A FROZEN buffer is not "watching" (the include is already off for it) but it is still a
    // buffer, and it goes with the pane that showed it. The renegotiation is only owed where the
    // include was actually on.
    const wasWatching = this.runOutput.watching();
    this.runOutput.closeAll();
    if (wasWatching) this.deps.onWatchChanged?.();
  }

  // --- internals -----------------------------------------------------------

  private track(work: Promise<unknown>): void {
    this.pending.push(work);
  }

  /** The tab's name: the row's own headline, so one piece of work has one name (Task 1). */
  private titleText(): string {
    return this.detail === null ? 'cgremlin' : headlineOf(this.detail.item);
  }

  private show(): void {
    if (this.panel !== null) {
      this.panel.title = this.titleText();
      this.panel.reveal(true);
      return;
    }
    const panel = this.deps.host.createWebviewPanel({
      viewType: ITEM_TAB_VIEW_TYPE,
      title: this.titleText(),
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
      case 'openFile':
        await this.openFile(message.path, message.line);
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

  /**
   * §3 — a `path:line` clicked inside a review, opened only where all four clauses hold.
   *
   * The webview is untrusted input and a review is written by an agent, so neither is allowed to
   * name a file: the path must be relative, must not climb out once normalised, must resolve
   * inside the SELECTED agent's worktree, and must exist. Any failure is one warning that names
   * the path the user clicked — never a silent no-op, and never a guess at what they meant.
   */
  private async openFile(path: string, line: number): Promise<void> {
    const agent = this.detail?.item.agents.find((a) => a.sessionId === this.selected);
    const root = agent?.worktreePath ?? null;
    const refuse = async (): Promise<void> => {
      await this.deps.host.showWarningMessage(
        `cgremlin: ${path} is not a file in this agent's worktree.`,
        undefined,
      );
    };
    if (root === null || path === '' || nodePath.isAbsolute(path)) return refuse();
    const resolved = nodePath.resolve(root, path);
    if (resolved !== root && !resolved.startsWith(`${root}${nodePath.sep}`)) return refuse();
    if (!this.deps.host.fileExists(resolved)) return refuse();
    await this.deps.host.openTextDocument(resolved, line);
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
      // Task 1 — the SAME headline the row draws (`headlineOf`), never the engine's raw title:
      // that one is `HB-1490 — <ticket summary>` and carries no pull request number.
      title: headlineOf(item),
      needsYou: item.needsYou,
      chips: [
        ...(item.ticket === null ? [] : [{ label: item.ticket.key, url: item.ticket.url }]),
        ...item.prs.map((pr) => ({ label: prLabel(pr), url: pr.url })),
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
              assigneeName:
                (detail.ticket as { assigneeName?: string | null }).assigneeName ?? null,
              descriptionText: detail.ticket.descriptionText,
              comments: detail.ticket.comments,
            },
      ticketError: detail.ticketError,
      lists: [...item.lists],
      qaRepos: qaReposOf(this.deps.config()),
      qaStatuses: qaStatusesOf(this.deps.config()),
      qaUnreachable: item.qaAttempt?.outcome === 'unreachable',
      buttons: [],
      parts: [],
    };
    state.buttons = buttonsFor(state);
    state.parts = partsOf(state);
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
      runFailed: agent?.runFailed ?? false,
      needsYou: agent?.needsYou ?? false,
      claimed: agent?.claimed ?? false,
      // Defect 4 — `null` unless a pane is watching, which is what keeps the Output part absent.
      runOutput: this.runOutput.viewOf(sessionId),
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

/** The artifact names the engine listed, per session — what an artifact focus is checked against. */
function artifactNamesOf(detail: ItemDetailResponse): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [sessionId, listings] of Object.entries(detail.artifacts)) {
    out[sessionId] = listings.map((listing) => listing.name);
  }
  return out;
}

/**
 * An unknown focus falls back to the primary agent rather than rendering blank (R48).
 *
 * Phase 17 §1: an AGENT focus resolves one step further, to that agent's primary artifact, so the
 * pane opens on the answer rather than on a pane that no longer exists. An artifact focus naming a
 * file the engine did not list falls back the same way — the union is parsed from untrusted
 * webview input and drives the worktree swap, so it may never resolve to nothing.
 */
function resolveFocus(
  item: WorkItem,
  names: Record<string, string[]>,
  requested?: ItemFocusMessage,
): ItemFocusMessage {
  if (requested !== undefined) {
    if (requested.kind === 'agent') {
      if (item.agents.some((agent) => agent.sessionId === requested.sessionId)) {
        return openingFocusOf(requested.sessionId, names);
      }
    } else if (requested.kind === 'artifact') {
      const known = names[requested.sessionId] ?? [];
      if (known.includes(requested.name)) return requested;
      if (item.agents.some((agent) => agent.sessionId === requested.sessionId)) {
        return openingFocusOf(requested.sessionId, names);
      }
    } else if (requested.kind === 'pr') {
      if (item.prs.some((pr) => pr.repo === requested.repo && pr.number === requested.number)) {
        return requested;
      }
    } else if (item.ticket !== null) {
      return requested;
    }
  }
  const primary = item.agents[0];
  if (primary !== undefined) return openingFocusOf(primary.sessionId, names);
  const pr = item.prs[0];
  if (pr !== undefined) return { kind: 'pr', repo: pr.repo, number: pr.number };
  return { kind: 'ticket' };
}

/** The agent's primary artifact where it has one, and the agent itself where it has none. */
function openingFocusOf(sessionId: string, names: Record<string, string[]>): ItemFocusMessage {
  const primary = primaryArtifactName(names[sessionId] ?? []);
  return primary === null
    ? { kind: 'agent', sessionId }
    : { kind: 'artifact', sessionId, name: primary };
}

function selectedFor(item: WorkItem | undefined, focus: ItemFocusMessage): string | null {
  if (item === undefined) return null;
  if (focus.kind === 'agent' || focus.kind === 'artifact') return focus.sessionId;
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
export const CHAT_TRIAGING_REASON =
  'Chat opens once the respond agent has written up the review threads. It is still triaging them.';

export function buttonsFor(state: ItemTabState): TabButton[] {
  const selected = state.agents.find((agent) => agent.sessionId === state.selectedSessionId);
  const triaging =
    selected !== undefined && selected.mode === 'respond' && selected.phase === 'triaging';
  // Phase 18 — the tab used to build these facts WITHOUT `qaRepos`, so §8's gate could never
  // pass here and the QA verbs existed on the panel rows alone. The tab reads the same config.
  const facts: ActionFacts = {
    agents: state.agents,
    prs: state.prs,
    ticketKey: state.ticket?.key ?? null,
    needsYou: state.needsYou,
    qaRepos: state.qaRepos ?? [],
    ticketStatus: state.ticket?.status ?? null,
    qaStatuses: state.qaStatuses ?? [],
    qaUnreachable: state.qaUnreachable === true,
  };
  const actions = rowActionsForLists(facts, state.lists);
  const buttons: TabButton[] = [];
  // §6: with no agent there is nothing to chat TO, so the button is not drawn — a disabled
  // control with `reason: undefined` explained nothing and is what made Chat look broken.
  //
  // Where it IS drawn, the rule decides its placement like every other verb's: an item whose
  // ladder is finished (every PR landed) has Chat promoted to its one click, and re-adding it
  // here as `inline` after the rule had already spent `primaryTaken` on it left the row with no
  // filled button and no next step at all.
  if (selected !== undefined) {
    const ruled = actions.find((action) => action.command === 'cgremlin.chat');
    buttons.push({
      id: 'cgremlin.chat',
      label: 'Chat',
      enabled: !triaging,
      placement: ruled?.placement === 'primary' ? 'primary' : 'inline',
      ...(triaging ? { reason: CHAT_TRIAGING_REASON } : {}),
    });
  }
  for (const action of actions) {
    if (action.command === 'cgremlin.chat') continue;
    // The chips above the row already ARE these links, and drawing them again is what made
    // three equal buttons out of one decision and two navigations (§6).
    if (action.command === 'cgremlin.openPr' || action.command === 'cgremlin.openTicket') continue;
    // Ack is the only overflow verb the tab draws, and it draws it last.
    if (action.placement === 'overflow' && action.command !== 'cgremlin.ack') continue;
    buttons.push({
      id: action.command,
      label: action.label,
      // Phase 18 — a verb the rule disabled arrives disabled here too, with its sentence: the
      // tab and the row say the same thing about the same item, or one of them is lying.
      enabled: action.enabled !== false,
      placement: action.placement === 'primary' ? 'primary' : 'inline',
      ...(action.reason === undefined ? {} : { reason: action.reason }),
    });
  }
  const rank = (button: TabButton): number => {
    if (button.placement === 'primary') return 0;
    return button.id === 'cgremlin.ack' ? 2 : 1;
  };
  return buttons.sort((a, b) => rank(a) - rank(b));
}

/** The path an item id is addressed at, re-exported so callers never build one by hand (R65). */
export { itemPathOf };

function messageOf(err: unknown): string {
  if (err instanceof CoreHttpError) return engineErrorText(err.body);
  return err instanceof Error ? err.message : String(err);
}
