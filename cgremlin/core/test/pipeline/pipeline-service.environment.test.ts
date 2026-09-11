import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createHarness,
  FIXED_NOW,
  flush,
  SESSIONS_DIR,
  WORKTREES_DIR,
  type PipelineHarness,
} from '../support/pipeline-harness';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { EnvironmentService, type EnvironmentServiceDeps } from '../../src/env/environment-service';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import {
  renderDevelopBrief,
  renderFindingsBrief,
  renderRereviewBrief,
  renderReviewBrief,
  renderReviewPrompt,
} from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';
import type { PrInfo } from '../../src/schema/stage';

const HOME = '/home/u';
const STATE_PATH = '/state/local-app.json';
const REPO_URL = 'git@github.com:acme/app.git';
const SLUG = 'acme/app';
const SECRET = 'S3CRET-VALUE';
const PREVIEW_HOST = 'app-git-feat.preview.example.com';
const LOCAL_URL = 'https://local.test';

const LOCAL_APP = { url: LOCAL_URL, port: 8080, stages: ['develop'] };
const VERCEL = { scope: 'sc', project: 'p', previewProject: 'p', bypassSecret: SECRET };

const F1_APPROVED_PLAN = `## Review Status
- PM: ✅ Approved — solves exactly the ticket
- Principal Engineer: ✅ Approved — mechanism checks out
`;

function vercelBody(previewUrl: string | null, nextCommitStatus = 'DEPLOYED'): string {
  const payload = {
    isMonorepo: false,
    type: 'github',
    projects: [
      {
        name: 'p',
        projectId: 'pid',
        rootDirectory: null,
        inspectorUrl: 'https://vercel.com/sc/p/dep',
        previewUrl,
        nextCommitStatus,
      },
    ],
  };
  return `[vc]: #h:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

const PR_COMMENTS = JSON.stringify({ comments: [{ author: { login: 'vercel' }, body: vercelBody(PREVIEW_HOST) }] });

function makeConfig(env: Record<string, unknown>): CoreConfig {
  return resolveCoreConfig({ repos: [SLUG], me: 'me', environments: { [SLUG]: env } }, HOME);
}

/** Records every session/local-app lock acquisition in the SAME ordered log the fake runner writes to. */
class LoggingLock extends KeyedLock {
  constructor(private readonly log: string[]) {
    super();
  }

  override withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return super.withLock(key, async () => {
      this.log.push(`lock.enter:${key}`);
      try {
        return await fn();
      } finally {
        this.log.push(`lock.exit:${key}`);
      }
    });
  }
}

interface EnvHarness {
  h: PipelineHarness;
  gh: FakeGhRunner;
  local: FakeLocalAppRunner;
  callLog: string[];
}

interface SetupOptions {
  env?: Record<string, unknown>;
  noEnvironment?: boolean;
  /** Wraps the built service, e.g. to make `stop()` reject. */
  wrap?: (service: EnvironmentService) => EnvironmentService;
}

function setup(options: SetupOptions = {}): EnvHarness {
  const gh = new FakeGhRunner();
  const callLog: string[] = [];
  const local = new FakeLocalAppRunner({ callLog });
  const lock = new LoggingLock(callLog);
  const config = makeConfig(options.env ?? { localApp: LOCAL_APP, vercel: VERCEL });
  const h = createHarness({
    lock,
    environment: options.noEnvironment
      ? undefined
      : (parts) => {
          const deps: EnvironmentServiceDeps = {
            fs: parts.fs,
            gh,
            git: parts.git,
            local,
            config,
            sessionsDir: SESSIONS_DIR,
            statePath: STATE_PATH,
            lock: parts.lock,
            env: { HOME },
            now: FIXED_NOW,
          };
          const service = new EnvironmentService(deps);
          return options.wrap ? options.wrap(service) : service;
        },
  });
  return { h, gh, local, callLog };
}

const PR: PrInfo = {
  repo: SLUG,
  number: 12,
  url: 'https://github.com/acme/app/pull/12',
  headSha: 'aaa',
  reviewedSha: null,
  title: 'T',
  author: 'bob',
};

async function prepWorktree(fs: InMemoryFileSystem, id: string): Promise<void> {
  const wt = `${WORKTREES_DIR}/${id}`;
  await fs.mkdir(wt, { recursive: true });
  await fs.writeFile(`${wt}/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));
  await fs.writeFile(`${wt}/.env.local`, 'A=1\n');
  await fs.mkdir(`${wt}/node_modules`, { recursive: true });
}

async function saveDevSession(h: PipelineHarness, id = 'dev-1'): Promise<Session> {
  const session: Session = {
    schemaVersion: 2,
    id,
    mode: 'development',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feat/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus: 'active',
    agent: null,
    lastRun: null,
    pr: PR,
  };
  await h.store.save(session);
  await prepWorktree(h.fs, id);
  return session;
}

async function saveInvestigationSession(h: PipelineHarness, id = 'inv-1'): Promise<Session> {
  const session: Session = {
    schemaVersion: 2,
    id,
    mode: 'investigation',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'investigate/APP-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus: 'findings',
    agent: null,
    lastRun: null,
    pr: null,
    intent: 'investigate_only',
    driveToCompletion: false,
  };
  await h.store.save(session);
  await prepWorktree(h.fs, id);
  return session;
}

async function saveReviewSession(h: PipelineHarness, id = 'pr-app-12'): Promise<Session> {
  const session: Session = {
    schemaVersion: 2,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-12' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'queued',
    agent: null,
    lastRun: null,
    pr: PR,
    reviewVersion: 0,
    lastRereviewSummary: null,
  };
  await h.store.save(session);
  await prepWorktree(h.fs, id);
  return session;
}

function queueRereviewGit(h: PipelineHarness): void {
  h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // rev-parse HEAD
  h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
  h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse FETCH_HEAD
  h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
  h.git.queueResponse({ stdout: 'abc1234 fix', stderr: '' }); // log
  h.git.queueResponse({ stdout: ' 1 file changed', stderr: '' }); // diff --stat
}

describe('PipelineService — environment preparation', () => {
  it('MG-9 env-prep-outside-the-lock: the local app starts before the session lock is entered and stops after it is released', async () => {
    const { h, local, callLog } = setup();
    const dev = await saveDevSession(h);

    const p = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 0, signal: null });
    await p;

    const startIdx = callLog.indexOf('local.start');
    const stopIdx = callLog.indexOf('local.stop');
    const firstEnter = callLog.indexOf(`lock.enter:${dev.id}`);
    const lastExit = callLog.lastIndexOf(`lock.exit:${dev.id}`);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(firstEnter).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(firstEnter);
    expect(lastExit).toBeLessThan(stopIdx);
    // Nothing touching the local app (or its own lock key) ever happens while
    // the per-session lock is held — no nesting, no deadlock surface.
    let held = 0;
    for (const entry of callLog) {
      if (entry === `lock.enter:${dev.id}`) held += 1;
      else if (entry === `lock.exit:${dev.id}`) held -= 1;
      else if (entry.startsWith('local.') || entry.startsWith('lock.enter:local-app:')) {
        expect({ entry, held }).toEqual({ entry, held: 0 });
      }
    }
    expect(local.startCalls).toHaveLength(1);
  });

  it('a develop stage on a configured repo starts the app before run.started, names the local URL in BRIEF.md, and stops it after the run', async () => {
    const { h, local } = setup();
    const dev = await saveDevSession(h);
    let startCallsAtRunStarted = -1;
    h.events.on('run.started', () => {
      startCallsAtRunStarted = local.startCalls.length;
    });

    const p = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 0, signal: null });
    await p;

    expect(startCallsAtRunStarted).toBe(1);
    expect(local.startCalls).toHaveLength(1);
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${dev.id}/BRIEF.md`);
    expect(brief).toContain(`Local app: ${LOCAL_URL}`);
    expect(brief).toContain(`${SESSIONS_DIR}/${dev.id}/logs/dev-server.log`);
    expect(local.stopCalls).toHaveLength(1);
  });

  it('MG-4 no-local-app-for-review: a review stage whose localApp.stages excludes review starts nothing and gets the preview URL', async () => {
    const { h, gh, local } = setup();
    gh.queueResponse({ stdout: PR_COMMENTS });
    const review = await saveReviewSession(h);

    const p = h.service.runReview(review.id);
    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;

    expect(local.startCalls).toHaveLength(0);
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${review.id}/BRIEF.md`);
    expect(brief).toContain(`Vercel preview: https://${PREVIEW_HOST}`);
  });

  it('MG-1 secret-never-in-brief: the bypass secret reaches only the 0600 file — never the brief, the prompt or the run.started payload', async () => {
    const { h, gh } = setup();
    gh.queueResponse({ stdout: PR_COMMENTS });
    const review = await saveReviewSession(h);
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    const startedPayloads: string[] = [];
    h.events.on('run.started', (payload) => {
      startedPayloads.push(JSON.stringify(payload));
    });

    const p = h.service.runReview(review.id);
    await flush();
    const liveSecret = await h.fs.readFile(`${sessionDir}/.bypass-secret`);
    const brief = await h.fs.readFile(`${sessionDir}/BRIEF.md`);
    const prompt = h.runner.getPrompts(h.runner.lastHandle())[0];

    expect(liveSecret.trim()).toBe(SECRET);
    expect(brief).not.toContain(SECRET);
    expect(brief).toContain(`${sessionDir}/.bypass-secret`);
    expect(prompt).not.toContain(SECRET);
    expect(startedPayloads).toHaveLength(1);
    expect(startedPayloads[0]).not.toContain(SECRET);

    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;
    expect(await h.fs.exists(`${sessionDir}/.bypass-secret`)).toBe(false);
  });

  it('the .bypass-secret file exists before run.started and is gone once run.finished has fired', async () => {
    const { h, gh } = setup();
    gh.queueResponse({ stdout: PR_COMMENTS });
    const review = await saveReviewSession(h);
    const secretPath = `${SESSIONS_DIR}/${review.id}/.bypass-secret`;
    let existedAtStart: boolean | null = null;
    let existedAtFinish: boolean | null = null;
    h.events.on('run.started', () => {
      void h.fs.exists(secretPath).then((e) => {
        existedAtStart = e;
      });
    });
    h.events.on('run.finished', () => {
      void h.fs.exists(secretPath).then((e) => {
        existedAtFinish = e;
      });
    });

    const p = h.service.runReview(review.id);
    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;
    await flush();

    expect(existedAtStart).toBe(true);
    expect(existedAtFinish).toBe(true); // teardown runs after the run completes
    expect(await h.fs.exists(secretPath)).toBe(false);
  });

  it('MG-5 local-app-always-stopped: the app is stopped and the secret removed when the agent exits 0', async () => {
    const { h, gh, local } = setup({ env: { localApp: LOCAL_APP, vercel: VERCEL, previewStages: ['develop'] } });
    gh.queueResponse({ stdout: PR_COMMENTS });
    const dev = await saveDevSession(h);

    const p = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 0, signal: null });
    await p;

    expect(local.stopCalls).toHaveLength(1);
    expect(await h.fs.exists(`${SESSIONS_DIR}/${dev.id}/.bypass-secret`)).toBe(false);
  });

  it('MG-5 local-app-always-stopped: the app is stopped and the secret removed when the agent exits 1', async () => {
    const { h, gh, local } = setup({ env: { localApp: LOCAL_APP, vercel: VERCEL, previewStages: ['develop'] } });
    gh.queueResponse({ stdout: PR_COMMENTS });
    const dev = await saveDevSession(h);

    const p = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 1, signal: null });
    await p;

    expect(local.stopCalls).toHaveLength(1);
    expect(await h.fs.exists(`${SESSIONS_DIR}/${dev.id}/.bypass-secret`)).toBe(false);
  });

  it('MG-5 local-app-always-stopped: a locked preRun that loses the eligibility race still tears the environment down, rethrows, and leaves the session unfailed', async () => {
    const { h, gh, local } = setup({ env: { localApp: LOCAL_APP, vercel: VERCEL, previewStages: ['develop'] } });
    gh.queueResponse({ stdout: PR_COMMENTS });
    const dev = await saveDevSession(h);

    // Hold the session lock across prepareEnvironment so the stage's own
    // locked preRun observes a session that has since moved on.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raced = h.lock.withLock(dev.id, async () => {
      await h.store.transition(dev.id, 'abandoned');
      await gate;
    });

    const p = h.service.runDevelop(dev.id);
    await flush();
    release();
    await raced;
    await expect(p).rejects.toThrow(UnsupportedStageError);

    expect(local.startCalls).toHaveLength(1);
    expect(local.stopCalls).toHaveLength(1);
    expect(await h.fs.exists(`${SESSIONS_DIR}/${dev.id}/.bypass-secret`)).toBe(false);
    expect((await h.store.load(dev.id)).stageStatus).toBe('abandoned');
  });

  it('a teardown that throws neither masks the stage error nor fails an otherwise successful run', async () => {
    const wrap = (service: EnvironmentService): EnvironmentService => {
      const throwing = Object.create(service) as EnvironmentService;
      throwing.stop = async (): Promise<never> => {
        throw new Error('stop blew up');
      };
      return throwing;
    };

    const ok = setup({ wrap });
    const dev = await saveDevSession(ok.h);
    const p = ok.h.service.runDevelop(dev.id);
    await ok.h.finishRun({}, { code: 0, signal: null });
    const session = await p;
    expect(session.lastRun?.outcome).toBe('succeeded');

    const racy = setup({ wrap });
    const dev2 = await saveDevSession(racy.h, 'dev-2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raced = racy.h.lock.withLock(dev2.id, async () => {
      await racy.h.store.transition(dev2.id, 'abandoned');
      await gate;
    });
    const p2 = racy.h.service.runDevelop(dev2.id);
    await flush();
    release();
    await raced;
    await expect(p2).rejects.toThrow(UnsupportedStageError);
  });

  it('R5: the brief is rendered from the POST-start context — a failed start degrades to UNAVAILABLE and the stage still runs', async () => {
    const { h, local } = setup();
    local.queueHealth({ ok: false, status: null, reason: 'timeout', exited: false });
    const dev = await saveDevSession(h);

    const p = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 0, signal: null });
    const session = await p;

    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${dev.id}/BRIEF.md`);
    expect(brief).toContain('Local app: UNAVAILABLE');
    expect(session.lastRun?.outcome).toBe('succeeded');
  });

  it('the findings stage only gets the local app when localApp.stages names it', async () => {
    const off = setup();
    const inv = await saveInvestigationSession(off.h);
    const p = off.h.service.runFindings(inv.id);
    await off.h.finishRun({ 'FINDINGS.md': '# f' }, { code: 0, signal: null });
    await p;
    expect(off.local.startCalls).toHaveLength(0);

    const on = setup({ env: { localApp: { ...LOCAL_APP, stages: ['findings'] } } });
    const inv2 = await saveInvestigationSession(on.h, 'inv-2');
    const p2 = on.h.service.runFindings(inv2.id);
    await on.h.finishRun({ 'FINDINGS.md': '# f' }, { code: 0, signal: null });
    await p2;
    expect(on.local.startCalls).toHaveLength(1);
    expect(await on.h.fs.readFile(`${SESSIONS_DIR}/${inv2.id}/BRIEF.md`)).toContain(LOCAL_URL);
  });

  it('rereview gets the preview URL and a BRIEF.md, and the local app is left alone', async () => {
    const { h, gh, local } = setup();
    gh.queueResponse({ stdout: PR_COMMENTS });
    const review = await saveReviewSession(h);
    await h.store.transition(review.id, 'reviewing');
    await h.store.transition(review.id, 'ready');
    queueRereviewGit(h);

    const p = h.service.runRereview(review.id);
    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;

    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${review.id}/BRIEF.md`);
    expect(brief).toContain(`Vercel preview: https://${PREVIEW_HOST}`);
    expect(brief).toContain('# RE-REVIEW — PR #12');
    expect(local.startCalls).toHaveLength(0);
  });

  it('R14: the review prompt gains the LIVE UI CHECK sentence exactly when the brief actually carries that section', async () => {
    const withEnv = setup();
    withEnv.gh.queueResponse({ stdout: PR_COMMENTS });
    const review = await saveReviewSession(withEnv.h);
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;
    const p = withEnv.h.service.runReview(review.id);
    await flush();
    const brief = await withEnv.h.fs.readFile(`${sessionDir}/BRIEF.md`);
    const prompt = withEnv.h.runner.getPrompts(withEnv.h.runner.lastHandle())[0];
    expect(brief).toContain('## LIVE UI CHECK');
    expect(prompt).toContain("'## LIVE UI CHECK' section");
    expect(prompt).toBe(renderReviewPrompt({ sessionDir, uiCheckRendered: true }));
    await withEnv.h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;

    // Same wiring, but the vercel comment carries no URL: no section, no sentence.
    const noUrl = setup();
    noUrl.gh.queueResponse({
      stdout: JSON.stringify({ comments: [{ author: { login: 'vercel' }, body: vercelBody(null, 'IGNORED') }] }),
    });
    const review2 = await saveReviewSession(noUrl.h, 'pr-app-13');
    const dir2 = `${SESSIONS_DIR}/${review2.id}`;
    const p2 = noUrl.h.service.runReview(review2.id);
    await flush();
    const brief2 = await noUrl.h.fs.readFile(`${dir2}/BRIEF.md`);
    const prompt2 = noUrl.h.runner.getPrompts(noUrl.h.runner.lastHandle())[0];
    expect(brief2).not.toContain('## LIVE UI CHECK');
    expect(brief2).toContain('Vercel preview: UNAVAILABLE');
    expect(prompt2).toBe(renderReviewPrompt({ sessionDir: dir2 }));
    await noUrl.h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p2;
  });

  it('F1: findings\' environment tears down before the findings->plan->develop chain starts develop (same port as findings)', async () => {
    const { h, callLog } = setup({ env: { localApp: { ...LOCAL_APP, stages: ['findings', 'develop'] } } });
    const invId = 'inv-f1';
    const inv: Session = {
      schemaVersion: 2,
      id: invId,
      mode: 'investigation',
      createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${invId}`, branch: 'investigate/APP-1' },
      lineage: { pipelineId: invId, parentSessionId: null, ticket: 'APP-1', selfReview: false },
      stageStatus: 'findings',
      agent: null,
      lastRun: null,
      pr: null,
      intent: 'development',
      driveToCompletion: true,
    };
    await h.store.save(inv);
    await prepWorktree(h.fs, invId);

    const p = h.service.runFindings(invId);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null }); // findings
    await h.finishRun({ 'PLAN.md': F1_APPROVED_PLAN }, { code: 0, signal: null }); // plan -> approved -> promote -> runDevelop starts
    await flush();
    const devHandle = h.runner.lastHandle();
    const devId = h.runner.getContext(devHandle).sessionId;
    const devDir = `${SESSIONS_DIR}/${devId}`;

    const starts = callLog.map((e, i) => ({ e, i })).filter((x) => x.e === 'local.start').map((x) => x.i);
    const stops = callLog.map((e, i) => ({ e, i })).filter((x) => x.e === 'local.stop').map((x) => x.i);
    // develop's local app must actually be attempted (a busy port would short-circuit
    // before ever reaching the injected runner's start()) and it must come up as the
    // running local URL, not degrade to UNAVAILABLE.
    expect(starts).toHaveLength(2);
    // findings' stop (the FIRST stop) must happen before develop's start (the SECOND start).
    expect(stops[0]).toBeLessThan(starts[1]);
    expect(await h.fs.readFile(`${devDir}/BRIEF.md`)).toContain(`Local app: ${LOCAL_URL}`);

    h.runner.emitExit(devHandle, { code: 0, signal: null }); // develop run
    await p;
  });
});

describe('PipelineService — no environment wired (regression pins)', () => {
  it('R14: findings and develop briefs are byte-identical to the env-less renderers', async () => {
    const { h } = setup({ noEnvironment: true });
    const inv = await saveInvestigationSession(h);
    const invDir = `${SESSIONS_DIR}/${inv.id}`;
    const p = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# f' }, { code: 0, signal: null });
    await p;
    expect(await h.fs.readFile(`${invDir}/BRIEF.md`)).toBe(
      renderFindingsBrief({ sessionDir: invDir, ticket: 'APP-1', intent: 'investigate_only' }),
    );

    const dev = await saveDevSession(h);
    const devDir = `${SESSIONS_DIR}/${dev.id}`;
    const p2 = h.service.runDevelop(dev.id);
    await h.finishRun({}, { code: 0, signal: null });
    await p2;
    expect(await h.fs.readFile(`${devDir}/BRIEF.md`)).toBe(
      renderDevelopBrief({ sessionDir: devDir, ticket: 'APP-1', hasPlan: false }),
    );
  });

  it('R14: review and rereview write a BRIEF.md with empty environment/UI-check sections, and the prompt has no LIVE UI CHECK sentence', async () => {
    const { h } = setup({ noEnvironment: true });
    const review = await saveReviewSession(h);
    const sessionDir = `${SESSIONS_DIR}/${review.id}`;

    const p = h.service.runReview(review.id);
    await flush();
    expect(h.runner.getPrompts(h.runner.lastHandle())).toEqual([renderReviewPrompt({ sessionDir })]);
    expect(await h.fs.readFile(`${sessionDir}/AGENT_STATE`)).toBe('working');
    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p;

    const brief = await h.fs.readFile(`${sessionDir}/BRIEF.md`);
    expect(brief).toBe(renderReviewBrief({ sessionDir, prNumber: 12 }));
    expect(brief).not.toContain('## Environment');
    expect(brief).not.toContain('## LIVE UI CHECK');

    queueRereviewGit(h);
    const p2 = h.service.runRereview(review.id);
    await h.finishRun({ 'REVIEW.md': '# Review\nx' }, { code: 0, signal: null });
    await p2;
    const rereviewBrief = await h.fs.readFile(`${sessionDir}/BRIEF.md`);
    expect(rereviewBrief).toBe(renderRereviewBrief({ sessionDir, prNumber: 12, commitCount: 1 }));
  });
});

describe('pipeline-service.ts source pins', () => {
  const source = readFileSync(path.join(__dirname, '../../src/pipeline/pipeline-service.ts'), 'utf8');

  it("runStageLocked still takes `brief: string | null` — no thunk", () => {
    expect(source).toContain('    brief: string | null,');
  });

  it('the locking-invariant comment block is byte-identical to the pre-Phase-5 text', () => {
    const expected = `// Locking invariant (replaces the old F5/F6 "known gap" note — this used to
// be accepted debt; a proven session-store clobber promoted it to a fix):
// before \`run.started\` fires, the caller — an API route handler, or this
// file's own \`runStageLocked\` — holds the per-session KeyedLock, so pre-run
// work must NOT try to acquire it too (KeyedLock is not re-entrant; nesting
// \`lock.withLock\` for the same id deadlocks). After \`run.started\`, the
// caller has released that lock, so EVERY subsequent write to that
// session — StageRunner's post-exit lastRun/agent patch, this file's
// evaluate -> transition -> pr/reviewVersion/lastRereviewSummary patches,
// and any chained stage's own pre-run work — must acquire the lock itself
// before reading-then-saving. Methods below that read-then-save without
// going through \`transition\`/\`patchLastRun\`/\`runStageLocked\` are the ones
// still doing a single, atomic, brand-new-id-only write (nothing else can
// reference that id yet) — those don't need the lock.
`;
    expect(source.slice(0, expected.length)).toBe(expected);
  });
});
