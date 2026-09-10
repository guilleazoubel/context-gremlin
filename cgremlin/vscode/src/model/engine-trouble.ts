/**
 * What the extension says when the engine on the socket is not one it can use.
 *
 * Pure module — no editor API, no I/O. It exists because three surfaces have to say the *same*
 * thing about the same fact: the panel's explanatory row, the status bar and the notification.
 * The failure that produced it was a real one — a socket held by an engine started by hand,
 * older than `GET /version` — and its symptom was silence: four empty lists, a Refresh command
 * that did nothing visible, and one warning the user never saw. Silence is the bug; the words
 * below are the fix, so they live in one place and are tested on their own.
 *
 * Two states are "trouble", and only two: `foreign` (something answers the socket and is not the
 * engine) and `failed` (the engine did not come up). Everything else is either healthy or in
 * motion, and the panel keeps showing what it always showed.
 */
import type { EngineState } from '../engine/manager';

/** Ask the manager to probe the socket again — the way out of `foreign` when the user fixes it. */
export const RE_PROBE = 'Re-probe';
/** The notification's other action, and the status bar's click target while `failed`. */
export const SHOW_LOG = 'Show log';
/** The same offer inside a sentence (the tree row is one line of prose, not a button). */
export const SHOW_LOG_ROW = 'show log';

/** How the command shows up in the palette; the message tells the user to run it by name. */
const START_COMMAND = 'cgremlin: Start the engine';

/** The command ids the row and the status bar dispatch. Mirrored in `package.json`. */
const START_ID = 'cgremlin.engine.start';
const SHOW_LOG_ID = 'cgremlin.engine.showLog';

/**
 * The engine state as the surfaces need it: its kind, the socket it was looked for on, and the
 * two payloads the wording uses. `socketPath` is `null`/absent until the engine's own loader has
 * resolved `core.json`.
 */
export interface EngineHealth {
  kind: EngineState['kind'];
  socketPath?: string | null;
  /** `failed`'s own reason, shown verbatim. */
  reason?: string;
  /** `stopping`'s elapsed time, for the status bar. */
  elapsedMs?: number;
}

export type EngineTrouble =
  | { kind: 'foreign'; socketPath: string | null }
  | { kind: 'failed'; reason: string };

/** The state machine's answer, flattened to what the surfaces read. */
export function healthOf(state: EngineState, socketPath: string | null): EngineHealth {
  return {
    kind: state.kind,
    socketPath,
    reason: state.kind === 'failed' ? state.reason : undefined,
    elapsedMs: state.kind === 'stopping' ? state.elapsedMs : undefined,
  };
}

/** The two states that owe the user an explanation, or `null` when nothing is wrong. */
export function troubleOf(health: EngineHealth): EngineTrouble | null {
  if (health.kind === 'foreign') return { kind: 'foreign', socketPath: health.socketPath ?? null };
  if (health.kind === 'failed') {
    return { kind: 'failed', reason: health.reason ?? 'the engine did not start' };
  }
  return null;
}

/** The whole explanation, in one sentence pair. Shown in the row, the tooltip and the popup. */
export function troubleMessage(trouble: EngineTrouble): string {
  if (trouble.kind === 'failed') return `The cgremlin engine failed: ${trouble.reason}`;
  const where = trouble.socketPath ?? 'the cgremlin socket';
  return (
    `Something is listening on ${where} but it is not a cgremlin engine this extension can use. ` +
    `If it is an older engine you started by hand, stop it and run "${START_COMMAND}".`
  );
}

/** The single row the tree shows instead of four empty lists. */
export function troubleRowLabel(trouble: EngineTrouble): string {
  const message = troubleMessage(trouble);
  return trouble.kind === 'failed' ? `${message} — ${SHOW_LOG_ROW}` : message;
}

/** Clicking the row (or the status bar): a re-probe for a stranger, the log for a failure. */
export function troubleCommand(trouble: EngineTrouble): string {
  return trouble.kind === 'foreign' ? START_ID : SHOW_LOG_ID;
}

/** The status bar's short form. The bar has no room for the sentence; the tooltip carries it. */
export function troubleStatusText(trouble: EngineTrouble): string {
  return trouble.kind === 'foreign'
    ? '$(warning) cgremlin: engine not usable'
    : '$(warning) cgremlin: engine failed';
}

/**
 * What the Refresh command says when there is nothing to refresh, or `null` when the engine is
 * running and the refresh should just happen. Trouble reuses the same wording the row shows;
 * every other not-running kind names the state, because "starting…" and "stopped" call for
 * patience and a command respectively, not the same explanation.
 */
export function refreshBlockedMessage(health: EngineHealth): string | null {
  if (health.kind === 'running') return null;
  const trouble = troubleOf(health);
  if (trouble !== null) return troubleMessage(trouble);
  return (
    `The cgremlin engine is not ready (${health.kind}), so there is nothing to refresh yet. ` +
    `Trying to reach it again — run "${START_COMMAND}" if it does not come up.`
  );
}
