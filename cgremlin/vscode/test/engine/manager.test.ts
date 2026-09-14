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
import { BUNDLED_BUILD_TIME, FakeEngineProcess, identity, pidFile } from '../support/fake-engine-process';

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

/** What the bundled `bridge.js` would export beside the version — a content address (MG-C5). */
const BUNDLED_BUILD_ID = 'aaaaaaaaaaaaaaaa';
/** An engine built BEFORE this window's bundle, and one built after it. */
const OLDER = '2026-09-09T09:00:00.000Z';
const NEWER = '2026-09-11T09:00:00.000Z';

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
    bundledBuildId: BUNDLED_BUILD_ID,
    bundledBuildTime: BUNDLED_BUILD_TIME,
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
    fake.probes = [identity({ version: '9.9.9', buildTime: OLDER })];
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

  it('adopts the engine that answers the post-exit probe, without spawning a second child', async () => {
    // The race the finding describes: a *different* window's engine already holds the socket by
    // the time this window's own spawn dies, so the one probe `handleChildExit` now takes finds it
    // and adopts it rather than reporting a stale failure.
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(manager.state().kind).toBe('running');
    expect(fake.spawns).toHaveLength(1);
    const probesBefore = fake.calls.filter((c) => c.kind === 'probe').length;

    await fake.exit(1);
    expect(manager.state()).toEqual({ kind: 'running', version: '0.0.1', pid: 4242, adopted: true });
    expect(fake.spawns).toHaveLength(1); // no second child spawned
    expect(fake.calls.filter((c) => c.kind === 'probe').length).toBe(probesBefore + 1);
  });

  it('fails with the log tail when the post-exit probe finds nothing (R26)', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(manager.state().kind).toBe('running');
    expect(fake.spawns).toHaveLength(1);

    // Nothing is there any more: the one post-exit probe is asked and answers silence.
    fake.spawnedAnswer = undefined;
    fake.probes = [null];
    const before = fake.now();
    await fake.exit(1);
    expect(fake.now()).toBe(before); // a flat `null` answer needs no retry/sleep
    const state = manager.state();
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') throw new Error('unreachable');
    expect(state.reason).toContain('exited with code 1');
    expect(state.logTail).toEqual(fake.tail);
    expect(fake.spawns).toHaveLength(1);
  });

  it('never loops or retries beyond the single post-exit probe', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    fake.spawnedAnswer = undefined;
    fake.probes = ['unreachable']; // would retry up to PROBE_ATTEMPTS if this were a fresh ensure
    await withClock(fake.exit(1), 1_000);
    // probeOrRetry's own retry-on-timeout still applies (it is the *one* probe mechanism), but
    // nothing beyond it: the child is not respawned and no second post-exit probe follows.
    expect(fake.spawns).toHaveLength(1);
    expect(manager.state().kind).toBe('failed');
  });
});

describe('a child exit does not interleave with an in-flight stop', () => {
  it('queues the post-exit probe behind an in-flight stop, which wins', async () => {
    fake.spawnedAnswer = identity();
    await withClock(manager.ensureRunning(), 1_000);
    expect(manager.state().kind).toBe('running');
    states.length = 0;

    // The engine is genuinely being stopped: the socket still answers while SIGTERM is in flight.
    fake.spawnedAnswer = undefined;
    fake.probes = [identity()];
    fake.pidFiles = [pidFile()];
    const stop = manager.stop();
    await flush();

    // The child now exits (the very process the stop just signalled) while the stop is mid-flight.
    void fake.exit(0);
    await flush();

    fake.probes = [null];
    await fake.advance(2_000);
    expect(await stop).toEqual({ kind: 'stopped' });
    await flush();
    await flush();

    // The exit-handling was queued behind the stop, ran only after it settled, saw `stopped`
    // already decided, and took no action of its own: no `running` or `failed` ever appeared.
    expect(states.map((s) => s.kind)).toEqual(['stopped']);
    expect(manager.state()).toEqual({ kind: 'stopped' });
    expect(fake.spawns).toHaveLength(1);
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

  it('does not hold a successful spawn against the next automatic start (R21, R26)', async () => {
    // The bug C2 found against a real engine: after a *successful* start, an automatic start
    // moments later — R21's silent restart on a version mismatch, or a config save — was refused
    // by a gate only failed spawns are supposed to earn (and three of them exhausted it for good).
    fake.nextPid = 4_242;
    fake.probes = [null, identity()];
    expect((await withClock(manager.ensureRunning('auto'), 1_000)).kind).toBe('running');
    expect(fake.spawns).toHaveLength(1);

    // The clock now stands 900 ms after that spawn ended — inside the first 1 s gate.
    fake.probes = [null, identity()];
    expect((await withClock(manager.ensureRunning('auto'), 1_000)).kind).toBe('running');
    expect(fake.spawns).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith('engine.respawn_deferred'))).toHaveLength(0);
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
      bundledBuildId: BUNDLED_BUILD_ID,
    bundledBuildTime: BUNDLED_BUILD_TIME,
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

/**
 * R26's second belt, and the other half of the config-watcher flap.
 *
 * The backoff bounds spawns that *fail*. Nothing bounded restarts that *succeed* — and a trigger
 * that repeats (a watcher firing on its own chmod, a settings event that arrives twice) would
 * therefore stop and start one perfectly healthy engine over and over. An automatic restart is
 * now spent once per engine identity: the same pid and the same boot is refused with one line,
 * a person asking is never refused, and a genuinely different engine is restartable again.
 */
/**
 * MG-C5's second half: the same version can be two different engines.
 *
 * `ENGINE_VERSION` is the package's version, and it stayed `0.0.1` across Phases 8 and 9 while
 * the engine itself changed underneath it — so an upgrade was invisible to a handshake that
 * compared version strings, and the extension adopted a stale engine (no `/items`, four empty
 * lists) for as long as that engine kept running. The build id is a content address of the
 * bundle, and the handshake now compares both.
 */
describe('MG-C5: the handshake compares the build id as well as the version', () => {
  it('calls the same version with an OLDER build a mismatch', async () => {
    fake.probes = [identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER, pid: 77 })];
    const state = await manager.ensureRunning();
    expect(state).toMatchObject({ kind: 'mismatch', pid: 77 });
    expect(fake.spawns).toHaveLength(0);
  });

  it('treats an engine that reports no build id at all as a mismatch', async () => {
    fake.probes = [identity({ buildId: undefined, buildTime: undefined, pid: 78 })];
    expect((await manager.ensureRunning()).kind).toBe('mismatch');
  });

  it('adopts an engine whose version and build id both match', async () => {
    fake.probes = [identity({ pid: 79 })];
    expect(await manager.ensureRunning()).toEqual({
      kind: 'running',
      version: '0.0.1',
      pid: 79,
      adopted: true,
    });
  });

  it('restarts a same-version different-build engine exactly once when nothing is running', async () => {
    const stale = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER });
    // The stale engine answers the restart probe and both halves of the ownership proof, and the
    // socket is silent once it is gone.
    fake.probes = [stale, stale, stale, null];
    fake.pidFiles = [pidFile()];
    fake.signalOutcome = 'gone';
    fake.spawnedAnswer = identity();
    const state = await withClock(manager.restart('auto'), 2_000);
    expect(fake.signals).toHaveLength(1);
    expect(fake.spawns).toHaveLength(1);
    expect(state).toMatchObject({ kind: 'running' });
  });
});

/**
 * The restart ping-pong, and the ordering that ends it.
 *
 * A content address answers "is this my engine?" and nothing else: two windows on two builds
 * BOTH read "not mine", both restarted the engine, and every restart handed the other window a
 * brand-new identity — so the once-per-identity latch reset each round and the pair traded
 * SIGTERMs every 1.5 s for ever, each restart succeeding (`exited with code 0`, never a
 * "Another process is already listening").
 *
 * The build TIME orders them. Only the window whose bundle is strictly newer may replace the
 * engine; the one that is behind adopts it and asks to be reloaded, which is a thing the loop
 * cannot be built out of.
 */
describe('ordering by build time (the restart ping-pong)', () => {
  it('adopts an engine NEWER than this window and signals nothing', async () => {
    fake.probes = [identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: NEWER, pid: 77 })];
    const state = await manager.ensureRunning();
    expect(state).toMatchObject({ kind: 'outdated', pid: 77 });
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(0);
  });

  it('restarts an engine OLDER than this window exactly once', async () => {
    const older = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER });
    fake.pidFiles = [pidFile()];
    fake.signalOutcome = 'gone';
    fake.probes = [older];
    expect((await manager.ensureRunning()).kind).toBe('mismatch');

    fake.probes = [older, older, older, null];
    fake.spawnedAnswer = identity();
    const state = await withClock(manager.restart('auto'), 2_000);
    expect(state).toMatchObject({ kind: 'running' });
    expect(fake.signals).toHaveLength(1);
  });

  it('calls two builds stamped at the same moment one engine, and says so once', async () => {
    fake.probes = [identity({ buildId: 'bbbbbbbbbbbbbbbb', pid: 77 })];
    expect(await manager.ensureRunning()).toMatchObject({ kind: 'running', pid: 77 });
    await manager.ensureRunning();
    await manager.ensureRunning();
    expect(fake.signals).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith('engine.build_time_equal'))).toHaveLength(1);
  });

  /**
   * The whole bug, in one case: two windows on two different builds over ONE engine, ten rounds
   * of each of them probing and acting. Before the ordering this produced a SIGTERM per round,
   * for ever. Now the newer window replaces the engine once and the older one adopts what it
   * finds — and ten more rounds change nothing.
   */
  it('two windows on different builds trade exactly ONE restart over ten rounds', async () => {
    const engineBuild = { buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER };
    // One fake engine both managers see: it answers with whatever build last replaced it.
    let current = identity(engineBuild);
    fake.probes = [current];
    fake.pidFiles = [pidFile({ pid: current.pid, startedAt: current.startedAt })];
    fake.signalOutcome = 'gone';

    const makeManager = (buildId: string, buildTime: string): EngineManager =>
      new EngineManager({
        process: fake,
        bundledVersion: '0.0.1',
        bundledBuildId: buildId,
        bundledBuildTime: buildTime,
        paths: () => PATHS,
        launch: () => LAUNCH,
        log: (line) => logs.push(line),
      });

    // The window that just installed the new vsix, and the one still running the previous build.
    const fresh = makeManager(BUNDLED_BUILD_ID, BUNDLED_BUILD_TIME);
    const stale = makeManager('cccccccccccccccc', OLDER);

    let boots = 0;
    for (let round = 0; round < 10; round += 1) {
      for (const [who, mgr] of [
        ['fresh', fresh],
        ['stale', stale],
      ] as const) {
        const state = await withClock(mgr.ensureRunning('auto'), 1_000);
        if (state.kind !== 'mismatch') continue;
        // What the surface does with a mismatch and nothing running: restart, silently.
        boots += 1;
        // The replacement is the build the restarting window ships, and it answers from now on.
        current = identity({
          buildId: who === 'fresh' ? BUNDLED_BUILD_ID : 'cccccccccccccccc',
          buildTime: who === 'fresh' ? BUNDLED_BUILD_TIME : OLDER,
          pid: 5000 + boots,
          startedAt: `2026-09-10T1${boots}:00:00.000Z`,
        });
        fake.probes = [current];
        fake.pidFiles = [pidFile({ pid: current.pid, startedAt: current.startedAt })];
        fake.spawnedAnswer = current;
        await withClock(mgr.restart('auto'), 2_000);
      }
    }

    expect(boots).toBe(1);
    expect(fake.signals).toHaveLength(1);
    expect(fresh.state().kind).toBe('running');
    expect(stale.state().kind).toBe('outdated');
  });
});

describe("engineStartedAt (R26b's cross-window freshness check)", () => {
  it('answers the identity probe reports', async () => {
    fake.probes = [identity({ startedAt: '2026-03-01T00:00:00.000Z' })];
    expect(await manager.engineStartedAt()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('is null when nothing answers, and null for a foreign socket', async () => {
    fake.probes = [null];
    expect(await manager.engineStartedAt()).toBeNull();
    fake.probes = ['unreachable', 'unreachable', 'unreachable'];
    expect(await withClock(manager.engineStartedAt(), 1_000)).toBeNull();
  });
});

/**
 * A second window's manager never needs the freshness check to see that a mismatch is already
 * fixed: `classify()` reads the *current* probe, so once the engine both windows share has been
 * restarted onto the bundled version and build id, a second manager's own `ensureRunning()`
 * reports `running`, never `mismatch` — there is nothing left for it to restart.
 */
describe('a second manager sees a mismatch already fixed as running, not mismatch', () => {
  it('classifies the restarted engine as running for a manager that never restarted it itself', async () => {
    const stale = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER });
    fake.probes = [stale, stale, stale, null];
    fake.pidFiles = [pidFile()];
    fake.signalOutcome = 'gone';
    fake.spawnedAnswer = identity(); // the bundled version and build id, once the restart lands
    const restarted = await withClock(manager.restart('auto'), 2_000);
    expect(restarted).toMatchObject({ kind: 'running' });

    const other = new EngineManager({
      process: fake,
      bundledVersion: '0.0.1',
      bundledBuildId: BUNDLED_BUILD_ID,
    bundledBuildTime: BUNDLED_BUILD_TIME,
      paths: () => PATHS,
      launch: () => LAUNCH,
      log: (line) => logs.push(line),
    });
    const state = await other.ensureRunning('auto');
    expect(state).toMatchObject({ kind: 'running' });
    expect(fake.signals).toHaveLength(1); // `other` never signalled anything itself
  });
});

describe('an automatic restart is spent once per engine identity', () => {
  /** A restart whose stop is over immediately, so the engine that answers afterwards is the same. */
  function sameEngineThroughout(who = identity()): void {
    fake.probes = [who];
    fake.pidFiles = [pidFile({ pid: who.pid, startedAt: who.startedAt })];
    fake.signalOutcome = 'gone';
  }

  it('refuses a second automatic restart against the same pid and boot, and says so once', async () => {
    sameEngineThroughout();
    expect((await withClock(manager.restart('auto'), 1_000)).kind).toBe('running');
    expect(fake.signals).toHaveLength(1);

    expect((await withClock(manager.restart('auto'), 1_000)).kind).toBe('running');
    expect(fake.signals).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('engine.auto_restart_refused'))).toHaveLength(1);
  });

  it('never refuses a person', async () => {
    sameEngineThroughout();
    await withClock(manager.restart('auto'), 1_000);
    await withClock(manager.restart('auto'), 1_000);
    expect(fake.signals).toHaveLength(1);

    await withClock(manager.restart('user'), 1_000);
    await withClock(manager.restart('user'), 1_000);
    expect(fake.signals).toHaveLength(3);
  });

  it('restarts again automatically once the engine is a different one', async () => {
    sameEngineThroughout();
    await withClock(manager.restart('auto'), 1_000);
    await withClock(manager.restart('auto'), 1_000);
    expect(fake.signals).toHaveLength(1);

    sameEngineThroughout(identity({ pid: 5_150, startedAt: '2026-09-10T11:00:00.000Z' }));
    await withClock(manager.restart('auto'), 1_000);
    expect(fake.signals).toHaveLength(2);
    expect(fake.signals.at(-1)?.pid).toBe(5_150);
  });

  it('restarts again automatically when only the boot time is new (a reused pid)', async () => {
    sameEngineThroughout();
    await withClock(manager.restart('auto'), 1_000);
    sameEngineThroughout(identity({ startedAt: '2026-09-10T12:00:00.000Z' }));
    await withClock(manager.restart('auto'), 1_000);
    expect(fake.signals).toHaveLength(2);
  });

  it('does not spend the identity on a stop that never proved ownership, so the next auto trigger tries again', async () => {
    // The engine answers the restart probe, but its identity file is gone by the time the stop
    // tries to prove ownership — the stop fails and nothing is ever signalled.
    const who = identity();
    fake.probes = [who];
    fake.pidFiles = [null];
    const first = await withClock(manager.restart('auto'), 1_000);
    expect(first.kind).toBe('failed');
    expect(fake.signals).toHaveLength(0);

    // Nothing was latched: the same identity gets a second attempt, not a refusal.
    fake.probes = [who];
    fake.pidFiles = [null];
    const second = await withClock(manager.restart('auto'), 1_000);
    expect(second.kind).toBe('failed');
    expect(fake.calls.filter((c) => c.kind === 'readPidFile')).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith('engine.auto_restart_refused'))).toHaveLength(0);
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

/**
 * The engine can say no, and that is what finally ends the ping-pong.
 *
 * Ordering by build time keeps a window that HAS the ordering from fighting. It does nothing
 * about a window still running the previous extension in memory: that code restarts on any build
 * mismatch, and a SIGTERM cannot be refused, so the pair traded restarts until every window was
 * reloaded. So the stop stops being a signal: the manager ASKS (`POST /shutdown`, carrying its own
 * build time, build id and the trigger's reason) and the engine decides. A signal is left for the
 * one case a request cannot cover — an engine that no longer answers its socket at all.
 */
describe('R-shutdown: stopping is a request the engine may refuse', () => {
  it('asks before it signals, and signals nothing at all when the engine accepts', async () => {
    fake.shutdownOutcome = { kind: 'accepted' };
    fake.probes = [null]; // the engine goes quiet on its own, the way close() does
    fake.pidFiles = [pidFile()];
    const state = await withClock(manager.stop('user'), 1_000);
    expect(state).toEqual({ kind: 'stopped' });
    expect(fake.signals).toHaveLength(0);
    expect(fake.shutdowns).toEqual([
      {
        requesterBuildTime: BUNDLED_BUILD_TIME,
        requesterBuildId: BUNDLED_BUILD_ID,
        reason: 'user',
      },
    ]);
  });

  it('a new window over an old engine: one request, no signal, and the restart goes through', async () => {
    const old = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: OLDER });
    fake.probes = [old, null];
    fake.pidFiles = [pidFile()];
    fake.shutdownOutcome = { kind: 'accepted' };
    fake.spawnedAnswer = identity();
    const state = await withClock(manager.restart('auto'), 2_000);
    expect(state).toMatchObject({ kind: 'running' });
    expect(fake.shutdowns.map((s) => s.reason)).toEqual(['restart']);
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(1);
  });

  it('an old window over a new engine: refused, adopted as outdated, and nothing is signalled', async () => {
    const newer = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: NEWER, pid: 77 });
    fake.probes = [newer];
    fake.pidFiles = [pidFile()];
    fake.shutdownOutcome = {
      kind: 'refused',
      reason: 'engine is newer than the requester',
      engineBuildTime: NEWER,
    };
    const state = await manager.stop('auto');
    expect(state).toMatchObject({ kind: 'outdated', pid: 77 });
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(0);
    expect(logs.filter((l) => l.startsWith('engine.shutdown_refused'))).toHaveLength(1);
  });

  it('a refused restart neither stops nor starts anything', async () => {
    const newer = identity({ buildId: 'bbbbbbbbbbbbbbbb', buildTime: NEWER, pid: 77 });
    fake.probes = [newer];
    fake.pidFiles = [pidFile()];
    fake.shutdownOutcome = {
      kind: 'refused',
      reason: 'engine is newer than the requester',
      engineBuildTime: NEWER,
    };
    const state = await manager.restart('auto');
    expect(state).toMatchObject({ kind: 'outdated' });
    expect(fake.signals).toHaveLength(0);
    expect(fake.spawns).toHaveLength(0);
  });

  it('falls back to the two-part proof and ONE signal only when the route does not answer', async () => {
    fake.shutdownOutcome = { kind: 'unavailable', detail: 'nothing answered' };
    fake.probes = [identity(), identity(), null];
    fake.pidFiles = [pidFile()];
    const state = await withClock(manager.stop('user'), 1_000);
    expect(state).toEqual({ kind: 'stopped' });
    expect(fake.signals).toEqual([{ pid: 4242, sig: 'SIGTERM' }]);
    expect(fake.order().slice(0, 6)).toEqual([
      'requestShutdown',
      'readPidFile',
      'probe',
      'readPidFile',
      'probe',
      'signal',
    ]);
  });

  it("names the trigger: 'user' for a person, 'restart'/'stop' for the window itself", async () => {
    fake.shutdownOutcome = { kind: 'accepted' };
    fake.probes = [null];
    fake.pidFiles = [pidFile()];
    await withClock(manager.stop('auto'), 1_000);
    await withClock(manager.stop('user'), 1_000);
    fake.probes = [identity()];
    fake.spawnedAnswer = identity();
    await withClock(manager.restart('auto'), 2_000);
    await withClock(manager.restart('user'), 2_000);
    expect(fake.shutdowns.map((s) => s.reason)).toEqual(['stop', 'user', 'restart', 'user']);
  });
});
