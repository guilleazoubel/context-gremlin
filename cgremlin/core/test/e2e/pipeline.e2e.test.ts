import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOriginRepo, startEngine, finishRun, waitFor, waitForAnySession, waitForNewHandle,
  type Engine,
} from '../support/e2e-harness';
import type { Session } from '../../src/schema/session';
import { mirrorDirName } from '../../src/workspace/repo-mirror';

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

      const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ permissions: {} });

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
