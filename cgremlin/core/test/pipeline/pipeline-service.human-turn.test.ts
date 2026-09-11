import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  createInvestigation,
  flush,
  WORKTREES_DIR,
  type PipelineHarness,
} from '../support/pipeline-harness';
import {
  HumanTurnInProgressError,
  isClaimed,
  UnsupportedStageError,
  type PipelineService,
} from '../../src/pipeline/pipeline-service';
import { RunInProgressError } from '../../src/pipeline/stage-runner';
import { SessionNotFoundError } from '../../src/engine/session-store';
import { KeyedLock } from '../../src/api/keyed-lock';
import { EMPTY_ENVIRONMENT } from '../../src/pipeline/prompts';
import type { EnvironmentBriefContext } from '../../src/pipeline/prompts';
import type { EnvironmentService, LocalAppStatus } from '../../src/env/environment-service';
import type { Session } from '../../src/schema/session';
import type { HumanTurn, StageName } from '../../src/schema/stage';

const CORE_ROOT = path.resolve(__dirname, '../..');
const INVARIANT_FIXTURE = path.join(CORE_ROOT, 'test/fixtures/pipeline-service-locking-invariant.txt');
const PIPELINE_SERVICE = path.join(CORE_ROOT, 'src/pipeline/pipeline-service.ts');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const REPO_URL = 'git@github.com:acme/app.git';
/** A claim that is still live at NOW. */
const LIVE: HumanTurn = { claimedAt: '2026-09-10T11:55:00.000Z', expiresAt: '2026-09-10T12:05:00.000Z' };
/** A claim whose TTL ran out before NOW. */
const EXPIRED: HumanTurn = { claimedAt: '2026-09-10T11:00:00.000Z', expiresAt: '2026-09-10T11:10:00.000Z' };

function withClaim(session: Session, humanTurn: HumanTurn | null): Session {
  return { ...session, agent: { runner: 'claude-code', resumeId: 'resume-1', humanTurn } };
}

/**
 * Only the members `PipelineService.prepareEnvironment` touches. `wantsLocalApp`
 * always says yes, so "start was never called" is a real assertion rather than
 * a tautology.
 */
class RecordingEnvironment {
  startCalls: string[] = [];
  briefContextCalls = 0;

  wantsLocalApp(): boolean {
    return true;
  }

  async start(session: Session): Promise<LocalAppStatus> {
    this.startCalls.push(session.id);
    return {
      state: 'running', sessionId: session.id, url: 'https://local.test', pid: 1,
      logPath: null, startedAt: NOW.toISOString(), reason: null, logTail: null,
    };
  }

  async briefContext(): Promise<EnvironmentBriefContext> {
    this.briefContextCalls += 1;
    return { ...EMPTY_ENVIRONMENT };
  }

  async writeBypassSecret(): Promise<string | null> {
    return null;
  }

  async clearBypassSecret(): Promise<void> {}

  async stop(): Promise<LocalAppStatus> {
    return {
      state: 'stopped', sessionId: null, url: null, pid: null, logPath: null,
      startedAt: null, reason: null, logTail: null,
    };
  }
}

function investigation(
  id: string,
  stageStatus: 'findings' | 'planning' | 'plan_ready' | 'approved',
  driveToCompletion = false,
): Session {
  return {
    schemaVersion: 2, id, mode: 'investigation', createdAt: '2026-09-10T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: `investigate/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus, agent: null, lastRun: null, pr: null,
    intent: 'investigate_only', driveToCompletion,
  };
}

function development(id: string, stageStatus: 'active' | 'pr_opened' = 'active'): Session {
  return {
    schemaVersion: 2, id, mode: 'development', createdAt: '2026-09-10T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feature/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus, agent: null, lastRun: null, pr: null,
  };
}

function review(id: string, stageStatus: 'queued' | 'ready' | 'changes_requested' = 'queued'): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-09-10T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus, agent: null, lastRun: null,
    pr: {
      repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1',
      headSha: 'a'.repeat(40), reviewedSha: null, title: 'T', author: 'bob',
    },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

interface StageCase {
  stage: StageName;
  session: (id: string) => Session;
  run: (service: PipelineService, id: string) => Promise<unknown>;
}

const STAGE_CASES: readonly StageCase[] = [
  { stage: 'findings', session: (id) => investigation(id, 'findings'), run: (s, id) => s.runFindings(id) },
  { stage: 'plan', session: (id) => investigation(id, 'planning'), run: (s, id) => s.runPlan(id) },
  { stage: 'develop', session: (id) => development(id), run: (s, id) => s.runDevelop(id) },
  { stage: 'review', session: (id) => review(id, 'queued'), run: (s, id) => s.runReview(id) },
  { stage: 'rereview', session: (id) => review(id, 'ready'), run: (s, id) => s.runRereview(id) },
];

function gitFetchOrReset(h: PipelineHarness): string[][] {
  return h.git.calls.map((c) => c.args).filter((args) => args[0] === 'fetch' || args[0] === 'reset');
}

/** FakeAgentRunner.lastHandle() throws until an agent has actually been started. */
function agentStarted(h: PipelineHarness): boolean {
  try {
    h.runner.lastHandle();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a run and settles the assertion WITHOUT awaiting a promise that a
 * missing refusal would leave pending forever: a run that was not refused
 * reaches the fake agent within a macrotask, so `agentStarted` fails fast and
 * loudly instead of the test timing out.
 */
async function expectRefused(h: PipelineHarness, run: Promise<unknown>): Promise<void> {
  const settled = run.then(
    () => new Error('the run was not refused'),
    (err: unknown) => err,
  );
  await flush();
  await flush();
  expect(agentStarted(h)).toBe(false);
  expect(await settled).toBeInstanceOf(HumanTurnInProgressError);
}

function harnessWithEnvironment(): { h: PipelineHarness; env: RecordingEnvironment } {
  const env = new RecordingEnvironment();
  const h = createHarness({ now: () => NOW, environment: () => env as unknown as EnvironmentService });
  return { h, env };
}

describe('isClaimed (R20 — the ONE definition of "claimed")', () => {
  it('is false with no agent, false with no claim, true for a live claim and false for an expired one', () => {
    const s = development('dev-x');
    expect(isClaimed(s, NOW)).toBe(false);
    expect(isClaimed(withClaim(s, null), NOW)).toBe(false);
    expect(isClaimed(withClaim(s, LIVE), NOW)).toBe(true);
    expect(isClaimed(withClaim(s, EXPIRED), NOW)).toBe(false);
  });

  it('treats expiresAt exactly equal to now as expired', () => {
    const s = withClaim(development('dev-x'), { claimedAt: '2026-09-10T11:50:00.000Z', expiresAt: NOW.toISOString() });
    expect(isClaimed(s, NOW)).toBe(false);
  });
});

describe('MG-A6 human-turn-blocks-every-headless-turn', () => {
  for (const c of STAGE_CASES) {
    it(`${c.stage}: a live claim refuses the run before any environment or git work`, async () => {
      const { h, env } = harnessWithEnvironment();
      const id = `s-${c.stage}`;
      await h.store.save(withClaim(c.session(id), LIVE));
      const before = await h.store.load(id);
      const runStarted: string[] = [];
      h.events.on('run.started', (e) => runStarted.push(e.session.id));

      await expectRefused(h, c.run(h.service, id));

      expect(runStarted).toEqual([]);
      expect((await h.store.load(id)).lastRun).toEqual(before.lastRun);
      // R19 — the only two assertions that can tell the advisory check from
      // its absence: no git work in the worktree, and no local app started.
      expect(gitFetchOrReset(h)).toEqual([]);
      expect(env.startCalls).toEqual([]);
    });
  }

  it('the refusal message names the session', async () => {
    const { h } = harnessWithEnvironment();
    await h.store.save(withClaim(development('dev-msg'), LIVE));
    const settled = h.service.runDevelop('dev-msg').then(() => new Error('not refused'), (err: unknown) => err);
    await flush();
    expect(agentStarted(h)).toBe(false);
    expect(await settled).toBeInstanceOf(HumanTurnInProgressError);
    expect((await settled as Error).message).toMatch(/dev-msg/);
  });
});

/**
 * Rewrites the session on disk to hold a live claim once the advisory check's
 * snapshot has already been read — i.e. between the unlocked snapshot and the
 * locked fresh load. Returns the ordered lock log.
 */
async function claimBetweenSnapshotAndLock(
  h: PipelineHarness,
  id: string,
  log: string[],
): Promise<void> {
  const originalLoad = h.store.load.bind(h.store);
  let loads = 0;
  h.store.load = async (loadId: string) => {
    const loaded = await originalLoad(loadId);
    if (loadId === id) {
      loads += 1;
      if (loads === 1) {
        log.push('advisory.snapshot');
        // The claim lands AFTER the advisory snapshot was handed out, so only
        // the locked check can still see it.
        await h.store.save(withClaim(loaded, LIVE));
      }
    }
    return loaded;
  };
}

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

describe('R19 both-sites pin / MG-A9(b) locking-invariant-unchanged', () => {
  it('a claim written between the advisory snapshot and the lock is still refused, inside the lock', async () => {
    const log: string[] = [];
    const env = new RecordingEnvironment();
    const h = createHarness({
      now: () => NOW,
      lock: new LoggingLock(log),
      environment: () => env as unknown as EnvironmentService,
    });
    const id = 'dev-toctou';
    await h.store.save(development(id));
    await claimBetweenSnapshotAndLock(h, id, log);

    const settled = h.service.runDevelop(id).then(
      () => new Error('the run was not refused'),
      (err: unknown) => {
        log.push('rejected');
        return err;
      },
    );
    await flush();
    await flush();
    expect(agentStarted(h)).toBe(false);
    expect(await settled).toBeInstanceOf(HumanTurnInProgressError);
    // The advisory check saw no claim (it ran on the pre-claim snapshot), so
    // the environment WAS prepared — proof this is the locked check firing.
    expect(env.startCalls).toEqual([id]);
    // MG-A9(b): the authoritative refusal happened inside the per-session lock.
    expect(log.indexOf(`lock.enter:${id}`)).toBeGreaterThan(-1);
    expect(log.indexOf(`lock.enter:${id}`)).toBeLessThan(log.indexOf('rejected'));
    expect(agentStarted(h)).toBe(false);
  });

  it('(a) pipeline-service.ts lines 1-14 are byte-identical to the committed pre-Phase-7 fixture', async () => {
    const expected = await readFile(INVARIANT_FIXTURE, 'utf8');
    const actual = (await readFile(PIPELINE_SERVICE, 'utf8')).split('\n').slice(0, 14).join('\n');
    // The fixture was captured with `sed -n '1,14p'`, which emits a trailing newline.
    expect(`${actual}\n`).toBe(expected);
  });
});

describe('R20 expiry is absence, and is reaped under the lock', () => {
  for (const c of STAGE_CASES) {
    it(`${c.stage}: an expired claim blocks nothing and is reaped from disk`, async () => {
      const { h } = harnessWithEnvironment();
      const id = `x-${c.stage}`;
      await h.store.save(withClaim(c.session(id), EXPIRED));
      const started = new Promise<void>((resolve) => h.events.on('run.started', () => resolve()));

      const run = c.run(h.service, id);
      run.catch(() => undefined);
      await started;

      expect((await h.store.load(id)).agent).toEqual({ runner: 'claude-code', resumeId: 'resume-1', humanTurn: null });
      h.runner.emitExit(h.runner.lastHandle(), { code: 1, signal: null });
      await run.catch(() => undefined);
      await flush();
    });
  }

  it('a live claim still blocks, so the reaping is expiry-driven and not unconditional', async () => {
    const { h, env } = harnessWithEnvironment();
    await h.store.save(withClaim(development('dev-live'), LIVE));
    await expectRefused(h, h.service.runDevelop('dev-live'));
    expect(env.startCalls).toEqual([]);
    expect((await h.store.load('dev-live')).agent?.humanTurn).toEqual(LIVE);
  });
});

describe('claimConversation / releaseConversation / conversation (R9, R12, R20)', () => {
  it('writes { claimedAt: now, expiresAt: now + humanTurnTtlMs } under the lock', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(development('dev-1'), null));
    const claimed = await h.service.claimConversation('dev-1');
    expect(claimed.agent).toEqual({
      runner: 'claude-code',
      resumeId: 'resume-1',
      humanTurn: { claimedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 600_000).toISOString() },
    });
    expect((await h.store.load('dev-1')).agent?.humanTurn).toEqual(claimed.agent?.humanTurn);
  });

  it('creates an agent record from the configured runner kind when the session never ran', async () => {
    const h = createHarness({ now: () => NOW, runnerKind: 'codex' });
    await h.store.save(development('dev-2'));
    const claimed = await h.service.claimConversation('dev-2');
    expect(claimed.agent).toEqual({
      runner: 'codex',
      resumeId: null,
      humanTurn: { claimedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 600_000).toISOString() },
    });
  });

  it('R9: refuses with RunInProgressError while a run is live, and writes nothing', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(development('dev-3'));
    const run = h.service.runDevelop('dev-3');
    run.catch(() => undefined);
    await flush();
    expect(h.service.activeSessionIds()).toEqual(['dev-3']);

    await expect(h.service.claimConversation('dev-3')).rejects.toBeInstanceOf(RunInProgressError);
    expect((await h.store.load('dev-3')).agent?.humanTurn).toBeNull();

    h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
    await run;
  });

  it('is idempotent and pushes expiresAt forward (the heartbeat path)', async () => {
    let now = NOW;
    const h = createHarness({ now: () => now });
    await h.store.save(development('dev-4'));
    const first = await h.service.claimConversation('dev-4');
    now = new Date(NOW.getTime() + 60_000);
    const second = await h.service.claimConversation('dev-4');
    expect(new Date(second.agent!.humanTurn!.expiresAt).getTime()).toBeGreaterThan(
      new Date(first.agent!.humanTurn!.expiresAt).getTime(),
    );
  });

  it('claiming an unknown id is a SessionNotFoundError', async () => {
    const h = createHarness({ now: () => NOW });
    await expect(h.service.claimConversation('nope')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('release clears the claim, is idempotent, and is a no-op on a session with no agent record', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(development('dev-5'), LIVE));
    expect((await h.service.releaseConversation('dev-5')).agent?.humanTurn).toBeNull();
    expect((await h.service.releaseConversation('dev-5')).agent?.humanTurn).toBeNull();

    await h.store.save(development('dev-6'));
    const released = await h.service.releaseConversation('dev-6');
    expect(released.agent).toBeNull();
  });

  it('conversation() reports the resume contract, with claimed false for an expired claim', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(development('dev-7'), LIVE));
    expect(await h.service.conversation('dev-7')).toEqual({
      runner: 'claude-code', resumeId: 'resume-1', worktreePath: `${WORKTREES_DIR}/dev-7`, claimed: true,
    });

    await h.store.save(withClaim(development('dev-8'), EXPIRED));
    expect((await h.service.conversation('dev-8')).claimed).toBe(false);

    await h.store.save(development('dev-9'));
    expect(await h.service.conversation('dev-9')).toEqual({
      runner: null, resumeId: null, worktreePath: `${WORKTREES_DIR}/dev-9`, claimed: false,
    });

    await expect(h.service.conversation('nope')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe('R20 terminality — a terminal transition clears the claim', () => {
  const cases: ReadonlyArray<{ session: () => Session; to: string }> = [
    { session: () => investigation('inv-t1', 'approved'), to: 'promoted_to_development' },
    { session: () => investigation('inv-t2', 'findings'), to: 'abandoned' },
    { session: () => development('dev-t1'), to: 'merged' },
    { session: () => development('dev-t2'), to: 'abandoned' },
    { session: () => review('rev-t1', 'queued'), to: 'approved' },
    { session: () => review('rev-t2', 'queued'), to: 'dismissed' },
  ];
  for (const c of cases) {
    it(`${c.session().mode} -> ${c.to} clears it`, async () => {
      const h = createHarness({ now: () => NOW });
      const s = c.session();
      await h.store.save(withClaim(s, LIVE));
      const after = await h.service.transition(s.id, c.to);
      expect(after.agent?.humanTurn).toBeNull();
      expect((await h.store.load(s.id)).agent?.humanTurn).toBeNull();
      // The rest of the agent record is untouched.
      expect(after.agent?.resumeId).toBe('resume-1');
    });
  }

  it('a non-terminal transition leaves the claim intact (regression pin)', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(investigation('inv-t3', 'findings'), LIVE));
    const after = await h.service.transition('inv-t3', 'planning');
    expect(after.agent?.humanTurn).toEqual(LIVE);
    expect((await h.store.load('inv-t3')).agent?.humanTurn).toEqual(LIVE);
  });
});

describe('promote and retry refuse a claimed session', () => {
  it('promote on a claimed investigation is refused before it transitions', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(investigation('inv-p1', 'approved'), LIVE));
    await expectRefused(h, h.service.promote('inv-p1'));
    expect((await h.store.load('inv-p1')).stageStatus).toBe('approved');
  });

  it('promote takes the lock and re-checks: a claim landing after its first load is authoritative', async () => {
    const h = createHarness({ now: () => NOW });
    const id = 'inv-p2';
    await h.store.save(investigation(id, 'plan_ready', true));
    // The claim lands AFTER promote's own unlocked snapshot was handed out —
    // only a locked re-check can see it. Without one, promote's terminal
    // transition would WIPE the claim (clearHumanTurnIfTerminal) and promote
    // would carry on into a brand-new development session.
    const originalLoad = h.store.load.bind(h.store);
    let loads = 0;
    h.store.load = async (loadId: string) => {
      const loaded = await originalLoad(loadId);
      if (loadId === id) {
        loads += 1;
        if (loads === 1) await h.store.save(withClaim(loaded, LIVE));
      }
      return loaded;
    };
    const created: string[] = [];
    h.events.on('session.created', (e) => created.push(e.session.id));

    await expectRefused(h, h.service.promote(id));

    const after = await originalLoad(id);
    expect(after.stageStatus).toBe('plan_ready');
    expect(after.agent?.humanTurn).toEqual(LIVE);
    expect(created).toEqual([]);
  });

  it('retry on a claimed session is refused', async () => {
    const h = createHarness({ now: () => NOW });
    const s = withClaim(development('dev-r1'), LIVE);
    await h.store.save({
      ...s,
      lastRun: {
        stage: 'develop', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
        exitCode: 1, signal: null, outcome: 'failed', error: 'boom',
      },
    });
    await expectRefused(h, h.service.retry('dev-r1'));
  });

  it('clearAllHumanTurns clears every claim and reports which sessions it touched', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(withClaim(development('dev-c1'), LIVE));
    await h.store.save(withClaim(development('dev-c2'), EXPIRED));
    await h.store.save(development('dev-c3'));
    expect(await h.service.clearAllHumanTurns()).toEqual({ count: 2, sessionIds: ['dev-c1', 'dev-c2'] });
    expect((await h.store.load('dev-c1')).agent?.humanTurn).toBeNull();
    expect((await h.store.load('dev-c2')).agent?.humanTurn).toBeNull();
  });
});

describe('unrelated failures are still classified as themselves', () => {
  it('an ineligible unclaimed session still fails with UnsupportedStageError', async () => {
    const h = createHarness({ now: () => NOW });
    const inv = await createInvestigation(h.service);
    await expect(h.service.runDevelop(inv.id)).rejects.toBeInstanceOf(UnsupportedStageError);
  });
});
