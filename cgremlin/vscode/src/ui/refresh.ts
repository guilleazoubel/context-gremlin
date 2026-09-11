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
import {
  CoreHttpError,
  EngineNotRunningError,
  engineErrorText,
  type CoreClient,
} from '../core-client';
import { itemsTroubleOf, jiraAuthTroubleOf, type SourceTrouble } from '../model/engine-trouble';
import type { NotificationLevel } from '../model/notify-policy';
import type { CoreConfigView } from '../model/items';
import { ticketTrouble, type ItemsResponse, type WorkItem } from '../model/work-items';
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
  /** How long a dropped connection must stay down before it is said out loud (P0-1). */
  offlineGraceMs?: number;
}

const DEFAULT_COALESCE_MS = 150;
/**
 * P0-1. The event stream drops on every engine restart and on every hiccup, and the consumer
 * reconnects on a 1/2/5/10 s backoff — so a banner raised on the first drop flaps for reasons the
 * user cannot act on. Eight seconds is past the third reconnect: long enough that a restart and a
 * hiccup pass in silence, short enough that a genuinely absent engine is still reported promptly.
 */
export const OFFLINE_GRACE_MS = 8_000;

export class RefreshCoordinator {
  private snapshot: WorkItem[] = [];
  private resolved: CoreConfigView | null = null;
  private connected = false;
  private seeded = false;
  private currentSessionId: string | null = null;
  private currentWorktreePath: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timerPending = false;
  private sourceTrouble: SourceTrouble | null = null;
  /**
   * R35's other half. Kept apart from `sourceTrouble` on purpose: an engine that cannot list the
   * work replaces the lists, whereas a Jira that rejected the token leaves every PR row exactly
   * where it was and only colours the bar (the panel says the rest, in its banner).
   */
  private jiraTrouble: SourceTrouble | null = null;
  /** Cancels the pending "not reachable" verdict while it is waiting out its window (P0-1). */
  private cancelOfflineGrace: (() => void) | null = null;
  /** Whether the verdict has actually been said, which is what makes it once per outage. */
  private offlineShown = false;

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
          this.connectionDropped();
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
    this.reportAlive();
    this.deps.notifications.reportOnline();

    const previous = this.snapshot;
    this.snapshot = response?.items ?? [];
    // §3.3: one refresh is ONE render. Three posts is three reconciles in the webview and three
    // chances for the order to move under the pointer.
    this.deps.panel.batch(() => {
      this.deps.panel.setConnected(true);
      this.deps.panel.setItems(response);
    });
    this.renderStatus();

    // The first snapshot seeds the diff without popping: on activation every item is *already* in
    // its state, and announcing all of them would train the user to dismiss cgremlin popups.
    if (this.seeded) {
      this.deps.notifications.apply(previous, this.snapshot, this.deps.notificationLevel());
    }
    this.seeded = true;
  }

  /**
   * An engine that answers but cannot list the work is **said out loud**, never rendered as four
   * empty lists: a 404 means the engine is older than this extension and the fix is one restart
   * away, and anything else is shown with the engine's own wording. Both replace the lists and
   * both warn in the status bar, exactly as engine trouble does (Phase 8's lesson: silence is
   * the bug).
   */
  private async readItems(): Promise<ItemsResponse | null> {
    try {
      const response = await this.deps.client.items();
      this.setSourceTrouble(null);
      const jira = ticketTrouble(response.ticketSource);
      this.jiraTrouble = jira === null ? null : jiraAuthTroubleOf(jira.message, jira.statusText);
      return response;
    } catch (err) {
      if (err instanceof CoreHttpError) {
        this.deps.host.log(`cgremlin: GET /items failed (${err.status})`);
        this.setSourceTrouble(itemsTroubleOf(err.status, engineErrorText(err.body)));
        return null;
      }
      throw err;
    }
  }

  private setSourceTrouble(trouble: SourceTrouble | null): void {
    this.sourceTrouble = trouble;
    this.deps.panel.setSourceTrouble(trouble);
  }

  setCurrentSession(sessionId: string | null, worktreePath: string | null): void {
    this.currentSessionId = sessionId;
    this.currentWorktreePath = worktreePath;
    this.renderStatus();
  }

  /**
   * The connection went away — one failed poll, one dropped stream. NOT a verdict: P0-1's window
   * has to pass with nothing getting through before "the engine is not reachable" is said, and
   * the last snapshot stays on screen throughout, because four empty lists claim something the
   * extension does not know.
   */
  connectionDropped(): void {
    if (this.offlineShown || this.cancelOfflineGrace !== null) return;
    this.cancelOfflineGrace = this.deps.host.setTimeout(() => {
      this.cancelOfflineGrace = null;
      this.offlineShown = true;
      this.markOffline();
      this.deps.notifications.reportOffline();
    }, this.deps.offlineGraceMs ?? OFFLINE_GRACE_MS);
  }

  /** Anything that got through — a request, a frame — clears the drop, pending or already said. */
  reportAlive(): void {
    this.cancelOfflineGrace?.();
    this.cancelOfflineGrace = null;
    this.offlineShown = false;
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
      sourceTrouble: this.sourceTrouble ?? this.jiraTrouble,
    });
  }

  async settled(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight;
    }
  }
}
