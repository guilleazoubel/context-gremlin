/**
 * One rule, in one place: **a person clicking is a person asking for the engine.**
 *
 * The incident this exists for: a window running old extension code SIGTERM'd the engine every
 * 1.5 s until the respawn backoff (R26) was spent, and the engine then stayed dead — no socket,
 * no `engine.json`, no process. Nothing retried, so every ordinary click answered with
 * "cgremlin engine is not running" and the only cure was reloading the window.
 *
 * A user-initiated request that finds the socket empty therefore asks for a start with the
 * `'user'` trigger — which is never refused and never deferred, and which resets the backoff —
 * and then sends its request once more. Only a second failure is worth telling the user about.
 *
 * Pure module — no editor API, no I/O of its own (MG-B1).
 */
import { EngineNotRunningError } from '../core-client';

/** How to ask for the engine, or `undefined` in a composition that has no engine surface. */
export type EngineRevival = (() => Promise<void>) | undefined;

/**
 * `call`, and — when the answer was "there is no engine on that socket" — `call` again, once,
 * after `revive`. Every other failure (a 4xx, a 500, a route that does not exist) is the
 * engine's own answer and is handed straight back to the caller.
 */
export async function withEngineRetry<T>(
  revive: EngineRevival,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (revive === undefined || !(err instanceof EngineNotRunningError)) throw err;
    await revive();
    return await call();
  }
}
