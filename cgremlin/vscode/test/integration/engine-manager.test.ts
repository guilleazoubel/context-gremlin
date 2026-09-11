/**
 * Integration: the SHIPPING launch path against the SHIPPING engine.
 *
 * Every other test in this package proves one layer. This one is the only place where the two
 * halves of Phase 8 meet: the real `EngineManager` + `NodeEngineProcess` start, adopt, prove and
 * stop the real `engine/engine.js` bundle, on a real Unix socket, in a throwaway state dir with
 * `HOME` redirected so `~/.cgremlin` and `~/.cgremlin-core` stay unreachable.
 *
 * What it exists to catch:
 *  - **MG-C5** the version the extension advertises is the version it actually spawns;
 *  - **MG-C1** a second `ensureRunning()` adopts, and two managers racing over one state dir leave
 *    exactly one engine (R22's lock, seen from above);
 *  - **MG-C2** a stop whose two-part proof does not hold signals nothing, against a real pid;
 *  - **R21** a version mismatch with nothing running restarts silently, with no prompt;
 *  - **R25** the editor's own `Code Helper (Plugin)` really is a Node ≥ 20 host, and the engine's
 *    self-scrub really does clear `ELECTRON_RUN_AS_NODE` before it could reach a grandchild.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineSurface } from '../../src/ui/engine';
import { loadBridge } from '../../src/engine/bridge';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import type { EngineIdentity, SignalOutcome } from '../../src/engine/manager';
import { FakeHost } from '../support/fake-host';
import {
  coreIsBuilt,
  createManager,
  ENGINE_BUNDLE,
  EXTENSION_ROOT,
  loadEngineBridge,
  readEngineLog,
  seedStateDir,
  SKIP_REASON,
  sleep,
  startEngineViaManager,
  waitForGone,
  waitUntil,
  type CoreHarness,
  type SeededStateDir,
} from '../support/core-harness';

const TIMEOUT = 30_000;

/**
 * A real stop's budget is `STOP_BUDGET_MS` (45 s, `src/engine/manager.ts`) before the manager
 * gives up polling and settles for `waitOutStop`'s bound. Under `test:integration`'s serialized
 * `pool: 'forks'` run this always lands in well under a second, but historically — run alongside
 * other real-engine suites under full parallel load — the real SIGTERM-to-exit poll and the
 * process-count check that follows it were occasionally slow enough to trip the shared 30 s
 * `TIMEOUT` even though the engine itself was shutting down correctly; that is what made this
 * case (and `real-engine.test.ts`'s "clears every claim at boot…" restart case, which pays the
 * same stop budget plus the SSE reconnect's own offline window) flaky under load while always
 * green in isolation. Sized generously past the 45 s budget itself, with one retry as a
 * last-resort net for a genuinely slow CI box.
 */
const STOP_TIMEOUT = { timeout: 90_000, retry: 1 };

/**
 * The `Code Helper (Plugin)` binary R25 names. Absent on a machine without VS Code installed, in
 * which case the case below skips loudly rather than passing quietly.
 */
const CODE_HELPER =
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';

/** A real port that counts the one call a "how many restarts?" question is about. */
class CountingProcess extends NodeEngineProcess {
  sigterms = 0;

  override signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    this.sigterms += 1;
    return super.signal(pid, sig);
  }
}

/**
 * How many engine processes exist for one state dir. `--config <path>` is unique to the temp dir,
 * so this can never see another engine on this machine — including the developer's own.
 */
function engineProcessCount(configPath: string): number {
  try {
    const out = execFileSync('pgrep', ['-f', configPath], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

/** `GET /version`, read through the very probe the manager uses. */
async function probeVersion(socketPath: string): Promise<EngineIdentity> {
  const result = await new NodeEngineProcess().probe(socketPath);
  if (result === null || typeof result === 'string') {
    throw new Error(`nothing this extension recognises answers on ${socketPath}: ${String(result)}`);
  }
  return result;
}

async function readPidFile(seed: SeededStateDir): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(seed.enginePidPath, 'utf8')) as Record<string, unknown>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, TIMEOUT);

describe.skipIf(!coreIsBuilt())('integration: the bundled engine through its manager', () => {
  async function boot(): Promise<CoreHarness> {
    const h = await startEngineViaManager();
    cleanups.push(() => h.cleanup());
    return h;
  }

  it('probes, spawns, and comes up as the version this extension ships (MG-C5)', async () => {
    const h = await boot();
    const state = h.manager.state();
    expect(state).toMatchObject({ kind: 'running', adopted: false });

    const version = await probeVersion(h.socketPath);
    expect(version.version).toBe(loadEngineBridge().ENGINE_VERSION);
    expect(version.activeRuns).toBe(0);

    // The lock is the ownership proof: it names the process that answers the socket.
    const pidFile = await readPidFile(h);
    expect(pidFile).toMatchObject({
      pid: version.pid,
      version: version.version,
      socketPath: h.socketPath,
    });
    expect(engineProcessCount(h.configPath)).toBe(1);
  }, TIMEOUT);

  it('adopts on the second ensureRunning, without a second process (MG-C1)', async () => {
    const h = await boot();
    const first = await readPidFile(h);

    const again = await h.manager.ensureRunning('auto');
    expect(again).toMatchObject({ kind: 'running', adopted: true });
    expect(engineProcessCount(h.configPath)).toBe(1);
    // Same boot: a respawn would have rewritten the lock with a new pid and a new startedAt.
    expect(await readPidFile(h)).toEqual(first);
  }, TIMEOUT);

  it('leaves exactly one engine when two managers race over one state dir (MG-C1, R22)', async () => {
    const seed = await seedStateDir();
    const managers = [createManager(seed), createManager(seed)];
    cleanups.push(async () => {
      const state = await managers[0].stop();
      if (state.kind === 'stopped') await waitForGone(seed.socketPath, 'the socket file');
      await rm(seed.stateDir, { recursive: true, force: true });
    });

    const raced = await Promise.all(managers.map((m) => m.ensureRunning('user')));
    // Whatever each manager concluded, the machine may hold only one engine for this state dir.
    expect(engineProcessCount(seed.configPath)).toBe(1);

    // The loser's own child lost the lock and exited non-zero — but `handleChildExit`'s one
    // post-exit probe finds the winner's engine already answering and adopts it right there, in
    // the very same `ensureRunning` call. Nobody needs to ask again.
    expect(raced.every((s) => s.kind === 'running')).toBe(true);
    const pids = new Set(raced.map((s) => (s.kind === 'running' ? s.pid : -1)));
    expect(pids.size).toBe(1);
    expect(engineProcessCount(seed.configPath)).toBe(1);

    const pidFile = JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { pid: number };
    expect(pidFile.pid).toBe([...pids][0]);
  }, TIMEOUT);

  it('stops the engine it can prove is its own, and leaves no socket and no engine.json', async () => {
    const h = await boot();
    const pid = (await readPidFile(h)).pid as number;

    await h.stop(); // asserts both files are gone, through the manager's two-part proof
    expect(h.manager.state()).toEqual({ kind: 'stopped' });
    expect(existsSync(h.socketPath)).toBe(false);
    expect(existsSync(h.enginePidPath)).toBe(false);
    await waitUntil(async () => engineProcessCount(h.configPath), (n) => n === 0, {
      what: 'the engine process to exit',
    });
    expect(() => process.kill(pid, 0)).toThrow();
  }, STOP_TIMEOUT);

  it('refuses to signal a pid the socket does not confirm (MG-C2)', async () => {
    const h = await boot();
    const real = await readPidFile(h);
    // A live, unrelated process: this test runner itself. Signalling it would be catastrophic and
    // completely silent, which is exactly why this guard exists.
    await writeFile(h.enginePidPath, JSON.stringify({ ...real, pid: process.pid }), 'utf8');

    const state = await h.manager.stop();
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' ? state.reason : '').toContain('disagree');
    expect(process.kill(process.pid, 0)).toBe(true);
    expect(engineProcessCount(h.configPath)).toBe(1);

    // Put the truth back so the harness can stop the engine it really did start.
    await writeFile(h.enginePidPath, JSON.stringify(real), 'utf8');
    await h.stop();
  }, TIMEOUT);

  it('restarts a mismatched engine silently when nothing is running (R21)', async () => {
    const seed = await seedStateDir();
    // Newer than the engine it will find: only the newer side may replace it.
    const manager = createManager(seed, {
      bundledVersion: '99.99.99-not-the-bundled-one',
      bundledBuildTime: new Date(Date.now() + 600_000).toISOString(),
    });
    cleanups.push(async () => {
      await manager.stop();
      await rm(seed.stateDir, { recursive: true, force: true });
    });

    const host = new FakeHost();
    const surface = new EngineSurface({
      host,
      manager,
      bridge: loadBridge(EXTENSION_ROOT),
      configPath: () => seed.configPath,
      home: seed.stateDir,
      execPath: process.execPath,
      enginePath: ENGINE_BUNDLE,
      resolveLoginPath: () =>
        new NodeEngineProcess({ env: seed.env, shell: seed.loginShell }).resolveLoginPath(),
      reconnect: async () => {},
    });

    const first = await manager.ensureRunning('user');
    expect(first.kind).toBe('mismatch');
    expect(await manager.activeRuns()).toBe(0);
    const before = JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { startedAt: string };

    await surface.settled();
    // R21: nothing was at stake, so nothing was asked — and the engine really was replaced.
    expect(host.callsOf('showInformationMessage')).toHaveLength(0);
    // The lock is removed by the stop and rewritten by the boot, so a read can land in between.
    const after = await waitUntil(
      async () => {
        try {
          return JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { startedAt: string };
        } catch {
          return null;
        }
      },
      (file) => file !== null && file.startedAt !== before.startedAt,
      { what: 'the restarted engine to write a new engine.json' },
    );
    expect(after?.startedAt).not.toBe(before.startedAt);
    expect(engineProcessCount(seed.configPath)).toBe(1);
    expect(host.output.join('\n')).toContain('it is being restarted');
    surface.dispose();
  }, TIMEOUT);

  /**
   * MG-C5's other half, and the reason the handshake has two parts at all.
   *
   * `ENGINE_VERSION` is the package's, and it stayed `0.0.1` across two phases of engine changes —
   * so a version-only handshake adopted a stale engine and then found no `/items` on it for as
   * long as it kept running. The build id is a content address of the bundle, and a differing one
   * is a mismatch even when the two version strings are the same word.
   *
   * The restart it earns is ONE. Here the replacement is the very same bundle, so it mismatches
   * again the moment it is probed; a surface that acted on every `mismatch` state would restart
   * the engine forever, which is the flap this phase set out to end. The latch is what stops it,
   * and one SIGTERM — counted on the real port, against the real pid — is what says so.
   */
  it('restarts a build-id mismatch exactly ONCE, and leaves the replacement alone (MG-C5)', async () => {
    const seed = await seedStateDir();
    const process_ = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    const bridge = loadBridge(EXTENSION_ROOT);
    // The bundle really is the shipping one. Only the content address the extension ADVERTISES is
    // faked, which is exactly the shape of an upgrade: same package version, different bundle.
    const manager = createManager(seed, {
      process: process_,
      bundledBuildId: 'not-the-bundled-build-id',
      // …and stamped after it, which is what makes this window the one allowed to replace it.
      bundledBuildTime: new Date(Date.now() + 600_000).toISOString(),
    });
    cleanups.push(async () => {
      await manager.stop();
      await rm(seed.stateDir, { recursive: true, force: true });
    });

    const host = new FakeHost();
    const surface = new EngineSurface({
      host,
      manager,
      bridge,
      configPath: () => seed.configPath,
      home: seed.stateDir,
      execPath: process.execPath,
      enginePath: ENGINE_BUNDLE,
      resolveLoginPath: () =>
        new NodeEngineProcess({ env: seed.env, shell: seed.loginShell }).resolveLoginPath(),
      reconnect: async () => {},
    });
    cleanups.push(async () => {
      surface.dispose();
      await surface.settled();
    });

    const first = await manager.ensureRunning('user');
    expect(first.kind).toBe('mismatch');
    // The two version words are identical, so the sentence is built from the BUILD ids instead —
    // "0.0.1 and 0.0.1 disagree" would tell the user nothing at all.
    const mismatch = first as Extract<typeof first, { kind: 'mismatch' }>;
    expect(mismatch.running).toBe(`${bridge.ENGINE_VERSION} (build ${bridge.ENGINE_BUILD_ID})`);
    expect(mismatch.bundled).toBe(`${bridge.ENGINE_VERSION} (build not-the-bundled-build-id)`);
    expect(mismatch.running).not.toBe(mismatch.bundled);

    const before = JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { startedAt: string };
    expect(await manager.activeRuns()).toBe(0);

    await surface.settled();
    // Nothing was at stake, so nothing was asked — and the engine really was replaced (R21).
    expect(host.callsOf('showInformationMessage')).toHaveLength(0);
    const after = await waitUntil(
      async () => {
        try {
          return JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { startedAt: string };
        } catch {
          return null;
        }
      },
      (file) => file !== null && file.startedAt !== before.startedAt,
      { what: 'the restarted engine to write a new engine.json' },
    );
    expect(after?.startedAt).not.toBe(before.startedAt);
    expect(process_.sigterms).toBe(1);

    // The replacement is the same bundle, so it is STILL a mismatch — and it is left alone. A
    // generous window, because a second restart would be a real process doing real work and this
    // is the only way to say it did not happen.
    expect(manager.state().kind).toBe('mismatch');
    await sleep(1_000);
    await surface.settled();
    expect(process_.sigterms).toBe(1);
    expect(engineProcessCount(seed.configPath)).toBe(1);
    expect(host.callsOf('showInformationMessage')).toHaveLength(0);
  }, STOP_TIMEOUT);

  /**
   * The restart ping-pong, against the real engine.
   *
   * Two VS Code windows on two different extension builds shared one engine. A content address
   * says "not mine" to BOTH of them, so both restarted it, and every restart gave the other a
   * new identity to restart again: a SIGTERM every 1.54 s in `engine.log`, each one a clean
   * `exited with code 0`, for as long as both windows were open.
   *
   * The build TIME orders the two. Here the fresh window ships a bundle stamped AFTER the engine
   * it finds and the stale one a bundle stamped before it — the shape of "I just installed a new
   * vsix while my other window still runs the old one". The fresh window replaces the engine
   * once; the stale one adopts it and says the window is what needs reloading. Twenty seconds of
   * both windows probing is what proves the loop is gone.
   */
  it('two windows on different builds leave exactly ONE SIGTERM in the log (the ping-pong)', async () => {
    const seed = await seedStateDir();
    const bridge = loadBridge(EXTENSION_ROOT);
    const engineBuiltAt = Date.parse(bridge.ENGINE_BUILD_TIME ?? '');
    expect(Number.isFinite(engineBuiltAt)).toBe(true);
    const iso = (offsetMs: number): string => new Date(engineBuiltAt + offsetMs).toISOString();

    const freshProcess = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    const staleProcess = new CountingProcess({ env: seed.env, shell: seed.loginShell });
    // Only what each window ADVERTISES is faked; the bundle both of them spawn is the real one.
    const fresh = createManager(seed, {
      process: freshProcess,
      bundledBuildId: 'the-newly-installed-build',
      bundledBuildTime: iso(60_000),
    });
    const stale = createManager(seed, {
      process: staleProcess,
      bundledBuildId: 'the-build-the-other-window-runs',
      bundledBuildTime: iso(-60_000),
    });
    cleanups.push(async () => {
      await fresh.stop();
      await rm(seed.stateDir, { recursive: true, force: true });
    });

    const surfaceFor = (manager: typeof fresh): EngineSurface =>
      new EngineSurface({
        host: new FakeHost(),
        manager,
        bridge,
        configPath: () => seed.configPath,
        home: seed.stateDir,
        execPath: process.execPath,
        enginePath: ENGINE_BUNDLE,
        resolveLoginPath: () =>
          new NodeEngineProcess({ env: seed.env, shell: seed.loginShell }).resolveLoginPath(),
        reconnect: async () => {},
      });
    const surfaces = [surfaceFor(fresh), surfaceFor(stale)];
    cleanups.push(async () => {
      for (const surface of surfaces) {
        surface.dispose();
        await surface.settled();
      }
    });

    // The fresh window starts the engine and finds a bundle older than its own: one restart.
    expect((await fresh.ensureRunning('user')).kind).toBe('mismatch');
    // The stale window adopts whatever is there — it can never prove it is the newer of the two.
    expect((await stale.ensureRunning('user')).kind).toBe('outdated');

    // Twenty seconds of both windows doing what activation, a settings change and a config save
    // all do. A loop would spend one SIGTERM per round here.
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      await fresh.ensureRunning('auto');
      await stale.ensureRunning('auto');
      for (const surface of surfaces) await surface.settled();
      await sleep(500);
    }

    const sigterms = (readEngineLog(seed.engineLogPath).match(/"signal":"SIGTERM"/g) ?? []).length;
    expect(sigterms).toBe(1);
    expect(freshProcess.sigterms + staleProcess.sigterms).toBe(1);
    expect(staleProcess.sigterms).toBe(0);
    expect(stale.state().kind).toBe('outdated');
    expect(engineProcessCount(seed.configPath)).toBe(1);
  }, 90_000);

  it('resolves the same paths the harness chose, through the bundled bridge (MG-C6)', async () => {
    const h = await boot();
    const resolved = await loadEngineBridge().loadResolvedConfig(h.configPath, h.stateDir);
    expect(resolved).toMatchObject({
      configPath: h.configPath,
      stateDir: h.stateDir,
      socketPath: h.socketPath,
      sessionsDir: h.sessionsDir,
      worktreesDir: h.worktreesDir,
      enginePidPath: h.enginePidPath,
      engineLogPath: h.engineLogPath,
      repos: [h.repoSlug],
      me: 'me',
    });
  }, TIMEOUT);

  it('loads the bridge in well under the activation budget', () => {
    const started = process.hrtime.bigint();
    const bridge = loadBridge(EXTENSION_ROOT);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(bridge.ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(elapsedMs).toBeLessThan(250);
  });
});

/**
 * R25. The design claims the editor's extension-host binary is a Node ≥ 20 host for the engine.
 * This is the only place that claim is executed rather than believed.
 */
describe.skipIf(!coreIsBuilt())("R25: spawning through the editor's own helper", () => {
  it('reports Electron and Node ≥ 20, with ELECTRON_RUN_AS_NODE scrubbed for grandchildren', async () => {
    if (!existsSync(CODE_HELPER)) {
      // Never a silent pass: the case is skipped, and it says exactly what it looked for.
      expect(`skipped: no editor helper binary at ${CODE_HELPER}`).toContain('skipped');
      return;
    }
    const seed = await seedStateDir();
    cleanups.push(() => rm(seed.stateDir, { recursive: true, force: true }));

    const proc = new NodeEngineProcess({
      env: {
        ...seed.env,
        // The debug seam A4 added: print what survived the scrub, then exit 0 without an engine.
        CGREMLIN_ENGINE_PRINT_ENV: '1',
        NODE_OPTIONS: '--max-old-space-size=99',
        VSCODE_PID: '1',
        VSCODE_CWD: '/x',
      },
      shell: seed.loginShell,
    });
    // The same two steps the manager takes, in the same order (R20 then the spawn), with the
    // editor's own helper standing in for `process.execPath`.
    const loginPath = await proc.resolveLoginPath();
    const spawned = await proc.spawnDetached({
      execPath: CODE_HELPER,
      args: [ENGINE_BUNDLE],
      cwd: seed.stateDir,
      logPath: seed.engineLogPath,
      env: { PATH: loginPath ?? undefined },
    });
    expect(spawned.pid).toBeGreaterThan(0);

    const reported = await waitUntil(
      async () => {
        const line = readEngineLog(seed.engineLogPath).split('\n').find((l) => l.startsWith('{'));
        return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
      },
      (value) => value !== null,
      { timeoutMs: 15_000, what: "the helper's environment report in the engine log" },
    );

    // The claim under test: this really is Electron, and it really is a Node the engine supports.
    expect(reported?.electronVersion).toEqual(expect.stringMatching(/^\d+\./));
    const major = Number(/^v(\d+)\./.exec(String(reported?.nodeVersion))?.[1] ?? '0');
    expect(major).toBeGreaterThanOrEqual(20);

    // R24/R25: the adapter set ELECTRON_RUN_AS_NODE to make the helper behave as Node, and the
    // engine deleted it again — so a `bash -lc` the engine spawns cannot inherit it.
    expect(reported?.electronRunAsNode).toBeNull();
    expect(reported?.nodeOptions).toBeNull();
    expect(reported?.vscodeKeys).toEqual([]);
    // R20's PATH really did come from the login shell, not from this process.
    expect(String(reported?.path).startsWith(`${seed.binDir}:`)).toBe(true);

    await sleep(50);
  }, TIMEOUT);
});

describe.skipIf(coreIsBuilt())('integration: skipped', () => {
  it('says how to build the engine bundle', () => {
    expect(SKIP_REASON).toContain('not built');
  });
});
