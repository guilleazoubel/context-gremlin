import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import prsFixture from './fixtures/prs.json';
import sessionsFixture from './fixtures/sessions.json';
import attentionFixture from './fixtures/attention.json';
import itemsFixture from './fixtures/items.json';
import configFixture from './fixtures/config.json';

export const fixtures = {
  prs: prsFixture as unknown,
  sessions: sessionsFixture as unknown,
  attention: attentionFixture as unknown,
  items: itemsFixture as unknown,
  config: configFixture as unknown,
};

export interface StubRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface StubResponse {
  status: number;
  body?: unknown;
}

export type StubHandler = (req: StubRequest) => StubResponse | undefined;

export interface StubServerHandle {
  readonly socketPath: string;
  /** Every non-`/events` request, in arrival order. */
  readonly requests: StubRequest[];
  /** Every `GET /events` request, in arrival order (its headers carry `Last-Event-ID`). */
  readonly eventRequests: StubRequest[];
  /** Currently open event-stream responses. */
  openStreams(): number;
  /** Push one framed event to every open stream, allocating the next id. */
  push(event: string, data: unknown): number;
  /** Write raw text to every open stream (for split-chunk and malformed-frame cases). */
  pushRaw(text: string): void;
  /** Push a `resync` frame — no id, per the spec. */
  pushResync(): void;
  setHandler(handler: StubHandler | undefined): void;
  /** Close the listener and every open connection, leaving the socket path free. */
  stop(): Promise<void>;
  /** Listen again on the same socket path, with a fresh epoch. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

interface StartOptions {
  handler?: StubHandler;
  /** Delay in ms between the response headers and the hello frame. */
  helloDelayMs?: number;
}

function defaultHandler(req: StubRequest): StubResponse | undefined {
  if (req.method === 'GET' && req.path === '/config') return { status: 200, body: fixtures.config };
  if (req.method === 'GET' && req.path === '/prs') return { status: 200, body: fixtures.prs };
  if (req.method === 'GET' && req.path === '/sessions') return { status: 200, body: fixtures.sessions };
  if (req.method === 'GET' && req.path === '/attention') return { status: 200, body: fixtures.attention };
  // R24: the one read the panel makes, plus the per-item detail the Item tab opens.
  if (req.method === 'GET' && req.path === '/items') return { status: 200, body: fixtures.items };
  if (req.method === 'GET' && req.path.startsWith('/items/')) {
    const detail = itemDetailFor(req.path.slice('/items/'.length));
    return detail === null ? { status: 404, body: { error: 'no such item' } } : { status: 200, body: detail };
  }
  if (req.method === 'GET' && /^\/sessions\/[^/]+\/artifacts\/[^/]+$/.test(req.path)) {
    return { status: 200, body: `# ${req.path.split('/').pop()}\n\nbody text` };
  }
  if (req.method === 'GET' && /^\/sessions\/[^/]+\/artifacts$/.test(req.path)) {
    return {
      status: 200,
      body: {
        artifacts: [
          { name: 'BRIEF.md', mtime: '2026-09-10T08:00:00.000Z', size: 1200 },
          { name: 'REVIEW.md', mtime: '2026-09-10T08:20:00.000Z', size: 4300 },
        ],
        primary: 'REVIEW.md',
      },
    };
  }
  if (req.method === 'GET' && /^\/sessions\/[^/]+\/conversation$/.test(req.path)) {
    return {
      status: 200,
      body: {
        runner: 'claude-code',
        resumeId: '7c3f9a10-2b4d-4e51-9f00-8a1b2c3d4e5f',
        worktreePath: '/tmp/cgremlin-fixture/worktrees/pr-acme-web-102',
        claimed: false,
      },
    };
  }
  if (req.method === 'POST') {
    const created = req.path === '/sessions/investigations' || req.path === '/sessions/developments';
    if (created) return { status: 201, body: { session: { id: 'created' } } };
    if (req.path === '/reviews') return { status: 202, body: { session: { id: 'created' }, created: true, started: true } };
    return { status: 200, body: { ok: true } };
  }
  return undefined;
}

interface FixtureItem {
  id: string;
  prs: { repo: string; number: number }[];
  agents: { sessionId: string }[];
  ticket: { key: string } | null;
}

/**
 * R65: a `pr/…` or `session/…` path resolves to the item that *contains* it, which may answer
 * with a `ticket:` id — the stub mirrors the engine's rule so the extension's tests exercise it.
 */
function itemDetailFor(path: string): unknown {
  const items = (fixtures.items as { items: FixtureItem[] }).items;
  const parts = path.split('/');
  const match = items.find((item) => {
    if (parts[0] === 'ticket') return item.ticket?.key === parts[1];
    if (parts[0] === 'session') return item.agents.some((a) => a.sessionId === parts[1]);
    if (parts[0] === 'pr') {
      return item.prs.some(
        (pr) => pr.repo === `${parts[1]}/${parts[2]}` && String(pr.number) === parts[3],
      );
    }
    return false;
  });
  if (match === undefined) return null;
  const artifacts: Record<string, unknown[]> = {};
  for (const agent of match.agents) {
    artifacts[agent.sessionId] = [
      { name: 'BRIEF.md', mtime: '2026-09-10T08:00:00.000Z', size: 10 },
    ];
  }
  return { item: match, ticket: null, ticketError: null, artifacts };
}

export async function startStubServer(opts: StartOptions = {}): Promise<StubServerHandle> {
  const socketPath = `${os.tmpdir()}/cgv-${randomUUID().slice(0, 8)}.sock`;
  const requests: StubRequest[] = [];
  const eventRequests: StubRequest[] = [];
  const streams = new Set<http.ServerResponse>();
  let handler: StubHandler | undefined = opts.handler;
  let epoch = `${new Date().toISOString()}-${randomUUID().slice(0, 4)}`;
  let nextId = 0;
  let server: http.Server;

  const writeAll = (text: string): void => {
    for (const res of streams) {
      if (!res.destroyed) res.write(text);
    }
  };

  const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const listen = async (): Promise<void> => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const request: StubRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: undefined,
      };

      if (request.method === 'GET' && request.path === '/events') {
        eventRequests.push(request);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        streams.add(res);
        res.on('close', () => streams.delete(res));
        const hello = (): void => {
          if (res.destroyed) return;
          res.write('retry: 2000\n\n');
          res.write(`event: hello\ndata: ${JSON.stringify({ epoch, lastEventId: nextId })}\n\n`);
        };
        if (opts.helloDelayMs) setTimeout(hello, opts.helloDelayMs).unref?.();
        else hello();
        return;
      }

      void readBody(req).then((body) => {
        request.body = body;
        requests.push(request);
        const answer = (handler ?? defaultHandler)(request) ?? defaultHandler(request) ?? {
          status: 404,
          body: { error: 'not found' },
        };
        const payload = answer.body === undefined ? '' : JSON.stringify(answer.body);
        res.writeHead(answer.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
  };

  await listen();

  const stop = async (): Promise<void> => {
    for (const res of streams) res.destroy();
    streams.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  };

  return {
    socketPath,
    requests,
    eventRequests,
    openStreams: () => streams.size,
    push(event, data) {
      nextId += 1;
      writeAll(`id: ${nextId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return nextId;
    },
    pushRaw: writeAll,
    pushResync() {
      writeAll(`event: resync\ndata: ${JSON.stringify({ epoch })}\n\n`);
    },
    setHandler(next) {
      handler = next;
    },
    stop,
    async restart() {
      epoch = `${new Date().toISOString()}-${randomUUID().slice(0, 4)}`;
      await listen();
    },
    async dispose() {
      await stop();
    },
  };
}
