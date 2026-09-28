import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOriginRepo, createMirrorFor, startEngine, finishRun, pushPrCommit, waitFor, waitForAnySession, waitForNewHandle,
  type Engine,
} from '../support/e2e-harness';
import type { Session } from '../../src/schema/session';
import { mirrorDirName } from '../../src/workspace/repo-mirror';
import { ReviewSessionFactory } from '../../src/pipeline/review-session-factory';
import { ReconciliationTick } from '../../src/discovery/reconciliation';

function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface EventEntry {
  type: string;
  sessionId: string;
  to?: string;
}

describe.skipIf(!hasGit())('Phase 3 engine end-to-end: investigation -> development', () => {
  let root: string;
  let originPath: string;
  let engine: Engine;
  let events: EventEntry[];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-e2e-'));
    originPath = await createOriginRepo(root);
    engine = await startEngine(root);

    events = [];
    engine.events.on('session.created', (e) => events.push({ type: 'session.created', sessionId: e.session.id }));
    engine.events.on('session.transitioned', (e) => events.push({ type: 'session.transitioned', sessionId: e.session.id, to: e.to }));
    engine.events.on('run.started', (e) => events.push({ type: 'run.started', sessionId: e.session.id }));
    engine.events.on('run.finished', (e) => events.push({ type: 'run.finished', sessionId: e.session.id }));
  }, 20_000);

  afterAll(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it(
    'drives investigation -> findings -> plan -> promote -> develop -> abandon over the real API with real fs/git',
    async () => {
      const start = Date.now();

      // --- Step 1: create the investigation ---
      const createRes = await engine.request('POST', '/sessions/investigations', {
        repoUrl: originPath,
        ticket: 'APP-1',
        intent: 'development',
        driveToCompletion: true,
      });
      expect(createRes.status).toBe(201);
      const invId = (createRes.body as { session: Session }).session.id;

      const worktreePath = path.join(root, 'worktrees', invId);
      const branchOnDisk = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim();
      expect(branchOnDisk).toBe('investigate/APP-1');

      const sessionsDir = path.join(root, 'sessions');
      const sessionJsonPath = path.join(sessionsDir, invId, 'session.json');
      const savedSession = JSON.parse(await readFile(sessionJsonPath, 'utf8')) as Session;
      expect(savedSession.schemaVersion).toBe(2);
      expect(savedSession.stageStatus).toBe('findings');

      // The investigation guard. This investigation is DEVELOPMENT-BOUND
      // (`intent: 'development'` above), and `promote()` below hands the
      // development session this very worktree and branch — so it may land
      // its own work, and posts and administers nothing.
      const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
      const invSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        permissions: { allow?: string[]; deny?: string[] };
      };
      expect(invSettings.permissions.allow).toBeUndefined();
      expect(invSettings.permissions.deny).toEqual(
        expect.arrayContaining([
          'Bash(gh pr comment:*)',
          'Bash(gh api:*)',
          'Bash(gh repo:*)',
          'Bash(git push --force:*)',
        ]),
      );
      expect(invSettings.permissions.deny).not.toContain('Bash(git push:*)');
      expect(invSettings.permissions.deny).not.toContain('Bash(git commit:*)');
      expect(invSettings.permissions.deny).not.toContain('Bash(gh pr create:*)');

      // --- Step 2: start the findings run ---
      const runRes = await engine.request('POST', `/sessions/${invId}/run`, { stage: 'findings' });
      expect(runRes.status).toBe(202);
      expect((runRes.body as { session: Session }).session.lastRun?.outcome).toBe('running');

      const briefPath = path.join(sessionsDir, invId, 'BRIEF.md');
      const brief = await readFile(briefPath, 'utf8');
      expect(brief).toContain('FINDINGS.md');

      const findingsHandle = engine.runner.lastHandle();
      const findingsCtx = engine.runner.getContext(findingsHandle);
      expect(findingsCtx.workingDirectory).toBe(worktreePath);
      expect(findingsCtx.additionalDirs).toEqual([path.join(sessionsDir, invId)]);

      // --- Step 3: finish findings, chain into plan ---
      engine.runner.setResumeId(findingsHandle, 'resume-findings-1');
      await finishRun(engine.runner, { 'FINDINGS.md': '# Findings\nroot cause' }, { code: 0, signal: null });

      await waitFor(engine, invId, (s) => s.stageStatus === 'planning');
      const planHandle = await waitForNewHandle(engine.runner, findingsHandle);
      const planBriefPath = path.join(sessionsDir, invId, 'BRIEF.md');
      const planBrief = await readFile(planBriefPath, 'utf8');
      expect(planBrief).toContain('## Review Status');
      expect(engine.runner.getContext(planHandle).resumeId).toBe('resume-findings-1');

      // --- Step 4: approve the plan, drive-to-completion promotes automatically ---
      await finishRun(
        engine.runner,
        { 'PLAN.md': '## Review Status\n- PM: ✅ Approved — a\n- Principal Engineer: ✅ Approved — b\n\n# Plan\n' },
        { code: 0, signal: null },
      );

      await waitFor(engine, invId, (s) => s.stageStatus === 'promoted_to_development');

      // promote() creates the development session and only afterwards starts
      // its develop run (a separate, later step in the same call chain) — wait
      // for the run to have actually started, not just for the session to exist.
      const dev = await waitForAnySession(
        engine,
        (s) => s.mode === 'development' && s.lineage.parentSessionId === invId && s.lastRun?.outcome === 'running',
      );

      const listRes = await engine.request('GET', '/sessions');
      const allSessions = (listRes.body as { sessions: Session[] }).sessions;
      const devSessions = allSessions.filter(
        (s) => s.mode === 'development' && s.lineage.parentSessionId === invId,
      );
      expect(devSessions.length).toBe(1);
      expect(dev.workspace.worktreePath).toBe(worktreePath);
      expect(dev.stageStatus).toBe('active');
      expect(dev.lastRun?.outcome).toBe('running');

      const devPlanPath = path.join(sessionsDir, dev.id, 'PLAN.md');
      const devFindingsPath = path.join(sessionsDir, dev.id, 'FINDINGS.md');
      await expect(readFile(devPlanPath, 'utf8')).resolves.toContain('Review Status');
      await expect(readFile(devFindingsPath, 'utf8')).resolves.toContain('root cause');

      const planArtifactRes = await engine.request('GET', `/sessions/${dev.id}/artifacts/PLAN.md`);
      expect(planArtifactRes.status).toBe(200);
      expect(planArtifactRes.body as string).toContain('Review Status');

      // --- Step 5: workspace teardown, guarded by the still-active development session ---
      const devHandle = engine.runner.lastHandle();
      const blockedRes = await engine.request('DELETE', '/workspaces', {
        repoUrl: originPath,
        worktreePath,
        branchName: 'investigate/APP-1',
      });
      expect(blockedRes.status).toBe(409);

      await finishRun(engine.runner, {}, { code: 0, signal: null });
      void devHandle;

      const abandonRes = await engine.request('POST', `/sessions/${dev.id}/transition`, { to: 'abandoned' });
      expect(abandonRes.status).toBe(200);

      const removeRes = await engine.request('DELETE', '/workspaces', {
        repoUrl: originPath,
        worktreePath,
        branchName: 'investigate/APP-1',
      });
      expect(removeRes.status).toBe(204);

      const worktreeExists = await readFile(path.join(worktreePath, '.git'), 'utf8').then(() => true, () => false);
      expect(worktreeExists).toBe(false);
      const mirrorPath = path.join(root, 'mirrors', mirrorDirName(originPath));
      const mirrorWorktreeList = gitRun(['worktree', 'list'], mirrorPath);
      expect(mirrorWorktreeList).not.toContain(worktreePath);

      // --- Step 6: the pinned event sequence ---
      expect(events).toEqual([
        { type: 'session.created', sessionId: invId },
        { type: 'run.started', sessionId: invId },
        { type: 'run.finished', sessionId: invId },
        { type: 'session.transitioned', sessionId: invId, to: 'planning' },
        { type: 'run.started', sessionId: invId },
        { type: 'run.finished', sessionId: invId },
        { type: 'session.transitioned', sessionId: invId, to: 'plan_ready' },
        { type: 'session.transitioned', sessionId: invId, to: 'promoted_to_development' },
        { type: 'session.created', sessionId: dev.id },
        { type: 'run.started', sessionId: dev.id },
        { type: 'run.finished', sessionId: dev.id },
        { type: 'session.transitioned', sessionId: dev.id, to: 'abandoned' },
      ]);

      const wallMs = Date.now() - start;
      console.log(`[e2e] investigation->development flow wall time: ${wallMs}ms`);
    },
    30_000,
  );
});

describe.skipIf(!hasGit())('Phase 3 engine end-to-end: review / re-review / reconciliation', () => {
  let root: string;
  let originPath: string;
  let engine: Engine;
  let prSha: string;
  const REPO_URL = 'https://github.com/acme/app.git';
  const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));

  function viewJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      ...baseView,
      number: 12,
      headRefName: 'feature/APP-12',
      baseRefName: 'main',
      url: 'https://github.com/acme/app/pull/12',
      reviewDecision: '',
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      headRefOid: prSha,
      ...overrides,
    });
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-e2e-review-'));
    originPath = await createOriginRepo(root);
    engine = await startEngine(root);
    createMirrorFor(engine.mirrorsDir, REPO_URL, originPath);
    prSha = gitRun(['rev-parse', 'refs/pull/12/head'], originPath).trim();
  }, 20_000);

  afterAll(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it(
    'creates a review session from a PR, runs review, re-reviews on a new commit via a tick, then dismisses on merge',
    async () => {
      const start = Date.now();

      const factory = new ReviewSessionFactory({
        gh: engine.gh,
        store: engine.store,
        workspace: engine.workspace,
        events: engine.events,
        sessionsDir: engine.sessionsDir,
        worktreesDir: engine.worktreesDir,
      });

      // --- Step 1: create the review session directly from the PR URL ---
      engine.gh.queueResponse({ stdout: viewJson() });
      const review = await factory.createFromPrUrl('https://github.com/acme/app/pull/12');

      expect(review.stageStatus).toBe('queued');
      expect(review.pr?.number).toBe(12);
      expect(review.pr?.headSha).toBe(prSha);
      expect(review.lineage.ticket).toBe('APP-12');

      const reviewWorktree = review.workspace.worktreePath;
      if (!reviewWorktree) throw new Error('review session has no worktreePath');
      expect(gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], reviewWorktree).trim()).toBe('pr-12');
      expect(gitRun(['rev-parse', 'HEAD'], reviewWorktree).trim()).toBe(prSha);

      // --- Step 2: run the review ---
      const runRes = await engine.request('POST', `/sessions/${review.id}/run`, { stage: 'review' });
      expect(runRes.status).toBe(202);
      expect((runRes.body as { session: Session }).session.stageStatus).toBe('reviewing');

      const reviewHandle = engine.runner.lastHandle();
      expect(engine.runner.getPrompts(reviewHandle)[0]).toContain(
        `Write the output to ${engine.sessionsDir}/${review.id}/REVIEW.md`,
      );

      await finishRun(engine.runner, { 'REVIEW.md': '# PR Review' }, { code: 0, signal: null });
      const readyReview = await waitFor(engine, review.id, (s) => s.stageStatus === 'ready');
      expect(readyReview.pr?.reviewedSha).toBe(prSha);

      // --- Step 3: a new commit lands, a tick picks it up as a rereview ---
      const newSha = await pushPrCommit(originPath, 12);
      engine.gh.queueResponse({ stdout: viewJson({ headRefOid: newSha }) });

      const tick = new ReconciliationTick({
        gh: engine.gh, store: engine.store, pipeline: engine.pipeline,
        events: engine.events, lock: engine.lock,
      });
      const report1 = await tick.run();
      expect(report1.actions).toContainEqual(
        expect.objectContaining({ type: 'rereview', sessionId: review.id }),
      );

      await waitFor(engine, review.id, (s) => s.stageStatus === 'reviewing');

      const sessionDir = path.join(engine.sessionsDir, review.id);
      await expect(readFile(path.join(sessionDir, 'REVIEW-v1.md'), 'utf8')).resolves.toBe('# PR Review');
      const reReviewContent = await readFile(path.join(sessionDir, 'RE-REVIEW.md'), 'utf8');
      expect(reReviewContent).toContain(prSha);
      expect(reReviewContent).toContain(newSha);
      expect(gitRun(['rev-parse', 'HEAD'], reviewWorktree).trim()).toBe(newSha);

      await finishRun(
        engine.runner,
        { 'REVIEW.md': '# PR Review v2', rereview_summary: '✅ 1/1 resolved' },
        { code: 0, signal: null },
      );
      const readyAgain = await waitFor(engine, review.id, (s) => s.stageStatus === 'ready');
      if (readyAgain.mode !== 'review') throw new Error('mode changed');
      expect(readyAgain.reviewVersion).toBe(1);
      expect(readyAgain.lastRereviewSummary).toEqual({ resolved: 1, total: 1, newFindings: 0 });
      expect(readyAgain.pr?.reviewedSha).toBe(newSha);

      // --- Step 4: the PR merges; a tick dismisses the review ---
      // The merge must land AFTER this session was created, or it is the
      // Phase 14 case (a review deliberately started on an already-landed
      // PR) and reconciliation is right to leave it alone. The session was
      // created moments ago by this test, so `now` is the in-flight shape.
      engine.gh.queueResponse({
        stdout: viewJson({ headRefOid: newSha, state: 'MERGED', mergedAt: new Date().toISOString() }),
      });
      await tick.run();
      await waitFor(engine, review.id, (s) => s.stageStatus === 'dismissed');

      const artifactRes = await engine.request('GET', `/sessions/${review.id}/artifacts/REVIEW-v1.md`);
      expect(artifactRes.status).toBe(200);

      // --- Step 5: gh is only ever asked to read, never to mutate ---
      expect(engine.gh.calls.length).toBeGreaterThan(0);
      for (const call of engine.gh.calls) {
        expect(call[0]).toBe('pr');
        expect(['view', 'list']).toContain(call[1]);
      }

      const wallMs = Date.now() - start;
      console.log(`[e2e] review/rereview/reconciliation flow wall time: ${wallMs}ms`);
    },
    30_000,
  );
});

describe.skipIf(!hasGit())('Phase 7 engine end-to-end: a development session created directly', () => {
  let root: string;
  let originPath: string;
  let engine: Engine;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-e2e-dev-'));
    originPath = await createOriginRepo(root);
    engine = await startEngine(root);
  }, 20_000);

  afterAll(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it(
    'creates a real worktree on feature/<ticket> with the development permission guard, starts nothing, then runs develop once into the PLAN GATE',
    async () => {
      const runStarts: string[] = [];
      engine.events.on('run.started', (e) => runStarts.push(e.session.id));

      const createRes = await engine.request('POST', '/sessions/developments', {
        repoUrl: originPath,
        ticket: 'APP-99',
      });
      expect(createRes.status).toBe(201);
      const dev = (createRes.body as { session: Session }).session;
      expect(dev.mode).toBe('development');
      expect(dev.stageStatus).toBe('active');
      expect(dev.lastRun).toBeNull();

      // A real git worktree, on the legacy feature/<ticket> branch.
      const worktreePath = path.join(root, 'worktrees', dev.id);
      expect(gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim()).toBe('feature/APP-99');

      // The development permission guard, not the investigation one.
      const settings = JSON.parse(
        await readFile(path.join(worktreePath, '.claude', 'settings.local.json'), 'utf8'),
      ) as { permissions: { deny?: string[] } };
      expect(settings.permissions.deny).toContain('Bash(gh pr review:*)');
      expect(settings.permissions.deny).not.toContain('Bash(git push:*)');

      // MG-A11 over the real API: creation started nothing.
      expect(runStarts).toEqual([]);

      const runRes = await engine.request('POST', `/sessions/${dev.id}/run`, { stage: 'develop' });
      expect(runRes.status).toBe(202);
      expect(runStarts).toEqual([dev.id]);

      const sessionDir = path.join(root, 'sessions', dev.id);
      const brief = await readFile(path.join(sessionDir, 'BRIEF.md'), 'utf8');
      expect(brief).toContain('**PLAN GATE — pause.**');
      expect(engine.runner.getContext(engine.runner.lastHandle()).workingDirectory).toBe(worktreePath);

      await finishRun(
        engine.runner,
        { 'DEVELOPMENT.md': '# Development plan\nrefined from the ticket\n', AGENT_STATE: 'needs-input' },
        { code: 0, signal: null },
      );

      const after = await waitFor(engine, dev.id, (s) => s.lastRun?.outcome === 'succeeded');
      expect(after.stageStatus).toBe('active'); // develop does not transition on success

      const devArtifact = await engine.request('GET', `/sessions/${dev.id}/artifacts/DEVELOPMENT.md`);
      expect(devArtifact.status).toBe(200);
      expect(devArtifact.body as string).toContain('refined from the ticket');
      expect(await readFile(path.join(sessionDir, 'AGENT_STATE'), 'utf8')).toBe('needs-input');
    },
    30_000,
  );
});
