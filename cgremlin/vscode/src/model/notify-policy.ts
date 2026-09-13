/**
 * Which attention change raises a popup.
 *
 * The core already answered "does this want ME" on every item (R22), so this policy filters on
 * `attention.needsYou` and on the user's level — nothing else. There is deliberately no copy of
 * the core's needs-you reason list here; `reasons` is used only to compose the text.
 *
 * P3: the popup is the narrow case. `needs-you-only` — the default — raises none at all; the
 * news reaches the user through the panel's strip, the view badge and the status bar instead.
 *
 * Pure module — no editor API (MG-B1).
 */
import type { WorkItem } from './work-items';

export type NotificationLevel = 'all' | 'needs-you-only' | 'off';

export interface Popup {
  /** The work item's own id (R24) — `Open` and `Ack` both address it by that. */
  id: string;
  message: string;
  reasons: string[];
}

/**
 * Diffs two snapshots of **work items, keyed by `item.id`** (R24), and returns one popup per item
 * that entered `needsYou` — or that gained a reason while already needing you. Losing a reason is
 * badge-only, and so is every item the core did not flag. `needsYou` is the **core's** flag: there
 * is deliberately no copy of its reason list here (MG-B2).
 */
export function decideNotifications(
  prev: WorkItem[],
  next: WorkItem[],
  level: NotificationLevel,
): Popup[] {
  // P3: a toast is an OPT-IN now. `needs-you-only` — the default — is the strip, the badge and
  // the status bar, which is the same news without the interruption over whatever the user was
  // typing into. Only `all` still pops, because that is what asking for `all` means.
  if (level !== 'all') return [];
  const before = new Map(prev.map((item) => [item.id, item]));
  const popups: Popup[] = [];
  for (const item of next) {
    if (!item.needsYou) continue;
    const was = before.get(item.id);
    const entered = was === undefined || !was.needsYou;
    const gained =
      was !== undefined && item.attention.reasons.some((r) => !was.attention.reasons.includes(r));
    if (!entered && !gained) continue;
    popups.push({
      id: item.id,
      message: `${item.title} — ${item.attention.reasons.join(', ')}`,
      reasons: [...item.attention.reasons],
    });
  }
  return popups;
}
