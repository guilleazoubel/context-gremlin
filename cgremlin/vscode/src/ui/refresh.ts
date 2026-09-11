/**
 * The refresh pipeline: one coalescing window, **one** request, one render.
 *
 * R24: a refresh is `GET /items` and nothing else. The four lists, the ticket source and the
 * thread source all arrive in that one response, so two answers can never disagree mid-scan —
 * and three round trips per SSE burst over a Unix socket was measurable at 58 PRs.
 *
 * The engine's event stream is chatty by design (a burst of `attention.changed` per stage), so
 * every trigger calls `schedule()` and a batch is applied once. The notification diff runs here
 * because it must see exactly the snapshot the panel and the status bar were built from.
 */
import { CoreHttpError, EngineNotRunningError, type CoreClient } from '../core-client';
import type { NotificationLevel } from '../model/notify-policy';
import type { CoreConfigView } from '../model/items';
import type { ItemsResponse, WorkItem } from '../model/work-items';
import type { Host } from './host';
import type { PanelView } from './panel-view';
import type { NotificationSurface } from './notifications';
import type { StatusBar } from './status-bar';

export interface RefreshCoordinatorDeps {
  host: Host;
  client: CoreClient;
  panel: PanelView;
  statusBar: StatusBar;
  notifications: NotificationSurface;
  notificationLevel: () => NotificationLevel;
  /** The coalescing window. 0 would still batch (one macrotask), but a few ms batches a burst. */
  coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 150;

export class RefreshCoordinator {
  private snapshot: WorkItem[] = [];
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

  items(): WorkItem[] {
    return this.snapshot;
  }

  itemOf(id: string): WorkItem | undefined {
    return this.snapshot.find((item) => item.id === id);
  }

  currentSession(): string | null {
    return this.currentSessionId;
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
    const response = await this.readItems();
    this.connected = true;
    this.deps.notifications.reportOnline();

    const previous = this.snapshot;
    this.snapshot = response?.items ?? [];
    this.deps.panel.setConnected(true);
    this.deps.panel.setItems(response);
    this.renderStatus();

    // The first snapshot seeds the diff without popping: on activation every item is *already* in
    // its state, and announcing all of them would train the user to dismiss cgremlin popups.
    if (this.seeded) {
      this.deps.notifications.apply(previous, this.snapshot, this.deps.notificationLevel());
    }
    this.seeded = true;
  }

  /**
   * `GET /items` 404s on an engine older than Phase 9, and there may be nothing to group before
   * the first scan. Neither is a reason to tear the panel down: the lists go empty and the next
   * tick fills them.
   */
  private async readItems(): Promise<ItemsResponse | null> {
    try {
      return await this.deps.client.items();
    } catch (err) {
      if (err instanceof CoreHttpError) {
        this.deps.host.log(`cgremlin: GET /items failed (${err.status})`);
        return null;
      }
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
    this.deps.panel.setConnected(false);
    this.renderStatus();
  }

  /**
   * R43: the status bar finds the **selected agent** inside `agents[]` and reads `phase`,
   * `running` and `needsYou` off that `WorkItemAgent` — one level deeper than the `/attention`
   * lookup it replaces. `needYou` counts *items*, not agents: one badge per row the user would
   * click. With no agent selected it shows the connection state and the count, as before.
   */
  private renderStatus(): void {
    const current =
      this.currentSessionId === null
        ? undefined
        : this.snapshot
            .flatMap((item) => item.agents)
            .find((agent) => agent.sessionId === this.currentSessionId);
    this.deps.statusBar.render({
      connected: this.connected,
      needYou: this.snapshot.filter((item) => item.needsYou).length,
      currentSessionId: this.currentSessionId,
      currentPhase: current?.phase ?? null,
      currentWorktreePath: this.currentWorktreePath,
    });
  }

  async settled(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }
  }
}
