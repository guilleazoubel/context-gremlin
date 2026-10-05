import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import { WorkspaceMissingError } from '../../src/pipeline/stage-runner';
import { renderReviewBrief, renderReviewPrompt } from '../../src/pipeline/prompts';
import { migrateV1ToV2, type ReviewSession } from '../../src/schema/session';
import type { ReviewPhase } from '../../src/schema/pipeline';
import type { PrInfo } from '../../src/schema/stage';

interface ReviewSessionOverrides {
  id?: string;
  stageStatus?: ReviewPhase;
  pr?: PrInfo | null;
  worktreePath?: string | undefined;
}

function makeReviewSession(overrides: ReviewSessionOverrides = {}): ReviewSession {
  const id = overrides.id ?? 'pr-app-12-x';
  const worktreePath = 'worktreePath' in overrides ? overrides.worktreePath : `/worktrees/${id}`;
  const v1 = {
    schemaVersion: 1 as const,
    id,
    mode: 'review' as const,
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', ...(worktreePath ? { worktreePath } : {}), branch: 'pr-12' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: overrides.stageStatus ?? 'queued',
  };
  const review = migrateV1ToV2(v1);
  if (review.mode !== 'review') throw new Error('mode changed');
  review.pr =
    overrides.pr === undefined
      ? { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'aaa', reviewedSha: null, title: 'T', author: 'bob' }
      : overrides.pr;
  return review;
}

async function saveReviewSession(
  h: PipelineHarness,
  overrides: ReviewSessionOverrides = {},
): Promise<ReviewSession> {
  const review = makeReviewSession(overrides);
  await h.store.save(review);
  return review;
}

describe('PipelineService — review', () => {
  it('runReview from queued transitions to reviewing before the prompt is sent, and exit 0 with a non-empty REVIEW.md sets ready and pr.reviewedSha', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h);
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;

    const p = h.service.runReview(review.id);
    await flush();
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');
    const handle = h.runner.lastHandle();
    expect(h.runner.getPrompts(handle)).toEqual([renderReviewPrompt({ sessionDir })]);
    // Since Phase 5 review writes a BRIEF.md; with no environment wired it is
    // the env-less render (no ## Environment, no ## LIVE UI CHECK) plus the 0c ticket state.
    expect(await h.fs.readFile(`${sessionDir}/BRIEF.md`)).toBe(renderReviewBrief({ sessionDir, prNumber: 12, ticketState: { kind: 'none', linking: 'disabled' } }));

    await h.finishRun({ 'REVIEW.md': '# Review\nfindings here' }, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('ready');
    if (session.mode !== 'review') throw new Error('mode changed');
    expect(session.pr?.reviewedSha).toBe('aaa');
  });

  it('runReview marks failed on exit 0 with an empty REVIEW.md, and on a non-zero exit even with a non-empty REVIEW.md (mutation guard)', async () => {
    const h1 = createHarness();
    const review1 = await saveReviewSession(h1);
    const p1 = h1.service.runReview(review1.id);
    await h1.finishRun({}, { code: 0, signal: null }); // no REVIEW.md written
    expect((await p1).stageStatus).toBe('failed');

    const h2 = createHarness();
    const review2 = await saveReviewSession(h2);
    const p2 = h2.service.runReview(review2.id);
    await h2.finishRun({ 'REVIEW.md': '# Review\nfindings' }, { code: 1, signal: null });
    expect((await p2).stageStatus).toBe('failed');
  });

  it('runReview rejects from approved/reviewing/without-pr, and the failed -> reviewing -> ready retry path works', async () => {
    const h = createHarness();
    const approvedReview = await saveReviewSession(h, { id: 'pr-1', stageStatus: 'approved' });
    await expect(h.service.runReview(approvedReview.id)).rejects.toThrow(UnsupportedStageError);

    const reviewingReview = await saveReviewSession(h, { id: 'pr-2', stageStatus: 'reviewing' });
    await expect(h.service.runReview(reviewingReview.id)).rejects.toThrow(UnsupportedStageError);

    const noPrReview = await saveReviewSession(h, { id: 'pr-3', pr: null });
    await expect(h.service.runReview(noPrReview.id)).rejects.toThrow(UnsupportedStageError);

    const failedReview = await saveReviewSession(h, { id: 'pr-4', stageStatus: 'failed' });
    const p = h.service.runReview(failedReview.id);
    await flush();
    expect((await h.store.load(failedReview.id)).stageStatus).toBe('reviewing');
    await h.finishRun({ 'REVIEW.md': '# Review\nfindings' }, { code: 0, signal: null });
    expect((await p).stageStatus).toBe('ready');
  });

  it('runRereview fetches the PR, archives REVIEW.md, writes RE-REVIEW.md, and on success sets ready + pr shas to the new commit', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'changes_requested' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    await h.fs.writeFile(`${sessionDir}/REVIEW.md`, 'old review');

    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // rev-parse HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
    h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse FETCH_HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
    h.git.queueResponse({ stdout: 'abc1234 fix the bug\ndef5678 add a test', stderr: '' }); // log
    h.git.queueResponse({ stdout: ' 1 file changed', stderr: '' }); // diff --stat

    const p = h.service.runRereview(review.id);
    await flush();

    expect(h.git.calls.slice(0, 6).map((c) => c.args)).toEqual([
      ['rev-parse', 'HEAD'],
      ['fetch', 'origin', 'pull/12/head'],
      ['rev-parse', 'FETCH_HEAD'],
      ['reset', '--hard', 'FETCH_HEAD'],
      ['log', '--oneline', 'aaa..bbb'],
      ['diff', '--stat', 'aaa...HEAD'],
    ]);
    expect(h.git.calls.slice(0, 6).every((c) => c.cwd === `/worktrees/${review.id}`)).toBe(true);

    expect(await h.fs.readFile(`${sessionDir}/REVIEW-v1.md`)).toBe('old review');
    const reReview = await h.fs.readFile(`${sessionDir}/RE-REVIEW.md`);
    expect(reReview).toContain('abc1234 fix the bug');
    expect(reReview).toContain('def5678 add a test');

    const handle = h.runner.lastHandle();
    expect(h.runner.getPrompts(handle)[0]).toContain('PR updated with 2 new commit(s)');

    const duringRun = await h.store.load(review.id);
    expect(duringRun.stageStatus).toBe('reviewing');
    if (duringRun.mode !== 'review') throw new Error('mode changed');
    expect(duringRun.reviewVersion).toBe(1);

    await h.finishRun({ 'REVIEW.md': 'new review', rereview_summary: '✅ 2/2 resolved' }, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('ready');
    if (session.mode !== 'review') throw new Error('mode changed');
    expect(session.pr?.reviewedSha).toBe('bbb');
    expect(session.pr?.headSha).toBe('bbb');
    expect(session.lastRereviewSummary).toEqual({ resolved: 2, total: 2, newFindings: 0 });
  });

  it('persists lastRereviewSummary parsed from rereview_summary after a successful rereview', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'changes_requested' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    await h.fs.writeFile(`${sessionDir}/REVIEW.md`, 'old review');

    h.git.queueResponse({ stdout: 'aaa', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: 'bbb', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: 'abc1234 fix the bug', stderr: '' });
    h.git.queueResponse({ stdout: ' 1 file changed', stderr: '' });

    const p = h.service.runRereview(review.id);
    await flush();
    await h.finishRun(
      { 'REVIEW.md': 'new review', rereview_summary: '⚠️ 1/3 resolved, 2 new' },
      { code: 0, signal: null },
    );
    const session = await p;
    expect(session.stageStatus).toBe('ready');
    if (session.mode !== 'review') throw new Error('mode changed');
    expect(session.lastRereviewSummary).toEqual({ resolved: 1, total: 3, newFindings: 2 });
  });

  it('a second runRereview archives the current REVIEW.md to REVIEW-v2.md and bumps reviewVersion to 2', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'ready' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    await h.fs.writeFile(`${sessionDir}/REVIEW-v1.md`, 'first review');
    await h.fs.writeFile(`${sessionDir}/REVIEW.md`, 'second review');
    await h.store.save({ ...review, reviewVersion: 1 });

    h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
    h.git.queueResponse({ stdout: 'ccc', stderr: '' }); // rev-parse FETCH_HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
    h.git.queueResponse({ stdout: 'ghi9012 more fixes', stderr: '' }); // log
    h.git.queueResponse({ stdout: ' 2 files changed', stderr: '' }); // diff --stat

    const p = h.service.runRereview(review.id);
    await flush();
    expect(await h.fs.readFile(`${sessionDir}/REVIEW-v2.md`)).toBe('second review');
    const duringRun = await h.store.load(review.id);
    if (duringRun.mode !== 'review') throw new Error('mode changed');
    expect(duringRun.reviewVersion).toBe(2);

    await h.finishRun({ 'REVIEW.md': 'third review', rereview_summary: '✅ 1/1 resolved' }, { code: 0, signal: null });
    await p;
  });

  it('runRereview is allowed from ready, and rejects from queued', async () => {
    const h = createHarness();
    const readyReview = await saveReviewSession(h, { id: 'pr-ready', stageStatus: 'ready' });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: 'bbb', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    h.git.queueResponse({ stdout: '', stderr: '' });
    const p = h.service.runRereview(readyReview.id);
    await h.finishRun({ 'REVIEW.md': 'r', rereview_summary: '✅ 0/0 resolved' }, { code: 0, signal: null });
    await expect(p).resolves.toMatchObject({ stageStatus: 'ready' });

    const queuedReview = await saveReviewSession(h, { id: 'pr-queued', stageStatus: 'queued' });
    await expect(h.service.runRereview(queuedReview.id)).rejects.toThrow(UnsupportedStageError);
  });

  it('a rejected git fetch propagates without transitioning, archiving, or starting a run', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'changes_requested' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    await h.fs.writeFile(`${sessionDir}/REVIEW.md`, 'old review');

    h.git.queueResponse({ stdout: 'aaa', stderr: '' });
    h.git.queueResponse(new Error('fetch failed'));

    await expect(h.service.runRereview(review.id)).rejects.toThrow('fetch failed');

    const after = await h.store.load(review.id);
    expect(after.stageStatus).toBe('changes_requested');
    if (after.mode !== 'review') throw new Error('mode changed');
    expect(after.reviewVersion).toBe(0);
    expect(await h.fs.exists(`${sessionDir}/REVIEW-v1.md`)).toBe(false);
    expect(await h.fs.exists(`${sessionDir}/RE-REVIEW.md`)).toBe(false);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('does not archive or bump reviewVersion when there was no REVIEW.md to archive', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'failed' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    // No REVIEW.md was ever written (e.g. the prior review run failed before producing one).

    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // rev-parse HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
    h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse FETCH_HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
    h.git.queueResponse({ stdout: 'abc1234 fix the bug', stderr: '' }); // log
    h.git.queueResponse({ stdout: ' 1 file changed', stderr: '' }); // diff --stat

    const p = h.service.runRereview(review.id);
    await flush();

    expect(await h.fs.exists(`${sessionDir}/REVIEW-v1.md`)).toBe(false);
    const duringRun = await h.store.load(review.id);
    if (duringRun.mode !== 'review') throw new Error('mode changed');
    expect(duringRun.reviewVersion).toBe(0);
    const reReview = await h.fs.readFile(`${sessionDir}/RE-REVIEW.md`);
    expect(reReview).toContain('(none');

    await h.finishRun({ 'REVIEW.md': 'new review', rereview_summary: '✅ 1/1 resolved' }, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('ready');
  });

  it('trims trailing newlines from real git rev-parse output before building commit ranges and PR shas', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'changes_requested' });
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    await h.fs.writeFile(`${sessionDir}/REVIEW.md`, 'old review');

    h.git.queueResponse({ stdout: 'aaa\n', stderr: '' }); // rev-parse HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
    h.git.queueResponse({ stdout: 'bbb\n', stderr: '' }); // rev-parse FETCH_HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
    h.git.queueResponse({ stdout: 'l1\nl2\n', stderr: '' }); // log
    h.git.queueResponse({ stdout: ' 1 file changed\n', stderr: '' }); // diff --stat

    const p = h.service.runRereview(review.id);
    await flush();

    expect(h.git.calls[4].args).toEqual(['log', '--oneline', 'aaa..bbb']);
    expect(h.git.calls[5].args).toEqual(['diff', '--stat', 'aaa...HEAD']);

    await h.finishRun({ 'REVIEW.md': 'new review', rereview_summary: '✅ 2/2 resolved' }, { code: 0, signal: null });
    const session = await p;
    if (session.mode !== 'review') throw new Error('mode changed');
    expect(session.pr?.headSha).toBe('bbb');
  });

  it('runReview rejects WorkspaceMissingError without transitioning when the session has no worktreePath', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { worktreePath: undefined });
    await expect(h.service.runReview(review.id)).rejects.toThrow(WorkspaceMissingError);
    const after = await h.store.load(review.id);
    expect(after.stageStatus).toBe('queued');
  });

  it('runReview transitions to failed and rethrows if stageRunner.run itself throws after the reviewing transition', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h);
    h.stageRunner.run = async () => {
      throw new Error('boom');
    };
    await expect(h.service.runReview(review.id)).rejects.toThrow('boom');
    const after = await h.store.load(review.id);
    expect(after.stageStatus).toBe('failed');
  });

  it('runRereview transitions to failed and rethrows if stageRunner.run itself throws after the reviewing transition', async () => {
    const h = createHarness();
    const review = await saveReviewSession(h, { stageStatus: 'changes_requested' });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // rev-parse HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
    h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse FETCH_HEAD
    h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
    h.git.queueResponse({ stdout: '', stderr: '' }); // log
    h.git.queueResponse({ stdout: '', stderr: '' }); // diff --stat
    h.stageRunner.run = async () => {
      throw new Error('boom');
    };
    await expect(h.service.runRereview(review.id)).rejects.toThrow('boom');
    const after = await h.store.load(review.id);
    expect(after.stageStatus).toBe('failed');
  });
});
