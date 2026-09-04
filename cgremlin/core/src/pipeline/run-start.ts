import type { EngineEvents } from '../engine/events';

/**
 * Resolves as soon as `run.started` fires for `sessionId`, or rejects if
 * `run` rejects first — whichever happens first. `run` is expected to be
 * already in flight; the caller never awaits it beyond this race, so a
 * no-op catch is attached immediately to keep it from ever surfacing as an
 * unhandled rejection.
 */
export function awaitRunStart(events: EngineEvents, sessionId: string, run: Promise<unknown>): Promise<void> {
  run.catch(() => undefined);
  return new Promise<void>((resolve, reject) => {
    const off = events.on('run.started', (e) => {
      if (e.session.id === sessionId) {
        off();
        resolve();
      }
    });
    run.then(
      () => {
        off();
        resolve();
      },
      (err) => {
        off();
        reject(err);
      },
    );
  });
}
