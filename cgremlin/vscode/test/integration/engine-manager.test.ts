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
import type { EngineIdentity } from '../../src/engine/manager';
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
 * The `Code Helper (Plugin)` binary R25 names. Absent on a machine without VS Code installed, in
 * which case the case below skips loudly rather than passing quietly.
 */
const CODE_HELPER =
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';

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

    // A loser that reported `failed` (its own child lost the lock and exited 1) adopts on the
    // next call rather than trying again — the winner is already there.
    const settled = [];
    for (const manager of managers) settled.push(await manager.ensureRunning('user'));
    expect(settled.every((s) => s.kind === 'running')).toBe(true);
    const pids = new Set(settled.map((s) => (s.kind === 'running' ? s.pid : -1)));
    expect(pids.size).toBe(1);
    expect(engineProcessCount(seed.configPath)).toBe(1);

    const pidFile = JSON.parse(readFileSync(seed.enginePidPath, 'utf8')) as { pid: number };
    expect(pidFile.pid).toBe([...pids][0]);
    expect(raced.length).toBe(2);
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
  }, TIMEOUT);

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
    const manager = createManager(seed, { bundledVersion: '99.99.99-not-the-bundled-one' });
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
