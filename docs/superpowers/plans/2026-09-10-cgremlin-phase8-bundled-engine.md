# cgremlin Phase 8: the extension ships and runs the engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install (or `F5`) the extension and it works. One setting — `cgremlin.configPath`, default
`~/.cgremlin-core/core.json` — names the state file; every other path is derived by **the core's own
config loader**, imported from the engine the extension bundles; and the extension **starts that
engine itself**, detached, whenever nothing answers on the socket. The legacy `~/.cgremlin` state dir
stops being anybody's default and survives only as the read source of `config import-legacy`.

**Architecture:** Two streams, then one convergence. **Stream A (core, branch `phase8-core`):** the
`stateDir` default moves to `~/.cgremlin-core`; `repos` becomes optional-with-`[]` so a first-run
template can load; two new derived paths (`enginePidPath`, `engineLogPath`); a dependency-free
`GET /version` carrying an authoritative `activeRuns` count (R21) plus an `engine.json` identity
file that `serve()` creates with `O_EXCL` **before** it listens — so it doubles as the
mutual-exclusion lock (R22) — and removes when it stops; a `config init` command that writes the template through the existing
`writeCoreConfig`; and two esbuild bundle entry points (`engine-main.ts` for spawning,
`extension-bridge.ts` for the extension to `require`). **Stream B (extension, branch `phase8-ext`):**
`socketPath` is deleted, the socket path becomes a provider function so a settings change takes
effect without a reload, a pure `EngineManager` state machine (probe → spawn → wait → healthy, with a
version handshake and a two-part ownership proof) plus a thin Node adapter, and the host wiring:
four `cgremlin.engine.*` commands, engine state in the status bar, a log tail into the existing
output channel, the first-run bootstrap and a config-file watcher. **Convergence (branch
`phase8-pack`):** packaging into one `.vsix`, the integration suite booting the **bundled** artifact
through the manager, then docs.

**Tech Stack:** core — TypeScript, zod, vitest, `node:http`/`node:fs` (no new *runtime* dependency;
`esbuild` is a devDependency). Extension — TypeScript, `tsc` only for its own code (Phase 7 R13
stands), `@types/vscode` 1.85.0, vitest; still **zero runtime dependencies**; `@vscode/vsce` and
nothing else added as a devDependency. No `@vscode/test-electron`.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase8-bundled-engine-design.md`.
D1–D8 there are binding supervisor decisions and are already folded into every task below.
**R1–R19 in the spec's §3 were confirmed on 2026-09-10 (each is stamped `CONFIRMED 2026-09-10`), and
R20–R30 are supervisor rulings added in the same pass — equally binding, and several of them amend an
earlier R.** Every task below names the rulings it depends on. Nothing is left to executor
discretion: an executor that believes it faces a decision not written in the spec escalates instead
of choosing. The amendments an executor must not miss: **R21** (a single `activeRuns` field on
`GET /version` gates every restart; `/attention` is no longer used for it) amends R2 and R6;
**R22** (an `O_EXCL` `engine.json` lock taken *before* `listenOnSocket`) reverses §4.2's and Task A2's
original write ordering and is the critical correctness fix in this revision; **R23** (stop budget ≥ 45 s, timeout →
`stopping`, never a harder signal) and **R29** (re-prove ownership immediately before every signal)
amend R3; **R20**/**R24** extend R10; **R27** completes R6; **R28** refines R8/R19/MG-C8.

## Verified Ground Truth (2026-09-10, planner grounding pass)

The spec's §2 carries the full list with citations. The facts every task below is built on:

**The bug, in four verified parts**
- `readSettings()` runs at activation (`cgremlin/vscode/src/extension.ts:33`) and `socketPath` is
  baked into `CoreClient` (`:35`) and `SseClient` (`:46`); only `notificationLevel` (`:41`) and
  `configPath` (`:42`) are read live. **No `onDidChangeConfiguration` exists in the package** (grep
  over `vscode/src` + `vscode/test`: zero hits).
- Two independent settings (`vscode/package.json:114-123`), both defaulting into the legacy tool's
  state dir (`vscode/src/settings.ts:16-17`), which `docs/SMOKE.md:19-20` says must not be touched.
- The core defaults the same way: `stateDir: z.string().min(1).default('~/.cgremlin')`
  (`core/src/config/core-config.ts:69`), CLI default `${home}/.cgremlin/core.json`
  (`core/src/cli/command-io.ts:19-21`).
- The only "start" affordance types a shell command into a terminal
  (`vscode/src/ui/commands.ts:154-158`), needing `cgremlin-core` on `PATH` (`docs/SMOKE.md:25-26`).

**Engine facts the plan builds on**
- **A stale socket is already handled by the engine.** `listenOnSocket` connects to test liveness,
  throws `SocketInUseError` if something answers, otherwise unlinks (ignoring `ENOENT`), listens and
  `chmod 600`s (`core/src/api/listen.ts:12-41`); `serveCommand` prints and exits 1 on
  `SocketInUseError` (`core/src/cli/commands/serve.ts:27-31`). **Nothing in the extension may unlink
  a socket.**
- **`serve()` writes no pid/identity file today** — its boot writes are three `mkdir`s
  (`core/src/host/serve.ts:70-72`) and its teardown unlinks the socket (`:223-225`). The only state
  file the engine writes is the local-app record (`core/src/env/environment-service.ts:316-320`).
- **Ownership-proof precedent:** `signal()` maps `ESRCH`→`gone`, `EPERM`→`foreign` and never
  escalates against a foreign target (`core/src/env/node-local-app-runner.ts:249-262`);
  `isOurListener` (`:211-217`); "only signal what we can still prove is ours"
  (`core/src/env/environment-service.ts:558-565`).
- **Detached-spawn precedent, line for line:** `openSync(logPath,'a')` → `spawn(..., { cwd, detached: true, stdio: ['ignore', fd, fd] })`
  → `child.unref()` → `closeSync(fd)` → throw if no pid (`core/src/env/node-local-app-runner.ts:104-116`).
- **Config is read once, at boot** (`core/src/cli/commands/serve.ts:9-19`) and `GET /config` serves
  that captured object (`core/src/api/server.ts:566-571`, wired at `core/src/host/build-engine.ts:217`)
  — so a saved edit only takes effect on restart.
- **`GET /config` cannot be an identity probe:** it 404s when the server has no config dep
  (`core/src/api/server.ts:566-570`).
- **A restart cancels running work:** `close()` stops the scheduler, then every active run, then the
  local app (`core/src/host/serve.ts:180-211`); boot clears every claim (`:139-142`) and reaps only
  its own recorded group (`:118-133`).
- **"What is running" is two counters and both already exist (R21).**
  `PipelineService.activeSessionIds()` → `StageRunner`'s in-memory active map
  (`core/src/pipeline/pipeline-service.ts:848-850`, `core/src/pipeline/stage-runner.ts:53`) misses a
  stage still *preparing* its environment — the W4 comment says so at
  `core/src/host/serve.ts:196-200`. Preparations live in `EnvironmentService.inFlight`
  (`core/src/env/environment-service.ts:124`, set synchronously at `:371`, drained by `abortAll()`
  at `:389-393`), which needs one new getter (`inFlightCount()` → `this.inFlight.size`).
  `ApiServerDeps.pipeline` is required and `.environment` optional (`core/src/api/server.ts:61-83`),
  so `activeRuns` is computable on a dep-free server.
- **`listenOnSocket` cannot be the mutual-exclusion primitive (R22).** Its liveness test is a
  *connect* (`core/src/api/listen.ts:12-23`) and it `unlink`s a socket nobody answers (`:29-32`), so
  two simultaneous starts can both proceed and the loser can unlink the winner's fresh socket.
  `engine.json` created with `'wx'` before listening is the lock.
- **`SessionFileSystem` has no exclusive create** — `readFile/writeFile({mode})/statMode/
  statMtimeMs/remove/rename/readdir/mkdir/exists` and nothing else
  (`core/src/fs/session-file-system.ts:1-14`). `serve()` already imports `unlink` from
  `node:fs/promises` directly for the socket (`core/src/host/serve.ts:1`), so R22's `open(path,'wx')`
  follows an existing precedent instead of widening the adapter.
- **`test/host/serve.test.ts` already mixes a real temp dir with an in-memory adapter** (`mkdtemp`
  for the socket, `InMemoryFileSystem` as the adapter, `existsSync` for real-FS assertions,
  imports at `:1-22`) — so A2's `engine.json` assertions point `stateDir` at that real temp dir.
- **A `repos: []` template cannot load today:** `repos` is `.min(1)` and `me` is required
  (`core/src/config/core-config.ts:56-58`); a zod failure becomes `ConfigError` (`:158-163`) and
  `serve` exits 1. Zero repos is otherwise inert — the scanner loops over `config.repos`
  (`core/src/inventory/inventory-scanner.ts:60-78`).
- **`writeCoreConfig` is the one config writer:** tmp → `0600` → rename, derived defaults stripped
  (`core/src/config/core-config.ts:257-289`).
- **Every derived path must be registered twice** — `resolveCoreConfig`'s `expandOrDerive`
  (`core/src/config/core-config.ts:99-111`) and `DERIVED_PATH_SUFFIXES` (`:257-265`) — documented at
  `core/docs/ARCHITECTURE.md:525-529`.
- The core's only runtime dependency is `zod` (`core/package.json:19-21`); `engines.node: ">=20"`
  (`:5-7`); `core/dist` is gitignored and untracked (`git ls-files cgremlin/core/dist` → 0).
- `buildEngine` already receives the resolved `config` and an optional clock
  (`core/src/host/build-engine.ts:204`, `:206-221`).
- `core/src/index.ts` is `export const VERSION = '0.0.1'`, exposed over HTTP nowhere.

**Extension facts**
- `CoreClient` holds the socket path as a constructor field (`vscode/src/core-client.ts:105`, used at
  `:118`); `SseClient` fixes its options at construction (`vscode/src/sse.ts:99-101`) and reads
  `opts.socketPath` per attempt (`:156`). `EngineNotRunningError` fires only for
  `ENOENT`/`ECONNREFUSED` (`:62`, `:127-129`).
- MG-B1 is two exact assertions this phase must extend on purpose: `pureSourceFiles()`
  (`vscode/test/purity.test.ts:9-15`) and the `vscode`-import allow-list plus the **exact** `src/ui/*`
  basename list (`:38`, `:54-75`).
- **The pure-module half is a plain substring check** — `source.includes('vscode')`
  (`vscode/test/purity.test.ts:26`) — while the whole-tree half is an import regex that explicitly
  tolerates prose (`:51`). So any file added to `pureSourceFiles()` may not contain the string
  `vscode` **even in a comment** (R30).
- `cgremlin.startEngine` is referenced by `vscode/src/ui/notifications.ts:56` and
  `vscode/src/ui/status-bar.ts:39`, with a wiring test at
  `vscode/test/ui/command-wiring.test.ts:118-126`.
- Cross-package build precedent: `"test:integration": "pnpm --dir ../core build && …"`
  (`vscode/package.json:232`); `F5` runs `pnpm build` via `.vscode/tasks.json`.
- The integration harness already spawns the engine as `process.execPath [entry] serve --config …`
  with a redirected `HOME` (`vscode/test/support/core-harness.ts:152-162`) and polls for the socket
  10 s at 25 ms (`:347-359`).

**Platform facts I executed on this machine**
- `code --version` → **1.137.0**. The extension host binary answers
  `ELECTRON_RUN_AS_NODE=1 … "Code Helper (Plugin)" -e "console.log(process.version)"` → **v24.18.1**
  (Electron 42.10.0). So `process.execPath` + `ELECTRON_RUN_AS_NODE=1` is a Node ≥ 20 host for the
  engine, satisfying `core/package.json`'s `engines.node`.
- **`vsce` is not installed** (`which vsce` empty, `npx vsce` refused) and neither package depends on
  it — packaging is unverifiable until Task C1 adds `@vscode/vsce` (R19).
- Shell Node is `v24.18.0`; `esbuild` is not currently a dependency of either package.
- The `Code Helper (Plugin)` binary **exists on this machine**, so R25's real-`execPath` case runs
  here rather than skipping.
- `env -i HOME=$HOME SHELL=/bin/zsh /bin/zsh -lic 'echo $PATH'` returned in **0.83 s** with a PATH
  containing `/opt/homebrew/bin` and the nvm bin dir — R20's probe and its 5 s cap, measured.
- `git remote -v` → `origin https://github.com/guilleazoubel/context-gremlin.git`;
  `cgremlin/vscode/package.json` has `"license": "UNLICENSED"` (`:8`), **no** `repository` field, and
  there is **no** `LICENSE` file in the repo — the three inputs to R28's manifest decision.

**Every `~/.cgremlin` reference the rename must walk** (grep, excluding `node_modules`/`dist`/`out`):
`core/src/config/core-config.ts:69`, `core/src/cli/command-io.ts:11,14,19`,
`core/src/cli/commands/config.ts:5` (**legacy read — stays**), `core/src/cli/main.ts:21`,
`core/src/pipeline/prompts.ts:82` (comment), `vscode/src/settings.ts:16-17`,
`vscode/package.json:116,121`; **tests — re-grepped 2026-09-10: six files, not the "ten"/"eleven"
earlier drafts claimed** (see Task A1 for the by-path list and what stays);
docs `core/README.md:23,46,63,132,192,195,241`,
`core/docs/ARCHITECTURE.md:433`, `vscode/README.md:71-72`, `vscode/docs/SMOKE.md:19,32-57,70`.
Historical phase specs under `core/docs/superpowers/specs/` are **not** rewritten.

**UNVERIFIED (and how each is closed)**
- `vsce package` behaviour with pnpm and `--no-dependencies` — closed by Task C1 recording
  `pnpm vsce ls` output as evidence, and by MG-C8.
- Whether `require`ing the bundle from the extension host has an unacceptable activation cost —
  closed by Task B1 logging the load duration and Task C2 asserting it is under 250 ms on this
  machine.
- Whether a GUI-launched VS Code hands the engine a `PATH` containing `claude`/`gh` — closed by R10
  (the engine logs its effective `PATH` as its first line) and by the smoke pass, not by code.

## Global Constraints

- Core: commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
  green at every commit. Extension: commands from `cgremlin/vscode/`; `pnpm test && pnpm build &&
  pnpm lint` green at every commit.
- **The extension never unlinks a socket file and never signals a process it cannot prove is
  cgremlin-core** (spec §4.2; MG-C2). Stale-socket recovery stays the engine's job
  (`core/src/api/listen.ts:26-32`).
- **No `SIGKILL` anywhere** (R3) and **no second signal** — a stop that outlasts its 45 s budget
  becomes the `stopping` state and keeps probing (R23), it never escalates. Only `serve()`'s own
  `close()` stops agents, clears claims and stops the local app in the correct order
  (`core/src/host/serve.ts:173-230`). Every signal is preceded by a **fresh** two-part proof (R29).
- **No restart, from any trigger, without consulting `GET /version`'s `activeRuns`** (R21):
  `0` → restart automatically and log one line; `> 0` → a modal prompt. `/attention` is not an input
  to this decision.
- **`engine.json` is a lock, not a report** (R22): `serve()` creates it with `'wx'` **before**
  `listenOnSocket`, exits 1 with `SocketInUseError` when a live owner holds it, takes over only a
  provably dead one, and removes it in `close()`'s `finally` *and* on a failed listen.
- **The string `vscode` may not appear — in code or prose — in any file listed by
  `pureSourceFiles()`** (`vscode/test/purity.test.ts:26` is a plain `includes`), which after this
  phase includes `src/engine/bridge.ts` and `src/engine/manager.ts` (R30).
- **The extension owns no path derivation.** `stateDir`, `socketPath`, `sessionsDir`,
  `worktreesDir`, `enginePidPath` and `engineLogPath` come from one call into the bundled bridge
  (MG-C6). `expandHome` survives in `settings.ts` only for the `~` in the setting itself.
- **The extension keeps zero runtime dependencies** and imports `vscode` in exactly two files —
  `extension.ts` and `settings.ts` (`vscode/test/purity.test.ts:38`). New pure modules are added to
  `pureSourceFiles()` and new `ui/*` modules to the exact basename list, deliberately, in the task
  that creates them.
- **Every new config field is additive and defaulted**, and every derived path is registered in
  **both** `resolveCoreConfig` and `DERIVED_PATH_SUFFIXES` (`core/docs/ARCHITECTURE.md:525-529`).
  Every `core.json` on disk must keep loading, including one with an explicit `stateDir: "~/.cgremlin"`.
- **`cgremlin-core` keeps working standalone with the same defaults** (D7): every behaviour the
  extension uses is reachable from the CLI (`serve`, `config init`, `config import-legacy`).
- **The engine's own posture is unchanged:** it still never posts to GitHub, never renders HTML and
  never spawns a terminal; the extension now spawns exactly one process (the engine), with the same
  detached posture the engine uses for its own children.
- Branches, all off `mission-control-pr-orchestrator`: **`phase8-core`** (A1→A4, one agent),
  **`phase8-ext`** (B1→B3, one agent, developed against fakes so it does not wait for A),
  **`phase8-pack`** (C1→C3 on the merged base). Merge order: `phase8-core`, then `phase8-ext`, then C.

## File Structure

**Stream A (core):** create `src/version.ts`, `src/host/engine-main.ts`,
`src/host/extension-bridge.ts`, `src/cli/commands/config-init.ts` (or a subcommand inside
`src/cli/commands/config.ts` — see A3), `test/host/engine-identity.test.ts`,
`test/api/version-route.test.ts`, `test/cli/config-init.test.ts`; modify
`src/config/core-config.ts`, `src/cli/command-io.ts`, `src/cli/main.ts`,
`src/cli/commands/config.ts`, `src/api/server.ts`, `src/host/build-engine.ts`, `src/host/serve.ts`,
`src/env/environment-service.ts` (one getter, R21), `package.json`, and the **five** core test files
tabulated in Task A1 (the sixth `~/.cgremlin` file is the extension's and moves in B1).

**Stream B (extension):** create `src/engine/bridge.ts`, `src/engine/manager.ts`,
`src/engine/node-engine-process.ts`, `src/ui/engine.ts`, `test/engine/manager.test.ts`,
`test/engine/bridge.test.ts`, `test/engine/node-engine-process.test.ts`; modify `src/settings.ts`,
`src/core-client.ts`, `src/sse.ts`, `src/extension.ts`, `src/ui/wiring.ts`, `src/ui/host.ts`,
`src/ui/commands.ts`, `src/ui/status-bar.ts`, `src/ui/notifications.ts`, `package.json`,
`test/purity.test.ts`, `test/ui/command-wiring.test.ts`, `test/support/fake-host.ts`.

**Convergence:** create `cgremlin/vscode/.vscodeignore` and
`cgremlin/vscode/test/packaging/vsix-contents.test.ts`; modify `cgremlin/vscode/package.json`,
`cgremlin/vscode/.gitignore`, `cgremlin/vscode/test/support/core-harness.ts`,
`cgremlin/vscode/test/integration/real-engine.test.ts`, `cgremlin/vscode/docs/SMOKE.md`,
`cgremlin/vscode/README.md`, `cgremlin/core/README.md`, `cgremlin/core/docs/ARCHITECTURE.md`,
`cgremlin/core/docs/DECISIONS.md`, root `README.md`.

---

## Stream A — core. Strictly sequential on one branch: A1 changes the schema every later task's tests assert against.

### Task A1: `stateDir` default, `repos` default, two new derived paths — tier `executor-heavy`

**Depends on:** R4 (drop `repos.min(1)`), R13 (`enginePidPath`/`engineLogPath`), R14 (rename test
fixtures). **Escalated tier** because it touches the schema every other core test loads through and
because a half-registered derived path is the documented failure mode
(`core/docs/ARCHITECTURE.md:525-529`).

**Files:** modify `src/config/core-config.ts`, `src/cli/command-io.ts`, `src/cli/main.ts` (usage
text only), and **exactly these five core test files, which hard-code `~/.cgremlin` as a scratch
state dir** (re-grepped 2026-09-10 —
`grep -rn '\.cgremlin' cgremlin/core/test cgremlin/vscode/test` → 35 matches in 7 files; earlier
drafts of this plan said "ten", which was wrong):

| # | Path | Lines | What moves |
|---|---|---|---|
| 1 | `cgremlin/core/test/config/core-config.test.ts` | `33-38`, `50`, `210-211`, `258`, `267` | every default-resolution assertion → `.cgremlin-core` |
| 2 | `cgremlin/core/test/cli/config.test.ts` | `25-26`, `31`, `33`, `43-44`, `54-55`, `59`, `64-65`, `76-77` | **only** the written target (`:31`, `:33`, `:59`); the legacy *input* `${HOME}/.cgremlin/config` **stays** |
| 3 | `cgremlin/core/test/env/environment-service.test.ts` | `19-20`, `129`, `590` | scratch `SESSIONS_DIR`/`STATE_PATH`/`readdir` root |
| 4 | `cgremlin/core/test/host/build-engine.test.ts` | `209`, `242` | `/home/e2e/.cgremlin` → `/home/e2e/.cgremlin-core` |
| 5 | `cgremlin/core/test/api/local-routes.test.ts` | `15` | scratch `local-app.json` path |

The sixth file, `cgremlin/vscode/test/workspace-file.test.ts:4-6` (`/home/me/.cgremlin/...`), belongs
to Stream B and is renamed in Task B1. `cgremlin/vscode/test/support/core-harness.ts:15` is **prose**
("The legacy `~/.cgremlin` state dir is never touched") and is left alone — it needs no exemption,
because MG-C4's pattern is `\.cgremlin/` with a trailing slash and that line has none. After this
task, that pattern's only legitimate hits are `core/src/cli/commands/config.ts:5`,
`core/src/cli/main.ts:21`, `core/src/pipeline/prompts.ts:82` and the legacy input lines of
`core/test/cli/config.test.ts`.

**Interfaces (produce):** `stateDir` default `'~/.cgremlin-core'`;
`repos: z.array(z.string().regex(...)).default([])`; `enginePidPath?: string` derived as
`<stateDir>/engine.json`; `engineLogPath?: string` derived as `<stateDir>/engine.log`;
`defaultConfigPath(home) === `${home}/.cgremlin-core/core.json``.

- [ ] **RED** — `test/config/core-config.test.ts`:
  - the default resolution now yields `${HOME}/.cgremlin-core` and `${HOME}/.cgremlin-core/{sessions,worktrees,mirrors,engine.sock,inventory.json,local-app.json,attention-acks.json,engine.json,engine.log}`
    (rewrite of `:33-38`, `:50`, `:210-211`, `:258`, `:267`);
  - **a config with an explicit `stateDir: '~/.cgremlin'` still resolves every path under it** — the
    regression pin that the rename is a *default* change, not a hard-coded path change;
  - `{ me: 'x' }` with **no `repos` key** parses, and `repos` is `[]`; `{ me: 'x', repos: [] }` parses;
    `{ repos: ['o/r'] }` with no `me` still **fails** (R4's deliberate asymmetry — assert the error
    mentions `me`);
  - `enginePidPath`/`engineLogPath` are derived when absent **and** omitted from a persisted file
    when they equal the derived default (`writeCoreConfig` round-trip — the `DERIVED_PATH_SUFFIXES`
    half; mutation that must fail this: registering the field in `resolveCoreConfig` only);
  - an explicit `enginePidPath: '~/elsewhere/e.json'` is `~`-expanded and survives persistence.
  - `test/cli/command-io.test.ts` (or the existing CLI tests): `defaultConfigPath` is under
    `.cgremlin-core`, while `legacyConfigPath` in `src/cli/commands/config.ts:4-6` still reads
    `${home}/.cgremlin/config` (assert both in one test, so the two paths can never be "fixed"
    together by accident).
  - Rename the scratch state dirs in the five files tabulated above, honouring the "what moves"
    column, so MG-C4's grep is meaningful; then run
    `grep -rn '\.cgremlin/' cgremlin/core/src cgremlin/core/test | grep -v '\.cgremlin-core'` and
    confirm the output is exactly the four legitimate hits named above.
- [ ] **GREEN** — implement. Two edits per new path, in `resolveCoreConfig`'s `expandOrDerive` block
      and in `DERIVED_PATH_SUFFIXES`.
- [ ] Commit `feat(cgremlin-core)!: default the state dir to ~/.cgremlin-core and derive the engine pid/log paths`.

### Task A2: `GET /version` + `activeRuns`, and the `engine.json` lock — tier `executor-heavy`

**Depends on:** A1 (`enginePidPath`), R1, R13, **R21** (the `activeRuns` field) and **R22** (the
`O_EXCL` lock, which reverses this task's original write ordering). **Tier escalated from `executor`
in this revision:** R22 makes this the task that owns mutual exclusion between engines, and it now
also touches `EnvironmentService`.

**Files:** create `src/version.ts`, `test/api/version-route.test.ts`,
`test/host/engine-identity.test.ts`; modify `src/api/server.ts`, `src/host/build-engine.ts`,
`src/host/serve.ts`, `src/env/environment-service.ts` (one getter), `test/host/serve.test.ts`.

**Interfaces (produce):** `ENGINE_VERSION`;
`ApiServerDeps.engineInfo?: { version: string; pid: number; startedAt: string; socketPath: string }`;
`EnvironmentService.inFlightCount(): number` (returns `this.inFlight.size`,
`src/env/environment-service.ts:124`); route `GET /version` →
`200 { version, pid, startedAt, socketPath, activeRuns }` where `activeRuns` is computed **per
request** as `pipeline.activeSessionIds().length + (environment?.inFlightCount() ?? 0)` (R21).

- [ ] **RED** —
  - `ENGINE_VERSION` equals `package.json`'s `version` (the test reads the file at runtime; an import
    would break `rootDir: "src"`);
  - `GET /version` answers **200 on a server built with no other deps at all** — this is the property
    that makes it a probe (`/config` 404s in exactly that case, `src/api/server.ts:566-570`); assert
    `/config` still 404s on the same server, side by side, so the distinction is pinned;
  - `pid` equals `process.pid` and `socketPath` equals the resolved config's; `startedAt` parses as a
    date and is stable across two calls (it is captured once at build time, not per request);
  - **`activeRuns` (R21) is computed per request and covers both terms**: `0` on an idle server;
    `1` while a fake `StageRunner` reports one active session; `1` while
    `EnvironmentService.inFlight` holds one entry and the pipeline reports **none** (the W4 case at
    `src/host/serve.ts:196-200` — mutation that must fail this: counting only
    `pipeline.activeSessionIds()`); `2` for one of each; and it changes between two successive
    `GET /version` calls on the same server (mutation that must fail this: capturing it in
    `engineInfo` at build time);
  - **`engine.json` is the lock, taken before the socket (R22).** `serve()` `open`s
    `config.enginePidPath` with flag `'wx'` and mode `0600` **before** `listenOnSocket`. Assert:
    the file exists (and has mode `0600`) once `serve()` resolves; a **second** `serve()` against the
    same `stateDir` while the first is alive rejects with `SocketInUseError` and leaves the first
    engine's file and socket **untouched** (byte-compare the file, and `GET /version` on the socket
    still answers); an `engine.json` naming a **dead** pid (e.g. a pid from a process that has
    exited, or a pid whose socket does not answer and which `process.kill(pid,0)` reports `ESRCH`) is
    **taken over** — removed, rewritten, engine boots; a `listenOnSocket` failure **removes** the
    lock the same call created (force it by pre-creating a live listener on the socket path only,
    with no `engine.json`, so the lock is taken and then the listen fails);
    `stateDir` points at the test's real `mkdtemp` dir, since this write bypasses the in-memory
    adapter by design (§2);
  - the file's content is exactly `{ pid, version, socketPath, startedAt }` and its `pid`/`version`
    match `GET /version` byte for byte (this equality *is* the ownership proof MG-C2 rests on);
  - `close()` removes it, and **still removes it when a `pipeline.stop()` inside `close()` throws**
    (the existing `finally` at `src/host/serve.ts:214-228` is where it goes; mutation that must fail
    this: putting the removal in the `try`);
  - a leftover `engine.json` from a *dead* previous boot is replaced (not appended to, not merged),
    and a `SIGTERM`-driven `close()` (via `handle.onSignal('SIGTERM')`) removes it too;
  - **MG-C1's two-process race (R22)**: start two real `serve` processes concurrently against one
    `stateDir` (`spawn` the built CLI twice with no delay, the way
    `vscode/test/support/core-harness.ts:152-162` spawns one) and assert **exactly one** comes up —
    the loser exits **1** with `listen.ts`'s `SocketInUseError` wording on stderr, the winner's
    socket answers `GET /version`, and the winner's `engine.json` names the winner's pid. Run the
    race a handful of times so a lucky ordering cannot pass it. (The manager-level half of this
    guard is B2's; the two-`serve` half is here.)
- [ ] **GREEN** — implement. `buildEngine` assembles `engineInfo` using its existing clock
      (`src/host/build-engine.ts:204`) and passes the two counters as callbacks (or reads them off
      the deps it already holds) so `activeRuns` stays per-request. The lock uses `open()` from
      `node:fs/promises` directly — `SessionFileSystem` has no `O_EXCL`
      (`src/fs/session-file-system.ts:1-14`) and `serve()` already bypasses the adapter for the
      socket (`src/host/serve.ts:1`). Wrap `listenOnSocket` in a `try/catch` that removes the lock
      and rethrows.
- [ ] Commit `feat(cgremlin-core): GET /version with activeRuns, and an engine.json lock that admits one engine per state dir`.

### Task A3: `cgremlin-core config init` — tier `executor`

**Depends on:** A1 (`repos` default), R5.

**Files:** modify `src/cli/commands/config.ts`, `src/cli/main.ts` (usage text); tests
`test/cli/config-init.test.ts`.

**Interface (produce):** `cgremlin-core config init [--me <login>] [--force]` — writes
`{ me, repos: [], runner: 'claude-code' }` through `resolveCoreConfig` + `writeCoreConfig` to
`configPathFor(io)`, prints the path, exit 0.

- [ ] **RED** —
  - the written file is mode `0600`, contains `repos: []`, contains **no** derived path key
    (`sessionsDir`, `socketPath`, `enginePidPath`, …), and `loadCoreConfig` accepts it;
  - `--me` missing → exit 2 with a message naming `--me` (the CLI never invents a `me`; R4);
  - an existing file → exit 1 with `writeCoreConfig`'s own "already exists" wording, and the file is
    **unmodified** (assert bytes); `--force` overwrites;
  - `config nonsense` still exits 2 with the existing unknown-subcommand message (the regression pin
    for `src/cli/commands/config.ts:38-44`);
  - `config import-legacy` still reads `${home}/.cgremlin/config` and now writes under
    `.cgremlin-core` (one test asserting both halves — U3 means nothing calls this automatically, but
    it must still work).
- [ ] **GREEN** — implement.
- [ ] Commit `feat(cgremlin-core): config init writes a loadable first-run core.json`.

### Task A4: the two esbuild bundle entry points and the build script — tier `executor`

**Depends on:** A2 (`ENGINE_VERSION`), R8.

**Files:** create `src/host/engine-main.ts`, `src/host/extension-bridge.ts`; modify `package.json`
(add `esbuild` devDependency + `build:engine` script); tests `test/host/extension-bridge.test.ts`,
plus a bundle smoke test.

**Interfaces (produce):**
- `src/host/engine-main.ts` — `import { run } from '../cli/main'; void run();` (nothing else, so the
  bundle is directly runnable);
- `src/host/extension-bridge.ts` — `export { ENGINE_VERSION }` and
  `export async function loadResolvedConfig(path: string, home: string): Promise<ResolvedEnginePaths>`
  (a wrapper over `NodeFileSystem` + the existing `loadCoreConfig`, returning
  `{ configPath, stateDir, socketPath, sessionsDir, worktreesDir, enginePidPath, engineLogPath, repos, me }`);
- `build:engine` producing `../vscode/engine/engine.js` and `../vscode/engine/bridge.js`
  (`--bundle --platform=node --format=cjs --target=node20 --sourcemap=inline` — inline, per R28, so
  a crash yields a readable trace and there is no external `.map` for `.vscodeignore` to strip);
- `engine-main.ts` also **scrubs its own environment** (R24): as its first statement it deletes
  `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and every `^VSCODE_` key from `process.env`, before
  `require`/`run()`, so every `bash -lc` the engine later spawns
  (`src/agent/claude-code-runner.ts:80`) inherits a clean environment even when the manager's own
  sanitization was bypassed. Deleting `ELECTRON_RUN_AS_NODE` at that point is safe — Electron reads
  it at process start. It also honours the debug flag `CGREMLIN_ENGINE_PRINT_ENV=1`, which prints
  `{ electronRunAsNode, nodeOptions, vscodeKeys, nodeVersion, electronVersion }` as JSON to stdout
  and exits 0 **without starting an engine** — the testable seam R24 and R25 both use.

- [ ] **RED** —
  - `loadResolvedConfig` on a temp `core.json` returns paths **identical** to `resolveCoreConfig`'s
    for the same input (assert field-by-field against the loader itself — this is the assertion that
    the bridge adds no derivation of its own);
  - a missing file rejects with the engine's own `No config file found at '<path>'` wording
    (`src/config/core-config.ts:147-150`), and an invalid one with the `ConfigError` text — the
    extension surfaces both verbatim;
  - a `0644` file carrying a bypass secret still rejects with the `chmod 600` instruction
    (`:164-171`) — proving the bridge goes through `loadCoreConfig`, not `resolveCoreConfig` alone;
  - **bundle smoke (runs `build:engine` in the test, skipping with a clear message if `esbuild` is
    absent):** `node ../vscode/engine/engine.js --help` prints `USAGE` and exits 0;
    `require('../vscode/engine/bridge.js').ENGINE_VERSION === ENGINE_VERSION`; neither bundle
    contains the string `require('zod')` (i.e. zod really is inlined, so the vsix needs no
    `node_modules`); each bundle carries an **inline** sourcemap comment
    (`//# sourceMappingURL=data:application/json;base64,`) and **no** `engine/*.map` file was
    emitted (R28); `engine.js` boots a real engine on a temp socket and answers `GET /version`;
  - **R24 self-scrub:** spawn `node ../vscode/engine/engine.js` with `CGREMLIN_ENGINE_PRINT_ENV=1`
    **and** `ELECTRON_RUN_AS_NODE=1`, `NODE_OPTIONS=--max-old-space-size=99`, `VSCODE_PID=1`,
    `VSCODE_CWD=/x` in its environment; parse the printed JSON and assert `electronRunAsNode` and
    `nodeOptions` are absent/undefined and `vscodeKeys` is `[]` (mutation that must fail this:
    deleting only `NODE_OPTIONS`, or scrubbing after `run()`).
- [ ] **GREEN** — implement.
- [ ] Commit `build(cgremlin-core): esbuild bundles for the engine and the extension bridge, and an engine that scrubs the editor's env`.

---

## Stream B — extension. Sequential on one branch. Developed against fakes, so it does not wait for Stream A.

### Task B1: one setting, a live socket path, the bridge loader — tier `executor`

**Depends on:** R7 (provider function), R9 (locally-declared bridge type). Runs against a
hand-written fake bridge; the real artifact arrives with Stream A.

**Files:** modify `src/settings.ts`, `src/core-client.ts`, `src/sse.ts`, `package.json`
(`contributes.configuration`), `test/purity.test.ts`, `test/core-client.test.ts`, `test/sse.test.ts`,
`test/workspace-file.test.ts` (`:4-6` — the sixth `~/.cgremlin` fixture file from A1's table, renamed
here because it is Stream B's); create `src/engine/bridge.ts`, `test/engine/bridge.test.ts`.

**Interfaces (produce):** `Settings = { configPath: string; notificationLevel: NotificationLevel }`;
`DEFAULT_CONFIG_PATH = '~/.cgremlin-core/core.json'`; `DEFAULT_SOCKET_PATH` **deleted**;
`CoreClient(socketPath: string | (() => string))`;
`SseClientOptions.socketPath: string | (() => string)`;
`loadBridge(extensionPath: string): EngineBridge` + the `ResolvedEnginePaths`/`EngineBridge`
interfaces from spec §4.1.

- [ ] **RED** —
  - `CoreClient` built with a provider re-reads it **per request**: point the provider at a stub
    server, make a call, re-point it at a second stub server, and assert the second call reached the
    second server (mutation that must fail this: resolving the provider once in the constructor);
  - `SseClient` built with a provider re-reads it **per connection attempt**: kill server A, re-point
    the provider at server B, and assert the reconnect lands on B (this is what makes D5 work without
    a window reload);
  - a string argument still behaves exactly as today for every existing test (the whole of
    `test/core-client.test.ts` and `test/sse.test.ts` must pass unchanged apart from the two new
    cases);
  - `readSettings()` returns two fields; **MG-C3**: a grep of `cgremlin/vscode/src`,
    `cgremlin/vscode/test`, `cgremlin/vscode/package.json` and `cgremlin/vscode/README.md` for
    `socketPath` finds only the `CoreClient`/`SseClient`/bridge plumbing and **no** `cgremlin.socketPath`
    setting;
  - `loadBridge` against a fixture bundle (a two-line CJS file in `test/support/`) returns its
    exports; against a missing path it throws a message naming the expected artifact and the
    `pnpm build` that produces it (the "ran tsc, not build" case), and the message is asserted
    verbatim;
  - `test/purity.test.ts`: `src/engine/bridge.ts` and `src/engine/manager.ts` are added to
    `pureSourceFiles()` and the `vscode`-free assertion covers them (the allow-list at `:38` is
    untouched — no new file imports `vscode`). **R30:** that assertion is a plain
    `source.includes('vscode')` (`:26`), so neither file may contain the string at all — write "the
    editor" or "the extension host" in their comments. Add one test that fails if a pure module
    merely *mentions* it, so the rule is enforced rather than remembered;
  - `test/workspace-file.test.ts:4-6` fixtures move to `.cgremlin-core` (A1's table, row 6);
  - **MG-C6** (first half): grep `cgremlin/vscode/src` for `engine.sock` → empty.
- [ ] **GREEN** — implement.
- [ ] Commit `refactor(cgremlin-vscode)!: one configPath setting, and a socket path resolved per request`.

### Task B2: the engine manager — tier `executor-heavy`

**Depends on:** B1, and R1/R2/R3/R10/R11/R18, plus **R20** (login-shell `PATH`), **R21**
(`activeRuns` in the probe body), **R23** (45 s stop budget, `stopping`), **R26** (child supervision
and respawn backoff), **R29** (re-prove before every signal) and **R30** (rotate → spawn → tail).
**Escalated tier:** this is the task that can kill a process, and MG-C2 is its whole reason for
existing.

**Files:** create `src/engine/manager.ts`, `src/engine/node-engine-process.ts`,
`test/engine/manager.test.ts`, `test/engine/node-engine-process.test.ts`,
`test/support/fake-engine-process.ts`.

**Interfaces (produce):** exactly spec §4.3 — `EngineState`, `EngineProcessPort`, `EngineManager`
with `ensureRunning`/`stop`/`restart`/`state`/`onStateChange`.

- [ ] **RED** — `manager.test.ts` against `FakeEngineProcess` and a fake clock:
  - **MG-C1 `no-second-engine`**: a probe that answers with the bundled version → `running{adopted:true}`
    and `spawnDetached` was called **zero** times; then five `ensureRunning()` calls in one tick with
    a *silent* socket → exactly **one** `spawnDetached` (the memoized in-flight promise, mirroring
    `serve()`'s memoized `close()`, `core/src/host/serve.ts:168-172`);
  - probe silent → `starting` is observed by `onStateChange` **before** the first poll, then
    `running{adopted:false}` on the first answering probe; and the recorded call order is
    `resolveLoginPath` → `rotateLog` → `spawnDetached` → first `probe` (**R30**; mutations that must
    fail this: rotating after the spawn, or starting the tail before the rotate);
  - **R20 `PATH`**: `resolveLoginPath` resolving a value → that value is the child's `PATH` and
    `process.env.PATH` is not; `resolveLoginPath` returning `null` (timeout, non-zero exit, empty
    output) → the child gets `process.env.PATH` **and exactly one** `engine.path_fallback` line was
    logged (assert the line, and that it is not repeated on the next spawn attempt within the same
    burst);
  - the spawn succeeds but the socket never answers → after 10 s of 100 ms polls,
    `failed{reason, logTail}` with the tail's last 20 lines, and **no** further spawn on the next
    `ensureRunning()` unless it is explicitly retried by the user;
  - the child reports no pid → `failed` immediately, with the log tail (the
    `node-local-app-runner.ts:112-114` failure mode);
  - **R26 supervision:** the child's `exit` handler fires while the state is `running` → `failed`
    with the log tail **immediately**, without waiting for a probe (assert the state transition
    happens on the exit callback, with the fake clock not advanced);
  - **R26 backoff**, on the fake clock, counting only automatic (non-user) `ensureRunning()` calls:
    after the 1st failed spawn a call at +0.5 s is refused with one logged line and **no**
    `spawnDetached`, and a call at +1.5 s spawns (retry 1); after that failure the gate is 5 s
    (+2 s refused, +6 s spawns — retry 2); then 30 s (+10 s refused, +31 s spawns — retry 3); after
    the third retry fails, **no automatic call ever spawns again**, however long the wait. A
    `failed` state is never auto-retried past that. A **user-initiated** `start()`/`restart()`
    spawns immediately at any point in that sequence and resets the backoff to the start (mutations
    that must fail this: applying the backoff to the user path, or letting the automatic path retry
    a fourth time);
  - probe answers a *different* version → `mismatch{running, bundled, pid}`, and `spawnDetached` and
    `signal` were both called **zero** times (R2);
  - probe answers something that is not a `/version` shape → `foreign`, and nothing is spawned or
    signalled;
  - **MG-C2 `never-kill-what-we-cannot-prove`**, four cases, each asserting `signal` was called zero
    times: no pid file; a pid file whose `pid` differs from `/version`'s; a pid file present but the
    socket silent; a pid file whose `socketPath` names a different socket. Then the happy path:
    both agree → exactly one `signal(pid,'SIGTERM')`, then polling until the probe goes silent →
    `stopped`. And: `signal` returning `foreign` (EPERM) or `gone` (ESRCH) never escalates and never
    retries (mutation that must fail this: adding a `SIGKILL` fallback);
  - **R29:** the proof is re-taken immediately before the signal — a fake whose second
    `readPidFile`/`probe` pair disagrees (different `pid`, or same `pid` with a different
    `startedAt`) after a first pair that agreed → `failed{reason}` and `signal` called **zero**
    times (mutation that must fail this: proving once and then signalling);
  - **R23 stop budget:** the engine keeps answering past the 45 s / 500 ms budget → the state
    becomes `stopping{elapsedMs}` (not `failed`), exactly **one** signal was sent, probing continues
    at 1 s, and a probe that goes silent at +2 min yields `stopped`; a probe still answering at the
    5-minute bound yields `failed{reason}` naming the log. Assert on the fake clock, and assert no
    second `signal` in any of those branches (mutation that must fail this: a `SIGKILL` or a repeat
    `SIGTERM` after the budget);
  - `restart()` = `stop()` then `ensureRunning()`. A `stop()` that reached `stopping` **defers** the
    restart until the socket goes silent and then spawns exactly once (R23); a `stop()` that ended
    in `failed` (no proof, or the 5-minute bound) **aborts** the restart — it must not spawn a
    second engine against a live socket (`serve()` would refuse it via R22's lock and
    `core/src/api/listen.ts:26-29`, but the manager must not try);
  - **MG-C1, manager half:** with a probe that answers, `spawnDetached` is never called; the
    two-process half of that guard is A2's and the real-process half is C2's;
  `node-engine-process.test.ts` (real Node, temp dirs):
  - `probe` against a real `http.Server` on a temp socket returns its `/version` body; against a
    path that does not exist → `null`; against a **stale socket file with nobody listening** → `null`
    (assert `ECONNREFUSED` is treated as "nobody home", matching `core-client.ts:62`), and in both
    cases assert the socket file **still exists** afterwards (the extension never unlinks);
  - `spawnDetached` of a fixture script writes into the log file, survives its parent's `unref`,
    and returns a real pid **and a handle whose `onExit` fires with the child's exit code** (R26);
    the child's env has `ELECTRON_RUN_AS_NODE=1`, the `PATH` R20 resolved, and **no** `NODE_OPTIONS`
    or `VSCODE_*` key (R10 — assert by having the fixture dump `process.env` into the log);
  - `resolveLoginPath` against a fake `$SHELL` script that echoes a known PATH returns it; against
    one that sleeps past the 5 s cap returns `null` within ~5 s and leaves no stray child (R20);
  - the log is **appended**, not truncated, across two spawns, and `rotateLog` moves it to
    `engine.log.1` when and only when it exceeds 8 MB — asserted **before** the spawn recreates it
    (R11/R30);
  - `signal` classifies `ESRCH` as `gone` and a pid it cannot signal as `foreign` — the same three
    outcomes as `core/src/env/node-local-app-runner.ts:249-262`.
- [ ] **GREEN** — implement. The spawn block is copied structurally from
      `node-local-app-runner.ts:104-116`; the probe uses `http.request({ socketPath })` like
      `CoreClient` (`core-client.ts:118`) and returns `activeRuns` alongside `version`/`pid` (R21).
      `signal` keeps `node-local-app-runner.ts:249-262`'s three outcomes verbatim. `execPath` stays a
      field of the spawn spec, injectable, because C2's R25 case supplies the real
      `Code Helper (Plugin)` path through it.
- [ ] Commit `feat(cgremlin-vscode): an engine manager that probes, starts and provably owns the engine it stops`.

### Task B3: host wiring — commands, status, first run, watchers — tier `executor-heavy`

**Depends on:** B2, and R2/R5/R6/R11/R12/R15/R16/R17, plus **R21** (the `activeRuns` gate and the
modal prompt), **R23** (`stopping` in the status bar), **R27** (validate-then-restart, and the `0600`
re-chmod) and **R30** (dispose both watches on deactivate; rotate → spawn → tail).
**Escalated tier:** it is the un-unit-testable editor surface plus two prompts whose wrong answer
cancels a user's running agent.

**Files:** create `src/ui/engine.ts`; modify `src/extension.ts`, `src/ui/wiring.ts`, `src/ui/host.ts`,
`src/ui/commands.ts`, `src/ui/status-bar.ts`, `src/ui/notifications.ts`, `package.json`
(`contributes.commands` + menus), `test/purity.test.ts`, `test/ui/command-wiring.test.ts`,
`test/support/fake-host.ts`.

**Interfaces (produce):** `Host` gains `openTextDocument(path: string): Promise<void>`,
`spawnCapture(cmd, args, opts): Promise<{ code: number; stdout: string; stderr: string }>` (for
`gh api user` and `config init`), `watchFile(dir, basename, cb): DisposableLike`,
`appendOutput(line: string): void` (the output channel, distinct from `log`),
`chmod(path: string, mode: number): Promise<void>` (R27's best-effort `0600` re-assert) and a
**modal** flag on the information-message call it already wraps (R21).
`StatusBarState` gains `engine: EngineState['kind']` — including `stopping`, rendered with its
elapsed seconds (R23). Commands `cgremlin.engine.start|stop|restart|showLog` replace
`cgremlin.startEngine` (R12).

- [ ] **RED** — with the fake `Host` and a fake `EngineManager`:
  - activation with an existing, valid `core.json`: exactly one `ensureRunning()`, and
    `connect()` happens **after** it reports `running` (assert the recorded order — connecting first
    is what produced the reported bug's misleading warning);
  - **first run (R5)**: `configPath` missing → `gh api user --jq .login` is attempted, then
    `config init --config <path> --me <login>` is run against the **bundled** `engine.js`, then
    `openTextDocument(configPath)`, then one information message, then `ensureRunning()` — in that
    order, with the exact argv asserted;
  - `gh` failing → an input box; **cancelling the input box writes nothing** (assert zero
    `spawnCapture` calls for `config init` and zero `writeFile`) and shows one warning naming the
    setting;
  - a `ConfigError` from the bridge → one warning carrying the engine's wording **verbatim** plus an
    `Open core.json` action that calls `openTextDocument`; **no** spawn is attempted;
  - **version mismatch (R2 as amended by R21)**: `mismatch` with the probe reporting
    `activeRuns > 0` → one **modal** information message naming both versions with
    `Restart engine`/`Not now`/`Show log`; picking `Restart engine` calls `restart()` once; picking
    `Not now` calls nothing, and the message is **not** shown again in the same session (assert one
    message across three state re-emissions). `mismatch` with `activeRuns === 0` → **no message at
    all**, exactly one `restart()`, and one line in the output channel (mutations that must fail
    this pair: prompting unconditionally, or restarting unconditionally);
  - `foreign` → one warning that offers `Show log`/`Settings` and calls neither `restart()` nor
    `stop()`;
  - **`engine.stop` (R16/R21)**: shows a confirmation naming the shared-daemon fact and the number
    of running items — read from `GET /version`'s `activeRuns`, **not** from the attention listing
    (mutation that must fail this: reading `/attention`); dismissing it calls `stop()` **zero**
    times; and while the manager reports `stopping`, the status bar shows `stopping… Ns` and a
    second `engine.stop` does not send a second signal (R23);
  - `engine.showLog` shows the output channel and offers to open `engineLogPath` — the path coming
    from the bridge, never joined by hand (**MG-C6**, second half: the assertion reads the recorded
    path and compares it to the fake bridge's value);
  - the log tail (R11) starts at the **current end of file** (write three lines before activation,
    assert none reaches the output channel; append one after, assert exactly that one does);
  - **config watcher (R6 as amended by R21/R27)**: a rename-in-place save (write `core.json.tmp`
    then rename over `core.json` — exactly what `writeCoreConfig` does,
    `core/src/config/core-config.ts:284-288`) is detected; two saves inside the 500 ms debounce
    window produce one action; the bridge's `loadResolvedConfig` is called **before** anything is
    restarted (assert the recorded order); on success the file is chmod'ed back to `0600` and then,
    with `activeRuns === 0`, the engine restarts silently, or with `activeRuns > 0` a modal prompt is
    shown and `restart()` runs only on the affirmative; a `chmod` that throws is logged as one line
    and does **not** block the restart; on a `ConfigError` the engine is left completely alone
    (`restart`/`stop`/`ensureRunning` all called zero times), the message is surfaced verbatim with
    `Open core.json`, and the **watcher is still armed** — a second, valid save restarts the engine
    (mutation that must fail this: disarming or disposing the watcher on the error path);
  - **live settings (D5, R7)**: `onDidChangeConfiguration` with a changed `configPath` re-resolves
    through the bridge, re-points the socket provider, stops+starts the SSE client, calls
    `connect()`, restarts the watcher and calls `ensureRunning()` — and calls `stop()` on the old
    engine **zero** times; a change that only touches `notificationLevel` does none of that;
  - status bar (R17): each `EngineState['kind']` renders its own text and click target
    (`stopped`/`failed` → `cgremlin.engine.start`; `starting` → `showLog`; healthy → the panel view);
    the existing connected/`N need you` text is unchanged for the healthy case (regression pin on
    `ui/status-bar.ts:18-25`);
  - **MG-C7 `no-engine-start-via-terminal`**: grep `cgremlin/vscode/src` — no `sendText` mentions
    `serve`, and `cgremlin.startEngine` appears nowhere (its two old call sites,
    `ui/notifications.ts:56` and `ui/status-bar.ts:39`, now name `cgremlin.engine.start`); the
    Phase 7 test at `test/ui/command-wiring.test.ts:118-126` is rewritten to assert
    `ensureRunning()` instead of a terminal;
  - `test/purity.test.ts`: the exact `src/ui/*` basename list (`:62-75`) gains `engine.ts`, and the
    `vscode`-import allow-list at `:38` is **unchanged**;
  - **R30 disposal**: `deactivate()` disposes both new `fs.watch` handles (the log tail and the
    config watcher) — assert both `dispose()` calls on the fake `Host`, and assert `stop()` on the
    engine is called **zero** times (R16: deactivate never stops the engine); a post-deactivate
    file change reaches neither the output channel nor `restart()`.
- [ ] **GREEN** — implement. `extension.ts` grows only adapters and wiring; every decision lives in
      `ui/engine.ts` or `engine/manager.ts`.
- [ ] Commit `feat(cgremlin-vscode): start, stop and watch the bundled engine from the editor`.

---

## Convergence — sequential, on the merged base (`phase8-core` then `phase8-ext`)

### Task C1: packaging — one `.vsix` that carries the engine — tier `executor`

**Depends on:** A4, B3, R8, R19, **R28**.

**Files:** create `cgremlin/vscode/.vscodeignore`; modify `cgremlin/vscode/package.json` (scripts,
`@vscode/vsce` devDependency, and the `repository` field per R28),
`cgremlin/vscode/.gitignore` (add `engine/`).

**`.vscodeignore` is exclude-only (R28)** — the format is a `.gitignore`-style deny list over an
otherwise-complete tree; there is no "include" syntax, so do not write one. Excluded: `src/**`,
`test/**`, `node_modules/**`, `docs/**`, `.vscode/**`, `**/*.ts`, `tsconfig*.json`,
`vitest.config.ts`, `eslint.config.js`, `pnpm-lock.yaml`, `**/*.map`, `.gitignore`, `.vscodeignore`.
`out/**/*.js`, `engine/**`, `README.md` and `package.json` ship because nothing excludes them.

**Manifest decision, already taken (R28) — do not re-decide:** add
`"repository": { "type": "git", "url": "https://github.com/guilleazoubel/context-gremlin.git" }`
(that is `origin`) and keep `"license": "UNLICENSED"` (`cgremlin/vscode/package.json:8`). Add a
`LICENSE` file only if `vsce` refuses without one. `--allow-missing-repository` is a last resort,
permitted only if `vsce` demands something not truthfully available. **If `vsce package` rejects the
manifest for any reason, record its exact failure text verbatim in the commit message** and fix the
manifest rather than silencing the check.

- [ ] `pnpm build` in `cgremlin/vscode` produces `engine/engine.js` **and** `out/extension.js` from a
      clean tree (`rm -rf out engine ../core/dist`), and `F5` still launches.
- [ ] `pnpm package` produces one `.vsix`. **Evidence to record in the commit message:** the full
      `pnpm vsce ls` output, and `unzip -l *.vsix | wc -l`.
- [ ] **MG-C8 `vsix-is-self-contained-and-lean`** (narrowed by R28): the listing contains
      `engine/engine.js`, `engine/bridge.js` and `out/extension.js`, and contains **no**
      `node_modules/`, `src/`, `test/`, `*.ts`, `docs/` entry and **no `out/**/*.map`**. It asserts
      nothing about `engine/*.map`, which by design do not exist — the engine bundles carry
      `--sourcemap=inline`. Recorded as a checked-in assertion script
      (`test/packaging/vsix-contents.test.ts`, skipped when no `.vsix` is present) so it is not a
      one-off manual check.
- [ ] Install the `.vsix` into the real editor (`code --install-extension <file>`), open a window
      with **no** `cgremlin.*` settings at all, and confirm: the engine starts, `~/.cgremlin-core/core.json`
      is created and opened, and `~/.cgremlin/` is **never created or touched** (`ls -la ~/.cgremlin`
      before and after — this is the U3/MG-C4 acceptance in the real world).
- [ ] Commit `build(cgremlin-vscode): package one vsix that carries the engine`.

### Task C2: integration against the bundled engine — tier `executor-heavy`

**Depends on:** C1, **R22** (the race), **R25** (the real `Code Helper (Plugin)` spawn).

**Files:** modify `cgremlin/vscode/test/support/core-harness.ts`,
`cgremlin/vscode/test/integration/real-engine.test.ts`; create
`cgremlin/vscode/test/integration/engine-manager.test.ts`; modify `package.json`
(`test:integration` also runs `build:engine`).

- [ ] **RED** — `startEngineViaManager()` seeds the same throwaway state dir the current harness does
      (`core-harness.ts:83-128`) but boots through the **real** `EngineManager` + `NodeEngineProcess`
      against `engine/engine.js` (not `bin/cgremlin-core`), with `HOME` redirected so
      `~/.cgremlin` stays unreachable (`:15`, `:157-158`). Then:
  - the socket appears within the manager's own timeout, and `GET /version.version` equals
    `loadBridge(...).ENGINE_VERSION` — **MG-C5**, the assertion that the version the extension
    advertises is the version it actually spawns;
  - a second `ensureRunning()` reports `running{adopted:true}` with **zero** additional processes
    (assert by pid, and by the log file not gaining a second boot line) — **MG-C1** over real
    processes;
  - **MG-C1's race, over real processes (R22)**: two `EngineManager` instances (each with its own
    `NodeEngineProcess`) calling `ensureRunning()` concurrently against **one** `stateDir` → exactly
    one engine exists (one pid, one `engine.json`, one boot line in the log); the loser either
    adopts the winner or reports the winner's version, and in no case is a second engine left
    running. Assert the surviving socket answers `GET /version` afterwards, and clean up by
    `stop()`ing through the manager that owns the proof;
  - **R25, the real editor host**: when
    `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`
    exists (it does on this machine — Ground Truth), spawn once with that binary as the spec's
    `execPath` and `ELECTRON_RUN_AS_NODE=1`, and assert **from the engine log** that the child
    reported a non-empty `process.versions.electron` and a `process.version` with major ≥ 20 (the
    values reach the log through A4's `CGREMLIN_ENGINE_PRINT_ENV` path). When the binary is absent,
    **skip with a message naming the path** — never silently pass;
  - `stop()` leaves **no** socket file and **no** `engine.json` (the same assertion the current
    harness makes about the socket, `core-harness.ts:184-186`);
  - **MG-C2** over real processes: rewrite `engine.json`'s `pid` to a live unrelated pid (the test's
    own `process.pid`), call `stop()`, and assert it refuses, sends no signal, and that
    `process.pid` is still alive;
  - `loadResolvedConfig` against the harness's real `core.json` returns exactly the paths the
    harness chose (the cross-layer version of A4's bridge test);
  - the whole existing Phase 7 integration suite passes against a manager-booted engine (run it with
    the new harness, unchanged otherwise) — the regression proof that nothing about the engine's
    behaviour changed;
  - `loadBridge` completes in under 250 ms (the activation-cost unknown from Ground Truth).
- [ ] **GREEN** — fix whatever the integration exposes, in the layer that is actually wrong. Do not
      loosen a type or widen a timeout to make it pass.
- [ ] Run the **manual smoke checklist** (`cgremlin/vscode/docs/SMOKE.md`, as rewritten in C3) end to
      end and record the result table.
- [ ] Commit `test(cgremlin-vscode): integration coverage for the bundled engine and its manager`.

### Task C3: documentation — tier `executor`

**Depends on:** C2.

**Files:** modify `cgremlin/vscode/docs/SMOKE.md`, `cgremlin/vscode/README.md`,
`cgremlin/core/README.md`, `cgremlin/core/docs/ARCHITECTURE.md`,
`cgremlin/core/docs/DECISIONS.md`, root `README.md`.

- [ ] `SMOKE.md` **step 0 rewritten** (replacing `:17-58`): install the `.vsix` (or open
      `cgremlin/vscode` and press `F5`); set `cgremlin.configPath` **only if** you want a state dir
      other than `~/.cgremlin-core`; everything else happens by itself. Delete the three-setting
      block at `:49-55` (there are two settings now, and neither is `socketPath`). Rewrite step 1
      (`:62-73`) around `cgremlin.engine.stop` / `engine.start` / `showLog` instead of
      `pkill`+`Start it`, and add a step 12 for the version handshake, the config-save restart and
      the first-run bootstrap on a machine with no `core.json`.
- [ ] `cgremlin/vscode/README.md`: the settings table (`:69-73`) loses `socketPath` and gains a
      sentence on derivation; the commands table (`:79-93`) gains the four `cgremlin.engine.*` rows
      and loses `Start the engine`'s terminal wording; a new "The bundled engine" section covering
      the detached posture, the shared-across-windows fact (R16), the log and its rotation, the
      version handshake, when a restart happens silently versus asks (R21), and the fact that
      closing the window does not stop the engine (R16/R30).
- [ ] `cgremlin/core/README.md`: `~/.cgremlin` → `~/.cgremlin-core` at `:46`, `:63`, `:132`, `:192`,
      `:195`; `:23` and `:241` keep the legacy path but say explicitly that it is *only* read by
      `config import-legacy`; the state-dir tree gains `engine.json` and `engine.log`; the route
      table gains `GET /version`; the CLI table gains `config init`; a note that `repos` may now be
      empty and what that means (no discovery, empty parking lot).
- [ ] `docs/ARCHITECTURE.md`: `GET /version` (including what `activeRuns` counts and why it needs
      both terms, R21) in the route table (`:379-415`); `config init` and the new default in the CLI
      table (`:424-435`, fixing `:433`); the two new derived paths in the config-field guidance
      (`:525-529`); `engine.json` in the concurrency/lifecycle discussion, documented as **both**
      the ownership proof and the `O_EXCL` admission lock taken before `listenOnSocket` (R22), with
      the rules "a pid file alone never authorizes a signal; `/version` must confirm it, freshly,
      immediately before the signal" (R29) and "one engine per state dir; the loser exits 1";
      the `0600` trap R27 documents (a dropped mode breaks nothing until a bypass secret is added,
      `src/config/core-config.ts:164-171`); and a new bullet in "Frontends: VS Code extension"
      (`:546-570`) stating that the extension now ships and supervises the engine, resolves the
      engine's `PATH` from the user's login shell (R20), still derives no state path of its own, and
      never signals a process it cannot prove is cgremlin-core.
- [ ] `docs/DECISIONS.md`: a `## 2026-09-10 — Phase 8 (the extension ships the engine)` section with
      one line per confirmed ruling **R1–R30** (noting for R2, R3, R6, R10 and R13 which later
      ruling amended them), and one line recording that legacy state import was explicitly declined
      (U3).
- [ ] Root `README.md`: one line — the extension carries the engine; installing the `.vsix` is the
      whole setup.
- [ ] Commit `docs(cgremlin): Phase 8 — the bundled engine, one setting, and the new state dir`.

---

## Parallelism

| Task | Tier | Agent / branch | Runs with |
|---|---|---|---|
| A1 state dir + `repos` default + derived paths | `executor-heavy` | agent 1 — `phase8-core` | parallel with agent 2 |
| A2 `GET /version` + `activeRuns` + the `engine.json` lock | `executor-heavy` | agent 1 — `phase8-core` | after A1 |
| A3 `config init` | `executor` | agent 1 — `phase8-core` | after A1 |
| A4 esbuild bundles + build script | `executor` | agent 1 — `phase8-core` | after A2 |
| B1 one setting + live socket path + bridge loader | `executor` | agent 2 — `phase8-ext` | parallel with agent 1 |
| B2 engine manager + Node adapter | `executor-heavy` | agent 2 — `phase8-ext` | after B1 |
| B3 host wiring, commands, first run, watchers | `executor-heavy` | agent 2 — `phase8-ext` | after B2 |
| C1 packaging | `executor` | merged base — `phase8-pack` | sequential |
| C2 integration through the manager | `executor-heavy` | merged base — `phase8-pack` | after C1 |
| C3 docs | `executor` | merged base — `phase8-pack` | after C2 |

**Merge order and what the supervisor resolves.** `phase8-core` → `phase8-ext` → C. The two streams
touch **disjoint** files (Stream A is entirely inside `cgremlin/core`, Stream B entirely inside
`cgremlin/vscode`), so there are no textual conflicts; what the supervisor must check at the merge is
the **contract** between them, in three places:

- `cgremlin/vscode/package.json`'s `build` script (B/C) must call the script name A4 actually created
  (`build:engine`) and write to the paths B1's `loadBridge` and B2's spawn expect
  (`engine/bridge.js`, `engine/engine.js`).
- B2's `probe` parses the body A2's `/version` route actually returns — **including `activeRuns`,
  which B3's restart gate depends on (R21)** — and B2's pid-file reader parses the shape A2's
  `serve()` actually writes, **including `startedAt`, which R29's fresh proof compares**. Both are
  asserted independently against fakes in Stream B; **C2 is the only place they are asserted against
  each other**, which is why C2 is `executor-heavy` and not a formality.
- B3's first-run flow spawns `config init` with the argv A3 accepts.

**Tier rationale.** A1 changes the schema every other core test loads through, and the
half-registered-derived-path failure is documented, not hypothetical. **A2 is escalated in this
revision:** R22 makes it the owner of mutual exclusion between engines — an `O_EXCL` lock taken
before `listenOnSocket`, a take-over path for a dead owner, removal on two different failure paths,
and a two-process race test. B2 can kill a process; its whole test list exists to prove it will not
kill the wrong one. B3 owns two prompts whose wrong default cancels a user's running agent (an engine
restart stops every active run, `core/src/host/serve.ts:180-211`). C2 is the only cross-stream
contract test, and now also the only place the real editor host is exercised (R25). A3/A4/B1/C1/C3
are additive and fully specified.

**Every judgment call is settled in the spec's §3**: R1–R19 stamped `CONFIRMED 2026-09-10`, R20–R30
added as binding supervisor rulings in the same pass. The tasks above name the ones they depend on.
Nothing below the task level is left to executor discretion — where a choice existed, the spec
records the choice, the reason and the rejected alternative. An executor that believes it faces an
unwritten decision escalates rather than choosing.

## Definition of Done

- `phase8-core`, `phase8-ext` and `phase8-pack` merged in that order.
  `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint && pnpm build` green;
  `cd cgremlin/vscode && pnpm test && pnpm build && pnpm lint` green;
  `cd cgremlin/vscode && pnpm test:integration` green.
- All eight mutation guards present and each demonstrated failing under its stated mutation:
  **MG-C1** `no-second-engine`, **MG-C2** `never-kill-what-we-cannot-prove`, **MG-C3**
  `socket-setting-is-gone`, **MG-C4** `legacy-state-dir-is-quarantined`, **MG-C5**
  `bundled-engine-is-the-engine-we-run`, **MG-C6** `extension-derives-no-state-paths`, **MG-C7**
  `no-engine-start-via-terminal`, **MG-C8** `vsix-is-self-contained-and-lean`.
- `grep -rn "cgremlin.socketPath" cgremlin` is empty except in `docs/superpowers/specs/` (history)
  and this plan (MG-C3).
- `grep -rn "\.cgremlin/" cgremlin/core/src cgremlin/vscode/src` matches **only**
  `core/src/cli/commands/config.ts` (the legacy read) and a comment at
  `core/src/pipeline/prompts.ts:82` (MG-C4).
- `grep -rn "engine\.sock\|engine\.log\|/sessions'\|/worktrees'" cgremlin/vscode/src` shows no
  hand-joined state path (MG-C6).
- `grep -rn "SIGKILL" cgremlin/vscode/src` is empty (R3), and no code path sends a second signal
  after a stop timeout (R23).
- `grep -rn "attention" cgremlin/vscode/src/ui/engine.ts cgremlin/vscode/src/engine` is empty — the
  restart gate reads `GET /version`'s `activeRuns` and nothing else (R21).
- `grep -rn "'vscode'\|\bvscode\b" cgremlin/vscode/src/engine` is empty — no file in
  `pureSourceFiles()` contains the string, prose included (R30, `test/purity.test.ts:26`).
- `serve()` takes the `engine.json` lock before `listenOnSocket`, and the two-process race
  (A2) and the two-manager race (C2) each leave exactly one engine, the loser exiting 1 (R22).
- The engine bundle scrubs `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`/`VSCODE_*` from its own env (R24),
  and the spawn path resolves `PATH` from `$SHELL -lic` with a 5 s cap and a single
  `engine.path_fallback` line on failure (R20).
- Both engine bundles carry inline sourcemaps and no `.map` file is emitted or packaged (R28).
- `grep -rn "unlink\|rmSync\|rm(" cgremlin/vscode/src` shows nothing touching a `.sock` path (the
  extension never removes a socket; stale-socket recovery stays
  `core/src/api/listen.ts:26-32`).
- `grep -rn "startEngine" cgremlin/vscode` is empty (R12), and `grep -rn "sendText" cgremlin/vscode/src`
  shows only the chat terminal (MG-C7).
- `cgremlin/vscode/package.json` still has **no** `dependencies` key, and `@vscode/vsce` + nothing
  else was added to `devDependencies`; `cgremlin/core/package.json`'s `dependencies` is still exactly
  `{ zod }` with `esbuild` in `devDependencies`.
- `grep -rn "'vscode'" cgremlin/vscode/src` shows imports only in `src/extension.ts` and
  `src/settings.ts` (`test/purity.test.ts:38`, unchanged), and the new pure modules are covered by
  `pureSourceFiles()`.
- Regression pins green: a `core.json` with an explicit `stateDir: "~/.cgremlin"` still resolves every
  path under it; a `core.json` with no `enginePidPath`/`engineLogPath` derives both and does not
  persist them; `config import-legacy` still reads `${home}/.cgremlin/config`; `GET /config` still
  404s on a server with no config dep while `GET /version` answers 200; the Phase 7 integration suite
  passes unchanged against a manager-booted engine.
- The real-editor acceptance from C1 recorded: a window with **no** `cgremlin.*` settings starts the
  engine, creates and opens `~/.cgremlin-core/core.json`, and never creates or touches `~/.cgremlin/`.
- The rewritten smoke checklist run end to end, result table filled in on the phase branch.
- R25 recorded: either the `Code Helper (Plugin)` case ran and the log showed
  `process.versions.electron` with Node ≥ 20, or it skipped with the path it looked for.
- If `vsce package` ever rejected the manifest, its exact text is in C1's commit message alongside
  the fix (R28).
- Not in scope: importing legacy sessions/worktrees/config (U3), marketplace publishing, bundling the
  extension's own code, bundling `claude`/`codex`/`gh`/`git`, and any change to the pipeline,
  attention model, event stream or human-turn machinery.
