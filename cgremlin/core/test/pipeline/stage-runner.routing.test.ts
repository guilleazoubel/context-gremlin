import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { KeyedLock } from '../../src/api/keyed-lock';
import { RunnerUnavailableError, StageRunner } from '../../src/pipeline/stage-runner';
import type { ResolvedRoute } from '../../src/config/routing';
import type { StageName } from '../../src/schema/stage';
import { migrateV1ToV2 } from '../../src/schema/session';

const sessionsDir = '/sessions';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function inv(resumeId: string | null) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if (resumeId !== null) s.agent = { runner: 'claude-code', resumeId, humanTurn: null };
  return s;
}

const toCodex = (stage: StageName): ResolvedRoute =>
  stage === 'review'
    ? { stage, runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', source: 'routing' }
    : { stage, runner: 'claude-code', model: null, effort: null, source: 'legacy' };

function started(runner: FakeAgentRunner): boolean {
  try {
    runner.lastHandle();
    return true;
  } catch {
    return false;
  }
}

async function setup(opts: { routeFor?: (stage: StageName) => ResolvedRoute; withCodex?: boolean; resumeId?: string | null } = {}) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, sessionsDir);
  await store.save(inv(opts.resumeId ?? null));
  await fs.mkdir('/w/inv-1', { recursive: true });
  const claude = new FakeAgentRunner();
  const codex = new FakeAgentRunner();
  const sr = new StageRunner({
    runner: claude,
    runnerKind: 'claude-code',
    ...(opts.withCodex === false ? {} : { runners: { 'claude-code': claude, codex } }),
    ...(opts.routeFor ? { routeFor: opts.routeFor } : {}),
    store, fs, events: new EngineEvents(), sessionsDir,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    lock: new KeyedLock(),
  });
  return { fs, store, claude, codex, sr };
}

describe('R116 — the stage runner routes each stage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a stage routed to codex starts on the codex runner with the route’s model and effort; the engine-wide runner is never started', async () => {
    const { claude, codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: '# b', prompt: 'go' });
    await flush();
    expect(started(claude)).toBe(false);
    expect(codex.getContext(codex.lastHandle())).toEqual({
      sessionId: 'inv-1', workingDirectory: '/w/inv-1', additionalDirs: ['/sessions/inv-1'], resumeId: undefined,
      model: 'gpt-6.1-sol', effort: 'high',
    });
    codex.emitExit(codex.lastHandle(), { code: 0, signal: null });
    const { session } = await p;
    expect(session.agent?.runner).toBe('codex');
  });

  it('a stage the route leaves on legacy runs on the engine-wide runner', async () => {
    const { claude, codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    expect(started(codex)).toBe(false);
    claude.emitExit(claude.lastHandle(), { code: 0, signal: null });
    expect((await p).session.agent?.runner).toBe('claude-code');
  });

  it('with no routeFor every stage runs on the engine-wide runner with no model or effort in the context (legacy)', async () => {
    const { claude, sr } = await setup({ withCodex: false });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const ctx = claude.getContext(claude.lastHandle());
    expect('model' in ctx).toBe(false);
    expect('effort' in ctx).toBe(false);
    claude.emitExit(claude.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a route naming a runner the engine does not have fails the stage before any agent starts', async () => {
    const { claude, store, sr } = await setup({ routeFor: toCodex, withCodex: false });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' })).rejects.toBeInstanceOf(
      RunnerUnavailableError,
    );
    expect(started(claude)).toBe(false);
    expect((await store.load('inv-1')).lastRun).toMatchObject({
      stage: 'review', outcome: 'failed', error: expect.stringContaining("routed to runner 'codex'"),
    });
    expect(sr.activeSessionIds()).toEqual([]);
  });

  it('stop() stops the runner the stage was routed to', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const h = codex.lastHandle();
    expect(await sr.stop('inv-1')).toBe(true);
    expect(codex.isStopped(h)).toBe(true);
    codex.emitExit(h, { code: null, signal: 'SIGTERM' });
    expect((await p).outcome).toBe('stopped');
  });

  it('liveness asks the routed runner for the pid', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const h = codex.lastHandle();
    codex.setPid(h, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(sr.activeSessionIds()).toEqual([]);
    codex.emitExit(h, { code: null, signal: 'SIGKILL' });
    await p;
  });

  it('a session last run on claude-code, routed to codex, starts a fresh conversation and notes the switch', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex, resumeId: 'claude-sess-1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    expect(codex.getContext(codex.lastHandle()).resumeId).toBeUndefined();
    codex.emitExit(codex.lastHandle(), { code: 0, signal: null });
    const { session } = await p;
    expect(session.lastRun?.error).toBe('runner changed from claude-code to codex; started a fresh conversation');
  });

  it("S2-6 — a route handing codex effort 'max' fails the stage before any agent starts (codex has no 'max')", async () => {
    const codexMax = (stage: StageName): ResolvedRoute => ({ stage, runner: 'codex', model: null, effort: 'max', source: 'routing' });
    const { claude, codex, store, sr } = await setup({ routeFor: codexMax });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' })).rejects.toThrow(/codex has no 'max'/);
    expect(started(codex)).toBe(false);
    expect(started(claude)).toBe(false);
    expect((await store.load('inv-1')).lastRun).toMatchObject({ stage: 'review', outcome: 'failed' });
    expect(sr.activeSessionIds()).toEqual([]);
  });

  it('a route with no model and no effort leaves both keys off the routed runner’s context (S2-5: no model crosses families)', async () => {
    const bare = (stage: StageName): ResolvedRoute => ({ stage, runner: 'codex', model: null, effort: null, source: 'routing' });
    const { codex, sr } = await setup({ routeFor: bare });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const ctx = codex.getContext(codex.lastHandle());
    expect('model' in ctx).toBe(false);
    expect('effort' in ctx).toBe(false);
    codex.emitExit(codex.lastHandle(), { code: 0, signal: null });
    await p;
  });
});
