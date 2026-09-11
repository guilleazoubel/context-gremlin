/**
 * Integration: two windows, one real engine, and a storm of `chmod` events on `core.json`.
 *
 * This is the flap, reproduced end to end on the shipping path — the real `EngineSurface`, the
 * real `watchFileByRename`, the real `EngineManager` and `NodeEngineProcess`, and the real engine
 * bundle on a real Unix socket in a throwaway state dir.
 *
 * The bug: the surface chmodded the watched file after every event, and on macOS a `chmod` of a
 * watched file is itself an event for it — so each window fed itself (chmod -> event -> validate
 * -> chmod -> restart, `activeRuns` 0) at the period of one engine restart. Two windows
 * phase-locked into paired SIGTERMs, spawn races, and the loser's `SocketInUseError`
 * ("Another process is already listening...") in the engine log.
 *
 * What is asserted is therefore what reached the machine: how many SIGTERMs two windows sent
 * between them, how many engines exist afterwards, and whether the engine log carries the
 * loser of a spawn race.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { watchFileByRename } from '../../src/engine/file-watch';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import { EngineSurface } from '../../src/ui/engine';
import type { DisposableLike } from '../../src/ui/host';
import type { SignalOutcome } from '../../src/engine/manager';
import { FakeHost } from '../support/fake-host';
import {
  coreIsBuilt,
  createManager,
  ENGINE_BUNDLE,
  loadEngineBridge,
  readEngineLog,
  seedStateDir,
  sleep,
  waitForGone,
  waitUntil,
  type SeededStateDir,
} from '../support/core-harness';

const TIMEOUT = 60_000;
/** The debounce, shortened so a storm resolves inside the test rather than inside the minute. */
const DEBOUNCE_MS = 30;
/** The wording R22's loser writes into the engine log. */
const SOCKET_IN_USE = 'Another process is already listening';

/**
 * The editor surface a window really has for the two members this test is about: a filesystem
 * that is the actual filesystem, and timers that are actually timers. Everything else — the
 * popups, the output channel, the command registry — is the recording fake, which is what makes
 * "was anything asked of the user?" answerable.
 */
class RealFsHost extends FakeHost {
  private readonly handles: DisposableLike[] = [];

  fileExists(target: string): boolean {
    return existsSync(target);
  }

  fileSize(target: string): number {
    try {
      return statSync(target).size;
    } catch {
      return 0;
    }
  }

  readFileSlice(target: string, from: number): { text: string; end: number } {
    try {
      const buffer = readFileSync(target);
      return { text: buffer.subarray(Math.min(from, buffer.byteLength)).toString('utf8'), end: buffer.byteLength };
    } catch {
      return { text: '', end: from };
    }
  }

  fileDigest(target: string): string | null {
    try {
      return createHash('sha256').update(readFileSync(target)).digest('hex');
    } catch {
      return null;
    }
  }

  fileMode(target: string): number | null {
    try {
      return statSync(target).mode & 0o777;
    } catch {
      return null;
    }
  }

  async chmod(target: string, mode: number): Promise<void> {
    this.calls.push({ kind: 'chmod', args: [target, mode] });
    chmodSync(target, mode);
  }

  watchFile(target: string, callback: () => void): DisposableLike {
    const handle = watchFileByRename(target, callback);
    this.handles.push(handle);
    return handle;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = globalThis.setTimeout(callback, ms);
    return () => globalThis.clearTimeout(timer);
  }

  disposeWatches(): void {
    for (const handle of this.handles.splice(0)) handle.dispose();
  }
}

/** A real port that counts the one call this test is about. */
class CountingProcess extends NodeEngineProcess {
  sigterms = 0;

  signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    this.sigterms += 1;
    return super.signal(pid, sig);
  }
}

interface Window {
  host: RealFsHost;
  surface: EngineSurface;
  process: CountingProcess;
}

/** How many engine processes exist for this state dir — `--config` makes the match unique. */
function engineProcessCount(configPath: string): number {
  try {
    return execFileSync('pgrep', ['-f', configPath], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '').length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

async function enginePid(seed: SeededStateDir): Promise<number | null> {
  const probe = await new NodeEngineProcess().probe(seed.socketPath);
  return probe === null || typeof probe === 'string' ? null : probe.pid;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, TIMEOUT);

describe.skipIf(!coreIsBuilt())('integration: a config chmod storm across two windows', () => {
  /** One window, wired the way `extension.ts` wires one. */
  function openWindow(seed: SeededStateDir): Window {
    const host = new RealFsHost();
    const process_ = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    const manager = createManager(seed, { process: process_ });
    const surface = new EngineSurface({
      host,
      manager,
      bridge: loadEngineBridge(),
      configPath: () => seed.configPath,
      home: seed.stateDir,
      execPath: globalThis.process.execPath,
      // Only reached by the first-run `config init`, which a seeded state dir never needs.
      enginePath: ENGINE_BUNDLE,
      resolveLoginPath: async () => null,
      reconnect: async () => undefined,
      debounceMs: DEBOUNCE_MS,
    });
    cleanups.push(async () => {
      surface.dispose();
      host.disposeWatches();
      await surface.settled();
    });
    return { host, surface, process: process_ };
  }

  async function twoWindows(): Promise<{ seed: SeededStateDir; windows: Window[] }> {
    const seed = await seedStateDir();
    cleanups.push(async () => {
      await rm(seed.stateDir, { recursive: true, force: true });
    });
    const first = openWindow(seed);
    // The first window starts the engine; the second adopts it (MG-C1).
    await first.surface.bootstrap();
    const second = openWindow(seed);
    await second.surface.bootstrap();
    cleanups.push(async () => {
      const stopper = createManager(seed);
      await stopper.stop();
      await waitForGone(seed.socketPath, 'the socket file', 15_000).catch(() => undefined);
    });
    expect(await enginePid(seed)).not.toBeNull();
    expect(engineProcessCount(seed.configPath)).toBe(1);
    return { seed, windows: [first, second] };
  }

  it(
    'sends no signal at all for a chmod storm, and leaves no spawn race in the log',
    async () => {
      const { seed, windows } = await twoWindows();
      const pid = await enginePid(seed);

      // The storm: the mode is re-asserted over and over, which is exactly what the old surface
      // did to itself. Each one is a `rename core.json` event in both windows.
      for (let i = 0; i < 25; i += 1) {
        chmodSync(seed.configPath, 0o600);
        await sleep(5);
      }
      // Well past the debounce, and past several restarts' worth of time had any started.
      await sleep(500);
      for (const window of windows) await window.surface.settled();

      expect(windows.map((w) => w.process.sigterms)).toEqual([0, 0]);
      // The engine is untouched: same pid, same single process, and nothing lost a spawn race.
      expect(await enginePid(seed)).toBe(pid);
      expect(engineProcessCount(seed.configPath)).toBe(1);
      expect(readEngineLog(seed.engineLogPath)).not.toContain(SOCKET_IN_USE);
      // And the mode is still what it must be, which is why the storm was pointless.
      expect(statSync(seed.configPath).mode & 0o777).toBe(0o600);
    },
    TIMEOUT,
  );

  /**
   * The other half of the picture, pinned so the boundary of the fix is on the record.
   *
   * A *genuine* save is a real reason to restart, and every window sees it — so two windows still
   * cost two restarts, one each, because each window owns its own manager and neither can know
   * the other has already acted. What the fix guarantees is that neither of them restarts twice,
   * that the storm of chmod events riding along with the save adds nothing, and that MG-C1 still
   * holds: whoever loses the resulting spawn race is ADOPTED, never left running as a second
   * engine. (Making this one restart in total would take a cross-window handshake — the engine
   * recording which config digest it booted with, so a window whose save the running engine has
   * already loaded skips the restart. That is not this change.)
   */
  it(
    'restarts once per window for a real save, and the storm riding along adds nothing',
    async () => {
      const { seed, windows } = await twoWindows();
      const before = await enginePid(seed);
      const config = JSON.parse(readFileSync(seed.configPath, 'utf8')) as Record<string, unknown>;

      // One genuine save — and then the storm the save's own chmod used to start.
      writeFileSync(seed.configPath, JSON.stringify({ ...config, pollIntervalMs: 900_000 }), {
        mode: 0o644,
      });
      for (let i = 0; i < 15; i += 1) {
        chmodSync(seed.configPath, 0o600);
        await sleep(5);
      }
      await sleep(500);
      for (const window of windows) await window.surface.settled();
      await waitUntil(() => enginePid(seed), (pid) => pid !== null, {
        timeoutMs: 20_000,
        what: 'the engine to answer on its socket again',
      });
      for (const window of windows) await window.surface.settled();

      // One restart per window, never two — the storm contributed nothing to either count.
      for (const window of windows) expect(window.process.sigterms).toBeLessThanOrEqual(1);
      expect(windows.reduce((total, w) => total + w.process.sigterms, 0)).toBeLessThanOrEqual(
        windows.length,
      );
      // The save took effect, and exactly one engine survived it whatever raced (MG-C1).
      expect(await enginePid(seed)).not.toBe(before);
      expect(engineProcessCount(seed.configPath)).toBe(1);
      for (const window of windows) {
        expect(window.surface.health().kind).not.toBe('foreign');
      }
      expect(statSync(seed.configPath).mode & 0o777).toBe(0o600);
    },
    TIMEOUT,
  );
});
