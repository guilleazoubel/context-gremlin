import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { mapPrView, PR_LIST_FIELDS } from '../../src/gh/pr-view';
import { DefaultPRDiscoveryStrategy } from '../../src/discovery/pr-discovery-strategy';
import { ReviewSessionFactory } from '../../src/pipeline/review-session-factory';
import { planReconciliation, ReconciliationTick } from '../../src/discovery/reconciliation';
import { SessionStore } from '../../src/engine/session-store';
import { stamp } from '../../src/pipeline/pipeline-service';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { DevelopmentPhase, InvestigationPhase, ReviewPhase } from '../../src/schema/pipeline';
import type { DiscoveryConfig } from '../../src/discovery/discovery-config';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const baseView = JSON.parse(readFileSync(path.join(fixturesDir, 'pr-view-open-approved.json'), 'utf8'));

function viewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...baseView, ...overrides });
}

function view(overrides: Partial<ReturnType<typeof mapPrView>> = {}): ReturnType<typeof mapPrView> {
  return {
    pr: {
      repo: 'acme/app', number: 5, url: 'https://github.com/acme/app/pull/5',
      headSha: 'a'.repeat(40), reviewedSha: null, title: 't', author: 'bob',
    },
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    ci: 'success',
    headRefName: 'fix/x',
    ...overrides,
  };
}

function prOf(repo: string, number: number, reviewedSha: string | null = 'a'.repeat(40)) {
  return {
    repo, number, url: `https://github.com/${repo}/pull/${number}`,
    headSha: 'a'.repeat(40), reviewedSha, title: 't', author: 'bob',
  };
}

function reviewSession(overrides: {
  stageStatus?: ReviewPhase;
  reviewedSha?: string | null;
  parentSessionId?: string | null;
  id?: string;
  repo?: string;
  number?: number;
} = {}): ReviewSession {
  const id = overrides.id ?? 'pr-app-5-x';
  const repo = overrides.repo ?? 'acme/app';
  const number = overrides.number ?? 5;
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git`, worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: overrides.parentSessionId ?? null, ticket: null },
    stageStatus: overrides.stageStatus ?? 'ready',
  }) as ReviewSession;
  return { ...v2, pr: prOf(repo, number, overrides.reviewedSha ?? 'a'.repeat(40)) };
}

function developmentSession(
  id: string, stageStatus: DevelopmentPhase, repo = 'acme/app', number = 5, worktreePath?: string,
): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'development', createdAt: '2026-09-01T00:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git`, ...(worktreePath ? { worktreePath } : {}) },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus,
  });
  return { ...v2, pr: prOf(repo, number) };
}

function investigationSession(id: string, stageStatus: InvestigationPhase, repo = 'acme/app', number = 5): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'investigation', createdAt: '2026-09-01T00:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus,
  });
  return { ...v2, pr: prOf(repo, number) };
}

describe('planReconciliation', () => {
  it('MERGED dismisses the review with no source', () => {
    const review = reviewSession({ stageStatus: 'ready' });
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with a development source at pr_opened dismisses the review and merges the source', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'pr_opened');
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with a development source at superseded also merges it', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'superseded');
    const { actions } = planReconciliation({ review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
  });

  it('MERGED with a development source at active also merges it (Phase 3a never records pr_opened, so active must not get stranded)', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'active');
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with an investigation source leaves the source untouched', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'inv-1' });
    const source = investigationSession('inv-1', 'approved');
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('CLOSED (not merged) dismisses the review and abandons a non-terminal development source', () => {
    const review = reviewSession({ stageStatus: 'changes_requested', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'active');
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'CLOSED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'abandoned', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('CLOSED with an investigation source leaves the source untouched', () => {
    const review = reviewSession({ stageStatus: 'changes_requested', parentSessionId: 'inv-1' });
    const source = investigationSession('inv-1', 'plan_ready');
    const { actions } = planReconciliation({ review, view: view({ state: 'CLOSED' }), source });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
  });

  it('OPEN + APPROVED from ready approves the review', () => {
    const review = reviewSession({ stageStatus: 'ready' });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from queued approves the review (an external approval is a fact regardless of local phase)', () => {
    const review = reviewSession({ stageStatus: 'queued' });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from changes_requested approves the review', () => {
    const review = reviewSession({ stageStatus: 'changes_requested' });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from failed approves the review', () => {
    const review = reviewSession({ stageStatus: 'failed' });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('MERGED from queued dismisses the review (dismissed is now reachable from queued too)', () => {
    const review = reviewSession({ stageStatus: 'queued' });
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('forbidden transition guard: an already-approved review with a MERGED view is skipped, not emitted (approved cannot go to dismissed)', () => {
    const review = reviewSession({ stageStatus: 'approved' });
    const { actions, skipped } = planReconciliation({ review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ sessionId: review.id, to: 'dismissed', why: expect.any(String) }]);
  });

  it('OPEN with a new head sha from ready requests a rereview', () => {
    const review = reviewSession({ stageStatus: 'ready', reviewedSha: 'b'.repeat(40) });
    const { actions } = planReconciliation({
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([{ type: 'rereview', sessionId: review.id, reason: expect.any(String) }]);
  });

  it('mutation guard: OPEN with a new head sha from queued does NOT request a rereview', () => {
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'b'.repeat(40) });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('an already-approved review with a new head sha is not re-reviewed', () => {
    const review = reviewSession({ stageStatus: 'approved', reviewedSha: 'b'.repeat(40) });
    const { actions } = planReconciliation({
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
  });

  it('OPEN with no decision change and no new commits produces no actions', () => {
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40) });
    const { actions, skipped } = planReconciliation({
      review, view: view({ state: 'OPEN', reviewDecision: '', pr: { ...view().pr, headSha: 'a'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

function discoveryConfig(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    repos: ['acme/app'],
    watchAuthors: ['bob'],
    me: 'me-user',
    pollIntervalMs: 60_000,
    prListLimit: 50,
    ...overrides,
  };
}

function tickHarness() {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const strategy = new DefaultPRDiscoveryStrategy(gh);
  const factory = new ReviewSessionFactory({
    gh, store: h.store, workspace: h.workspace, events: h.events,
    sessionsDir: SESSIONS_DIR, worktreesDir: WORKTREES_DIR, now: FIXED_NOW,
  });
  // Share h's own lock — StageRunner/PipelineService (inside h) and
  // ReconciliationTick must use the SAME KeyedLock instance for the
  // per-session locking invariant (pipeline-service.ts) to actually
  // serialize anything between a tick and h.service's own calls.
  const lock = h.lock;
  return { h, gh, strategy, factory, lock };
}

describe('ReconciliationTick', () => {
  it('never calls gh pr view for terminal (approved/dismissed) review sessions', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const approved = reviewSession({ id: 'pr-app-6-x', stageStatus: 'approved', repo: 'acme/app', number: 6 });
    const dismissed = reviewSession({ id: 'pr-app-7-x', stageStatus: 'dismissed', repo: 'acme/app', number: 7 });
    await h.store.save(approved);
    await h.store.save(dismissed);
    gh.queueResponse({ stdout: '[]' }); // strategy.poll's pr list for acme/app — the only gh call expected

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.reconciled).toBe(0);
    expect(gh.calls).toEqual([['pr', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', '50', '--json', PR_LIST_FIELDS]]);
    expect((await h.store.load('pr-app-6-x')).stageStatus).toBe('approved');
    expect((await h.store.load('pr-app-7-x')).stageStatus).toBe('dismissed');
  });

  it('applies a MERGED transition to a real review session on disk', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' }); // strategy.poll's pr list for acme/app

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.reconciled).toBe(1);
    expect(report.errors).toEqual([]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('dismissed');
  });

  it('stops the agent before dismissing a review session that is mid-run (reviewing), so it does not leak', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(review);

    // Start a real run so the session is genuinely 'reviewing' with an active agent handle.
    const runPromise = h.service.runReview(review.id);
    await flush();
    const handle = h.runner.lastHandle();
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');
    expect(h.runner.isStopped(handle)).toBe(false);

    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(h.runner.isStopped(handle)).toBe(true);
    expect((await h.store.load(review.id)).stageStatus).toBe('dismissed');
    void runPromise; // left pending deliberately: the fake never emits exit on its own after stop()
  });

  it('X1: stops any agent before a transition that lands on a terminal phase, not just review->dismissed (development source at active with a develop run pending)', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const source = developmentSession('dev-1', 'active', 'acme/app', 5, `${WORKTREES_DIR}/dev-1`);
    await h.store.save(source);
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5, parentSessionId: 'dev-1' });
    await h.store.save(review);

    // Start a real develop run so dev-1 has an active agent handle.
    const developPromise = h.service.runDevelop('dev-1');
    await flush();
    const handle = h.runner.lastHandle();
    expect(h.runner.isStopped(handle)).toBe(false);

    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(h.runner.isStopped(handle)).toBe(true);
    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
    void developPromise; // left pending deliberately: the fake never emits exit on its own after stop()
  });

  it('invokes runRereview for the new-commit case, seen as the review session moving to reviewing', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save(review);
    await h.workspace.createWorkspace({
      repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/${review.id}`,
      branchName: 'pr-5', baseRef: 'origin/pr/5', mode: 'review',
    });
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'c'.repeat(40) }) });
    gh.queueResponse({ stdout: '[]' });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // runRereview's rev-parse HEAD

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.actions).toEqual([{ type: 'rereview', sessionId: review.id, reason: expect.any(String) }]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('reviewing');
  });

  it('mutation guard: does not start a REREVIEW for a queued review session even with a new head sha (rereview needs a completed prior review)', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'c'.repeat(40) }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    // No rereview/transition action was proposed by planReconciliation for a
    // queued phase — but the recovery path (W2) still starts a first,
    // ordinary review for it, since it has never been run at all.
    expect(report.actions).toEqual([]);
    expect(report.started).toEqual([review.id]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('reviewing');
  });

  it('recovery: a pre-existing queued session with lastRun null is started (engine-restart recovery)', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '', headRefOid: 'a'.repeat(40) }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.started).toEqual([review.id]);
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');
  });

  it('recovery guard: a queued session with a non-null lastRun (a stopped/failed earlier attempt) is NOT auto-started — that is a human decision', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save({
      ...review,
      lastRun: {
        stage: 'review', startedAt: '2026-09-04T00:00:00.000Z', finishedAt: '2026-09-04T00:05:00.000Z',
        exitCode: null, signal: 'SIGTERM', outcome: 'stopped', error: 'stopped by user',
      },
    });
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '', headRefOid: 'a'.repeat(40) }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.started).toEqual([]);
    expect((await h.store.load(review.id)).stageStatus).toBe('queued');
  });

  it('a gh pr view rejection for one review session does not stop the others, and lands in errors', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const broken = reviewSession({ id: 'pr-app-4-x', stageStatus: 'ready', repo: 'acme/app', number: 4 });
    const healthy = reviewSession({ id: 'pr-app-5-x', stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(broken);
    await h.store.save(healthy);
    // store.list() sorts by id, so pr-app-4-x is queried before pr-app-5-x
    gh.queueResponse(new Error('gh: rate limited'));
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.errors).toEqual([{ where: expect.stringContaining('pr-app-4-x'), error: expect.stringContaining('rate limited') }]);
    expect((await h.store.load('pr-app-5-x')).stageStatus).toBe('dismissed');
  });

  it('discovers a review candidate via the strategy, creates a session for it, and starts its review within the same tick', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    gh.queueResponse({
      stdout: JSON.stringify([{
        number: 9, url: 'https://github.com/acme/app/pull/9',
        author: { login: 'bob', is_bot: false }, isDraft: false, reviewDecision: '',
        headRefOid: 'd'.repeat(40), headRefName: 'feature', baseRefName: 'main',
        title: 'new PR', updatedAt: '2026-09-04T00:00:00.000Z',
      }]),
    });
    gh.queueResponse({ stdout: viewJson({ number: 9, url: 'https://github.com/acme/app/pull/9' }) });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'], watchAuthors: ['bob'], me: 'me-user' }),
    });
    const report = await tick.run();

    expect(report.created.length).toBe(1);
    expect(report.ignoredOwn).toBe(0);
    const createdId = report.created[0];
    expect(report.started).toEqual([createdId]);
    const sessions = await h.store.list();
    expect(sessions.some((s) => s.mode === 'review' && s.pr?.number === 9)).toBe(true);
    const created = await h.store.load(createdId);
    expect(created.stageStatus).toBe('reviewing');
  });

  it('X3: starting review for a freshly discovered session is protected by the shared lock, not started until the lock is free', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    gh.queueResponse({
      stdout: JSON.stringify([{
        number: 11, url: 'https://github.com/acme/app/pull/11',
        author: { login: 'bob', is_bot: false }, isDraft: false, reviewDecision: '',
        headRefOid: 'f'.repeat(40), headRefName: 'feature', baseRefName: 'main',
        title: 'locked PR', updatedAt: '2026-09-04T00:00:00.000Z',
      }]),
    });
    gh.queueResponse({ stdout: viewJson({ number: 11, url: 'https://github.com/acme/app/pull/11' }) });

    // The factory's default id is deterministic given a fixed clock — compute
    // it ahead of time so we can hold its lock before the tick even creates it.
    const expectedId = `pr-app-11-${stamp(FIXED_NOW())}`;
    let releaseHold: () => void = () => {};
    const held = lock.withLock(expectedId, () => new Promise<void>((resolve) => { releaseHold = resolve; }));

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'], watchAuthors: ['bob'], me: 'me-user' }),
    });
    const tickPromise = tick.run();
    await flush();

    // The session was created (queued), but starting its review must be
    // blocked behind the lock we're holding for the same id.
    const createdSoFar = await h.store.load(expectedId);
    expect(createdSoFar.stageStatus).toBe('queued');

    releaseHold();
    await held;
    const report = await tickPromise;

    expect(report.created).toEqual([expectedId]);
    expect(report.started).toEqual([expectedId]);
    expect((await h.store.load(expectedId)).stageStatus).toBe('reviewing');
  });

  it('counts an own candidate but does not create a session for it', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    gh.queueResponse({
      stdout: JSON.stringify([{
        number: 10, url: 'https://github.com/acme/app/pull/10',
        author: { login: 'me-user', is_bot: false }, isDraft: false, reviewDecision: '',
        headRefOid: 'e'.repeat(40), headRefName: 'feature', baseRefName: 'main',
        title: 'my own PR', updatedAt: '2026-09-04T00:00:00.000Z',
      }]),
    });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'], watchAuthors: ['me-user'], me: 'me-user' }),
    });
    const report = await tick.run();

    expect(report.created).toEqual([]);
    expect(report.ignoredOwn).toBe(1);
    expect(gh.calls.length).toBe(1); // only the pr list call — no pr view for the own candidate
  });

  it('never throws — a strategy-level gh failure for one repo lands in errors and the tick still returns a report', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    gh.queueResponse(new Error('gh: network unreachable'));

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.created).toEqual([]);
    expect(report.ignoredOwn).toBe(0);
    expect(report.errors).toEqual([
      { where: expect.stringContaining('acme/app'), error: expect.stringContaining('network unreachable') },
    ]);
  });

  it('never throws — a failing initial store.list() lands in errors and the tick still returns a report', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    class FailingStore extends SessionStore {
      list(): Promise<Session[]> {
        return Promise.reject(new Error('disk error'));
      }
    }
    const failingStore = new FailingStore(h.fs, SESSIONS_DIR);

    const tick = new ReconciliationTick({
      gh, store: failingStore, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const report = await tick.run();

    expect(report.reconciled).toBe(0);
    expect(report.created).toEqual([]);
    // Both the initial list() and the second one (inside the discovery pass)
    // fail independently against the same broken store, so both are recorded.
    expect(report.errors.length).toBe(2);
    expect(report.errors.every((e) => e.error.includes('disk error'))).toBe(true);
    expect(gh.calls).toEqual([]);
  });

  it('links a discovered candidate to its development source via the ticket key in the branch name, then merges that source once the PR merges (proves source lookup is not always null)', async () => {
    const { h, gh, strategy, factory, lock } = tickHarness();
    const source = developmentSession('dev-1', 'pr_opened', 'acme/app', 999); // a different PR number: pass-1 (repo+number) must NOT match
    await h.store.save({ ...source, lineage: { ...source.lineage, ticket: 'APP-1' } });

    gh.queueResponse({
      stdout: JSON.stringify([{
        number: 42, url: 'https://github.com/acme/app/pull/42',
        author: { login: 'bob', is_bot: false }, isDraft: false, reviewDecision: '',
        headRefOid: 'f'.repeat(40), headRefName: 'feature/APP-1-x', baseRefName: 'main',
        title: 'linked PR', updatedAt: '2026-09-04T00:00:00.000Z',
      }]),
    });
    gh.queueResponse({
      stdout: viewJson({ number: 42, url: 'https://github.com/acme/app/pull/42', headRefName: 'feature/APP-1-x' }),
    });

    const tick = new ReconciliationTick({
      gh, store: h.store, strategy, factory, pipeline: h.service, events: h.events, lock,
      config: discoveryConfig({ repos: ['acme/app'] }),
    });
    const discoveryReport = await tick.run();
    expect(discoveryReport.created.length).toBe(1);
    const createdId = discoveryReport.created[0];
    const created = await h.store.load(createdId);
    expect(created.lineage.parentSessionId).toBe('dev-1');
    expect((await h.store.load('dev-1')).stageStatus).toBe('superseded'); // supersede fired: source was pr_opened

    gh.queueResponse({
      stdout: viewJson({
        number: 42, url: 'https://github.com/acme/app/pull/42', headRefName: 'feature/APP-1-x',
        state: 'MERGED', mergedAt: '2026-09-04T01:00:00Z',
      }),
    });
    gh.queueResponse({ stdout: '[]' });
    await tick.run();

    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
    expect((await h.store.load(createdId)).stageStatus).toBe('dismissed');
  });
});
