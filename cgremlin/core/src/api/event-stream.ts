import type { IncomingMessage, ServerResponse } from 'node:http';
import { redactBypassUrls } from '../config/core-config';
import { ENGINE_EVENT_TYPES, type EngineEventMap, type EngineEvents } from '../engine/events';

export const EVENT_RING_CAPACITY = 256;
/** How many frames one lagging connection may have pending before it is destroyed (R21). */
export const MAX_PENDING_FRAMES = 256;

const HEARTBEAT_MS = 15_000;
const RETRY_MS = 2000;
/** A bound on the replay→live catch-up passes, so a pathological emitter cannot spin here. */
const MAX_CATCH_UP_PASSES = 64;

export interface RingEntry {
  id: number;
  type: keyof EngineEventMap;
  data: unknown;
}

type RingSubscriber = (entry: RingEntry) => void;

/**
 * The bounded replay buffer behind `GET /events`. `push` appends FIRST and
 * notifies afterwards (R21), so a subscriber never sees an id the ring cannot
 * replay.
 */
export class EventRing {
  private readonly entries: RingEntry[] = [];
  private readonly subscribers = new Set<RingSubscriber>();
  private nextId = 1;
  private readonly epochValue = `${new Date().toISOString()}-${Math.random().toString(36).slice(2)}`;

  constructor(private readonly capacity: number = EVENT_RING_CAPACITY) {}

  /** `${engine start ISO}-${random}` — changes on every engine restart. */
  get epoch(): string {
    return this.epochValue;
  }

  get lastEventId(): number {
    return this.nextId - 1;
  }

  /** Entries currently retained — never more than `capacity`. */
  get size(): number {
    return this.entries.length;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  push(type: keyof EngineEventMap, data: unknown): RingEntry {
    const entry: RingEntry = { id: this.nextId, type, data };
    this.nextId += 1;
    this.entries.push(entry);
    while (this.entries.length > this.capacity) this.entries.shift();
    // A snapshot, so a subscriber registered by this notification does not
    // receive the very entry it was registered during.
    for (const cb of [...this.subscribers]) {
      try {
        cb(entry);
      } catch {
        // A misbehaving (or dead) connection must not break the ring.
      }
    }
    return entry;
  }

  /** `complete: false` means the client must resync rather than wait. */
  since(lastEventId: number): { entries: RingEntry[]; complete: boolean } {
    // R21: an id beyond what we have ever emitted is a client replaying
    // against a restarted engine — those ids will never come.
    if (lastEventId > this.lastEventId) return { entries: [], complete: false };
    const oldest = this.entries.length > 0 ? this.entries[0].id : this.lastEventId + 1;
    if (lastEventId + 1 < oldest) return { entries: [], complete: false };
    return { entries: this.entries.filter((e) => e.id > lastEventId), complete: true };
  }

  subscribe(cb: RingSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.unsubscribe(cb);
  }

  unsubscribe(cb: RingSubscriber): void {
    this.subscribers.delete(cb);
  }
}

/** Feeds every engine event into the ring, once, at engine build time. */
export function attachEventRing(events: EngineEvents, ring: EventRing): () => void {
  const offs = ENGINE_EVENT_TYPES.map((type) =>
    events.on(type, (payload) => {
      ring.push(type, payload);
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}

export function serializeFrame(entry: RingEntry): string {
  // JSON.stringify escapes every newline, so no payload can forge a frame
  // boundary out of a multi-line agent chunk.
  return `id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

/** R8/R21: `run.output` is redacted on `chunk.data`, exactly as `serve()` does. */
function redactRunOutput(data: unknown): unknown {
  const payload = data as { chunk?: { data?: unknown } } | null;
  if (payload === null || typeof payload !== 'object' || typeof payload.chunk?.data !== 'string') {
    return data;
  }
  return { ...payload, chunk: { ...payload.chunk, data: redactBypassUrls(payload.chunk.data) } };
}

export interface EventStreamDeps {
  ring: EventRing;
}

/**
 * The `GET /events` handler. Writes an SSE stream and returns immediately;
 * it never sends JSON and never throws, so the route's fall-through and its
 * error mapping cannot touch a response that already has headers.
 *
 * The stream is GLOBAL (R21): no `?session=` filter, because clients
 * subscribe before the sessions they care about exist. Filtering is
 * client-side.
 */
export function handleEventStream(req: IncomingMessage, res: ServerResponse, deps: EventStreamDeps): void {
  const ring = deps.ring;
  const url = new URL(req.url ?? '/events', 'http://localhost');
  const includeRunOutput = url.searchParams.getAll('include').includes('run.output');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const pending: string[] = [];
  const inbox: RingEntry[] = [];
  let lagging = false;
  let draining = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let cleanedUp = false;
  let lastSent = 0;

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    pending.length = 0;
    inbox.length = 0;
  }

  /**
   * Every write goes through here: guarded on `res.destroyed`, and while the
   * socket is lagging a droppable frame (`run.output`, which is opt-in,
   * high-volume and replayable from the ring) is dropped while everything
   * else queues. A stalled reader must never grow the engine's heap, so past
   * MAX_PENDING_FRAMES the connection is destroyed.
   */
  function send(chunk: string, droppable: boolean): void {
    if (res.destroyed) return;
    if (lagging) {
      if (droppable) return;
      if (pending.length >= MAX_PENDING_FRAMES) {
        cleanup();
        res.destroy();
        return;
      }
      pending.push(chunk);
      return;
    }
    if (res.write(chunk) === false) lagging = true;
  }

  res.on('drain', () => {
    lagging = false;
    while (pending.length > 0 && !lagging && !res.destroyed) {
      const next = pending.shift() as string;
      if (res.write(next) === false) lagging = true;
    }
  });

  /**
   * The single monotonic gate both halves of the handover write through, so
   * an entry can be written neither twice nor out of order — and a frame we
   * deliberately do not send still advances it.
   */
  function writeEntry(entry: RingEntry): void {
    if (entry.id <= lastSent) return;
    lastSent = entry.id;
    if (entry.type === 'run.output') {
      if (!includeRunOutput) return;
      send(serializeFrame({ ...entry, data: redactRunOutput(entry.data) }), true);
      return;
    }
    send(serializeFrame(entry), false);
  }

  /**
   * Entries are queued and drained in enqueue order, never written straight
   * from the notification: a write can re-enter the engine (a subscriber that
   * emits, a logger that pushes), and writing that nested entry mid-batch
   * would put an id out of order and make the gate below skip the rest of the
   * batch as already-sent.
   */
  function enqueue(entries: readonly RingEntry[]): void {
    for (const entry of entries) inbox.push(entry);
    if (draining) return;
    draining = true;
    try {
      while (inbox.length > 0 && !res.destroyed) {
        writeEntry(inbox.shift() as RingEntry);
      }
    } finally {
      draining = false;
      if (res.destroyed) inbox.length = 0;
    }
  }

  function resync(): void {
    send(`event: resync\ndata: ${JSON.stringify({ epoch: ring.epoch })}\n\n`, false);
  }

  send(`retry: ${RETRY_MS}\n\n`, false);
  send(`event: hello\ndata: ${JSON.stringify({ epoch: ring.epoch, lastEventId: ring.lastEventId })}\n\n`, false);

  const headerId = req.headers['last-event-id'];
  const rawId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? url.searchParams.get('lastEventId');
  const parsedId = rawId === undefined || rawId === null || rawId === '' ? NaN : Number(rawId);
  const requestedId = Number.isInteger(parsedId) && parsedId >= 0 ? parsedId : null;
  const requestedEpoch = url.searchParams.get('epoch');

  // Default: live from now.
  lastSent = ring.lastEventId;
  if (requestedEpoch !== null && requestedEpoch !== ring.epoch) {
    resync();
  } else if (requestedId !== null) {
    const snapshot = ring.since(requestedId);
    if (!snapshot.complete) {
      resync();
    } else {
      lastSent = requestedId;
      enqueue(snapshot.entries);
    }
  }

  // The replay itself can destroy the connection: a reader that stalls from
  // the first byte fills the pending queue and trips the ceiling inside
  // `send`, which already ran cleanup. Bailing out here is what keeps that
  // path from re-installing a ring subscription and a 15 s interval that
  // nothing would ever tear down (cleanedUp is already true).
  if (cleanedUp || res.destroyed) return;

  // Replay first, subscribe second (R21) — then drain anything the ring
  // gained while the replay was being written, which is the only remaining
  // window in which an event could have been lost.
  unsubscribe = ring.subscribe((entry) => enqueue([entry]));
  for (let pass = 0; pass < MAX_CATCH_UP_PASSES; pass += 1) {
    if (cleanedUp || res.destroyed) break;
    const missed = ring.since(lastSent);
    if (!missed.complete || missed.entries.length === 0) break;
    enqueue(missed.entries);
  }
  // Same story for the catch-up: it writes, so it too can trip the ceiling.
  if (cleanedUp || res.destroyed) {
    cleanup();
    return;
  }

  heartbeat = setInterval(() => {
    if (res.destroyed) return;
    send(': ping\n\n', false);
  }, HEARTBEAT_MS);

  req.on('close', cleanup);
}
