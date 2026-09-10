/**
 * The engine's `GET /events` stream: a pure frame parser plus a reconnecting consumer.
 *
 * Pure module — Node stdlib only, no editor API (MG-B1).
 */
import http from 'node:http';
import { resolveSocketPath, type SocketPathSource } from './core-client';

export interface SseFrame {
  id: number | null;
  event: string;
  data: unknown;
}

/**
 * Splits `buffer` into whole frames plus whatever is left over, which the caller feeds back in
 * front of the next chunk. Line terminators may be LF, CRLF or CR; a trailing CR is held back
 * because it may be the first half of a CRLF that the next chunk completes.
 */
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  let text = buffer;
  let dangling = '';
  if (text.endsWith('\r')) {
    dangling = '\r';
    text = text.slice(0, -1);
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    const frame = parseBlock(block);
    if (frame !== null) frames.push(frame);
  }
  return { frames, rest: rest + dangling };
}

function parseBlock(block: string): SseFrame | null {
  let id: number | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') {
      const parsed = Number(value);
      id = Number.isInteger(parsed) ? parsed : null;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
    // `retry` and any unknown field are ignored: this client owns its own backoff.
  }
  if (event === null && data.length === 0) return null;
  return { id, event: event ?? 'message', data: decodeData(data) };
}

function decodeData(lines: readonly string[]): unknown {
  if (lines.length === 0) return null;
  const raw = lines.join('\n');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export type SseEventName = 'frame' | 'open' | 'resync' | 'offline';

export interface SseClientOptions {
  /** Resolved per connection *attempt* when it is a function, so a reconnect can land elsewhere. */
  socketPath: SocketPathSource;
  /** Opt in to the engine's high-volume `run.output` frames (R8). */
  includeRunOutput?: boolean;
  /** Reconnect delays, one per consecutive failure; the last one repeats. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000];

/**
 * Holds one `GET /events` connection open, replays from `Last-Event-ID` after a drop, and
 * surfaces the engine's `resync` verdict instead of silently resuming from "now".
 */
export class SseClient {
  private readonly opts: SseClientOptions;
  private readonly backoff: readonly number[];
  private readonly listeners = new Map<SseEventName, Set<(payload: unknown) => void>>();
  private request: http.ClientRequest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private buffer = '';
  private stopped = true;
  private failures = 0;
  private lastId: number | null = null;
  private currentEpoch: string | null = null;

  constructor(opts: SseClientOptions) {
    this.opts = opts;
    this.backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  }

  get lastEventId(): number | null {
    return this.lastId;
  }

  get epoch(): string | null {
    return this.currentEpoch;
  }

  on(event: SseEventName, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => {
      set.delete(cb);
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const request = this.request;
    this.request = null;
    request?.destroy();
  }

  private emit(event: SseEventName, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload);
  }

  private path(): string {
    const query = new URLSearchParams();
    if (this.opts.includeRunOutput === true) query.set('include', 'run.output');
    if (this.currentEpoch !== null) query.set('epoch', this.currentEpoch);
    const suffix = query.toString();
    return suffix === '' ? '/events' : `/events?${suffix}`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.buffer = '';
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastId !== null) headers['Last-Event-ID'] = String(this.lastId);
    const request = http.request(
      { socketPath: resolveSocketPath(this.opts.socketPath), path: this.path(), method: 'GET', headers },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          this.dropped();
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => this.consume(chunk));
        res.on('end', () => this.dropped());
        res.on('error', () => this.dropped());
      },
    );
    this.request = request;
    request.on('error', () => this.dropped());
    request.end();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const { frames, rest } = parseSseChunk(this.buffer);
    this.buffer = rest;
    for (const frame of frames) this.dispatch(frame);
  }

  private dispatch(frame: SseFrame): void {
    if (frame.event === 'resync') {
      this.lastId = null;
      this.currentEpoch = epochOf(frame.data) ?? this.currentEpoch;
      this.emit('resync', frame.data);
      return;
    }
    if (frame.id !== null) this.lastId = frame.id;
    if (frame.event === 'hello') {
      this.failures = 0;
      this.currentEpoch = epochOf(frame.data) ?? this.currentEpoch;
      this.emit('open', frame.data);
      return;
    }
    this.emit('frame', frame);
  }

  private dropped(): void {
    if (this.stopped || this.request === null) return;
    this.request = null;
    this.emit('offline', null);
    const delay = this.backoff[Math.min(this.failures, this.backoff.length - 1)];
    this.failures += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }
}

function epochOf(data: unknown): string | null {
  if (data !== null && typeof data === 'object' && 'epoch' in data) {
    const value = (data as { epoch: unknown }).epoch;
    if (typeof value === 'string') return value;
  }
  return null;
}
