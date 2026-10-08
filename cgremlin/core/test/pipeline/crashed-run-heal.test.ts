/**
 * Phase 18 — nothing healed a crashed run.
 *
 * Phase 15 swept `verifying` qa sessions at boot. The wedge that followed was
 * the same shape one rung down: ANY session whose `lastRun.outcome` is still
 * `running` while the runner holds nothing was left contradicting itself
 * forever. So the sweep is generalised, and the contradiction is also healed
 * lazily — under the session's own lock — the first time a read path sees it.
 */
import { describe, expect, it, vi } from 'vitest';
import { SESSIONS_DIR, createHarness, createInvestigation, flush } from '../support/pipeline-harness';
import { CRASHED_RUN_ERROR } from '../../src/pipeline/run-liveness';
import { RUN_FACTS_FILE, readRunRecords } from '../../src/pipeline/run-records';
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

describe('I2 — a run the engine lost still gets its record', () => {
  it('a run the engine lost gets an interrupted record when healed, and only one', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const run = h.service.runFindings(inv.id);
    await flush();
    const handle = h.runner.lastHandle();
    h.runner.setPid(handle, 4242);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([inv.id]);
    kill.mockRestore();
    const dir = `${SESSIONS_DIR}/${inv.id}`;
    expect(await readRunRecords(h.fs, dir)).toEqual([
      expect.objectContaining({
        stage: 'findings', runner: 'claude-code', outcome: 'failed', error: CRASHED_RUN_ERROR, interrupted: true,
        tokens: null, tokensSource: null, costUsd: null, modelUsage: null,
      }),
    ]);
    // The lost child reports its exit after all: the record was already written, so no second one.
    h.runner.emitExit(handle, { code: null, signal: 'SIGKILL' });
    await run;
    expect(await readRunRecords(h.fs, dir)).toHaveLength(1);
  });

  function engineDies(): () => void {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    return () => kill.mockRestore();
  }

  it("a lost run's late exit never takes the next run's facts: the next run is recorded once, at its own end", async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const dir = `${SESSIONS_DIR}/${inv.id}`;
    const runA = h.service.runFindings(inv.id);
    await flush();
    const handleA = h.runner.lastHandle();
    h.runner.setPid(handleA, 4242);
    const restore = engineDies();
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([inv.id]);
    restore();
    expect(await readRunRecords(h.fs, dir)).toEqual([expect.objectContaining({ interrupted: true })]);

    // Run B starts on the healed session and leaves its own facts.
    const runB = h.stageRunner.run({ sessionId: inv.id, stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const handleB = h.runner.lastHandle();
    expect(handleB).not.toEqual(handleA);
    const factsB = await h.fs.readFile(`${dir}/${RUN_FACTS_FILE}`);

    // A's child finally reports its exit (its stdio was held open): A is already recorded.
    h.runner.emitExit(handleA, { code: null, signal: 'SIGKILL' });
    await runA.catch(() => undefined);
    expect(await readRunRecords(h.fs, dir)).toHaveLength(1);
    expect(await h.fs.readFile(`${dir}/${RUN_FACTS_FILE}`)).toBe(factsB);

    h.runner.emitExit(handleB, { code: 0, signal: null });
    await runB;
    expect((await readRunRecords(h.fs, dir)).map((r) => [r.outcome, r.interrupted])).toEqual([
      ['failed', true],
      ['succeeded', false],
    ]);
    expect(await h.fs.exists(`${dir}/${RUN_FACTS_FILE}`)).toBe(false);
  });

  it('stale facts from an earlier run never become the record of a run whose own facts write failed', async () => {
    const logs: string[] = [];
    const h = createHarness({ log: (line) => logs.push(line) });
    const inv = await createInvestigation(h.service);
    const dir = `${SESSIONS_DIR}/${inv.id}`;
    await h.fs.mkdir(dir, { recursive: true });
    const stale = JSON.stringify({
      v: 1, runId: 'earlier', sessionId: inv.id, stage: 'plan', runner: 'claude-code', model: 'stale-model', effort: null,
      routeSource: 'legacy', fresh: false, resumed: false, startedAt: '2026-01-01T00:00:00.000Z',
    });
    await h.fs.writeFile(`${dir}/${RUN_FACTS_FILE}`, stale);
    const realWrite = h.fs.writeFile.bind(h.fs);
    h.fs.writeFile = async (path: string, content: string, options?: { mode?: number }) => {
      if (path.endsWith(`/${RUN_FACTS_FILE}`)) throw new Error('EACCES');
      return realWrite(path, content, options);
    };

    const runC = h.service.runFindings(inv.id);
    await flush();
    const handleC = h.runner.lastHandle();
    h.runner.setPid(handleC, 4242);
    const restore = engineDies();
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([inv.id]);
    restore();
    expect(await readRunRecords(h.fs, dir)).toEqual([]);
    expect(await h.fs.readFile(`${dir}/${RUN_FACTS_FILE}`)).toBe(stale);
    expect((await h.store.load(inv.id)).lastRun?.error).toBe(CRASHED_RUN_ERROR);

    // C's own exit, if it ever comes, records C — never the stale run.
    h.runner.emitExit(handleC, { code: 0, signal: null });
    await runC.catch(() => undefined);
    const records = await readRunRecords(h.fs, dir);
    expect(records.map((r) => [r.stage, r.model, r.interrupted])).toEqual([['findings', null, false]]);
  });

  async function crashedWithFacts(facts: Record<string, unknown> | string, options: { log?: (line: string) => void } = {}) {
    const h = createHarness(options);
    const inv = await createInvestigation(h.service);
    await h.store.save({ ...inv, lastRun: CRASHED } as Session);
    const dir = `${SESSIONS_DIR}/${inv.id}`;
    await h.fs.mkdir(dir, { recursive: true });
    const base = {
      v: 1, runId: 'r-1', sessionId: inv.id, stage: CRASHED.stage, runner: 'claude-code', model: 'opus', effort: 'high',
      routeSource: 'routing', fresh: false, resumed: true, startedAt: CRASHED.startedAt,
    };
    await h.fs.writeFile(`${dir}/${RUN_FACTS_FILE}`, typeof facts === 'string' ? facts : JSON.stringify({ ...base, ...facts }));
    return { h, id: inv.id, dir };
  }

  it('the interrupted record names the real session, whatever the agent-writable facts claim', async () => {
    const { h, id, dir } = await crashedWithFacts({ sessionId: 'someone-else' });
    expect(await h.service.reconcileCrashedRun(id)).toBe(true);
    expect(await readRunRecords(h.fs, dir)).toEqual([
      expect.objectContaining({ sessionId: id, stage: 'findings', model: 'opus', effort: 'high', startedAt: CRASHED.startedAt, interrupted: true }),
    ]);
  });

  it.each([
    ['an oversized model', { model: 'm'.repeat(100_000) }],
    ['garbage', 'not json{'],
    ['another run (a different startedAt)', { startedAt: '2026-01-01T00:00:00.000Z' }],
    ['another stage', { stage: 'plan' }],
  ])('facts that are %s give no interrupted record, and the heal still saves', async (_label, facts) => {
    const { h, id, dir } = await crashedWithFacts(facts);
    expect(await h.service.reconcileCrashedRun(id)).toBe(true);
    expect(await readRunRecords(h.fs, dir)).toEqual([]);
    expect((await h.store.load(id)).lastRun).toMatchObject({ outcome: 'failed', error: CRASHED_RUN_ERROR });
  });

  it('an interrupted record that cannot be written is a log line, and the heal still saves', async () => {
    const logs: string[] = [];
    const { h, id, dir } = await crashedWithFacts({}, { log: (line) => logs.push(line) });
    const realRename = h.fs.rename.bind(h.fs);
    h.fs.rename = async (from: string, to: string) => {
      if (to.endsWith('/runs.jsonl')) throw new Error('disk full');
      return realRename(from, to);
    };
    expect(await h.service.reconcileCrashedRun(id)).toBe(true);
    expect(await readRunRecords(h.fs, dir)).toEqual([]);
    expect((await h.store.load(id)).lastRun).toMatchObject({ outcome: 'failed', error: CRASHED_RUN_ERROR });
    expect(logs).toEqual([expect.stringContaining(`interrupted run record for ${id} not written: disk full`)]);
  });
});
