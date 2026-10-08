import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { KeyedLock } from '../../src/api/keyed-lock';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { RUN_FACTS_FILE, readRunRecords } from '../../src/pipeline/run-records';
import type { RunStats } from '../../src/agent/agent-runner';
import type { ResolvedRoute } from '../../src/config/routing';
import type { StageName } from '../../src/schema/stage';
import { migrateV1ToV2 } from '../../src/schema/session';

const NOW = '2026-10-08T12:00:00.000Z';
const WARNING = { at: NOW, kind: 'warning' as const, limitType: 'five_hour', resetsAt: '2026-10-08T15:00:00.000Z', message: null };
const STATS: RunStats = {
  tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
  tokensSource: 'result',
  costUsd: 0.42,
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800, webSearchRequests: 0, costUsd: 0.42 },
  },
  limitEvents: [WARNING],
  observedModel: 'claude-opus-5-5',
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function setup(opts: { routeFor?: (stage: StageName) => ResolvedRoute; worktree?: boolean; resumeId?: string } = {}) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, '/sessions');
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if (opts.resumeId !== undefined) s.agent = { runner: 'claude-code', resumeId: opts.resumeId, humanTurn: null };
  await store.save(s);
  if (opts.worktree !== false) await fs.mkdir('/w/inv-1', { recursive: true });
  const runner = new FakeAgentRunner();
  const logs: string[] = [];
  const lock = new KeyedLock();
  const sr = new StageRunner({
    runner, runnerKind: 'claude-code', store, fs, events: new EngineEvents(), sessionsDir: '/sessions',
    now: () => new Date(NOW), lock, log: (line) => logs.push(line),
    ...(opts.routeFor ? { routeFor: opts.routeFor } : {}),
  });
  return { fs, store, runner, sr, logs, lock };
}

describe('R116/R118f — one record per run in <session>/runs.jsonl', () => {
  it('a succeeded run appends its route, tokens, cost, per-model usage, limit events and outcome', async () => {
    const { fs, runner, sr } = await setup({
      routeFor: (stage) => ({ stage, runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' }),
    });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# b', prompt: 'go' });
    await flush();
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(true);
    const h = runner.lastHandle();
    runner.setRunStats(h, STATS);
    runner.emitExit(h, { code: 0, signal: null });
    await p;
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([
      {
        v: 1, sessionId: 'inv-1', stage: 'findings', runner: 'claude-code', model: 'opus', effort: 'high', routeSource: 'routing',
        fresh: false, resumed: false, startedAt: NOW, finishedAt: NOW,
        tokens: STATS.tokens, tokensSource: 'result', costUsd: 0.42, modelUsage: STATS.modelUsage, limitEvents: [WARNING],
        outcome: 'succeeded', stopReason: null, error: null, interrupted: false,
      },
    ]);
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(false);
  });

  it('with no model routed, the record names the model the CLI reported', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.setRunStats(runner.lastHandle(), STATS);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ model: 'claude-opus-5-5', effort: null, routeSource: 'legacy' });
  });

  it('a failed and then a stopped run each append their own record; a runner with no stats records nulls', async () => {
    const { fs, runner, sr } = await setup();
    const first = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    await first;
    const second = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    await sr.stop('inv-1');
    runner.emitExit(runner.lastHandle(), { code: null, signal: 'SIGTERM' });
    await second;
    const records = await readRunRecords(fs, '/sessions/inv-1');
    expect(records.map((r) => [r.outcome, r.stopReason, r.error, r.tokens, r.costUsd, r.modelUsage, r.limitEvents])).toEqual([
      ['failed', null, 'agent exited with code 1', null, null, null, []],
      ['stopped', 'user', 'stopped by user', null, null, null, []],
    ]);
  });

  it('M8 — a run that hit a rejected rate limit is recorded as stopped by the limit; lastRun keeps the process outcome', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const rejected = { at: NOW, kind: 'rejected' as const, limitType: 'five_hour', resetsAt: null, message: null };
    runner.setRunStats(runner.lastHandle(), { ...STATS, limitEvents: [WARNING, rejected] });
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    const result = await p;
    expect(result.session.lastRun?.outcome).toBe('failed');
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ outcome: 'stopped', stopReason: 'limit', limitEvents: [WARNING, rejected] });
  });

  it('a warning alone does not change the outcome', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.setRunStats(runner.lastHandle(), STATS);
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    await p;
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ outcome: 'failed', stopReason: null });
  });

  it('repeated limit events collapse to the latest per kind and limit type', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const at = (minute: number) => `2026-10-08T12:${String(minute).padStart(2, '0')}:00.000Z`;
    const fiveHour = (minute: number) => ({ ...WARNING, at: at(minute) });
    const sevenDay = { ...WARNING, at: at(2), limitType: 'seven_day' };
    const rejected = { at: at(5), kind: 'rejected' as const, limitType: 'five_hour', resetsAt: null, message: null };
    // The CLI emits a warning per 1% move: 81%, 82%, 83%… of the same five-hour window.
    runner.setRunStats(runner.lastHandle(), {
      ...STATS,
      limitEvents: [fiveHour(1), sevenDay, fiveHour(3), fiveHour(4), rejected],
    });
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    await p;
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({
      outcome: 'stopped',
      stopReason: 'limit',
      limitEvents: [sevenDay, fiveHour(4), rejected],
    });
  });

  it('a runner whose stats throw still gets a record, with no stats', async () => {
    const { fs, runner, sr, logs } = await setup();
    runner.getRunStats = () => {
      throw new Error('Unknown agent handle');
    };
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({
      outcome: 'succeeded', tokens: null, tokensSource: null, costUsd: null, modelUsage: null, limitEvents: [],
    });
    expect(logs).toEqual([]);
  });

  it('the record is written before the run gives up the session lock, so nothing that waits on the lock sees a finished run without its record', async () => {
    const { fs, store, runner, sr, lock } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    // A claim or transition arriving the moment lastRun says the run is over queues on the lock.
    while ((await store.load('inv-1')).lastRun?.outcome === 'running') await Promise.resolve();
    const seen = await lock.withLock('inv-1', () => readRunRecords(fs, '/sessions/inv-1'));
    expect(seen.map((r) => r.outcome)).toEqual(['succeeded']);
    await p;
  });

  it('a fresh run is recorded as fresh and not resumed; a resumed one as resumed', async () => {
    const { fs, runner, sr } = await setup({ resumeId: 'prev' });
    const a = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await a;
    const b = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await b;
    expect((await readRunRecords(fs, '/sessions/inv-1')).map((r) => [r.fresh, r.resumed])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('a runner that throws at start still leaves a failed record', async () => {
    const { fs, runner, sr } = await setup();
    runner.start = async () => {
      throw new Error('spawn claude ENOENT');
    };
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow('spawn claude ENOENT');
    expect((await readRunRecords(fs, '/sessions/inv-1')).map((r) => [r.outcome, r.error])).toEqual([['failed', 'spawn claude ENOENT']]);
  });

  it('a run that never reached the agent (worktree gone) writes no record and no facts', async () => {
    const { fs, sr } = await setup({ worktree: false });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow();
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([]);
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(false);
  });

  it('run facts that cannot be written are a log line; the run still gets its record', async () => {
    const { fs, runner, sr, logs } = await setup();
    const realWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (path: string, content: string, options?: { mode?: number }) => {
      if (path.endsWith(`/${RUN_FACTS_FILE}`)) throw new Error('read-only');
      return realWrite(path, content, options);
    };
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
    expect((await readRunRecords(fs, '/sessions/inv-1')).map((r) => r.outcome)).toEqual(['succeeded']);
    expect(logs).toEqual([expect.stringContaining('run facts for inv-1 not written: read-only')]);
  });

  it('a record that cannot be written is a log line, never a failed run', async () => {
    const { fs, runner, sr, logs } = await setup();
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (to.endsWith('/runs.jsonl')) throw new Error('disk full');
      return realRename(from, to);
    };
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
    expect(result.session.lastRun).toMatchObject({ outcome: 'succeeded', error: null });
    expect(logs).toEqual([expect.stringContaining('run record for inv-1 not written: disk full')]);
  });
});
