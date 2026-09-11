/**
 * The popup surface.
 *
 * The policy itself is pure (`model/notify-policy.ts`) and filters on the core's own
 * `attention.needsYou` (R22); this file only shows what it returns and dispatches the two actions.
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
  reportOffline(): void {
    if (this.offlineWarned) return;
    this.offlineWarned = true;
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
