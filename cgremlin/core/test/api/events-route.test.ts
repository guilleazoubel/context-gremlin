import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { EventRing, attachEventRing } from '../../src/api/event-stream';
import { createHarness, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let ring: EventRing;
let detachRing: () => void;

interface StreamClient {
  frames: string[];
  waitFor(predicate: (frames: string[]) => boolean, label: string): Promise<void>;
  close(): void;
}

function open(urlPath: string, headers: Record<string, string> = {}): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', headers }, (res) => {
      let buffer = '';
      const frames: string[] = [];
      let notify: (() => void) | null = null;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          frames.push(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
        }
        notify?.();
      });
      resolve({
        frames,
        async waitFor(predicate, label) {
          const deadline = Date.now() + 3000;
          while (!predicate(frames)) {
            if (Date.now() > deadline) {
              throw new Error(`timed out waiting for ${label}; frames: ${JSON.stringify(frames)}`);
            }
            await new Promise<void>((r) => {
              notify = r;
              setTimeout(r, 20);
            });
            notify = null;
          }
        },
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function typesOf(frames: readonly string[]): string[] {
  return frames.map((f) => /event: (\S+)/.exec(f)?.[1]).filter((t): t is string => t !== undefined);
}

function idsOf(frames: readonly string[]): number[] {
  return frames
    .map((f) => /^id: (\d+)/.exec(f)?.[1])
    .filter((id): id is string => id !== undefined)
    .map(Number);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-events-'));
  h = createHarness();
  ring = new EventRing(4);
  detachRing = attachEventRing(h.events, ring);
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    eventRing: ring,
  });
  socketPath = path.join(dir, 'events.sock');
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  detachRing();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function emitOutput(data: string): void {
  h.events.emit('run.output', { sessionId: 's1', stage: 'review', chunk: { stream: 'stdout', data } });
}

describe('GET /events', () => {
  it('opens with retry and hello, then streams events emitted after connect', async () => {
    const client = await open('/events');
    await client.waitFor((f) => typesOf(f).includes('hello'), 'hello');
    expect(client.frames[0]).toBe('retry: 2000');
    expect(client.frames[1]).toBe(`event: hello\ndata: ${JSON.stringify({ epoch: ring.epoch, lastEventId: 0 })}`);

    h.events.emit('session.created', { session: { id: 's1' } as never });
    await client.waitFor((f) => typesOf(f).includes('session.created'), 'session.created');
    expect(client.frames.find((f) => f.includes('session.created'))).toContain('id: 1');
    client.close();
  });

  it('replays only what a reconnecting client missed', async () => {
    h.events.emit('session.created', { session: { id: 'a' } as never });
    h.events.emit('session.created', { session: { id: 'b' } as never });
    const client = await open('/events', { 'Last-Event-ID': '1' });
    await client.waitFor((f) => idsOf(f).includes(2), 'the missed event');
    expect(idsOf(client.frames)).toEqual([2]);
    client.close();
  });

  it('resyncs an ancient id, a future id and a stale epoch', async () => {
    // The ring holds 4 entries here, so id 1 is long gone.
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      h.events.emit('session.created', { session: { id } as never });
    }
    for (const [label, urlPath, headers] of [
      ['ancient', '/events', { 'Last-Event-ID': '1' }],
      ['future', '/events', { 'Last-Event-ID': '99' }],
      ['stale epoch', '/events?epoch=nope', { 'Last-Event-ID': '6' }],
    ] as const) {
      const client = await open(urlPath, headers);
      await client.waitFor((f) => typesOf(f).includes('resync'), `${label} resync`);
      expect(client.frames.find((f) => f.includes('resync'))).toContain(ring.epoch);
      client.close();
    }
  });

  // MG-A4 events-never-leak-the-secret, over the wire
  it('MG-A4 events-never-leak-the-secret', async () => {
    const plain = await open('/events');
    const opted = await open('/events?include=run.output');
    await plain.waitFor((f) => typesOf(f).includes('hello'), 'hello');
    await opted.waitFor((f) => typesOf(f).includes('hello'), 'hello');

    emitOutput('https://h/?x-vercel-protection-bypass=S3CRET-VALUE&x-vercel-set-bypass-cookie=true');
    h.events.emit('session.created', { session: { id: 's1' } as never });
    await plain.waitFor((f) => typesOf(f).includes('session.created'), 'session.created');
    await opted.waitFor((f) => typesOf(f).includes('run.output'), 'run.output');

    expect(typesOf(plain.frames)).not.toContain('run.output');
    expect(opted.frames.filter((f) => f.includes('event: run.output'))).toHaveLength(1);
    expect(opted.frames.join('')).toContain('x-vercel-protection-bypass=<redacted>');
    for (const frame of [...plain.frames, ...opted.frames]) {
      expect(frame).not.toContain('S3CRET-VALUE');
    }
    plain.close();
    opted.close();
  });

  it('serves two concurrent clients, and one disconnecting breaks neither the engine nor the other', async () => {
    const a = await open('/events');
    const b = await open('/events');
    await a.waitFor((f) => typesOf(f).includes('hello'), 'hello');
    await b.waitFor((f) => typesOf(f).includes('hello'), 'hello');
    h.events.emit('session.created', { session: { id: 'one' } as never });
    await a.waitFor((f) => typesOf(f).includes('session.created'), 'a first event');
    await b.waitFor((f) => typesOf(f).includes('session.created'), 'b first event');

    a.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // EngineEvents.emit swallows a subscriber throw, and the writer guards on
    // res.destroyed — so the dead connection cannot break this emit.
    expect(() => h.events.emit('session.created', { session: { id: 'two' } as never })).not.toThrow();
    await b.waitFor((f) => idsOf(f).includes(2), 'b second event');
    b.close();
  });

  it('404s when no event ring is wired', async () => {
    const bare = createApiServer({
      sessionStore: h.store,
      workspaceManager: h.workspace,
      pipeline: h.service,
      fs: h.fs,
      sessionsDir: SESSIONS_DIR,
      events: h.events,
      lock: h.lock,
    });
    const bareSocket = path.join(dir, 'bare.sock');
    await new Promise<void>((resolve) => bare.listen(bareSocket, resolve));
    try {
      const body = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
        const req = http.request({ socketPath: bareSocket, path: '/events', method: 'GET' }, (res) => {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, raw }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(body.status).toBe(404);
      expect(JSON.parse(body.raw)).toEqual({ error: 'events not configured' });
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});
