# cgremlin Phase 8 — The extension ships and runs the engine: Design

> Status: **confirmed 2026-09-10**. Every R-numbered judgment call in §3 is binding: R1–R19 were
> confirmed as written (each is stamped `CONFIRMED 2026-09-10`), and R20–R30 are supervisor rulings
> added in the same pass — several of them *amend* an earlier R, which is stated at both ends.
> No ruling is left to executor discretion.
> Repo `/Users/guilherme.azoubel/context-gremlin`, branch `mission-control-pr-orchestrator` @ `f9d49dd`.
> Companion plan: `docs/superpowers/plans/2026-09-10-cgremlin-phase8-bundled-engine.md`.

## 0. Why

Phase 7 shipped a VS Code extension that is a **pure client** of an engine somebody else has to
start. The reported failure is the whole phase in one sentence: after `F5`, with
`cgremlin-core serve --config ~/.cgremlin-core-smoke/core.json` running in a terminal, the panel
still said

> `cgremlin engine is not running (no engine on ~/.cgremlin/engine.sock)`

Four independent causes, each verified below:

1. **`socketPath` is read once and baked in.** `activate()` calls `readSettings()` at
   `cgremlin/vscode/src/extension.ts:33` and passes `settings.socketPath` into `new CoreClient(...)`
   (`:35`) and `new SseClient({ socketPath })` (`:46`). Only `notificationLevel` (`:41`) and
   `configPath` (`:42`) are re-read live. There is **no** `onDidChangeConfiguration` anywhere in the
   package (grep over `cgremlin/vscode/src` and `cgremlin/vscode/test`: zero hits), so setting the
   socket after activation changes nothing until a window reload.
2. **Two settings that must agree.** `cgremlin.socketPath` and `cgremlin.configPath`
   (`cgremlin/vscode/package.json:114-123`) are independent strings. A user who sets one and not the
   other gets exactly this error, and neither setting is validated against the other.
3. **Both defaults point at the legacy tool.** `DEFAULT_SOCKET_PATH = '~/.cgremlin/engine.sock'`,
   `DEFAULT_CONFIG_PATH = '~/.cgremlin/core.json'` (`cgremlin/vscode/src/settings.ts:16-17`) — the
   *legacy bash tool's* state dir, which the smoke doc explicitly says must not be touched
   (`cgremlin/vscode/docs/SMOKE.md:19-20`). The core has the same default:
   `stateDir: z.string().min(1).default('~/.cgremlin')` (`cgremlin/core/src/config/core-config.ts:69`).
4. **The engine has to be started by hand.** The only "start" affordance types a command into a
   terminal: `cgremlin.startEngine` runs `terminal.sendText('cgremlin-core serve --config …')`
   (`cgremlin/vscode/src/ui/commands.ts:154-158`), which requires `cgremlin-core` on `PATH`
   (`SMOKE.md:25-26`) and a built `cgremlin/core`.

The user's ask, verbatim: *"core functionality ships with the extension so I don't need to start them
separately. I just install it and it works. I just need to say where our local cache json would
be."* And the user's decision: **no legacy import path is needed; start fresh.**

## 1. Scope

**In.**

- One setting: `cgremlin.configPath`, default `~/.cgremlin-core/core.json`. `cgremlin.socketPath` is
  **removed**. Every path — socket, sessions, worktrees, log, pid file — is derived from
  `core.json`'s `stateDir` by **the core's own loader**, imported from the bundled engine.
- The core's default `stateDir` moves from `~/.cgremlin` to `~/.cgremlin-core`. `~/.cgremlin` survives
  in exactly one place: as the *read* source of `cgremlin-core config import-legacy`.
- The extension **bundles a built engine** and starts it, detached, when nothing answers on the
  socket. Commands `cgremlin.engine.start|stop|restart|showLog`; engine state in the status bar;
  engine stdout/stderr to a log file under `stateDir`, tailed into the existing `cgremlin` output
  channel.
- A version handshake, so a stale long-lived engine from an older extension build is noticed, and
  one authoritative `activeRuns` counter so no restart ever silently cancels running work (R21).
- An `O_EXCL` `engine.json` lock taken by `serve()` before it listens, so two engines can never race
  onto one `stateDir` (R22), and a login-shell-resolved `PATH` for the spawned engine (R20).
- First-run bootstrap: no `core.json` → the **core** writes a valid template (via a new
  `cgremlin-core config init`), the extension opens it and starts the engine.
- Settings observed live (`onDidChangeConfiguration('cgremlin')`) and a config-file watcher that
  restarts the engine after a save.
- One `.vsix` from `vsce package` containing the engine, with no `devDependencies` and no
  `node_modules` inside.
- `SMOKE.md` step 0 rewritten to the new flow; `ARCHITECTURE.md`, both `README.md`s, `DECISIONS.md`.

**Out.**

- Importing legacy `~/.cgremlin` state (sessions, worktrees, config) into the new state dir. The
  `config import-legacy` command keeps working, but nothing calls it automatically and no UI offers
  it.
- Publishing to the marketplace (no publisher account, no signing); `vsce package` + "Install from
  VSIX" is the distribution story.
- Bundling the *extension's own* code (R13 of Phase 7 stands: the extension stays `tsc`-only). The
  engine bundle is a build artifact the extension spawns and `require`s, not a compilation of the
  extension.
- Bundling `claude`/`codex`/`gh`/`git`. The engine still shells out to them; a missing agent CLI is a
  runtime error the engine already reports.
- Any change to the pipeline, attention model, event stream or human-turn machinery.

## 2. Verified Ground Truth (2026-09-10, planner grounding pass)

Everything in this section was read or executed. Nothing here is inferred.

**Platform facts I executed on this machine**

- `code --version` → `1.137.0` / `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c` / `arm64`.
- The extension host binary reports Node **v24.18.1** (Electron 42.10.0):
  `ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" -e "console.log(process.version, process.versions.electron)"`
  → `v24.18.1 42.10.0`. So `process.execPath` **is** a usable Node ≥ 20 for the engine, provided
  `ELECTRON_RUN_AS_NODE=1` is set in the child's environment. `@types/vscode` is pinned `1.85.0` and
  `engines.vscode` is `^1.85.0` (`cgremlin/vscode/package.json:239`, `:10`) — the API surface this
  phase uses (`workspace.onDidChangeConfiguration`, `window.showTextDocument`,
  `OutputChannel.append`) all predate 1.85.
- `vsce` is **not** installed anywhere on this machine (`which vsce` empty; `npx vsce` refused), and
  neither package depends on it. Packaging therefore cannot be verified until the packaging task adds
  `@vscode/vsce` as a devDependency — see R19.
- `node --version` → `v24.18.0` (the shell's Node, used by the test suites).
- The `Code Helper (Plugin)` executable **is present on this machine** at
  `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`
  (`ls` on that directory lists exactly that one entry), so R25's real-`execPath` integration case
  runs here rather than skipping.
- **The login-shell PATH probe R20 relies on works and is fast.**
  `env -i HOME=$HOME SHELL=/bin/zsh /bin/zsh -lic 'echo $PATH'` returned in **0.83 s** and printed a
  PATH containing `/opt/homebrew/bin` and `~/.nvm/versions/node/v24.18.0/bin` — i.e. exactly the
  entries a GUI-launched editor is missing and where `gh`/`claude` live. 5 s is therefore a budget
  with ~6× headroom, not a guess.

**The extension as it stands**

- `readSettings()` is called at activation and in two live closures only:
  `extension.ts:33`, `:41`, `:42`. `Settings` is `{ socketPath, configPath, notificationLevel }`
  (`settings.ts:10-14`); `expandHome` (`:20-24`) is a hand-copy of the core's own `expandHome`
  (`cgremlin/core/src/config/core-config.ts:89-93`) and its doc comment says so.
- `CoreClient` holds the socket path as a constructor field (`core-client.ts:105`) and uses it per
  request (`:118`). `SseClient` stores its options object at construction (`sse.ts:99-101`) and reads
  `opts.socketPath` per connection attempt (`:156`). So making the path *live* is a one-field change
  in each, not a rewiring.
- `EngineNotRunningError` is raised only for `ENOENT`/`ECONNREFUSED` (`core-client.ts:62`, `:127-129`)
  — exactly the two codes a missing or stale socket produces.
- The offline UX shows one warning per outage with `Start it` / `Settings`
  (`ui/notifications.ts:43-60`), and the status bar's click target is `cgremlin.startEngine` while
  offline (`ui/status-bar.ts:37-40`). Its wiring test is
  `test/ui/command-wiring.test.ts:118-126`.
- MG-B1 is enforced by two assertions that this phase must extend deliberately, not by accident:
  `pureSourceFiles()` lists `src/core-client.ts`, `src/sse.ts` and every file under `src/model/`
  (`test/purity.test.ts:9-15`), and `imports vscode only in extension.ts and settings.ts`
  (`:38`, `:54-60`) plus an **exact** list of `src/ui/*` basenames (`:62-75`).
- **The two halves of MG-B1 are not equally forgiving, and the strict one is the trap.** The
  pure-module check is a *plain substring* test — `if (source.includes('vscode'))`
  (`test/purity.test.ts:26`) — so any file added to `pureSourceFiles()` may not contain the string
  `vscode` **even in a comment**. The whole-tree check is a regex over `from 'vscode'` /
  `require('vscode')` (`:51`) and its comment explicitly permits prose. See R30.
- `cgremlin/vscode/package.json` has **no** `dependencies` key, and Phase 7's DoD pins that
  (`docs/superpowers/plans/2026-09-10-cgremlin-phase7-vscode-ui-v1.md:454`).
- Cross-package build precedent already exists: `"test:integration": "pnpm --dir ../core build && vitest run test/integration"` (`cgremlin/vscode/package.json:232`).
- `.vscode/launch.json` runs `preLaunchTask: "pnpm: build"` → `pnpm build` in `cgremlin/vscode`
  (`.vscode/tasks.json`). Whatever produces the engine artifact must therefore hang off `pnpm build`,
  or `F5` ships an extension with no engine.

**The engine as it stands**

- **A stale socket file is already the engine's problem, and it handles it.**
  `listenOnSocket` (`cgremlin/core/src/api/listen.ts:25-41`) first *connects* to decide liveness
  (`isSocketLive`, `:12-23`); a live socket throws `SocketInUseError`, otherwise it `unlink`s the
  path (ignoring `ENOENT`), listens, and `chmod 600`s the socket. `serveCommand` maps
  `SocketInUseError` to a one-line stderr message and exit 1 (`src/cli/commands/serve.ts:27-31`).
  **The extension must never unlink a socket.**
- **`serve()` writes no pid/identity file.** Its only filesystem writes at boot are three `mkdir`s
  (`src/host/serve.ts:70-72`); its teardown unlinks the socket (`:223-225`). The only state file the
  engine writes today is the local-app record (`src/env/environment-service.ts:316-320`). So the
  ownership proof MG-C2 needs does not exist yet and has to be added.
- **Ownership-proof precedent to copy.** `NodeLocalAppRunner.signal()` maps `ESRCH`→`gone`,
  `EPERM`→`foreign` and never escalates against a foreign target
  (`src/env/node-local-app-runner.ts:249-262`); `isOurListener` refuses to trust a re-derived pgid
  unless it matches the one we spawned (`:211-217`); `EnvironmentService` only signals a record it
  can still prove is its own (`src/env/environment-service.ts:558-565`).
- **Detached-spawn precedent to copy, line for line.**
  `openSync(logPath, 'a')` → `spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', fd, fd] })` →
  `child.unref()` → `closeSync(fd)` → throw if `child.pid === undefined`
  (`src/env/node-local-app-runner.ts:104-116`). The agent runners are detached too
  (`src/agent/claude-code-runner.ts:80`, `src/agent/codex-runner.ts:68`).
- **Config is loaded exactly once, at boot.** `serveCommand` calls `loadCoreConfig` then
  `serve(config, …)` (`src/cli/commands/serve.ts:9-19`); `GET /config` returns the object captured at
  build time (`src/api/server.ts:566-571` reading `deps.config`, wired at
  `src/host/build-engine.ts:217`). Nothing re-reads the file. **A config edit therefore requires an
  engine restart** — D4's watcher is not a nicety, it is the only way a saved edit takes effect.
- **`GET /config` is not a safe identity probe.** It answers `404 {"error":"config not available"}`
  when the server was built without a config (`src/api/server.ts:566-570`), which every
  test-constructed server is. A probe that treats 404 as "not cgremlin-core" would be wrong, and one
  that treats it as "is cgremlin-core" proves nothing.
- **Restarting the engine stops in-flight work.** `close()` awaits `scheduler.stop()`, then
  `pipeline.stop(id)` for every `activeSessionIds()`, then `environment.abortAll()`/`stop()`
  (`src/host/serve.ts:180-211`). Boot then clears every human-turn claim
  (`:139-142`) and reaps only the process group it recorded (`:118-133`). A silent restart is
  therefore a silent cancellation of running agents — which is why R21 below gates every restart on
  `activeRuns === 0`.
- **"What is running" is two counters, not one, and both already exist.**
  `PipelineService.activeSessionIds()` delegates to `StageRunner`'s in-memory active map
  (`src/pipeline/pipeline-service.ts:848-850`, `src/pipeline/stage-runner.ts:53`) — the only
  trustworthy source, per `close()`'s own comment (`src/host/serve.ts:181-184`). It does **not**
  cover a stage still *preparing* its environment: the W4 comment at `src/host/serve.ts:196-200`
  says so in as many words ("a stage still PREPARING its environment has no active run for
  `pipeline.stop()` to find"). Those preparations are tracked in `EnvironmentService`'s
  `inFlight` map (`src/env/environment-service.ts:124`, registered synchronously at `:371`,
  drained by `abortAll()` at `:389-393`), which has no public accessor yet. So R21's `activeRuns`
  needs exactly one new one-line getter (`inFlightCount(): number → this.inFlight.size`), not a new
  bookkeeping mechanism.
- **`pipeline` is a required `ApiServerDeps` field and `environment` is optional**
  (`src/api/server.ts:61-83`), so `activeRuns` can be computed on a server built with no optional
  deps at all: `pipeline.activeSessionIds().length + (environment?.inFlightCount() ?? 0)`.
- **`SessionFileSystem` has no exclusive-create.** Its whole surface is
  `readFile/writeFile({mode})/statMode/statMtimeMs/remove/rename/readdir/mkdir/exists`
  (`src/fs/session-file-system.ts:1-14`) — no flags, no `O_EXCL`. `serve()` already bypasses the
  adapter for the one other real-filesystem artifact it owns, importing `unlink` from
  `node:fs/promises` directly for the socket (`src/host/serve.ts:1`, `:223-225`). R22's `engine.json`
  follows that precedent rather than widening the adapter (see R22).
- **`serve()`'s tests already mix a real temp dir with an in-memory adapter.**
  `test/host/serve.test.ts` `mkdtemp`s a real directory for the socket, passes an
  `InMemoryFileSystem` as the adapter, and asserts real-FS facts with `existsSync` (imports at
  `:1-22`). A2's `engine.json` assertions therefore need `stateDir` pointed at that real temp dir.
- **A first-run template with no repos cannot load today.** `CoreConfigSchema` requires
  `repos: z.array(...).min(1)` and `me: z.string().min(1)`
  (`src/config/core-config.ts:56-58`); `loadCoreConfig` wraps a zod failure in `ConfigError`
  (`:158-163`) and `serveCommand` exits 1 (`src/cli/commands/serve.ts:12-15`). D4's
  `repos: []` template is impossible without a schema change (R4).
- **Zero repos is otherwise harmless.** `InventoryScanner.run()` loops over `config.repos`
  (`src/inventory/inventory-scanner.ts:60-78`); with none, it produces an empty inventory and no
  error.
- **`writeCoreConfig` is the one config writer**, and it is careful: tmp file → `mode 0600` → rename,
  and it strips any path field equal to its `stateDir`-derived default so a persisted file does not
  bake in absolute paths (`src/config/core-config.ts:257-289`, `DERIVED_PATH_SUFFIXES` at `:257-265`).
- **Every derived path has to be registered twice.** `resolveCoreConfig`'s `expandOrDerive` block
  (`src/config/core-config.ts:99-111`) *and* `DERIVED_PATH_SUFFIXES` (`:257-265`) — documented as a
  trap in `docs/ARCHITECTURE.md:525-529` and in Phase 7's plan (line 94).
- **The core has exactly one runtime dependency: `zod`** (`cgremlin/core/package.json:19-21`), and
  declares `engines.node: ">=20"` (`:5-7`). `cgremlin/core/dist` is gitignored and untracked
  (`core/.gitignore`; `git ls-files cgremlin/core/dist` → 0 files) — build artifacts are not
  committed, and the engine bundle will follow that rule.
- The bin shim is two lines: `#!/usr/bin/env node` + `require('../dist/cli/main.js').run()`
  (`cgremlin/core/bin/cgremlin-core`), and `run()` builds real IO with `home: homedir()`
  (`src/cli/main.ts:79-92`). The CLI's default config path is `${home}/.cgremlin/core.json`
  (`src/cli/command-io.ts:19-21`).
- `config import-legacy` reads `${home}/.cgremlin/config` (`src/cli/commands/config.ts:4-6`) and
  writes `configPathFor(io)` (`:21`) — so flipping `defaultConfigPath` flips its output target for
  free, and the legacy *read* path stays where it is.
- `src/index.ts` is `export const VERSION = '0.0.1'` — a version constant exists but is not exposed
  over HTTP anywhere (grep for `version` in `src/api/server.ts`: only the `schemaVersion` field and
  `reviewVersion`).
- `buildEngine` already receives the resolved `config` and an optional `clock`
  (`src/host/build-engine.ts:204`, `:206-221`), which is where a `/version` payload gets assembled.
- The integration harness already spawns the engine the way the manager will:
  `spawn(process.execPath, [CORE_ENTRY, 'serve', '--config', configPath], { cwd, stdio, env: { HOME: stateDir, PATH: … } })`
  (`cgremlin/vscode/test/support/core-harness.ts:152-162`) and polls for the socket up to 10 s at
  25 ms (`:347-359`).

**Every place `~/.cgremlin` appears** (grep, excluding `node_modules`/`dist`/`out`) — the full list
the rename task must walk:

- Source: `core/src/config/core-config.ts:69`, `core/src/cli/command-io.ts:11,14,19`,
  `core/src/cli/commands/config.ts:5` (**legacy read — stays**), `core/src/cli/main.ts:21` (usage
  text), `core/src/pipeline/prompts.ts:82` (a comment about legacy), `vscode/src/settings.ts:16-17`,
  `vscode/package.json:116,121`.
- Tests — **re-grepped 2026-09-10; the exhaustive list is six files, not the "eleven" an earlier
  draft of this section claimed** (`grep -rn '\.cgremlin' cgremlin/core/test cgremlin/vscode/test`
  → 35 matches in 7 files, one of which is prose):
  1. `core/test/config/core-config.test.ts:33-38,50,210-211,258,267` — default-resolution assertions.
  2. `core/test/cli/config.test.ts:25-26,31,33,43-44,54-55,59,64-65,76-77` — **mixed**: the legacy
     *input* `${HOME}/.cgremlin/config` **stays**; only the written target (`:31`, `:33`, `:59`) moves.
  3. `core/test/env/environment-service.test.ts:19-20,129,590` — scratch state dir.
  4. `core/test/host/build-engine.test.ts:209,242` — `/home/e2e/.cgremlin` scratch state dir.
  5. `core/test/api/local-routes.test.ts:15` — scratch `local-app.json` path.
  6. `vscode/test/workspace-file.test.ts:4-6` — `/home/me/.cgremlin/...` fixture paths (Stream B).
  Not renamed: `vscode/test/support/core-harness.ts:15`, which is a **prose** comment stating that
  the legacy dir is never touched — still true. It needs no exemption, because MG-C4's pattern is
  `\.cgremlin/` (trailing slash, minus `.cgremlin-core`) and that line writes `~/.cgremlin` with no
  slash. Verified today: that pattern's post-phase allow-list is exactly
  `core/src/cli/commands/config.ts:5` (legacy read), `core/src/cli/main.ts:21` (the
  `import-legacy` usage line), `core/src/pipeline/prompts.ts:82` (comment) and the legacy *input*
  lines of `core/test/cli/config.test.ts` — everything else in that grep's current 35-match output
  moves to `.cgremlin-core`.
- Docs: `core/README.md:23,46,63,132,192,195,241`, `core/docs/ARCHITECTURE.md:433`,
  `vscode/README.md:71-72`, `vscode/docs/SMOKE.md:19,32-57,70`, plus the Phase 4/5/7 specs (historical
  — **not** rewritten; a spec records what was decided then).

## 3. Rulings

**Binding user decisions.** U1: one setting, and it names the cache/config JSON. U2: the engine
ships with the extension and starts itself. U3: no legacy import; start fresh.

**Binding supervisor decisions** (D1–D8 in the task brief), restated as they land here:

- **D1** One setting `cgremlin.configPath` (default `~/.cgremlin-core/core.json`); `socketPath`
  removed; every path derived from `core.json`'s `stateDir` by the core's own loader, imported from
  the bundled engine (not re-implemented). Core default `stateDir` → `~/.cgremlin-core`.
- **D2** Bundle the built engine; start it detached when nobody answers; log to a file under
  `stateDir` and tail it into the output channel; four `cgremlin.engine.*` commands; engine state in
  the status bar; probe over the socket; **never** unlink a socket from the extension.
- **D3** Version handshake; only ever restart an engine that proved it is cgremlin-core.
- **D4** First run: create `core.json` from a template, open it, watch it, restart on save.
- **D5** `onDidChangeConfiguration('cgremlin')` re-resolves and reconnects.
- **D6** One `.vsix` containing the engine, no devDependencies.
- **D7** `cgremlin-core` keeps working standalone, same defaults.
- **D8** The test matrix and guards MG-C1…MG-C4.

**Judgment calls, all now confirmed.** R1–R19 are the planner's calls, confirmed as written on
2026-09-10 except where an R20–R30 ruling below amends them (each amendment is cross-referenced from
both ends). R20–R30 are supervisor rulings from the same pass and are equally binding. An executor
may not re-open any of them; a task that appears to need a decision not written here escalates.

- **R1 — `GET /version`, not a field on `/config`. CONFIRMED 2026-09-10.**
  A new dependency-free route `GET /version` → `{ version, pid, startedAt, socketPath, activeRuns }`.
  **Amended by R21**, which adds the `activeRuns` field and makes it the single authority on whether
  a restart is safe.
  Justification, all from §2: (a) `/config` 404s when the server has no config dep
  (`src/api/server.ts:566-570`), so its answer cannot distinguish "not our engine" from "our engine,
  no config" — a probe needs a route that *always* answers; (b) the stop path needs `pid` bound to
  the socket to be a proof (see R3), and a pid does not belong in a config document; (c) `/config`'s
  body carries a redacted copy of every secret-bearing environment — sending it on every liveness
  poll is gratuitous; (d) the extension already calls `/config` once on connect
  (`ui/refresh.ts:45-49`), so `/version` adds exactly one request per probe, not per refresh.
  Rejected alternative: `HEAD /` or a `Server:` header — invisible to the existing client layer and
  untestable through `CoreClient`.
- **R2 — A version mismatch never *silently* cancels work. CONFIRMED 2026-09-10, amended by R21.**
  `serve()`'s `close()` stops every active run and tears down the local app
  (`src/host/serve.ts:180-211`). An extension update landing while a review is mid-flight must not
  silently cancel it. What survives from R2: the prompt's shape — a **modal** information message
  (`Restart engine` / `Not now` / `Show log`) naming both versions, `Not now` remembered for the
  window's lifetime, and the mismatched engine left running and fully usable in the meantime (a
  mismatch is not an error state). What R21 changes: the prompt is shown only when
  `activeRuns > 0`; with `activeRuns === 0` there is nothing to cancel, so the extension restarts
  automatically and logs one line instead of asking.
- **R3 — Stop is `SIGTERM` only, against a pid proved twice, with no `SIGKILL`. CONFIRMED 2026-09-10.**
  The proof: `<stateDir>/engine.json` (written by `serve`) says `{ pid, version, socketPath, startedAt }`
  **and** `GET /version` on that socket answers with the same `pid`. Only then does the extension
  `process.kill(pid, 'SIGTERM')`, then poll `/version` until it stops answering (10 s — **raised to
  45 s, and a timeout turned into `stopping`, by R23**). No
  `SIGKILL`, ever: `close()` is the only thing that stops running agents, clears claims and stops the
  local dev server in the right order (`src/host/serve.ts:173-230`), and a hard kill orphans a dev
  server that only the *next* boot's `reconcileOrphans` (`:118-133`) could reap. If the engine has
  not exited the extension says so and links the log; it does not escalate. **Amended by R23** (the
  poll budget is ≥ 45 s, and a timeout is a `stopping` state rather than a failure) and **by R29**
  (the two-part proof is re-taken immediately before every signal, not once per `stop()`).
- **R4 — `CoreConfigSchema.repos` loses `.min(1)`; `me` stays required. CONFIRMED 2026-09-10.**
  D4's `repos: []` template cannot load otherwise (§2). `repos` becomes
  `z.array(...).default([])`, which is safe: the scanner's loop simply does not execute
  (`src/inventory/inventory-scanner.ts:60-78`) and the parking lot is empty. `me` stays
  `z.string().min(1)` on purpose — an empty `me` would silently defeat the own-PR refusal
  (`src/api/server.ts:114-116` compares against `inv.config.me`), so the *extension* must supply a
  real login: `gh api user --jq .login`, else an input box, else it writes nothing and explains why.
- **R5 — The template is written by the core, not by the extension. CONFIRMED 2026-09-10.**
  A new `cgremlin-core config init [--me <login>] [--force]` calls the existing `writeCoreConfig`
  (tmp → `0600` → rename, derived paths omitted; `src/config/core-config.ts:267-289`). The extension
  spawns the bundled engine to run it. Rationale: one config writer, one place that knows the file
  mode, and D7 parity for free (a CLI user gets the same bootstrap). The alternative — the
  extension's `Host.writeFile` (`src/ui/host.ts:139`, no mode argument) — would create a
  world-readable file that later fails `loadCoreConfig`'s `0600` assertion the moment a bypass
  secret is added (`src/config/core-config.ts:164-171`).
- **R6 — On a `core.json` save: auto-restart when nothing is running, ask otherwise. CONFIRMED 2026-09-10, amended by R21 and R27.**
  D4 says "restarts the engine on save". Taken literally that cancels a running review on an
  unrelated edit (same citation as R2). The compromise stands, but **not** the mechanism: R6's
  original `GET /attention?all=1` probe is **withdrawn** — the attention listing describes PRs, not
  the engine's own in-flight work, and it misses a stage still preparing its environment
  (`src/host/serve.ts:196-200`). The gate is `GET /version`'s `activeRuns` (R21) and nothing else.
  R27 adds what must happen *before* the gate is consulted: re-load the config and restart only if
  it loads. If the engine is not running at all, just start it.
- **R7 — Live socket path via a provider function, not by rebuilding the client layer. CONFIRMED 2026-09-10.**
  `CoreClient`'s constructor takes `string | (() => string)` and resolves per request;
  `SseClientOptions.socketPath` likewise, resolved per connection attempt (both are single-field
  changes — `core-client.ts:105`, `sse.ts:99-101`, `:156`). `onDidChangeConfiguration` then means:
  re-resolve the config, `sse.stop()`, `sse.start()`, `coordinator.connect()`. Rejected alternative:
  disposing and rebuilding `createUi(...)` on every settings change — it would tear down the tree
  provider, the status bar item and every outstanding chat claim (`ui/wiring.ts:108-114` calls
  `chat.releaseAll()` on dispose), i.e. a settings edit would release the user's human-turn claims.
- **R8 — Bundling: esbuild, two single-file CJS bundles, built by the core into `cgremlin/vscode/engine/`. CONFIRMED 2026-09-10.**
  Option (a) from D6, for grounded reasons: the core's only runtime dependency is `zod`
  (`core/package.json:19-21`), so a bundle is small and self-contained; and option (b) (vendored
  `dist` + production `node_modules`) is actively hostile under pnpm, whose `node_modules` is a tree
  of symlinks into a content-addressed store — `vsce package` would either follow them and inline the
  world or skip them and ship a broken engine. Two entry points, one build step:
  - `engine/engine.js` ← new `core/src/host/engine-main.ts` (`import { run } from '../cli/main'; void run();`)
    — a directly runnable `node engine.js serve --config <path>`;
  - `engine/bridge.js` ← new `core/src/host/extension-bridge.ts`, exporting
    `ENGINE_VERSION` and `loadResolvedConfig(path, home)` (a two-line wrapper over the existing
    `NodeFileSystem` + `loadCoreConfig`) — this is the module the extension `require`s so that
    `expandOrDerive` exists in exactly one place (D1).
  Both `--platform=node --format=cjs --target=node20 --bundle`. `esbuild` is a devDependency of
  `cgremlin/core`; `cgremlin/vscode`'s `build` script runs `pnpm --dir ../core build:engine` first
  (the precedent at `vscode/package.json:232`), so `F5` and `vsce package` both get it.
  `cgremlin/vscode/engine/` is gitignored, exactly as `core/dist` is.
- **R9 — The bridge's *type* is declared locally; its *logic* is not. CONFIRMED 2026-09-10.**
  esbuild emits no `.d.ts`, and the core's per-file declarations (`core/dist/**/*.d.ts`) reference
  `zod` and sibling modules, so they cannot be dropped next to a bundle. The extension therefore
  declares a narrow structural interface for what it reads (`{ ENGINE_VERSION: string; loadResolvedConfig(path, home): Promise<ResolvedPaths> }`)
  and loads the bundle with a `require` of an absolute path built from `context.extensionPath`. A
  DoD grep (MG-C6) pins that no path *derivation* leaked back in: `engine.sock` must not appear
  anywhere under `cgremlin/vscode/src`. Rejected alternative: `import type` from
  `../../core/src/config/core-config` — the file is outside the extension's `rootDir: "src"`
  (`vscode/tsconfig.json`) and would pull `zod` into the extension's typecheck.
- **R10 — The child's environment is sanitized. CONFIRMED 2026-09-10.**
  `{ ...process.env, ELECTRON_RUN_AS_NODE: '1' }` minus `NODE_OPTIONS` and every `VSCODE_*` key.
  `ELECTRON_RUN_AS_NODE` is required for `process.execPath` to behave as Node (§2); `NODE_OPTIONS`
  and the `VSCODE_*` block are the editor's own plumbing and are inherited by every `bash -lc` the
  engine spawns for an agent (`src/agent/claude-code-runner.ts:80`). The engine logs its effective
  `PATH` as its first log line, because a GUI-launched editor is the classic way for `claude`/`gh` to
  go missing. **Extended by R20** (that `PATH` is not the editor's — it is resolved from the user's
  login shell) and **by R24** (the engine also scrubs these variables from its *own* `process.env`
  at startup, so a child spawned by any later code path cannot inherit them either).
- **R11 — Log file `<stateDir>/engine.log`, appended, rotated to `engine.log.1` when it exceeds 8 MB at spawn time; tailed by offset. CONFIRMED 2026-09-10.**
  Append (not truncate) so a crash loop keeps its evidence, matching the local app's
  `appendLog` mode (`src/env/node-local-app-runner.ts:104`). The tail is a `fs.watch` on the file plus
  a read from the last byte offset, and it starts at the *current* end of file so activation does not
  replay yesterday's log into the output channel.
- **R12 — `cgremlin.startEngine` is replaced by `cgremlin.engine.start`, not aliased. CONFIRMED 2026-09-10.**
  Two call sites (`ui/notifications.ts:56`, `ui/status-bar.ts:39`) and one test
  (`test/ui/command-wiring.test.ts:118-126`) change with it. Keeping a dead alias would leave two
  ways to start an engine, one of which types a shell command that will no longer be on `PATH`.
- **R13 — The pid file is a derived config path, `enginePidPath` → `<stateDir>/engine.json`. CONFIRMED 2026-09-10.**
  Registered in **both** `resolveCoreConfig` and `DERIVED_PATH_SUFFIXES`
  (`src/config/core-config.ts:99-111`, `:257-265`) per `ARCHITECTURE.md:525-529`. Also
  `engineLogPath` → `<stateDir>/engine.log`, same treatment, so the extension asks the core where the
  log is instead of joining paths itself (MG-C6).
- **R14 — Legacy references are *renamed in tests*, not just tolerated. CONFIRMED 2026-09-10.**
  MG-C4 ("`~/.cgremlin/` never referenced outside the import-legacy command") is only a useful grep
  if the test fixtures stop using `${HOME}/.cgremlin` as a scratch state dir. §2's re-grepped list —
  **six** files, five in the core and one in the extension, not the "eleven" an earlier draft
  claimed — moves to `.cgremlin-core`, minus the legacy *input* lines of
  `core/test/cli/config.test.ts`. The historical Phase 4/5/7 specs are left untouched, and the grep
  excludes `docs/superpowers/specs`.
- **R15 — The extension auto-starts the engine on activation. CONFIRMED 2026-09-10.**
  This is the literal content of "I just install it and it works", but it is a posture change worth
  saying out loud: opening VS Code starts a background daemon that outlives the window. Guards: it
  only happens when `configPath` exists and parses; concurrent windows cannot double-start (MG-C1 —
  the probe answers, and in a true race the `O_EXCL` `engine.json` lock refuses the loser with
  `SocketInUseError` — **R22**, which corrects this ruling's original claim that `listenOnSocket`
  alone would refuse it: it would not, because it unlinks a socket nobody answers,
  `src/api/listen.ts:29-32`); and `cgremlin.engine.stop` warns that the engine is shared by every
  window before stopping it.
- **R16 — No window "owns" the engine. CONFIRMED 2026-09-10.** The engine is a machine-wide singleton keyed by its socket,
  like the legacy tool's daemon. `deactivate()` does **not** stop it (it keeps doing exactly what it
  does today: stop the stream and release claims, `extension.ts:67-74`).
- **R17 — Status bar shows the engine state only when it is not simply healthy. CONFIRMED 2026-09-10.** `connected` stays
  the socket-level truth that drives the existing text (`ui/status-bar.ts:18-25`); the new
  `engine: 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped' | 'mismatch' | 'foreign' | 'failed'`
  field replaces the bare `offline` text with `starting…` / `stopping… Ns` (R23, elapsed seconds) /
  `failed — see log` / `version mismatch`, and the click target becomes `cgremlin.engine.start`
  (`stopped`/`failed`), `cgremlin.engine.showLog` (`starting`/`stopping`/`failed`) or the panel
  (healthy). `foreign` reads `another server on this socket` and opens the log.
- **R18 — Probe/boot timings mirror the harness that already works. CONFIRMED 2026-09-10.** Poll every 100 ms for up to
  10 s for the socket to answer `/version` (`test/support/core-harness.ts:347-359` uses 25 ms/10 s;
  100 ms is kinder to an editor's event loop and still 100 attempts). A child that exits before the
  socket answers fails immediately with the last 20 log lines.
- **R19 — `@vscode/vsce` (not the deprecated `vsce`) becomes a devDependency of `cgremlin/vscode`, and `vscode:prepublish` runs the full build. CONFIRMED 2026-09-10.**
  Unverifiable on this machine right now (§2: no vsce installed), so the packaging task's
  acceptance is "`pnpm vsce ls` output recorded in the plan's evidence block", not "it should work".

**Supervisor rulings added 2026-09-10 (R20–R30). Binding.**

- **R20 — the engine's `PATH` comes from the user's login shell, not from the editor. BINDING.**
  Before spawning, the manager resolves a `PATH` by running `$SHELL -lic 'echo $PATH'` with a **5 s**
  timeout and taking the last non-empty line of stdout. On timeout, a non-zero exit, empty output or
  an unset `$SHELL`, it logs exactly one line — `engine.path_fallback` — with the reason, and uses
  `process.env.PATH` instead. The resolved value replaces `PATH` in the child environment R10
  already sanitizes; every other rule of R10 is unchanged. Measured today: 0.83 s on this machine,
  returning a `PATH` with `/opt/homebrew/bin` and the nvm bin dir (§2), which is the difference
  between an engine that can run `gh`/`claude` and the failure mode §6 describes. `-l` picks up the
  login files, `-i` picks up the interactive ones (many users put their `PATH` in `.zshrc`), and `-c`
  keeps it a single non-interactive command; the 5 s cap is what stops a pathological profile from
  hanging activation. This is recorded here and in the plan's Task B2.

- **R21 — one authoritative `activeRuns` field on `GET /version` gates every restart. BINDING; amends R2 and R6.**
  `GET /version` answers `{ version, pid, startedAt, socketPath, activeRuns }`. `activeRuns` is
  **one** number, computed per request (unlike `version`/`pid`/`startedAt`, which are captured at
  build time):
  `pipeline.activeSessionIds().length + (environment?.inFlightCount() ?? 0)`
  — live `StageRunner` runs (`src/pipeline/pipeline-service.ts:848-850` → `stage-runner.ts:53`)
  **plus** in-flight environment preparations. The second term is required because of the W4 comment
  at `src/host/serve.ts:196-200`: a stage still *preparing* its environment has no active run for
  `pipeline.stop()` to find, yet a restart aborts it. Those preparations are already tracked in
  `EnvironmentService.inFlight` (`src/env/environment-service.ts:124`, set synchronously at `:371`,
  drained by `abortAll()` at `:389-393`); the only new code is a one-line public getter
  `inFlightCount(): number` returning `this.inFlight.size`. `pipeline` is a required
  `ApiServerDeps` field and `environment` is optional (`src/api/server.ts:61-83`), so the route stays
  answerable on a server built with no optional deps — R1's whole point.
  **The gate, for both triggers (a version mismatch and a `core.json` save):** `activeRuns === 0` →
  restart automatically, logging one line; `activeRuns > 0` → ask, with a **modal** message so the
  choice cannot be missed behind the notification stack. **Any reliance on `/attention` for this
  decision is dropped** (R6's original probe): the attention listing is about PRs, not about the
  engine's own work, and it cannot see a preparing stage.

- **R22 — mutual exclusion is an `O_EXCL` create of `engine.json` *before* `listenOnSocket`. BINDING; supersedes §4.2's original "written after we listen" ordering. R13 itself (the pid file is a derived config path, registered twice) is unchanged.**
  This is the critical correction: `listenOnSocket`'s liveness check is a *connect* attempt
  (`src/api/listen.ts:12-23`) and it `unlink`s a socket nobody answers (`:29-32`), so two engines
  starting at the same moment can both see a dead socket and both proceed — the loser's `listen`
  may even succeed after unlinking the winner's fresh socket. `engine.json` is therefore the lock,
  and it is taken first:
  1. `serve()` opens `config.enginePidPath` with flag **`'wx'`** (`O_CREAT|O_EXCL|O_WRONLY`) and mode
     `0600`, writes `{ pid, version, socketPath, startedAt }`, closes. Because
     `SessionFileSystem` has no exclusive-create (`src/fs/session-file-system.ts:1-14`), this uses
     `open()` from `node:fs/promises` directly — the same bypass `serve()` already makes for the
     socket `unlink` (`src/host/serve.ts:1`, `:223-225`). The `stateDir` is `mkdir`ed first.
  2. On **`EEXIST`**: read the recorded `pid` and probe it two ways — is the process alive
     (`process.kill(pid, 0)`; `ESRCH` → dead, `EPERM` → alive but foreign, both classified exactly
     as `node-local-app-runner.ts:249-262` does), and does its `socketPath` answer
     (`isSocketLive`-equivalent connect)? **Either signal positive → exit 1 with `SocketInUseError`**
     (the same class `serveCommand` already maps to a one-line stderr message and exit 1,
     `src/cli/commands/serve.ts:27-31`). **Both provably negative → remove the file and retake the
     lock** (one retry; a second `EEXIST` means somebody beat us and is `SocketInUseError`).
  3. Only then `listenOnSocket`.
  4. The file is removed in the **same `finally`** that unlinks the socket
     (`src/host/serve.ts:214-228`) **and** on a failed `listenOnSocket` — that path returns by
     throwing, before any handle exists, so it needs its own `try/catch` around step 3 that removes
     the lock and rethrows. A crash still leaves a stale file, which is exactly why nothing ever
     trusts it alone (§4.2 rule 1, R29).
  §4.2 and Task A2's tests are written against this ordering, and **MG-C1 gains a two-process race
  case**: two `EngineManager` instances (and, in the integration suite, two `serve` processes)
  started concurrently against one `stateDir` must yield exactly one engine — the loser exits 1, and
  the winner's socket is intact and still answers `/version` afterwards.

- **R23 — the stop budget is ≥ 45 s, and a timeout is `stopping`, never a harder signal. BINDING; amends R3.**
  R3's 10 s was a guess against a `close()` that awaits a scheduler tick, every active
  `pipeline.stop()`, `environment.abortAll()` *and* `environment.stop()`
  (`src/host/serve.ts:173-211`) — a dev-server teardown alone can outlast 10 s. The poll budget is
  **45 s** at 500 ms. On expiry the manager does **not** terminate anything and does **not** report
  `failed`: it enters `{ kind: 'stopping'; since; pid; elapsedMs }`, which the status bar shows as
  `stopping… Ns` (R17's text table gains the row), and keeps probing at 1 s. A `restart()` waiting
  behind that stop proceeds the moment a probe comes back silent. Probing stops after a further
  **5 minutes** (a bound, so the manager cannot poll forever) with
  `failed{reason: 'engine still answering N minutes after SIGTERM', logTail}`; `cgremlin.engine.start`
  and `engine.restart` remain available to the user throughout, and `SIGKILL` is still never sent
  (R3's core rule, DoD-grepped).

- **R24 — the engine scrubs the editor's variables from its own `process.env` at startup. BINDING; extends R10.**
  R10 sanitizes what the *manager* passes. R24 closes the other half: `core/src/host/engine-main.ts`
  deletes `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and **every** key matching `^VSCODE_` from
  `process.env` as its first statement, *before* `require`/`run()` of the CLI — so every later
  `bash -lc` the engine spawns for an agent (`src/agent/claude-code-runner.ts:80`,
  `src/agent/codex-runner.ts:68`) inherits a clean environment even if the manager's own
  sanitization is ever bypassed (a hand-started `node engine.js`, a future code path, a wrapper).
  Deleting `ELECTRON_RUN_AS_NODE` after start is safe: Electron reads it at process start, and the
  process is already running as Node by the time this line executes.
  **Testable seam (chosen; the ruling left it open):** a debug flag on the bundle —
  `CGREMLIN_ENGINE_PRINT_ENV=1 node engine.js` prints, to stdout, a JSON object of the scrubbed keys
  it can still see (`{ electronRunAsNode, nodeOptions, vscodeKeys: [...] }`) and exits 0 without
  starting an engine. A4's bundle smoke spawns it with `ELECTRON_RUN_AS_NODE=1`,
  `NODE_OPTIONS=--max-old-space-size=99`, `VSCODE_PID=1`, `VSCODE_CWD=/x` set and asserts all three
  come back empty. Rejected alternative: inferring it from a child `bash -lc env` recorded by the
  fake local-app runner — it proves the same thing two layers away, needs a whole engine boot with a
  configured repo environment, and fails for unrelated reasons.

- **R25 — one integration case spawns through the real `Code Helper (Plugin)`. BINDING.**
  C2 adds a case that, when
  `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`
  exists (it does on this machine, §2), spawns the engine with that binary as `execPath` and asserts
  **from the engine log** that the child reported a non-empty `process.versions.electron` and a
  `process.version` whose major is ≥ 20 — i.e. that the editor's own helper really is the Node host
  the design claims. When the binary is absent the case **skips with a message naming the path**, and
  `execPath` stays an injectable field of the spawn spec (spec §4.3's `EngineProcessPort`) precisely
  so this case and the default `process.execPath` case are the same code path. The reported values
  reach the log through the same `CGREMLIN_ENGINE_PRINT_ENV`-style debug path R24 introduces
  (extended to include `versions.electron` and `version`).

- **R26 — the manager supervises the child it spawned, with a bounded backoff. BINDING.**
  `spawnDetached` returns the `ChildProcess` handle as well as the pid, and the manager keeps it
  (`unref`ed, so it never holds the window open) purely to observe `exit`. On an exit while the state
  is `running`, the state becomes `failed{reason, logTail}` immediately, rather than waiting for the
  next probe to notice. **Respawn policy:** a respawn the user did not ask for (an
  `ensureRunning()` from activation, a settings change, a config save) is **refused** while inside a
  growing backoff — **1 s, then 5 s, then 30 s, then stop trying** — measured from the last spawn.
  Concretely: three automatic retries, each behind a longer gate, and after the third one fails no
  automatic call ever spawns again. The refusal is logged, not surfaced as a new notification. A user-initiated `cgremlin.engine.start` (or `restart`) is **always**
  allowed and resets the backoff — the user is entitled to retry a broken engine as often as they
  like. This is what keeps a mis-configured `core.json` from becoming a spawn loop that fills
  `engine.log`.

- **R27 — the config watcher validates before it restarts, and re-asserts `0600`. BINDING; completes R6.**
  On a change (debounced 500 ms, dir-watched by basename per §4.5):
  1. `loadResolvedConfig(configPath, home)` through the bridge **first**.
  2. On success: restart, subject to R21's `activeRuns` gate.
  3. On `ConfigError`: show the engine's message **verbatim** (the rule at `ui/commands.ts:5-8`) with
     an `Open core.json` action, **do not touch the engine**, and re-arm the watcher — the next save
     is the user's fix attempt, and a watcher that disarmed itself on a typo would silently stop
     working.
  **The mode trap, documented because it bites later, not now:** `loadCoreConfig` asserts `0600`
  **only when the config holds a secret** (`hasAnySecret` → `src/config/core-config.ts:164-171`). An
  editor or tool that rewrites `core.json` and drops the mode therefore breaks nothing today and
  refuses to load the *moment* a `bypassSecret` is added — a failure whose cause is minutes or weeks
  in the past. **Decision: yes, re-chmod.** `config init` writes `0600` already (`writeCoreConfig`,
  `:280-288`), and the extension **chmods the file back to `0600` after every successful validation**
  in step 2, best-effort: a failure (a read-only file, a foreign owner, a non-POSIX mount) is logged
  as one line and never blocks the restart. `Host` gains the one-line `chmod(path, mode)` this needs.

- **R28 — packaging specifics. BINDING; refines R8, R19 and MG-C8.**
  - `.vscodeignore` is expressed as **exclude-only** rules. There is no "includes" list — the file
    format is a `.gitignore`-style deny list over an otherwise-complete tree, and the earlier
    "**includes** `out/**/*.js`, `engine/**`, …" phrasing in §4.7 described something the format does
    not have. Excluded: `src/**`, `test/**`, `node_modules/**`, `docs/**`, `.vscode/**`, `**/*.ts`,
    `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `pnpm-lock.yaml`, `**/*.map`,
    `.gitignore`, `.vscodeignore`.
  - Both esbuild bundles are built with **`--sourcemap=inline`** — a crashing engine must produce a
    readable stack trace, and an inline map cannot be separated from the file it describes by a
    packaging rule (which is exactly what an external `.map` excluded by `.vscodeignore` would be).
  - **MG-C8 is narrowed** accordingly: it asserts the listing contains `engine/engine.js`,
    `engine/bridge.js` and `out/extension.js`, and contains no `node_modules/`, `src/`, `test/`,
    `*.ts`, `docs/` **and no `out/**/*.map`**. It says nothing about `engine/*.map`, which by design
    do not exist.
  - If `vsce package` rejects the manifest, C1 **records the exact failure text** in the commit
    message and fixes the manifest rather than silencing it. **Decision, taken now so C1 does not
    have to choose:** add a truthful `"repository": { "type": "git", "url": "https://github.com/guilleazoubel/context-gremlin.git" }`
    (that is `origin`) and keep `"license": "UNLICENSED"` (`vscode/package.json:8`); add a `LICENSE`
    file only if `vsce` refuses without one. `--allow-missing-repository` is a last resort, used only
    if `vsce` demands something that is not truthfully available, and its use is recorded verbatim
    with the message that forced it.

- **R29 — the ownership proof is re-taken immediately before every signal. BINDING; tightens R3.**
  Reading `engine.json`, probing `/version` and *then* calling `process.kill` is a
  time-of-check/time-of-use window: the engine can exit and its pid be reused in between. So the
  proof is re-taken **immediately before each `process.kill`** — re-read `engine.json`, re-probe
  `/version`, and require that `pid` **and** `startedAt` still agree between the two (`startedAt` is
  what survives pid reuse: a reused pid has a different boot time). Any disagreement aborts the stop
  with `failed{reason}` and **no signal**. **Residual risk, documented rather than papered over:**
  the window is now microseconds wide but not zero — precisely the residual risk
  `NodeLocalAppRunner.isOurListener` already accepts and documents ("a pgid re-derived through `ps`
  is only trusted once it matches the group we spawned — after pid reuse it can just as easily name
  a stranger's", `src/env/node-local-app-runner.ts:207-217`). We match that posture; we do not claim
  to beat it.

- **R30 — mechanical rules that are cheap to get wrong. BINDING.**
  - **The string `vscode` is banned from every file in `pureSourceFiles()`, prose included.** The
    pure-module assertion is a plain `source.includes('vscode')` (`test/purity.test.ts:26`), not the
    import regex the whole-tree assertion uses (`:51`). So `src/engine/bridge.ts` — the file whose
    entire job is to talk to the extension — may not even *mention* the editor in a comment; write
    "the editor" or "the extension host". Same for `src/engine/manager.ts` and anything else B1/B2
    add to that list.
  - **`deactivate()` disposes the log tail and the config watcher, and still never stops the
    engine** (R16). The `fs.watch` behind the log tail (R11) and the `fs.watch` behind the config
    watcher (§4.5) are both registered in `context.subscriptions` and disposed on deactivate; an
    undisposed watch survives a window reload and tails into a dead output channel.
  - **The spawn-time order is pinned: rotate → spawn → (re)start tail.** Rotate `engine.log` to
    `engine.log.1` if it exceeds 8 MB (R11), *then* spawn (whose `openSync(logPath,'a')` recreates
    the file), *then* start or restart the tail at the new file's current end. Any other order either
    tails a file that is about to be renamed out from under it or replays the rotated content into
    the output channel.

## 4. Design

### 4.1 One setting, and where every path comes from

`cgremlin/vscode/package.json` `contributes.configuration` keeps exactly two properties:

```jsonc
"cgremlin.configPath":        { "type": "string", "default": "~/.cgremlin-core/core.json" },
"cgremlin.notificationLevel": { "type": "string", "enum": ["all","needs-you-only","off"], "default": "all" }
```

`src/settings.ts` shrinks to `{ configPath, notificationLevel }` and keeps `expandHome` **only** for
the `~` in the setting itself (the one path the core cannot resolve for us, because it is the input).
`DEFAULT_SOCKET_PATH` is deleted.

Everything else comes from one call into the bundled engine:

```ts
// src/engine/bridge.ts — no `vscode` import; the only `require` of the bundle.
export interface ResolvedEnginePaths {
  configPath: string; stateDir: string; socketPath: string;
  sessionsDir: string; worktreesDir: string;
  enginePidPath: string; engineLogPath: string;
  repos: readonly string[]; me: string;
}
export interface EngineBridge {
  ENGINE_VERSION: string;
  loadResolvedConfig(path: string, home: string): Promise<ResolvedEnginePaths>;
}
export function loadBridge(extensionPath: string): EngineBridge;   // require(join(extensionPath,'engine/bridge.js'))
```

Failure modes are distinguished, because the UX differs: **missing file** → the first-run flow
(§4.5); **`ConfigError`** → a warning carrying the engine's own wording verbatim (the same rule the
rest of the extension follows, `ui/commands.ts:5-8`) plus an `Open core.json` action; **anything
else** → the output channel.

### 4.2 `GET /version` and the identity/ownership proof

Core side (R1, R13):

```
GET /version → 200 {
  version: "0.0.1", pid: 12345, startedAt: "…Z", socketPath: "/…/engine.sock",
  activeRuns: 0            // R21: live StageRunner runs + in-flight environment preparations
}
```

`version`, `pid`, `startedAt` and `socketPath` are captured once, at build time. `activeRuns` is
computed **per request** —
`pipeline.activeSessionIds().length + (environment?.inFlightCount() ?? 0)` — and is the only input to
the restart gate (R21). It stays answerable on a server with no optional deps because `pipeline` is
required and `environment` is optional (`src/api/server.ts:61-83`).

- `ENGINE_VERSION` lives in `core/src/version.ts` (a literal), with a core test asserting it equals
  `package.json`'s `version` — `resolveJsonModule` is on, but `../package.json` is outside
  `rootDir: "src"` (`core/tsconfig.json`), so an import would break emit; a test is the honest pin.
- The route is a branch at the top of `handleRequest`'s chain, dependency-free, answering before any
  gate. `buildEngine` supplies `engineInfo` alongside the `config` it already passes
  (`src/host/build-engine.ts:206-221`), using its existing clock (`:204`) for `startedAt`.
- **`config.enginePidPath` is created *before* `listenOnSocket`, with `O_EXCL`, and it is the
  mutual-exclusion lock** (R22 — this replaces the earlier "written after we listen" ordering, which
  left a real double-start race, because `listenOnSocket` unlinks a socket nobody answers,
  `src/api/listen.ts:29-32`). Sequence: `mkdir` `stateDir` → `open(enginePidPath, 'wx', 0o600)` →
  write `{ pid, version, socketPath, startedAt }` → `listenOnSocket` → the rest of boot. On
  `EEXIST`, probe the recorded pid (`process.kill(pid, 0)`, classified `ESRCH`→dead /
  `EPERM`→alive-but-foreign as in `node-local-app-runner.ts:249-262`) **and** its socket; alive on
  either signal → exit 1 with `SocketInUseError`; provably dead on both → remove and retake the lock
  once. The file is removed in the same `finally` that unlinks the socket
  (`src/host/serve.ts:214-228`) **and** by an explicit `catch` around `listenOnSocket`, which throws
  before any handle exists. A crash still leaves a stale file — which is why nothing ever trusts it
  alone (rule 1 below, R29).

Extension side, the two rules that make MG-C2 provable:

1. **Never signal anything unless `engine.json`'s `pid` and `GET /version`'s `pid` agree.** A stale
   `engine.json` alone proves nothing (pids get reused); a `/version` answer alone identifies the
   engine but not which process to signal; together they bind `socket → pid → version`.
   Per **R29** the pair is re-read **immediately before every `process.kill`**, and `startedAt` must
   match too — a reused pid has a different boot time. The remaining microsecond-wide window is the
   same residual risk `isOurListener` already documents (`node-local-app-runner.ts:207-217`).
2. **Never restart an engine that did not answer `/version`.** Something is listening on the socket
   and it is not ours: report it, offer `Show log` and `Open Settings`, change nothing.
3. **Never restart an engine that reports `activeRuns > 0` without asking** (R21), and never ask
   when it reports `0` — a prompt with nothing at stake trains the user to dismiss the one that
   matters.

### 4.3 The engine manager (pure state machine + a thin Node adapter)

`src/engine/manager.ts` — no `vscode`, no `child_process`; every effect is an injected port.

```ts
export type EngineState =
  | { kind: 'unknown' }
  | { kind: 'stopped' }
  | { kind: 'starting'; since: number }
  | { kind: 'running'; version: string; pid: number; adopted: boolean }
  | { kind: 'stopping'; since: number; pid: number; elapsedMs: number }   // R23
  | { kind: 'mismatch'; running: string; bundled: string; pid: number }
  | { kind: 'foreign' }                       // something answers the socket, but not /version
  | { kind: 'failed'; reason: string; logTail: readonly string[] };

export interface EngineProcessPort {
  probe(socketPath: string): Promise<{ version: string; pid: number; activeRuns: number } | null>; // null = ENOENT/ECONNREFUSED
  /** R20: `$SHELL -lic 'echo $PATH'`, 5 s cap; null when it times out or gives nothing. */
  resolveLoginPath(): Promise<string | null>;
  /** R26: the handle is kept (unref'ed) only to observe `exit`. execPath is injectable — R25. */
  spawnDetached(spec: { execPath: string; args: string[]; cwd: string; logPath: string; env: Record<string,string|undefined> }): { pid: number; onExit(cb: (code: number | null) => void): void };
  /** R11/R30: rotate BEFORE spawn; no-op below the threshold. */
  rotateLog(path: string, maxBytes: number): Promise<void>;
  readPidFile(path: string): Promise<{ pid: number; version: string; socketPath: string; startedAt: string } | null>;
  signal(pid: number, sig: 'SIGTERM'): 'signalled' | 'gone' | 'foreign';   // mirrors NodeLocalAppRunner.signal
  logTail(path: string, lines: number): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export class EngineManager {
  ensureRunning(): Promise<EngineState>;   // memoized while in flight (one spawn per burst)
  stop(): Promise<EngineState>;
  restart(): Promise<EngineState>;
  state(): EngineState;
  onStateChange(cb: (s: EngineState) => void): () => void;
}
```

`ensureRunning()`:

1. `probe` → answers, version matches bundled → `running{adopted:true}`. **No spawn** (MG-C1).
2. `probe` → answers, version differs → `mismatch` (R2 asks; nothing is killed).
3. `probe` → answers but the body is not a `/version` shape → `foreign`.
4. `probe` → `null` → `starting`; `resolveLoginPath()` (R20, 5 s cap, `engine.path_fallback` on
   failure); `rotateLog` (R11/R30); `spawnDetached`; then poll `probe` every 100 ms up to 10 s
   (R18). First successful probe → `running{adopted:false}`. Timeout, or a spawn that reports no pid
   → `failed` with `logTail(20)`. The child's `exit` while `running` also produces `failed` at once
   rather than waiting for the next probe (R26).
5. Concurrency: `ensureRunning` memoizes its in-flight promise, the same way `serve()`'s `close()`
   memoizes (`src/host/serve.ts:168-172`) — five triggers in one window produce one spawn. A
   second engine also cannot exist even if that memo were defeated: `serve()` takes an `O_EXCL`
   lock on `engine.json` before it listens and the loser exits 1 (R22).
6. Respawn backoff (R26): a spawn the user did not ask for is refused (and logged, not surfaced)
   while within 1 s, then 5 s, then 30 s of the last spawn; after the third it stops trying.
   `failed` is never auto-retried. `cgremlin.engine.start`/`restart` from the user always spawn and
   reset the backoff.

`stop()` = read pid file → probe → require `pid` **and** `startedAt` to agree → re-read/re-probe
immediately before the signal (R29) → `SIGTERM` → poll `probe` every 500 ms for **45 s** (R23) →
`stopped`; any missing or disagreeing proof → `failed{reason}` **without signalling** (MG-C2).
`gone`/`foreign` from `signal` are terminal, never escalated (R3) — no second signal, ever, and no
`SIGKILL`. On the 45 s expiry the state becomes `stopping{elapsedMs}` and probing continues at 1 s
for up to 5 more minutes; a `restart()` queued behind the stop proceeds on the first silent probe,
and only the 5-minute bound turns it into `failed`. `restart()` never spawns while the socket still
answers.

The Node adapter `src/engine/node-engine-process.ts` implements the port with
`http.request({ socketPath })` (the same mechanism as `CoreClient`), `openSync/spawn/unref/closeSync`
copied from `node-local-app-runner.ts:104-116`, and `process.kill` wrapped in the `ESRCH`/`EPERM`
classification from `:249-262`. It is also the only place that knows about `$SHELL` (R20) and about
the child environment R10/R20 assemble: `{ ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: <login
PATH or process.env.PATH> }` minus `NODE_OPTIONS` and every `VSCODE_*` key. The engine scrubs the
same three things from its own `process.env` at startup as a second line of defence (R24).

### 4.4 Wiring, commands, status, log

`src/ui/engine.ts` (a new `ui/*` module, so it takes `Host` as a parameter like every other) owns:

- the four commands `cgremlin.engine.start | stop | restart | showLog`;
- the mismatch and `foreign` prompts (R2 for the shape, R21 for when they are shown at all);
- pushing `EngineState` into the status bar (R17, plus R23's `stopping… Ns`) and one line per
  transition into the output channel;
- the log tail (R11), started when the manager first reports `starting`/`running`, and always in the
  order **rotate → spawn → (re)start tail** (R30) so it never tails a file about to be renamed and
  never replays rotated content.

`extension.ts` grows by roughly 25 lines and no new responsibility: build the process port, build the
manager, `createUi({ …, engine })`, register `onDidChangeConfiguration`, register the config
watcher, and call `ensureRunning()` once (R15). It remains the only file that imports `vscode`
besides `settings.ts` (MG-B1). `deactivate()` pushes both new `fs.watch` handles — the log tail and
the config watcher — through `context.subscriptions` and disposes them, and still does **not** stop
the engine (R16, R30).

`cgremlin.engine.stop` shows a confirmation naming the shared-daemon fact (R16) and the number of
running items it is about to cancel, read from the attention listing.

### 4.5 First run

`configPath` does not exist →

1. `me`: `gh api user --jq .login` (spawned, 5 s timeout); on any failure an input box
   (`Your GitHub login`); on cancel, stop here with one warning — **no file is written** (R4).
2. Run the bundled engine: `node engine/engine.js config init --config <path> --me <login>` (R5).
   Template: `{ me, repos: [], runner: 'claude-code' }` — everything else is a schema default, and
   `writeCoreConfig` omits every derived path.
3. `window.showTextDocument(configPath)` + an information message: *"Created `<path>`. Add the repos
   you want cgremlin to watch; the engine restarts when you save."*
4. `ensureRunning()`.

The config watcher (`fs.watch` on `dirname(configPath)`, filtered by basename, debounced 500 ms) is
required to watch the **directory**: `writeCoreConfig` replaces the file by rename
(`src/config/core-config.ts:284-288`), and a watch on the inode would be orphaned by the first save
from the engine's own `config init`. Behaviour on a change is R6 as amended by **R21** and **R27**:
load through the bridge first; on `ConfigError` show the engine's wording verbatim with
`Open core.json`, leave the engine alone and re-arm; on success re-assert mode `0600` best-effort
(`Host.chmod`, one logged line on failure) and then restart under R21's `activeRuns` gate —
automatically at `0`, behind a modal prompt above it. The watcher is disposed on deactivate (R30).

### 4.6 Live settings

`onDidChangeConfiguration(e)` where `e.affectsConfiguration('cgremlin')`:

- re-read the setting; if `configPath` is unchanged, only `notificationLevel` can have changed and
  nothing else happens (it is already read live, `extension.ts:41`);
- otherwise: re-resolve through the bridge, re-point the socket provider (R7), restart the config
  watcher, `sse.stop()` / `sse.start()`, `coordinator.connect()`, and `ensureRunning()` for the new
  socket. The old engine is **left alone** — pointing the extension elsewhere is not a request to
  kill a daemon (R16).

### 4.7 Packaging

```
cgremlin/vscode/
  out/**                 tsc output (unchanged)
  engine/engine.js       esbuild bundle of core/src/host/engine-main.ts   (gitignored artifact)
  engine/bridge.js       esbuild bundle of core/src/host/extension-bridge.ts
```

`cgremlin/core/package.json` gains
`"build:engine": "esbuild src/host/engine-main.ts --bundle --platform=node --format=cjs --target=node20 --sourcemap=inline --outfile=../vscode/engine/engine.js && esbuild src/host/extension-bridge.ts --bundle --platform=node --format=cjs --target=node20 --sourcemap=inline --outfile=../vscode/engine/bridge.js"`
(the `--sourcemap=inline` on both is R28)
and `esbuild` in `devDependencies`. `cgremlin/vscode/package.json`:
`"build": "pnpm --dir ../core build:engine && tsc -p tsconfig.json"`, plus
`"vscode:prepublish": "pnpm build"` and `"package": "vsce package --no-dependencies"`.

`.vscodeignore` (new file) is **exclude-only** — the format is a `.gitignore`-style deny list over an
otherwise-complete tree, so there is nothing to "include" (R28). It excludes `src/**`, `test/**`,
`node_modules/**`, `docs/**`, `.vscode/**`, `**/*.ts`, `tsconfig*.json`, `vitest.config.ts`,
`eslint.config.js`, `pnpm-lock.yaml`, `**/*.map`, `.gitignore` and `.vscodeignore`; `out/**/*.js`,
`engine/**`, `README.md` and `package.json` ship because nothing excludes them. `--no-dependencies`
is what keeps pnpm's symlink farm out of the vsix (R8). Both bundles are built with
`--sourcemap=inline` (R28) so a crash still yields a readable stack trace and there is no separate
`.map` for a packaging rule to strip.

## 5. Testing strategy

**Extension, pure (vitest, no editor):**
`test/engine/manager.test.ts` drives `EngineManager` against a fake `EngineProcessPort`: adopt,
spawn-and-wait, spawn-timeout, child-exits-early (R26's `exit`-driven `failed`), mismatch, foreign,
stop-with-proof, stop-without-proof, stop-timeout→`stopping`→late-silence (R23),
proof-changes-between-check-and-signal (R29), respawn-refused-inside-backoff and
user-start-always-allowed (R26), `resolveLoginPath` timeout → `engine.path_fallback` (R20),
rotate-before-spawn ordering (R30), and five-concurrent-`ensureRunning`-one-spawn. `test/engine/bridge.test.ts` asserts
`loadBridge` fails with an actionable message when the artifact is missing (the "you ran `tsc` but
not `build`" case).

**Extension, adapter:** `test/engine/node-engine-process.test.ts` probes a real `http.Server` on a
temp socket (the `stub-server.ts` pattern, `test/support/stub-server.ts:99`), and asserts `probe`
returns `null` for a path that does not exist and for a **stale socket file** (a socket file with
nobody listening → `ECONNREFUSED`), and that nothing is unlinked in either case.

**Extension, integration (extends `test/integration/real-engine.test.ts`'s harness):**
`startEngineViaManager()` boots the **bundled** artifact through `EngineManager` (not
`bin/cgremlin-core`), and asserts: the socket appears; `/version.version === bridge.ENGINE_VERSION`
(MG-C5); a second `ensureRunning()` adopts without spawning (MG-C1); `stop()` removes the socket
*and* `engine.json`; a `stop()` against a mutated pid file signals nothing (MG-C2); the bundle scrubs
`ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`/`VSCODE_*` from its own env (R24, via the
`CGREMLIN_ENGINE_PRINT_ENV` debug flag); a spawn through the real `Code Helper (Plugin)` reports
`process.versions.electron` and Node ≥ 20, or skips with the path (R25); and the existing Phase 7
suite still passes against a manager-booted engine.

**Core:** `/version` route test (including `activeRuns` from both terms, R21); `serve()` takes the
`O_EXCL` `engine.json` lock **before** it listens, refuses a second engine with `SocketInUseError`,
takes over a provably dead one, and removes the file both in `close()`'s `finally` and when
`listenOnSocket` throws (R22; a failed `close()` still removes it, mirroring the socket assertion at
`core-harness.ts:184-186`); the two-process race (R22/MG-C1);
`config init` writes a `0600` file that `loadCoreConfig` accepts, refuses to overwrite without
`--force`, and produces a config whose `repos` is empty and which still boots an engine; the new
`stateDir` default and the two new derived paths, asserted in **both** `resolveCoreConfig` and the
persisted-file shape.

### Mutation guards

| Id | Name | Fails when |
|---|---|---|
| MG-C1 | `no-second-engine` | `ensureRunning()` spawns while a probe answers, **or** two managers/`serve` processes started concurrently against one `stateDir` both come up (R22's race case: exactly one engine, the loser exits 1, the winner's socket still answers `/version`) |
| MG-C2 | `never-kill-what-we-cannot-prove` | `stop()` signals a pid that the socket's `/version` does not confirm, or signals with only a pid file / only a probe |
| MG-C3 | `socket-setting-is-gone` | `cgremlin.socketPath` reappears in `package.json`, `src/`, `test/` or the READMEs |
| MG-C4 | `legacy-state-dir-is-quarantined` | `~/.cgremlin/` appears outside `core/src/cli/commands/config.ts` and its test (and the historical specs) |
| MG-C5 | `bundled-engine-is-the-engine-we-run` | the version the extension reports as bundled differs from the spawned engine's `/version` |
| MG-C6 | `extension-derives-no-state-paths` | `engine.sock`, `engine.log`, `sessions/` or `worktrees/` is joined by hand anywhere under `cgremlin/vscode/src` |
| MG-C7 | `no-engine-start-via-terminal` | any `sendText` in `cgremlin/vscode/src` mentions `serve` |
| MG-C8 | `vsix-is-self-contained-and-lean` | `vsce ls` omits `engine/engine.js`, `engine/bridge.js` or `out/extension.js`, or includes `node_modules/`, `src/`, `test/`, `*.ts`, `docs/` or any `out/**/*.map` (R28 — engine sourcemaps are inline, so no `engine/*.map` is expected to exist) |

## 6. What this does not fix

- A machine with no `claude`/`gh` on the **login shell's** `PATH` still fails at the first agent run.
  R20 removes the common case (a GUI-launched editor's truncated `PATH`) by asking `$SHELL -lic` for
  the real one, and the engine's first log line records what it ended up with (R10), so the failure
  is diagnosable in one click — but a tool that is genuinely not on the user's own `PATH` is still
  the user's shell setup to fix.
- Nothing migrates legacy sessions (U3). A user with history in `~/.cgremlin/sessions` starts empty.
- The engine is still a per-machine singleton keyed by one socket; two different `configPath`s in two
  windows means two engines, which is correct but means two log files and two status bars that each
  only know their own.
