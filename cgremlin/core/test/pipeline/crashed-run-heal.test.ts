/**
 * Phase 18 — nothing healed a crashed run.
 *
 * Phase 15 swept `verifying` qa sessions at boot. The wedge that followed was
 * the same shape one rung down: ANY session whose `lastRun.outcome` is still
 * `running` while the runner holds nothing was left contradicting itself
 * forever. So the sweep is generalised, and the contradiction is also healed
 * lazily — under the session's own lock — the first time a read path sees it.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush } from '../support/pipeline-harness';
import { CRASHED_RUN_ERROR } from '../../src/pipeline/run-liveness';
import type { LastRun } from '../../src/schema/stage';
import type { QaSession, Session } from '../../src/schema/session';

const CRASHED: LastRun = {
  stage: 'findings',
  startedAt: '2026-09-16T21:11:06.000Z',
  finishedAt: null,
  exitCode: null,
  signal: null,
  outcome: 'running',
  error: null,
};

function qaSession(id: string, stageStatus: string, lastRun: LastRun | null): QaSession {
  return {
    schemaVersion: 2,
    id,
    mode: 'qa',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `/worktrees/${id}`, branch: `qa/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'HB-627', selfReview: false },
    agent: null,
    lastRun,
    pr: null,
    stageStatus,
    qa: { verifiedSha: null, verdict: null },
  } as unknown as QaSession;
}

async function crashedInvestigation(): Promise<{ h: ReturnType<typeof createHarness>; id: string }> {
  const h = createHarness();
  const inv = await createInvestigation(h.service);
  await h.store.save({ ...inv, lastRun: CRASHED } as Session);
  return { h, id: inv.id };
}

function countTransitions(h: ReturnType<typeof createHarness>): () => number {
  let seen = 0;
  h.events.on('session.transitioned', () => { seen += 1; });
  return () => seen;
}

describe('a crashed run is reconciled to failed', () => {
  it('records the failure, says what happened, and announces the session exactly once', async () => {
    const { h, id } = await crashedInvestigation();
    const transitions = countTransitions(h);

    expect(await h.service.reconcileCrashedRun(id)).toBe(true);

    const healed = await h.store.load(id);
    expect(healed.lastRun?.outcome).toBe('failed');
    expect(healed.lastRun?.error).toBe(CRASHED_RUN_ERROR);
    expect(healed.lastRun?.finishedAt).not.toBeNull();
    expect(transitions()).toBe(1);
  });

  it('is idempotent: a second pass changes nothing and announces nothing', async () => {
    const { h, id } = await crashedInvestigation();
    await h.service.reconcileCrashedRun(id);
    const transitions = countTransitions(h);

    expect(await h.service.reconcileCrashedRun(id)).toBe(false);
    expect(transitions()).toBe(0);
  });

  it('leaves a genuinely live run alone', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const running = h.service.runFindings(inv.id);
    running.catch(() => undefined);
    await flush();

    expect(await h.service.reconcileCrashedRun(inv.id)).toBe(false);
    expect((await h.store.load(inv.id)).lastRun?.outcome).toBe('running');

    h.runner.emitExit(h.runner.lastHandle(), { code: 1, signal: null });
    await running.catch(() => undefined);
  });

  it('moves the phase to `failed` too where the mode has one', async () => {
    const h = createHarness();
    await h.store.save(qaSession('qa-crashed', 'verifying', { ...CRASHED, stage: 'verify' }));

    expect(await h.service.reconcileCrashedRun('qa-crashed')).toBe(true);
    const healed = await h.store.load('qa-crashed');
    expect(healed.stageStatus).toBe('failed');
    expect(healed.lastRun?.error).toBe(CRASHED_RUN_ERROR);
  });

  it('takes the session lock rather than racing whoever holds it', async () => {
    const { h, id } = await crashedInvestigation();
    let released!: () => void;
    const held = h.lock.withLock(id, () => new Promise<void>((resolve) => { released = resolve; }));
    await flush();

    let done = false;
    const heal = h.service.reconcileCrashedRun(id).then(() => { done = true; });
    await flush();
    expect(done).toBe(false);

    released();
    await held;
    await heal;
    expect((await h.store.load(id)).lastRun?.outcome).toBe('failed');
  });
});

describe('the boot sweep is no longer only about `verifying`', () => {
  it('heals every crashed run, keeps the Phase 15 qa case, and reports one id per session', async () => {
    const { h, id } = await crashedInvestigation();
    await h.store.save(qaSession('qa-stuck', 'verifying', null));
    await h.store.save(qaSession('qa-fine', 'ready', null));

    const swept = await h.service.failStaleRuns();
    expect(swept.sessionIds.sort()).toEqual([id, 'qa-stuck'].sort());
    expect(swept.count).toBe(2);
    expect((await h.store.load(id)).lastRun?.error).toBe(CRASHED_RUN_ERROR);
    expect((await h.store.load('qa-stuck')).stageStatus).toBe('failed');
    expect((await h.store.load('qa-fine')).stageStatus).toBe('ready');
  });
});

describe('a read path heals what it sees, rather than waiting for a restart', () => {
  it('asking for the conversation on a crashed session fixes it on the way', async () => {
    const { h, id } = await crashedInvestigation();
    const transitions = countTransitions(h);

    await h.service.conversation(id);

    expect((await h.store.load(id)).lastRun?.outcome).toBe('failed');
    expect(transitions()).toBe(1);
  });
});
