/**
 * Integration: two windows on two REAL builds over one REAL engine, and nothing gets signalled.
 *
 * This is the case the whole shutdown route exists for. Before it, ordering by build time kept a
 * window that HAD the ordering from fighting — but a window still running the previous extension
 * in memory restarted on any build mismatch, and a SIGTERM cannot be refused: the pair traded
 * restarts every 1.5 s until every window was reloaded. Now the stop is a REQUEST. The engine
 * compares build times and answers, and the window that is behind is told so.
 *
 * Both builds here are genuine: the second is the shipping `engine.js` with a different build id
 * and a later build time stamped into it, spawned for real, answering `GET /version` for real.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import type { ShutdownOutcome, ShutdownRequestBody, SignalOutcome } from '../../src/engine/manager';
import {
  coreIsBuilt,
  createManager,
  ENGINE_BUNDLE,
  loadEngineBridge,
  readEngineLog,
  seedStateDir,
  sleep,
  waitUntil,
} from '../support/core-harness';

const TIMEOUT = 90_000;
/** The window the two windows are left arguing for, if they are going to argue at all. */
const ROUNDS = 10;

/** A real port that counts what actually reached the machine, and what was merely asked. */
class CountingProcess extends NodeEngineProcess {
  sigterms = 0;
  readonly asked: ShutdownRequestBody[] = [];

  override signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    this.sigterms += 1;
    return super.signal(pid, sig);
  }

  override async requestShutdown(
    socketPath: string,
    body: ShutdownRequestBody,
  ): Promise<ShutdownOutcome> {
    this.asked.push(body);
    return await super.requestShutdown(socketPath, body);
  }
}

function engineProcessCount(configPath: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', configPath], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

/** Every `{"type": ...}` line the engine(s) wrote, in order. */
function engineEvents(logPath: string): { type: string }[] {
  return readEngineLog(logPath)
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { type: string }];
      } catch {
        return [];
      }
    });
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, TIMEOUT);

describe.skipIf(!coreIsBuilt())('integration: one engine, two windows, zero signals', () => {
  /**
   * The shipping bundle with a different build id and a LATER build time stamped in — an upgrade,
   * as the machine sees it: same code, a build the running engine is genuinely older than.
   */
  async function newerBundle(): Promise<{ enginePath: string; buildId: string; buildTime: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'cg-newer-engine-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const enginePath = path.join(dir, 'engine.js');
    await copyFile(ENGINE_BUNDLE, enginePath);
    const bridge = loadEngineBridge();
    const buildId = 'newerbuildid00000';
    const buildTime = new Date(Date.now() + 600_000).toISOString();
    const source = await readFile(enginePath, 'utf8');
    const stamped = source
      .split(JSON.stringify(bridge.ENGINE_BUILD_ID))
      .join(JSON.stringify(buildId))
      .split(JSON.stringify(bridge.ENGINE_BUILD_TIME))
      .join(JSON.stringify(buildTime));
    expect(stamped).not.toBe(source);
    await writeFile(enginePath, stamped, 'utf8');
    return { enginePath, buildId, buildTime };
  }

  it('the newer window replaces the engine once; the older one is refused and ends outdated', async () => {
    const seed = await seedStateDir();
    const newer = await newerBundle();
    const bridge = loadEngineBridge();

    // The window that just installed the new vsix, and the window still running the old one.
    const freshPort = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    const stalePort = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    const fresh = createManager(seed, {
      process: freshPort,
      enginePath: newer.enginePath,
      bundledBuildId: newer.buildId,
      bundledBuildTime: newer.buildTime,
    });
    const stale = createManager(seed, { process: stalePort });
    cleanups.push(async () => {
      // A person asking is honoured whatever the build order says — including by the newer engine.
      await fresh.stop('user');
      await rm(seed.stateDir, { recursive: true, force: true });
    });

    // The engine the old window started: the shipping build, which the new window is newer than.
    expect((await stale.ensureRunning('user')).kind).toBe('running');
    expect(engineProcessCount(seed.configPath)).toBe(1);

    const started = Date.now();
    for (let round = 0; round < ROUNDS && Date.now() - started < 30_000; round += 1) {
      // What the surface does with a mismatch and nothing running: restart, silently.
      if ((await fresh.ensureRunning('auto')).kind === 'mismatch') await fresh.restart('auto');
      await stale.ensureRunning('auto');
      // …and what a window running PRE-ordering code does, every time: restart regardless. The
      // engine is what stops it now, because a request is a thing that can be answered `no`.
      await stale.restart('auto');
      await sleep(100);
    }

    // The machine: one engine, and not one signal between the two windows.
    expect(engineProcessCount(seed.configPath)).toBe(1);
    expect(freshPort.sigterms).toBe(0);
    expect(stalePort.sigterms).toBe(0);

    // The engines' own account of it: exactly one accepted stop, and the rest refused.
    const events = engineEvents(seed.engineLogPath);
    expect(events.filter((e) => e.type === 'shutdown.accepted')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'shutdown.refused').length).toBeGreaterThanOrEqual(
      ROUNDS - 1,
    );
    expect(events.filter((e) => e.type === 'signal')).toHaveLength(0);

    // The window that is behind is told the one thing that fixes it, and keeps using the engine.
    expect(stale.state()).toMatchObject({ kind: 'outdated' });
    expect(fresh.state()).toMatchObject({ kind: 'running' });
    expect(stalePort.asked.every((a) => a.requesterBuildTime === bridge.ENGINE_BUILD_TIME)).toBe(
      true,
    );

    // …and the engine that is up really is the newer build, not the one the old window started.
    const version = await waitUntil(
      async () => await new NodeEngineProcess().probe(seed.socketPath),
      (probe) => probe !== null && typeof probe !== 'string',
      { what: 'the newer engine to answer GET /version' },
    );
    expect(version).toMatchObject({ buildId: newer.buildId, buildTime: newer.buildTime });
  }, TIMEOUT);
});
