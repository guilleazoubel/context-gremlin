/**
 * Boots a REAL cgremlin engine for the integration tests — through the REAL manager.
 *
 * Nothing here is a stub of the core, and since Phase 8 nothing here is a stub of the launch path
 * either: the engine is the **bundled** `engine/engine.js` this package ships, started by the
 * shipping `EngineManager` + `NodeEngineProcess` exactly as the editor starts it — probe, resolve
 * a login-shell PATH, rotate, spawn detached, poll `GET /version`. The extension then talks to it
 * through the very same `CoreClient` / `SseClient` / `RefreshCoordinator` that ship.
 *
 * What IS faked, and only outside the engine:
 *  - `gh`, by a committed script on PATH that answers `pr list`/`pr view` from fixtures and exits 1
 *    for every write (test/support/fake-gh/gh);
 *  - `claude`, by a no-op script on PATH, purely as a backstop — no test here starts a stage, and
 *    the assertions say so;
 *  - the login shell R20 asks for `PATH`, by a script that echoes the throwaway bin dir first, so
 *    the fake `gh` is what the engine finds.
 *
 * The legacy `~/.cgremlin` state dir is never touched: HOME itself is redirected into the temp dir.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreClient } from '../../src/core-client';
import { loadBridge, type EngineBridge } from '../../src/engine/bridge';
import { EngineManager, type EngineState } from '../../src/engine/manager';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import type { SessionView } from '../../src/model/items';

const REPO_SLUG = 'fake/repo';
const FAKE_GH_DIR = path.join(__dirname, 'fake-gh');

/** The installed extension's root — where `engine/engine.js` and `engine/bridge.js` sit. */
export const EXTENSION_ROOT = path.resolve(__dirname, '../..');
export const ENGINE_BUNDLE = path.join(EXTENSION_ROOT, 'engine', 'engine.js');
export const BRIDGE_BUNDLE = path.join(EXTENSION_ROOT, 'engine', 'bridge.js');

export const SKIP_REASON =
  `the engine bundle is not built (${ENGINE_BUNDLE} is missing) — ` +
  'run `pnpm build`, or `pnpm test:integration`, which does it for you.';

let built: boolean | null = null;

/** True when both bundles exist, so the integration suite can run at all. */
export function coreIsBuilt(): boolean {
  // Sync on purpose: `describe.skipIf` needs an answer before any test body runs.
  built ??= existsSync(ENGINE_BUNDLE) && existsSync(BRIDGE_BUNDLE);
  return built;
}

/** The bundled bridge, loaded the way the extension loads it. */
export function loadEngineBridge(): EngineBridge {
  return loadBridge(EXTENSION_ROOT);
}

/** The 40-hex head sha of the PR fixture the seeded review session points at. */
export const PR3_SHA = '3333333333333333333333333333333333333333';

export interface SeededSessions {
  investigation: string;
  development: string;
  review: string;
}

/** A throwaway state dir with a loadable `core.json` and three seeded sessions in it. */
export interface SeededStateDir {
  stateDir: string;
  sessionsDir: string;
  worktreesDir: string;
  binDir: string;
  socketPath: string;
  configPath: string;
  /** `<stateDir>/engine.json` — asserted against the engine's own derivation, never trusted. */
  enginePidPath: string;
  engineLogPath: string;
  /** The fake `$SHELL` R20's `PATH` probe runs. */
  loginShell: string;
  /** The environment the engine is spawned with, before the adapter's own scrubbing. */
  env: NodeJS.ProcessEnv;
  repoSlug: string;
  bypassSecret: string;
  humanTurnTtlMs: number;
  seeded: SeededSessions;
}

export interface CoreHarness extends SeededStateDir {
  client: CoreClient;
  /** The manager that owns this engine — the only thing allowed to signal it. */
  manager: EngineManager;
  /** Everything the manager logged (R20's fallback line, R26's refusals). */
  managerLog(): readonly string[];
  /** The engine's own JSON event log: its stderr, redirected into `engine.log` by the spawn. */
  stderr(): string;
  /** Stop through the manager's two-part proof, and assert socket and `engine.json` are gone. */
  stop(): Promise<void>;
  /** Stop and start again on the same socket and state dir (R20's boot clear). */
  restart(): Promise<void>;
  /** Removes the whole temp state dir. */
  cleanup(): Promise<void>;
}

export interface StartEngineOptions {
  /** R20's claim TTL. Deliberately short in tests that assert a claim expires. */
  humanTurnTtlMs?: number;
}

export async function seedStateDir(opts: StartEngineOptions = {}): Promise<SeededStateDir> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'cgvsc-'));
  const sessionsDir = path.join(stateDir, 'sessions');
  const worktreesDir = path.join(stateDir, 'worktrees');
  const binDir = path.join(stateDir, 'bin');
  const socketPath = path.join(stateDir, 'engine.sock');
  const humanTurnTtlMs = opts.humanTurnTtlMs ?? 600_000;
  const bypassSecret = 'integration-bypass-secret-do-not-leak';

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await symlink(path.join(FAKE_GH_DIR, 'gh'), path.join(binDir, 'gh'));
  // A backstop only: no test in this suite starts a stage, so this must never be invoked. It
  // exists so that a future assertion which does start one cannot reach the real agent CLI.
  await writeFile(path.join(binDir, 'claude'), '#!/bin/bash\nexit 0\n', 'utf8');
  await chmod(path.join(binDir, 'claude'), 0o755);

  // R20's login shell, faked so the engine's PATH really does come through `$SHELL -lic` and
  // really does find the fake `gh` first.
  const loginShell = path.join(binDir, 'login-shell');
  await writeFile(
    loginShell,
    `#!/bin/bash\necho "${binDir}:${process.env.PATH ?? ''}"\n`,
    'utf8',
  );
  await chmod(loginShell, 0o755);

  const configPath = path.join(stateDir, 'core.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        repos: [REPO_SLUG],
        watchAuthors: ['mate'],
        me: 'me',
        // One hour, so no discovery tick ever fires on its own: every scan in these tests is an
        // explicit POST /prs/scan, which keeps the assertions deterministic.
        pollIntervalMs: 3_600_000,
        stateDir,
        socketPath,
        humanTurnTtlMs,
        // Present so `GET /config`'s redaction is proved against a real secret rather than an
        // empty object. `hasAnySecret` then demands mode 0600 on this file, hence the mode below.
        environments: {
          [REPO_SLUG]: {
            vercel: { scope: 'fake-scope', project: 'fake', previewProject: 'fake', bypassSecret },
          },
        },
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );

  const seeded = await seedSessions(sessionsDir, worktreesDir);

  return {
    stateDir,
    sessionsDir,
    worktreesDir,
    binDir,
    socketPath,
    configPath,
    enginePidPath: path.join(stateDir, 'engine.json'),
    engineLogPath: path.join(stateDir, 'engine.log'),
    loginShell,
    env: {
      ...process.env,
      // The legacy state dir must be unreachable even by accident.
      HOME: stateDir,
      FAKE_GH_FIXTURES: FAKE_GH_DIR,
    },
    repoSlug: REPO_SLUG,
    bypassSecret,
    humanTurnTtlMs,
    seeded,
  };
}

export interface ManagerOptions {
  /** Override to drive the version handshake (R2/R21) against a real engine. */
  bundledVersion?: string;
  /** R25 supplies the editor's own `Code Helper (Plugin)` here. */
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** A manager wired the way the editor wires one, over a seeded state dir. */
export function createManager(seed: SeededStateDir, opts: ManagerOptions = {}): EngineManager {
  return new EngineManager({
    process: new NodeEngineProcess({ env: opts.env ?? seed.env, shell: seed.loginShell }),
    bundledVersion: opts.bundledVersion ?? loadEngineBridge().ENGINE_VERSION,
    paths: () => ({
      configPath: seed.configPath,
      socketPath: seed.socketPath,
      enginePidPath: seed.enginePidPath,
      engineLogPath: seed.engineLogPath,
    }),
    launch: () => ({
      execPath: opts.execPath ?? process.execPath,
      enginePath: ENGINE_BUNDLE,
      cwd: seed.stateDir,
    }),
    log: opts.log ?? (() => {}),
  });
}

/** Reads `engine.log` — where the spawn sends both of the engine's streams. */
export function readEngineLog(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

export async function startEngineViaManager(opts: StartEngineOptions = {}): Promise<CoreHarness> {
  const seed = await seedStateDir(opts);
  const logged: string[] = [];
  const manager = createManager(seed, { log: (line) => logged.push(line) });
  let live = false;

  function describeFailure(state: EngineState): string {
    return `${JSON.stringify(state)}\nengine.log:\n${readEngineLog(seed.engineLogPath)}`;
  }

  async function start(): Promise<void> {
    const state = await manager.ensureRunning('user');
    if (state.kind !== 'running') {
      throw new Error(`the engine did not come up: ${describeFailure(state)}`);
    }
    live = true;
  }

  async function stop(): Promise<void> {
    if (!live) return;
    const state = await manager.stop();
    if (state.kind !== 'stopped') {
      throw new Error(`the engine did not stop: ${describeFailure(state)}`);
    }
    live = false;
    // The engine unlinks its socket and removes its lock in `close()`'s finally, just after it
    // stops answering — so this is a short wait, not a loosened assertion.
    await waitForGone(seed.socketPath, 'the socket file');
    await waitForGone(seed.enginePidPath, 'engine.json');
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  async function cleanup(): Promise<void> {
    await stop();
    await rm(seed.stateDir, { recursive: true, force: true });
  }

  const harness: CoreHarness = {
    ...seed,
    client: new CoreClient(seed.socketPath),
    manager,
    managerLog: () => logged,
    stderr: () => readEngineLog(seed.engineLogPath),
    stop,
    restart,
    cleanup,
  };

  await start();
  return harness;
}

/** Waits for a path the engine owns to disappear. */
export async function waitForGone(target: string, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await exists(target))) return;
    if (Date.now() >= deadline) {
      throw new Error(`the engine left ${what} behind at ${target} after ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Seeded state — plain `schemaVersion: 2` documents. No git, no agent, no stage.
// ---------------------------------------------------------------------------

async function seedSessions(sessionsDir: string, worktreesDir: string): Promise<SeededSessions> {
  const investigation = 'inv-fake-repo-APP-1';
  const development = 'dev-fake-repo-APP-2';
  const review = 'rev-fake-repo-3';

  await writeSession(sessionsDir, worktreesDir, {
    schemaVersion: 2,
    id: investigation,
    createdAt: '2026-09-09T10:00:00.000Z',
    mode: 'investigation',
    stageStatus: 'plan_ready',
    workspace: {
      repoUrl: `https://github.com/${REPO_SLUG}.git`,
      worktreePath: path.join(worktreesDir, investigation),
      branch: 'investigate/APP-1',
    },
    lineage: { pipelineId: investigation, parentSessionId: null, ticket: 'APP-1' },
    agent: { runner: 'claude-code', resumeId: 'resume-inv-1', humanTurn: null },
    lastRun: {
      stage: 'plan',
      startedAt: '2026-09-09T10:01:00.000Z',
      finishedAt: '2026-09-09T10:09:00.000Z',
      exitCode: 0,
      signal: null,
      outcome: 'succeeded',
      error: null,
    },
    pr: null,
    intent: 'development',
    driveToCompletion: false,
  });
  await writeArtifacts(sessionsDir, investigation, {
    'BRIEF.md': '# brief\n',
    'PLAN.md': '# the plan\n\nstep one\n',
  });

  await writeSession(sessionsDir, worktreesDir, {
    schemaVersion: 2,
    id: development,
    createdAt: '2026-09-09T11:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: {
      repoUrl: `https://github.com/${REPO_SLUG}.git`,
      worktreePath: path.join(worktreesDir, development),
      branch: 'feature/APP-2',
    },
    lineage: { pipelineId: development, parentSessionId: null, ticket: 'APP-2' },
    agent: { runner: 'claude-code', resumeId: 'resume-dev-2', humanTurn: null },
    // No lastRun and no AGENT_STATE, so this session derives NO reason at all: the item whose
    // `needsYou` must be false while the other two are true.
    lastRun: null,
    pr: null,
  });

  await writeSession(sessionsDir, worktreesDir, {
    schemaVersion: 2,
    id: review,
    createdAt: '2026-09-09T09:00:00.000Z',
    mode: 'review',
    stageStatus: 'ready',
    workspace: {
      repoUrl: `https://github.com/${REPO_SLUG}.git`,
      worktreePath: path.join(worktreesDir, review),
      branch: 'review/3',
    },
    lineage: { pipelineId: review, parentSessionId: null, ticket: null },
    agent: { runner: 'claude-code', resumeId: 'resume-rev-3', humanTurn: null },
    lastRun: {
      stage: 'review',
      startedAt: '2026-09-09T09:01:00.000Z',
      finishedAt: '2026-09-09T09:20:00.000Z',
      exitCode: 0,
      signal: null,
      outcome: 'succeeded',
      error: null,
    },
    // reviewedSha === the fixture's headRefOid on purpose: a mismatch would make the
    // reconciliation tick start a re-review, which is a real agent run.
    pr: {
      repo: REPO_SLUG,
      number: 3,
      url: 'https://github.com/fake/repo/pull/3',
      headSha: PR3_SHA,
      reviewedSha: PR3_SHA,
      title: 'Fixture PR three (we are reviewing it)',
      author: 'mate',
    },
    reviewVersion: 1,
    lastRereviewSummary: null,
  });
  await writeArtifacts(sessionsDir, review, {
    'BRIEF.md': '# brief\n',
    'REVIEW.md': '# review\n\nlooks fine\n',
  });

  return { investigation, development, review };
}

async function writeSession(
  sessionsDir: string,
  worktreesDir: string,
  session: SessionView,
): Promise<void> {
  await mkdir(path.join(sessionsDir, session.id), { recursive: true });
  await mkdir(path.join(worktreesDir, session.id), { recursive: true });
  await writeFile(
    path.join(sessionsDir, session.id, 'session.json'),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );
}

async function writeArtifacts(
  sessionsDir: string,
  id: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(sessionsDir, id, name), content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// small waits
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Polls `read` until `predicate` holds, then returns the value. */
export async function waitUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${opts.what ?? 'a condition'}; last value: ${JSON.stringify(last)}`,
      );
    }
    await sleep(25);
  }
}
