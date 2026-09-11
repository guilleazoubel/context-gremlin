import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { AckStore } from '../../src/attention/ack-store';
import {
  AttentionService,
  PrSourceAdapter,
  SessionSourceAdapter,
  type SourceAdapter,
} from '../../src/attention/attention-service';
import type { ItemSource } from '../../src/attention/item-ref';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import type { Session } from '../../src/schema/session';
import { createHarness, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';

const NOW = new Date('2026-09-10T12:00:00.000Z');

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let inv: Inventory | null;

interface ItemBody {
  ref: string;
  source: string;
  attention: { acked: boolean; needsYou: boolean };
}

interface ResponseBody {
  evaluatedAt?: string;
  items?: ItemBody[];
  item?: ItemBody;
  error?: string;
}

function requestOn(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: ResponseBody }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function investigation(id: string, over: Partial<Session> = {}): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    mode: 'investigation',
    stageStatus: 'findings',
    intent: 'investigate_only',
    driveToCompletion: false,
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'b' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'APP-1' },
    agent: null,
    lastRun: null,
    pr: null,
    ...over,
  } as Session;
}

function entry(over: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    ...PHASE9_ENTRY_DEFAULTS,
    repo: 'acme/app',
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'PR twelve',
    author: 'me-user',
    isDraft: false,
    headSha: 'sha1',
    baseRef: 'main',
    updatedAt: '2026-09-03T00:00:00.000Z',
    reviewDecision: 'CHANGES_REQUESTED',
    isMine: true,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

async function startServer(opts: { withAttention: boolean; extraAdapters?: SourceAdapter[] } = { withAttention: true }): Promise<void> {
  h = createHarness();
  await h.fs.mkdir('/state', { recursive: true });
  const acks = new AckStore(h.fs, '/state/attention-acks.json');
  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({
        store: h.store,
        fs: h.fs,
        sessionsDir: SESSIONS_DIR,
        isRunning: () => false,
      }),
      new PrSourceAdapter({ inventory: { load: async () => inv } }),
      ...(opts.extraAdapters ?? []),
    ],
    acks,
    events: h.events,
    now: () => NOW,
  });
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    ...(opts.withAttention ? { attention } : {}),
  });
  socketPath = path.join(dir, `attn-${Math.random().toString(36).slice(2)}.sock`);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-attention-'));
  inv = null;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('attention routes', () => {
  it('GET /attention returns only needy items, and ?all=1 returns every item', async () => {
    await startServer({ withAttention: true });
    await h.store.save(investigation('quiet'));
    await h.store.save(investigation('loud', { stageStatus: 'plan_ready' }));

    const needy = await requestOn('GET', '/attention');
    expect(needy.status).toBe(200);
    expect(needy.body.evaluatedAt).toBe(NOW.toISOString());
    expect(needy.body.items!.map((i) => i.ref)).toEqual(['session:loud']);

    const all = await requestOn('GET', '/attention?all=1');
    expect(all.body.items!.map((i) => i.ref).sort()).toEqual(['session:loud', 'session:quiet']);
  });

  it('GET /attention?source=pr filters by source', async () => {
    await startServer({ withAttention: true });
    await h.store.save(investigation('loud', { stageStatus: 'plan_ready' }));
    inv = { scannedAt: 't', repos: ['acme/app'], entries: [entry()], errors: [] };

    const prs = await requestOn('GET', '/attention?source=pr');
    expect(prs.body.items!.map((i) => i.ref)).toEqual(['pr:acme/app#12']);
    const sessions = await requestOn('GET', '/attention?source=session');
    expect(sessions.body.items!.map((i) => i.ref)).toEqual(['session:loud']);
    expect((await requestOn('GET', '/attention?source=nope')).status).toBe(400);
  });

  it('POST /attention/ack acks by ref, 400s a malformed ref and 404s a ref naming nothing', async () => {
    await startServer({ withAttention: true });
    await h.store.save(investigation('loud', { stageStatus: 'plan_ready' }));

    const ok = await requestOn('POST', '/attention/ack', { ref: 'session:loud' });
    expect(ok.status).toBe(200);
    expect(ok.body.item!.attention.acked).toBe(true);
    expect((await requestOn('GET', '/attention')).body.items).toEqual([]);

    expect((await requestOn('POST', '/attention/ack', { ref: 'nope:x' })).status).toBe(400);
    expect((await requestOn('POST', '/attention/ack', {})).status).toBe(400);
    expect((await requestOn('POST', '/attention/ack', { ref: 'session:ghost' })).status).toBe(404);
  });

  it('the two named ack routes are byte-identical aliases of the generic one', async () => {
    await startServer({ withAttention: true });
    await h.store.save(investigation('loud', { stageStatus: 'plan_ready' }));
    inv = { scannedAt: 't', repos: ['acme/app'], entries: [entry()], errors: [] };

    const viaAlias = await requestOn('POST', '/sessions/loud/ack');
    const viaGeneric = await requestOn('POST', '/attention/ack', { ref: 'session:loud' });
    expect(viaAlias.status).toBe(200);
    expect(JSON.stringify(viaAlias.body)).toBe(JSON.stringify(viaGeneric.body));

    const prAlias = await requestOn('POST', '/prs/acme/app/12/ack');
    const prGeneric = await requestOn('POST', '/attention/ack', { ref: 'pr:acme/app#12' });
    expect(prAlias.status).toBe(200);
    expect(JSON.stringify(prAlias.body)).toBe(JSON.stringify(prGeneric.body));

    expect((await requestOn('POST', '/sessions/ghost/ack')).status).toBe(404);
    expect((await requestOn('POST', '/prs/acme/app/999/ack')).status).toBe(404);
  });

  it('404s every attention route when no attention service is wired', async () => {
    await startServer({ withAttention: false });
    for (const [method, url] of [
      ['GET', '/attention'],
      ['POST', '/attention/ack'],
      ['POST', '/sessions/x/ack'],
      ['POST', '/prs/acme/app/12/ack'],
    ] as const) {
      const res = await requestOn(method, url, method === 'POST' ? { ref: 'session:x' } : undefined);
      expect(res).toEqual({ status: 404, body: { error: 'attention not configured' } });
    }
  });

  it('R18: a stub source flows through GET /attention with no route edit', async () => {
    const stub: SourceAdapter = {
      source: 'stub' as ItemSource,
      collect: async () => [
        {
          ref: 'stub:x',
          id: 'x',
          title: 'a stub item',
          repoOrContext: 'PROJ',
          derived: [{ reason: 'needs_input' as const, at: null }],
          fallbackSince: '2026-09-01T00:00:00.000Z',
          mode: null,
          stageStatus: null,
          running: false,
          claimed: false,
          links: {
            sessionId: null,
            worktreePath: null,
            prRepo: null,
            prNumber: null,
            prUrl: null,
            ticket: null,
            primaryArtifact: null,
          },
        },
      ],
      collectOne: async () => null,
    };
    await startServer({ withAttention: true, extraAdapters: [stub] });
    const res = await requestOn('GET', '/attention');
    expect(res.body.items!.map((i) => i.ref)).toEqual(['stub:x']);
    expect(res.body.items![0].attention.needsYou).toBe(true);
  });
});
