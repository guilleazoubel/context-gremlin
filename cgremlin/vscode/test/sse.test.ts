import { describe, expect, it, afterEach } from 'vitest';
import { parseSseChunk, SseClient } from '../src/sse';
import { startStubServer, type StubServerHandle } from './support/stub-server';

const servers: StubServerHandle[] = [];
const clients: SseClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) await server.dispose();
});

async function stub(...args: Parameters<typeof startStubServer>): Promise<StubServerHandle> {
  const server = await startStubServer(...args);
  servers.push(server);
  return server;
}

function track(client: SseClient): SseClient {
  clients.push(client);
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for a condition');
}

describe('parseSseChunk', () => {
  it('parses one complete frame', () => {
    const { frames, rest } = parseSseChunk('id: 4\nevent: attention.changed\ndata: {"a":1}\n\n');
    expect(frames).toEqual([{ id: 4, event: 'attention.changed', data: { a: 1 } }]);
    expect(rest).toBe('');
  });

  it('holds a frame split across two chunks until it is complete', () => {
    const first = parseSseChunk('id: 4\nevent: ping\ndata: {"a"');
    expect(first.frames).toEqual([]);
    expect(first.rest).not.toBe('');
    const second = parseSseChunk(`${first.rest}:1}\n\n`);
    expect(second.frames).toEqual([{ id: 4, event: 'ping', data: { a: 1 } }]);
    expect(second.rest).toBe('');
  });

  it('parses two frames in one chunk', () => {
    const { frames, rest } = parseSseChunk('id: 1\nevent: a\ndata: 1\n\nid: 2\nevent: b\ndata: 2\n\n');
    expect(frames.map((f) => f.id)).toEqual([1, 2]);
    expect(frames.map((f) => f.event)).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });

  it('ignores a retry-only block', () => {
    const { frames, rest } = parseSseChunk('retry: 2000\n\nevent: hello\ndata: {}\n\n');
    expect(frames).toEqual([{ id: null, event: 'hello', data: {} }]);
    expect(rest).toBe('');
  });

  it('ignores a comment heartbeat line', () => {
    const { frames } = parseSseChunk(': ping\n\n');
    expect(frames).toEqual([]);
  });

  it('reports a frame with no id as id null and defaults the event name', () => {
    const { frames } = parseSseChunk('data: {"a":1}\n\n');
    expect(frames).toEqual([{ id: null, event: 'message', data: { a: 1 } }]);
  });

  it('keeps non-JSON data as a raw string instead of throwing', () => {
    const { frames } = parseSseChunk('event: note\ndata: not json\n\n');
    expect(frames).toEqual([{ id: null, event: 'note', data: 'not json' }]);
  });

  it('parses a CRLF-delimited frame', () => {
    const { frames, rest } = parseSseChunk('id: 9\r\nevent: a\r\ndata: {"a":1}\r\n\r\n');
    expect(frames).toEqual([{ id: 9, event: 'a', data: { a: 1 } }]);
    expect(rest).toBe('');
  });

  it('joins multi-line data with a newline', () => {
    const { frames } = parseSseChunk('event: a\ndata: one\ndata: two\n\n');
    expect(frames[0]?.data).toBe('one\ntwo');
  });
});

describe('SseClient', () => {
  it('fires open with the hello payload and delivers frames in order', async () => {
    const server = await stub();
    const client = track(new SseClient({ socketPath: server.socketPath, backoffMs: [20] }));
    const opens: unknown[] = [];
    const frames: unknown[] = [];
    client.on('open', (p) => opens.push(p));
    client.on('frame', (p) => frames.push(p));
    client.start();

    await waitFor(() => opens.length === 1);
    expect(opens[0]).toMatchObject({ lastEventId: 0 });
    expect(client.epoch).toEqual(expect.any(String));

    server.push('session.created', { n: 1 });
    server.push('run.started', { n: 2 });
    await waitFor(() => frames.length === 2);
    expect(frames).toEqual([
      { id: 1, event: 'session.created', data: { n: 1 } },
      { id: 2, event: 'run.started', data: { n: 2 } },
    ]);
    expect(client.lastEventId).toBe(2);
  });

  it('goes offline when the server dies and reconnects with Last-Event-ID', async () => {
    const server = await stub();
    const client = track(new SseClient({ socketPath: server.socketPath, backoffMs: [20] }));
    let offline = 0;
    const opens: unknown[] = [];
    client.on('offline', () => (offline += 1));
    client.on('open', (p) => opens.push(p));
    client.start();

    await waitFor(() => opens.length === 1);
    server.push('session.created', { n: 1 });
    await waitFor(() => client.lastEventId === 1);

    await server.stop();
    await waitFor(() => offline >= 1);

    await server.restart();
    await waitFor(() => opens.length === 2);
    expect(server.eventRequests).toHaveLength(2);
    expect(server.eventRequests[1]?.headers['last-event-id']).toBe('1');
  });

  it('fires resync and clears lastEventId', async () => {
    const server = await stub();
    const client = track(new SseClient({ socketPath: server.socketPath, backoffMs: [20] }));
    const resyncs: unknown[] = [];
    client.on('open', () => undefined);
    client.on('resync', (p) => resyncs.push(p));
    client.start();

    await waitFor(() => client.epoch !== null);
    server.push('session.created', { n: 1 });
    await waitFor(() => client.lastEventId === 1);

    server.pushResync();
    await waitFor(() => resyncs.length === 1);
    expect(client.lastEventId).toBeNull();
  });

  it('stops reconnecting after stop()', async () => {
    const server = await stub();
    const client = track(new SseClient({ socketPath: server.socketPath, backoffMs: [20] }));
    client.on('open', () => undefined);
    client.start();
    await waitFor(() => server.eventRequests.length === 1);

    client.stop();
    await server.stop();
    await server.restart();
    await sleep(200);
    expect(server.eventRequests).toHaveLength(1);
  });

  it('requests run.output only when asked', async () => {
    const server = await stub();
    const plain = track(new SseClient({ socketPath: server.socketPath, backoffMs: [20] }));
    plain.start();
    await waitFor(() => server.eventRequests.length === 1);
    expect(server.eventRequests[0]?.url).toBe('/events');

    const verbose = track(
      new SseClient({ socketPath: server.socketPath, includeRunOutput: true, backoffMs: [20] }),
    );
    verbose.start();
    await waitFor(() => server.eventRequests.length === 2);
    expect(server.eventRequests[1]?.query.get('include')).toBe('run.output');
  });
});
