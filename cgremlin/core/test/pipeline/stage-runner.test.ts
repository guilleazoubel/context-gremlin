import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { RunInProgressError, StageRunner, WorkspaceMissingError } from '../../src/pipeline/stage-runner';
import { migrateV1ToV2 } from '../../src/schema/session';

const sessionsDir = '/sessions';
function inv(overrides: Partial<{ worktreePath: string | undefined; resumeId: string | null }> = {}) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if ('worktreePath' in overrides) s.workspace = { ...s.workspace, worktreePath: overrides.worktreePath };
  if (overrides.resumeId !== undefined) s.agent = { runner: 'claude-code', resumeId: overrides.resumeId };
  return s;
}

// StageRunner.run() chains several sequential awaits (store.load, fs.mkdir,
// two fs.writeFile calls, store.save's own three internal fs awaits) before
// it ever reaches `runner.start()` — empirically well over a dozen nested
// microtask hops. A fixed count of `await Promise.resolve()` calls is too
// fragile to reach that point deterministically, so wait for a macrotask
// boundary instead: Node drains the entire microtask queue before running a
// `setImmediate` callback, so this reliably flushes the whole chain.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function setup(session = inv()) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, sessionsDir);
  await store.save(session);
  const runner = new FakeAgentRunner();
  const events = new EngineEvents();
  const now = () => new Date('2026-09-04T12:00:00.000Z');
  const sr = new StageRunner({ runner, store, fs, events, sessionsDir, runnerKind: 'claude-code', now });
  return { fs, store, runner, events, sr };
}

describe('StageRunner.run', () => {
  it('writes BRIEF.md and AGENT_STATE=working, passes the session dir as additionalDirs and the worktree as cwd, and sends the prompt', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# brief', prompt: 'go' });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('# brief');
    expect(await fs.readFile('/sessions/inv-1/AGENT_STATE')).toBe('working');
    const h = runner.lastHandle();
    expect(runner.getContext(h)).toEqual({
      sessionId: 'inv-1', workingDirectory: '/w/inv-1', additionalDirs: ['/sessions/inv-1'], resumeId: undefined,
    });
    expect(runner.getPrompts(h)).toEqual(['go']);
    runner.emitExit(h, { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
  });

  it('records lastRun running → succeeded with timestamps, and persists the runner resume id', async () => {
    const { store, runner, sr, events } = await setup();
    const started: string[] = []; const finished: string[] = [];
    events.on('run.started', (e) => started.push(e.stage));
    events.on('run.finished', (e) => finished.push(e.outcome));
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    expect((await store.load('inv-1')).lastRun).toMatchObject({ stage: 'findings', outcome: 'running', finishedAt: null });
    const h = runner.lastHandle();
    runner.setResumeId(h, 'claude-sess-1');
    runner.emitExit(h, { code: 0, signal: null });
    const { session } = await p;
    expect(session.lastRun).toEqual({
      stage: 'findings', startedAt: '2026-09-04T12:00:00.000Z', finishedAt: '2026-09-04T12:00:00.000Z',
      exitCode: 0, signal: null, outcome: 'succeeded', error: null,
    });
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'claude-sess-1' });
    expect(started).toEqual(['findings']); expect(finished).toEqual(['succeeded']);
  });

  it('seeds resumeId from the session so a restarted engine continues the same conversation', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'plan' });
    await flush();
    const h = runner.lastHandle();
    expect(runner.getContext(h).resumeId).toBe('prev');
    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });

  it('marks failed on non-zero exit and on signal, with a message', async () => {
    const { runner, sr } = await setup();
    const p1 = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 2, signal: null });
    expect((await p1).session.lastRun).toMatchObject({ outcome: 'failed', exitCode: 2, error: 'agent exited with code 2' });
    const p2 = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: null, signal: 'SIGKILL' });
    expect((await p2).session.lastRun).toMatchObject({ outcome: 'failed', signal: 'SIGKILL', error: 'agent killed by SIGKILL' });
  });

  it('does not treat sendPrompt resolving as completion — the run stays running until onExit fires', async () => {
    const { store, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    let settled = false; void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20)); // FakeAgentRunner.sendPrompt has resolved long ago by now
    expect(settled).toBe(false);
    expect(sr.isRunning('inv-1')).toBe(true);
    expect((await store.load('inv-1')).lastRun?.outcome).toBe('running');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
    expect(settled).toBe(true);
  });

  it('stop() kills the runner and the run resolves as stopped once exit arrives', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    expect(await sr.stop('inv-1')).toBe(true);
    expect(runner.isStopped(h)).toBe(true);
    runner.emitExit(h, { code: null, signal: 'SIGTERM' });
    const r = await p;
    expect(r.outcome).toBe('stopped');
    expect(r.session.lastRun).toMatchObject({ outcome: 'stopped', error: 'stopped by user' });
    expect(sr.isRunning('inv-1')).toBe(false);
    expect(await sr.stop('inv-1')).toBe(false);
  });

  it('rejects a second concurrent run for the same session and allows a different session', async () => {
    const { store, runner, sr } = await setup();
    await store.save({ ...inv(), id: 'inv-2', workspace: { repoUrl: 'u', worktreePath: '/w/inv-2' } });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    await expect(sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'x' })).rejects.toThrow(RunInProgressError);
    const p2 = sr.run({ sessionId: 'inv-2', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit({ id: 'fake-agent-1' }, { code: 0, signal: null });
    runner.emitExit({ id: 'fake-agent-2' }, { code: 0, signal: null });
    await Promise.all([p, p2]);
  });

  it('throws WorkspaceMissingError when the session has no worktree', async () => {
    const { sr } = await setup(inv({ worktreePath: undefined }));
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow(WorkspaceMissingError);
  });

  it('a runner.start failure is recorded as a failed run and rethrown, and clears the running flag', async () => {
    const { store, sr, runner } = await setup();
    runner.start = async () => { throw new Error('spawn ENOENT'); };
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow('spawn ENOENT');
    expect((await store.load('inv-1')).lastRun).toMatchObject({ outcome: 'failed', error: 'spawn ENOENT' });
    expect(sr.isRunning('inv-1')).toBe(false);
  });

  it('stop() requested before the agent starts never sends a prompt', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    expect(await sr.stop('inv-1')).toBe(true);
    const result = await p;
    expect(result.outcome).toBe('stopped');
    expect(runner.getPrompts(runner.lastHandle())).toEqual([]);
    expect(result.session.lastRun).toMatchObject({ outcome: 'stopped', error: 'stopped by user' });
    expect(sr.isRunning('inv-1')).toBe(false);
  });

  it('a failure while persisting the failed-run record does not mask the original error, and run.finished still fires once', async () => {
    const { store, runner, events, sr } = await setup();
    const finished: string[] = [];
    events.on('run.finished', (e) => finished.push(e.outcome));

    let saveCount = 0;
    const originalSave = store.save.bind(store);
    store.save = async (session) => {
      saveCount += 1;
      if (saveCount === 2) {
        // The final (post-exit) save fails, and every load from then on is
        // corrupt too — simulating a disk that went from full to corrupt.
        store.load = async () => { throw new Error('corrupt'); };
        throw new Error('disk full');
      }
      return originalSave(session);
    };

    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });

    await expect(p).rejects.toThrow('disk full');
    expect(finished).toEqual(['failed']);
    expect(sr.isRunning('inv-1')).toBe(false);
  });
});
