/**
 * Boots a REAL cgremlin engine for the integration tests.
 *
 * Nothing here is a stub of the core: the engine is `cgremlin-core serve`, spawned as a child
 * process from the core's own built output, listening on a real Unix socket in a throwaway state
 * dir. The extension then talks to it through the very same `CoreClient` / `SseClient` /
 * `RefreshCoordinator` that ship.
 *
 * What IS faked, and only outside the engine:
 *  - `gh`, by a committed script on PATH that answers `pr list`/`pr view` from fixtures and exits 1
 *    for every write (test/support/fake-gh/gh);
 *  - `claude`, by a no-op script on PATH, purely as a backstop — no test here starts a stage, and
 *    the assertions say so.
 *
 * The legacy `~/.cgremlin` state dir is never touched: HOME itself is redirected into the temp dir.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreClient } from '../../src/core-client';
import type { SessionView } from '../../src/model/items';

const REPO_SLUG = 'fake/repo';
const CORE_DIR = path.resolve(__dirname, '../../../core');
const FAKE_GH_DIR = path.join(__dirname, 'fake-gh');

/** The engine entry point the harness spawns. Absent until `pnpm --dir ../core build` has run. */
export const CORE_ENTRY = path.join(CORE_DIR, 'bin/cgremlin-core');
export const CORE_DIST_MAIN = path.join(CORE_DIR, 'dist/cli/main.js');

export const SKIP_REASON =
  `cgremlin/core is not built (${CORE_DIST_MAIN} is missing) — ` +
  'run `pnpm --dir ../core build`, or `pnpm test:integration`, which does it for you.';

let built: boolean | null = null;

/** True when the core's built entry point exists, so the integration suite can run at all. */
export function coreIsBuilt(): boolean {
  // Sync on purpose: `describe.skipIf` needs an answer before any test body runs.
  built ??= existsSync(CORE_DIST_MAIN);
  return built;
}

/** The 40-hex head sha of the PR fixture the seeded review session points at. */
export const PR3_SHA = '3333333333333333333333333333333333333333';

export interface SeededSessions {
  investigation: string;
  development: string;
  review: string;
}

export interface CoreHarness {
  socketPath: string;
  stateDir: string;
  sessionsDir: string;
  worktreesDir: string;
  binDir: string;
  repoSlug: string;
  /** The bypass secret written into `core.json` — `GET /config` must never echo it. */
  bypassSecret: string;
  humanTurnTtlMs: number;
  client: CoreClient;
  seeded: SeededSessions;
  /** The engine's stderr, which is where `serve()` writes its JSON event log. */
  stderr(): string;
  /** SIGTERM, wait for exit, and assert the socket file is gone. */
  stop(): Promise<void>;
  /** Spawns the engine again on the same socket and state dir (R20's boot clear). */
  restart(): Promise<void>;
  /** Removes the whole temp state dir. */
  cleanup(): Promise<void>;
}

export interface StartEngineOptions {
  /** R20's claim TTL. Deliberately short in tests that assert a claim expires. */
  humanTurnTtlMs?: number;
}

export async function startEngine(opts: StartEngineOptions = {}): Promise<CoreHarness> {
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

  const harness: CoreHarness = {
    socketPath,
    stateDir,
    sessionsDir,
    worktreesDir,
    binDir,
    repoSlug: REPO_SLUG,
    bypassSecret,
    humanTurnTtlMs,
    client: new CoreClient(socketPath),
    seeded,
    stderr: () => stderr,
    stop,
    restart,
    cleanup,
  };

  let child: ChildProcess | null = null;
  let stderr = '';
  let exited: Promise<void> = Promise.resolve();

  async function spawnEngine(): Promise<void> {
    const proc = spawn(process.execPath, [CORE_ENTRY, 'serve', '--config', configPath], {
      cwd: stateDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The legacy state dir must be unreachable even by accident.
        HOME: stateDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FAKE_GH_FIXTURES: FAKE_GH_DIR,
      },
    });
    child = proc;
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.once('exit', (code, signal) => {
      if (code !== 0 && signal === null) {
        stderr += `\n[engine exited with code ${String(code)}]\n`;
      }
    });
    await waitForSocket(socketPath, () => stderr, proc);
  }

  async function stop(): Promise<void> {
    const proc = child;
    child = null;
    if (proc === null) return;
    proc.kill('SIGTERM');
    await withTimeout(exited, 10_000, () => `engine did not exit after SIGTERM. stderr:\n${stderr}`);
    if (await exists(socketPath)) {
      throw new Error(`engine left its socket file behind at ${socketPath}`);
    }
  }

  async function restart(): Promise<void> {
    await stop();
    await spawnEngine();
  }

  async function cleanup(): Promise<void> {
    await stop();
    await rm(stateDir, { recursive: true, force: true });
  }

  await spawnEngine();
  return harness;
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

async function waitForSocket(socketPath: string, stderr: () => string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await exists(socketPath)) return;
    if (proc.exitCode !== null) {
      throw new Error(`engine exited before listening (code ${String(proc.exitCode)}). stderr:\n${stderr()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`engine never created its socket at ${socketPath}. stderr:\n${stderr()}`);
    }
    await sleep(25);
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message())), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
