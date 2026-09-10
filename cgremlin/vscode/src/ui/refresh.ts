/**
 * The refresh pipeline: one coalescing window, one refetch, one tree fire.
 *
 * The engine's event stream is chatty by design (a burst of `attention.changed` per stage), so
 * every trigger — an SSE frame, a resync, a command that changed something — calls `schedule()`
 * and a batch is applied once. That is what keeps "one `onDidChangeTreeData` per applied batch"
 * true, and it is why the notification diff runs here: it must see exactly the snapshot the tree
 * and the status bar were built from.
 */
import { buildLists } from '../model/view-model';
import { CoreHttpError, EngineNotRunningError, type CoreClient } from '../core-client';
import type { NotificationLevel } from '../model/notify-policy';
import type { AttentionItem, CoreConfigView, InventoryGroups, SessionView } from '../model/items';
import type { Host } from './host';
import type { CgremlinTreeProvider } from './tree';
import type { NotificationSurface } from './notifications';
import type { StatusBar } from './status-bar';

export interface RefreshCoordinatorDeps {
  host: Host;
  client: CoreClient;
  tree: CgremlinTreeProvider;
  statusBar: StatusBar;
  notifications: NotificationSurface;
  notificationLevel: () => NotificationLevel;
  /** The coalescing window. 0 would still batch (one macrotask), but a few ms batches a burst. */
  coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 150;

export class RefreshCoordinator {
  private snapshot: AttentionItem[] = [];
  private resolved: CoreConfigView | null = null;
  private connected = false;
  private seeded = false;
  private currentSessionId: string | null = null;
  private currentWorktreePath: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timerPending = false;

  constructor(private readonly deps: RefreshCoordinatorDeps) {}

  /** Throws `EngineNotRunningError` when the socket is not there — the caller owns that UX. */
  async connect(): Promise<void> {
    this.resolved = await this.deps.client.config();
    this.connected = true;
    await this.refreshNow();
  }

  config(): CoreConfigView | null {
    return this.resolved;
  }

  items(): AttentionItem[] {
    return this.snapshot;
  }

  schedule(): void {
    if (this.timerPending) return;
    this.timerPending = true;
    this.deps.host.setTimeout(() => {
      this.timerPending = false;
      this.run();
    }, this.deps.coalesceMs ?? DEFAULT_COALESCE_MS);
  }

  private run(): void {
    const work = this.refreshNow()
      .catch((err: unknown) => {
        if (err instanceof EngineNotRunningError) {
          this.markOffline();
          this.deps.notifications.reportOffline();
          return;
        }
        this.deps.host.log(`cgremlin: refresh failed: ${String(err)}`);
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
  }

  async refreshNow(): Promise<void> {
    const groups = await this.readGroups();
    const sessions = await this.readSessions();
    const listing = await this.deps.client.attention(true);
    this.connected = true;
    this.deps.notifications.reportOnline();

    const previous = this.snapshot;
    this.snapshot = listing.items;
    this.deps.tree.setLists(buildLists({ items: this.snapshot, groups, sessions }));
    this.deps.tree.refresh();
    this.renderStatus();

    // The first snapshot seeds the diff without popping: on activation every item is *already* in
    // its state, and announcing all of them would train the user to dismiss cgremlin popups.
    if (this.seeded) {
      this.deps.notifications.apply(previous, this.snapshot, this.deps.notificationLevel());
    }
    this.seeded = true;
  }

  /** `GET /prs` 404s before the first scan; the panel is attention-driven and copes with none. */
  private async readGroups(): Promise<InventoryGroups | null> {
    try {
      return (await this.deps.client.prs()).groups;
    } catch (err) {
      if (err instanceof CoreHttpError) return null;
      throw err;
    }
  }

  private async readSessions(): Promise<SessionView[]> {
    try {
      return (await this.deps.client.sessions()).sessions;
    } catch (err) {
      if (err instanceof CoreHttpError) return [];
      throw err;
    }
  }

  setCurrentSession(sessionId: string | null, worktreePath: string | null): void {
    this.currentSessionId = sessionId;
    this.currentWorktreePath = worktreePath;
    this.renderStatus();
  }

  markOffline(): void {
    this.connected = false;
    this.renderStatus();
  }

  private renderStatus(): void {
    const current = this.snapshot.find((item) => item.links.sessionId === this.currentSessionId);
    this.deps.statusBar.render({
      connected: this.connected,
      needYou: this.snapshot.filter((item) => item.attention.needsYou).length,
      currentSessionId: this.currentSessionId,
      currentPhase: current?.stageStatus ?? null,
      currentWorktreePath: this.currentWorktreePath,
    });
  }

  async settled(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }
  }
}
