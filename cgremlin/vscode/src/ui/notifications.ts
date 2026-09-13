/**
 * The popup surface.
 *
 * The policy itself is pure (`model/notify-policy.ts`) and filters on the core's own
 * `attention.needsYou` (R22); this file only shows what it returns and dispatches the two actions.
 *
 * P3: at every level but `all` this surface shows nothing at all. The news lives in the panel's
 * needs-you strip, the view-container badge and the status bar; `warn` stays, because a command
 * the user just clicked failing is an answer to THAT click and belongs where the click was.
 */
import { decideNotifications, type NotificationLevel, type Popup } from '../model/notify-policy';
import type { WorkItem } from '../model/work-items';
import { PendingWork, type Host } from './host';

const OPEN = 'Open';
const ACK = 'Ack';
const START_IT = 'Start it';
const SETTINGS = 'Settings';
export const NOT_RUNNING_MESSAGE = 'cgremlin engine is not running';

export class NotificationSurface {
  private readonly pending = new PendingWork();
  private offlineWarned = false;

  constructor(private readonly host: Host) {}

  /**
   * Dispatches one popup per item that entered needs-you. Deliberately does not await them: a
   * popup's promise settles when the user dismisses it, which may be never.
   */
  apply(prev: WorkItem[], next: WorkItem[], level: NotificationLevel): void {
    for (const popup of decideNotifications(prev, next, level)) {
      this.pending.track(this.show(popup));
    }
  }

  private async show(popup: Popup): Promise<void> {
    const answer = await this.host.showInformationMessage(popup.message, undefined, OPEN, ACK);
    // R31: `Ack` is ONE request — `POST /items/<path>/ack` — and the core fans out over every
    // ref the item contributes. The extension never loops over refs itself.
    if (answer === OPEN) await this.host.executeCommand('cgremlin.openItem', popup.id);
    else if (answer === ACK) await this.host.executeCommand('cgremlin.ack', popup.id);
  }

  /**
   * One warning per outage, not one per retry: the SSE client keeps reconnecting with backoff and
   * a dialog per attempt would be unusable.
   */
  reportOffline(level: NotificationLevel): void {
    if (this.offlineWarned) return;
    this.offlineWarned = true;
    // P3: engine trouble is explained in the panel, which already paints it and offers the same
    // two actions. A popup on top of that is the same sentence twice, over whatever the user was
    // doing — so it happens only when the level explicitly asks for every popup.
    if (level !== 'all') return;
    this.pending.track(this.showOffline());
  }

  private async showOffline(): Promise<void> {
    const answer = await this.host.showWarningMessage(
      NOT_RUNNING_MESSAGE,
      undefined,
      START_IT,
      SETTINGS,
    );
    if (answer === START_IT) await this.host.executeCommand('cgremlin.engine.start');
    else if (answer === SETTINGS) {
      await this.host.executeCommand('workbench.action.openSettings', 'cgremlin');
    }
  }

  reportOnline(): void {
    this.offlineWarned = false;
  }

  /** Any engine message that has no policy behind it — a failed command, a bad response. */
  warn(message: string): void {
    this.pending.track(this.host.showWarningMessage(message, undefined).then(() => undefined));
  }

  settled(): Promise<void> {
    return this.pending.settled();
  }
}
