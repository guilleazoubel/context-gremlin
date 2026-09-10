import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EVENT_RING_CAPACITY,
  EventRing,
  MAX_PENDING_FRAMES,
  handleEventStream,
  serializeFrame,
  type RingEntry,
} from '../../src/api/event-stream';

interface StubRes {
  destroyed: boolean;
  blocked: boolean;
  writes: string[];
  headers: Record<string, string> | undefined;
  status: number | undefined;
  destroyCalls: number;
  drain(): void;
  as(): ServerResponse;
}

function stubRes(): StubRes {
  const drainListeners: Array<() => void> = [];
  const res: StubRes = {
    destroyed: false,
    blocked: false,
    writes: [],
    headers: undefined,
    status: undefined,
    destroyCalls: 0,
    drain() {
      for (const cb of [...drainListeners]) cb();
    },
    as() {
      return this as unknown as ServerResponse;
    },
  };
  Object.assign(res, {
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    write(chunk: string) {
      res.writes.push(chunk);
      return !res.blocked;
    },
    destroy() {
      res.destroyCalls += 1;
      res.destroyed = true;
    },
    on(event: string, cb: () => void) {
      if (event === 'drain') drainListeners.push(cb);
      return res;
    },
    end() {
      return res;
    },
  });
  return res;
}

function stubReq(url: string, headers: Record<string, string> = {}) {
  const closeListeners: Array<() => void> = [];
  const req = {
    url,
    headers,
    on(event: string, cb: () => void) {
      if (event === 'close') closeListeners.push(cb);
      return req;
    },
  };
  return {
    as: () => req as unknown as IncomingMessage,
    close: () => {
      for (const cb of [...closeListeners]) cb();
    },
  };
}

function framesOf(res: StubRes): string[] {
  return res.writes.join('').split('\n\n').filter((f) => f.length > 0);
}

function typesOf(res: StubRes): string[] {
  return framesOf(res)
    .map((f) => /event: (\S+)/.exec(f)?.[1])
    .filter((t): t is string => t !== undefined);
}

describe('EventRing', () => {
  it('numbers entries from 1, increasing by 1', () => {
    const ring = new EventRing();
    expect(ring.lastEventId).toBe(0);
    expect(ring.push('session.created', { a: 1 })).toEqual({ id: 1, type: 'session.created', data: { a: 1 } });
    expect(ring.push('session.created', { a: 2 }).id).toBe(2);
    expect(ring.lastEventId).toBe(2);
  });

  it('replays everything since 0 on a partially full ring', () => {
    const ring = new EventRing();
    ring.push('session.created', 1);
    ring.push('session.created', 2);
    expect(ring.since(0)).toEqual({
      entries: [
        { id: 1, type: 'session.created', data: 1 },
        { id: 2, type: 'session.created', data: 2 },
      ],
      complete: true,
    });
    expect(ring.since(2)).toEqual({ entries: [], complete: true });
  });

  it('reports an id older than the oldest entry as incomplete', () => {
    const ring = new EventRing(4);
    for (let i = 0; i < 6; i += 1) ring.push('session.created', i);
    expect(ring.since(1).complete).toBe(false);
    expect(ring.since(2).entries.map((e) => e.id)).toEqual([3, 4, 5, 6]);
    expect(ring.since(2).complete).toBe(true);
  });

  // R21: a client replaying against a restarted engine must refetch, not wait
  // for ids that will never come.
  it('R21: reports an id greater than lastEventId as incomplete', () => {
    const ring = new EventRing();
    ring.push('session.created', 1);
    expect(ring.since(9)).toEqual({ entries: [], complete: false });
  });

  it('has a stable epoch per instance that differs between instances', () => {
    const ring = new EventRing();
    expect(ring.epoch).toBe(ring.epoch);
    expect(new EventRing().epoch).not.toBe(ring.epoch);
  });

  it('delivers every subsequent push to a subscriber, in id order, until unsubscribed', () => {
    const ring = new EventRing();
    const seen: number[] = [];
    const off = ring.subscribe((e) => seen.push(e.id));
    ring.push('session.created', 1);
    ring.push('session.created', 2);
    off();
    ring.push('session.created', 3);
    expect(seen).toEqual([1, 2]);

    const seen2: number[] = [];
    const cb = (e: { id: number }): void => {
      seen2.push(e.id);
    };
    ring.subscribe(cb);
    ring.push('session.created', 4);
    ring.unsubscribe(cb);
    ring.push('session.created', 5);
    expect(seen2).toEqual([4]);
    expect(ring.subscriberCount).toBe(0);
  });

  it('does not deliver the in-flight entry twice to a subscriber added during a push', () => {
    const ring = new EventRing();
    const late: number[] = [];
    ring.subscribe(() => {
      ring.subscribe((e) => late.push(e.id));
    });
    ring.push('session.created', 1);
    expect(late).toEqual([]);
    ring.push('session.created', 2);
    expect(late).toContain(2);
    expect(late).not.toContain(1);
  });

  // MG-A5 sse-replay-is-bounded-and-honest (the ring half)
  it('MG-A5 sse-replay-is-bounded-and-honest: never exceeds capacity and says so', () => {
    const ring = new EventRing();
    for (let i = 0; i < EVENT_RING_CAPACITY + 50; i += 1) {
      ring.push('run.output', { i });
      expect(ring.size).toBeLessThanOrEqual(EVENT_RING_CAPACITY);
    }
    expect(ring.since(1).complete).toBe(false);
    expect(ring.lastEventId).toBe(EVENT_RING_CAPACITY + 50);
  });
});

describe('serializeFrame', () => {
  it('emits id/event/data and JSON-escapes a payload newline so no frame boundary can be forged', () => {
    const frame = serializeFrame({ id: 7, type: 'run.output', data: { text: 'a\n\nb' } });
    expect(frame).toBe('id: 7\nevent: run.output\ndata: {"text":"a\\n\\nb"}\n\n');
    const data = frame.slice(frame.indexOf('data: '), -2);
    expect(data).not.toContain('\n');
  });
});

describe('handleEventStream', () => {
  it('opens with the SSE headers, a retry frame and a hello carrying epoch and lastEventId', () => {
    const ring = new EventRing();
    ring.push('session.created', 1);
    const res = stubRes();
    handleEventStream(stubReq('/events').as(), res.as(), { ring });
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    expect(res.writes[0]).toBe('retry: 2000\n\n');
    expect(res.writes[1]).toBe(`event: hello\ndata: ${JSON.stringify({ epoch: ring.epoch, lastEventId: 1 })}\n\n`);
  });

  it('writes events emitted after connect, and no run.output by default', () => {
    const ring = new EventRing();
    const res = stubRes();
    handleEventStream(stubReq('/events').as(), res.as(), { ring });
    ring.push('session.created', { id: 's1' });
    ring.push('run.output', { sessionId: 's1', chunk: { stream: 'stdout', data: 'x' } });
    expect(typesOf(res)).toEqual(['hello', 'session.created']);
  });

  it('replays only the events after Last-Event-ID, from the header or the query', () => {
    const ring = new EventRing();
    ring.push('session.created', 1);
    ring.push('session.created', 2);
    ring.push('session.created', 3);
    const viaHeader = stubRes();
    handleEventStream(stubReq('/events', { 'last-event-id': '2' }).as(), viaHeader.as(), { ring });
    expect(framesOf(viaHeader).filter((f) => f.startsWith('id: ')).map((f) => f.slice(4, 5))).toEqual(['3']);

    const viaQuery = stubRes();
    handleEventStream(stubReq('/events?lastEventId=2').as(), viaQuery.as(), { ring });
    expect(framesOf(viaQuery).filter((f) => f.startsWith('id: ')).map((f) => f.slice(4, 5))).toEqual(['3']);
  });

  it('resyncs an ancient id, a future id and a stale epoch', () => {
    const ring = new EventRing(4);
    for (let i = 0; i < 6; i += 1) ring.push('session.created', i);
    for (const req of [
      stubReq('/events', { 'last-event-id': '1' }),
      stubReq('/events', { 'last-event-id': '99' }),
      stubReq('/events?epoch=stale', { 'last-event-id': '5' }),
    ]) {
      const res = stubRes();
      handleEventStream(req.as(), res.as(), { ring });
      expect(typesOf(res)).toContain('resync');
      expect(framesOf(res).find((f) => f.includes('resync'))).toContain(ring.epoch);
    }
  });

  // R21 ordering guard
  it('R21 sse-handover-has-no-gap-and-no-duplicate', () => {
    const ring = new EventRing();
    for (let i = 0; i < 10; i += 1) ring.push('session.created', i);
    const res = stubRes();
    // A burst emitted across the handover: pushing from inside the replay's
    // own writes is the tightest interleaving a real client can produce.
    let burst = 0;
    Object.assign(res, {
      write(chunk: string) {
        res.writes.push(chunk);
        if (burst < 40) {
          burst += 1;
          ring.push('session.created', `burst-${burst}`);
        }
        return true;
      },
    });
    handleEventStream(stubReq('/events', { 'last-event-id': '3' }).as(), res.as(), { ring });
    for (let i = 0; i < 10; i += 1) ring.push('session.created', `after-${i}`);
    const ids = framesOf(res)
      .map((f) => /^id: (\d+)/.exec(f)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(Number);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(4);
    expect(ids[ids.length - 1]).toBe(ring.lastEventId);
    expect(ids).toEqual(Array.from({ length: ring.lastEventId - 3 }, (_, i) => i + 4));
  });

  // R21 drop-policy guard
  it('R21 lagging-drops-only-run-output', () => {
    const ring = new EventRing();
    const res = stubRes();
    handleEventStream(stubReq('/events?include=run.output').as(), res.as(), { ring });
    res.blocked = true;
    ring.push('attention.changed', { item: { ref: 'session:a' } });
    for (let i = 0; i < 5; i += 1) {
      ring.push('run.output', { sessionId: 'a', chunk: { stream: 'stdout', data: `chunk-${i}` } });
      ring.push('attention.changed', { item: { ref: `session:${i}` } });
    }
    const writesWhileLagging = res.writes.length;
    res.blocked = false;
    res.drain();
    const types = typesOf(res);
    expect(types.filter((t) => t === 'attention.changed')).toHaveLength(6);
    expect(types).not.toContain('run.output');
    expect(res.writes.length).toBeGreaterThan(writesWhileLagging);
    expect(res.destroyCalls).toBe(0);
  });

  it('R21 destroys a stalled connection past MAX_PENDING_FRAMES instead of growing the heap', () => {
    const ring = new EventRing();
    const res = stubRes();
    handleEventStream(stubReq('/events').as(), res.as(), { ring });
    res.blocked = true;
    for (let i = 0; i < MAX_PENDING_FRAMES + 20; i += 1) {
      ring.push('attention.changed', { item: { ref: `session:${i}` } });
    }
    expect(res.destroyCalls).toBeGreaterThan(0);
    const writesAtDestroy = res.writes.length;
    ring.push('attention.changed', { item: { ref: 'session:after' } });
    res.blocked = false;
    res.drain();
    expect(res.writes.length).toBe(writesAtDestroy);
    expect(ring.subscriberCount).toBe(0);
  });

  it('R21 leaves no subscriber and no heartbeat when the replay itself overruns the ceiling', () => {
    vi.useFakeTimers();
    try {
      const total = MAX_PENDING_FRAMES + 100;
      const ring = new EventRing(total);
      for (let i = 0; i < total; i += 1) ring.push('session.created', { i });
      const res = stubRes();
      // A reader that stalls from the very first byte: the replay alone is
      // enough to hit the pending ceiling and destroy the connection.
      res.blocked = true;
      handleEventStream(stubReq('/events', { 'last-event-id': '0' }).as(), res.as(), { ring });
      expect(res.destroyCalls).toBeGreaterThan(0);
      expect(ring.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      // And nothing keeps writing to it afterwards.
      const after = res.writes.length;
      ring.push('session.created', { late: true });
      vi.advanceTimersByTime(60_000);
      expect(res.writes.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  // MG-A4 events-never-leak-the-secret
  it('MG-A4 events-never-leak-the-secret', () => {
    const ring = new EventRing();
    const plain = stubRes();
    const opted = stubRes();
    handleEventStream(stubReq('/events').as(), plain.as(), { ring });
    handleEventStream(stubReq('/events?include=run.output').as(), opted.as(), { ring });
    const data =
      'https://h/?x-vercel-protection-bypass=S3CRET-VALUE&x-vercel-set-bypass-cookie=true';
    ring.push('run.output', { sessionId: 'a', stage: 'review', chunk: { stream: 'stdout', data } });

    expect(typesOf(plain)).not.toContain('run.output');
    const optedFrames = framesOf(opted);
    expect(optedFrames.filter((f) => f.includes('event: run.output'))).toHaveLength(1);
    expect(optedFrames.join('')).toContain('x-vercel-protection-bypass=<redacted>');
    for (const frame of [...framesOf(plain), ...optedFrames]) {
      expect(frame).not.toContain('S3CRET-VALUE');
    }
  });

  // R21 cleanup guard
  it('R21 unsubscribes the ring and clears the heartbeat on close', () => {
    vi.useFakeTimers();
    try {
      const ring = new EventRing();
      const res = stubRes();
      const req = stubReq('/events');
      handleEventStream(req.as(), res.as(), { ring });
      expect(ring.subscriberCount).toBe(1);
      vi.advanceTimersByTime(15_000);
      expect(res.writes.at(-1)).toBe(': ping\n\n');
      req.close();
      expect(ring.subscriberCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const after = res.writes.length;
      vi.advanceTimersByTime(60_000);
      ring.push('session.created', 1);
      expect(res.writes.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The `entry.id <= lastSent` gate. With today's EventRing the gate is not
   * reachable: `push` only ever hands out increasing ids, and the handover
   * subscribes strictly after the replay snapshot, so no already-sent id can
   * come back. It is the one thing standing between a future ring change (a
   * re-delivering subscriber, a since() that overlaps what was replayed) and
   * a duplicated frame, so it is pinned here against a ring that does exactly
   * that rather than left to the honour system.
   */
  describe('R21: an already-sent id is never written twice', () => {
    class ReDeliveringRing extends EventRing {
      subscriber: ((entry: RingEntry) => void) | null = null;
      /** Entries the Nth `since` call returns instead of the real answer. */
      overlapOnCall: { call: number; entries: RingEntry[] } | null = null;
      private sinceCalls = 0;

      subscribe(cb: (entry: RingEntry) => void): () => void {
        this.subscriber = cb;
        return super.subscribe(cb);
      }

      since(lastEventId: number): { entries: RingEntry[]; complete: boolean } {
        this.sinceCalls += 1;
        if (this.overlapOnCall !== null && this.overlapOnCall.call === this.sinceCalls) {
          return { entries: this.overlapOnCall.entries, complete: true };
        }
        return super.since(lastEventId);
      }
    }

    function idsOf(res: StubRes): number[] {
      return framesOf(res)
        .map((f) => /^id: (\d+)/.exec(f)?.[1])
        .filter((id): id is string => id !== undefined)
        .map(Number);
    }

    it('drops a live notification for an id the replay already wrote', () => {
      const ring = new ReDeliveringRing();
      for (let i = 1; i <= 5; i += 1) ring.push('session.created', { i });
      const res = stubRes();
      handleEventStream(stubReq('/events', { 'last-event-id': '0' }).as(), res.as(), { ring });
      expect(idsOf(res)).toEqual([1, 2, 3, 4, 5]);

      // The ring re-delivers what the replay already sent.
      ring.subscriber?.({ id: 3, type: 'session.created', data: { i: 3 } });
      ring.subscriber?.({ id: 5, type: 'session.created', data: { i: 5 } });
      expect(idsOf(res)).toEqual([1, 2, 3, 4, 5]);

      // And the connection is still live for the next real event.
      ring.push('session.created', { i: 6 });
      const ids = idsOf(res);
      expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
      expect(ids).toEqual([...new Set(ids)]);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    it('drops a catch-up pass that overlaps what the replay already wrote', () => {
      const ring = new ReDeliveringRing();
      for (let i = 1; i <= 5; i += 1) ring.push('session.created', { i });
      // Call 1 is the replay snapshot; call 2 is the post-subscribe catch-up,
      // which here hands back an id already written alongside a new one.
      ring.overlapOnCall = {
        call: 2,
        entries: [
          { id: 2, type: 'session.created', data: { i: 2 } },
          { id: 6, type: 'session.created', data: { i: 6 } },
        ],
      };
      const res = stubRes();
      handleEventStream(stubReq('/events', { 'last-event-id': '0' }).as(), res.as(), { ring });
      const ids = idsOf(res);
      expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
      expect(ids).toEqual([...new Set(ids)]);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });
  });

  it('never writes to a destroyed response', () => {
    const ring = new EventRing();
    const res = stubRes();
    handleEventStream(stubReq('/events').as(), res.as(), { ring });
    const before = res.writes.length;
    res.destroyed = true;
    ring.push('session.created', 1);
    expect(res.writes.length).toBe(before);
  });
});
