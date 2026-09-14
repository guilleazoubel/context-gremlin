/**
 * What the extension is still allowed to say out loud — which is one thing.
 *
 * `warn` survives because a command the user just clicked failing is an ANSWER to that click: it
 * belongs where the click was, and there is nowhere else to put it. Everything else that used to
 * raise a dialog is gone. Needs-you is the panel's strip, the view-container badge and the
 * status-bar count; engine trouble is the panel's trouble row (which offers the same two actions
 * the old warning did) and the status bar. Neither interrupts.
 *
 * `apply` and `reportOffline` stay as the seams the refresh loop already calls, and they are
 * deliberately silent: keeping the call sites makes "this event raises nothing" a thing the
 * tests can assert about the surface rather than a thing they have to prove by absence.
 */
import type { NotificationLevel } from '../model/notify-policy';
import type { WorkItem } from '../model/work-items';
import { PendingWork, type Host } from './host';

export class NotificationSurface {
  private readonly pending = new PendingWork();

  constructor(private readonly host: Host) {}

  /** Items entering needs-you. Nothing is raised at any level — the strip and the badge say it. */
  apply(_prev: WorkItem[], _next: WorkItem[], _level: NotificationLevel): void {}

  /** The engine went away. The panel's trouble row and the status bar already carry it. */
  reportOffline(_level: NotificationLevel): void {}

  reportOnline(): void {}

  /** Any engine message that has no policy behind it — a failed command, a bad response. */
  warn(message: string): void {
    this.pending.track(this.host.showWarningMessage(message, undefined).then(() => undefined));
  }

  settled(): Promise<void> {
    return this.pending.settled();
  }
}
