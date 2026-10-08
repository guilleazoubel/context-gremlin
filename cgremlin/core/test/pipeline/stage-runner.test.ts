import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { RunInProgressError, StageRunner, WorkspaceMissingError } from '../../src/pipeline/stage-runner';
import { runLiveness } from '../../src/pipeline/run-liveness';
import { KeyedLock } from '../../src/api/keyed-lock';
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
  if (overrides.resumeId !== undefined) s.agent = { runner: 'claude-code', resumeId: overrides.resumeId, humanTurn: null };
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

async function setup(session = inv(), opts: { runnerKind?: 'claude-code' | 'codex' } = {}) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, sessionsDir);
  await store.save(session);
  // The worktree a session names has to actually exist: StageRunner refuses
  // to run in one that is gone from disk (WorktreeGoneError).
  if (session.workspace.worktreePath) await fs.mkdir(session.workspace.worktreePath, { recursive: true });
  const runner = new FakeAgentRunner();
  const events = new EngineEvents();
  const now = () => new Date('2026-09-04T12:00:00.000Z');
  const lock = new KeyedLock();
  const sr = new StageRunner({ runner, store, fs, events, sessionsDir, runnerKind: opts.runnerKind ?? 'claude-code', now, lock });
  return { fs, store, runner, events, sr, lock };
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
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'claude-sess-1', humanTurn: null });
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

  it('never seeds a resume id from a different runner; starts fresh, records the new runner/id, and notes the switch without failing the run', async () => {
    const { store, runner, sr } = await setup(inv({ resumeId: 'claude-sess-1' }), { runnerKind: 'codex' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'plan' });
    await flush();
    const h = runner.lastHandle();
    expect(runner.getContext(h).resumeId).toBeUndefined();
    runner.setResumeId(h, 'codex-sess-1');
    runner.emitExit(h, { code: 0, signal: null });
    const { session, outcome } = await p;
    expect(outcome).toBe('succeeded');
    expect(session.agent).toEqual({ runner: 'codex', resumeId: 'codex-sess-1', humanTurn: null });
    expect(session.lastRun).toMatchObject({
      outcome: 'succeeded',
      error: 'runner changed from claude-code to codex; started a fresh conversation',
    });
    expect((await store.load('inv-1')).agent).toEqual({ runner: 'codex', resumeId: 'codex-sess-1', humanTurn: null });
  });

  it('same-runner resume still seeds and completes with no runner-change note', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'plan' });
    await flush();
    const h = runner.lastHandle();
    expect(runner.getContext(h).resumeId).toBe('prev');
    runner.emitExit(h, { code: 0, signal: null });
    const { session } = await p;
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'prev', humanTurn: null });
    expect(session.lastRun).toMatchObject({ outcome: 'succeeded', error: null });
  });

  it('activeSessionIds reflects sessions with an in-flight run, and is empty once it exits', async () => {
    const { runner, sr } = await setup();
    expect(sr.activeSessionIds()).toEqual([]);
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    expect(sr.activeSessionIds()).toEqual(['inv-1']);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
    expect(sr.activeSessionIds()).toEqual([]);
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

  /**
   * Defect 2 — the engine CAPTURED the reason a run died and threw it away.
   *
   * The user's findings run died after three seconds. The agent said why 362ms before it exited
   * ("Failed to authenticate: OAuth session expired and could not be refreshed"), the sentence
   * reached `run.output`, and the only thing that ever persisted a `run.output` was the verbose
   * engine log — which was off. What the user got was `agent exited with code 1`.
   */
  it('records what the process actually said on a non-zero exit, not just the exit code', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.emitOutput(h, { stream: 'stdout', data: 'Reading the ticket…\n' });
    runner.emitOutput(h, {
      stream: 'stderr',
      data: 'Failed to authenticate: OAuth session expired and could not be refreshed\n',
    });
    runner.emitExit(h, { code: 1, signal: null });
    expect((await p).session.lastRun?.error).toBe(
      'agent exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    );
  });

  it('redacts a secret in that output before it is persisted', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.emitOutput(h, { stream: 'stderr', data: 'refresh rejected: authorization=sk-live-9f8e7d6c5b4a\n' });
    runner.emitExit(h, { code: 1, signal: null });
    const error = (await p).session.lastRun?.error ?? '';
    expect(error).toContain('authorization=<redacted>');
    expect(error).not.toContain('sk-live-9f8e7d6c5b4a');
  });

  it('keeps only a bounded tail, so a chatty agent cannot write an unbounded error', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    for (let i = 0; i < 200; i++) runner.emitOutput(h, { stream: 'stdout', data: `${'x'.repeat(200)}\n` });
    runner.emitOutput(h, { stream: 'stderr', data: 'the last thing it said\n' });
    runner.emitExit(h, { code: 1, signal: null });
    const error = (await p).session.lastRun?.error ?? '';
    expect(error).toBe('agent exited with code 1: the last thing it said');
    expect(error.length).toBeLessThan(600);
  });

  it('says nothing about the output when the run succeeded', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.emitOutput(h, { stream: 'stdout', data: 'wrote FINDINGS.md\n' });
    runner.emitExit(h, { code: 0, signal: null });
    expect((await p).session.lastRun?.error).toBeNull();
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

  it('activeSessionIds lists sessions with an in-flight run, and clears once it finishes', async () => {
    const { runner, sr } = await setup();
    expect(sr.activeSessionIds()).toEqual([]);
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    expect(sr.activeSessionIds()).toEqual(['inv-1']);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
    expect(sr.activeSessionIds()).toEqual([]);
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
    const { fs, store, runner, sr } = await setup();
    await store.save({ ...inv(), id: 'inv-2', workspace: { repoUrl: 'u', worktreePath: '/w/inv-2' } });
    await fs.mkdir('/w/inv-2', { recursive: true });
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

  it('a stageStatus transition applied while a run is pending is preserved by the final save (the post-exit re-read must not clobber it)', async () => {
    const { store, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    // An external change lands on disk after the "running" lastRun was
    // persisted, but before the agent exits.
    await store.transition('inv-1', 'planning');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    const result = await p;
    expect(result.session.stageStatus).toBe('planning');
    expect(result.session.lastRun).toMatchObject({ outcome: 'succeeded' });
    const persisted = await store.load('inv-1');
    expect(persisted.stageStatus).toBe('planning');
    expect(persisted.lastRun).toMatchObject({ outcome: 'succeeded' });
  });
});

describe('Phase 19 — active self-corrects when a child dies without an exit event', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an entry whose pid is gone: not reported live, dropped, and runLiveness answers crashed', async () => {
    const { store, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.setPid(h, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    expect(sr.activeSessionIds()).toEqual([]);
    // Dropped, not just hidden: a second call still reports nothing.
    expect(sr.activeSessionIds()).toEqual([]);
    expect(sr.isRunning('inv-1')).toBe(false);

    const persisted = await store.load('inv-1');
    expect(runLiveness(persisted.lastRun, false)).toBe('crashed');

    // Clean up the still-pending run() promise without a real exit — the
    // fake process is gone, so nothing will ever call onExit for real.
    runner.emitExit(h, { code: null, signal: 'SIGKILL' });
    await p;
  });

  it('an entry whose pid is alive is still reported live', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.setPid(h, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(sr.activeSessionIds()).toEqual(['inv-1']);
    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });

  it('a kill(pid,0) that throws EPERM: still reported live (pids get reused; EPERM proves someone holds it, not that it is dead)', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.setPid(h, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(sr.activeSessionIds()).toEqual(['inv-1']);
    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });

  it('an entry with no pid yet (mid-spawn) is treated as live and never dropped', async () => {
    const { runner, sr } = await setup();
    const killSpy = vi.spyOn(process, 'kill');
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    // FakeAgentRunner.getPid returns undefined until setPid is called —
    // exactly the real runners' "child hasn't spawned yet" state.

    expect(sr.activeSessionIds()).toEqual(['inv-1']);
    expect(killSpy).not.toHaveBeenCalled();
    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });

  it('NEVER signals a real process — the only signal argument the probe ever passes is 0', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.setPid(h, 4242);
    const signalsSeen: unknown[] = [];
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      signalsSeen.push(signal);
      return true;
    });

    sr.activeSessionIds();
    sr.isRunning('inv-1');

    expect(signalsSeen.length).toBeGreaterThan(0);
    expect(signalsSeen.every((s) => s === 0)).toBe(true);

    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });
});

describe('MG-A7 human-turn-survives-a-run', () => {
  it("a claim survives both of run()'s agent-object rebuilds, and resumeId is still recorded", async () => {
    const CLAIM = { claimedAt: '2026-09-10T09:00:00.000Z', expiresAt: '2026-09-10T09:10:00.000Z' };
    const { store, runner, events, sr, lock } = await setup(inv({ resumeId: 'prev' }));
    // R9 refuses `claimConversation` while a run is live, so a mid-run claim
    // is not expressible: the claim is written BEFORE the run starts, through
    // the store, under the SAME per-session lock every other writer takes.
    await lock.withLock('inv-1', async () => {
      const s = await store.load('inv-1');
      await store.save({ ...s, agent: { runner: 'claude-code', resumeId: 'prev', humanTurn: CLAIM } });
    });

    let seededAgent: unknown;
    events.on('run.started', (e) => { seededAgent = e.session.agent; });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    // The pre-run seed (stage-runner.ts:103) — the `running` snapshot.
    expect(seededAgent).toEqual({ runner: 'claude-code', resumeId: 'prev', humanTurn: CLAIM });

    const h = runner.lastHandle();
    runner.setResumeId(h, 'claude-sess-9');
    runner.emitExit(h, { code: 0, signal: null });
    await p;
    // The post-exit merge (stage-runner.ts:165).
    expect((await store.load('inv-1')).agent).toEqual({
      runner: 'claude-code', resumeId: 'claude-sess-9', humanTurn: CLAIM,
    });
  });
});

describe('R90 — fresh runs and the per-round archive', () => {
  async function seedRound(fs: InMemoryFileSystem, files: Record<string, string>): Promise<void> {
    await fs.mkdir('/sessions/inv-1', { recursive: true });
    for (const [name, text] of Object.entries(files)) await fs.writeFile(`/sessions/inv-1/${name}`, text);
  }

  it('a fresh run never passes the session’s resume id, and records the new conversation', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    const h = runner.lastHandle();
    expect(runner.getContext(h).resumeId).toBeUndefined();
    runner.setResumeId(h, 'round-2');
    runner.emitExit(h, { code: 0, signal: null });
    const { session } = await p;
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'round-2', humanTurn: null });
  });

  it('a fresh run whose agent reported no conversation id keeps the previous one, so Take over can still resume', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    const { session } = await p;
    expect(session.agent?.resumeId).toBe('prev');
  });

  it('a non-fresh run still resumes (today’s behaviour) and archives nothing', async () => {
    const { fs, runner, sr } = await setup(inv({ resumeId: 'prev' }));
    await seedRound(fs, { 'BRIEF.md': 'old brief', 'FEEDBACK.md': 'old feedback' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'new brief', prompt: 'go' });
    await flush();
    expect(runner.getContext(runner.lastHandle()).resumeId).toBe('prev');
    expect(await fs.exists('/sessions/inv-1/BRIEF-v1.md')).toBe(false);
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('new brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK.md')).toBe('old feedback');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run archives the previous round’s BRIEF.md and FEEDBACK.md under one round number, then writes its own', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'round 1 brief', 'FEEDBACK.md': 'round 1 feedback' });
    const p = sr.run({
      sessionId: 'inv-1', stage: 'plan', brief: 'round 2 brief', prompt: 'go', fresh: true, feedback: 'round 2 feedback',
    });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v1.md')).toBe('round 1 brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v1.md')).toBe('round 1 feedback');
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('round 2 brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK.md')).toBe('round 2 feedback');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('round numbers are shared: a round that had no FEEDBACK.md still advances the number both files use', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF-v1.md': 'r0', 'BRIEF.md': 'r1', 'FEEDBACK.md': 'f1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r2', prompt: 'go', fresh: true });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v2.md')).toBe('r1');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v2.md')).toBe('f1');
    expect(await fs.exists('/sessions/inv-1/FEEDBACK-v1.md')).toBe(false);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run with no feedback of its own still moves the stale FEEDBACK.md out of the agent’s way', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'r1', 'FEEDBACK.md': 'stale' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r2', prompt: 'go', fresh: true });
    await flush();
    expect(await fs.exists('/sessions/inv-1/FEEDBACK.md')).toBe(false);
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v1.md')).toBe('stale');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run with no new brief keeps reading the current BRIEF.md (copied, not moved)', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'r1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'go', fresh: true });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('r1');
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v1.md')).toBe('r1');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh first round has nothing to archive', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r1', prompt: 'go', fresh: true });
    await flush();
    expect((await fs.readdir('/sessions/inv-1')).filter((f) => /-v\d+\.md$/.test(f))).toEqual([]);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });
});
