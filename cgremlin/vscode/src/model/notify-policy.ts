/**
 * Which attention change raises a popup.
 *
 * The core already answered "does this want ME" on every item (R22), so this policy filters on
 * `attention.needsYou` and on the user's level — nothing else. There is deliberately no copy of
 * the core's needs-you reason list here; `reasons` is used only to compose the text.
 *
 * Pure module — no editor API (MG-B1).
 */
import { displayTitle } from './items';
import type { AttentionItem, AttentionReason, ItemRef, ItemSource } from './items';

export type NotificationLevel = 'all' | 'needs-you-only' | 'off';

export interface Popup {
  ref: ItemRef;
  source: ItemSource;
  message: string;
  reasons: AttentionReason[];
}

/**
 * Diffs two snapshots **keyed by `ref`**, never by source, and returns one popup per item that
 * entered `needsYou` — or that gained a reason while already needing you. Losing a reason is
 * badge-only, and so is every item the core did not flag.
 */
export function decideNotifications(
  prev: AttentionItem[],
  next: AttentionItem[],
  level: NotificationLevel,
): Popup[] {
  if (level === 'off') return [];
  // `all` and `needs-you-only` coincide in v1: only needs-you items ever pop, so there is nothing
  // for the narrower level to suppress. The distinction is kept for the settings contract.
  const before = new Map(prev.map((item) => [item.ref, item]));
  const popups: Popup[] = [];
  for (const item of next) {
    if (!item.attention.needsYou) continue;
    const was = before.get(item.ref);
    const entered = was === undefined || !was.attention.needsYou;
    const gained =
      was !== undefined && item.attention.reasons.some((r) => !was.attention.reasons.includes(r));
    if (!entered && !gained) continue;
    popups.push({
      ref: item.ref,
      source: item.source,
      message: `${displayTitle(item)} — ${item.attention.reasons.join(', ')}`,
      reasons: [...item.attention.reasons],
    });
  }
  return popups;
}
