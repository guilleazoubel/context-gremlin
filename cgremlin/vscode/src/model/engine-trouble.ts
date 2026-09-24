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
 * Three states are "trouble": `foreign` (something answers the socket and is not the engine),
 * `failed` (the engine did not come up) and `outdated` (the engine is NEWER than this window's
 * extension — it is adopted rather than restarted, and the window is what has to change).
 * Everything else is either healthy or in motion, and the panel keeps showing what it always
 * showed.
 */
import type { EngineState } from '../engine/manager';

/** Ask the manager to probe the socket again — the way out of `foreign` when the user fixes it. */
export const RE_PROBE = 'Re-probe';
/** The notification's other action, and the status bar's click target while `failed`. */
export const SHOW_LOG = 'Show log';
/** The only thing that fixes a window running behind the engine it adopted. */
export const RELOAD_WINDOW = 'Reload window';
/** The same offer inside a sentence (the tree row is one line of prose, not a button). */
export const SHOW_LOG_ROW = 'show log';

/** How the command shows up in the palette; the message tells the user to run it by name. */
const START_COMMAND = 'cgremlin: Start the engine';

/** The primary button's wording wherever there is no usable engine. */
const START_THE_ENGINE = 'Start the engine';

/** The engine is simply not there. One sentence, and the row's button is the whole fix. */
export const NOT_RUNNING_MESSAGE =
  'The cgremlin engine is not running, so there is nothing to list. Start it to pick up where ' +
  'you left off.';

/** The command ids the row and the status bar dispatch. Mirrored in `package.json`. */
const START_ID = 'cgremlin.engine.start';
const SHOW_LOG_ID = 'cgremlin.engine.showLog';
/** The editor's own; nothing this package registers. */
const RELOAD_WINDOW_ID = 'workbench.action.reloadWindow';

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
  | { kind: 'failed'; reason: string }
  | { kind: 'outdated' }
  /**
   * There is no engine at all — it was stopped, or the incident's SIGTERM storm outlived the
   * respawn budget and nothing started it again. Four empty lists with no explanation is what
   * the user actually saw; this is the row that says so and offers the one click that fixes it.
   */
  | { kind: 'notRunning' };

/** The state machine's answer, flattened to what the surfaces read. */
export function healthOf(state: EngineState, socketPath: string | null): EngineHealth {
  return {
    kind: state.kind,
    socketPath,
    reason: state.kind === 'failed' ? state.reason : undefined,
    elapsedMs: state.kind === 'stopping' ? state.elapsedMs : undefined,
  };
}

/** The states that owe the user an explanation, or `null` when nothing is wrong. */
export function troubleOf(health: EngineHealth): EngineTrouble | null {
  if (health.kind === 'foreign') return { kind: 'foreign', socketPath: health.socketPath ?? null };
  if (health.kind === 'failed') {
    return { kind: 'failed', reason: health.reason ?? 'the engine did not start' };
  }
  if (health.kind === 'outdated') return { kind: 'outdated' };
  // The incident's ending, and the ordinary case of `cgremlin: Stop the engine`: nothing is
  // listening, and the panel's job is to offer the way back rather than to go quiet.
  if (health.kind === 'stopped') return { kind: 'notRunning' };
  return null;
}

/** The whole explanation, in one sentence pair. Shown in the row, the tooltip and the popup. */
export function troubleMessage(trouble: EngineTrouble): string {
  if (trouble.kind === 'outdated') return OUTDATED_EXTENSION_MESSAGE;
  if (trouble.kind === 'notRunning') return NOT_RUNNING_MESSAGE;
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

/**
 * The row's primary act. Every trouble that means "there is no usable engine" — a stranger on the
 * socket, a failed start, a stopped engine — is one click from starting one. The log is a second
 * button now ({@link troubleSecondary}) rather than the only offer: reading why it died is not a
 * way out of it, and the incident ended with a user who had no way out at all.
 */
export function troubleCommand(trouble: EngineTrouble): string {
  return trouble.kind === 'outdated' ? RELOAD_WINDOW_ID : START_ID;
}

/** The row's (and the notification's) button, beside the same sentence. */
export function troubleActionLabel(trouble: EngineTrouble): string {
  return trouble.kind === 'outdated' ? RELOAD_WINDOW : START_THE_ENGINE;
}

/**
 * The second, quieter offer — `null` when there is only one thing to say. A start that failed and
 * an engine that is simply not there both owe the user the log; a stranger on the socket does not
 * (there is nothing of ours in it), and a window that is behind has nothing to read either.
 */
export function troubleSecondary(
  trouble: EngineTrouble,
): { command: string; actionLabel: string } | null {
  if (trouble.kind !== 'failed' && trouble.kind !== 'notRunning') return null;
  return { command: SHOW_LOG_ID, actionLabel: SHOW_LOG };
}

/** The status bar's short form. The bar has no room for the sentence; the tooltip carries it. */
export function troubleStatusText(trouble: EngineTrouble): string {
  if (trouble.kind === 'outdated') return '$(warning) cgremlin: reload this window';
  if (trouble.kind === 'notRunning') return '$(circle-slash) cgremlin: engine is not running';
  return trouble.kind === 'foreign'
    ? '$(warning) cgremlin: engine not usable'
    : '$(warning) cgremlin: engine failed';
}

/**
 * The engine on the socket was built AFTER this window's extension. It is adopted — never
 * restarted, because a window that restarts an engine newer than itself is one half of a loop
 * that restarts it for ever — and this is the one thing that ends it.
 */
export const OUTDATED_EXTENSION_MESSAGE =
  'This window runs an older cgremlin extension than the engine — reload the window.';

/**
 * The engine answered, but not with work items.
 *
 * Two causes, and they need different words: an engine older than this extension has no
 * `/items` route at all — the fix is to restart it so the manager adopts the bundled version —
 * while anything else is a failure worth showing verbatim, with the log one click away. Either
 * way the panel says so: four empty lists that silently mean "the engine cannot answer" is the
 * failure Phase 8's engine-trouble row exists to end.
 */
export interface SourceTrouble {
  message: string;
  command: string;
  actionLabel: string;
  /** The status bar's short form. The bar has no room for the sentence. */
  statusText: string;
}

export const OUTDATED_ENGINE_MESSAGE =
  'The engine is older than this extension (no /items). Restart the engine to load the ' +
  'bundled version.';

/**
 * R35: a Jira that REJECTED the credentials earns the engine-trouble treatment in the status bar
 * as well as the panel banner — it is the one ticket-source state a restart will not fix and the
 * user has to go and do something about. The lists themselves stay: the PRs are still good.
 */
export function jiraAuthTroubleOf(message: string, statusText: string): SourceTrouble {
  return { message, statusText, command: SHOW_LOG_ID, actionLabel: SHOW_LOG };
}

export function itemsTroubleOf(status: number, message: string): SourceTrouble {
  if (status === 404) {
    return {
      message: OUTDATED_ENGINE_MESSAGE,
      command: 'cgremlin.engine.restart',
      actionLabel: 'Restart the engine',
      statusText: '$(warning) cgremlin: engine is out of date',
    };
  }
  return {
    message: `The engine could not list your work (HTTP ${status}): ${message}`,
    command: SHOW_LOG_ID,
    actionLabel: SHOW_LOG,
    statusText: '$(warning) cgremlin: work items unavailable',
  };
}

/**
 * `unknown`, `starting`, `stopping` and `mismatch` are not "trouble" — nothing is wrong, the
 * engine just is not ready to answer yet — but the bare word from `EngineState['kind']` is not a
 * sentence a person can act on. Each gets one that names what is actually happening.
 */
function notReadyMessage(kind: EngineHealth['kind']): string {
  switch (kind) {
    case 'starting':
      return 'The cgremlin engine is starting up. Try Refresh again in a moment.';
    case 'stopping':
      return 'The cgremlin engine is stopping. Try Refresh again once it has stopped.';
    // Never NEWER-replaces-OLDER told as the bare word: this window's bundled engine is newer
    // than the one on the socket, and is in the middle of replacing it (see `EngineManager`'s
    // `classify`) — the very state that produced the incident this fix exists for.
    case 'mismatch':
      return (
        'This window is replacing the running engine with the newer one it ships. Try Refresh ' +
        'again once it has restarted.'
      );
    default:
      return (
        `The cgremlin engine has not answered yet. Trying to reach it again — run ` +
        `"${START_COMMAND}" if it does not come up.`
      );
  }
}

/**
 * What the Refresh command says when there is nothing to refresh, or `null` when the engine is
 * running and the refresh should just happen. Trouble reuses the same wording the row shows;
 * every other not-ready kind gets its own sentence, because "starting…" and "stopping…" call for
 * patience rather than for the same explanation — and `mismatch` in particular is never shown as
 * the bare internal word (see `notReadyMessage`).
 */
export function refreshBlockedMessage(health: EngineHealth): string | null {
  if (health.kind === 'running') return null;
  const trouble = troubleOf(health);
  if (trouble !== null) return troubleMessage(trouble);
  return notReadyMessage(health.kind);
}
