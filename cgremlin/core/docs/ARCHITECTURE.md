# Architecture

## Layers

```
Frontends (thin clients)
  - CLI (cgremlin-core: serve, prs, review, sessions, scan, config, local, release)
  - cgremlin/vscode (VS Code extension)
        │  HTTP-over-Unix-socket API (JSON), GET /events (SSE)
        ▼
Engine (one process, built by src/host/build-engine.ts, run by src/host/serve.ts)
  - SessionStore, WorkspaceManager, PipelineService, StageRunner
  - InventoryScanner + DiscoveryScheduler + ReconciliationTick
  - EnvironmentService (local dev app + Vercel preview)
  - AttentionService (SourceAdapters + AckStore), EventRing, SessionWatcher
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

`mode: 'investigation' | 'review' | 'development' | 'respond'` is the sole source of truth
for a session's kind (`src/schema/session-mode.ts`). Each mode has its own phase enum and
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

**respond** (Phase 9, R51) — `triaging → addressing → ready → closed`, any non-terminal
phase → `abandoned`. The mode addresses the reviews on **my own** PR: `triaging` is the agent
classifying the live review threads into `COMMENTS.md`, `addressing` is working the entries
(local fixes and drafted replies), `ready` means every thread has a verdict and the fixes are
committed — so the thing it waits on is a **human**. `RESPOND_RUNNABLE_FROM` is
`['triaging', 'addressing', 'ready']`, and `runRespond` transitions `triaging → addressing`
inside the locked pre-run callback, so a brief is never written for a phase that has since
moved. `respond` is also a `STAGE_NAMES` entry, which is what lets `POST /sessions/:id/run`
validate it and `lastRun.stage` record it.

Nothing in this mode writes to GitHub (R55): the drafted replies live in `COMMENTS.md` for a
human to paste. See "Review threads" below for where the threads come from.

`canTransition`/`transitionPhase` (`src/schema/pipeline.ts`) are the only place these
tables are checked; `IllegalTransitionError` maps to HTTP 409. `TERMINAL_PHASES_BY_MODE`
(`src/workspace/workspace-in-use.ts`) is a `Record<Session['mode'], …>` read by eight
modules, so **adding a mode without filling it in is a compile error** — which is the
mechanism that made the fourth mode safe to add.

### Schema v2 fields (`src/schema/session.ts`)

Every session (v2) carries, beyond the v1 base (`id`, `createdAt`, `workspace`, `lineage`,
`mode`, `stageStatus`):

```ts
agent: { runner: 'claude-code' | 'codex'; resumeId: string | null;
         humanTurn: { claimedAt: string; expiresAt: string } | null } | null
lastRun: { stage, startedAt, finishedAt, exitCode, signal,
           outcome: 'running'|'succeeded'|'failed'|'stopped', error } | null
pr: { repo, number, url, headSha, reviewedSha, title, author } | null
```

`agent.humanTurn` is an additive, defaulted field (`HumanTurnSchema.nullable().default(null)`,
`src/schema/stage.ts`) — a Phase-7 addition, see "Human-turn claim" below — so every `session.json`
on disk keeps loading.

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
| `attention.changed` | `{ item: AttentionItem }` — emitted by `AttentionService` only on a real delta a client hasn't seen |
| `artifact.changed` | `{ sessionId, name, mtime }` — emitted from the session-directory watch, for a non-`AGENT_STATE` artifact write |
| `item.changed` | `{ id, kind, changedFields? }` — emitted by `WorkItemService` when a work item's rendered state moves. **An address, not a payload**: the ring buffers 256 frames and 256 whole `WorkItem`s would be resident memory paid for frames nobody reads, so a client re-reads `GET /items` (or `GET /items/<path>` for an open tab) and renders from that. `changedFields` is advisory — nothing may branch on its *absence* into a different correctness path (R41) |

`serve()` logs one JSON line per event to stderr; `--verbose` also logs `run.output`
(redacted). `awaitRunStart` (`src/pipeline/run-start.ts`) is the primitive every
"detached" API route uses to respond as soon as `run.started` fires rather than waiting
for the whole agent turn. `GET /events` (below) fans every one of these events out over SSE.

## Attention

`src/attention/` computes, for every trackable item, whether it `needsAttention` and whether
it `needsYou` — a rule the engine owns once so the CLI, the VS Code extension and any future
client agree (R18: `cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase7-vscode-ui-v1-design.md`
§2, §4.1).

- **`Item`/`ItemRef`** (`src/attention/item-ref.ts`, `src/attention/attention-service.ts`): every
  item is generic over a `source: 'pr' | 'session'` (future: `'jira' | 'slack'`), addressed by a
  stable, parseable `ItemRef` string (`'session:<id>'` / `'pr:<owner>/<repo>#<n>'`), which is also
  the acknowledgement key.
- **`SourceAdapter`** (`src/attention/attention-service.ts`): one per `ItemSource` —
  `SessionSourceAdapter` and `PrSourceAdapter` — each `collect()`s its items and calls its own pure
  `derive*Reasons` function (`deriveSessionReasons`/`derivePrReasons`, `src/attention/attention.ts`).
  **A new item source is an adapter plus a `derive*Reasons`, nothing more** — the shared,
  source-agnostic `evaluateAttention` (ordering, the `signature`, the ack comparison) never changes.
- `ATTENTION_REASONS` (`src/attention/attention.ts`) is the ordered `as const` list every item's
  `reasons[]` is sorted into (never `.sort()`ed — dedup and order come from iterating this list); the
  subset `NEEDS_YOU_REASONS` decides `AttentionState.needsYou`, and lives only here — no client
  re-derives it.
- **`AttentionService`** (`src/attention/attention-service.ts`) composes the adapters plus an
  `AckStore` (`<stateDir>/attention-acks.json`, keyed by `ItemRef`) and subscribes to both the
  engine's own events and the `SessionWatcher`; `refresh(scope)` coalesces bursts by joining an
  in-flight recompute for the same scope and scheduling at most one trailing recompute behind it
  (not a fixed-window timer), and emits `attention.changed` only on a real delta — dedup compares
  the reasons/`since`/claimed/running/mode/title shape of an item, not its `ItemLinks`.
  `AttentionService.refresh` reads `session.json` **without taking the per-session lock** —
  `SessionStore.save` is tmp-then-rename, so an unlocked read never sees a torn document, and
  attention must never block a stage run.
- **Routes**: `GET /attention` (`?all=1` for every evaluated item, `?source=session|pr` to filter;
  default is only items with `needsAttention`), `POST /attention/ack { ref }` (the one ack path),
  and the two named aliases `POST /sessions/:id/ack` / `POST /prs/:owner/:repo/:number/ack`.

## Work items

`src/work/` answers the question the panel actually asks — *what am I working on?* — by
**grouping** the attention items, never by deriving a second opinion about them (R1). Nothing
in this directory reads a session document, an `AGENT_STATE` file or an artifact mtime, and
nothing in it takes a session lock (MG-1): `deriveSessionReasons`/`evaluateAttention` is the
one place the "does this want me" rule lives, and a second reader of session state would be a
second copy of that rule *and* a second thing that could block a stage run.

- **`groupWorkItems`** (`src/work/work-item.ts`) is **pure**: no clock, no I/O. It takes the
  **pre-dedupe** attention list (`attention.list({ all: true, dedupe: false })`, R27 — so a work
  item can still see the PR row's draft flag, review requests and human activity after
  `AttentionService` has folded that row into its session), the inventory, the last Jira scan
  and the config, and returns one `WorkItem` per piece of work. A `WorkItem` is
  `kind: 'pr' | 'ticket' | 'pr+ticket' | 'session'` with `prs[]`, `ticket`, `agents[]` and one
  merged `attention` block whose `refs[]` are every contributing `ItemRef` (which is what makes
  the ack a server-side fan-out, R31).
- **Ids** (`src/work/work-item-id.ts`): `ticket:<KEY>` | `pr:<owner>/<repo>#<n>` |
  `session:<id>`. Ids are **stable under a link appearing**: once a PR names a ticket the item's
  id is the ticket's, which is why every route addresses an item by a **path** (`ticket/:key`,
  `pr/:owner/:repo/:n`, `session/:id`) that resolves to the item *containing* that part rather
  than by matching the item's own id (R65).
- **`isBotLogin`** (`src/work/bot-login.ts`) is the ONE bot predicate in the engine: the
  parsed author's `is_bot` when gh emitted one, then a `[bot]` suffix, then the default list
  widened (never replaced) by `config.botLogins`. MG-4 asserts no second `[bot]` literal exists.
- **`sizeTier`** (`src/work/size-tier.ts`) is the core's own `S | M | L | XL` verdict on a PR,
  carried on every `WorkItemPr`. It is pure arithmetic on `changedFiles` and
  `additions + deletions`: a tier is computed from **each dimension independently**
  (files ≤ 3 / 10 / 25, lines ≤ 50 / 300 / 1000) and the **worse of the two wins**, so a
  one-file 1800-line generated diff is not an `S` and neither is a thirty-file rename sweep.
  `null` whenever any of the three inputs is null — a missing field is unknown, never a
  fabricated zero (R45/MG-12). It lives in the core so the CLI and every client agree on one
  answer; a client that wants to sort by size sorts on the tier first and on the raw file count
  only to break ties inside one tier.
- **`WorkItemService`** (`src/work/work-item-service.ts`) composes the grouping with the
  attention service, the inventory store, the Jira scanner and the review-thread scanner, and
  emits `item.changed` deltas. `serve()` owns its `start()`/`stop()`, exactly as it does for
  `AttentionService`.

### The four lists (R47–R50)

Membership is the **core's** answer (D2). A client re-sorts and renders; it never re-derives
which list a row is in, whether somebody is already on a PR, or which parking-lot group a row
belongs to. `lists` on the response carries per-list **order** as id arrays; `items` is a set
keyed by id, sorted by `id`, because one array cannot carry four different orders at once.

| List | Membership |
|---|---|
| `parkingLot` | A teammate's open PR (`isDraft !== true`, `isMine !== true`) that is either by a `watchAuthors` login, or has **my** review requested (R30 — a request to me outranks the watch list), or `showAllRepoPrs` is on. Split into three ordered groups: **`reviewing`** (we already have a review agent on it) on top, then **`untouched`**, then a collapsed **`someoneOnIt`**. R57's totality disjunct keeps a **merged or closed** teammate PR listed while a live review agent is still on it |
| `myWork` | A Jira ticket assigned to me ∪ my own open PRs ∪ any item with a non-`review` agent. **A review agent never routes an item into `myWork`** (R48, the coordinator override): a teammate's PR we are reviewing is a teammate's PR, and it belongs at the top of the parking lot |
| `investigations` | Literally "the sessions I only have an investigation for" — no PR, no ticket, investigation agents only. A **ticket-linked** investigation is a commitment to deliver, so it is `myWork` instead (R49) |
| `waitingForReview` | My own open PRs. Clicking one creates a `respond` session and **starts its run** (R51/R56) |

`demoted` is "somebody is already on this PR", and since Phase 10 it is **exactly one thing**:
`humanActivity.lastAt !== null` — a human has actually reviewed or commented, computed at scan
time from the **unfiltered** reviews and comments, never from the watch-filtered `teamActivity`.
A pending **review request** no longer demotes anything (R47.1, reversed): GitHub asking somebody
is not that somebody having looked, and a row hidden behind the collapsed group is a row nobody
reads. The request is still carried on the PR and still rendered on the row — it is information,
not a verdict. A **draft** is in no list at all, mine included.

The ticket merge is deliberately one-sided (R61): a PR and a ticket become one row only when
the **resulting item would be mine**, so two teammates' PRs naming one ticket key stay two
items — in the parking lot the user is choosing between PRs to *read*, and merging them hides
one behind the other.

## Jira (the ticket source)

`src/jira/` is **read-only, forever**. `JiraSource` (`src/jira/jira-source.ts`) has three
methods — `whoami`, `search`, `issue` — and no fourth; the REST adapter issues only `GET`
(a source grep for `method: 'POST'` under `src/jira` must be empty), and there is no Jira
write path anywhere in the engine.

- **Config** (`jira` in `core.json`): `siteUrl` and `email` are required, `apiToken` is the one
  thing the user must supply. `baseUrl` defaults to `siteUrl` and exists so a test or a proxy
  can point the adapter elsewhere; **browse URLs are always built from `siteUrl`** (R37).
  `jql` is one string (`assignee = currentUser() AND statusCategory != Done ORDER BY updated
  DESC` by default) — a user who wants the current sprint edits that one string.
  **`projectKeys` is required for linking**: empty means ticket linking is *disabled*, not
  unfiltered, because the bare key regex happily links `SHA-256` and `UTF-8` (R46). The engine
  says so once per process, never once per PR. `extraFields` is where instance-specific field
  names go — an unknown field name 400s the whole request, which is why
  `acceptance_criteria`/`customfield_10016` are not in the default set.
- **The secret regime** (R44, MG-5): `jira.apiToken` is treated exactly like
  `vercel.bypassSecret` — it makes `hasAnySecret` true (so a world-readable `core.json` is
  refused), it is `[redacted]` by `redactCoreConfig`, and it never appears in a brief, a log
  line, an event frame, an HTTP response or `jira.json`. The only place it is read is the
  adapter's `Authorization` header.
- **Both pagination shapes** (R32): `/search/jql` first, paging by `nextPageToken`/`isLast`; a
  404 or 410 means the instance has not migrated and the adapter falls back to `/search`
  (`startAt`/`maxResults`/`total`, reading the **response's** page size, since Jira caps it
  server-side). The fallback fires **once per scan**, never once per page.
- **The scan leg** (`src/jira/jira-scanner.ts`, R12/R34/R35): folded into the discovery tick
  rather than given a second scheduler, but it runs **after** `inventory.updated` is emitted,
  is **not awaited** by the tick, is single-flight, is bounded by one `AbortController` at
  `jira.scanBudgetMs` for the whole leg (whoami plus every page), and reports failures instead
  of throwing them. `ScanReport.jira` carries the **last completed** report, which is what lets
  `POST /prs/scan` answer at PR speed against a Jira that is timing out.
- **Degrade, never empty** (MG-6): a failed scan keeps the previous tickets and says why.
  `ticketSource.kind` is `ok` | `unavailable` | `auth` (a 401/403 — the one state a restart will
  not fix) | `notConfigured` (no block, or no token: not an error, and **not** a reason to make
  a request or clobber the cache). The previous `jira.json` is deliberately not rewritten on a
  failure, so a restart still finds yesterday's answer.
- **No HTML crosses the port** (R33, MG-10): `renderedFields` is flattened to text in
  `src/jira/html-to-text.ts`, and no identifier ending in `Html` exists on the boundary.
- **Caches**: `jiraCachePath` (`<stateDir>/jira.json`) for the scan, plus a short-lived
  `TicketDetailCache` so repeat opens of one Item tab stay off the network (R36).

## Review threads

`src/gh/review-threads.ts` is the engine's **first and only** GraphQL call (R52). It goes
through the existing `GhRunner` (`gh api graphql`), so there is no new port, no new process
spawner and no new fake. Like `src/jira`, it is read-only forever: every document here is a
`query`, and MG-14's greps are what keep it that way.

- **The query** is the legacy tool's (`bin/cgremlin:14776-14787`) widened from
  `comments(first:1)` to `comments(first:100)` on purpose — the truncation is exactly why the
  old brief had to reconcile replies by hand. A thread with more comments than one page is
  followed by a second query addressed at the thread's own node id
  (`node(id:) { ... on PullRequestReviewThread { comments(after:) } }`), capped at
  `MAX_COMMENT_PAGES`; past the cap the thread is marked `truncated` rather than coming back
  silently short.
- **The fetch policy** is the cost control, decided because "threads for all 58 PRs every tick"
  is the risk: only **my** open non-draft PRs (they feed `waitingForReview` and the respond
  brief) and a parking-lot candidate whose `humanActivity` is *empty* from reviews and comments
  alone — the only case where a thread comment could change the answer. A PR that already has
  human activity needs no thread call to stay demoted.
- **The cache** (`reviewThreadsCachePath`, `<stateDir>/review-threads.json`) is keyed
  `"<repo>#<n>"` with the PR's `updatedAt` recorded beside the threads: an unchanged
  `updatedAt` is **never** refetched, so a steady-state tick makes **zero** GraphQL calls
  (MG-16). The leg runs on R34's discipline exactly like the Jira one — after
  `inventory.updated`, not awaited, single-flight, budgeted by
  `reviewThreads.scanBudgetMs`, drained by `stop()`, and leaving the previous cache intact on
  failure.
- A thread reply counts towards `humanActivity` exactly like a conversation comment, and is the
  only such signal the two `gh pr list` arrays cannot see. Because the leg publishes *after* the
  scan, that half is deliberately **one tick behind**.

## Session-directory watcher

The founding "artifact-driven completion, not agent callbacks" rule (above, and `docs/DECISIONS.md`)
means the agent writes `FINDINGS.md`/`PLAN.md`/`AGENT_STATE` directly, inside its own turn, with no
engine involvement — so a mid-turn "the agent is asking a question" is invisible to the engine unless
something watches the filesystem.

`SessionWatcher` (`src/fs/session-watcher.ts`) is a port; `NodeSessionWatcher`
(`src/fs/node-session-watcher.ts`) is the real implementation: `fs.watch(sessionsDir, { recursive:
true })` when available, falling back to a `pollIntervalMs` (default 2000 ms) mtime scan on
`ENOSYS`/`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. It maps a relative `<sessionId>/<name>` path to a
`SessionWatchEvent { sessionId, name }`, discards anything not exactly two path segments and anything
whose `name` isn't in the artifact allow-list plus `AGENT_STATE`/`AGENT_NOTE`, coalesces duplicate
reports of the same `<sessionId>/<name>` within 100 ms, and never reads file *contents* — only
`AttentionService`, subscribed as the consumer, does that. A watch event for `AGENT_STATE` triggers an
attention recompute for that session (may emit `attention.changed`); any other allow-listed artifact
emits `artifact.changed` directly.

## Event ring and `/events` (SSE)

`GET /events` streams every `EngineEventMap` event as Server-Sent Events over the same Unix socket.

- **`EventRing`** (`src/api/event-stream.ts`) is a bounded in-memory ring buffer, capacity 256
  (`EVENT_RING_CAPACITY`), carrying an incrementing id per pushed event and an `epoch` string
  (`<process-start-ISO>-<random>`) that changes on every engine restart.
- **Replay + live handover, no gap and no duplicate**: a connection opens with `retry: 2000` then
  `event: hello\ndata: {epoch, lastEventId}`; if it carries a `Last-Event-ID` header (or
  `?lastEventId=`), the handler reads `ring.since(id)` as a snapshot, writes those frames, records the
  last id written, and only then subscribes live — the live callback discards anything with an id
  at-or-before that point, so an event pushed during the handover is delivered exactly once.
- **Resync**: `since(n)` reports `complete: false` — and the connection gets an `event: resync` frame
  instead — when `n` is older than the ring's oldest id, when `n` is *greater* than the ring's current
  max (the engine restarted and reused the id space), or when a supplied `?epoch=` no longer matches;
  a client that sees `resync` must refetch `/prs`, `/sessions`, `/attention` rather than wait for ids
  that will never arrive.
- **`run.output` is opt-in and always redacted**: sent only with `?include=run.output`, through the
  same `redactBypassUrls` call `serve()` itself uses (R8) — one turn emits hundreds of these chunks
  and they can carry a bypass URL.
- **Backpressure**: when `res.write` returns `false` the connection is marked lagging; while lagging,
  `run.output` frames are dropped (they're opt-in and replayable from the ring) while every other
  frame is still queued; if the queue passes 256 pending frames (`MAX_PENDING_FRAMES`) the connection
  is destroyed — a stalled reader must never grow the engine's heap. `'drain'` clears the lagging flag.
- **Cleanup**: a 15 s heartbeat (`: ping`) is `clearInterval`ed, and every per-connection `events.on`
  subscription is removed, in the same `req.on('close')` handler.
- **The stream is global** — there is no `?session=` filter. A client subscribes before the sessions
  it cares about exist (a fresh window has no id to filter by yet, and `POST /sessions/developments`
  must be observable on a connection that predates it); per-session filtering is client-side, on
  `sessionId`/`ItemRef`.

## Human-turn claim

A human can take over an agent conversation (`claude --resume <id>` in a terminal) without racing the
engine's own headless pipeline. `session.agent.humanTurn: { claimedAt, expiresAt } | null`
(`HumanTurnSchema`, `src/schema/stage.ts`) is a **claim, not a flag** — it expires
(`CoreConfig.humanTurnTtlMs`, default 10 minutes) so an extension that crashes, or a terminal on a
machine that reboots, can never wedge a session's pipeline forever.

- `isClaimed(session, now)` (`src/pipeline/pipeline-service.ts`) is the **one** definition of
  "claimed" — present and `expiresAt > now` — used by both refusal sites below, `conversation()`,
  `AttentionItem.claimed`, the `sessions` CLI table, and the reconciliation tick.
- **Checked twice.** An **advisory, unlocked** check — `if (isClaimed(session, this.now())) throw new
  HumanTurnInProgressError(id);` — is the first statement after each `run*` method's existing mode
  check (and in `promote()`), on the snapshot already loaded, so a refusal costs no environment setup
  and no git work. The **authoritative, locked** check, `assertNoHumanTurn(fresh)`, is the first
  statement after the fresh load inside each stage's locked pre-run (and inside `promote()`'s own
  lock) — it is the one that actually blocks a headless turn: a claimed conversation blocks every
  headless turn, checked **authoritatively inside** the per-session lock (the unlocked advisory copy
  runs earlier, and is never a substitute), and every claim expires. Being on the write path, the
  authoritative check also **reaps** an expired claim (`agent.humanTurn = null`, saved under the lock
  it is already inside) rather than merely ignoring it.
- **Claiming while a run is live is refused** (`claimConversation` → 409 `RunInProgressError` when
  `pipeline.activeSessionIds()` contains the id) — two `claude --resume` processes on one transcript
  is unrecoverable corruption.
- **Four paths clear an orphaned claim**: expiry (reaped by the first authoritative check that trips
  over it); `serve()` clears every session's claim before it starts listening (logs one
  `conversation.claims_cleared` line); a `transition` into a phase in `TERMINAL_PHASES_BY_MODE`
  (`src/workspace/workspace-in-use.ts`) clears it in the same locked write; and
  `cgremlin-core release <session-id>` (→ `POST /sessions/:id/conversation/release`) clears it by
  hand.
- **Reconciliation skips, not errors**: a claimed review session that would otherwise get a
  `rereview` action instead gets a `SkippedTransition` — the tick never files a `report.errors` entry
  for a claim, and merge/close/approve transitions still apply on schedule (and clear the claim) —
  a claim delays a re-review, never the truth about a PR.
- **Routes**: `GET /sessions/:id/conversation` → `{ runner, resumeId, worktreePath, claimed }`;
  `POST /sessions/:id/conversation/claim` / `.../release`.

## API route table

All routes are on the Unix socket at `config.socketPath`, JSON in/out.

| Method | Path | Purpose | Notable status codes |
|---|---|---|---|
| GET | `/events` | global SSE event stream — every `EngineEventMap` event; `Last-Event-ID`/`?lastEventId=` replay, `?include=run.output` opt-in | see "Event ring" above |
| GET | `/sessions` | list all sessions | |
| GET | `/sessions/:id` | load one session | 404 unknown id |
| GET | `/sessions/:id/artifacts` | list a session's artifacts, with mtimes and the core-chosen `primary` | 200, 404 unknown session |
| GET | `/sessions/:id/artifacts/:name` | read an allow-listed file from the session dir | 400 bad name, 404 not found |
| GET | `/sessions/:id/changes` | "changes so far" for one session's worktree: `{base, baseResolved, head, committed, workingTree}`, each summary `{files, additions, deletions, entries[]}`. `committed` is the diff from `git merge-base <base> HEAD` to `HEAD` — the merge base, so a stale or rebased base never inflates the count — and `workingTree` is `git diff HEAD`, which is uncommitted work on **tracked** files only. `base` is the PR's own `baseRef` from the current inventory when the session carries a PR, else `config.defaultBaseRef`; `baseResolved` is a **boolean** saying whether `merge-base` resolved, and `false` means the committed half fell back to a three-dot diff against `base` itself rather than failing the request. A pure read of the worktree, deliberately **not** under the session lock — it never contends with a run | 200 (with every field `null` when the session has no worktree), 404 unknown session or no git configured |
| GET | `/items` | the four work-item lists: `{evaluatedAt, lists, items, ticketSource, threadSource}`. `?list=parkingLot\|myWork\|investigations\|waitingForReview` narrows it (`reviewing` is a **group**, not a list, and is rejected). A pure read — it starts nothing (MG-8) | 200, 400 unknown list, 404 no work-item layer wired |
| GET | `/items/ticket/:key`, `/items/pr/:owner/:repo/:n`, `/items/session/:id` | `{item, ticket, ticketError, artifacts}` for the item **containing** that part (R65) — a `pr/` path on a ticket-linked PR answers with the `ticket:` item, and `artifacts` is keyed by session id. `ticket` is the full Jira detail as text, fetched on demand; a Jira that is down answers `ticket: null` with `ticketError` rather than failing the route | 200, 404 no item owns that path |
| POST | `/items/<path>/ack` | acknowledge the item — the fan-out over **every** contributing `ItemRef` happens server-side, so no client re-derives which refs an item owns (R31) | 200 `{item, acked, failed}`, 502 when every ack failed |
| POST | `/items/<path>/agents` `{mode, repoUrl?, intent?, driveToCompletion?, selfReview?}` | create (or report) an agent on this item, **composing the existing creation paths** rather than inventing a second one. `review` and `respond` take the same `pr:<slug>#<n>` lock key the review routes take, so they cannot race `POST /prs/…/review`. `respond` creates AND starts the run (R56) | 202 `{session, created, started, item}`, 200 `{…, reason}` when an existing session is left alone (a run in flight, or a human holds the claim), 400 no PR / no repoUrl for a ticket-only item, 409 own PR (`review`) or **not** my PR (`respond`). **`selfReview: true`** (mode `review` only) is the one way past `OwnPrError`: it is a deliberate request to review your **own** PR, it is recorded on the created review session's `lineage.selfReview`, and the review prompt says so — an agent that did not know would write a review addressed to somebody else. No other caller can set it, so `POST /reviews` and `POST /prs/…/review` keep refusing own PRs |
| GET | `/attention` | `?all=1` for every evaluated item (default: only `needsAttention`); `?source=session\|pr` to filter | 200 |
| POST | `/attention/ack` `{ref}` | acknowledge one item by `ItemRef` | 200, 400 unparseable ref, 404 |
| POST | `/sessions/:id/ack` | alias for `{ref: sessionRef(id)}` | 200, 404 |
| POST | `/prs/:owner/:repo/:number/ack` | alias for `{ref: prRef(slug, n)}` | 200, 404 |
| GET | `/version` | `{name, version, buildId, pid, startedAt, socketPath, activeRuns}` — the liveness/identity probe. **`buildId`** is a content address of the engine bundle and is the other half of the adoption handshake: `version` is the *package's* and does not move between phases, so a version-only check adopted a stale engine and then found routes missing on it for as long as it kept running. A client adopts only when **both** agree. Built with **no dependencies at all**, so it answers 200 on any engine; `/config` 404s on an engine with no config dep, which is why `/config` cannot be a probe. `activeRuns` is computed **per request** as `pipeline.activeSessionIds().length + environment.inFlightCount()`: the first term misses a stage still *preparing* its environment, and cancelling one of those is just as destructive as cancelling a run, so a restart decision needs both | 200 |
| GET | `/config` | the resolved, redacted `CoreConfig` | 200 |
| POST | `/sessions` | save a raw session record | |
| POST | `/sessions/investigations` | create an investigation session (+ workspace) | 201 |
| POST | `/sessions/developments` `{repoUrl, ticket, baseRef?}` | create a development session directly — its own fresh worktree, self-rooted lineage, **starts nothing** | 201, 400 validation |
| POST | `/sessions/:id/transition` `{to}` | force a phase transition | 409 illegal transition |
| POST | `/sessions/:id/run` `{stage}` | run one stage | 202 (after `run.started`), 409 run in progress / unsupported stage / human-turn claimed |
| POST | `/sessions/:id/approve-plan` | human approves a ready plan | 409 wrong phase |
| POST | `/sessions/:id/promote` | promote to development, start `develop` | 202 `{investigation, development}`, 409 plan gate / claimed |
| POST | `/sessions/:id/rereview` | re-review a review session | 202 |
| POST | `/sessions/:id/stop` | stop the active run, if any | 200 `{stopped: boolean}` |
| POST | `/sessions/:id/retry` | re-run the last stage | 202 |
| GET | `/sessions/:id/conversation` | `{runner, resumeId, worktreePath, claimed}` | 200, 404 |
| POST | `/sessions/:id/conversation/claim` | claim the agent conversation for a human | 200 `{session}`, 404, 409 run in progress |
| POST | `/sessions/:id/conversation/release` | release the claim | 200 `{session}`, 404 |
| POST | `/workspaces` | create a bare workspace (mirror + worktree) | 201 |
| DELETE | `/workspaces` | remove a workspace | 409 still in use |
| GET | `/prs` | `{inventory, groups}` from the last scan | 404 no scan yet |
| POST | `/prs/scan` | run one scan now | 409 scan already running |
| GET | `/prs/status` | scheduler status | |
| GET | `/prs/:owner/:repo/:number` | one inventory entry | 404 |
| POST | `/prs/:owner/:repo/:number/review` | start (or report) a review; `?refresh=1` forces a scan first | 202/201/200, 404 not in inventory, 409 own PR |
| POST | `/reviews` `{prUrl}` | start (or report) a review for **any** PR URL, including a repo outside `config.repos` — the only way to review an off-config repo | 202/201 created, 200 already tracked (R23), 400 bad URL, 409 own PR |
| GET | `/local`, `GET /sessions/:id/local` | local-app status (id-less form: whichever session owns it) | 404 no environment configured |
| POST | `/local/stop`, `POST /sessions/:id/local/stop` | stop the local app | |
| POST | `/sessions/:id/local/start` `?fresh=1` | start the local app for this session | 409 unavailable (busy port/prereq/unhealthy) |

`mapErrorToHttp` (`src/api/http-errors.ts`) is the single place error names become status
codes: `SessionNotFoundError`/`ArtifactNotFoundError`/`NoScanYetError`/`ItemNotFoundError` → 404;
`InvalidSessionIdError`/`ValidationError`/`InvalidPrUrlError` → 400; `IllegalTransitionError`,
`PlanGateError`, `RunInProgressError`, `WorkspaceInUseError`, `HumanTurnInProgressError`,
`UnsupportedStageError`, `WorkspaceMissingError`, `TickInProgressError`, `OwnPrError`, `NotMyPrError`, and every
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
| `config init [--me <login>] [--force]` | write a first-run `core.json` (`{me, repos: [], runner}`) through `writeCoreConfig` — 0600, no derived paths persisted; exit 2 without `--me`, exit 1 over an existing file without `--force` |
| `config check-jira` | `GET /rest/api/3/myself` with the configured credentials — the same check the legacy tool made. On failure it prints **Jira's own wording**, because that is the only thing that tells a wrong token from a revoked one from a captcha challenge. The token itself is never printed. Runs against the config, not the socket: it works with the engine stopped |
| `config import-legacy [--force]` | read the legacy `~/.cgremlin/config`, write `~/.cgremlin-core/core.json`. That legacy path is the only `~/.cgremlin` reference left in the engine |
| `local start <session-id> [--fresh]` / `local stop\|status [session-id]` [--json] | the `/local*` routes |
| `release <session-id>` | `POST /sessions/:id/conversation/release` — the by-hand human-turn recovery path |

`sessions [--json]` gains a `claimed` column (text and JSON), computed by `isClaimed` — never by
`humanTurn !== null` alone — so an expired claim reads as unclaimed there too.

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

**Add an item source**: a source is an attention `SourceAdapter` plus its own pure
`derive*Reasons` (see "Attention"), and nothing else — `evaluateAttention` is source-agnostic
and never changes. `src/work/` then groups whatever the adapter produced: give the new source
an id shape in `src/work/work-item-id.ts` if items of that kind can stand alone, teach
`groupWorkItems` which candidate it joins, and add its membership clause to `membership()`.
Do **not** add a reader of session or filesystem state to `src/work/` — MG-1's grep is what
keeps the UI path lock-free.

**Add a session mode**: add it to `SessionModeSchema` (`src/schema/session-mode.ts`) and a
variant to the v2 session union (`src/schema/session.ts`; both unions are discriminated on
`mode`, so a fourth variant is additive and the **v1** union is deliberately not extended).
Add its phase enum and transition table to `src/schema/pipeline.ts`, then fill it in at
`TERMINAL_PHASES_BY_MODE` (`src/workspace/workspace-in-use.ts`) — that map is a
`Record<Session['mode'], …>` read by eight modules, so **the compiler is the gate**: a missed
site is a build error, not a runtime surprise. If the mode can run, it also needs a
`STAGE_NAMES` entry, a `render<Mode>Brief`, a `run<Mode>` on `PipelineService` with its own
`*_RUNNABLE_FROM` list, and a `runStage` switch arm — `respond` (Phase 9) is the worked
example, and `POST /sessions/:id/run` failing zod validation is what a missing stage name
looks like.

**Add a runner**: implement `AgentRunner` (`src/agent/agent-runner.ts`); wire it into
`realAdapters()` (`src/host/serve.ts`) behind `config.runner`; add it to
`CoreConfigSchema.runner`'s enum. `StageRunner`'s resume-mismatch guard (compare
`session.agent.runner` to `runnerKind`) needs no change — it's generic.

**Add a config field**: add it to the appropriate zod schema in
`src/config/core-config.ts`; if it's a derived path, add it to `DERIVED_PATH_SUFFIXES`
and `resolveCoreConfig`'s `expandOrDerive` calls so it participates in `stateDir`
derivation and is omitted from a persisted file when it's just the default. Never make a
new field required — every existing `core.json` on disk must keep loading. The two paths
Phase 8 added, `enginePidPath` (`<stateDir>/engine.json`) and `engineLogPath`
(`<stateDir>/engine.log`), are registered in both places; registering only one is the
documented failure mode (the file loads, and then the value is silently re-persisted).
`stateDir` itself now defaults to `~/.cgremlin-core`; a `core.json` that names
`~/.cgremlin` explicitly still resolves every path under it, because the rename is a
change of *default*, not a hard-coded path.

**The engine's identity file and admission lock (`engine.json`)**: `serve()` creates
`config.enginePidPath` with `open(path, 'wx')` (O_EXCL, mode 0600) **before** it calls
`listenOnSocket`, writes `{pid, version, socketPath, startedAt}` into it, and removes it
in `close()`'s `finally` *and* on a failed listen. It is therefore two things at once:

- **the admission lock.** `listenOnSocket` cannot be the mutual-exclusion primitive: its
  liveness test is a *connect*, and it unlinks a socket nobody answers, so two engines
  starting at the same instant can both proceed and the loser can unlink the winner's
  fresh socket. Exactly one engine therefore wins a state dir; the loser exits 1 with
  `SocketInUseError`. **The create is a write-then-`link`, not `open(path, 'wx')`** — the
  design's original wording was wrong: `wx` is exclusive but publishes a *zero-byte* file
  that the loser can read before the winner has written a word, and a record with no
  readable pid looks exactly like a dead owner to take over. `link()` from a temp file is
  atomic, fails `EEXIST`, and the file is complete the instant it exists.
- **taking over a dead owner needs a command-line check, not just a pid.** On `EEXIST`
  the recorded owner is probed: if its socket answers, it is the owner and this boot
  refuses; if its pid is alive but silent, `ps -o command= -p <pid>` decides — a command
  naming `cgremlin-core` or `engine.js` is an engine still booting (refuse), anything
  else is a reused pid (take over), and a pid that cannot be identified refuses with an
  explicit "delete that file if no engine is running". Without that check one recycled
  pid would make every later `serve` refuse forever. This is the same posture
  `NodeLocalAppRunner.isOurListener` takes before it trusts a pgid.
- **a stop the engine may refuse.** `POST /shutdown` is the primary way to stop an engine,
  and the engine decides: the requester must prove its bundle is strictly newer than the
  engine's own `buildTime`, or be a person (`reason: 'user'`). Anything else is `409` and the
  engine keeps serving. A signal is not a request — it carries no sender (POSIX puts it in
  `siginfo_t`, Node exposes none of it) and cannot be refused, so SIGTERM is left for the one
  case a request cannot cover: an engine that no longer answers its socket at all.
- **the ownership proof, for whoever stops the engine.** A pid file alone never
  authorizes a signal. `GET /version` on that socket must confirm the same `pid` **and**
  the same `startedAt` — `startedAt` is what survives pid reuse — and that pair must be
  re-taken **immediately before** each signal, not once per stop, or the check/use window
  lets a reused pid take the signal. Any disagreement aborts the stop and signals
  nothing. The residual window is microseconds wide and not zero: the same posture
  `isOurListener` already documents, not a stronger claim.

**The 0600 trap, documented because it bites later rather than now**: `loadCoreConfig`
asserts mode 0600 **only when the config holds a secret** (`hasAnySecret`). An editor or
tool that rewrites `core.json` and drops the mode therefore breaks nothing today, and
refuses to load the moment a `bypassSecret` is added — a failure whose cause is weeks in
the past. Anything that writes `core.json` re-asserts 0600.

**Add an event**: add it to `EngineEventMap` and `ENGINE_EVENT_TYPES` (`src/engine/events.ts`) — the
`/events` route and its `EventRing` need no change, since `handleEventStream` subscribes to every
`EngineEventMap` key generically. If the event is attention-relevant, wire the emitting code to call
`AttentionService.refresh(scope)` rather than emitting `attention.changed` directly — that keeps the
"only on a real delta" and debounce guarantees in one place.

**Invariants any change must keep**: the locking invariant above; environment preparation
never takes a session lock and never writes session state; a foreign process (on a port,
or holding a local-app record this engine can't prove is its own) is never signalled;
the Vercel bypass secret is representable only as a file path in a brief's params, never
as a string value; the reconciliation tick never creates a session or starts a first
review; a claimed conversation blocks every headless turn, checked **authoritatively
inside** the per-session lock (an unlocked advisory copy runs earlier, and is never a
substitute for it), and every claim expires.

## Frontends: VS Code extension

`cgremlin/vscode` is the reference UI (`cgremlin/vscode/README.md`). It is a **pure client of the
socket API** — every rule in the "layer split" that phase's spec lays out
(`cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase7-vscode-ui-v1-design.md` §2) reduces
to: **core owns state, rules and side effects; the extension owns presentation and intent.** In
particular the extension never scans GitHub, never spawns an agent, and never re-derives anything the
core already answers — most visibly, `needsYou` (whether an item should interrupt) is computed once
by `AttentionService` and the extension only reads `AttentionItem.attention.needsYou`; it carries no
copy of `NEEDS_YOU_REASONS`.

- **One worktree folder at a time.** The extension manages a multi-root `cgremlin.code-workspace`
  file that holds exactly one repo folder — the worktree of the most recently opened session; opening
  a different session swaps it via a single `updateWorkspaceFolders(0, 1, {uri})` call, never a
  single-folder→multi-root transition (which would restart the extension host). There is no pinning
  or LRU in v1.
- **Chat is `claude --resume <id>` in a plain VS Code terminal** (`createTerminal({ cwd:
  worktreePath }).sendText(...)`) — the engine itself "never spawns a terminal" (above), and no VS
  Code extension API accepts a `cwd` for a resume, so a terminal with an explicit `cwd` is the only
  correct mechanism. The extension re-claims the conversation (`POST
  .../conversation/claim`) every `humanTurnTtlMs / 3` while that terminal is open, so a live
  conversation never expires its claim.
- **`needsYou` is computed by the core, once.** The extension's notification policy filters on
  `item.attention.needsYou` and the user's `cgremlin.notificationLevel` setting — nothing else.
- **Since Phase 8 the extension ships and supervises the engine.** It bundles two esbuild
  artifacts of this package (`engine/engine.js`, spawned; `engine/bridge.js`, required) and starts
  the engine itself, detached, whenever nothing answers the socket — one engine per state dir,
  shared by every window, and never stopped when a window closes. It has exactly one setting,
  `cgremlin.configPath` (default `~/.cgremlin-core/core.json`); **every** other path —
  `stateDir`, `socketPath`, `sessionsDir`, `worktreesDir`, `enginePidPath`, `engineLogPath` — comes
  from one call into the bundled bridge, so the extension still derives no state path of its own.
  It resolves the engine's `PATH` from the user's login shell (`$SHELL -lic 'echo $PATH'`, 5 s cap,
  one logged fallback line) because a GUI-launched editor's `PATH` need not contain `claude` or
  `gh`, and it strips `NODE_OPTIONS` and every `VSCODE_*` key from the child's environment (the
  engine bundle scrubs the same keys from its own `process.env` at startup, so an agent it later
  spawns cannot inherit them either).
- **`engine.json` is the lock, and it carries the identity.** `serve()` writes
  `{pid, version, buildId, socketPath, startedAt}` **before** it listens (R22), so a losing second
  engine is refused without having cleared the winner's claims. `buildId` is there for the same
  reason `/version` carries it: a window that reads the lock can tell a stale engine from the one
  it ships without asking the socket.
- **Since Phase 10 an upgrade restarts the engine exactly once.** The extension's handshake
  compares `version` **and** `buildId`, so a rebuilt bundle under an unchanged package version is
  recognised as a mismatch. The restart it earns is one: the config watcher is **content-addressed**
  (a `chmod`, a touch or any write that changes no bytes restarts nothing — on macOS a `chmod` of a
  watched file is itself an event for it, which is how a window used to feed itself), and an
  automatic restart is spent **once per engine identity** (`pid@startedAt`), so the same running
  engine cannot be restarted twice by the same decision arriving again. A person is never refused.
  The client also waits out a short window (8 s, past the third reconnect backoff) before saying
  the engine is unreachable, so a restart passes in silence instead of flapping a banner.
- **It never unlinks a socket and never signals a process it cannot prove is cgremlin-core.**
  Stale-socket recovery stays `listenOnSocket`'s job. A stop is one `SIGTERM` against the
  freshly re-proved pid, then polling — never a second signal, never `SIGKILL`, whatever the wait:
  only `serve()`'s own `close()` stops agents, clears claims and stops the local app in the right
  order, and a hard kill would orphan a dev server. A restart is gated on `GET /version`'s
  `activeRuns`: zero restarts silently, more than zero asks first.
