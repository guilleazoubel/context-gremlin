/**
 * The composition root's body.
 *
 * `extension.ts` builds a real {@link Host} from the `vscode` namespace and calls `createUi`;
 * the tests build a fake one and call the same function. That is deliberate: there is no
 * test-only wiring to drift from what ships.
 */
import { CoreHttpError, EngineNotRunningError, type CoreClient } from '../core-client';
import { troubleOf } from '../model/engine-trouble';
import { qaReposOf } from '../model/items';
import { currentAgentOf } from '../model/lifecycle';
import { itemPathOf, type ItemArtifactListing } from '../model/work-items';
import type { NotificationLevel } from '../model/notify-policy';
import { PanelView, PANEL_VIEW_ID } from './panel-view';
import { NotificationSurface } from './notifications';
import { StatusBar } from './status-bar';
import { RefreshCoordinator } from './refresh';
import { WorktreeSwapper } from './preview';
import { ItemTab, type ItemTabAssets } from './item-tab';
import { ChatSessions } from './terminal';
import { registerCommands } from './commands';
import type { EngineSurface } from './engine';
import type { DisposableLike, Host } from './host';

/** The single view the four lists live in — a webview since R54. Matches `contributes.views`. */
export const VIEW_ID = PANEL_VIEW_ID;

export interface UiOptions {
  host: Host;
  client: CoreClient;
  notificationLevel: () => NotificationLevel;
  /**
   * The engine's own surface: its four commands and the status bar's engine half. Optional only
   * so a test can compose the rest of the UI without one.
   */
  engine?: EngineSurface;
  coalesceMs?: number;
  /**
   * R62: the webview bundle and stylesheet as TEXT, read by `extension.ts` at activation. A test
   * passes literals, so no unit test depends on `build:webview` having run.
   */
  assets?: { itemTab: ItemTabAssets; panel: ItemTabAssets; mediaPath: string };
}

export interface Ui {
  readonly panel: PanelView;
  readonly itemTab: ItemTab;
  readonly statusBar: StatusBar;
  readonly notifications: NotificationSurface;
  readonly coordinator: RefreshCoordinator;
  readonly chat: ChatSessions;
  /** `GET /config` then the first snapshot. `false` means the engine is not running. */
  connect(): Promise<boolean>;
  /**
   * One `/events` frame. R41: its payload is read as an **address** and never as content — the
   * open Item tab refetches only when the id is its own, and everything else coalesces into one
   * `/items` refresh.
   */
  handleFrame(frame: unknown): void;
  /** The SSE consumer lost its connection (or never had one). */
  offline(): Promise<void>;
  settled(): Promise<void>;
  dispose(): Promise<void>;
}

export function createUi(options: UiOptions): Ui {
  const { host, client } = options;
  const statusBar = new StatusBar(host);
  const notifications = new NotificationSurface(host);
  const panel: PanelView = new PanelView({
    host,
    assets: options.assets?.panel ?? { scriptText: '', styleText: '' },
    mediaPath: options.assets?.mediaPath ?? '',
    onOpenItem: async (id) => {
      await host.executeCommand('cgremlin.openItem', id);
    },
    onOpenChild: async (id, childId) => {
      await host.executeCommand('cgremlin.openChild', id, childId);
    },
    onCommand: async (command, id, childId) => {
      await host.executeCommand(command, id, childId);
    },
    /**
     * §4, amended: the click that selects a row also puts that item's own worktree in the
     * workspace, through the same swap path (and the same dirty-editor confirm) the Item tab
     * uses. An item with no session to open swaps nothing rather than guessing.
     */
    /** §8's gate: which repos have a `qa.url`, straight off the resolved `GET /config`. */
    qaRepos: () => qaReposOf(coordinator.config()),
    onSelect: async (id) => {
      const agent = currentAgentOf(coordinator.itemOf(id)?.agents ?? []);
      if (agent?.worktreePath == null) return;
      coordinator.setCurrentSession(agent.sessionId, agent.worktreePath);
      await swapper.swapTo(agent.sessionId, agent.worktreePath);
    },
    /** What the ONE expanded row needs and the list response does not carry (§4, amended). */
    loadExpanded: async (item) => {
      // P11: a read that finds no engine is not a reason to refuse the row. The panel expands
      // from the snapshot it already has and says, in one line, that the detail is stale — the
      // parts, the PR and the ticket are all in hand, and opening either needs no engine.
      let offline = false;
      const note = (err: unknown): null => {
        if (err instanceof EngineNotRunningError) offline = true;
        return null;
      };
      const path = itemPathOf(item.id);
      const detail = path === null ? null : await client.item(path).catch(note);
      const artifactAt: Record<string, string | null> = {};
      for (const [sessionId, listing] of Object.entries(detail?.artifacts ?? {})) {
        artifactAt[sessionId] = latestArtifactAt(listing);
      }
      const agent = currentAgentOf(item.agents);
      const changes = agent === null ? null : await client.changes(agent.sessionId).catch(note);
      return { artifactAt, changes, offline };
    },
  });
  const coordinator = new RefreshCoordinator({
    host,
    client,
    panel,
    statusBar,
    notifications,
    notificationLevel: options.notificationLevel,
    coalesceMs: options.coalesceMs,
  });
  const chat = new ChatSessions({
    host,
    client,
    ttlMs: () => coordinator.config()?.humanTurnTtlMs,
  });
  const swapper = new WorktreeSwapper({
    host,
    config: () => coordinator.config(),
    // P10: the offer that used to be a popup on every row click. The panel decides whether to
    // paint it — it is the half that remembers a "Not now".
    onOfferManaged: () => panel.setWorkspaceOffer(true),
  });
  const itemTab = new ItemTab({
    host,
    client,
    config: () => coordinator.config(),
    assets: options.assets?.itemTab ?? { scriptText: '', styleText: '' },
    mediaPath: options.assets?.mediaPath ?? '',
    swapper,
    onOpened: (sessionId, worktreePath) => coordinator.setCurrentSession(sessionId, worktreePath),
  });
  const disposables: DisposableLike[] = [
    host.registerWebviewViewProvider(VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    host.onDidCloseTerminal((terminal) => chat.handleClosed(terminal)),
    ...registerCommands({
      host,
      client,
      coordinator,
      panel,
      itemTab,
      chat,
      swapper,
      engine: options.engine,
    }),
  ];
  if (options.engine !== undefined) {
    const engine = options.engine;
    disposables.push(...engine.register());
    const unsubscribe = engine.onState((status) => {
      statusBar.setEngine(status);
      // An engine that cannot be used replaces the four lists with one row that says so; the
      // moment a usable one is adopted, the lists come back.
      panel.setTrouble(troubleOf(status));
    });
    disposables.push({ dispose: unsubscribe });
  }

  // P0-1: a drop is reported to the coordinator, which decides whether it has lasted long enough
  // to be worth saying. Nothing here blanks a list: the last snapshot outlives a hiccup.
  const offline = async (): Promise<void> => {
    coordinator.connectionDropped();
    await Promise.resolve();
  };

  return {
    panel,
    itemTab,
    statusBar,
    notifications,
    coordinator,
    chat,
    async connect() {
      try {
        await coordinator.connect();
        return true;
      } catch (err) {
        if (err instanceof EngineNotRunningError) {
          await offline();
          return false;
        }
        // Something answered, and did not recognise the route. That is an engine this extension
        // cannot use — the same fact a `foreign` probe reports, and it earns the same
        // explanation rather than a bare 404 and an empty panel.
        if (err instanceof CoreHttpError && err.status === 404 && options.engine !== undefined) {
          host.log(`cgremlin: the engine did not recognise ${err.message}`);
          options.engine.reportUnusable();
          return false;
        }
        host.log(`cgremlin: could not read the engine's state: ${String(err)}`);
        notifications.warn(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    offline,
    handleFrame(frame: unknown) {
      // A frame arriving is proof the stream is up, whatever the frame says (P0-1).
      coordinator.reportAlive();
      const { event, id } = addressOf(frame);
      if (event === 'item.changed' && id !== null) {
        // The panel's open row is re-read only when something it shows moved; a frame that names
        // the item is the engine saying so directly.
        panel.noteFrame(id, null);
        if (id === itemTab.itemId()) void itemTab.itemChanged(id);
      }
      if (event === 'artifact.changed') {
        const { sessionId, name } = artifactAddressOf(frame);
        if (sessionId !== null) panel.noteFrame(null, sessionId);
        if (sessionId !== null && name !== null) void itemTab.artifactChanged(sessionId, name);
      }
      coordinator.schedule();
    },
    async settled() {
      await options.engine?.settled();
      await coordinator.settled();
      await notifications.settled();
      await chat.settled();
    },
    async dispose() {
      await chat.releaseAll();
      for (const disposable of disposables.splice(0)) disposable.dispose();
      itemTab.dispose();
      statusBar.dispose();
      panel.dispose();
    },
  };
}

/**
 * A frame's payload, read as an address and nothing else (R41): the `event` name and the `id`
 * the change is about. Nothing branches on the absence of `changedFields`.
 */
function addressOf(frame: unknown): { event: string | null; id: string | null } {
  if (typeof frame !== 'object' || frame === null) return { event: null, id: null };
  const event = (frame as { event?: unknown }).event;
  const data = (frame as { data?: unknown }).data;
  const id = typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  return {
    event: typeof event === 'string' ? event : null,
    id: typeof id === 'string' ? id : null,
  };
}

function artifactAddressOf(frame: unknown): { sessionId: string | null; name: string | null } {
  const data = (frame as { data?: unknown } | null)?.data;
  if (typeof data !== 'object' || data === null) return { sessionId: null, name: null };
  const sessionId = (data as { sessionId?: unknown }).sessionId;
  const name = (data as { name?: unknown }).name;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    name: typeof name === 'string' ? name : null,
  };
}

/**
 * The newest artifact a session has written — what dates a finished lifecycle slot. The engine
 * sends the whole listing; the row only needs "when did this stage last produce something".
 */
function latestArtifactAt(listing: readonly ItemArtifactListing[]): string | null {
  let latest: string | null = null;
  for (const artifact of listing) {
    if (latest === null || artifact.mtime > latest) latest = artifact.mtime;
  }
  return latest;
}
