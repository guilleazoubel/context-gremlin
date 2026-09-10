# Architecture

## Layers

```
Frontends (thin clients)
  - CLI (cgremlin-core: serve, prs, review, sessions, scan, config, local)
  - (future) plugin-style UI
        │  HTTP-over-Unix-socket API (JSON)
        ▼
Engine (one process, built by src/host/build-engine.ts, run by src/host/serve.ts)
  - SessionStore, WorkspaceManager, PipelineService, StageRunner
  - InventoryScanner + DiscoveryScheduler + ReconciliationTick
  - EnvironmentService (local dev app + Vercel preview)
  - EngineEvents, KeyedLock
        │  AgentRunner interface
        ▼
Agent-runner adapters
  - ClaudeCodeRunner  (spawns `claude`)
  - CodexRunner       (spawns `codex`)
```

The engine never spawns a terminal and never knows about HTML. Frontends never touch
`session.json` or git directly — everything goes through the API. `src/index.ts` exports
only a version string; the real composition root is `src/host/build-engine.ts`
(pure wiring) plus `src/host/serve.ts` (the side-effecting half: mkdir, listen, signals).

## Session model

`mode: 'investigation' | 'review' | 'development'` is the sole source of truth for a
session's kind (`src/schema/session-mode.ts`). Each mode has its own phase enum and
transition table (`src/schema/pipeline.ts`):

**investigation** — `findings → planning → plan_ready → approved →
promoted_to_development`, any non-terminal phase → `abandoned`. `plan_ready` and
`approved` both have a direct edge to `promoted_to_development` (drive-to-completion
skips the human `approved` step without ever claiming it happened).

**development** — `active → pr_opened → superseded (by a review session) → merged`,
`active → merged` directly (PR-3a records no `pr_opened` yet), any non-terminal phase →
`abandoned`.

**review** — `queued → reviewing → ready → approved | changes_requested | dismissed`,
plus `failed` (review phases are *activity* states, so a bad run is a real phase, unlike
investigation/development where a failed run just leaves `stageStatus` unchanged and is
recorded in `lastRun`). GitHub facts apply from *any* non-terminal phase regardless of
where the local pipeline sits: `dismissed` is reachable from every non-terminal phase,
`approved` from every non-terminal phase except `reviewing` (a GitHub approval that arrives
mid-run is applied on the next tick once the run settles), and `ready → reviewing` lets a
PR updated before a human acts get re-reviewed.

`canTransition`/`transitionPhase` (`src/schema/pipeline.ts`) are the only place these
tables are checked; `IllegalTransitionError` maps to HTTP 409.

### Schema v2 fields (`src/schema/session.ts`)

Every session (v2) carries, beyond the v1 base (`id`, `createdAt`, `workspace`, `lineage`,
`mode`, `stageStatus`):

```ts
agent: { runner: 'claude-code' | 'codex'; resumeId: string | null } | null
lastRun: { stage, startedAt, finishedAt, exitCode, signal,
           outcome: 'running'|'succeeded'|'failed'|'stopped', error } | null
pr: { repo, number, url, headSha, reviewedSha, title, author } | null
```

Mode-specific: investigation adds `intent: 'investigate_only' | 'development'` and
`driveToCompletion: boolean`; review adds `reviewVersion: number` and
`lastRereviewSummary: { resolved, total, newFindings } | null`. `parseSession` accepts a
v1 document and runs it through `migrateV1ToV2` (agent/lastRun/pr → null,
reviewVersion → 0) before validating against the v2 schema; `SessionStore.list()` skips
(does not throw on) any directory whose `session.json` fails validation entirely — a
document with no `schemaVersion` at all (legacy shape) falls into that bucket.

## Pipeline

`StageRunner.run()` (`src/pipeline/stage-runner.ts`) is the one-turn-per-call primitive:
write `BRIEF.md` + `AGENT_STATE=working`, record `lastRun = running`, emit `run.started`,
call `runner.start()`/`sendPrompt()`, wait for exit, record the outcome (`succeeded` on a
clean exit, `failed` otherwise, `stopped` if `stop()` was called), persist
`agent.resumeId`, emit `run.finished`. It never inspects artifacts or decides a
transition — that is `PipelineService`'s job, layered on top per stage:

| Stage | Method | On success, evaluates | Transition |
|---|---|---|---|
| findings | `runFindings` | `FINDINGS.md` non-empty | none (chains into `runPlan` if `intent === 'development'`) |
| plan | `runPlan` | `## Review Status` block: both `PM:` and `Principal Engineer:` lines `✅` | `→ plan_ready`; `unresolved` (an `## Unresolved Review Disagreement` block) leaves phase unchanged with `lastRun.error` set; `missing` → `lastRun.outcome = 'failed'` |
| develop | `runDevelop` | — | none yet (PR detection is reconciliation, not this stage) |
| review | `runReview` | clean exit + non-empty `REVIEW.md` | `→ ready` or `→ failed` |
| rereview | `runRereview` | same as review | `→ ready` or `→ failed`; on `ready`, `pr.reviewedSha`/`headSha` advance and `lastRereviewSummary` is parsed from `rereview_summary` |

Artifact evaluation is pure and file-based (`src/pipeline/artifacts.ts`): `evaluateFindings`,
`evaluatePlan` (→ `parsePlanReviewStatus`), `evaluateReview`, `evaluateRereview`,
`nextReviewVersion`. **Artifact-driven completion, not agent callbacks** is the founding
rule here: the legacy tool had the agent call back into `cgremlin --plan-ready` etc.;
this engine instead runs one headless turn, waits for exit, and reads what the agent left
on disk — the agent only ever writes plain files (`AGENT_NOTE`, `AGENT_STATE`, the
`.md` deliverables), never calls back into the engine.

### Brief/prompt contract

Every stage's brief is `<sessionDir>/BRIEF.md`, rendered by a pure function in
`src/pipeline/prompts.ts` and reached via `--add-dir <sessionDir>`; the prompt is a short
one-line pointer at it (`STAGE_ENTRY_PROMPT`, or a stage-specific variant for
review/rereview). Findings/develop/review/rereview briefs each render a `##
Environment` section (empty string when nothing resolved) and, when a local or preview
URL exists, a `## LIVE UI CHECK` protocol (PM + Designer subagents, `fix` mode for
findings/develop, `observe` mode for review/rereview). `renderReviewPrompt`'s reference
to running the LIVE UI CHECK section is included only when that section actually
rendered into the brief — there is no separate config flag gating it.

**The REVIEW.md format contract** (`renderReviewContract()`) is fixed and verbatim: a
title line, `**Does it do what the ticket asked?**`, `**How deep did I look?**`, `##
Summary`, a `## What I found` table (severity legend 🔴 Critical / 🟠 High / 🟡 Perf /
🔧 Maintainability / 📋 PM/AC / 🎨 Design), `## Details` with stable `<a id="fN">` anchors
matching the table's `[N](#fN)` links, a **Link:** permalink built from the checked-out
commit's full 40-char SHA, `## Verdict`, and `## Review History`. `evaluateReview`,
`evaluateRereview`, and every re-review prompt depend on this exact shape (resolved
findings are re-classified ✅/⚠️/❌/🔁 by status; `Status` appears in both the table row
and the detail heading and must match).

### The plan gate

`canPromote(session)` (`src/pipeline/plan-gate.ts`) is the single rule: `stageStatus ===
'approved'`, or `driveToCompletion && stageStatus === 'plan_ready'`. `promote()` calls
`assertCanPromote` (throws `PlanGateError` → 409) before doing anything else. There is no
`--force` equivalent; a human can still call `POST /sessions/:id/transition` directly.

### Promotion

`promote(id)` transitions the investigation to `promoted_to_development`, then creates a
**new** development session sharing the same `pipelineId`/`ticket`/`workspace` (same
worktree, same branch) as the investigation — the schema makes `promoted_to_development`
terminal rather than flipping `mode` in place, so both records exist and can be inspected
independently. `FINDINGS.md`/`PLAN.md` are copied into the new session's directory, and
`runDevelop` is started immediately. `DELETE /workspaces` refuses (409) while any other
non-terminal session still references the same `worktreePath` (`assertWorktreeNotInUse`,
`src/workspace/workspace-in-use.ts`).

## Concurrency model

One `KeyedLock` (`src/api/keyed-lock.ts`) is shared by the API server, `PipelineService`,
`StageRunner`, and `ReconciliationTick` — a simple promise-chain-per-key mutex, not
re-entrant.

**Locking invariant** (documented atop `pipeline-service.ts`): before `run.started`
fires, the caller (an API route handler, or `PipelineService`'s own `runStageLocked`)
holds the per-session lock; `StageRunner` releases it the instant `run.started` emits.
After that point, **every** subsequent write to that session — `StageRunner`'s post-exit
`lastRun`/`agent` patch, `PipelineService`'s evaluate→transition→`pr`/`reviewVersion`
patches, a chained stage's own pre-run check — re-acquires the lock itself before
read-then-save. Environment preparation (below) deliberately runs **before** the lock is
taken at all, so it must write no session state whatsoever.

`local-app:<port>` is a second, disjoint lock-key namespace on the **same** `KeyedLock`
(`assertSafeSessionId` forbids `:` in a session id, so the namespaces can never collide).
Every read-modify-write of `local-app.json` — `start`, `stop`, `reconcileOrphans` — runs
inside it, which is what actually makes "one local app, single owner" true: without it,
two sessions starting concurrently would both see an empty state file and both spawn.

**Never nested**: nothing that holds a session's `KeyedLock` key ever tries to acquire
`local-app:<port>` for the same call, and nothing holding `local-app:<port>` tries to
acquire a session lock — `prepareEnvironment` (which takes `local-app:<port>` via
`EnvironmentService.start`) runs entirely outside any session lock.

## Inventory + reconciliation

`InventoryScanner.run()` (`src/inventory/inventory-scanner.ts`), driven by
`DiscoveryScheduler` on `pollIntervalMs` (never-overlapping ticks; a tick already running
skips the next timer beat and counts it in `skippedBeats`):

1. Runs `ReconciliationTick.run()` first.
2. Lists open PRs per configured repo (`gh pr list … --json …`), builds `InventoryEntry`
   rows joined against current sessions (`ours` status), groups them
   (`unreviewed`/`teamOnIt`/`ours`/`mine`).
3. Persists `inventory.json` atomically (tmp + rename); emits `inventory.updated`.
4. A per-repo `gh` failure falls back to that repo's entries from the last completed
   scan rather than dropping the repo's PRs for one bad tick.

**What the tick does**: for every review session that is non-terminal and already has a
`pr`, it re-fetches that PR's live view and proposes/applies exactly one of: PR merged →
review `dismissed` + source `merged`; PR closed → review `dismissed` + source
`abandoned`; `reviewDecision === 'APPROVED'` → review `approved`; head sha changed and
phase is re-reviewable → `runRereview`. Each planned action is re-validated against a
fresh load of the session before it is applied (an API call may have already moved it).

**What it never does**: create a session, or start the *first* review for a PR nobody
has a session for yet. Discovering a brand-new PR only populates the inventory; a human
(or a client) explicitly calls `review <url>` / `POST /prs/.../review` to start one. This
reverses an earlier design where the tick auto-started reviews for every discovered
candidate — see `docs/DECISIONS.md`.

## Environment tooling

`EnvironmentService` (`src/env/environment-service.ts`) owns the one local dev app the
engine may run, and the Vercel preview URL lookup, per session.

- **Prepare-before-lock**: `PipelineService.prepareEnvironment(id, stage, session)` runs
  entirely *before* `runStageLocked` — it does `gh pr view`, `vercel link`/`env pull`,
  spawns the dev process, waits out its healthcheck (up to `healthTimeoutMs`, default
  90s), writes `.bypass-secret`, and returns the rendered `EnvironmentBriefContext`. It
  takes no session lock and writes no session state, because holding the session lock for
  a 90-second-plus cold start would block `stop` and every other action on that session.
- **Teardown in finally**: every environment-bearing stage (`findings`, `develop`,
  `review`, `rereview`) wraps its body in `try { … } finally { await prep.teardown(); }`,
  **outside** the stage's own `preRunCommitted` try/catch — so teardown (clear the
  bypass-secret file, and stop the app if *this* call started it) always runs, whether the
  stage succeeded, failed, or the locked pre-run check itself threw (a lost eligibility
  race). Teardown is idempotent (guarded by a `tornDown` flag) because a chained stage
  (`findings → plan → promote → develop`) tears down before chaining *in addition to* its
  own outer `finally`.
- **Ownership/pgid rules**: exactly one local app at a time, tracked in
  `local-app.json` by `{sessionId, pid, pgid, url, port, logPath, startedAt}`. A port held
  by anything the engine did not itself record is **never killed** — `start` degrades to
  `unavailable` instead (`LocalAppPortBusyError`, one message when the engine recognizes
  the holder as its own leftover, a different message otherwise). At boot,
  `reconcileOrphans()` reaps *only* a process group this engine itself recorded and can
  still prove is the same one (the group still owns the recorded port, or the record
  postdates this machine's last boot) — a foreign listener, or a record that fails that
  proof, is only cleared from the state file, never signalled. The dev-server wrapper
  forks (the pnpm wrapper case), so the pid/pgid actually recorded is re-derived from
  `portListenerPid` after the healthcheck passes, not the originally-spawned pid.
- **Secret invariants**: the Vercel bypass secret never appears in `BRIEF.md`, in
  `inventory.json`, in the engine's stderr log, or in any HTTP response; it exists on
  disk only as `<sessionDir>/.bypass-secret` (mode 0600) while a stage that resolved a
  protected preview URL is running, deleted in the teardown above. `redactBypassUrls`
  scrubs every other text path that could carry it (verbose `run.output`, every
  `logTail`). See `README.md`'s Secret handling section for the full invariant table.

## Events

`EngineEventMap` (`src/engine/events.ts`), each in-process only:

| Event | Payload |
|---|---|
| `session.created` | `{ session }` |
| `session.transitioned` | `{ session, from, to }` |
| `run.started` | `{ session, stage }` |
| `run.output` | `{ sessionId, stage, chunk }` |
| `run.finished` | `{ session, stage, outcome }` |
| `inventory.updated` | `{ inventory }` |

`serve()` logs one JSON line per event to stderr; `--verbose` also logs `run.output`
(redacted). `awaitRunStart` (`src/pipeline/run-start.ts`) is the primitive every
"detached" API route uses to respond as soon as `run.started` fires rather than waiting
for the whole agent turn.

## API route table

All routes are on the Unix socket at `config.socketPath`, JSON in/out.

| Method | Path | Purpose | Notable status codes |
|---|---|---|---|
| GET | `/sessions` | list all sessions | |
| GET | `/sessions/:id` | load one session | 404 unknown id |
| GET | `/sessions/:id/artifacts/:name` | read an allow-listed file from the session dir | 400 bad name, 404 not found |
| POST | `/sessions` | save a raw session record | |
| POST | `/sessions/investigations` | create an investigation session (+ workspace) | 201 |
| POST | `/sessions/:id/transition` `{to}` | force a phase transition | 409 illegal transition |
| POST | `/sessions/:id/run` `{stage}` | run one stage | 202 (after `run.started`), 409 run in progress / unsupported stage |
| POST | `/sessions/:id/approve-plan` | human approves a ready plan | 409 wrong phase |
| POST | `/sessions/:id/promote` | promote to development, start `develop` | 202 `{investigation, development}`, 409 plan gate |
| POST | `/sessions/:id/rereview` | re-review a review session | 202 |
| POST | `/sessions/:id/stop` | stop the active run, if any | 200 `{stopped: boolean}` |
| POST | `/sessions/:id/retry` | re-run the last stage | 202 |
| POST | `/workspaces` | create a bare workspace (mirror + worktree) | 201 |
| DELETE | `/workspaces` | remove a workspace | 409 still in use |
| GET | `/prs` | `{inventory, groups}` from the last scan | 404 no scan yet |
| POST | `/prs/scan` | run one scan now | 409 scan already running |
| GET | `/prs/status` | scheduler status | |
| GET | `/prs/:owner/:repo/:number` | one inventory entry | 404 |
| POST | `/prs/:owner/:repo/:number/review` | start (or report) a review; `?refresh=1` forces a scan first | 202/200, 404 not in inventory, 409 own PR |
| GET | `/local`, `GET /sessions/:id/local` | local-app status (id-less form: whichever session owns it) | 404 no environment configured |
| POST | `/local/stop`, `POST /sessions/:id/local/stop` | stop the local app | |
| POST | `/sessions/:id/local/start` `?fresh=1` | start the local app for this session | 409 unavailable (busy port/prereq/unhealthy) |

`mapErrorToHttp` (`src/api/http-errors.ts`) is the single place error names become status
codes: `SessionNotFoundError`/`ArtifactNotFoundError`/`NoScanYetError` → 404;
`InvalidSessionIdError`/`ValidationError` → 400; `IllegalTransitionError`,
`PlanGateError`, `RunInProgressError`, `WorkspaceInUseError`, `UnsupportedStageError`,
`WorkspaceMissingError`, `TickInProgressError`, `OwnPrError`, and every
`LocalAppPortBusyError`/`LocalAppPrereqError`/`LocalAppUnhealthyError`/`LocalAppSetupError`
→ 409; `SessionCorruptError` and anything unrecognized → 500.

## CLI command table

| Command | What it does |
|---|---|
| `serve [--config path] [--verbose]` | load config, wire the real engine, listen, run until SIGINT/SIGTERM |
| `prs [--json]` | `GET /prs`, printed as a grouped table or raw JSON |
| `review <pr-url>` | `POST /prs/:owner/:repo/:number/review` |
| `sessions [--json]` | `GET /sessions` |
| `scan [--json]` | `POST /prs/scan` |
| `config import-legacy [--force]` | read `~/.cgremlin/config`, write `~/.cgremlin/core.json` |
| `local start <session-id> [--fresh]` / `local stop\|status [session-id]` [--json] | the `/local*` routes |

Every command but `serve`/`config` calls `runSocketCommand` (`src/cli/command-io.ts`),
which loads config, makes the request, and maps a connection failure (no socket) to the
one friendly "engine is not running" message rather than a stack trace.

## Agent runners

Both implement `AgentRunner` (`src/agent/agent-runner.ts`): `start`, `sendPrompt`,
`onOutput`, `onExit`, `stop`, optional `getResumeId`. Neither the engine nor
`StageRunner` ever spawns a process directly.

**`ClaudeCodeRunner`** spawns `claude` with:
`-p <prompt> --output-format stream-json --verbose --permission-mode <mode>`, then
`--add-dir <dir>` for every `additionalDirs` entry, then `--model <m>` if configured, then
`--resume <sessionId>` if resuming. Output is NDJSON on stdout; `assistant` messages'
text parts become `run.output`, and a `result` event's `session_id` becomes the resume id
for next time.

**`CodexRunner`** spawns `codex exec` with either `--json -s <sandbox>` (fresh) or
`resume <threadId> --json -c sandbox_mode="<sandbox>"` (resuming — `-s`/`--add-dir` are
rejected by `codex exec resume`, so `sandbox_mode` is re-asserted via `-c` instead, and
`--add-dir` is only ever passed on the first turn). `-m <model>`,
`--skip-git-repo-check`, and `--dangerously-bypass-approvals-and-sandbox` are appended
when configured. `thread.started`/`item.completed` (`agent_message`/`error`
items)/`turn.failed` events become `run.output` / the resume id.

**Resume rules**: `StageRunner` seeds `resumeId` from `session.agent.resumeId` unless
`session.agent.runner !== runnerKind` — a conversation id from one runner is meaningless
to the other, so a runner switch always starts a fresh conversation (and records a
`lastRun.error` note on success, rather than silently losing the mismatch).

## Testing strategy

- **Fakes per port**: every external dependency is a narrow interface with a fake used
  everywhere in tests instead of a real subprocess/filesystem/git — `FakeAgentRunner`,
  `FakeGitRunner`, `FakeGhRunner` (rejects any argv containing a write subcommand —
  `review`/`comment`/`merge`/`close`/`edit`/`create`/`--method` — so a test proves the
  engine never mutates GitHub), `FakeLocalAppRunner`, `InMemoryFileSystem`, `FakeClock`
  (`test/support/`). Engine-core tests never spawn a real process or need a real git
  repo.
- **Mutation guards** are named assertions each phase's plan calls out explicitly so a
  regression is provable, not just "seems covered" — e.g. (Phase 5, `src/env/*`):
  `MG-1` secret never appears in a rendered `BRIEF.md`, `MG-2` `.bypass-secret` is not a
  readable artifact, `MG-3` the secret never leaves the process (log lines, HTTP bodies),
  `MG-4` no local app starts for a stage not configured to want one, `MG-5` the local app
  is always stopped (success, failure, or a lost eligibility race), `MG-6` a foreign port
  holder is never killed, `MG-7` no rendered brief references any legacy
  `cgremlin --run-local`/`engine.sock`-style callback, `MG-8` `core.json` with a secret is
  mode 0600, `MG-9` environment preparation happens strictly before the session lock is
  entered, `MG-10` concurrent starts are serialized to one, `MG-11` orphan reaping only
  ever touches the engine's own recorded process group. Earlier phases carry their own
  (e.g. Phase 3: removing the plan-gate check, ignoring exit code in `evaluateReview`, or
  removing the shared-workspace refusal must each fail a test).
- **e2e over real git** (`test/e2e/pipeline.e2e.test.ts`, `test/support/e2e-harness.ts`):
  a small number of tests run the pipeline against a real, disposable local git
  repository (real `git worktree`, real filesystem) with only the agent runner and `gh`
  faked — proving the worktree/mirror machinery works against actual git rather than a
  fake, without needing a real GitHub repo or a live agent CLI.
- Contract tests run the same behavioral test suite against both `ClaudeCodeRunner` and
  `CodexRunner` shapes (recorded/mocked transcripts, not live CLIs); a real-subprocess
  test for `NodeLocalAppRunner` spawns a tiny fixture HTTP server through the exact same
  `bash -lc '… exec …'` wrapper the real dev command uses, to prove the process-group
  properties (`isAlive`, `stop` frees the port) end-to-end. Live smoke tests against real
  `gh`/`claude`/`codex` are manual, run by whoever is landing the phase, never part of CI.

## Extending

**Add a stage**: add the name to `STAGE_NAMES` (`src/schema/stage.ts`); add a
`render<Stage>Brief`/prompt pair in `src/pipeline/prompts.ts`; add a `run<Stage>` method
on `PipelineService` following the existing shape (`prepareEnvironment` →
`runStageLocked` with a locked, freshly-reloaded eligibility check → evaluate artifacts →
transition) and wire it into `runStage`'s switch. Keep the locking invariant: pre-run
mutation happens only inside the locked `preRun` callback, and every write after
`run.started` re-acquires the lock.

**Add a route**: add a branch in `handleRequest` (`src/api/server.ts`), following the
existing pattern of parsing `parts`/`method` first; if it mutates a session, either wrap
it in `lock.withLock(id, …)` yourself (a pure read like artifacts) or call a
`PipelineService` method that already locks internally — never both (KeyedLock is not
re-entrant, and nesting deadlocks). Map any new error class in `mapErrorToHttp`.

**Add a runner**: implement `AgentRunner` (`src/agent/agent-runner.ts`); wire it into
`realAdapters()` (`src/host/serve.ts`) behind `config.runner`; add it to
`CoreConfigSchema.runner`'s enum. `StageRunner`'s resume-mismatch guard (compare
`session.agent.runner` to `runnerKind`) needs no change — it's generic.

**Add a config field**: add it to the appropriate zod schema in
`src/config/core-config.ts`; if it's a derived path, add it to `DERIVED_PATH_SUFFIXES`
and `resolveCoreConfig`'s `expandOrDerive` calls so it participates in `stateDir`
derivation and is omitted from a persisted file when it's just the default. Never make a
new field required — every existing `core.json` on disk must keep loading.

**Invariants any change must keep**: the locking invariant above; environment preparation
never takes a session lock and never writes session state; a foreign process (on a port,
or holding a local-app record this engine can't prove is its own) is never signalled;
the Vercel bypass secret is representable only as a file path in a brief's params, never
as a string value; the reconciliation tick never creates a session or starts a first
review.
