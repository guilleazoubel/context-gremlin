/**
 * P3 — the needs-you strip, and the badge that counts it.
 *
 * The news that something wants the user is worth having; arriving as a toast over whatever they
 * were typing into is not. So the same `attention.needsYou` the core already decided (R22) is
 * rendered in three quiet places instead: a strip at the top of the panel, a numeric badge on the
 * view container, and the count the status bar already carried. Nothing here re-derives who needs
 * whom — it words what the core said.
 *
 * Pure module — no editor API (MG-B1).
 */
import type { WorkItem, WorkListKind } from './work-items';

export interface NeedsYouEntry {
  id: string;
  /** The list the strip clicks back into — an item is selected in a list, not in the abstract. */
  list: WorkListKind;
  label: string;
  /** The first reason, in the words a person would use. */
  reason: string;
}

/**
 * The core's vocabulary, said out loud. An unknown reason falls back to the raw token with its
 * underscores opened out, so a newer engine's reason reads as prose rather than as nothing.
 */
const REASON_TEXT: Record<string, string> = {
  plan_ready: 'plan ready',
  needs_input: 'needs input',
  blocked: 'blocked',
  run_failed: 'the run failed',
  review_ready: 'review ready',
  rereview_ready: 're-review ready',
  comments_ready: 'replies ready to post',
  local_prereq_failed: 'the local app would not start',
  changes_requested: 'changes requested',
  review_arrived: 'a review arrived',
  approved: 'approved',
};

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * One entry per item the core flagged, in the order the response carried them — which is the
 * order the lists themselves are in, so the strip reads top-down like the panel below it.
 */
export function needsYouEntries(items: readonly WorkItem[]): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [];
  for (const item of items) {
    if (!item.needsYou) continue;
    const list = item.lists[0];
    if (list === undefined) continue;
    entries.push({
      id: item.id,
      list,
      label: item.title,
      reason: reasonText(item.attention.reasons[0] ?? ''),
    });
  }
  return entries;
}

/** What the badge's hover says. Singular matters: the badge is read at a glance. */
export function badgeTooltip(count: number): string {
  return count === 1 ? '1 item needs you' : `${count} items need you`;
}
