/**
 * The notification level — which is now only about how loudly the panel is allowed to be quiet.
 *
 * There is no popup policy left to express. Needs-you reaches the user through the panel's
 * needs-you strip, the view-container badge and the status-bar count, and that is the whole of
 * it: the user said the popups "show all the time and it is really annoying", and a toast raised
 * over whatever he was typing into is not a surface he ever asked for.
 *
 * So `all` — the value that used to mean "one popup per item" — is no longer a level. It is
 * still ACCEPTED, because a setting already in somebody's `settings.json` must not turn into an
 * error or a silent fallback he cannot see: it reads as the default, and says so once in the
 * log. Once, not once per refresh — the level is read live on every poll, and a line per poll is
 * its own kind of noise. And in the log rather than in a toast, because announcing the end of
 * popups with a popup would be the joke it sounds like.
 *
 * Pure module — no editor API (MG-B1).
 */

export const NOTIFICATION_LEVELS = ['needs-you-only', 'off'] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'needs-you-only';

/** The value that used to raise a popup per item. Kept readable, never advertised. */
const LEGACY_LOUD = 'all';

const LEGACY_NOTICE =
  `cgremlin: "${LEGACY_LOUD}" is no longer a notificationLevel — reading it as ` +
  `"${DEFAULT_NOTIFICATION_LEVEL}". Needs-you is in the panel's strip, the view badge and the ` +
  'status bar; there are no popups for it any more.';

/** Module state on purpose: "once" is a fact about this window, not about any one caller. */
let announced = false;

export function normalizeLevel(value: string, log?: (line: string) => void): NotificationLevel {
  if ((NOTIFICATION_LEVELS as readonly string[]).includes(value)) return value as NotificationLevel;
  if (value === LEGACY_LOUD && !announced) {
    announced = true;
    log?.(LEGACY_NOTICE);
  }
  return DEFAULT_NOTIFICATION_LEVEL;
}
