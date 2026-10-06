# Decisions

Dated rulings recorded in the phase design specs (`cgremlin/core/docs/superpowers/specs/`).
Each entry is one line of rationale plus a pointer to where it was decided. Where the
shipped code and a spec disagree, the code is what actually runs — see the parent
conversation's report for the specific discrepancies found while writing this doc set.

## 2026-08-28 — Rebuild design

- **Rebuild, don't patch.** `bin/cgremlin` (~15,000 lines of bash + an embedded ~5,200-line
  Python heredoc) has no test suite and no separation between engine and shell; a ground-up
  TypeScript rebuild is deterministic and unit-testable in a way the bash never could be.
  *§0.*
- **Three independently-replaceable layers**: frontends → engine (daemon, local
  HTTP-over-socket API) → agent-runner adapters. No frontend ever touches `session.json` or
  git directly. *§2.*
- **Worktrees, not shallow clones.** One bare/mirror clone per repo, a `git worktree` per
  session — cheap to create and discard, avoids re-fetching the whole repo per session.
  *§4.*
- **One `AgentRunner` interface, two adapters** (Claude Code, Codex), contract-tested
  identically so the engine's pipeline logic stays agent-CLI-agnostic. *§5.*
- **PR-discovery is its own module**, deliberately over-separated relative to how small the
  logic is, because it's the piece expected to keep changing independently of the
  orchestration engine. *§6.*
- **The engine never posts to GitHub** — invocation + bookkeeping only; the
  reader→reviewer→verifier review logic itself stays in an external Claude Code skill,
  invoked headlessly. *§7.*
- **Phase-1 UI is deliberately disposable** — a placeholder local dashboard, later dropped
  entirely (see 2026-09-04 below) in favor of CLI + a future plugin-style UI against the
  same API. *§9.*

## 2026-09-04 — Phase 3 (Pipelines)

- **Artifact-driven completion, not agent callbacks.** The agent never calls back into the
  engine (legacy had it invoke `cgremlin --plan-ready` etc.); the engine runs one headless
  turn, waits for exit, and reads what was left on disk. Removes the whole class of bug
  where an agent skips or misorders a callback, and needs no CLI shipped inside the
  worktree. *§2.1.*
- **Local-only side effects.** Only read-only `gh` calls (`pr view`, `pr list`) run from the
  engine; any GitHub mutation is deferred to a later, explicit, user-triggered action.
  *§2.2.*
- **Own-PR comment triage deferred** — a distinct feature with its own polling/mutation
  surface, parked past Phase 4. *§2.3, §1 Out.*
- **Failure is a phase only where the phase is an activity.** Review phases gain `failed`
  (they're activity states); investigation/development leave `stageStatus` unchanged on a
  failed run and record it in `lastRun` (they're artifact milestones). *§2.4.*
- **Promotion creates a new development session** rather than flipping `mode` in place —
  the new schema makes `promoted_to_development` terminal, so both records exist and the
  audit trail is honest about what happened. *§2.5.*
- **The brief lives in the session directory, not the worktree** (`<sessionDir>/BRIEF.md`
  via `--add-dir`), so the worktree stays clean of engine files except the permission
  guard. *§2.6.*
- **Multi-turn stages use `--resume`** so a findings→plan sequence keeps its conversation
  context, with the resume id persisted on the session so a restarted engine can continue.
  *§2.7.*
- **Amended mid-phase**: `plan_ready`/`approved` both get a direct edge to
  `promoted_to_development` — the table originally lacked this and an implementation
  synthesized an `approved` step nobody actually took; the audit trail must never show an
  approval that didn't happen. *§3, amended during Task 8.*
- **Amended mid-phase**: GitHub facts (merge, close, approval) apply from any non-terminal
  review phase, matching legacy's unconditional behavior — not just the phases the local
  pipeline would naturally have reached. *§3, amended during 3b Task 6.*
- **A supervising-agent feature was proposed and deferred** to its own phase, after Phase 4,
  because it is a client of the engine API plus the (then-planned) event stream and
  introduces a second, long-lived-interactive agent-runner shape the original interface
  didn't anticipate. *§8.*

## 2026-09-04 — Phase 4 (PR inventory, host, CLI)

- **The dashboard was dropped.** The user decided the UI will be a VS Code plugin or app
  later, reading the engine's API — Phase 4 replaces the planned dashboard with a runnable
  host (`serve`) and a CLI. *§0.*
- **No more auto-reviewing every discovered PR.** The tick used to auto-start a review for
  any newly-discovered candidate; that policy burns tokens on PRs nobody asked to have
  reviewed. Discovery becomes a scan that only produces data; starting a review is now an
  explicit action (`review <url>` / `POST /prs/.../review`); re-review of PRs *already*
  tracked stays automatic. This reverses the earlier Phase 3b ruling and retires
  `DefaultPRDiscoveryStrategy`'s auto-start path. *§0, §4.*
- **Team activity counts any review or conversation comment** from a watched-authors login
  that isn't `me` — bots are excluded by construction (the watch list is an allowlist, not
  a denylist heuristic on `is_bot`). *§3.*
- **Posting to GitHub, when built, is a separate structured-input component** — it would
  receive a verdict and per-finding `{path, line, body}` items and perform the `gh` write;
  it would never itself read or know `REVIEW.md`'s format. Still fully deferred as of this
  writing. *§9.*

## 2026-09-09 — Phase 5 (Environment tooling)

- **Environment preparation happens before the per-session lock is taken; the engine still
  starts the app before the stage run and stops it after; agents never request it.** An
  earlier draft put the local-app start inside the locked pre-run callback; that would hold
  the session lock for up to 90+ seconds (healthcheck) plus a cold `vercel
  link`/`env pull`/`pnpm install`, blocking `stop` and everything else on that session for
  the whole window. Moved outside the lock instead, accepting that a concurrent action can
  occasionally race it (handled safely: the locked pre-run re-validates and, if it loses,
  the just-started app is torn down). *R4, amended.*
- **A failed local-app start degrades the stage; it does not fail it.** Killing a
  40-minute investigation because a dev backend was briefly unreachable is strictly worse
  than telling the agent to verify what it can statically. *R5.*
- **Foreign processes are never killed.** A port held by anything the engine did not
  itself start becomes an `unavailable` status, never a kill — this deliberately diverges
  from the legacy tool, which killed the squatter with only a warning. An engine running
  unattended must not kill a process it didn't start. Boot-time orphan reaping is
  correspondingly narrow: only a process group the engine itself recorded, and only when
  it can still be proven to be the same one. *R6, R13.*
- **The Vercel preview URL comes from the `vercel` bot's PR comment, not the `vercel` CLI**
  — verified live that the CLI is never used for this in legacy, and that the GitHub
  status-check entry carries only an inspector URL, not a navigable deployment URL. *R7.*
- **Local-app stages and preview stages are independently configurable**, defaulting to
  legacy behavior (`develop` gets a local app; `review`/`rereview` get a preview) —
  `findings` can opt in but isn't on by default. *R8.*
- **Review/rereview briefs carry the full legacy REVIEW.md output contract verbatim**,
  restoring behavior that had silently dangled (the prompt referenced a `CLAUDE.md`
  section the engine never wrote). *R9, R10.*
- **Machine prerequisites are config-driven and only ever checked, never fixed.** The
  engine does not edit `/etc/hosts`, configure a port-forward, or install `nvm` versions;
  a dev command that exits before its healthcheck passes is reported with its own log
  output (fast-fail, not a 90-second stall) rather than worked around. *R11, amended.*
- **`nvm` is honored via a login-shell wrapper**, matching legacy exactly, but a missing
  Node version is reported as a prerequisite failure rather than silently installed
  (installing would mutate the user's default nvm alias, a side effect legacy itself
  flagged as unwanted). *R12.*
- **A repo with no `environments` entry renders nothing about environments at all** — not
  just an empty section, but the prompt sentence that would tell the agent to run a LIVE UI
  CHECK is omitted too. The gate is "was the section actually rendered," not a separate
  config flag, so a repo with no Vercel deployment is never told to check a URL that
  doesn't exist. *R14.*
- **The local-app state file is guarded by a dedicated, non-session lock key**
  (`local-app:<port>`) on the same shared lock the sessions use — this is what makes
  "single local-app instance" actually true under concurrent starts, and it cannot nest
  with a session lock because environment prep already runs outside one. *R15.*
- **On shutdown, sessions stop before the local app does.** Pulling the dev server out from
  under an agent still mid-run would look like an app crash rather than a clean shutdown.
  *R16.*

## 2026-09-10 — Phase 7 (VS Code UI v1)

Pointer: `cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase7-vscode-ui-v1-design.md`.

- **The VS Code extension is the UI; two layers only.** Core owns state, rules and side effects;
  the extension owns presentation and intent. Anything the UI needs that the core cannot answer
  becomes a core feature, never a UI workaround. *R1.*
- **v1 scope is fixed at stream A items 1–9 and stream B items 10–16**; v2 items (own chat pane,
  structured findings, an MCP server, inline screenshots, GitHub posting, legacy migration,
  multi-repo workspace, a Jira parking lot) are out, and no v1 decision may preclude them. *R2.*
- **A managed multi-root `cgremlin.code-workspace` file**, never a plain single-folder window —
  so adding a worktree is an `updateWorkspaceFolders` call inside an already-multi-root workspace,
  never the single-folder→multi-root transition that restarts the extension host. *R3.*
- **Chat is a plain terminal**: `createTerminal({ cwd }).sendText('claude --resume <id>')`, never
  the Claude Code extension's undocumented `claude-vscode.*` commands or URI handler — neither
  accepts a `cwd` for a resume. *R4.*
- **The locking invariant and "no automatic review start" rule are untouched.** Nothing in Phase 7
  starts an agent that was not explicitly asked for. *R5.*
- **A live run's `AGENT_STATE` is authoritative even mid-run.** Core has one state file
  (`AGENT_STATE`), written by `StageRunner` at run start and overwritten by the agent only at a
  deliberate gate — so a mid-run `needs-input`/`blocked` is a real agent statement, not stale
  activity, and is reported alongside a separate `running: true` flag rather than suppressed until
  the turn ends. *R6.*
- **`artifact.changed` and watch-driven `attention.changed` come only from the filesystem watch;
  everything session-record-derived recomputes on existing engine events** — emitting on both the
  engine's own writes and the watch would double-emit, since the watch covers the same directory
  those writes land in. *R7.*
- **`run.output` is excluded from `/events` unless requested (`?include=run.output`), and always
  redacted** — one turn emits hundreds of chunks and they can carry a bypass URL; this is the v2
  chat-pane hook. *R8.*
- **Claiming a conversation is refused while a run is in flight** (409, `stop` first — two
  `claude --resume` processes on one transcript is unrecoverable corruption); the converse (the
  pipeline refusing a claimed session) is authoritative only inside the locked pre-run check, never
  the pre-lock advisory copy alone. *R9.*
- **Acknowledgement lives in its own store** (`attention-acks.json`, keyed by `ItemRef`), not on
  the session record — an ack must exist for inventory items with no session, the session schema is
  versioned/migration-bearing and an ack isn't pipeline state, and an ack write must never contend
  with the per-session lock. *R10.*
- **The primary artifact is chosen by the core** (`pickPrimaryArtifact`), not the UI — a per-mode
  rule identical for every frontend. *R11.*
- **`claimed` is exposed on the attention item and on `GET /sessions/:id/conversation`; the
  inventory schema is not changed** — adding a field there would touch the scanner and every
  persisted `inventory.json` for no benefit, since the UI already fetches `/attention?all=1`. *R12.*
- **The extension builds with `tsc`, has zero runtime dependencies, and no bundler** — `out/*.js`
  loads directly in the extension host, and vitest imports the same sources with no build step.
  *R13.*
- **Pure modules in the extension must not import `vscode`** — the request/mapping/policy layer is
  unit-tested without an Electron harness; only `extension.ts` and `src/ui/*` touch the editor API,
  enforced by a source-grep guard (MG-B1). *R14.*
- **One worktree folder at a time, no pinning or LRU in v1.** Opening a session swaps the managed
  workspace's single folder; the status bar names the session whose repo is open because that is
  now load-bearing information. *R15.*
- **A development session can be created directly, and the develop stage's plan gate is
  preserved** — it stops at the existing `needs-input` gate in the develop brief; there is
  deliberately no new phase, and approving that plan happens through Chat, not a new headless route.
  *R16.*
- **A review can be started from any PR URL, including a repo the scan does not watch**
  (`POST /reviews`) — reconciliation already covers these sessions unchanged, since it iterates
  sessions and fetches each one's own PR rather than consulting `config.repos`; only the "PRs we
  are reviewing" list needed to become session-derived rather than inventory-derived. *R17.*
- **Every item is a generic `Item` with a `source`**, and both the attention model and the panel's
  view model are defined over it — the roadmap's Jira/Slack sources are added as an adapter plus a
  `derive*Reasons`, touching neither the shared evaluator nor the view model's list-building.
  *R18.*
- **The human-turn refusal is checked twice**: an unlocked advisory check, first statement after
  each stage's existing mode check (so a refusal costs no environment setup or git work), and the
  authoritative locked check inside each stage's `preRun` — necessary because `prepareEnvironment`
  and (for rereview) a `git fetch`/`reset --hard` both happen before the locked check would
  otherwise run. *R19.*
- **A claim expires, and four paths clear one that gets orphaned**: expiry (reaped by the first
  authoritative check that trips over it), a boot-time clear of every session's claim, a terminal
  phase transition, and `cgremlin-core release`. The reconciliation tick skips (not errors) a
  claimed session's re-review, while merge/close/approve transitions still apply on schedule and
  clear the claim. *R20.*
- **`/events`' fan-out is explicit, ordered, bounded and back-pressured**: replay hands over to a
  live ring subscription with no gap and no duplicate; `since(n)` past the ring's bounds triggers an
  explicit resync frame rather than silent waiting; a lagging connection drops only `run.output`
  frames and is destroyed past a bounded pending-frame ceiling. *R21.*
- **The core says whether an item needs *you*; the extension only decides whether that pops.**
  `AttentionState.needsYou` is the one source of truth; the extension's notify policy filters on it
  and the user's setting, and carries no copy of `NEEDS_YOU_REASONS`. An engine-died run
  (`lastRun.outcome === 'running'` with nothing actually running) derives `run_failed` rather than
  showing no indicator at all. *R22.*
- **`POST /reviews` on an already-tracked PR answers 200, exactly like the inventory-originated
  review route** — the caller's intent ("get me a review of this PR") is satisfied by the session
  that already exists, and two routes with one meaning must not disagree on a status code; a PR
  authored by `config.me` still answers 409. *R23.*

**Accepted deviations found while executing the plan**, kept because the code they describe is what
actually runs (see this file's header):

- **A review session in `changes_requested` is non-terminal, not terminal.** The review phase table
  (`src/schema/pipeline.ts`) allows `changes_requested → reviewing | dismissed | approved`, and
  `TERMINAL_PHASES_BY_MODE.review` (`src/workspace/workspace-in-use.ts`) is `{approved, dismissed}`
  only — `changes_requested` stays open specifically so the re-review path (a PR updated after
  changes were requested) can still fire.
- **`promote()` checks the human-turn claim under its own lock**, not via a shared call from
  `runDevelop`'s pre-run: promoting is itself the write the human's conversation is about, and no
  stage's own check can protect it (the terminal-transition clear that `transition` performs would
  itself un-claim the session), so `promote()` carries its own advisory-then-authoritative pair
  ahead of `assertCanPromote`.
- **SSE delivery to a live client goes only through the `EventRing`'s subscription**, never a
  second, parallel event path — `handleEventStream` subscribes to `ring`, not to `EngineEvents`
  directly, so the ring's ordering and bounding guarantees (R21) cover every frame a client sees.
- **`AttentionService.refresh` debounces as in-flight coalescing plus one trailing recompute**, not
  a fixed-window debounce: a burst of triggers for the same scope collapses to at most one recompute
  already running and one more queued behind it, rather than a timer restarted on every trigger.
- **Delta detection (`attention.changed`'s "only on a real change" guarantee) ignores `links`** —
  it compares the reasons/since/claimed/running shape of an item, not its `ItemLinks`, so a
  `primaryArtifact` or `worktreePath` value settling in does not itself count as the delta that
  justifies an event.

## 2026-09-10 — Phase 8 (the extension ships the engine)

Pointer: `cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase8-bundled-engine-design.md`.
User decisions: **U1** one setting, and it names the config JSON; **U2** the engine ships with the
extension and starts itself; **U3** no legacy import — start fresh, which was declined explicitly
and is not a deferral: nothing reads `~/.cgremlin` except `config import-legacy`, run by hand.
R1–R19 were confirmed on 2026-09-10; R20–R30 are supervisor rulings from the same pass, several of
which amend an earlier R.

- **R1 — `GET /version`, not a field on `/config`.** `/config` 404s on a server with no config dep,
  so its answer cannot distinguish "not our engine" from "our engine, no config"; a probe needs a
  route that always answers, and a pid does not belong in a config document. *Amended by R21,
  which adds `activeRuns`.*
- **R2 — a version mismatch never silently cancels work.** A restart stops every active run, so a
  mismatch is a modal prompt naming both versions, `Not now` remembered for the window, and the
  mismatched engine left running and usable. *Amended by R21: the prompt only appears when
  `activeRuns > 0`.*
- **R3 — stop is `SIGTERM` only, against a pid proved twice, with no `SIGKILL` ever.** Only
  `close()` stops agents, clears claims and stops the local app in the right order; a hard kill
  orphans a dev server that only the next boot could reap. *Amended by R23 (budget and the
  `stopping` state) and R29 (the proof is re-taken before every signal).*
- **R4 — `repos` loses `.min(1)` and defaults to `[]`; `me` stays required.** A first-run template
  must load; an empty `me` would silently defeat the own-PR refusal, so the extension supplies a
  real login or writes nothing.
- **R5 — the template is written by the core, not the extension.** `config init` goes through the
  one config writer (`writeCoreConfig`: tmp → 0600 → rename, derived paths omitted), which is also
  what gives the CLI the same bootstrap for free.
- **R6 — the config file is watched, and a save restarts the engine.** *Completed by R27:
  validate through the bridge first, re-assert 0600, and leave the engine alone on a `ConfigError`
  with the watcher still armed.*
- **R7 — the socket path is a provider function, not a value captured at activation**, so a
  settings change takes effect without a window reload.
- **R8 — one `.vsix` carrying two esbuild bundles and no dependencies** (`--no-dependencies` keeps
  pnpm's symlink farm out). *Refined by R28.*
- **R9 — the bundle's type is declared locally in the extension**, because esbuild emits no
  declarations and the core's own ones drag `zod` in; the logic still lives in the engine.
- **R10 — the manager sanitizes the child's environment** (`NODE_OPTIONS`, every `VSCODE_*`) and
  sets `ELECTRON_RUN_AS_NODE=1`. *Extended by R20 (the login-shell `PATH`) and R24 (the engine
  scrubs its own env too).*
- **R11 — the engine logs to `<stateDir>/engine.log`, tailed into the output channel, rotated to
  `engine.log.1` past 8 MB.**
- **R12 — four `cgremlin.engine.*` commands replace `cgremlin.startEngine`**, which typed a shell
  command into a terminal and needed `cgremlin-core` on `PATH`.
- **R13 — two new derived paths, `enginePidPath` and `engineLogPath`**, registered in both
  `resolveCoreConfig` and `DERIVED_PATH_SUFFIXES`. *Amended by R22, which makes `engine.json` a
  lock rather than a report.*
- **R14 — the test fixtures move to `.cgremlin-core` with the default**, so the quarantine grep
  over `~/.cgremlin/` stays meaningful.
- **R15 — first run is `gh api user --jq .login`, then an input box, then nothing** — cancelling
  writes no file and explains why.
- **R16 — the engine is a machine-wide daemon**: shared by every window, never stopped on
  `deactivate()`, and `engine.stop` confirms, naming the shared-daemon fact and the count of
  running items.
- **R17 — engine state lives in the status bar**, one text and click target per state.
- **R18 — start polls at 100 ms for 10 s**, kinder to an editor than the harness's 25 ms.
- **R19 — `@vscode/vsce` is added as a devDependency and nothing else is**, so packaging is
  verifiable in this repo rather than on a developer's global install.
- **R20 — the engine's `PATH` comes from `$SHELL -lic 'echo $PATH'`, capped at 5 s**, because a
  GUI-launched editor's `PATH` need not contain `claude` or `gh`. A timeout, a non-zero exit or
  empty output falls back to the host's own `PATH` with exactly one logged line.
- **R21 — `GET /version`'s `activeRuns` is the single authority on whether a restart is safe.**
  It is computed per request from **both** the active-run map and the environment preparations
  still in flight, because cancelling a preparing stage is just as destructive. Zero → restart
  silently and log one line; more than zero → a modal prompt. `/attention` is not an input.
- **R22 — `engine.json` is an admission lock, taken before `listenOnSocket`, not a report written
  after it.** `listenOnSocket`'s liveness test is a connect and it unlinks a socket nobody answers,
  so it cannot be the mutual-exclusion primitive; one engine per state dir, the loser exits 1.
  **Spec correction found in implementation:** `open(path, 'wx')` is exclusive but publishes a
  zero-byte file a loser can read before the winner has written a word — which looks exactly like a
  dead owner to take over. The lock is therefore written to a temp file and `link()`ed into place,
  which is atomic and fails `EEXIST`. **Second correction:** taking over a lock whose pid is alive
  but silent requires a `ps -o command=` check — a pid alone is not ownership, and without the
  check one recycled pid would make every later `serve` refuse forever.
- **R23 — the stop budget is 45 s at 500 ms, and a timeout becomes `stopping`, never a harder
  signal.** R3's 10 s was a guess against a `close()` that awaits a scheduler tick, every active
  stop, `abortAll()` and the local app. Past the budget the manager keeps probing at 1 s to a
  5-minute bound; `SIGKILL` is still never sent.
- **R24 — the engine scrubs `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and every `VSCODE_*` key from
  its own `process.env` before it starts**, so every `bash -lc` it later spawns for an agent is
  clean even when the launcher's sanitization was bypassed. `CGREMLIN_ENGINE_PRINT_ENV=1` is the
  testable seam: it prints what survived and exits 0 without starting an engine.
- **R25 — one integration case spawns through the real `Code Helper (Plugin)`** and asserts, from
  the engine log, a non-empty `process.versions.electron` and a `process.version` major ≥ 20 —
  or skips with the path it looked for. It ran on the development machine: Electron 42.10.0,
  Node v24.18.1.
- **R26 — the manager supervises the child it spawned, with a bounded backoff.** An exit while
  `running` is a failure immediately, not at the next poll. Automatic respawns are gated at 1 s,
  5 s, 30 s and then never; a user-initiated start is always allowed and resets the gate.
  **Implementation correction found by the Phase 8 integration suite:** the gate must reset when
  the engine *answers*, not only when the user asks — counting a successful spawn made R21's
  silent restart wait out a backoff it never earned, and three of them exhausted it for good.
- **R27 — the config watcher validates before it restarts, and re-asserts 0600.** A `ConfigError`
  leaves the engine completely alone, shows the engine's wording verbatim, and keeps the watcher
  armed. The mode matters late, not now: `loadCoreConfig` only demands 0600 once the config holds
  a secret.
- **R28 — packaging specifics.** `.vscodeignore` is exclude-only (the format is a deny list over
  an otherwise-complete tree; there is no include syntax). Both bundles carry `--sourcemap=inline`,
  so a crash yields a readable trace and no `.map` exists for a packaging rule to strip. MG-C8 is
  narrowed accordingly. The manifest gains a truthful `repository` (git origin) and keeps
  `"license": "UNLICENSED"`; `vsce package` accepted it, warning only that no LICENSE file exists,
  so none was added and `--allow-missing-repository` was not used.
- **R29 — the ownership proof is re-taken immediately before every signal**, requiring `pid` *and*
  `startedAt` to still agree, because reading, probing and then killing is a check/use window a
  reused pid can walk through. The residual window is microseconds wide and not zero — the same
  posture `isOurListener` already documents.
- **R30 — mechanical rules that are cheap to get wrong.** The string `vscode` is banned from every
  file in `pureSourceFiles()`, prose included, because that assertion is a plain `includes`.
  `deactivate()` disposes both `fs.watch` handles and still never stops the engine. The spawn-time
  order is pinned: rotate → spawn → (re)start the tail.
- **The probe's third answer is `foreign`.** A socket that answers something that is not a
  `/version` shape is neither "nobody home" (`null`) nor an engine: nothing is spawned against it
  and nothing is ever signalled.
- **A start or stop is tagged `'auto'` or `'user'`.** The distinction is not cosmetic: it is what
  R26's backoff is measured against, and a person is entitled to retry a broken engine as often
  as they like.

## 2026-09-10 — Phase 9 (Work items)

Rulings live in `docs/superpowers/specs/2026-09-10-cgremlin-phase9-work-items-design.md`
(D1–D8, R1–R67). Recorded here as the phase lands, task by task.

- **R6 reverses the "no `is_bot` heuristic" line above** (the Phase 4 entry: *"bots are excluded
  by construction — the watch list is an allowlist, not a denylist heuristic on `is_bot`"*).
  Answering *"has any human reviewed this PR"* is a different question from *"has a teammate I
  watch reviewed this PR"*, and it cannot be answered from an allow-list: a reviewer outside
  `watchAuthors` is still a human. `humanActivity` is therefore computed from the raw, unfiltered
  reviews and comments through one bot predicate (`src/work/bot-login.ts`), while `teamActivity`
  keeps its allow-list semantics untouched. The reversal is deliberate and scoped to the new
  field. *R6, R47.*
- **U1 is CLOSED, in the negative.** A real `gh pr list --json reviews,comments` against
  `aplaceformom/grace-frontend` (recorded as `test/fixtures/gh/pr-list-with-bot-reviews.json`,
  2026-09-10) emits activity authors carrying **only** `login`. `is_bot` is present on the
  PR-level `author` object and nowhere else. R5's clause (a) therefore never fires on inventory
  data, and the `[bot]`-suffix plus `botLogins` list carries the whole load. It has to: the bots
  active on that repo — `vercel`, `github-actions`, `gitstream-cm`, `apfm-sonar` — carry no
  `[bot]` suffix at all, and the last two are not in `DEFAULT_BOT_LOGINS`, so a real deployment
  must name them in `config.botLogins`. *A2, R5.*
- **U6 is CLOSED, in two halves.** `statusCheckRollup` on `gh pr list` is the **same**
  `CheckRun`/`StatusContext` union `gh pr view` emits (plus a `startedAt` the schema strips), so
  R59's `.catch([])` was **not** load-bearing for the shape and stays as cheap insurance.
  `reviewRequests`, by contrast, came back as **teams** (`{ __typename, name, slug }`) on every
  single PR in the sample: **R60's union is load-bearing**, and the
  `z.array(z.object({ login: z.string() }))` the ruling forbids would have thrown on the first
  row. The 32-PR repo did not trip GitHub's node limit even at `--limit 100`, so R67's two-call
  fallback remains covered by fixtures and by smoke step 1 only. *A2, R59, R60, R67.*
- **R56's create-and-start click, recorded explicitly against Phase 7 R5 / MG-8.** "Nothing starts an
  agent that was not explicitly asked for" still holds: the user's click on a lit `waitingForReview`
  row **is** the explicit ask, and it is a `POST`, not a read. So
  `POST /items/pr/:o/:r/:n/agents { mode: 'respond' }` creates the session AND starts the respond run
  in the same request, answering `202` with `started: true`. MG-8 is amended to match — it still
  asserts **zero** starts from every `GET`, and now asserts exactly one from that `POST`. The
  alternative hands the user a session with an empty `BRIEF.md` and a second button to press.
  *A9, R56.*
- **`'respond'` is a `STAGE_NAME`, appended.** `STAGE_NAMES` is three contracts in one array — the
  `POST /sessions/:id/run` validator, the persisted `lastRun.stage` type, and the
  `run.started`/`run.finished` payload type — so a respond session running a stage named anything
  else could not be started, recorded or reported. Appending keeps every persisted `lastRun.stage`
  meaning what it did. *A9, R56.*
- **The v1 session union is deliberately not extended.** There were no respond sessions before
  Phase 9, so a v1 respond document cannot exist and `migrateV1ToV2` needs no case for it. Both
  unions are discriminated on `mode`, so the fourth variant is additive and every document already
  on disk keeps matching its own branch — MG-13 pins that against six committed pre-Phase-9
  fixtures. *A9, R51.*
- **Nothing in v1 posts to GitHub.** The respond agent's permission set denies every mutating
  `gh pr` verb and `gh api --method`; `renderRespondBrief` carries the out-of-scope line in the
  brief itself; and the respond-flow tests run against a `GhRunner` fake that throws on any
  mutation. The legacy `--reply-comment` / `--resolve-comment` / `--push-fix` verbs are not ported.
  v1 ends at "the fix is committed locally"; the drafted replies live in `COMMENTS.md`. *A9, R55.*

### The shape of the thing (D1–D8, R1–R46)

- **A work item is a GROUPING over attention items, never a second derivation** (R1, D1).
  `src/work/` reads no session document, no `AGENT_STATE` and no artifact mtime, and takes no
  session lock: `deriveSessionReasons`/`evaluateAttention` is the one place the "does this want
  me" rule lives, and a second reader would be both a second copy of that rule and a second
  thing that could block a stage run. The grouping function itself is pure — no clock, no I/O.
- **Membership is the core's answer; ordering and badges are the client's** (D2). The engine
  decides which list a row is in, whether somebody is already on a PR, and which parking-lot
  group it belongs to; the panel re-sorts with the user's selection and renders. A client that
  re-derived membership would be a second answer to the same question.
- **The ack key stays the `ItemRef`, and the fan-out is server-side** (R3, R31). An ack keyed to
  the *view* would silently un-ack the moment the view changed shape, so an item is acked only
  when every contributing ref is, and `POST /items/<path>/ack` walks them itself rather than
  making each client re-derive which refs an item owns.
- **An item is addressed by a PATH, never by its own id** (R14, R65). Once a PR names a ticket
  the item's id becomes the ticket's, so an id lookup would 404 on exactly the merged rows this
  phase exists to create. `pr/:o/:r/:n` resolves to the item *containing* that PR — and answers
  with `id: "ticket:HB-627"`, which is not a contradiction but the point.
- **`POST /items/<path>/agents` composes the existing creation paths** (R15) under the **same**
  `pr:<slug>#<n>` lock key the review routes take, so it cannot race `POST /prs/…/review` or
  `POST /reviews`. There is no second creation path to keep in step.
- **The engine fetches the ticket text; the agent never sees a credential** (R18), and the
  `## Ticket` brief block is composed in exactly one place.
- **No HTML crosses the port, the API or `postMessage`** (R33). `renderedFields` is flattened in
  `src/jira/html-to-text.ts`; MG-10 greps for any identifier ending in `Html` on the boundary.
  The **core renders no HTML at all**, which is why the markdown renderer could not live there
  however convenient that would have been.
- **The Jira leg reports, never throws** (R34, R35). It runs after the PR half publishes, is not
  awaited, is single-flight, is bounded by one budget for the whole leg, and degrades to
  `unavailable`/`auth` while keeping the last tickets that were scanned. `notConfigured` says
  **nothing** in the UI — a permanent red banner for somebody mid-setup is the failure R35 names.
- **No Jira writes, ever.** `JiraSource` has three read methods and no fourth; the adapter issues
  only `GET`. This is a posture, not an omission: there is no "post a comment to Jira" task
  deferred to a later phase.
- **Ticket linking is off unless `jira.projectKeys` is set** (R46), logged once per process. The
  bare key regex links `SHA-256`, `UTF-8` and `PR-123`, and a wrong merge puts two unrelated PRs
  on one row — so the failure mode is "no linking" rather than "confident wrong linking".
- **`jira.apiToken` is treated exactly like `vercel.bypassSecret`** (R44): `hasAnySecret`, the
  0600 load refusal, `redactCoreConfig`, and never in a brief, a log line, an event frame, an
  HTTP response or `jira.json`.
- **The markdown-preview path is gone** (R23). The panel opened work in VS Code's built-in
  markdown preview, which could show one file with no PR context, no ticket and no agent
  switcher; the Item tab replaces it outright, and `cgremlin.refreshPreview` goes with it.
- **R40 narrows Phase 7 R13 ("the extension has zero dependencies")** to zero **runtime**
  dependencies. `esbuild` and `markdown-it` are devDependencies, bundled into `media/*.js` at
  build time, and the `.vsix` still carries no `node_modules/`. The alternative — a hand-written
  markdown renderer — is a security surface nobody would maintain. The accepted cost of
  `html: false` is that the review contract's `<a id="fN"></a>` anchors render as **text**, so
  the in-page footnote *targets* are synthesised by matching markdown-it's escaped output; the
  `[N](#fN)` references need nothing.
- **A window reload closes the Item tab, by design** (R39). A `WebviewPanel` is not serialised,
  and restoring one would mean re-fetching an item that may no longer exist. The `ready`
  handshake is what makes the first open reliable instead: the host renders only once the script
  says it is listening, because a render posted before that is dropped silently and the panel
  stays blank.
- **Claims belong to the chat terminal alone** (R42). Opening an item, switching agents and
  focusing a PR are *browsing*; none of them claim or release. MG-B9 asserts zero claim calls on
  a tab switch.

### The re-scope (R47–R55)

- **Four lists, not five** (R47). Parking lot / my dev work / investigations / PRs waiting for
  review. **Drafts are in no list at all** — a draft is not asking for anything — and that
  includes **my own** draft PR, which appears only once it carries an agent of mine or its
  ticket is assigned to me.
- **"Someone is on it" is an exclusion signal, not a badge** (R47). Any human review or comment
  demotes a PR into a collapsed group, **and so does a pending review request to somebody else**
  (R47.1, decided): GitHub has already assigned that PR to a named person, and picking it up is
  duplicated work. What the eye should land on is the *untouched* count.
  **Phase 10 errata: R47.1 is REVERSED** (gh#2125 false positive) — a pending review request, to a
  user or a team slug, no longer demotes; only actual `humanActivity` does, and `reviewRequests`
  keeps driving R30 and display only.
- **The coordinator override replaced the `reviewing` list** (R47/R48). A teammate's PR that our
  review agent is on stays in the **parking lot**, in a `'reviewing'` group pinned on top, and
  **never enters `myWork`** — a teammate's PR is a teammate's PR, whatever we have running on it.
  This is what let the fourth list go without dropping its members on the floor.
- **A ticket-linked investigation is `myWork`, not `investigations`** (R49). `investigations` is
  literally "the sessions I only have an investigation for": no PR, no ticket, investigation
  agents only. A ticket is a commitment to deliver.
- **A fourth session mode, `respond`** (R51) — see R56 below for the click, and the entries at
  the end of this section for what the merge found. Its worktree is the PR's **own head branch**,
  because the point of the mode is to commit a fix onto that branch.
- **The engine's first GraphQL call, and its cost decision** (R52). Review threads are the one
  signal `gh pr list` cannot see, and they go through the existing `GhRunner` (`gh api graphql`),
  so there is no new port and no new fake. "Threads for all 58 PRs every tick" was the risk, so
  the fetch policy is narrow (my open non-draft PRs, plus a parking-lot candidate whose
  `humanActivity` is empty from reviews and comments alone) and the cache is keyed on the PR's
  `updatedAt` — a steady-state tick makes **zero** calls.
- **The side panel is a webview, and the `TreeView` is deleted** (R54). A tree cannot render
  two-line card rows, badges, a collapsible group or an inline sort control. The consequence,
  accepted: under `font-src 'none'` there are no codicons, so every glyph is a **unicode
  character**. The risk this buys — a webview that fails to load renders blank rather than
  throwing — is covered by the `ready` handshake, a manifest assertion that the view is
  `"type": "webview"`, and MG-B10's proof that the bundle actually shipped.
- **Nothing posts to GitHub in v1** (R55). The legacy tool's `--reply-comment`,
  `--resolve-comment` and `--push-fix` are deliberately **not** ported. v1 ends at "the fix is
  committed locally"; the drafted replies live in `COMMENTS.md` for a human to paste.

### The re-check (R56–R67)

- **R57: `isDraft !== true`, not `=== false`.** Every pre-Phase-9 row and every agent-only row
  has an *unknown* draft state, and `=== false` would unlist all of them. Paired with the
  live-agent totality invariant: a **merged** teammate PR that still carries our review agent is
  still listed, and a merged own PR with a respond agent is still in `myWork` — the agent, not
  the inventory row, keeps the item alive.
- **R58: attention timestamps are pinned to something only a human moves.** `approved` and
  `changes_requested` take `reviewDecisionAt` (the newest review whose state matches the current
  decision) and `humanActivity.lastAt`, never `updatedAt` — otherwise a push to an approved,
  acked PR re-fires the notification.
- **R61: the pr↔ticket merge is one-sided.** A PR and a ticket become one row only when the
  **resulting item would be mine**. Two teammates' PRs naming one ticket key stay two items:
  merging them hides one behind the other and makes "how many files changed" meaningless, and in
  the parking lot the user is choosing between PRs to *read*.
- **R62: the webview script and stylesheet are injected TEXT.** `extension.ts` reads them from
  disk at activation and hands them to the UI modules, so no unit test depends on the bundler
  having run — a red test means bad HTML, never a missing bundle.
- **R66: the panel is an ARIA tree.** One tab stop, `role="treeitem"` rows with `aria-level` and
  `aria-expanded`, and the arrow keys moving within it — a list of nested clickable `div`s is
  not navigable otherwise.

### Deviations the two streams found, and what was done about them

- **`groupWorkItems` returns `items` ordered by `id`; per-list order lives in `lists`.** One
  array cannot carry four different orders at once, so `items` is a *set* keyed by id and the
  four id arrays carry presentation order. Every comparator is total, deterministic and stable,
  with ties broken on `id`, so the CLI and any future client agree. C1 pins the committed
  extension fixture to that order against the live engine.
- **Comment pagination is addressed by node id.** A review thread with more than one page of
  comments is followed with `node(id:) { ... on PullRequestReviewThread { comments(after:) } }`
  rather than re-walking `reviewThreads`, capped at five pages; past the cap the thread is marked
  `truncated` rather than coming back silently short. The legacy query's `comments(first:1)` is
  exactly why the old brief had to reconcile replies by hand.
- **`ApiServerDeps.now`** exists so the claim check on the respond parity path
  (`isClaimed(existing, deps.now())`) is testable without a fake clock inside the route.
- **`chatTargetOf` is one rule, used by the button and by the click.** A respond agent is
  chat-eligible only from `addressing` onwards — chatting into a session whose `BRIEF.md` is
  still being written is the failure R50's ordering prevents — and among several eligible agents
  a running one wins, then a claimed one, then the core's own order. Both the action's presence
  and its target come from that one function, so they cannot disagree.
- **A `/items` that 404s is engine trouble, said out loud.** An engine older than the extension
  cannot answer the route; the panel replaces the lists with one row that says "restart the
  engine" and the status bar warns, rather than rendering four empty lists. Silence was Phase 8's
  lesson.
- **`artifactText` returns the bytes the engine sent.** An artifact that happens to parse as JSON
  is still a document, so the client does not parse it.

### Three defects the convergence found

- **`RespondSessionFactory` could never create a worktree.** It branched with `-b <headRefName>`,
  and the bare mirror already carries `refs/heads/<that branch>` from `clone --bare` — so every
  respond session failed with *"a branch named X already exists"*. `createWorktree` gained an
  opt-in `resetBranch` (`-B`), used only by respond, which is also the only way the worktree gets
  the **fetched** head: `fetch --prune` updates `refs/remotes/origin/*`, never the mirror's own
  `refs/heads/*`.
- **`ticketTrouble` was dead code.** R35 asks for a row **and** a status-bar state on
  `ticketSource.kind === 'auth'`; the helper existed and was unit-tested but nothing called it.
  It is kept deliberately apart from the `/items` trouble: an engine that cannot list the work
  replaces the lists, whereas a rejected Jira token leaves every PR row where it is.
- **`COMMENTS.md` was not a readable artifact.** The respond mode's only output 400'd on
  `GET /sessions/:id/artifacts/COMMENTS.md`, so the Item tab could never show it. Added to the
  allow-list, with a matching `pickPrimaryArtifact` branch so a respond row opens on its verdicts
  and falls back to the brief while the agent is still triaging.

## 2026-09-11 — Phase 10 (the panel workshop, and the restart storm)

Rulings live in `docs/superpowers/specs/2026-09-11-cgremlin-phase10-panel-workshop.md`. Recorded
here as the phase lands. Two of them reverse or amend something written above, and both say so.

### R47.1 reversed — a review request never counts as someone being on it

Phase 9 made `demoted` true for *"any human review or comment, **or** a pending review request to
somebody other than me"*, on the reasoning that GitHub had already assigned the PR to a named
person. **That half is removed.** `someoneIsOnIt` is now `humanActivity.lastAt !== null` and
nothing else.

The evidence is `gh#2125`: a PR sat in the collapsed *someone is on it* group for days with a
review requested from a teammate who had not opened it once. A request is GitHub's *intention*;
`humanActivity` is what actually happened, and only what actually happened should hide a row from
the person deciding what to pick up. The request itself is not thrown away — it is still carried
on the `WorkItemPr` and still rendered on the row (`👤 @dana requested`), because it is useful
information about who *ought* to look. What changed is that it no longer suppresses the row.

This is deliberately asymmetric with a bot's review, which never demoted a row and still does not
(R6's bot predicate): both are cases where something happened to the PR and nobody read it.

### The size tier — per dimension, worse wins

`WorkItemPr.sizeTier` is `S | M | L | XL | null`, computed in the core rather than in each client,
because the CLI and the panel disagreeing about how big a change is would be worse than either
answer. The thresholds are read **per dimension** — files ≤ 3 / 10 / 25, lines ≤ 50 / 300 / 1000 —
and the worse of the two wins. A single "whichever number is larger" rule was tried first and is
wrong in both directions: it makes a one-file 1800-line generated diff an `S`, and a thirty-file
40-line rename sweep an `S` as well. Either dimension alone is allowed to push a PR up a tier.

`null` when any input is null. A tier is a judgement about a number the scan does not have, and
MG-12's rule holds: unknown renders `—`, never a fabricated `S`.

### Forward only — the lifecycle offers one stage, the one after the furthest reached

The lifecycle is investigation → development → review, and a row offers **only the stage after the
furthest one it has reached**. A PR *is* the development stage's output, whether or not this tool
ever saw the agent that opened it, so an item with a PR is already past development.

This replaces a rule that offered *Start investigation* and *Start development* on every row of
every list. On a parking-lot row — a teammate's PR — both verbs could only ever produce a
nonsensical session on somebody else's branch, and a button whose only outcome is a 409 is what
made the old panel untrustworthy. The rule lives in exactly one module (`model/row-actions`), and
the expanded row's lifecycle slots take their Start button **from the row's own actions** rather
than deriving it a second time: a slot that offered a verb the row refuses would be the same
defect wearing a different hat.

### Click = select + expand + swap, as one decision

One click on a row does three things: the row becomes the selected one, it expands in place
(accordion — at most one row open), and the workspace swaps to that item's current worktree. They
are **one message** on the wire, because they are one user act; three messages would let the panel
end up highlighted on one row and swapped to another if any were dropped. The repaint happens
before the swap is asked for, so the highlight and the expansion are on screen before a
dirty-editor modal can appear in front of them.

Which session the row *is* — the worktree a click opens and the session "changes so far" counts —
is decided once: a session with no worktree is not a candidate, among the rest a running agent
wins because it is the one writing files, and otherwise the furthest stage wins, `respond`
included (answering a review is the most recent thing to have happened on a PR).

### `GET /sessions/:id/changes` — the merge base, and a boolean

"Changes so far" is a route rather than a field because it is the number that moves *while an
agent works*, and a field on a listing would be stale by the time it was rendered. The committed
half diffs from `git merge-base <base> HEAD`, not from `base`: a base that has moved since the
branch was cut would otherwise report the whole of `main` as this session's work. `base` comes
from the PR's own `baseRef` in the current inventory when there is a PR, and from
`config.defaultBaseRef` otherwise — never from a persisted field on the session, because there
isn't one and inventing one would make it wrong the moment the PR was retargeted.

`baseResolved` is a **boolean**, not a sha: it says whether `merge-base` resolved at all. A base
ref that was never fetched into that worktree is a normal state, not an error, so the route falls
back to a three-dot diff and says it did rather than failing. (The extension had parsed this field
as a string and therefore always read it as null; found by the Phase 10 integration pass.)

The route is deliberately **not** under the session lock. It is a pure read of the worktree, and
making a sidebar refresh able to queue behind a running stage would be a new way to make the panel
feel broken.

### `selfReview` — the one way past `OwnPrError`

Reviewing your own PR is a legitimate thing to want and the engine refused it flatly. It now
refuses it *by default*: only `POST /items/<path>/agents` with `{mode: 'review', selfReview: true}`
bypasses `OwnPrError`, and that request is only ever produced by the row's own *Start self-review*
button, whose wording says what it is. `POST /reviews` and `POST /prs/…/review` still refuse.

The flag is recorded on the **review session's** `lineage.selfReview` and never inherited from the
source session it links to — it is a fact about this review, not about the ticket — and the review
prompt states it, because an agent that does not know it is reading its own work writes a review
addressed to somebody else.

### The default bot list

`config.botLogins` is now optional and **adds to** a default list shipped in the engine
(`github-actions`, `dependabot`, `renovate`, `codecov`, `vercel`, `sonarcloud`, `copilot`,
`coderabbitai`, `snyk-bot`, …). Every user was maintaining the same list by hand, and the cost of
forgetting one is a PR wrongly demoted out of sight. It widens, never replaces, so a user's own
entry is still honoured and a default can never be *removed* by configuring the field.

### The build id, the content-addressed watcher, and the once-per-identity restart

Three rulings, one failure. The flap: two windows restarting one engine forever, phase-locked into
paired SIGTERMs and spawn races, with the loser's *"Another process is already listening"* in the
log.

- **The adoption handshake compares a build id as well as a version.** `ENGINE_VERSION` is the
  package's and it stayed `0.0.1` across two phases of engine changes, so a Phase 8 engine looked
  identical to a Phase 9 extension, which adopted it and then found no `/items` on it for as long
  as it kept running. `buildId` is a content address of the bundle; adoption requires both to
  agree, and the mismatch message is built from the **build ids** when the version words are the
  same, because "0.0.1 and 0.0.1 disagree" tells the user nothing.
- **The config watcher is content-addressed.** It restarts on a change of *bytes*, not on a
  filesystem event. The surface used to re-assert the file's mode after every event, and on macOS a
  `chmod` of a watched file is itself an event for it — so each window fed itself at the period of
  one engine restart.
- **An automatic restart is spent once per engine identity** (`pid@startedAt`). A second automatic
  trigger against the same running engine is not a new decision, it is the same one arriving again,
  and it is refused with a logged reason. Only a stop that actually proved ownership **and**
  succeeded spends the identity, so a failed stop leaves the next legitimate trigger free to try.
  A person is never refused and never latched: what they asked for is the point.

Two windows still cost two restarts for a genuine save, one each — neither window can know the
other has already acted. Making that one would take a cross-window handshake (the engine recording
which config digest it booted with); that is deliberately not this change.

### Eight seconds of hysteresis before "offline"

The event stream drops on every engine restart and every hiccup, and the consumer reconnects on a
1/2/5/10 s backoff — so a banner raised on the first drop flaps for a reason the user cannot act
on. The drop is reported, and only a window that stays down for **8 s** (past the third reconnect)
is said out loud. Anything that gets through — a request, a frame — clears it, pending or already
said. Throughout, the **last snapshot stays on screen**: four empty lists claim something the
extension does not know.

### Phase 15 — QA verification: a rung outside the ladder (R70, R72, R74 amended, R75, R77 amended, R82)

- **R70: QA sits after the forward-only ladder, not on it.** `STAGE_ORDER`/`nextStages` are
  untouched — they already return `[]` on a landed item — and the QA verbs are their own rule,
  allowed only when every PR on the item is `merged` (a change that was thrown away, closed
  without merging, is not a change to verify). Grafting a fourth rung onto the existing ladder
  would reopen `furthestStage` for every row already on it, for a mode that only ever runs after
  the ladder is done.
- **R72: `byNeedsYouThenRecent` compares `needsYou` before `byLanded`, and only there.** A
  not-ready verdict on a merged item belongs at the top of my work; the other two list orders keep
  `byLanded` first, because a landed-but-fine item is still background noise everywhere else. This
  also lifts `run_failed`/`comments_ready` landed rows in `myWork`, which is the same reasoning
  applied consistently rather than a special case for QA.
- **R74, amended: one new secret, under the existing regime.** The ruling calls for QA auth kinds
  `clerk-test` | `credentials` | `vercel-bypass` | `none`: `vercel-bypass` reuses
  `vercel.bypassSecret` verbatim, and `credentials` adds exactly one new secret,
  `qa.account.password`, under the *same* regime as everything else that already handles a
  secret — 0600 `core.json`, `hasAnySecret`, `redactCoreConfig`, a 0600
  `<sessionDir>/.qa-account` written before the run and removed in teardown, and the widened
  redactor (R85) everywhere. **As of this task, only `clerk-test | vercel-bypass | none` are wired**
  (`QaEnvironmentSchema` in `core-config.ts`, `QaAuthMode` in `prompts.ts`) — `credentials` and its
  secret are not yet implemented; a repo with no Clerk test user and no Vercel bypass secret has no
  auto-runnable auth kind today. Flagged for whichever task lands `credentials`.
- **R75: the protocol lives in the brief, not in a cgremlin-repo file.** `qaSkillCommand`
  (default `/cgremlin:qa-verify`) is an enhancement that degrades silently, exactly like
  `reviewSkillCommand`/`renderUiCheckProtocol`. The agent runs in the *target* repo's worktree,
  where a file that ships with cgremlin's own repo does not exist — so the skill's source ships at
  `skills/qa-verify/SKILL.md` here, to be installed by the user into their own Claude Code skills
  directory, and the brief carries the same protocol inlined so a missing install never leaves the
  agent with nothing to do.
- **R77, amended: a cold record seeds, it does not fire.** The original ruling would have had a
  freshly-installed leg fire one verification per tick against an entire pre-existing QA backlog
  forever — at a 60 s poll interval that is dozens of unasked-for agents in an hour, against the
  standing no-burn rule. A record with no prior known status now seeds `lastStatus`/`ordinal:0`
  and starts nothing; the backlog is surfaced instead with the manual `Verify in QA` action lit,
  one human click each. `qa.backfillOnFirstRun` (default `false`) is the deliberate, explicit
  opt-in for someone who wants the fleet anyway, still capped by `maxAutoStartsPerTick`.
- **R82: one list, three places, checked by a guard test.** The permitted/forbidden list for a QA
  agent is carried verbatim by the spec, `renderQaBrief`'s `QA_CONDUCT_RULE`, and
  `skills/qa-verify/SKILL.md` — a guard test (`test/skills/qa-verify-skill.test.ts`) asserts the
  skill's copy is byte-identical to the exported constant, so the three cannot drift apart
  silently. The spec, the brief and the skill also all say the same true thing about enforcement:
  the runner launches with `--permission-mode bypassPermissions`, and the `qa` deny list matches
  Bash argv only — it stops `gh pr create`, it does not stop a `curl -X POST` or an MCP tool that
  writes. The enforceable boundary is the test identity's own permissions, and pretending
  otherwise would be worse than naming it.

## 2026-10-05 — R110 (a review of someone else's PR posts only when the user asks)

- **Review findings on another person's PR post only on the user's explicit request, in the
  conversation.** Commit `1fd7bec` (2026-09-18) removed "Do NOT post to GitHub" from the review
  prompt and told the headless run to post, so manual reviews — and the automatic re-review on
  new commits, which nobody watches — posted findings the user had never read. A headless
  `review`/`rereview` now writes `REVIEW.md` (and `rereview_summary`) and stops; the brief keeps
  its `## Posting` section (own PR only, never approve, never land) for the chat agent, gated on
  the user asking there.
- **Enforced, not just worded.** A headless review resolves to the `review` permission profile,
  which denies `.cgremlin/post-review` and `.cgremlin/post-comment` (bare and `./`-prefixed), and
  the guardrail refresh *removes* the helpers from its worktree. Claiming the conversation
  re-renders the worktree as `review:conversation` — helpers written, those denies lifted — before
  the editor opens `claude --resume`; release, and every stage run regardless, restore the
  headless state, so an expired or unreleased claim cannot leak into a headless run.
- **`respond` is unchanged** — it replies on the user's own PR, headless, as Phase 20 decided. QA
  is unchanged.

## 2026-10-06 — Step 1 (development guard; stage-aware profiles, R92/R112)

- **`development` is hardened.** It used to deny only posting plus `gh pr merge`/`close`; a dev
  session could run `gh pr ready`, `gh pr edit`, `gh api` and force-push. It now denies
  `gh pr ready/edit/merge/close`, `gh api:*` and every force-push spelling (`--force`, `-f`,
  `+refspec`, and `--force-with-lease` until a later step needs it). Commit, push of its own
  branch and `gh pr create --draft` stay (the engine re-checks `isDraft`). The rest of the `gh`
  surface is unchanged on purpose.
- **Authority now depends on the stage too.** `PermissionSubject` gains `stage`;
  `development:inspect` and `investigation:development:inspect` are the two dev-landing profiles
  plus `git commit`/`git push` denies, selected for `review`, `rereview`, `phase_review` and
  `live_check`, so a stage that only looks at a dev worktree cannot change its branch. The stage
  runner passes it on its pre-run guard refresh; respond, QA, review and `review:conversation`
  resolve exactly as before.
- **Still a guardrail.** Same limits as the guard header: quoting and `git -C` defeat matching,
  MCP is not covered; non-draft `gh pr create` is still allowed to development (the engine checks
  `isDraft`, the brief says draft only).
