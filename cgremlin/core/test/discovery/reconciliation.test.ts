import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { mapPrView } from '../../src/gh/pr-view';
import { planReconciliation, ReconciliationTick } from '../../src/discovery/reconciliation';
import { SessionStore } from '../../src/engine/session-store';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { DevelopmentPhase, InvestigationPhase, ReviewPhase } from '../../src/schema/pipeline';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const NOW = new Date('2026-09-10T12:00:00.000Z');
/** A claim that is still live at NOW. */
const LIVE_CLAIM = { claimedAt: '2026-09-10T11:55:00.000Z', expiresAt: '2026-09-10T12:05:00.000Z' };
/** A claim whose TTL ran out before NOW. */
const EXPIRED_CLAIM = { claimedAt: '2026-09-10T11:00:00.000Z', expiresAt: '2026-09-10T11:10:00.000Z' };

function claimed<S extends Session>(session: S, humanTurn: { claimedAt: string; expiresAt: string } | null): S {
  return { ...session, agent: { runner: 'claude-code' as const, resumeId: null, humanTurn } };
}
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
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with a development source at pr_opened dismisses the review and merges the source', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'pr_opened');
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with a development source at superseded also merges it', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'superseded');
    const { actions } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
  });

  it('MERGED with a development source at active also merges it (Phase 3a never records pr_opened, so active must not get stranded)', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'active');
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('MERGED with an investigation source leaves the source untouched', () => {
    const review = reviewSession({ stageStatus: 'ready', parentSessionId: 'inv-1' });
    const source = investigationSession('inv-1', 'approved');
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('CLOSED (not merged) dismisses the review and abandons a non-terminal development source', () => {
    const review = reviewSession({ stageStatus: 'changes_requested', parentSessionId: 'dev-1' });
    const source = developmentSession('dev-1', 'active');
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'CLOSED' }), source });
    expect(actions).toEqual([
      { type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) },
      { type: 'transition', sessionId: 'dev-1', to: 'abandoned', reason: expect.any(String) },
    ]);
    expect(skipped).toEqual([]);
  });

  it('CLOSED with an investigation source leaves the source untouched', () => {
    const review = reviewSession({ stageStatus: 'changes_requested', parentSessionId: 'inv-1' });
    const source = investigationSession('inv-1', 'plan_ready');
    const { actions } = planReconciliation({ now: NOW, review, view: view({ state: 'CLOSED' }), source });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
  });

  it('OPEN + APPROVED from ready approves the review', () => {
    const review = reviewSession({ stageStatus: 'ready' });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from queued approves the review (an external approval is a fact regardless of local phase)', () => {
    const review = reviewSession({ stageStatus: 'queued' });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from changes_requested approves the review', () => {
    const review = reviewSession({ stageStatus: 'changes_requested' });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('OPEN + APPROVED from failed approves the review', () => {
    const review = reviewSession({ stageStatus: 'failed' });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', reviewDecision: 'APPROVED' }), source: null,
    });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'approved', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('MERGED from queued dismisses the review (dismissed is now reachable from queued too)', () => {
    const review = reviewSession({ stageStatus: 'queued' });
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);
  });

  it('forbidden transition guard: an already-approved review with a MERGED view is skipped, not emitted (approved cannot go to dismissed)', () => {
    const review = reviewSession({ stageStatus: 'approved' });
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ sessionId: review.id, to: 'dismissed', why: expect.any(String) }]);
  });

  it('OPEN with a new head sha from ready requests a rereview', () => {
    const review = reviewSession({ stageStatus: 'ready', reviewedSha: 'b'.repeat(40) });
    const { actions } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([{ type: 'rereview', sessionId: review.id, reason: expect.any(String) }]);
  });

  it('mutation guard: OPEN with a new head sha from queued does NOT request a rereview', () => {
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'b'.repeat(40) });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('an already-approved review with a new head sha is not re-reviewed', () => {
    const review = reviewSession({ stageStatus: 'approved', reviewedSha: 'b'.repeat(40) });
    const { actions } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', pr: { ...view().pr, headSha: 'c'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
  });

  it('OPEN with no decision change and no new commits produces no actions', () => {
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40) });
    const { actions, skipped } = planReconciliation({ now: NOW,
      review, view: view({ state: 'OPEN', reviewDecision: '', pr: { ...view().pr, headSha: 'a'.repeat(40) } }), source: null,
    });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

function tickHarness() {
  const h = createHarness();
  const gh = new FakeGhRunner();
  // Share h's own lock — StageRunner/PipelineService (inside h) and
  // ReconciliationTick must use the SAME KeyedLock instance for the
  // per-session locking invariant (pipeline-service.ts) to actually
  // serialize anything between a tick and h.service's own calls.
  const lock = h.lock;
  return { h, gh, lock };
}

describe('ReconciliationTick', () => {
  it('never calls gh at all for terminal (approved/dismissed) review sessions', async () => {
    const { h, gh, lock } = tickHarness();
    const approved = reviewSession({ id: 'pr-app-6-x', stageStatus: 'approved', repo: 'acme/app', number: 6 });
    const dismissed = reviewSession({ id: 'pr-app-7-x', stageStatus: 'dismissed', repo: 'acme/app', number: 7 });
    await h.store.save(approved);
    await h.store.save(dismissed);

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.reconciled).toBe(0);
    expect(gh.calls).toEqual([]);
    expect((await h.store.load('pr-app-6-x')).stageStatus).toBe('approved');
    expect((await h.store.load('pr-app-7-x')).stageStatus).toBe('dismissed');
  });

  it('applies a MERGED transition to a real review session on disk', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.reconciled).toBe(1);
    expect(report.errors).toEqual([]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('dismissed');
  });

  it('stops the agent before dismissing a review session that is mid-run (reviewing), so it does not leak', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(review);

    // Start a real run so the session is genuinely 'reviewing' with an active agent handle.
    const runPromise = h.service.runReview(review.id);
    await flush();
    const handle = h.runner.lastHandle();
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');
    expect(h.runner.isStopped(handle)).toBe(false);

    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(h.runner.isStopped(handle)).toBe(true);
    expect((await h.store.load(review.id)).stageStatus).toBe('dismissed');
    void runPromise; // left pending deliberately: the fake never emits exit on its own after stop()
  });

  it('X1: stops any agent before a transition that lands on a terminal phase, not just review->dismissed (development source at active with a develop run pending)', async () => {
    const { h, gh, lock } = tickHarness();
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

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(h.runner.isStopped(handle)).toBe(true);
    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
    void developPromise; // left pending deliberately: the fake never emits exit on its own after stop()
  });

  it('invokes runRereview for the new-commit case, seen as the review session moving to reviewing', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save(review);
    await h.workspace.createWorkspace({
      repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/${review.id}`,
      branchName: 'pr-5', baseRef: 'origin/pr/5', mode: 'review',
    });
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'c'.repeat(40) }) });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // runRereview's rev-parse HEAD

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.actions).toEqual([{ type: 'rereview', sessionId: review.id, reason: expect.any(String) }]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('reviewing');
  });

  it('mutation guard: a queued review session is left untouched by a new head sha (rereview needs a completed prior review, and no code path auto-starts a queued session anymore)', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'c'.repeat(40) }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.actions).toEqual([]);
    expect(report.skipped).toEqual([]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('queued');
    expect(reloaded.lastRun).toBeNull();
  });

  it('mutation guard: a queued session with a non-null lastRun (a stopped/failed earlier attempt) is left untouched — starting it is a human decision, never automatic', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'queued', reviewedSha: 'a'.repeat(40), repo: 'acme/app', number: 5 });
    await h.store.save({
      ...review,
      lastRun: {
        stage: 'review', startedAt: '2026-09-04T00:00:00.000Z', finishedAt: '2026-09-04T00:05:00.000Z',
        exitCode: null, signal: 'SIGTERM', outcome: 'stopped', error: 'stopped by user',
      },
    });
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '', headRefOid: 'a'.repeat(40) }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.actions).toEqual([]);
    expect((await h.store.load(review.id)).stageStatus).toBe('queued');
  });

  it('a gh pr view rejection for one review session does not stop the others, and lands in errors', async () => {
    const { h, gh, lock } = tickHarness();
    const broken = reviewSession({ id: 'pr-app-4-x', stageStatus: 'ready', repo: 'acme/app', number: 4 });
    const healthy = reviewSession({ id: 'pr-app-5-x', stageStatus: 'ready', repo: 'acme/app', number: 5 });
    await h.store.save(broken);
    await h.store.save(healthy);
    // store.list() sorts by id, so pr-app-4-x is queried before pr-app-5-x
    gh.queueResponse(new Error('gh: rate limited'));
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.errors).toEqual([{ where: expect.stringContaining('pr-app-4-x'), error: expect.stringContaining('rate limited') }]);
    expect((await h.store.load('pr-app-5-x')).stageStatus).toBe('dismissed');
  });

  it('never throws — a failing store.list() lands in errors and the tick still returns a report', async () => {
    const { h, gh, lock } = tickHarness();
    class FailingStore extends SessionStore {
      list(): Promise<Session[]> {
        return Promise.reject(new Error('disk error'));
      }
    }
    const failingStore = new FailingStore(h.fs, SESSIONS_DIR);

    const tick = new ReconciliationTick({ gh, store: failingStore, pipeline: h.service, events: h.events, lock });
    const report = await tick.run();

    expect(report.reconciled).toBe(0);
    expect(report.errors).toEqual([{ where: 'store.list', error: expect.stringContaining('disk error') }]);
    expect(gh.calls).toEqual([]);
  });

  it('links a review session to its development source via lineage.parentSessionId, then merges that source once the PR merges (proves source lookup is not always null)', async () => {
    const { h, gh, lock } = tickHarness();
    const source = developmentSession('dev-1', 'pr_opened', 'acme/app', 42);
    await h.store.save(source);
    const review = reviewSession({
      id: 'pr-app-42-x', stageStatus: 'ready', repo: 'acme/app', number: 42, parentSessionId: 'dev-1',
    });
    await h.store.save(review);

    gh.queueResponse({
      stdout: viewJson({
        number: 42, url: 'https://github.com/acme/app/pull/42', headRefName: 'feature/APP-1-x',
        state: 'MERGED', mergedAt: '2026-09-04T01:00:00Z',
      }),
    });
    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    await tick.run();

    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
    expect((await h.store.load(review.id)).stageStatus).toBe('dismissed');
  });
});

describe('R20 — a claimed conversation skips the re-review, it never errors', () => {
  it('a live claim replaces the rereview action with one skipped entry', () => {
    const review = claimed(reviewSession({ stageStatus: 'ready', reviewedSha: 'b'.repeat(40) }), LIVE_CLAIM);
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view(), source: null });
    expect(actions).toEqual([]);
    expect(skipped).toEqual([
      { sessionId: review.id, to: 'reviewing', why: 'conversation claimed by a human turn' },
    ]);
  });

  it('no claim, or an expired one, returns the rereview action unchanged (regression pin)', () => {
    const base = reviewSession({ stageStatus: 'ready', reviewedSha: 'b'.repeat(40) });
    for (const review of [base, claimed(base, null), claimed(base, EXPIRED_CLAIM)]) {
      const { actions, skipped } = planReconciliation({ now: NOW, review, view: view(), source: null });
      expect(actions).toEqual([{ type: 'rereview', sessionId: review.id, reason: expect.any(String) }]);
      expect(skipped).toEqual([]);
    }
  });

  it('a transition-type action still applies while claimed, and the apply loop clears the claim', async () => {
    const { h, gh, lock } = tickHarness();
    const review = claimed(reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5 }), LIVE_CLAIM);
    const { actions, skipped } = planReconciliation({ now: NOW, review, view: view({ state: 'MERGED' }), source: null });
    expect(actions).toEqual([{ type: 'transition', sessionId: review.id, to: 'dismissed', reason: expect.any(String) }]);
    expect(skipped).toEqual([]);

    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z' }) });
    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW });
    const report = await tick.run();
    expect(report.errors).toEqual([]);
    const reloaded = await h.store.load(review.id);
    expect(reloaded.stageStatus).toBe('dismissed');
    expect(reloaded.agent?.humanTurn).toBeNull();
  });

  it('a full tick over a claimed re-reviewable session records zero errors and exactly one skipped entry', async () => {
    const { h, gh, lock } = tickHarness();
    const review = claimed(
      reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5, reviewedSha: 'b'.repeat(40) }),
      LIVE_CLAIM,
    );
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '' }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(report.skipped).toEqual([
      { sessionId: review.id, to: 'reviewing', why: 'conversation claimed by a human turn' },
    ]);
    // Nothing started, and the claim is untouched.
    expect((await h.store.load(review.id)).agent?.humanTurn).toEqual(LIVE_CLAIM);
    expect((await h.store.load(review.id)).stageStatus).toBe('ready');
  });
});

describe('R20 — a claim that races in AFTER planning is skipped, not errored', () => {
  it('a rereview refused by the pipeline files a skipped entry, never a report.errors entry', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5, reviewedSha: 'b'.repeat(40) });
    await h.store.save(review);
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '' }) });

    // The claim lands between the tick's locked PLANNING load (#2 — #1 is
    // store.list()'s own) and runRereview's own snapshot, so
    // planReconciliation still returns the rereview action and the refusal
    // happens in the apply loop, which is the path under test.
    const originalLoad = h.store.load.bind(h.store);
    let loads = 0;
    h.store.load = async (loadId: string) => {
      const loaded = await originalLoad(loadId);
      if (loadId === review.id) {
        loads += 1;
        if (loads === 2) await h.store.save(claimed(loaded as ReviewSession, LIVE_CLAIM));
      }
      return loaded;
    };

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW });
    const report = await tick.run();

    expect(report.errors).toEqual([]);
    expect(report.skipped).toEqual([
      { sessionId: review.id, to: 'reviewing', why: 'conversation claimed by a human turn' },
    ]);
    expect((await originalLoad(review.id)).agent?.humanTurn).toEqual(LIVE_CLAIM);
  });

  it('any OTHER rereview failure is still a report.errors entry (regression pin)', async () => {
    const { h, gh, lock } = tickHarness();
    const review = reviewSession({ stageStatus: 'ready', repo: 'acme/app', number: 5, reviewedSha: 'b'.repeat(40) });
    await h.store.save({ ...review, workspace: { repoUrl: review.workspace.repoUrl } });
    gh.queueResponse({ stdout: viewJson({ state: 'OPEN', reviewDecision: '' }) });

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW });
    const report = await tick.run();

    expect(report.skipped).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ where: review.id });
  });
});
