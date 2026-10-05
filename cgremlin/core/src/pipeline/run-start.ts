import type { EngineEvents } from '../engine/events';

/**
 * Resolves as soon as `run.started` fires for `sessionId`, or rejects if
 * `run` rejects first — whichever happens first. `run` is expected to be
 * already in flight; the caller never awaits it beyond this race, so a
 * no-op catch is attached immediately to keep it from ever surfacing as an
 * unhandled rejection.
 *
 * 0c: resolves `true` when a run started, and `false` when `run` settled
 * without ever starting one — the shared preflight blocked it (the session
 * then says needs-input). A caller that answers "started" must use this.
 */
export function awaitRunStart(events: EngineEvents, sessionId: string, run: Promise<unknown>): Promise<boolean> {
  run.catch(() => undefined);
  return new Promise<boolean>((resolve, reject) => {
    const off = events.on('run.started', (e) => {
      if (e.session.id === sessionId) {
        off();
        resolve(true);
      }
    });
    run.then(
      () => {
        off();
        resolve(false);
      },
      (err) => {
        off();
        reject(err);
      },
    );
  });
}
