import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { PipelineService } from '../../src/pipeline/pipeline-service';
import { EngineEvents } from '../../src/engine/events';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { migrateV1ToV2, type ReviewSession, type Session, type SessionV1 } from '../../src/schema/session';
import type { SessionFileSystem } from '../../src/fs/session-file-system';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW, type PipelineHarness } from '../support/pipeline-harness';
import { createInventoryHarness, inventoryScanConfig } from '../support/inventory-harness';
import { DiscoveryScheduler } from '../../src/discovery/scheduler';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner, type ScanReport } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import type { Inventory } from '../../src/inventory/inventory';
import { ReviewSessionFactory } from '../../src/pipeline/review-session-factory';
import { FakeGhRunner } from '../support/fake-gh-runner';
import type { GhRunner } from '../../src/gh/gh-runner';
import { readFileSync } from 'node:fs';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { parseArtifactName, ValidationError } from '../../src/api/validation';

const APPROVED_PLAN = `## Review Status
- PM: ✅ Approved — solves exactly the ticket
- Principal Engineer: ✅ Approved — mechanism checks out
`;

let dir: string;
let socketPath: string;
let server: http.Server;

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
          let body: unknown;
          if (raw) {
            // Most routes return JSON; the artifact-read route returns
            // text/plain. Fall back to the raw string rather than failing
            // the request when the body isn't valid JSON.
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return requestOn(socketPath, method, urlPath, body);
}

/**
 * Wraps a SessionFileSystem and injects a real timer delay on every
 * operation, forcing genuine event-loop interleaving between concurrent
 * requests. InMemoryFileSystem alone resolves everything via microtasks,
 * so two "concurrent" HTTP requests never actually overlap without this —
 * which is exactly how the lock's effect went untested before this fix.
 */
class DelayedFileSystem implements SessionFileSystem {
  constructor(
    private readonly inner: SessionFileSystem,
    private readonly delayMs = 5,
  ) {}

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async readFile(path: string): Promise<string> {
    await this.delay();
    return this.inner.readFile(path);
  }

  async writeFile(path: string, content: string, options?: { mode?: number }): Promise<void> {
    await this.delay();
    return this.inner.writeFile(path, content, options);
  }

  async statMode(path: string): Promise<number | null> {
    await this.delay();
    return this.inner.statMode(path);
  }

  async statMtimeMs(path: string): Promise<number | null> {
    await this.delay();
    return this.inner.statMtimeMs(path);
  }

  async remove(path: string): Promise<void> {
    await this.delay();
    return this.inner.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.delay();
    return this.inner.rename(from, to);
  }

  async readdir(path: string): Promise<string[]> {
    await this.delay();
    return this.inner.readdir(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delay();
    return this.inner.mkdir(path, options);
  }

  async exists(path: string): Promise<boolean> {
    await this.delay();
    return this.inner.exists(path);
  }
}

/**
 * Builds a full server stack (store/workspace/pipeline/events) on a
 * DelayedFileSystem and listens on its own socket, so genuinely concurrent
 * requests actually interleave in the event loop instead of resolving
 * back-to-back via microtasks (see DelayedFileSystem's own doc comment).
 */
async function createDelayedServer(socketFileName: string, opts: { inventory?: boolean } = {}) {
  const delayedFs = new DelayedFileSystem(new InMemoryFileSystem());
  const git = new FakeGitRunner();
  const store = new SessionStore(delayedFs, '/sessions');
  const workspace = new WorkspaceManager(git, delayedFs, '/mirrors');
  const events = new EngineEvents();
  const runner = new FakeAgentRunner();
  const lock = new KeyedLock();
  const stageRunner = new StageRunner({
    runner,
    store,
    fs: delayedFs,
    events,
    sessionsDir: '/sessions',
    runnerKind: 'claude-code',
    lock,
  });
  const pipeline = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs: delayedFs,
    git,
    events,
    config: { sessionsDir: '/sessions', worktreesDir: '/worktrees', defaultBaseRef: 'origin/main' , runnerKind: 'claude-code', humanTurnTtlMs: 600_000 },
    lock,
  });

  let inventoryDeps: { gh: FakeGhRunner; scanner: InventoryScanner; scheduler: DiscoveryScheduler<ScanReport>; factory: ReviewSessionFactory; inventoryStore: InventoryStore } | undefined;
  if (opts.inventory) {
    const gh = new FakeGhRunner();
    const reconciliationTick = new ReconciliationTick({ gh, store, pipeline, events, lock });
    const inventoryStore = new InventoryStore(delayedFs, '/state/inventory.json');
    const scanner = new InventoryScanner({
      gh, store, inventoryStore, reconciler: { reconcile: () => reconciliationTick.run() },
      events, config: inventoryScanConfig(), now: FIXED_NOW,
    });
    const scheduler = new DiscoveryScheduler<ScanReport>(scanner, 60_000);
    const factory = new ReviewSessionFactory({
      gh, store, workspace, events, sessionsDir: '/sessions', worktreesDir: '/worktrees', now: FIXED_NOW,
    });
    inventoryDeps = { gh, scanner, scheduler, factory, inventoryStore };
  }

  const srv = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: delayedFs,
    sessionsDir: '/sessions',
    events,
    lock,
    ...(inventoryDeps
      ? {
          inventory: {
            scanner: inventoryDeps.scanner, scheduler: inventoryDeps.scheduler,
            factory: inventoryDeps.factory, inventoryStore: inventoryDeps.inventoryStore,
            config: { me: 'me-user' },
          },
        }
      : {}),
  });
  const sock = path.join(dir, socketFileName);
  await new Promise<void>((resolve) => srv.listen(sock, resolve));
  return {
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    sock,
    store,
    pipeline,
    runner,
    lock,
    events,
    workspace,
    git,
    fs: delayedFs,
    inventory: inventoryDeps,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-api-test-'));
  socketPath = path.join(dir, 'api.sock');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let h: PipelineHarness;

beforeEach(async () => {
  h = createHarness();
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(socketPath, { force: true });
});

function makeSession(overrides: Record<string, unknown> = {}): Session {
  const v1 = {
    schemaVersion: 1,
    id: 'inv-test-1',
    mode: 'investigation',
    createdAt: '2026-08-28T10:00:00.000Z',
    workspace: { repoUrl: 'git@example.com:x/y.git' },
    lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
    stageStatus: 'findings',
    ...overrides,
  } as SessionV1;
  return migrateV1ToV2(v1);
}

describe('API server', () => {
  it('GET /sessions returns an empty list initially', async () => {
    const res = await request('GET', '/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('POST /sessions creates a session, then GET /sessions/:id returns it', async () => {
    const session = makeSession();
    const createRes = await request('POST', '/sessions', session);
    expect(createRes.status).toBe(201);
    const getRes = await request('GET', `/sessions/${session.id}`);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { session: Session }).session).toEqual(session);
  });

  it('GET /sessions/:id returns 404 for an unknown id', async () => {
    const res = await request('GET', '/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /sessions/:id/transition applies a legal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'planning' });
    expect(res.status).toBe(200);
    expect((res.body as { session: Session }).session.stageStatus).toBe('planning');
  });

  it('POST /sessions/:id/transition returns 409 for an illegal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'approved' });
    expect(res.status).toBe(409);
  });

  it('unknown routes return 404', async () => {
    const res = await request('GET', '/nope');
    expect(res.status).toBe(404);
  });

  it('POST /workspaces creates a workspace via WorkspaceManager', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(res.status).toBe(201);
    expect((res.body as { mirrorPath: string }).mirrorPath).toBe(
      '/mirrors/github.com-org-repo.git',
    );
  });

  it('DELETE /workspaces tears down a workspace via WorkspaceManager', async () => {
    const res = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
    });
    expect(res.status).toBe(204);
  });

  it('POST /workspaces returns 400 for an invalid mode', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'bogus',
    });
    expect(res.status).toBe(400);
  });

  it('POST /workspaces returns 400 for a missing required field', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: '/sessions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (r) => {
          r.on('data', () => undefined);
          r.on('end', () => resolve({ status: r.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.write('{not valid json');
      req.end();
    });
    expect(res.status).toBe(400);
  });

  it('concurrent transitions to the same target for the same session id are serialized: exactly one succeeds', async () => {
    const delayedFs = new DelayedFileSystem(new InMemoryFileSystem());
    const git = new FakeGitRunner();
    const delayedStore = new SessionStore(delayedFs, '/sessions');
    const delayedWorkspaceManager = new WorkspaceManager(git, delayedFs, '/mirrors');
    const delayedEvents = new EngineEvents();
    const delayedRunner = new FakeAgentRunner();
    const delayedLock = new KeyedLock();
    const delayedStageRunner = new StageRunner({
      runner: delayedRunner,
      store: delayedStore,
      fs: delayedFs,
      events: delayedEvents,
      sessionsDir: '/sessions',
      runnerKind: 'claude-code',
      lock: delayedLock,
    });
    const delayedPipeline = new PipelineService({
      store: delayedStore,
      workspace: delayedWorkspaceManager,
      stageRunner: delayedStageRunner,
      fs: delayedFs,
      git,
      events: delayedEvents,
      config: { sessionsDir: '/sessions', worktreesDir: '/worktrees', defaultBaseRef: 'origin/main' , runnerKind: 'claude-code', humanTurnTtlMs: 600_000 },
      lock: delayedLock,
    });
    const delayedServer = createApiServer({
      sessionStore: delayedStore,
      workspaceManager: delayedWorkspaceManager,
      pipeline: delayedPipeline,
      fs: delayedFs,
      sessionsDir: '/sessions',
      events: delayedEvents,
    });
    const delayedSocketPath = path.join(dir, 'concurrency.sock');
    await new Promise<void>((resolve) => delayedServer.listen(delayedSocketPath, resolve));

    try {
      const session = makeSession({ id: 'inv-race', stageStatus: 'findings' });
      await requestOn(delayedSocketPath, 'POST', '/sessions', session);
      const [r1, r2] = await Promise.all([
        requestOn(delayedSocketPath, 'POST', '/sessions/inv-race/transition', { to: 'planning' }),
        requestOn(delayedSocketPath, 'POST', '/sessions/inv-race/transition', { to: 'planning' }),
      ]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
    } finally {
      await new Promise<void>((resolve) => delayedServer.close(() => resolve()));
      await rm(delayedSocketPath, { force: true });
    }
  });

  it('POST /sessions/investigations creates a session at findings and creates the worktree', async () => {
    const res = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-1',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    expect(res.status).toBe(201);
    const body = res.body as { session: Session };
    expect(body.session.stageStatus).toBe('findings');
    const worktreeAdd = h.git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(worktreeAdd).toBeDefined();
  });

  it('POST /sessions/:id/run starts a stage run (202, lastRun running), and the run completes in the background', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-2',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    const runRes = await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    expect(runRes.status).toBe(202);
    expect((runRes.body as { session: Session }).session.lastRun?.outcome).toBe('running');

    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });

    const getRes = await request('GET', `/sessions/${id}`);
    expect((getRes.body as { session: Session }).session.lastRun?.outcome).toBe('succeeded');
  });

  it('POST /sessions/:id/run while a run is still pending returns 409 RunInProgressError for the second request', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-3',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    const firstRes = await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    expect(firstRes.status).toBe(202);

    // No exit has been emitted yet: the first run is genuinely still pending.
    const secondRes = await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    expect(secondRes.status).toBe(409);
  });

  it('POST /sessions/:id/run rejects a stage the session mode does not own (409) and an unknown stage (400)', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-4',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    const reviewRes = await request('POST', `/sessions/${id}/run`, { stage: 'review' });
    expect(reviewRes.status).toBe(409);

    const bogusRes = await request('POST', `/sessions/${id}/run`, { stage: 'bogus' });
    expect(bogusRes.status).toBe(400);
  });

  it('POST /sessions/:id/promote rejects with 409 PlanGateError before approve-plan, then succeeds with both sessions after', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-5',
      intent: 'development',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });
    await h.finishRun({ 'PLAN.md': APPROVED_PLAN }, { code: 0, signal: null });

    const afterPlanRes = await request('GET', `/sessions/${id}`);
    expect((afterPlanRes.body as { session: Session }).session.stageStatus).toBe('plan_ready');

    const promoteRejectRes = await request('POST', `/sessions/${id}/promote`);
    expect(promoteRejectRes.status).toBe(409);

    const approveRes = await request('POST', `/sessions/${id}/approve-plan`);
    expect(approveRes.status).toBe(200);

    const promoteRes = await request('POST', `/sessions/${id}/promote`);
    expect(promoteRes.status).toBe(202);
    const promoteBody = promoteRes.body as { investigation: Session; development: Session };
    expect(promoteBody.investigation.stageStatus).toBe('promoted_to_development');
    expect(promoteBody.development.stageStatus).toBe('active');
  });

  it('GET /sessions/:id/artifacts/:name reads an artifact, 404s when missing, 400s a disallowed name, and allows a versioned REVIEW-vN.md', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-6',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;
    await h.fs.writeFile(`${SESSIONS_DIR}/${id}/PLAN.md`, '# Plan text');
    await h.fs.writeFile(`${SESSIONS_DIR}/${id}/REVIEW-v2.md`, 'archived review');

    const planRes = await request('GET', `/sessions/${id}/artifacts/PLAN.md`);
    expect(planRes.status).toBe(200);
    expect(planRes.body).toBe('# Plan text');

    const missingRes = await request('GET', `/sessions/${id}/artifacts/DEVELOPMENT.md`);
    expect(missingRes.status).toBe(404);

    // Not a path-traversal payload (the URL parser normalizes literal '..'
    // segments before the route ever sees them) but a disallowed name —
    // exactly the class of request the artifact allow-list exists to reject.
    const invalidRes = await request('GET', `/sessions/${id}/artifacts/session.json`);
    expect(invalidRes.status).toBe(400);

    const versionedRes = await request('GET', `/sessions/${id}/artifacts/REVIEW-v2.md`);
    expect(versionedRes.status).toBe(200);
    expect(versionedRes.body).toBe('archived review');
  });

  it('DELETE /workspaces refuses removal while an active development session shares the worktree, then allows it once abandoned', async () => {
    const session = makeSession({
      id: 'dev-1',
      mode: 'development',
      stageStatus: 'active',
      workspace: { repoUrl: 'git@github.com:org/repo.git', worktreePath: '/work/inv-1' },
    });
    await h.store.save(session);

    const blockedRes = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
    });
    expect(blockedRes.status).toBe(409);

    await h.store.transition('dev-1', 'abandoned');

    const allowedRes = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
    });
    expect(allowedRes.status).toBe(204);
  });

  it('POST /sessions/:id/stop stops a running run (true) and reports false when idle', async () => {
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-7',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    const stopRes = await request('POST', `/sessions/${id}/stop`);
    expect(stopRes.status).toBe(200);
    expect((stopRes.body as { stopped: boolean }).stopped).toBe(true);

    h.runner.emitExit(h.runner.lastHandle(), { code: null, signal: 'SIGTERM' });
    await flush();

    const idleStopRes = await request('POST', `/sessions/${id}/stop`);
    expect((idleStopRes.body as { stopped: boolean }).stopped).toBe(false);
  });

  it('POST /sessions/:id/run immediately followed by POST /sessions/:id/stop on the same id completes without deadlocking', async () => {
    // /run no longer wraps in the server's lock (PipelineService locks the
    // pre-run window itself, releasing exactly at run.started, before the
    // HTTP response for /run is even sent) — /stop still does wrap in the
    // server's lock. If /run's lock were somehow still held when /stop's
    // request lands, this would hang forever (KeyedLock is not re-entrant,
    // but a lock held by a DIFFERENT request never releases from here).
    const createRes = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-7b',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const id = (createRes.body as { session: Session }).session.id;

    const start = Date.now();
    const runRes = await request('POST', `/sessions/${id}/run`, { stage: 'findings' });
    expect(runRes.status).toBe(202);
    const stopRes = await request('POST', `/sessions/${id}/stop`);
    expect(stopRes.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(1000);

    h.runner.emitExit(h.runner.lastHandle(), { code: null, signal: 'SIGTERM' });
    await flush();
  });

  it('POST /sessions/:id/promote filters run.started by the actual development session, so concurrent promotes do not cross-assign', async () => {
    const d = await createDelayedServer('promote-race.sock');
    try {
      const invA = await d.pipeline.createInvestigationSession({
        repoUrl: 'git@github.com:acme/app.git', ticket: 'A-1', intent: 'investigate_only', driveToCompletion: false,
      });
      const invB = await d.pipeline.createInvestigationSession({
        repoUrl: 'git@github.com:acme/app.git', ticket: 'B-1', intent: 'investigate_only', driveToCompletion: false,
      });
      for (const inv of [invA, invB]) {
        await d.store.transition(inv.id, 'planning');
        await d.store.transition(inv.id, 'plan_ready');
        await d.store.transition(inv.id, 'approved');
      }

      const [resA, resB] = await Promise.all([
        requestOn(d.sock, 'POST', `/sessions/${invA.id}/promote`),
        requestOn(d.sock, 'POST', `/sessions/${invB.id}/promote`),
      ]);
      expect(resA.status).toBe(202);
      expect(resB.status).toBe(202);
      const bodyA = resA.body as { investigation: Session; development: Session };
      const bodyB = resB.body as { investigation: Session; development: Session };
      expect(bodyA.investigation.id).toBe(invA.id);
      expect(bodyB.investigation.id).toBe(invB.id);
      expect(bodyA.development.lineage.parentSessionId).toBe(invA.id);
      expect(bodyB.development.lineage.parentSessionId).toBe(invB.id);
    } finally {
      await d.close();
      await rm(d.sock, { force: true });
    }
  });

  it('a develop run\'s post-exit patch never clobbers a concurrent /transition to abandoned (the proven session-store race), over 20 iterations', async () => {
    const d = await createDelayedServer('post-run-lock-race.sock');
    try {
      for (let i = 0; i < 20; i++) {
        const devId = `dev-race-${i}`;
        const worktreePath = `/worktrees/${devId}`;
        const dev = makeSession({
          id: devId,
          mode: 'development',
          stageStatus: 'active',
          workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath },
          lineage: { pipelineId: devId, parentSessionId: null, ticket: null },
        });
        await d.store.save(dev);

        const runRes = await requestOn(d.sock, 'POST', `/sessions/${devId}/run`, { stage: 'develop' });
        expect(runRes.status).toBe(202);

        // Emitting exit here kicks off StageRunner's post-exit lastRun/agent
        // patch (load -> save, each delayed by DelayedFileSystem) in the
        // background; the transition request below races it for real,
        // exercising the exact clobber this fix closes — not a simulated one.
        d.runner.emitExit(d.runner.lastHandle(), { code: 0, signal: null });

        const abandonRes = await requestOn(d.sock, 'POST', `/sessions/${devId}/transition`, { to: 'abandoned' });
        expect(abandonRes.status).toBe(200);

        // Let both in-flight delayed writes fully settle before asserting —
        // whichever of the two actually wrote last, the lock serializes them
        // so the later one always sees (and preserves) the earlier one's write.
        await new Promise((resolve) => setTimeout(resolve, 80));

        const final = await d.store.load(devId);
        expect(final.stageStatus).toBe('abandoned');
        // The transition must not clobber StageRunner's own write either —
        // lastRun still reflects the agent's real outcome, not wiped by
        // whichever write landed last.
        expect(final.lastRun).toMatchObject({ outcome: 'succeeded' });

        const removeRes = await requestOn(d.sock, 'DELETE', '/workspaces', {
          repoUrl: 'git@github.com:acme/app.git',
          worktreePath,
          branchName: 'main',
        });
        expect(removeRes.status).toBe(204);
      }
    } finally {
      await d.close();
      await rm(d.sock, { force: true });
    }
  }, 20_000);

  it('POST /run develop racing POST /transition to abandoned: never a running agent on an abandoned session, over 20 iterations', async () => {
    const d = await createDelayedServer('run-vs-abandon-race.sock');
    try {
      for (let i = 0; i < 20; i++) {
        const devId = `dev-race-b-${i}`;
        const worktreePath = `/worktrees/${devId}`;
        const dev = makeSession({
          id: devId,
          mode: 'development',
          stageStatus: 'active',
          workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath },
          lineage: { pipelineId: devId, parentSessionId: null, ticket: null },
        });
        await d.store.save(dev);

        // Race the run's pre-run eligibility check + start against the
        // abandon transition landing at roughly the same moment — either
        // ordering is acceptable (refused, or started before the abandon
        // committed), but the two writes must never leave an inconsistent
        // combination behind.
        const [runRes, abandonRes] = await Promise.all([
          requestOn(d.sock, 'POST', `/sessions/${devId}/run`, { stage: 'develop' }),
          requestOn(d.sock, 'POST', `/sessions/${devId}/transition`, { to: 'abandoned' }),
        ]);
        expect([202, 409]).toContain(runRes.status);
        expect(abandonRes.status).toBe(200);

        const final = await d.store.load(devId);
        if (final.lastRun?.outcome === 'running') {
          expect(final.stageStatus).not.toBe('abandoned');
          // Clean up the still-running agent so it doesn't leak into the
          // next iteration's shared FakeAgentRunner/DelayedFileSystem state.
          d.runner.emitExit(d.runner.lastHandle(), { code: 0, signal: null });
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
    } finally {
      await d.close();
      await rm(d.sock, { force: true });
    }
  }, 20_000);

  it('a ReconciliationTick sharing the server\'s lock waits for an in-flight API rereview on the same session, then re-plans from the fresh state instead of starting a second rereview', async () => {
    const d = await createDelayedServer('shared-lock.sock');
    try {
      const reviewId = 'pr-app-5-x';
      const v1: SessionV1 = {
        schemaVersion: 1, id: reviewId, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
        workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/worktrees/pr-app-5-x', branch: 'pr-5' },
        lineage: { pipelineId: reviewId, parentSessionId: null, ticket: null },
        stageStatus: 'ready',
      };
      const review = migrateV1ToV2(v1);
      if (review.mode !== 'review') throw new Error('mode changed');
      review.pr = {
        repo: 'acme/app', number: 5, url: 'https://github.com/acme/app/pull/5',
        headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob',
      };
      await d.store.save(review);

      const gh = new FakeGhRunner();
      // A head sha mismatch is only a rereview trigger from 'ready'/'changes_requested' —
      // if the tick used the stale 'ready' snapshot instead of waiting on the shared lock
      // and re-reading fresh, it would see this mismatch as eligible and try a second,
      // concurrent rereview on the session the API call is already running.
      gh.queueResponse({ stdout: JSON.stringify({
        number: 5, title: 't', author: { login: 'bob' }, headRefName: 'pr-5', headRefOid: 'b'.repeat(40),
        baseRefName: 'main', url: 'https://github.com/acme/app/pull/5', state: 'OPEN', isDraft: false,
        reviewDecision: '', mergedAt: null, closedAt: null, latestReviews: [], statusCheckRollup: [],
      }) });

      const tick = new ReconciliationTick({
        gh, store: d.store, pipeline: d.pipeline, events: d.events, lock: d.lock,
      });

      const apiRequest = requestOn(d.sock, 'POST', `/sessions/${reviewId}/rereview`);
      // Give the API request a head start acquiring the lock before the tick races in —
      // the delayed fs makes its own path slow enough that this margin is generous.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const report = await tick.run();
      const apiRes = await apiRequest;

      expect(apiRes.status).toBe(202);
      expect(report.errors).toEqual([]);
      // No rereview or transition action was planned: the tick's fresh, lock-protected
      // read saw 'reviewing' (not rereview-eligible), not the stale 'ready' snapshot.
      expect(report.actions).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect((await d.store.load(reviewId)).stageStatus).toBe('reviewing');
    } finally {
      await d.close();
      await rm(d.sock, { force: true });
    }
  });

  it('POST /sessions/:id/run filters run.started by session id, so an unrelated pending run does not resolve it early', async () => {
    const createY = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git', ticket: 'Y-1', intent: 'investigate_only', driveToCompletion: false,
    });
    const idY = (createY.body as { session: Session }).session.id;

    // StageRunner.run() persists the 'running' lastRun via store.save()
    // BEFORE it emits run.started (emitting doesn't wait on runner.start()
    // at all) — so hold store.save open to keep Y's own run.started from
    // firing until we release it below. Any resolution observed in the
    // meantime MUST come from the unrelated event if the id filter were
    // missing — deterministic, unlike trying to win a real timing race
    // between two live runs.
    const originalSave = h.store.save.bind(h.store);
    let releaseSave: (() => void) | undefined;
    h.store.save = (session) =>
      new Promise((resolve, reject) => {
        releaseSave = () => originalSave(session).then(resolve, reject);
      });

    let settled = false;
    const pending = request('POST', `/sessions/${idY}/run`, { stage: 'findings' })
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });
    // A real socket round-trip is involved (unlike the in-process pipeline
    // tests), so wait on a real timer rather than a single microtask/
    // setImmediate flush — that's not enough to guarantee the request has
    // even been received yet, let alone routed and awaiting run.started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // Y's own run.started has not fired yet

    // An unrelated session's run.started fires on the same shared
    // EngineEvents instance while Y's listener is still registered.
    h.events.emit('run.started', {
      session: { id: 'unrelated-id', mode: 'investigation' } as unknown as Session,
      stage: 'findings',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false); // must not have resolved from the unrelated event

    releaseSave?.(); // let Y's own run.started fire for real, so the request (and its socket) can finish cleanly
    await pending;
  });

  it('DELETE /workspaces normalizes worktree paths (trailing slash) before the in-use compare, and 400s an absent body', async () => {
    const session = makeSession({
      id: 'dev-2',
      mode: 'development',
      stageStatus: 'active',
      workspace: { repoUrl: 'git@github.com:org/repo.git', worktreePath: '/work/inv-2' },
    });
    await h.store.save(session);

    const blockedRes = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-2/',
      branchName: 'main',
    });
    expect(blockedRes.status).toBe(409);

    const emptyBodyRes = await request('DELETE', '/workspaces');
    expect(emptyBodyRes.status).toBe(400);
  });

  it('POST /sessions/investigations rejects a ticket containing characters that would produce an unsafe id', async () => {
    const res = await request('POST', '/sessions/investigations', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: '../../x',
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    expect(res.status).toBe(400);
  });

  it('MG-2 secret-not-an-artifact: .bypass-secret is never readable through the artifact route', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    await h.fs.writeFile(`${SESSIONS_DIR}/${session.id}/.bypass-secret`, 'S3CRET-VALUE\n');

    const res = await request('GET', `/sessions/${session.id}/artifacts/.bypass-secret`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('S3CRET-VALUE');
  });

  it('GET /sessions/:id/artifacts/:name 404s an unknown session id even when a stray file exists at that path', async () => {
    // A leftover file on disk with no corresponding saved session — the
    // route must still 404 via sessionStore.load(id), not just check the
    // file's existence (which would incorrectly succeed).
    await h.fs.mkdir(`${SESSIONS_DIR}/ghost-1`, { recursive: true });
    await h.fs.writeFile(`${SESSIONS_DIR}/ghost-1/PLAN.md`, 'leftover file');

    const res = await request('GET', '/sessions/ghost-1/artifacts/PLAN.md');
    expect(res.status).toBe(404);
  });

  it('POST /sessions/:id/transition emits a session.transitioned event', async () => {
    const emitted: Array<{ from: string; to: string }> = [];
    h.events.on('session.transitioned', (e) => emitted.push({ from: e.from, to: e.to }));
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'planning' });
    expect(res.status).toBe(200);
    expect(emitted).toEqual([{ from: 'findings', to: 'planning' }]);
  });

  it('GET /prs 404s when inventory is not configured', async () => {
    const res = await request('GET', '/prs');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'inventory not configured' });
  });

  it('POST /prs/scan 404s when inventory is not configured', async () => {
    const res = await request('POST', '/prs/scan');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'inventory not configured' });
  });

  it('GET /prs/status 404s when inventory is not configured', async () => {
    const res = await request('GET', '/prs/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'inventory not configured' });
  });
});

function prsFixtureItem(number: number, author: string, overrides: Record<string, unknown> = {}) {
  return {
    number, url: `https://github.com/acme/app/pull/${number}`, author: { login: author },
    isDraft: false, reviewDecision: '', headRefOid: 'a'.repeat(40), headRefName: `feature-${number}`,
    baseRefName: 'main', title: `PR #${number}`, updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [], reviews: [], comments: [], ...overrides,
  };
}

function prViewFixture(number: number, author: string) {
  return JSON.stringify({
    number, title: `PR #${number}`, author: { login: author }, headRefName: `feature-${number}`,
    headRefOid: 'a'.repeat(40), baseRefName: 'main', url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN', isDraft: false, reviewDecision: '', mergedAt: null, closedAt: null,
    latestReviews: [], statusCheckRollup: [],
  });
}

function queuedReviewSession(id: string, number: number): ReviewSession {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'queued',
  }) as ReviewSession;
  return {
    ...v2,
    pr: {
      repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`,
      headSha: 'a'.repeat(40), reviewedSha: null, title: `PR #${number}`, author: 'bob',
    },
  };
}

function failedReviewSession(id: string, number: number): ReviewSession {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'failed',
  }) as ReviewSession;
  return {
    ...v2,
    pr: {
      repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`,
      headSha: 'a'.repeat(40), reviewedSha: null, title: `PR #${number}`, author: 'bob',
    },
  };
}

function reviewingReviewSession(id: string, number: number): ReviewSession {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'reviewing',
  }) as ReviewSession;
  return {
    ...v2,
    lastRun: {
      stage: 'review', startedAt: '2026-09-04T10:00:00.000Z', finishedAt: null,
      exitCode: null, signal: null, outcome: 'running', error: null,
    },
    pr: {
      repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`,
      headSha: 'a'.repeat(40), reviewedSha: null, title: `PR #${number}`, author: 'bob',
    },
  };
}

describe('PR inventory routes (configured)', () => {
  let prsSocketPath: string;
  let prsServer: http.Server;
  let ih: ReturnType<typeof createInventoryHarness>;

  function prsRequest(method: string, urlPath: string, body?: unknown) {
    return requestOn(prsSocketPath, method, urlPath, body);
  }

  beforeEach(async () => {
    ih = createInventoryHarness();
    ih.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob'), prsFixtureItem(11, 'me-user')]) });
    await ih.scanner.run();

    prsSocketPath = path.join(dir, 'api-prs.sock');
    prsServer = createApiServer({
      sessionStore: ih.h.store,
      workspaceManager: ih.h.workspace,
      pipeline: ih.h.service,
      fs: ih.h.fs,
      sessionsDir: SESSIONS_DIR,
      events: ih.h.events,
      inventory: {
        scanner: ih.scanner, scheduler: ih.scheduler, factory: ih.factory, inventoryStore: ih.inventoryStore,
        config: { me: ih.config.me },
      },
      lock: ih.h.lock,
    });
    await new Promise<void>((resolve) => prsServer.listen(prsSocketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => prsServer.close(() => resolve()));
    await rm(prsSocketPath, { force: true });
  });

  it('GET /prs returns the inventory and groups from the last scan', async () => {
    const res = await prsRequest('GET', '/prs');
    expect(res.status).toBe(200);
    const body = res.body as { inventory: { entries: unknown[] }; groups: { unreviewed: unknown[]; mine: unknown[] } };
    expect(body.inventory.entries.length).toBe(2);
    expect(body.groups.unreviewed.length).toBe(1);
    expect(body.groups.mine.length).toBe(1);
  });

  it('GET /prs/:owner/:repo/:number returns the single entry', async () => {
    const res = await prsRequest('GET', '/prs/acme/app/10');
    expect(res.status).toBe(200);
    expect((res.body as { entry: { number: number } }).entry.number).toBe(10);
  });

  it('GET /prs/:owner/:repo/:number 404s for a PR not in the inventory', async () => {
    const res = await prsRequest('GET', '/prs/acme/app/999');
    expect(res.status).toBe(404);
  });

  it('POST /prs/scan runs a fresh scan and returns the ScanReport', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob'), prsFixtureItem(11, 'me-user')]) });
    const res = await prsRequest('POST', '/prs/scan');
    expect(res.status).toBe(200);
    expect((res.body as { inventory: { entries: unknown[] } }).inventory.entries.length).toBe(2);
  });

  it('A5: POST /prs/scan carries the jira block, with no token in it', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
    const res = await prsRequest('POST', '/prs/scan');
    expect(res.status).toBe(200);
    const body = res.body as { jira: { kind: string; issues: unknown[]; error: string | null } };
    expect(body.jira.kind).toBe('notConfigured');
    expect(body.jira.issues).toEqual([]);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('apitoken');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('authorization');
  });

  it('GET /prs/status reports running/lastScanAt/lastError/skippedBeats', async () => {
    const res = await prsRequest('GET', '/prs/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      running: false, lastScanAt: FIXED_NOW().toISOString(), lastError: null, skippedBeats: 0,
    });
  });

  it('POST /prs/:owner/:repo/:number/review on an own PR returns 409', async () => {
    const res = await prsRequest('POST', '/prs/acme/app/11/review');
    expect(res.status).toBe(409);
  });

  it('POST /prs/:owner/:repo/:number/review on a PR not in the inventory returns 404', async () => {
    const res = await prsRequest('POST', '/prs/acme/app/999/review');
    expect(res.status).toBe(404);
  });

  it('POST /prs/:owner/:repo/:number/review creates and starts a review for a fresh PR', async () => {
    ih.gh.queueResponse({ stdout: prViewFixture(10, 'bob') }); // ReviewSessionFactory's own gh pr view call
    const res = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(true);
    expect(body.started).toBe(true);
    expect(body.session.stageStatus).toBe('reviewing');
    expect((await ih.h.store.list()).length).toBe(1);
  });

  it('an existing queued session with no live run is started: 202 { created:false, started:true }', async () => {
    const review = queuedReviewSession('pr-app-10-x', 10);
    await ih.h.store.save(review);
    const res = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
    expect((await ih.h.store.list()).length).toBe(1); // reused, not duplicated
  });

  it('F4: an existing failed session with no live run is restarted: 202 { created:false, started:true }', async () => {
    const review = failedReviewSession('pr-app-10-x', 10);
    await ih.h.store.save(review);
    const res = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
  });

  it('F4: an existing reviewing session with no live run (orphaned by a crashed host) is marked failed then restarted: 202 { created:false, started:true }', async () => {
    const review = reviewingReviewSession('pr-app-10-x', 10);
    await ih.h.store.save(review);
    expect(ih.h.service.activeSessionIds()).not.toContain('pr-app-10-x'); // no live run on disk-only state
    const res = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(res.status).toBe(202);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(true);
    expect(body.session.id).toBe('pr-app-10-x');
    expect(body.session.stageStatus).toBe('reviewing');
  });

  it('F4: a genuinely live reviewing session (in activeSessionIds) responds 200 { created:false, started:false } and starts no second run', async () => {
    ih.gh.queueResponse({ stdout: prViewFixture(10, 'bob') }); // ReviewSessionFactory's own gh pr view call
    const firstRes = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(firstRes.status).toBe(202);
    const sessionId = (firstRes.body as { session: Session }).session.id;
    expect(ih.h.service.activeSessionIds()).toContain(sessionId);
    const handleBefore = ih.h.runner.lastHandle().id;

    const res = await prsRequest('POST', '/prs/acme/app/10/review');
    expect(res.status).toBe(200);
    const body = res.body as { session: Session; created: boolean; started: boolean };
    expect(body.created).toBe(false);
    expect(body.started).toBe(false);
    expect(body.session.id).toBe(sessionId);
    expect(ih.h.runner.lastHandle().id).toBe(handleBefore); // no second agent handle was started
  });

  it('?refresh=1 runs exactly one additional scan before deciding', async () => {
    // PR #12 does not exist in the beforeEach scan — only visible once the
    // refresh scan (queued here) actually runs, proving it really happened.
    ih.gh.queueResponse({
      stdout: JSON.stringify([prsFixtureItem(10, 'bob'), prsFixtureItem(11, 'me-user'), prsFixtureItem(12, 'carol')]),
    });
    ih.gh.queueResponse({ stdout: prViewFixture(12, 'carol') }); // factory's own gh pr view call
    const res = await prsRequest('POST', '/prs/acme/app/12/review?refresh=1');
    expect(res.status).toBe(202);
    const inv = await ih.inventoryStore.load();
    expect(inv?.entries.length).toBe(3);
  });

  it('mutation guard: GET /prs and POST /prs/scan create no sessions and start no runs', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob'), prsFixtureItem(11, 'me-user')]) });
    await prsRequest('GET', '/prs');
    await prsRequest('POST', '/prs/scan');
    expect(await ih.h.store.list()).toEqual([]);
    expect(() => ih.h.runner.lastHandle()).toThrow();
  });
});

it('two concurrent POST /prs/.../review for the same fresh PR create exactly one session', async () => {
  const d = await createDelayedServer('prs-race.sock', { inventory: true });
  try {
    if (!d.inventory) throw new Error('inventory deps missing');
    d.inventory.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(20, 'bob')]) });
    await d.inventory.scanner.run();
    // Only ONE request should ever reach the factory's own gh pr view call —
    // the second, lock-serialized request must see the first's session via
    // its own fresh store.list() lookup instead of creating a duplicate.
    d.inventory.gh.queueResponse({ stdout: prViewFixture(20, 'bob') });

    const [resA, resB] = await Promise.all([
      requestOn(d.sock, 'POST', '/prs/acme/app/20/review'),
      requestOn(d.sock, 'POST', '/prs/acme/app/20/review'),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([200, 202]);
    expect((await d.store.list()).length).toBe(1);
  } finally {
    await d.close();
  }
});

it('F6: POST .../review?refresh=1 waits for a pending scheduler tick instead of colliding with it', async () => {
  class SlowGhRunner implements GhRunner {
    constructor(private readonly inner: GhRunner, private readonly delayMs: number) {}
    async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return this.inner.run(args);
    }
  }
  const slow = createInventoryHarness(inventoryScanConfig(), (gh) => new SlowGhRunner(gh, 30));
  slow.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) });
  await slow.scanner.run(); // baseline scan, so PR #10 is in the inventory

  const slowSocketPath = path.join(dir, 'api-f6-slow.sock');
  const slowServer = createApiServer({
    sessionStore: slow.h.store,
    workspaceManager: slow.h.workspace,
    pipeline: slow.h.service,
    fs: slow.h.fs,
    sessionsDir: SESSIONS_DIR,
    events: slow.h.events,
    lock: slow.h.lock,
    inventory: {
      scanner: slow.scanner, scheduler: slow.scheduler, factory: slow.factory, inventoryStore: slow.inventoryStore,
      config: { me: slow.config.me },
    },
  });
  await new Promise<void>((resolve) => slowServer.listen(slowSocketPath, resolve));
  try {
    slow.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) }); // the pending scheduler tick's pr list
    const pendingTick = slow.scheduler.runNow();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let it actually start before we race it

    slow.gh.queueResponse({ stdout: JSON.stringify([prsFixtureItem(10, 'bob')]) }); // the refresh=1 scan's pr list
    slow.gh.queueResponse({ stdout: prViewFixture(10, 'bob') }); // factory's own gh pr view call
    const res = await requestOn(slowSocketPath, 'POST', '/prs/acme/app/10/review?refresh=1');

    expect(res.status).toBe(202); // not 409 — it waited for the pending tick instead of colliding
    await pendingTick;
  } finally {
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    await rm(slowSocketPath, { force: true });
  }
});

it('F5/M1 + F7: GET /prs and GET /prs/status fall back to inventoryStore.load() when lastReport is null (e.g. after a process restart)', async () => {
  const fresh = createInventoryHarness();
  const preWritten: Inventory = {
    scannedAt: '2026-01-01T00:00:00.000Z',
    repos: ['acme/app'],
    entries: [],
    errors: [],
  };
  await fresh.inventoryStore.save(preWritten);
  expect(fresh.scanner.lastReport).toBeNull(); // this process never scanned

  const freshSocketPath = path.join(dir, 'api-fresh-restart.sock');
  const freshServer = createApiServer({
    sessionStore: fresh.h.store,
    workspaceManager: fresh.h.workspace,
    pipeline: fresh.h.service,
    fs: fresh.h.fs,
    sessionsDir: SESSIONS_DIR,
    events: fresh.h.events,
    lock: fresh.h.lock,
    inventory: {
      scanner: fresh.scanner, scheduler: fresh.scheduler, factory: fresh.factory, inventoryStore: fresh.inventoryStore,
      config: { me: fresh.config.me },
    },
  });
  await new Promise<void>((resolve) => freshServer.listen(freshSocketPath, resolve));
  try {
    const prsRes = await requestOn(freshSocketPath, 'GET', '/prs');
    expect(prsRes.status).toBe(200);
    expect((prsRes.body as { inventory: Inventory }).inventory.scannedAt).toBe('2026-01-01T00:00:00.000Z');

    const statusRes = await requestOn(freshSocketPath, 'GET', '/prs/status');
    expect(statusRes.status).toBe(200);
    expect((statusRes.body as { lastScanAt: string }).lastScanAt).toBe('2026-01-01T00:00:00.000Z');
  } finally {
    await new Promise<void>((resolve) => freshServer.close(() => resolve()));
    await rm(freshSocketPath, { force: true });
  }
});

const CLAIM_LIVE = {
  claimedAt: FIXED_NOW().toISOString(),
  expiresAt: new Date(FIXED_NOW().getTime() + 600_000).toISOString(),
};

function devSessionForConversation(id: string, humanTurn: typeof CLAIM_LIVE | null): Session {
  return {
    schemaVersion: 2, id, mode: 'development', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feature/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus: 'active',
    agent: { runner: 'claude-code', resumeId: 'resume-1', humanTurn },
    lastRun: null, pr: null,
  };
}

describe('conversation routes (R9, R12, R20)', () => {
  it('GET /sessions/:id/conversation returns the resume contract, 404 for an unknown session', async () => {
    await h.store.save(devSessionForConversation('dev-conv-1', CLAIM_LIVE));
    const res = await request('GET', '/sessions/dev-conv-1/conversation');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runner: 'claude-code', resumeId: 'resume-1', worktreePath: `${WORKTREES_DIR}/dev-conv-1`, claimed: true,
    });
    expect((await request('GET', '/sessions/nope/conversation')).status).toBe(404);
  });

  it('POST /sessions/:id/conversation/claim returns 200 with the session, 404 for an unknown session', async () => {
    await h.store.save(devSessionForConversation('dev-conv-2', null));
    const res = await request('POST', '/sessions/dev-conv-2/conversation/claim');
    expect(res.status).toBe(200);
    expect((res.body as { session: Session }).session.agent?.humanTurn).toEqual(CLAIM_LIVE);
    expect((await request('POST', '/sessions/nope/conversation/claim')).status).toBe(404);
  });

  it('POST /sessions/:id/conversation/claim answers 409 while a run is in flight (R9)', async () => {
    await h.store.save(devSessionForConversation('dev-conv-3', null));
    const run = h.service.runDevelop('dev-conv-3');
    run.catch(() => undefined);
    await flush();
    const res = await request('POST', '/sessions/dev-conv-3/conversation/claim');
    expect(res.status).toBe(409);
    expect((await h.store.load('dev-conv-3')).agent?.humanTurn).toBeNull();
    h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
    await run;
  });

  it('POST /sessions/:id/conversation/release returns 200 and clears the claim, 404 for an unknown session', async () => {
    await h.store.save(devSessionForConversation('dev-conv-4', CLAIM_LIVE));
    const res = await request('POST', '/sessions/dev-conv-4/conversation/release');
    expect(res.status).toBe(200);
    expect((res.body as { session: Session }).session.agent?.humanTurn).toBeNull();
    expect((await request('POST', '/sessions/nope/conversation/release')).status).toBe(404);
  });

  it('POST /sessions/:id/run and /retry answer 409 with the message for a claimed session', async () => {
    await h.store.save(devSessionForConversation('dev-conv-5', CLAIM_LIVE));
    const runRes = await request('POST', '/sessions/dev-conv-5/run', { stage: 'develop' });
    expect(runRes.status).toBe(409);
    expect((runRes.body as { error: string }).error).toMatch(/human holds the agent conversation/);

    await h.store.save({
      ...devSessionForConversation('dev-conv-6', CLAIM_LIVE),
      lastRun: {
        stage: 'develop', startedAt: FIXED_NOW().toISOString(), finishedAt: FIXED_NOW().toISOString(),
        exitCode: 1, signal: null, outcome: 'failed', error: 'boom',
      },
    });
    expect((await request('POST', '/sessions/dev-conv-6/retry')).status).toBe(409);
  });

  it('POST /sessions/:id/promote answers 409 for a claimed investigation', async () => {
    const inv = migrateV1ToV2({
      schemaVersion: 1, id: 'inv-conv-1', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/inv-conv-1` },
      lineage: { pipelineId: 'inv-conv-1', parentSessionId: null, ticket: 'APP-1' },
      stageStatus: 'approved',
    });
    await h.store.save({ ...inv, agent: { runner: 'claude-code', resumeId: null, humanTurn: CLAIM_LIVE } });
    const res = await request('POST', '/sessions/inv-conv-1/promote');
    expect(res.status).toBe(409);
    expect((await h.store.load('inv-conv-1')).stageStatus).toBe('approved');
  });

  it('none of the three conversation branches takes a route-layer lock (KeyedLock is not re-entrant)', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(__dirname, '../../src/api/server.ts'), 'utf8'),
    );
    const handler = /async function handleConversationRoute[\s\S]*?\n}\n/.exec(source);
    expect(handler, 'handleConversationRoute must exist').not.toBeNull();
    expect(handler![0]).not.toContain('withLock');
    const dispatch = /const conversationAction = [\s\S]*?\n {4}}\n/.exec(source);
    expect(dispatch, 'the conversation dispatch must exist').not.toBeNull();
    expect(dispatch![0]).not.toContain('withLock');
  });
});

describe('artifact listing and GET /config', () => {
  let listSocketPath: string;
  let listServer: http.Server;
  let lh: PipelineHarness;

  const RAW_CONFIG = {
    repos: ['acme/app'],
    me: 'me-user',
    stateDir: '/state',
    environments: {
      'acme/app': {
        vercel: { scope: 's', project: 'p', previewProject: 'pp', bypassSecret: 'S3CRET-VALUE' },
      },
    },
  };

  function listRequest(method: string, urlPath: string, body?: unknown) {
    return requestOn(listSocketPath, method, urlPath, body);
  }

  beforeEach(async () => {
    lh = createHarness();
    listServer = createApiServer({
      sessionStore: lh.store,
      workspaceManager: lh.workspace,
      pipeline: lh.service,
      fs: lh.fs,
      sessionsDir: SESSIONS_DIR,
      events: lh.events,
      lock: lh.lock,
      config: resolveCoreConfig(RAW_CONFIG, '/home/u'),
    });
    listSocketPath = path.join(dir, 'artifacts.sock');
    await new Promise<void>((resolve) => listServer.listen(listSocketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => listServer.close(() => resolve()));
    await rm(listSocketPath, { force: true });
  });

  it('GET /sessions/:id/artifacts returns every listable artifact with an ISO mtime and a size, plus the primary', async () => {
    const session = makeSession();
    await lh.store.save(session);
    await lh.fs.writeFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`, 'brief');
    await lh.fs.writeFile(`${SESSIONS_DIR}/${session.id}/PLAN.md`, '# Plan text');
    await lh.fs.writeFile(`${SESSIONS_DIR}/${session.id}/REVIEW-v2.md`, 'archived');

    const res = await listRequest('GET', `/sessions/${session.id}/artifacts`);
    expect(res.status).toBe(200);
    const body = res.body as { artifacts: Array<{ name: string; mtime: string; size: number }>; primary: string | null };
    expect([...body.artifacts].map((a) => a.name).sort()).toEqual(['BRIEF.md', 'PLAN.md', 'REVIEW-v2.md']);
    const plan = body.artifacts.find((a) => a.name === 'PLAN.md')!;
    expect(plan.size).toBe('# Plan text'.length);
    expect(plan.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.primary).toBe('PLAN.md');
  });

  it('GET /sessions/:id/artifacts 404s an unknown session', async () => {
    const res = await listRequest('GET', '/sessions/does-not-exist/artifacts');
    expect(res.status).toBe(404);
  });

  it('MG-A10 artifact-listing-respects-the-allow-list', async () => {
    const session = makeSession();
    await lh.store.save(session);
    const sessionDir = `${SESSIONS_DIR}/${session.id}`;
    await lh.fs.writeFile(`${sessionDir}/BRIEF.md`, 'brief');
    await lh.fs.writeFile(`${sessionDir}/.bypass-secret`, 'S3CRET-VALUE\n');
    await lh.fs.writeFile(`${sessionDir}/BRIEF.md.tmp`, 'half-written');
    await lh.fs.writeFile(`${sessionDir}/notes.txt`, 'scratch');
    await lh.fs.mkdir(`${sessionDir}/logs`, { recursive: true });
    await lh.fs.writeFile(`${sessionDir}/logs/dev-server.log`, 'noise');

    const res = await listRequest('GET', `/sessions/${session.id}/artifacts`);
    expect(res.status).toBe(200);
    const body = res.body as { artifacts: Array<{ name: string }>; primary: string | null };
    expect(body.artifacts.map((a) => a.name)).toEqual(['BRIEF.md']);
    expect(JSON.stringify(res.body)).not.toContain('S3CRET-VALUE');

    // The one allow-list is still the one in src/api/validation.ts, and it is
    // still the only gate on the single-artifact read.
    expect(() => parseArtifactName('.bypass-secret')).toThrow(ValidationError);
    const readRes = await listRequest('GET', `/sessions/${session.id}/artifacts/.bypass-secret`);
    expect(readRes.status).toBe(400);

    // ...and the listing reaches it by calling that same gate per readdir
    // entry, rather than through a second allow-list of its own.
    const serverSource = readFileSync(path.join(__dirname, '../../src/api/server.ts'), 'utf8');
    expect(serverSource).toMatch(/parseArtifactName\(name\)/);
  });

  it('GET /config returns the resolved config with every bypass secret redacted', async () => {
    const res = await listRequest('GET', '/config');
    expect(res.status).toBe(200);
    const { config } = res.body as { config: CoreConfig };
    expect(config.stateDir).toBe('/state');
    expect(config.sessionsDir).toBe('/state/sessions');
    expect(config.worktreesDir).toBe('/state/worktrees');
    expect(config.socketPath).toBe('/state/engine.sock');
    expect(config.repos).toEqual(['acme/app']);
    expect(config.me).toBe('me-user');
    for (const env of Object.values(config.environments)) {
      if (env.vercel !== undefined) expect(env.vercel.bypassSecret).toBe('[redacted]');
    }
    expect(JSON.stringify(res.body)).not.toContain('S3CRET-VALUE');
  });

  it('GET /config 404s on a server built without a config', async () => {
    const srv = await createDelayedServer('no-config.sock');
    try {
      const res = await requestOn(srv.sock, 'GET', '/config');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'config not available' });
    } finally {
      await srv.close();
    }
  });
});

describe('POST /sessions/developments (R16)', () => {
  it('creates a development session at active on feature/<ticket> and starts nothing', async () => {
    const runEvents: string[] = [];
    h.events.on('run.started', () => runEvents.push('run.started'));

    const res = await request('POST', '/sessions/developments', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-9',
    });

    expect(res.status).toBe(201);
    const { session } = res.body as { session: Session };
    expect(session.mode).toBe('development');
    expect(session.stageStatus).toBe('active');
    expect(session.lastRun).toBeNull();
    expect(session.workspace.branch).toBe('feature/APP-9');
    expect(session.lineage).toEqual({ pipelineId: session.id, parentSessionId: null, ticket: 'APP-9', selfReview: false });
    expect((await h.store.load(session.id)).id).toBe(session.id);

    // MG-A11 at the HTTP layer: the route starts nothing.
    expect(runEvents).toEqual([]);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('400s a ticket that would smuggle a path and a missing repoUrl, creating nothing', async () => {
    const badTicket = await request('POST', '/sessions/developments', {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: '../../x',
    });
    expect(badTicket.status).toBe(400);

    const noRepo = await request('POST', '/sessions/developments', { ticket: 'APP-9' });
    expect(noRepo.status).toBe(400);

    expect(await h.store.list()).toEqual([]);
  });
});
