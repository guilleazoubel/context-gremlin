/**
 * The composition root's body.
 *
 * `extension.ts` builds a real {@link Host} from the `vscode` namespace and calls `createUi`;
 * the tests build a fake one and call the same function. That is deliberate: there is no
 * test-only wiring to drift from what ships.
 */
import { EngineNotRunningError, type CoreClient } from '../core-client';
import type { NotificationLevel } from '../model/notify-policy';
import { CgremlinTreeProvider } from './tree';
import { NotificationSurface } from './notifications';
import { StatusBar } from './status-bar';
import { RefreshCoordinator } from './refresh';
import { ItemOpener } from './preview';
import { ChatSessions } from './terminal';
import { registerCommands } from './commands';
import type { EngineSurface } from './engine';
import type { DisposableLike, Host } from './host';

/** The single tree view the four lists are roots of. Must match `contributes.views`. */
export const VIEW_ID = 'cgremlin.items';

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
}

export interface Ui {
  readonly tree: CgremlinTreeProvider;
  readonly statusBar: StatusBar;
  readonly notifications: NotificationSurface;
  readonly coordinator: RefreshCoordinator;
  readonly chat: ChatSessions;
  /** `GET /config` then the first snapshot. `false` means the engine is not running. */
  connect(): Promise<boolean>;
  /** The SSE consumer lost its connection (or never had one). */
  offline(): Promise<void>;
  settled(): Promise<void>;
  dispose(): Promise<void>;
}

export function createUi(options: UiOptions): Ui {
  const { host, client } = options;
  const tree = new CgremlinTreeProvider(host);
  const statusBar = new StatusBar(host);
  const notifications = new NotificationSurface(host);
  const coordinator = new RefreshCoordinator({
    host,
    client,
    tree,
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
  const opener = new ItemOpener({
    host,
    client,
    config: () => coordinator.config(),
    onOpened: (sessionId, worktreePath) => coordinator.setCurrentSession(sessionId, worktreePath),
  });

  const disposables: DisposableLike[] = [
    host.registerTreeDataProvider(VIEW_ID, tree),
    host.onDidCloseTerminal((terminal) => chat.handleClosed(terminal)),
    ...registerCommands({ host, client, coordinator, opener, chat }),
  ];
  if (options.engine !== undefined) {
    const engine = options.engine;
    disposables.push(...engine.register());
    const unsubscribe = engine.onState((status) => statusBar.setEngine(status));
    disposables.push({ dispose: unsubscribe });
  }

  const offline = async (): Promise<void> => {
    coordinator.markOffline();
    notifications.reportOffline();
    await Promise.resolve();
  };

  return {
    tree,
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
        host.log(`cgremlin: could not read the engine's state: ${String(err)}`);
        notifications.warn(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    offline,
    async settled() {
      await options.engine?.settled();
      await coordinator.settled();
      await notifications.settled();
      await chat.settled();
    },
    async dispose() {
      await chat.releaseAll();
      for (const disposable of disposables.splice(0)) disposable.dispose();
      statusBar.dispose();
      tree.dispose();
    },
  };
}
