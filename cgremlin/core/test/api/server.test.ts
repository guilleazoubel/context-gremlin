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
import { migrateV1ToV2, type Session, type SessionV1 } from '../../src/schema/session';
import type { SessionFileSystem } from '../../src/fs/session-file-system';
import { createHarness, flush, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { createDiscoveryHarness } from '../support/discovery-harness';
import { DiscoveryScheduler } from '../../src/discovery/scheduler';
import type { GhRunner } from '../../src/gh/gh-runner';

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

  async writeFile(path: string, content: string): Promise<void> {
    await this.delay();
    return this.inner.writeFile(path, content);
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
async function createDelayedServer(socketFileName: string) {
  const delayedFs = new DelayedFileSystem(new InMemoryFileSystem());
  const git = new FakeGitRunner();
  const store = new SessionStore(delayedFs, '/sessions');
  const workspace = new WorkspaceManager(git, delayedFs, '/mirrors');
  const events = new EngineEvents();
  const runner = new FakeAgentRunner();
  const stageRunner = new StageRunner({
    runner,
    store,
    fs: delayedFs,
    events,
    sessionsDir: '/sessions',
    runnerKind: 'claude-code',
  });
  const pipeline = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs: delayedFs,
    git,
    events,
    config: { sessionsDir: '/sessions', worktreesDir: '/worktrees', defaultBaseRef: 'origin/main' },
  });
  const srv = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs: delayedFs,
    sessionsDir: '/sessions',
    events,
  });
  const sock = path.join(dir, socketFileName);
  await new Promise<void>((resolve) => srv.listen(sock, resolve));
  return {
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    sock,
    store,
    pipeline,
    runner,
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
    const delayedStageRunner = new StageRunner({
      runner: delayedRunner,
      store: delayedStore,
      fs: delayedFs,
      events: delayedEvents,
      sessionsDir: '/sessions',
      runnerKind: 'claude-code',
    });
    const delayedPipeline = new PipelineService({
      store: delayedStore,
      workspace: delayedWorkspaceManager,
      stageRunner: delayedStageRunner,
      fs: delayedFs,
      git,
      events: delayedEvents,
      config: { sessionsDir: '/sessions', worktreesDir: '/worktrees', defaultBaseRef: 'origin/main' },
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

  it('POST /discovery/tick 404s when discovery is not configured', async () => {
    const res = await request('POST', '/discovery/tick');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'discovery not configured' });
  });

  it('GET /discovery/config 404s when discovery is not configured', async () => {
    const res = await request('GET', '/discovery/config');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'discovery not configured' });
  });

  it('GET /discovery/status 404s when discovery is not configured', async () => {
    const res = await request('GET', '/discovery/status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'discovery not configured' });
  });
});

describe('discovery routes (configured)', () => {
  let discSocketPath: string;
  let discServer: http.Server;
  let dh: ReturnType<typeof createDiscoveryHarness>;

  function discRequest(method: string, urlPath: string, body?: unknown) {
    return requestOn(discSocketPath, method, urlPath, body);
  }

  beforeEach(async () => {
    dh = createDiscoveryHarness();
    discSocketPath = path.join(dir, 'api-discovery.sock');
    discServer = createApiServer({
      sessionStore: dh.h.store,
      workspaceManager: dh.h.workspace,
      pipeline: dh.h.service,
      fs: dh.h.fs,
      sessionsDir: SESSIONS_DIR,
      events: dh.h.events,
      discovery: { scheduler: new DiscoveryScheduler(dh.tick, 60_000), config: dh.config },
    });
    await new Promise<void>((resolve) => discServer.listen(discSocketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => discServer.close(() => resolve()));
    await rm(discSocketPath, { force: true });
  });

  it('POST /discovery/tick runs one tick now and returns the TickReport', async () => {
    dh.gh.queueResponse({ stdout: '[]' }); // strategy.poll's pr list for acme/app
    const res = await discRequest('POST', '/discovery/tick');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reconciled: 0, created: [], ignoredOwn: 0, errors: [] });
  });

  it('GET /discovery/config returns the configured DiscoveryConfig', async () => {
    const res = await discRequest('GET', '/discovery/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(dh.config);
  });

  it('GET /discovery/status returns running/lastReport/skippedBeats', async () => {
    const res = await discRequest('GET', '/discovery/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ running: false, lastReport: null, skippedBeats: 0 });
  });

  it('POST /discovery/tick returns 409 when a tick is already running', async () => {
    class SlowGhRunner implements GhRunner {
      constructor(private readonly inner: GhRunner, private readonly delayMs: number) {}
      async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        return this.inner.run(args);
      }
    }
    const slow = createDiscoveryHarness({}, (gh) => new SlowGhRunner(gh, 30));
    slow.gh.queueResponse({ stdout: '[]' });
    const slowSocketPath = path.join(dir, 'api-discovery-slow.sock');
    const slowServer = createApiServer({
      sessionStore: slow.h.store,
      workspaceManager: slow.h.workspace,
      pipeline: slow.h.service,
      fs: slow.h.fs,
      sessionsDir: SESSIONS_DIR,
      events: slow.h.events,
      discovery: { scheduler: new DiscoveryScheduler(slow.tick, 60_000), config: slow.config },
    });
    await new Promise<void>((resolve) => slowServer.listen(slowSocketPath, resolve));
    try {
      const first = requestOn(slowSocketPath, 'POST', '/discovery/tick');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await requestOn(slowSocketPath, 'POST', '/discovery/tick');
      expect(second.status).toBe(409);
      expect((await first).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
      await rm(slowSocketPath, { force: true });
    }
  });
});
