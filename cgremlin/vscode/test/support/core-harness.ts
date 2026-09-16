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
 *  - `gh`, by a committed script on PATH that answers `pr list`/`pr view`/`api graphql` from
 *    fixtures and exits 1 for every write and for any GraphQL `mutation` (test/support/fake-gh/gh);
 *  - `claude`, by a no-op script on PATH: the ONLY stage any test here starts is the one respond
 *    run C1 asserts, and MG-8's accounting over `run.started` is what keeps that true;
 *  - Jira, by a stub HTTP server the caller starts and points `jira.baseUrl` at (D7/R10) — the
 *    real `JiraRestSource` inside the real engine talks to it over real HTTP;
 *  - `https://github.com/...`, by a `url.<local>.insteadOf` in the throwaway HOME's `.gitconfig`,
 *    so `RespondSessionFactory`'s mirror-and-worktree really runs against a local origin;
 *  - the login shell R20 asks for `PATH`, by a script that echoes the throwaway bin dir first, so
 *    the fake `gh` is what the engine finds.
 *
 * The legacy `~/.cgremlin` state dir is never touched: HOME itself is redirected into the temp dir.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreClient } from '../../src/core-client';
import { loadBridge, type EngineBridge } from '../../src/engine/bridge';
import { EngineManager, type EngineProcessPort, type EngineState } from '../../src/engine/manager';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import type { SessionView } from '../../src/model/items';

const REPO_SLUG = 'fake/repo';
/** The merged PRs the QA fixtures answer `gh pr view` for. */
const QA_PR_NUMBERS = [900];
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
  /** Carries `lineage.ticket: 'APP-1'`, so under `projectKeys: ['APP']` it merges into a ticket. */
  investigation: string;
  /** No ticket, no PR — R49's "the sessions I only have an investigation for". */
  looseInvestigation: string;
  development: string;
  review: string;
}

/** The Jira block C1 seeds into `core.json`, pointing the real adapter at the stub (D7/R10). */
export interface SeededJira {
  baseUrl: string;
  apiToken: string;
  email?: string;
  siteUrl?: string;
  projectKeys?: string[];
  scanBudgetMs?: number;
  timeoutMs?: number;
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
  /** The throwaway Jira token, or null when the seed carries no `jira` block. */
  jiraToken: string | null;
  humanTurnTtlMs: number;
  seeded: SeededSessions;
  /**
   * Phase 16 — the local origin, and its two commits: `head` is the sha the
   * merged PR fixture carries, `parent` an OLDER build that does not contain
   * it. A QA serving `parent` is a QA the change has not reached yet.
   */
  originPath: string;
  originShas: { head: string; parent: string };
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
  /**
   * D7/R10: a `jira` block pointing at a stub. Omitted, the engine has no Jira source at all and
   * `ticketSource.kind` is `notConfigured` — which is exactly what the engine-manager suite wants,
   * and what MG-6's third case asserts with a block that carries no `apiToken`.
   */
  jira?: SeededJira;
  /**
   * MG-7/R45: a pre-Phase-9 `inventory.json` written before the engine boots, so the upgrade
   * path (`InventoryStore.load` re-parses and `GET /prs` has no catch) is exercised for real.
   */
  inventory?: unknown;
  /**
   * `config.repos`, for a test whose subject is the CHOICE of repo (the ticket-only start's quick
   * pick). `fake/repo` is always present — the seeded sessions and every PR fixture are its — and
   * each extra slug gets its own local origin, so a session really can be created in it. The fake
   * `gh` needs a `pr-list-<slug with / as ->.json` fixture for every slug the scan visits.
   */
  repos?: string[];
  /**
   * The directory the fake `gh` reads its fixtures from. Defaults to the committed one; a test
   * that needs a differently SHAPED inventory (P1: a parking lot that is entirely "someone is on
   * it") points this at its own dir rather than rewriting the shared fixture out from under
   * every other integration test.
   */
  ghFixtures?: string;
  /**
   * Phase 15 — the QA environment block for `fake/repo`, plus the `qa` trigger config. `url`
   * is ALWAYS a loopback URL from `test/support/fake-qa`: no integration test may reach a real
   * QA deployment. Giving this also generates a `pr-view-<n>.json` fixture whose `mergeCommit`
   * is the local origin's REAL head sha, because the QA factory checks that commit out.
   */
  qa?: { url: string; auth: 'vercel-bypass' | 'clerk-test' | 'credentials' | 'none'; autoVerify?: boolean };
  /** `<stateDir>/pr-states.json` — a PR that has merged and left the open-PR inventory. */
  prStates?: Record<string, unknown>;
  /** What the fake `claude` writes as `QA.md` when a QA run starts. */
  qaVerdict?: string;
  /**
   * Phase 18 — the fake agent HANGS for this many seconds instead of exiting,
   * so a test can catch a run mid-flight. Bounded on purpose: an engine killed
   * under it orphans the child, and this is what reaps it.
   */
  agentHangsForSeconds?: number;
}

/** The merged-PR cache row a QA test seeds, linked to its ticket by `ticketKeys` (R28). */
export function mergedPrState(number: number, ticket: string): Record<string, unknown> {
  return {
    state: 'merged',
    title: `Fixture PR ${number} (merged, links ${ticket})`,
    url: `https://github.com/${REPO_SLUG}/pull/${number}`,
    mergedAt: '2026-09-14T10:00:00Z',
    closedAt: null,
    branch: `me/${ticket.toLowerCase()}`,
    ticketKeys: [ticket],
    author: 'me',
    createdAt: '2026-09-10T10:00:00Z',
    changedFiles: 3,
    additions: 40,
    deletions: 2,
    isDraft: false,
    labels: [],
    checkedAt: '2026-09-14T10:05:00Z',
  };
}

/** The `gh pr view` fixture a merged PR answers with — `PR_QA_VIEW_FIELDS`' extra two included. */
function mergedPrView(number: number, ticket: string, mergeSha: string): unknown {
  return {
    number,
    title: `Fixture PR ${number} (merged, links ${ticket})`,
    author: { login: 'me' },
    headRefName: `me/${ticket.toLowerCase()}`,
    headRefOid: mergeSha,
    baseRefName: 'main',
    url: `https://github.com/${REPO_SLUG}/pull/${number}`,
    state: 'MERGED',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergedAt: '2026-09-14T10:00:00Z',
    closedAt: null,
    mergeCommit: { oid: mergeSha },
    files: [{ path: 'README.md', additions: 40, deletions: 2 }],
    latestReviews: [],
    statusCheckRollup: [],
  };
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
  // The agent runner, as a no-op that exits 0. Exactly ONE stage is started anywhere in this
  // suite — C1's respond run — and MG-8's accounting over `run.started` proves it; this script
  // is what guarantees that even that one can never reach the real agent CLI.
  // Phase 15 adds one thing it may do: when `$FAKE_QA_VERDICT` names a file, it copies that
  // file into the session directory the runner passed as `--add-dir` — which is exactly what a
  // verification agent does, and the only way an end-to-end test can drive `evaluateQa`.
  await writeFile(
    path.join(binDir, 'claude'),
    opts.agentHangsForSeconds !== undefined
    ? ['#!/bin/bash', `exec sleep ${opts.agentHangsForSeconds}`, ''].join('\n')
    : [
      '#!/bin/bash',
      'set -u',
      'verdict="${FAKE_QA_VERDICT:-}"',
      '[ -z "$verdict" ] && exit 0',
      '[ -f "$verdict" ] || exit 0',
      'dir=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "--add-dir" ]; then dir="$arg"; break; fi',
      '  prev="$arg"',
      'done',
      '# Only a QA run: every other stage writes its own artifacts and must stay a no-op.',
      'if [ -n "$dir" ] && [ -f "$dir/BRIEF.md" ] && grep -q "QA VERIFICATION" "$dir/BRIEF.md"; then',
      '  cat "$verdict" > "$dir/QA.md"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
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

  // R51's respond flow mirrors and worktrees `https://github.com/fake/repo.git` for real, so the
  // throwaway HOME rewrites that prefix onto a local origin. Everything else about git is left
  // alone: the clone, the fetch, the `worktree add -b <head branch> origin/<head branch>` all run.
  const originsDir = path.join(stateDir, 'origins');
  const repos = opts.repos === undefined ? [REPO_SLUG] : [...new Set([REPO_SLUG, ...opts.repos])];
  for (const slug of repos) await createOrigin(path.join(originsDir, `${slug}.git`));
  await writeFile(
    path.join(stateDir, '.gitconfig'),
    [
      '[user]',
      '\tname = integration',
      '\temail = integration@example.com',
      '[safe]',
      '\tdirectory = *',
      `[url "${originsDir}/"]`,
      '\tinsteadOf = https://github.com/',
      '',
    ].join('\n'),
    'utf8',
  );

  const configPath = path.join(stateDir, 'core.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        repos: opts.repos ?? [REPO_SLUG],
        watchAuthors: ['mate'],
        me: 'me',
        // R5, the user's own two: `apfm-sonar` also carries gh's `is_bot`, `gitstream-cm` does
        // not — so PR #7 proves both halves of the ONE bot predicate keep a row untouched.
        botLogins: ['apfm-sonar', 'gitstream-cm'],
        // R46: without `projectKeys` no PR and no session links to a ticket at all, so the
        // pr↔ticket merge this phase exists to create would never fire.
        ...(opts.jira !== undefined
          ? {
              jira: {
                siteUrl: opts.jira.siteUrl ?? 'https://fake.atlassian.net',
                email: opts.jira.email ?? 'integration@example.com',
                ...(opts.jira.apiToken === '' ? {} : { apiToken: opts.jira.apiToken }),
                baseUrl: opts.jira.baseUrl,
                projectKeys: opts.jira.projectKeys ?? ['APP'],
                scanBudgetMs: opts.jira.scanBudgetMs ?? 5_000,
                timeoutMs: opts.jira.timeoutMs ?? 4_000,
              },
            }
          : {}),
        reviewThreads: { scanBudgetMs: 5_000 },
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
            // Phase 15 §6. `url` is a loopback stub, never a real deployment.
            ...(opts.qa !== undefined
              ? {
                  qa: {
                    url: opts.qa.url,
                    auth: opts.qa.auth,
                    healthPath: '/',
                    healthTimeoutMs: 3_000,
                    // Phase 16 — the user's own keys: where QA says which build it serves.
                    versionPath: '/api/health',
                    versionField: 'version',
                  },
                }
              : {}),
          },
        },
        ...(opts.qa !== undefined
          ? {
              qa: {
                autoVerify: opts.qa.autoVerify ?? true,
                maxAutoStartsPerTick: 1,
                maxAttemptsPerEntry: 1,
                scanBudgetMs: 10_000,
                backfillOnFirstRun: false,
              },
            }
          : {}),
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );

  if (opts.prStates !== undefined) {
    await writeFile(
      path.join(stateDir, 'pr-states.json'),
      `${JSON.stringify(opts.prStates, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }

  // Phase 15: a fixtures dir of our own, because the merge commit the QA factory checks out has
  // to be the local origin's REAL head sha — which only exists once `createOrigin` has run.
  let ghFixtures = opts.ghFixtures ?? FAKE_GH_DIR;
  let verdictPath: string | null = null;
  if (opts.qa !== undefined) {
    ghFixtures = path.join(stateDir, 'gh-fixtures');
    await mkdir(ghFixtures, { recursive: true });
    for (const name of await readdir(opts.ghFixtures ?? FAKE_GH_DIR)) {
      await copyFile(path.join(opts.ghFixtures ?? FAKE_GH_DIR, name), path.join(ghFixtures, name));
    }
    const originPath = path.join(originsDir, `${REPO_SLUG}.git`);
    const mergeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: originPath, encoding: 'utf8' }).trim();
    for (const number of QA_PR_NUMBERS) {
      await writeFile(
        path.join(ghFixtures, `pr-view-${number}.json`),
        `${JSON.stringify(mergedPrView(number, 'APP-42', mergeSha), null, 2)}\n`,
        'utf8',
      );
    }
    verdictPath = path.join(stateDir, 'qa-verdict.md');
    await writeFile(verdictPath, opts.qaVerdict ?? '', 'utf8');
  }

  if (opts.inventory !== undefined) {
    await writeFile(
      path.join(stateDir, 'inventory.json'),
      `${JSON.stringify(opts.inventory, null, 2)}\n`,
      'utf8',
    );
  }

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
      FAKE_GH_FIXTURES: ghFixtures,
      ...(verdictPath === null ? {} : { FAKE_QA_VERDICT: verdictPath }),
    },
    repoSlug: REPO_SLUG,
    bypassSecret,
    jiraToken: opts.jira?.apiToken !== undefined && opts.jira.apiToken !== '' ? opts.jira.apiToken : null,
    humanTurnTtlMs,
    seeded,
    originPath: path.join(originsDir, `${REPO_SLUG}.git`),
    originShas: originShasOf(path.join(originsDir, `${REPO_SLUG}.git`)),
  };
}

/** `main`'s head (the merged PR's sha) and the commit before it (an older build). */
function originShasOf(originPath: string): { head: string; parent: string } {
  const rev = (ref: string): string =>
    execFileSync('git', ['rev-parse', ref], { cwd: originPath, encoding: 'utf8' }).trim();
  return { head: rev('HEAD'), parent: rev('HEAD~1') };
}

/**
 * A local origin carrying `main` and PR #5's head branch, for the respond
 * worktree. TWO commits on `main` since Phase 16: the merged PR's sha is the
 * head, and the commit before it stands in for a QA build cut earlier — one
 * that does not contain the change.
 */
async function createOrigin(originPath: string): Promise<void> {
  await mkdir(path.dirname(originPath), { recursive: true });
  const git = (args: string[], cwd = originPath): void => {
    execFileSync('git', ['-c', 'user.email=integration@example.com', '-c', 'user.name=integration', ...args], {
      cwd,
      encoding: 'utf8',
    });
  };
  execFileSync('git', ['init', '-q', '-b', 'main', originPath]);
  await writeFile(path.join(originPath, 'README.md'), '# fixture origin\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  // The branch PR #5 is open on — `RespondSessionFactory` branches from `origin/<headRefName>`.
  git(['branch', 'me/fixture-five']);
  await writeFile(path.join(originPath, 'CHANGE.md'), '# the merged change\n', 'utf8');
  git(['add', 'CHANGE.md']);
  git(['commit', '-q', '-m', 'the merged change']);
}

/** One more commit on the origin's `main` — the build QA cuts next. */
export function commitOnOrigin(originPath: string, message: string): string {
  const git = (args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=integration@example.com', '-c', 'user.name=integration', ...args], {
      cwd: originPath,
      encoding: 'utf8',
    });
  writeFileSync(path.join(originPath, `${message.replace(/[^a-z0-9]/gi, '-')}.md`), `${message}\n`, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

/**
 * Every file under the state dir except `core.json` itself, which is the one place the token is
 * allowed to be — MG-5 is "the secret never LEAVES core.json", not "there is no secret".
 */
export async function stateDirFiles(stateDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The mirrors and worktrees are git's own object store; nothing the engine writes.
        if (entry.name === '.git' || entry.name === 'mirrors' || entry.name === 'origins') continue;
        await walk(full);
        continue;
      }
      if (full === path.join(stateDir, 'core.json')) continue;
      if (full === path.join(stateDir, '.gitconfig')) continue;
      found.push(full);
    }
  };
  await walk(stateDir);
  return found;
}

export interface ManagerOptions {
  /**
   * The port itself, for a test that has to *count* what reached the machine — how many SIGTERMs
   * two windows sent between them. Defaults to a real {@link NodeEngineProcess}.
   */
  process?: EngineProcessPort;
  /** Override to drive the version handshake (R2/R21) against a real engine. */
  bundledVersion?: string;
  /** MG-C5's content address; override it to make a same-version engine look stale. */
  bundledBuildId?: string;
  /**
   * What ORDERS this window's bundle against the engine's. Override it to make a window look
   * newer than the engine (which may restart it) or older (which may not, ever).
   */
  bundledBuildTime?: string | null;
  /** R25 supplies the editor's own `Code Helper (Plugin)` here. */
  execPath?: string;
  /**
   * The bundle this manager would SPAWN. Defaults to the shipping `engine/engine.js`; a test
   * about two windows on two builds points one manager at a copy stamped with a different build
   * id and time, so the engine it starts really is a different build rather than a pretend one.
   */
  enginePath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** A manager wired the way the editor wires one, over a seeded state dir. */
export function createManager(seed: SeededStateDir, opts: ManagerOptions = {}): EngineManager {
  return new EngineManager({
    process:
      opts.process ?? new NodeEngineProcess({ env: opts.env ?? seed.env, shell: seed.loginShell }),
    bundledVersion: opts.bundledVersion ?? loadEngineBridge().ENGINE_VERSION,
    bundledBuildId: opts.bundledBuildId ?? loadEngineBridge().ENGINE_BUILD_ID,
    bundledBuildTime:
      opts.bundledBuildTime === undefined
        ? loadEngineBridge().ENGINE_BUILD_TIME
        : opts.bundledBuildTime,
    paths: () => ({
      configPath: seed.configPath,
      socketPath: seed.socketPath,
      enginePidPath: seed.enginePidPath,
      engineLogPath: seed.engineLogPath,
    }),
    launch: () => ({
      execPath: opts.execPath ?? process.execPath,
      enginePath: opts.enginePath ?? ENGINE_BUNDLE,
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
  const looseInvestigation = 'inv-fake-repo-loose';
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

  // R49: no PR, no ticket, an investigation agent and nothing else — the one item that belongs
  // in `investigations` and must NOT also be in `myWork`.
  await writeSession(sessionsDir, worktreesDir, {
    schemaVersion: 2,
    id: looseInvestigation,
    createdAt: '2026-09-09T10:30:00.000Z',
    mode: 'investigation',
    stageStatus: 'findings',
    workspace: {
      repoUrl: `https://github.com/${REPO_SLUG}.git`,
      worktreePath: path.join(worktreesDir, looseInvestigation),
      branch: 'investigate/loose',
    },
    lineage: { pipelineId: looseInvestigation, parentSessionId: null, ticket: null },
    agent: { runner: 'claude-code', resumeId: 'resume-inv-loose', humanTurn: null },
    lastRun: null,
    pr: null,
    intent: 'investigate_only',
    driveToCompletion: false,
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

  return { investigation, looseInvestigation, development, review };
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

/**
 * Artifacts with EXPLICIT, distinct mtimes, oldest first in declaration order. The Item tab sorts
 * a session's artifacts newest-first (R48), and two files written in the same millisecond make
 * that assertion a coin toss rather than a test.
 */
async function writeArtifacts(
  sessionsDir: string,
  id: string,
  files: Record<string, string>,
): Promise<void> {
  const base = Date.parse('2026-09-09T10:00:00.000Z');
  let index = 0;
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(sessionsDir, id, name);
    await writeFile(target, content, 'utf8');
    const at = new Date(base + index * 60_000);
    await utimes(target, at, at);
    index += 1;
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
