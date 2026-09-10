/**
 * The engine manager, driven against a recording port and a fake clock.
 *
 * This is the suite that stands between a bug and a killed process. Two guards run through all of
 * it: **MG-C1** — an engine that answers is adopted, never raced — and **MG-C2** — nothing is ever
 * signalled that the socket and the identity file have not just agreed is ours.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EngineManager,
  LOG_MAX_BYTES,
  START_TIMEOUT_MS,
  TAIL_LINES,
  type EngineState,
  type Trigger,
} from '../../src/engine/manager';
import { FakeEngineProcess, identity, pidFile } from '../support/fake-engine-process';

const PATHS = {
  configPath: '/home/me/.cgremlin-core/core.json',
  socketPath: '/tmp/cg/engine.sock',
  enginePidPath: '/tmp/cg/engine.json',
  engineLogPath: '/tmp/cg/engine.log',
};

const LAUNCH = {
  execPath: '/path/to/node',
  enginePath: '/ext/engine/engine.js',
  cwd: '/home/me',
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let fake: FakeEngineProcess;
let logs: string[];
let states: EngineState[];
let manager: EngineManager;

beforeEach(() => {
  fake = new FakeEngineProcess();
  logs = [];
  states = [];
  manager = new EngineManager({
    process: fake,
    bundledVersion: '0.0.1',
    paths: () => PATHS,
    launch: () => LAUNCH,
    log: (line) => logs.push(line),
  });
  manager.onStateChange((s) => states.push(s));
});

/** Drives a call that parks on the fake clock. */
async function withClock<T>(work: Promise<T>, ms: number): Promise<T> {
  await fake.advance(ms);
  return await work;
}

describe('MG-C1 no-second-engine', () => {
  it('adopts an engine that answers with the bundled version and spawns nothing', async () => {
    fake.probes = [identity({ pid: 77 })];
    const state = await manager.ensureRunning();
    expect(state).toEqual({ kind: 'running', version: '0.0.1', pid: 77, adopted: true });
    expect(fake.spawns).toHaveLength(0);
  });

  it('spawns exactly once for five triggers in one burst', async () => {
    fake.spawnedAnswer = identity();
    const calls = [1, 2, 3, 4, 5].map(() => manager.ensureRunning());
    const settled = await withClock(Promise.all(calls), 1_000);
    expect(fake.spawns).toHaveLength(1);
    expect(new Set(settled.map((s) => s.kind))).toEqual(new Set(['running']));
  });

  it('never spawns while the probe answers, whatever it answers', async () => {
    fake.probes = ['foreign'];
    expect((await manager.ensureRunning()).kind).toBe('foreign');
    fake.probes = [identity({ version: '9.9.9' })];
    expect((await manager.ensureRunning()).kind).toBe('mismatch');
    expect(fake.spawns).toHaveLength(0);
    expect(fake.signals).toHaveLength(0);
  });
});

describe('a probe that times out (unreachable)', () => {
  it('retries a transient timeout and adopts the engine that answers next', async () => {
    fake.probes = ['unreachable', identity({ pid: 77 })];
    const state = await withClock(manager.ensureRunning(), 1_000);
    expect(state).toEqual({ kind: 'running', version: '0.0.1', pid: 77, adopted: true });
    expect(fake.spawns).toHaveLength(0);
  });

  it('gives up as foreign only after three timeouts', async () => {
    fake.probes = ['unreachable'];
    const state = await withClock(manager.ensureRunning(), 1_000);
    expect(state).toEqual({ kind: 'foreign' });
    expect(fake.calls.filter((c) => c.kind === 'probe')).toHaveLength(3);
    expect(fake.spawns).toHaveLength(0);
  });

  it('re-probes on a user action rather than trusting the foreign state', async () => {
    fake.probes = ['unreachable'];
    expect((await withClock(manager.ensureRunning(), 1_000)).kind).toBe('foreign');

    fake.probes = [identity({ pid: 88 })];
    const state = await manager.ensureRunning('user');
    expect(state).toEqual({ kind: 'running', version: '0.0.1', pid: 88, adopted: true });
    expect(fake.spawns).toHaveLength(0);
  });
});

describe('starting an engine', () => {
  it('reports starting before the first poll and running on the first answer', async () => {
    fake.spawnedAnswer = identity();
    const running = manager.ensureRunning();
    await flush();
    expect(states.map((s) => s.kind)).toEqual(['starting']);
    const state = await withClock(running, 1_000);
    expect(state).toEqual({ kind: 'running', version: '0.0.1', pid: 4242, adopted: false });
  });

  it('resolves the login PATH, rotates the log, spawns, and only then polls (R30)', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(fake.order().slice(0, 5)).toEqual([
      'probe',
      'resolveLoginPath',
      'rotateLog',
      'spawnDetached',
      'probe',
    ]);
    expect(fake.rotations).toEqual([{ path: PATHS.engineLogPath, maxBytes: LOG_MAX_BYTES }]);
  });

  it('spawns the bundled engine against the configured core.json', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(fake.spawns[0]).toMatchObject({
      execPath: LAUNCH.execPath,
      args: [LAUNCH.enginePath, 'serve', '--config', PATHS.configPath],
      cwd: LAUNCH.cwd,
      logPath: PATHS.engineLogPath,
    });
  });

  it('gives the child the login shell PATH (R20)', async () => {
    fake.spawnedAnswer = identity();
    fake.loginPath = '/opt/homebrew/bin:/usr/bin';
    await withClock(manager.ensureRunning(), 1_000);
    expect(fake.spawns[0].env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(logs.filter((l) => l.startsWith('engine.path_fallback'))).toHaveLength(0);
  });

  it('falls back to this process PATH once, with one logged line (R20)', async () => {
    fake.loginPath = null;
    fake.nextPid = null; // fail fast so the burst can retry inside one test
    await manager.ensureRunning();
    expect(fake.spawns[0].env.PATH).toBeUndefined();
    fake.set(2_000);
    await manager.ensureRunning('user');
    expect(fake.spawns).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith('engine.path_fallback'))).toHaveLength(1);
  });

  it('fails with the log tail when the socket never answers, and does not respawn', async () => {
    const state = await withClock(manager.ensureRunning(), START_TIMEOUT_MS);
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain(PATHS.socketPath);
    expect(state.logTail).toEqual(fake.tail);
    expect(fake.calls.filter((c) => c.kind === 'logTail')[0].args[1]).toBe(TAIL_LINES);

    const again = await manager.ensureRunning();
    expect(again.kind).toBe('failed');
    expect(fake.spawns).toHaveLength(1);
  });

  it('fails immediately when the child reports no pid', async () => {
    fake.nextPid = null;
    const state = await manager.ensureRunning();
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain('no pid');
    expect(state.logTail).toEqual(fake.tail);
  });

  it('fails the moment the child exits, without waiting for a probe (R26)', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(manager.state().kind).toBe('running');
    expect(fake.spawns).toHaveLength(1);

    const before = fake.now();
    await fake.exit(1);
    expect(fake.now()).toBe(before);
    const state = manager.state();
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain('exited with code 1');
    expect(state.logTail).toEqual(fake.tail);
  });
});

describe('R26 respawn backoff', () => {
  async function failedSpawn(at: number, trigger: Trigger = 'auto'): Promise<void> {
    fake.set(at);
    await manager.ensureRunning(trigger);
  }

  beforeEach(() => {
    fake.nextPid = null; // every spawn fails immediately
  });

  it('refuses an automatic respawn inside 1 s, then 5 s, then 30 s, then for good', async () => {
    await failedSpawn(0);
    expect(fake.spawns).toHaveLength(1);

    await failedSpawn(500);
    expect(fake.spawns).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('engine.respawn_deferred'))).toHaveLength(1);

    await failedSpawn(1_500);
    expect(fake.spawns).toHaveLength(2);

    await failedSpawn(3_500);
    expect(fake.spawns).toHaveLength(2);
    await failedSpawn(7_500);
    expect(fake.spawns).toHaveLength(3);

    await failedSpawn(17_500);
    expect(fake.spawns).toHaveLength(3);
    await failedSpawn(38_500);
    expect(fake.spawns).toHaveLength(4);

    await failedSpawn(38_500 + 60_000);
    await failedSpawn(38_500 + 3_600_000);
    expect(fake.spawns).toHaveLength(4);
    expect(logs.some((l) => l.startsWith('engine.respawn_exhausted'))).toBe(true);
  });

  it('always lets the user start, and resets the backoff', async () => {
    await failedSpawn(0);
    await failedSpawn(1_500);
    await failedSpawn(7_500);
    await failedSpawn(38_500);
    expect(fake.spawns).toHaveLength(4);

    await failedSpawn(38_600, 'user');
    expect(fake.spawns).toHaveLength(5);

    await failedSpawn(38_700); // inside the reset 1 s gate
    expect(fake.spawns).toHaveLength(5);
    await failedSpawn(40_000);
    expect(fake.spawns).toHaveLength(6);
  });
});

describe('MG-C2 never-kill-what-we-cannot-prove', () => {
  it('signals nothing when there is no identity file', async () => {
    fake.probes = [identity()];
    fake.pidFiles = [null];
    const state = await manager.stop();
    expect(fake.signals).toHaveLength(0);
    expect(state.kind).toBe('failed');
  });

  it('signals nothing when the identity file and the socket name different pids', async () => {
    fake.probes = [identity({ pid: 1111 })];
    fake.pidFiles = [pidFile({ pid: 2222 })];
    await manager.stop();
    expect(fake.signals).toHaveLength(0);
  });

  it('signals nothing when the socket is silent', async () => {
    fake.probes = [null];
    fake.pidFiles = [pidFile()];
    await manager.stop();
    expect(fake.signals).toHaveLength(0);
  });

  it('signals nothing when the identity file names another socket', async () => {
    fake.probes = [identity()];
    fake.pidFiles = [pidFile({ socketPath: '/tmp/somewhere/else.sock' })];
    await manager.stop();
    expect(fake.signals).toHaveLength(0);
  });

  it('signals once when both agree, and polls until the socket goes quiet', async () => {
    fake.probes = [identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    const state = await withClock(manager.stop(), 1_000);
    expect(fake.signals).toEqual([{ pid: 4242, sig: 'SIGTERM' }]);
    expect(state).toEqual({ kind: 'stopped' });
  });

  it('proves ownership before it signals, never after (R29 order)', async () => {
    fake.probes = [identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    await withClock(manager.stop(), 1_000);
    expect(fake.order().slice(0, 5)).toEqual([
      'readPidFile',
      'probe',
      'readPidFile',
      'probe',
      'signal',
    ]);
  });

  it('never escalates a gone or foreign outcome', async () => {
    fake.probes = [identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    fake.signalOutcome = 'gone';
    expect((await manager.stop()).kind).toBe('stopped');
    expect(fake.signals).toHaveLength(1);

    const other = new EngineManager({
      process: fake,
      bundledVersion: '0.0.1',
      paths: () => PATHS,
      launch: () => LAUNCH,
      log: (line) => logs.push(line),
    });
    fake.probes = [identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    fake.signalOutcome = 'foreign';
    expect((await other.stop()).kind).toBe('failed');
    expect(fake.signals).toHaveLength(2);
  });
});

describe('R29 the proof is re-taken immediately before the signal', () => {
  it('aborts when the second pair names a different pid', async () => {
    fake.probes = [identity(), identity({ pid: 5555 })];
    fake.pidFiles = [pidFile(), pidFile({ pid: 5555 })];
    const state = await manager.stop();
    expect(fake.signals).toHaveLength(0);
    expect(state.kind).toBe('failed');
  });

  it('aborts when the pid is the same but the boot time is not (pid reuse)', async () => {
    const later = '2026-09-10T11:30:00.000Z';
    fake.probes = [identity(), identity({ startedAt: later })];
    fake.pidFiles = [pidFile(), pidFile({ startedAt: later })];
    const state = await manager.stop();
    expect(fake.signals).toHaveLength(0);
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain('nothing was signalled');
  });

  it('aborts when the second pair disagrees with itself', async () => {
    fake.probes = [identity(), identity({ pid: 7777 })];
    fake.pidFiles = [pidFile(), pidFile()];
    await manager.stop();
    expect(fake.signals).toHaveLength(0);
  });
});

describe('R23 the stop budget', () => {
  beforeEach(() => {
    fake.probes = [identity()]; // it keeps answering
    fake.pidFiles = [pidFile()];
  });

  it('becomes stopping past 45 s, with exactly one signal and no escalation', async () => {
    const stop = manager.stop();
    await fake.advance(45_000);
    const state = manager.state();
    expect(state.kind).toBe('stopping');
    if (state.kind !== 'stopping') throw new Error('unreachable');
    expect(state.pid).toBe(4242);
    expect(state.elapsedMs).toBeGreaterThanOrEqual(45_000);
    expect(fake.signals).toHaveLength(1);

    fake.probes = [null];
    await fake.advance(2_000);
    expect((await stop).kind).toBe('stopped');
    expect(fake.signals).toHaveLength(1);
  });

  it('reports the elapsed seconds while it waits', async () => {
    const stop = manager.stop();
    await fake.advance(50_000);
    const stopping = states.filter((s) => s.kind === 'stopping');
    expect(stopping.length).toBeGreaterThan(1);
    fake.probes = [null];
    await fake.advance(1_000);
    await stop;
  });

  it('goes quiet two minutes late and still ends stopped', async () => {
    const stop = manager.stop();
    await fake.advance(45_000 + 120_000);
    expect(manager.state().kind).toBe('stopping');
    fake.probes = [null];
    await fake.advance(1_000);
    expect((await stop).kind).toBe('stopped');
    expect(fake.signals).toHaveLength(1);
  });

  it('gives up at the five-minute bound with a reason naming the log', async () => {
    const stop = manager.stop();
    await fake.advance(45_000 + 300_000 + 1_000);
    const state = await stop;
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain(PATHS.engineLogPath);
    expect(fake.signals).toHaveLength(1);
  });
});

describe('the serial operation queue', () => {
  it('holds a triggered start behind an in-flight stop, and reports the two in order', async () => {
    // SIGTERM is sent but the socket keeps answering: the process has not exited yet, which is
    // exactly the window in which a concurrent `ensureRunning` used to adopt the dying engine.
    fake.probes = [identity()];
    fake.pidFiles = [pidFile()];
    const stop = manager.stop();
    const ensure = manager.ensureRunning('auto');

    await fake.advance(2_000);
    expect(fake.spawns).toHaveLength(0);
    expect(states.map((s) => s.kind)).toEqual([]);
    expect(fake.signals).toHaveLength(1);

    fake.probes = [null];
    fake.spawnedAnswer = identity({ pid: 99 });
    await fake.advance(2_000);

    expect(await stop).toEqual({ kind: 'stopped' });
    expect(await ensure).toEqual({ kind: 'running', version: '0.0.1', pid: 99, adopted: false });
    expect(fake.spawns).toHaveLength(1);
    expect(states.map((s) => s.kind)).toEqual(['stopped', 'starting', 'running']);
  });
});

describe('restart', () => {
  it('starts without a stop when nothing answers', async () => {
    fake.spawnedAnswer = identity();
    const state = await withClock(manager.restart(), 1_000);
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(1);
    expect(state.kind).toBe('running');
  });

  it('stops then starts when the engine is ours', async () => {
    fake.probes = [identity(), identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    fake.spawnedAnswer = identity();
    const state = await withClock(manager.restart(), 2_000);
    expect(fake.signals).toHaveLength(1);
    expect(fake.spawns).toHaveLength(1);
    expect(state.kind).toBe('running');
  });

  it('defers past a stopping engine and then spawns exactly once (R23)', async () => {
    fake.probes = [identity()];
    fake.pidFiles = [pidFile()];
    const restart = manager.restart();
    await fake.advance(45_000 + 60_000);
    expect(manager.state().kind).toBe('stopping');
    expect(fake.spawns).toHaveLength(0);

    fake.probes = [null];
    fake.spawnedAnswer = identity();
    const state = await withClock(restart, 2_000);
    expect(fake.spawns).toHaveLength(1);
    expect(state.kind).toBe('running');
  });

  it('aborts when the stop could not prove ownership', async () => {
    fake.probes = [identity()];
    fake.pidFiles = [null];
    const state = await manager.restart();
    expect(state.kind).toBe('failed');
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(0);
  });
});
