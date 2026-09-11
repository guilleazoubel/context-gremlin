import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { createInventoryHarness, type InventoryHarness } from '../support/inventory-harness';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import type { DevelopmentSession, Session } from '../../src/schema/session';
import type { Inventory } from '../../src/inventory/inventory';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';

const HEAD_SHA = 'a'.repeat(40);
const MERGE_BASE_SHA = 'b'.repeat(40);

function devSession(id: string, overrides: Partial<DevelopmentSession> = {}): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feat/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    agent: null,
    lastRun: null,
    pr: null,
    ...overrides,
  };
}

function noWorktreeSession(id: string): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: { repoUrl: 'https://github.com/acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    agent: null,
    lastRun: null,
    pr: null,
  };
}

function inventoryWith(baseRef: string): Inventory {
  return {
    scannedAt: '2026-09-01T00:00:00.000Z',
    repos: ['acme/app'],
    errors: [],
    entries: [
      {
        ...PHASE9_ENTRY_DEFAULTS,
        repo: 'acme/app',
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
        title: 'x',
        author: 'someone',
        isDraft: false,
        headSha: 'c'.repeat(40),
        isMine: false,
        teamActivity: [],
        ours: { status: 'none' },
        seenAt: '2026-09-01T00:00:00.000Z',
        reviewDecision: '',
        updatedAt: '2026-09-01T00:00:00.000Z',
        baseRef,
      },
    ],
  };
}

let dir: string;
let socketPath: string;
/** Keeps the unix socket path short — macOS caps it at 104 bytes and `listen` then never calls back. */
let socketSeq = 0;
let server: http.Server;
let h: PipelineHarness;
let ih: InventoryHarness;

function request(method: string, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(opts: { withGit?: boolean; config?: CoreConfig; withInventory?: boolean } = {}): Promise<void> {
  ih = createInventoryHarness();
  h = ih.h;
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    ...(opts.withGit === false ? {} : { git: h.git }),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.withInventory === false
      ? {}
      : {
          inventory: {
            scanner: ih.scanner,
            scheduler: ih.scheduler,
            factory: ih.factory,
            inventoryStore: ih.inventoryStore,
            config: { me: ih.config.me },
          },
        }),
  });
  socketPath = path.join(dir, `s${(socketSeq += 1).toString()}.sock`);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgr-chg-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('GET /sessions/:id/changes (Phase 10)', () => {
  it('404s for an unknown session', async () => {
    await startServer();
    const res = await request('GET', '/sessions/nope/changes');
    expect(res.status).toBe(404);
  });

  it('is unlocked: does not take the session lock (no lock instrumentation needed — the route never calls lock.withLock)', async () => {
    await startServer();
    await h.store.save(devSession('s0'));
    // Hold the session lock for the whole request: an unlocked read must
    // still answer while another caller owns 's0'.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockHeld = h.lock.withLock('s0', () => held);
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s0/changes');
    expect(res.status).toBe(200);
    release();
    await lockHeld;
  });

  it('returns null fields when the session has no worktree yet', async () => {
    await startServer();
    await h.store.save(noWorktreeSession('s1'));
    const res = await request('GET', '/sessions/s1/changes');
    expect(res).toEqual({
      status: 200,
      body: { base: null, baseResolved: null, head: null, committed: null, workingTree: null },
    });
  });

  it('404s when no git runner is configured', async () => {
    await startServer({ withGit: false });
    await h.store.save(devSession('s2'));
    const res = await request('GET', '/sessions/s2/changes');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'git not configured' });
  });

  it("uses the PR's inventory baseRef when the session carries a pr and it is found", async () => {
    await startServer();
    await ih.inventoryStore.save(inventoryWith('origin/develop'));
    await h.store.save(
      devSession('s3', { pr: { repo: 'acme/app', number: 42, url: 'u', headSha: null, reviewedSha: null, title: null, author: null } }),
    );
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s3/changes');
    expect(res.status).toBe(200);
    expect((res.body as { base: string }).base).toBe('origin/develop');
    expect(h.git.calls[1].args).toEqual(['merge-base', 'origin/develop', 'HEAD']);
  });

  it('falls back to config.defaultBaseRef when the session has no pr', async () => {
    const config = resolveCoreConfig({ repos: ['acme/app'], me: 'me-user', defaultBaseRef: 'origin/trunk' }, '/home/x');
    await startServer({ config });
    await h.store.save(devSession('s4'));
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s4/changes');
    expect((res.body as { base: string }).base).toBe('origin/trunk');
  });

  it('falls back to config.defaultBaseRef when the pr is not found in the current inventory', async () => {
    const config = resolveCoreConfig({ repos: ['acme/app'], me: 'me-user', defaultBaseRef: 'origin/fallback' }, '/home/x');
    await startServer({ config });
    await h.store.save(
      devSession('s5', { pr: { repo: 'acme/app', number: 999, url: 'u', headSha: null, reviewedSha: null, title: null, author: null } }),
    );
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s5/changes');
    expect((res.body as { base: string }).base).toBe('origin/fallback');
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a ref with a space in it', 'origin/my branch'],
    ['a ref containing ..', 'origin/../etc'],
  ])('falls back to config.defaultBaseRef when the inventory baseRef is %s', async (_label, badBaseRef) => {
    const config = resolveCoreConfig({ repos: ['acme/app'], me: 'me-user', defaultBaseRef: 'origin/fallback' }, '/home/x');
    await startServer({ config });
    await ih.inventoryStore.save(inventoryWith(badBaseRef));
    await h.store.save(
      devSession('s7', { pr: { repo: 'acme/app', number: 42, url: 'u', headSha: null, reviewedSha: null, title: null, author: null } }),
    );
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: `${MERGE_BASE_SHA}\n`, stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s7/changes');
    expect((res.body as { base: string }).base).toBe('origin/fallback');
  });

  it('sets baseResolved:false and falls back to a three-dot diff when merge-base fails', async () => {
    await startServer();
    await h.store.save(devSession('s6'));
    h.git.queueResponse({ stdout: `${HEAD_SHA}\n`, stderr: '' });
    h.git.queueResponse(new Error('fatal: no such ref'));
    h.git.queueResponse({ stdout: '1\t0\tfoo.ts\n', stderr: '' });
    h.git.queueResponse({ stdout: 'M\tfoo.ts\n', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const res = await request('GET', '/sessions/s6/changes');
    const body = res.body as { baseResolved: boolean; committed: { files: number } };
    expect(body.baseResolved).toBe(false);
    expect(body.committed.files).toBe(1);
  });
});
