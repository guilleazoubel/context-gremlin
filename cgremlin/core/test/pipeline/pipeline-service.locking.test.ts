import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush, type PipelineHarness } from '../support/pipeline-harness';
import { UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import { migrateV1ToV2, type ReviewSession } from '../../src/schema/session';
import type { ReviewPhase } from '../../src/schema/pipeline';

function devSession(id: string) {
  return migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'development',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: `/w/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'active',
  });
}

async function saveReviewSession(
  h: PipelineHarness,
  id: string,
  stageStatus: ReviewPhase,
): Promise<ReviewSession> {
  const v1 = {
    schemaVersion: 1 as const,
    id,
    mode: 'review' as const,
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus,
  };
  const review = migrateV1ToV2(v1);
  if (review.mode !== 'review') throw new Error('mode changed');
  review.pr = {
    repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1',
    headSha: 'a'.repeat(40), reviewedSha: stageStatus === 'ready' ? 'a'.repeat(40) : null, title: 'T', author: 'bob',
  };
  await h.store.save(review);
  return review;
}

/** Tracks each promise's eventual settlement without awaiting it, so a still-pending winner never blocks checking on an already-settled loser. */
function track<T>(p: Promise<T>): { settled: () => { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | undefined } {
  let result: { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown } | undefined;
  p.then(
    (value) => { result = { status: 'fulfilled', value }; },
    (reason) => { result = { status: 'rejected', reason }; },
  );
  return { settled: () => result };
}

describe('PipelineService/StageRunner shared per-session lock', () => {
  it(
    "a develop run's post-exit lastRun/agent patch and a concurrent transition to 'abandoned' never clobber each other — " +
      'the transition blocks on the shared lock until the patch commits, then applies cleanly on top of it',
    async () => {
      const h = createHarness();
      const devId = 'dev-lock-1';
      await h.store.save(devSession(devId));

      // Deterministically force the exact interleaving that produced the
      // proven clobber: hold StageRunner's post-exit patch open (its 2nd
      // save for this id — the 1st is the pre-run 'running' save) so a
      // concurrent transition either races it (pre-fix: corrupts state) or
      // blocks behind it (post-fix: correct either way).
      const originalSave = h.store.save.bind(h.store);
      let saveCallsForDev = 0;
      let releasePostExitSave: (() => void) | undefined;
      h.store.save = (session) => {
        if (session.id === devId) {
          saveCallsForDev += 1;
          if (saveCallsForDev === 2) {
            return new Promise<void>((resolve, reject) => {
              releasePostExitSave = () => originalSave(session).then(resolve, reject);
            });
          }
        }
        return originalSave(session);
      };

      const runPromise = h.service.runDevelop(devId);
      await flush();
      h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
      // Let the post-exit patch's load + merge run and reach (and get held
      // at) its own store.save call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(saveCallsForDev).toBe(2);

      let transitionResolved = false;
      const transitionPromise = h.service.transition(devId, 'abandoned').then((s) => {
        transitionResolved = true;
        return s;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Proves the fix: the transition does not race the held-open patch —
      // it queues behind the same per-session lock instead.
      expect(transitionResolved).toBe(false);

      releasePostExitSave?.();
      await runPromise;
      const transitioned = await transitionPromise;

      expect(transitioned.stageStatus).toBe('abandoned');
      const final = await h.store.load(devId);
      expect(final.stageStatus).toBe('abandoned');
      expect(final.lastRun).toMatchObject({ outcome: 'succeeded' });
    },
  );

  it(
    'two concurrent runRereview calls on a ready session: exactly one runs, the other rejects cleanly ' +
      "without ever marking the session 'failed' mid-flight, and the winner still reaches 'ready'",
    async () => {
      const h = createHarness();
      const id = 'pr-lock-rereview';
      await saveReviewSession(h, id, 'ready');

      const t1 = track(h.service.runRereview(id));
      const t2 = track(h.service.runRereview(id));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const s1 = t1.settled();
      const s2 = t2.settled();
      const [loser, winnerSettled] = s1?.status === 'rejected' ? [s1, s2] : [s2, s1];
      expect(loser?.status).toBe('rejected');
      if (loser?.status === 'rejected') {
        expect(loser.reason).toBeInstanceOf(UnsupportedStageError);
      }
      expect(winnerSettled).toBeUndefined(); // the winner is still mid-agent-run, not settled yet

      // The core bug: the loser's rejection must never have marked the
      // session 'failed' while the winner's agent is still actively running.
      const midFlight = await h.store.load(id);
      expect(midFlight.stageStatus).toBe('reviewing');

      await h.finishRun({ 'REVIEW.md': '# v2', rereview_summary: '✅ 1/1 resolved' }, { code: 0, signal: null });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const final = await h.store.load(id);
      expect(final.stageStatus).toBe('ready');
    },
  );

  it(
    'two concurrent runReview calls on a queued session: exactly one runs, the other rejects cleanly ' +
      "without ever marking the session 'failed' mid-flight, and the winner still reaches 'ready'",
    async () => {
      const h = createHarness();
      const id = 'pr-lock-review';
      await saveReviewSession(h, id, 'queued');

      const t1 = track(h.service.runReview(id));
      const t2 = track(h.service.runReview(id));
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const s1 = t1.settled();
      const s2 = t2.settled();
      const [loser, winnerSettled] = s1?.status === 'rejected' ? [s1, s2] : [s2, s1];
      expect(loser?.status).toBe('rejected');
      if (loser?.status === 'rejected') {
        expect(loser.reason).toBeInstanceOf(UnsupportedStageError);
      }
      expect(winnerSettled).toBeUndefined();

      const midFlight = await h.store.load(id);
      expect(midFlight.stageStatus).toBe('reviewing');

      await h.finishRun({ 'REVIEW.md': '# Review\nfindings' }, { code: 0, signal: null });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const final = await h.store.load(id);
      expect(final.stageStatus).toBe('ready');
    },
  );

  it("runReview's post-run outcome-transition-and-pr-patch write is itself lock-protected — a concurrent transition blocks on it rather than racing it", async () => {
    const h = createHarness();
    const id = 'pr-lock-postrun';
    await saveReviewSession(h, id, 'queued');

    const originalSave = h.store.save.bind(h.store);
    let saveCalls = 0;
    let release: (() => void) | undefined;
    h.store.save = (session) => {
      if (session.id === id) {
        saveCalls += 1;
        // #1 the preRun transition (queued -> reviewing), #2 StageRunner's
        // pre-run 'running' save, #3 StageRunner's post-exit merge, #4 the
        // post-run block's own store.transition()-internal save — hold that one.
        if (saveCalls === 4) {
          return new Promise<void>((resolve, reject) => {
            release = () => originalSave(session).then(resolve, reject);
          });
        }
      }
      return originalSave(session);
    };

    const runPromise = h.service.runReview(id);
    await flush();
    await h.finishRun({ 'REVIEW.md': '# Review\nfindings' }, { code: 0, signal: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saveCalls).toBe(4);

    // The concurrent op's own eventual success/failure isn't the point here
    // (it may well lose a legitimate race against the winner's own 'ready'
    // transition once released) — only that it does not settle, either way,
    // while the post-run block still holds the lock.
    const concurrent = track(h.service.transition(id, 'ready'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(concurrent.settled()).toBeUndefined();

    release?.();
    await runPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(concurrent.settled()).not.toBeUndefined();
  });

  it('patchLastRun is lock-protected — a concurrent transition blocks on it rather than racing it', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'investigate_only', driveToCompletion: false });

    const originalSave = h.store.save.bind(h.store);
    let saveCalls = 0;
    let release: (() => void) | undefined;
    h.store.save = (session) => {
      if (session.id === inv.id) {
        saveCalls += 1;
        // #1 pre-run 'running' save, #2 StageRunner's post-exit merge,
        // #3 patchLastRun's own save (findings succeeded with no FINDINGS.md).
        if (saveCalls === 3) {
          return new Promise<void>((resolve, reject) => {
            release = () => originalSave(session).then(resolve, reject);
          });
        }
      }
      return originalSave(session);
    };

    const runPromise = h.service.runFindings(inv.id);
    await flush();
    await h.finishRun({}, { code: 0, signal: null }); // no FINDINGS.md written -> patchLastRun path
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saveCalls).toBe(3);

    let concurrentResolved = false;
    const concurrentPromise = h.service.transition(inv.id, 'planning').then(() => {
      concurrentResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(concurrentResolved).toBe(false);

    release?.();
    await runPromise;
    await concurrentPromise;
    expect(concurrentResolved).toBe(true);
  });
});
