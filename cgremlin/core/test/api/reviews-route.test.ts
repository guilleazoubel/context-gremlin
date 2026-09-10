import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createInventoryHarness, inventoryScanConfig } from '../support/inventory-harness';
import { SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { ReviewPhase } from '../../src/schema/pipeline';

let dir: string;
let socketPath: string;
let closeServer: () => Promise<void>;
let ih: ReturnType<typeof createInventoryHarness>;

const OFF_CONFIG_SLUG = 'other/repo';
const OFF_CONFIG_URL = `https://github.com/${OFF_CONFIG_SLUG}/pull/7`;

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return requestOn(socketPath, method, urlPath, body);
}

function requestOn(
  targetSocketPath: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: targetSocketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function prViewFixture(slug: string, number: number, author: string): string {
  return JSON.stringify({
    number,
    title: `PR #${number}`,
    author: { login: author },
    headRefName: `feature-${number}`,
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    url: `https://github.com/${slug}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergedAt: null,
    closedAt: null,
    latestReviews: [],
    statusCheckRollup: [],
  });
}

function prsFixtureItem(number: number, author: string) {
  return {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    author: { login: author },
    isDraft: false,
    reviewDecision: '',
    headRefOid: 'a'.repeat(40),
    headRefName: `feature-${number}`,
    baseRefName: 'main',
    title: `PR #${number}`,
    updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [],
    reviews: [],
    comments: [],
  };
}

function reviewSessionAt(id: string, slug: string, number: number, stageStatus: ReviewPhase): ReviewSession {
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `https://github.com/${slug}.git`, worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus,
  }) as ReviewSession;
  return {
    ...v2,
    pr: {
      repo: slug,
      number,
      url: `https://github.com/${slug}/pull/${number}`,
      headSha: 'a'.repeat(40),
      reviewedSha: null,
      title: `PR #${number}`,
      author: 'bob',
    },
  };
}

// A 'reviewing' session whose lastRun claims to be running but which has no
// live pipeline run behind it — the on-disk state left behind by a crashed
// host, distinct from a genuinely live in-flight review.
function orphanedReviewingSessionAt(id: string, slug: string, number: number): ReviewSession {
  const base = reviewSessionAt(id, slug, number, 'reviewing');
  return {
    ...base,
    lastRun: {
      stage: 'review',
      startedAt: '2026-09-04T10:00:00.000Z',
      finishedAt: null,
      exitCode: null,
      signal: null,
      outcome: 'running',
      error: null,
    },
  };
}

async function startServer(name: string, harness: ReturnType<typeof createInventoryHarness>): Promise<{
  sock: string;
  close: () => Promise<void>;
}> {
  const srv = createApiServer({
    sessionStore: harness.h.store,
    workspaceManager: harness.h.workspace,
    pipeline: harness.h.service,
    fs: harness.h.fs,
    sessionsDir: SESSIONS_DIR,
    events: harness.h.events,
    lock: harness.h.lock,
    inventory: {
      scanner: harness.scanner,
      scheduler: harness.scheduler,
      factory: harness.factory,
      inventoryStore: harness.inventoryStore,
      config: { me: harness.config.me },
    },
  });
  const sock = path.join(dir, name);
  await new Promise<void>((resolve) => srv.listen(sock, resolve));
  return {
    sock,
    close: async () => {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      await rm(sock, { force: true });
    },
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-reviews-route-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  ih = createInventoryHarness();
  const started = await startServer('reviews.sock', ih);
  socketPath = started.sock;
  closeServer = started.close;
});

afterEach(async () => {
  await closeServer();
});

describe('POST /reviews (R17/R23)', () => {
  it('creates and starts a review for a PR in a repo absent from config.repos', async () => {
    expect(inventoryScanConfig().repos).not.toContain(OFF_CONFIG_SLUG);
    ih.gh.queueResponse({ stdout: prViewFixture(OFF_CONFIG_SLUG, 7, 'bob') });
    const started: string[] = [];
    ih.h.events.on('run.started', (e) => started.push(e.session.id));

    const res = await request('POST', '/reviews', { prUrl: OFF_CONFIG_URL });

    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(true);
    expect(body.started).toBe(true);
    expect(body.session.mode).toBe('review');
    expect(body.session.pr?.repo).toBe(OFF_CONFIG_SLUG);
    expect(body.session.stageStatus).toBe('reviewing');
    expect(started).toEqual([body.session.id]);
  });

  it.each([
    'https://github.com/o/r',
    'https://gitlab.com/o/r/pull/1',
    'https://github.com/o/r/pull/abc',
    'not a url',
  ])('400s a URL that is not a GitHub PR URL (%s) and creates nothing', async (prUrl) => {
    const res = await request('POST', '/reviews', { prUrl });
    expect(res.status).toBe(400);
    expect(await ih.h.store.list()).toEqual([]);
    expect(ih.gh.calls).toEqual([]);
  });

  it('400s a body with no prUrl', async () => {
    const res = await request('POST', '/reviews', {});
    expect(res.status).toBe(400);
    expect(await ih.h.store.list()).toEqual([]);
  });

  it('R23: an already-tracked PR answers 200 { created:false, started:false }, exactly as the inventory route does', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
    await ih.scanner.run();
    const existing = reviewSessionAt('pr-app-10-x', 'acme/app', 10, 'ready');
    await ih.h.store.save(existing);

    const viaUrl = await request('POST', '/reviews', { prUrl: 'https://github.com/acme/app/pull/10' });
    const viaInventory = await request('POST', '/prs/acme/app/10/review');

    expect(viaUrl.status).toBe(200);
    expect(viaInventory.status).toBe(viaUrl.status);
    expect(viaUrl.body).toEqual(viaInventory.body);
    expect((viaUrl.body as { created: boolean; started: boolean }).created).toBe(false);
    expect((viaUrl.body as { created: boolean; started: boolean }).started).toBe(false);
    expect((viaUrl.body as { session: Session }).session.id).toBe('pr-app-10-x');
    expect((await ih.h.store.list()).length).toBe(1);
    expect(() => ih.h.runner.lastHandle()).toThrow(); // nothing was started by either route
  });

  it('F4: an existing failed session with no live run is restarted via POST /reviews: 202 { created:false, started:true }', async () => {
    const existing = reviewSessionAt('pr-app-10-x', 'acme/app', 10, 'failed');
    await ih.h.store.save(existing);
    const started: string[] = [];
    ih.h.events.on('run.started', (e) => started.push(e.session.id));

    const res = await request('POST', '/reviews', { prUrl: 'https://github.com/acme/app/pull/10' });

    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
    expect((await ih.h.store.list()).length).toBe(1); // reused, not duplicated
    expect(started).toEqual(['pr-app-10-x']); // a run was actually kicked off, not just claimed in the response
  });

  it('F4: an existing queued session with no live run is restarted via POST /reviews: 202 { created:false, started:true }', async () => {
    const existing = reviewSessionAt('pr-app-10-x', 'acme/app', 10, 'queued');
    await ih.h.store.save(existing);
    const started: string[] = [];
    ih.h.events.on('run.started', (e) => started.push(e.session.id));

    const res = await request('POST', '/reviews', { prUrl: 'https://github.com/acme/app/pull/10' });

    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
    expect(started).toEqual(['pr-app-10-x']);
  });

  it('F4: an orphaned reviewing session (lastRun not actually live) is restarted via POST /reviews: 202 { created:false, started:true }', async () => {
    const existing = orphanedReviewingSessionAt('pr-app-10-x', 'acme/app', 10);
    await ih.h.store.save(existing);
    expect(ih.h.service.activeSessionIds()).not.toContain('pr-app-10-x'); // no live run on disk-only state
    const started: string[] = [];
    ih.h.events.on('run.started', (e) => started.push(e.session.id));

    const res = await request('POST', '/reviews', { prUrl: 'https://github.com/acme/app/pull/10' });

    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
    expect(started).toEqual(['pr-app-10-x']);
  });

  it('guard: POST /reviews and POST /prs/:owner/:repo/:n/review give the same answer for the same non-live session state', async () => {
    for (const [i, status] of (['failed', 'queued', 'reviewing'] as const).entries()) {
      const viaUrlHarness = createInventoryHarness();
      viaUrlHarness.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
      await viaUrlHarness.scanner.run();
      await viaUrlHarness.h.store.save(
        status === 'reviewing'
          ? orphanedReviewingSessionAt('pr-app-10-x', 'acme/app', 10)
          : reviewSessionAt('pr-app-10-x', 'acme/app', 10, status),
      );
      const viaUrlServer = await startServer(`g${i}a.sock`, viaUrlHarness);

      const viaInvHarness = createInventoryHarness();
      viaInvHarness.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
      await viaInvHarness.scanner.run();
      await viaInvHarness.h.store.save(
        status === 'reviewing'
          ? orphanedReviewingSessionAt('pr-app-10-x', 'acme/app', 10)
          : reviewSessionAt('pr-app-10-x', 'acme/app', 10, status),
      );
      const viaInvServer = await startServer(`g${i}b.sock`, viaInvHarness);

      try {
        const viaUrl = await requestOn(viaUrlServer.sock, 'POST', '/reviews', {
          prUrl: 'https://github.com/acme/app/pull/10',
        });
        const viaInv = await requestOn(viaInvServer.sock, 'POST', '/prs/acme/app/10/review');

        expect(viaInv.status).toBe(viaUrl.status);
        const urlBody = viaUrl.body as { session: Session; created: boolean; started: boolean };
        const invBody = viaInv.body as { session: Session; created: boolean; started: boolean };
        expect(invBody.created).toBe(urlBody.created);
        expect(invBody.started).toBe(urlBody.started);
        expect(invBody.session.stageStatus).toBe(urlBody.session.stageStatus);
      } finally {
        await viaUrlServer.close();
        await viaInvServer.close();
      }
    }
  });

  it('a terminal review session for that PR is not a match: a new session is created', async () => {
    const dismissed = reviewSessionAt('pr-repo-7-old', OFF_CONFIG_SLUG, 7, 'dismissed');
    await ih.h.store.save(dismissed);
    ih.gh.queueResponse({ stdout: prViewFixture(OFF_CONFIG_SLUG, 7, 'bob') });

    const res = await request('POST', '/reviews', { prUrl: OFF_CONFIG_URL });

    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean };
    expect(body.created).toBe(true);
    expect(body.session.id).not.toBe('pr-repo-7-old');
    expect((await ih.h.store.list()).length).toBe(2);
  });

  it('409s a PR authored by config.me and leaves no session and no worktree behind', async () => {
    ih.gh.queueResponse({ stdout: prViewFixture(OFF_CONFIG_SLUG, 7, 'Me-User') });

    const res = await request('POST', '/reviews', { prUrl: OFF_CONFIG_URL });

    expect(res.status).toBe(409);
    expect(await ih.h.store.list()).toEqual([]);
    expect(ih.h.git.calls.filter((c) => c.args[0] === 'worktree')).toEqual([]);
  });

  it('surfaces a gh failure as a 500 and leaves no partial session behind', async () => {
    ih.gh.queueResponse(new Error('gh: could not resolve to a PullRequest'));

    const res = await request('POST', '/reviews', { prUrl: OFF_CONFIG_URL });

    expect(res.status).toBe(500);
    expect(await ih.h.store.list()).toEqual([]);
  });

  it('MG-A12 any-pr-url-is-reviewable-exactly-once', async () => {
    // Two concurrent POST /reviews for the same URL: the pr:<slug>#<n> key
    // serializes them, so exactly one session is created and one run starts.
    ih.gh.queueResponse({ stdout: prViewFixture(OFF_CONFIG_SLUG, 7, 'bob') });
    const started: string[] = [];
    ih.h.events.on('run.started', (e) => started.push(e.session.id));

    const [a, b] = await Promise.all([
      request('POST', '/reviews', { prUrl: OFF_CONFIG_URL }),
      request('POST', '/reviews', { prUrl: OFF_CONFIG_URL }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 202]);
    const loser = (a.status === 200 ? a : b).body as { session: Session; created: boolean; started: boolean };
    expect(loser.created).toBe(false);
    expect(loser.started).toBe(false);
    expect((await ih.h.store.list()).length).toBe(1);
    expect(started.length).toBe(1);
    expect(ih.gh.calls.length).toBe(1); // the loser never reached the factory

    // ...and the same holds against the inventory-originated route, which
    // takes the identical lock key.
    const raced = createInventoryHarness();
    raced.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
    await raced.scanner.run();
    raced.gh.queueResponse({ stdout: prViewFixture('acme/app', 10, 'bob') });
    const racedServer = await startServer('reviews-race.sock', raced);
    try {
      const [c, d] = await Promise.all([
        requestOn(racedServer.sock, 'POST', '/reviews', { prUrl: 'https://github.com/acme/app/pull/10' }),
        requestOn(racedServer.sock, 'POST', '/prs/acme/app/10/review'),
      ]);
      expect([c.status, d.status].sort()).toEqual([200, 202]);
      expect((await raced.h.store.list()).length).toBe(1);
    } finally {
      await racedServer.close();
    }

    // An own PR is refused with no worktree, on the same route.
    const own = createInventoryHarness();
    own.gh.queueResponse({ stdout: prViewFixture(OFF_CONFIG_SLUG, 7, 'me-user') });
    const ownServer = await startServer('reviews-own.sock', own);
    try {
      const res = await requestOn(ownServer.sock, 'POST', '/reviews', { prUrl: OFF_CONFIG_URL });
      expect(res.status).toBe(409);
      expect(await own.h.store.list()).toEqual([]);
      expect(own.h.git.calls.filter((c) => c.args[0] === 'worktree')).toEqual([]);
    } finally {
      await ownServer.close();
    }
  });

  it('404s when the server was built with no inventory wiring (no factory to reach)', async () => {
    const bare = createApiServer({
      sessionStore: ih.h.store,
      workspaceManager: ih.h.workspace,
      pipeline: ih.h.service,
      fs: ih.h.fs,
      sessionsDir: SESSIONS_DIR,
      events: ih.h.events,
      lock: ih.h.lock,
    });
    const sock = path.join(dir, 'reviews-bare.sock');
    await new Promise<void>((resolve) => bare.listen(sock, resolve));
    try {
      const res = await requestOn(sock, 'POST', '/reviews', { prUrl: OFF_CONFIG_URL });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'inventory not configured' });
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
      await rm(sock, { force: true });
    }
  });
});
