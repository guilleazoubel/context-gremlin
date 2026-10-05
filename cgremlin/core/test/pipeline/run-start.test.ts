import { describe, expect, it } from 'vitest';
import { awaitRunStart } from '../../src/pipeline/run-start';
import { EngineEvents, type EngineEventMap } from '../../src/engine/events';
import type { Session } from '../../src/schema/session';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class SpyEvents extends EngineEvents {
  unsubscribeCalls = 0;

  on<K extends keyof EngineEventMap>(type: K, cb: (payload: EngineEventMap[K]) => void): () => void {
    const off = super.on(type, cb);
    return () => {
      this.unsubscribeCalls += 1;
      off();
    };
  }
}

describe('awaitRunStart', () => {
  it('resolves when run.started fires for the matching sessionId', async () => {
    const events = new EngineEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    events.emit('run.started', { session: { id: 's1' } as unknown as Session, stage: 'review' });
    // 0c: `true` — a run started.
    await expect(p).resolves.toBe(true);
  });

  it('ignores run.started for a different sessionId', async () => {
    const events = new EngineEvents();
    const d = deferred<void>();
    let settled = false;
    const p = awaitRunStart(events, 's1', d.promise).then(() => { settled = true; });
    events.emit('run.started', { session: { id: 'other' } as unknown as Session, stage: 'review' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    d.resolve();
    await p;
    expect(settled).toBe(true);
  });

  it('rejects when run rejects before run.started fires', async () => {
    const events = new EngineEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    d.reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });

  it('never lets a rejecting run become an unhandled rejection', async () => {
    const events = new EngineEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    d.reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    // awaitRunStart must have already attached its own handler to d.promise —
    // attaching a second one here must not throw or warn either.
    await expect(d.promise).rejects.toThrow('boom');
  });

  it('unsubscribes from run.started after resolving via the event', async () => {
    const events = new SpyEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    events.emit('run.started', { session: { id: 's1' } as unknown as Session, stage: 'review' });
    await p;
    expect(events.unsubscribeCalls).toBe(1);
    d.resolve();
  });

  it('unsubscribes from run.started after rejecting via run', async () => {
    const events = new SpyEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    d.reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(events.unsubscribeCalls).toBe(1);
  });

  it('resolves if run itself settles successfully without run.started ever firing (defensive fallback)', async () => {
    const events = new EngineEvents();
    const d = deferred<void>();
    const p = awaitRunStart(events, 's1', d.promise);
    d.resolve();
    // 0c: `false` — no run started (the shared preflight blocked it).
    await expect(p).resolves.toBe(false);
  });
});
