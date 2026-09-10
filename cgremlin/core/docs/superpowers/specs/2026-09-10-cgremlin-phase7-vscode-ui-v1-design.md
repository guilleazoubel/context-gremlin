# cgremlin Phase 7 — VS Code UI v1 and its core additions: Design

Date: 2026-09-10
Status: **rulings proposed; R1–R5 are restatements of binding user decisions and need no confirmation.
R6–R14 are planner rulings confirmed by the supervisor on 2026-09-10** (each is tagged `CONFIRMED 2026-09-10`).
**R19–R23 are binding supervisor rulings issued on review of this spec** — they refine R8/R9/R10/R12
and the `POST /reviews` conflict code, and they win wherever an earlier ruling's prose disagrees.
No open questions and no TBDs remain — every ruling has a decided value so the plan is executable as written.
Parent specs: `2026-08-28-cgremlin-core-rebuild-design.md` (§2 layer split, §9 UI), `2026-09-04-cgremlin-core-phase4-pr-inventory-host-cli-design.md` (inventory + host + API), `2026-09-09-cgremlin-core-phase5-environment-tooling-design.md` (locking, secrets).
Spike grounding: `spikes/vscode-v1/NOTES.md` (VS Code API surface, `claude --resume`, Unix-socket HTTP from the extension host).
Engine grounding: read directly, cited inline as `file:line`.

---

## 0. Why

The engine has been headless since Phase 4 dropped the dashboard (`docs/DECISIONS.md:70-72`):
`cgremlin/core/README.md:219-228` still says "**A UI.** … nothing in this package renders HTML."
Everything the engine knows — four PR groups, five pipeline stages, per-session agent state —
is reachable only by typing `cgremlin-core prs` and reading a table. There is no way to be *told*
that a plan is ready or that an agent asked a question, and no way to take over a conversation the
engine started headlessly.

Phase 7 adds the UI as a VS Code extension, and — this is the point of the phase — adds to the core
every capability the UI needs that the core cannot currently answer. The engine today can say
*what state a session is in*; it cannot say *whether that state wants you*, cannot tell a client
*when* anything changed (`EngineEventMap` is "each in-process only", `src/engine/events.ts:6-13`),
and cannot hand a conversation over to a human without racing its own pipeline.

## 1. Scope

**In — stream A (core, `cgremlin/core`)**

1. **Attention model, generic over item sources** — a per-source pure reason-deriver plus one
   shared pure evaluator producing `{ needsAttention, needsYou, reasons[], since }`, a persisted
   per-item-ref
   acknowledgement, and `GET /attention`, `POST /attention/ack { ref }`, plus the two named aliases
   `POST /sessions/:id/ack` and `POST /prs/:owner/:repo/:number/ack`. **Nothing in the shape is
   session-only** (R18).
2. **Event stream** — `GET /events` as Server-Sent Events over the existing Unix socket, carrying
   every `EngineEventMap` event plus two new ones (`attention.changed`, `artifact.changed`), with a
   bounded in-memory ring buffer and `Last-Event-ID` replay.
3. **Session-directory watch** — a `SessionWatcher` port + `NodeSessionWatcher` (recursive
   `fs.watch`, polling fallback) + a fake, so an artifact or `AGENT_STATE` an *agent* writes
   mid-turn becomes an event.
4. **Human-turn flag** — `session.agent.humanTurn` as an **expiring claim**
   (`{ claimedAt, expiresAt }`, R20), `POST /sessions/:id/conversation/claim` / `release`, a
   `HumanTurnInProgressError` (409) refusal both as an unlocked advisory check and as the
   authoritative check inside every stage's locked pre-run (R19), a reconciliation-tick skip, a
   boot-time claim clear, and `cgremlin-core release <session-id>`.
5. **Resume contract** — `GET /sessions/:id/conversation` → `{ runner, resumeId, worktreePath, claimed }`.
6. **Artifact listing** — `GET /sessions/:id/artifacts` with mtimes **and** the core-computed
   `primary` artifact; one additive `statMtimeMs` method on the filesystem port.
7. **Resolved-config read** — `GET /config` returning the *redacted* resolved `CoreConfig`, so the
   extension never re-implements `resolveCoreConfig`'s `stateDir` derivation.
8. **Direct development session** — `PipelineService.createDevelopmentSession` +
   `POST /sessions/developments`: a development session with its own fresh worktree on
   `feature/<ticket>`, self-rooted lineage, created **without** an investigation and **without**
   starting any run.
9. **Manual review from any PR URL** — `POST /reviews { prUrl }`, which finally reaches the already
   written, already tested, currently **unreachable** `ReviewSessionFactory.createFromPrUrl`
   (`src/pipeline/review-session-factory.ts:42-45`) so a PR in a repo that is not in `config.repos`
   can be reviewed.

**In — stream B (new package `cgremlin/vscode`)**

10. One side panel with four live lists (PR parking lot, PRs we are reviewing, my investigations,
   my dev work), each row carrying an attention indicator.
11. A pop notification when an item enters a needs-you state; clicking it reveals the item.
12. Open item → the item's primary artifact as a rendered markdown preview + the item's worktree
    as the single folder of a **managed multi-root workspace** (R15).
13. A "Chat" action → a VS Code terminal in the worktree running `claude --resume <resumeId>`.
14. Cheap commands: start review from the parking lot, approve plan, stop, retry, ack, refresh
    inventory.
15. Session creation from the UI: **New investigation…**, **New development session…** and
    **New review from PR URL…** (sequential quick-picks / an input box; repo from `config.repos`).
16. Status bar (engine connected / N need you / *which session's repo the workspace currently holds*)
    and the not-running error UX.

**Out (v2 — nothing in v1 may preclude it)**

- Our own chat pane fed by core streaming (`run.output` is already an opt-in `/events` frame).
- Structured findings as cards (`reasons[]` is an open array; `REVIEW.md` stays unparsed).
- A core MCP server for agent tools.
- Inline screenshots (the artifact allow-list is deliberately **not** widened in v1).
- Posting to GitHub (still deferred, `docs/DECISIONS.md:81-85`).
- Legacy session migration (Phase 6).
- More than one repo folder in the managed workspace (pinning / LRU) — see R15.
- **A Jira parking lot** (tickets assigned to me, with no session yet) — deferred to the next phase;
  see §10.
- A formal plan-gate *phase* for development sessions — see R16.
- `@vscode/test-electron` in CI — manual smoke checklist instead (§8).

## 2. Layer split — every v1 capability and where it lives

The binding rule: **core owns state, rules and side effects; the extension owns presentation and
intent. Anything the UI needs that the core cannot answer becomes a core feature, never a UI
workaround.** Applied capability by capability:

| Capability | Layer | Why (one line) |
|---|---|---|
| "Does this item want me, and why" | **core** | It is a rule over engine state (phase, `lastRun`, `AGENT_STATE`, inventory), and the CLI and a future MCP server need the same answer. |
| Acknowledging an item ("I saw it") | **core** | It must survive an extension-host restart and be shared by every frontend; a UI-local `Memento` would silently diverge per window. |
| Which reasons are "needs-you" vs. informational | **core** | The reason vocabulary *is* the rule; a UI that invented its own list would drift from the pipeline. |
| Whether a reason *pops* vs. only badges | **extension** | Interruption policy is presentation, and is a user setting (`cgremlin.notificationLevel`) — but *whether the item needs you at all* is the core's `attention.needsYou`, which the extension only filters (R22). |
| The four list definitions | **core** (data) + **extension** (assembly) | Core already groups the inventory (`groupInventory`, `src/inventory/inventory.ts:129-143`) and lists sessions; composing four rows-with-indicators is pure presentation. |
| "What changed, just now" | **core** | Only the engine sees its own transitions and owns the fs watch; polling from the UI would be both laggy and O(sessions) per tick. |
| Which artifact is an item's *primary* one | **core** | It is a per-mode/per-stage rule ("latest of FINDINGS/PLAN, `REVIEW.md` for reviews"), identical for every frontend. |
| Rendering that artifact | **extension** | VS Code's built-in markdown preview already auto-refreshes on disk change (spike §1). |
| "A human has the conversation now" | **core** | It must *block the engine's own pipeline*; a UI-only flag cannot stop a headless turn. |
| Resume id / runner / worktree for a chat | **core** | Already on the session record (`src/schema/session.ts:43`, `:9-13`); the API just needs to expose the tuple. |
| Spawning the chat terminal | **extension** | The engine "never spawns a terminal" (`docs/ARCHITECTURE.md:23`) — and no VS Code extension API accepts a cwd for a resume (spike §1 Q1), so a terminal with an explicit `cwd` is the only correct mechanism. |
| Starting a review / approving / stopping / retrying | **core** | Existing routes; the extension only sends intent. |
| The managed `.code-workspace` file | **extension** | It is window/workspace state VS Code itself owns; the core has no concept of an editor window. |
| Resolved `stateDir`/`worktreesDir` paths | **core** | `resolveCoreConfig` (`src/config/core-config.ts:91-106`) is the only correct implementation of the derivation; re-implementing it in TypeScript-for-the-UI is exactly the workaround this rule forbids. |
| Reviewing an arbitrary PR URL | **core** | It is a session + worktree + agent turn; the UI contributes only a validated URL, and `parsePrUrl` (`src/gh/pr-url.ts:18-38`) is already the core's parser. |
| Creating a session (investigation or development) | **core** | It creates a worktree, a branch, a permission guard and a record — all side effects the engine owns; the UI only collects the four answers. |
| Which questions to ask when creating one | **extension** | Quick-pick sequencing is presentation; the *validation* is the core's existing ticket regex, fetched, not re-invented. |
| Which worktree the editor window currently holds | **extension** | Workspace-folder membership is window state VS Code owns. |
| "The engine is not running" | **extension** | Connection UX; the core cannot report its own absence. |

## 3. Rulings

**R1 (binding, user).** The VS Code extension is the UI. Two layers only, per §2.

**R2 (binding, user).** v1 scope is exactly §1 items 1–16 (stream A 1–9, stream B 10–16). v2 items are out, but no v1 decision may
preclude them.

**R3 (binding, user).** The extension manages a multi-root `cgremlin.code-workspace` file so that
adding a worktree never triggers the single-folder→multi-root extension-host restart
`workspace.updateWorkspaceFolders` documents (spike §2 citation 2, `@types/vscode` index.d.ts
~13914-13966).

**R4 (binding, user).** Chat is `vscode.window.createTerminal({ cwd }).sendText('claude --resume <id>')`
(spike §2 citation 4 + CONCLUSION (c)) — never the Claude Code extension's undocumented
`claude-vscode.*` commands or its URI handler, neither of which takes a cwd.

**R5 (binding, engine).** The locking invariant (`src/pipeline/pipeline-service.ts:1-14`) and the
"no automatic review start" rule (`docs/ARCHITECTURE.md:186-191`) are untouched. Nothing in Phase 7
starts an agent that was not explicitly asked for.

**R6 `CONFIRMED 2026-09-10` — `AGENT_STATE` is authoritative even while a run is live.**
Legacy resolved attention with "`working` (activity) always wins → 🔄, regardless of `.cg_attention`"
(`docs/superpowers/plans/2026-07-09-status-panel-attention-work-sessions.md:17`), because legacy had
*two* files: a hook-written `.cg_agent_state` and an agent-written `.cg_attention`. Core has **one**
file: `StageRunner` writes `AGENT_STATE=working` at run start
(`src/pipeline/stage-runner.ts:91`) and the agent overwrites it only deliberately at a gate
(`src/pipeline/prompts.ts:47`, `:291`, `:312`, `:332`, `:354`, `:358`). So in core a mid-run
`needs-input` is a deliberate agent statement, not stale activity, and suppressing it would delay
the single most valuable notification in the product until the turn ends. Ruling: `needs_input` and
`blocked` are raised from `AGENT_STATE` regardless of liveness; a live run is reported separately as
`running: true` on the attention item so the UI can show both.

**R7 `CONFIRMED 2026-09-10` — `artifact.changed` and `AGENT_STATE`-driven `attention.changed` come
from the fs watch only; everything session-record-derived recomputes on existing engine events.**
The alternative (emit on the engine's own writes *and* watch) double-emits for every engine write,
because the watch covers the same `sessionsDir` those writes land in. The watch is not optional:
the founding "artifact-driven completion, not agent callbacks" rule (`docs/DECISIONS.md:33-38`)
means the agent writes `FINDINGS.md`/`PLAN.md`/`AGENT_STATE` directly, inside its turn, with no
engine involvement — without a watch, an agent asking a question would be invisible until the turn
exits. Verified on this machine (Node v24.18.0, darwin 25.6.0):
`fs.watch(dir, { recursive: true })` fires `["rename","s1/AGENT_STATE"]` for a nested write, i.e.
relative `<sessionId>/<name>` paths. Non-recursive-capable platforms fall back to a 2000 ms mtime
scan of `sessionsDir/*/`.

**R8 `CONFIRMED 2026-09-10` — `run.output` is excluded from `/events` unless explicitly requested,
and is always redacted.** One agent turn emits hundreds of `run.output` chunks
(`src/pipeline/stage-runner.ts:118`) and they can carry a bypass URL — which is why `serve` only
logs them under `--verbose` and through `redactBypassUrls` (`src/host/serve.ts:90-101`). `/events`
sends them only for `GET /events?include=run.output`, always through `redactBypassUrls`. This is the
v2 chat-pane hook.

**R9 `CONFIRMED 2026-09-10` — claiming a conversation is refused while a run is in flight.** Two
`claude --resume <same id>` processes on one transcript is unrecoverable corruption. `claim` returns
409 `RunInProgressError` when `pipeline.activeSessionIds()` contains the id
(`src/pipeline/pipeline-service.ts:665-667`); the user must `stop` first. The converse (the pipeline
refusing while claimed) is **authoritatively** checked on the fresh load inside each stage's locked
pre-run: a pre-lock check alone would be a TOCTOU hole of exactly the kind the invariant comment was
written to close. R19 additionally puts an **advisory, non-authoritative** copy of the same check
before the lock, purely so a refusal costs no environment setup and no git work; the locked check is
what makes the refusal correct, and removing it is a bug even if the advisory one stays.

**R10 `CONFIRMED 2026-09-10` — acknowledgement lives in its own store, not on the session record.**
`<stateDir>/attention-acks.json`, keyed `session:<id>` / `pr:<owner>/<repo>#<n>`. Reasons: an ack
must exist for inventory items that have no session at all; the session schema is versioned and
migration-bearing (`src/schema/session.ts:80-105`) and an ack is not pipeline state; and an ack
write must not contend with the per-session lock that guards `session.json`. The ack stores the
canonical **signature** defined once in §4.1 — `reasons.join(',') + '|' + since`, with `reasons`
already in `ATTENTION_REASONS` order, so no sort is involved anywhere — which is what makes a *new*
reason or a *newer* `since` re-raise attention automatically.

**R11 `CONFIRMED 2026-09-10` — the primary artifact is chosen by the core, not the UI.** `GET
/sessions/:id/artifacts` returns `primary`. Rule (pure, `pickPrimaryArtifact`): review mode →
`REVIEW.md` if present else `RE-REVIEW.md` else `BRIEF.md`; investigation/development → the
most-recently-modified of `PLAN.md`, `FINDINGS.md`, `DEVELOPMENT.md`, falling back to `BRIEF.md`;
`null` when the session directory holds none of them.

**R12 `CONFIRMED 2026-09-10` — `claimed` is exposed on the attention item and on
`GET /sessions/:id/conversation`, and the inventory schema is NOT changed.** Adding a field to
`OursStatus` (`src/inventory/inventory.ts:14-22`) would change `InventorySchema`
(`:152-185`), the scanner, and every persisted `inventory.json`. The UI already fetches
`/attention?all=1` for its indicators, so it gets `claimed` there for free.

**R13 `CONFIRMED 2026-09-10` — the extension builds with `tsc`, not esbuild, and has no runtime
dependencies.** With zero runtime deps there is nothing to bundle; `out/*.js` loads directly in the
extension host (spike compiled clean with `npx tsc -p .`). This also lets vitest import the same
sources with no build step. `@types/vscode` + `@types/node` + `typescript` + `vitest` are the only
devDependencies.

**R14 `CONFIRMED 2026-09-10` — pure modules in the extension must not import `vscode`.** The
request/mapping/policy layer (`core-client`, `sse`, `view-model`, `notify-policy`,
`workspace-file`, `items`) is `vscode`-free and unit-tested; only `extension.ts` and `src/ui/*`
touch the API. Enforced by a source-grep guard (MG-B1), because this is the only thing that keeps
the extension testable without `@vscode/test-electron`.

**R15 (binding, user) — ONE worktree folder at a time.** The managed `cgremlin.code-workspace`
contains exactly **one** repo folder: the worktree of the most recently opened session. Opening a
different session **swaps** it — the old folder is removed (VS Code closes that folder's editors as
a consequence) and the new one added, in a single `updateWorkspaceFolders(0, 1, {uri})` call. No
pinning and no LRU in v1; the status bar therefore always names the session whose repo you are
looking at, because that is now load-bearing information rather than decoration. Pinning/LRU is a
v2 hook, to be added only if usage shows a need.

**R16 (binding, user) — a development session can be created directly, and the develop stage's
PLAN GATE is preserved.** `createDevelopmentSession({ repoUrl, ticket, baseRef? })` creates a
development session at `active` with a fresh worktree on `feature/<ticket>` (legacy naming,
`bin/cgremlin:14293`, `:14504`) and self-rooted lineage. `runDevelop` then renders the *existing*
`hasPlan: false` develop brief (`src/pipeline/prompts.ts:326-330`): the agent refines the ticket
into `DEVELOPMENT.md`, writes `AGENT_STATE=needs-input` and **stops at the PLAN GATE**. That gate is
deliberately not removed.

*How the human approves that plan in v1:* through **Chat** (§5.6) — they claim the conversation and
tell the agent to proceed. There is deliberately **no** new phase: the development transition table
is `active → pr_opened → superseded → merged` (`docs/ARCHITECTURE.md:41-44`) with no `plan_ready`, and
re-issuing `POST /sessions/:id/run {stage:'develop'}` would re-render the same brief and hit the same
gate, so a headless "proceed" is not expressible today. Whether development sessions should gain a
formal plan-gate phase (and an `approve-plan` equivalent) is recorded as a **v2 hook**, not smuggled
in here.

**R17 (binding, user) — a review can be started from any PR URL, including a repo the scan does not
watch.** `POST /reviews { prUrl }`. Grounding, checked: `createFromPrUrl` exists, is unit-tested
(`test/pipeline/review-session-factory.test.ts:55-84`) and is called from **nowhere** in `src/` —
the CLI's `review <url>` parses the URL only to address
`POST /prs/:owner/:repo/:number/review` (`src/cli/commands/review.ts:16`), which 404s when the PR is
not in the current inventory (`src/api/server.ts:106-110`). So today an off-config PR simply cannot
be reviewed, and the fix is a route, not new machinery.

*Reconciliation already covers these sessions, unchanged.* `ReconciliationTick.run()` iterates
**sessions from the store** and fetches each one's own PR with
`gh pr view <number> --repo <pr.repo>` (`src/discovery/reconciliation.ts:148-175`) — it never
consults `config.repos`. So an off-config review session is merged/closed/approved/re-reviewed on
exactly the same schedule as any other. **No core change is needed for freshness.** The one real
consequence is on the UI side: `InventoryScanner` *does* iterate `config.repos`, so an off-config PR
has no `InventoryEntry` and therefore no `groups.ours` row — which is why the panel's "PRs we are
reviewing" list is built from **sessions**, with the inventory entry as optional enrichment (§5.2),
not from `groups.ours` alone.

**R18 (binding, user) — every item is a generic `Item` with a `source`, and both the core attention
model and the panel's view model are defined over it.** The user's roadmap adds at least two more
sources (Jira tickets + ticket comments; a Slack mentions inbox with an agent-produced briefing and a
human-sent draft reply — §10). Therefore v1 ships the *shape*, not just the two sources it needs:

```ts
export const ITEM_SOURCES = ['pr', 'session'] as const;              // future: 'jira', 'slack'
export type ItemSource = (typeof ITEM_SOURCES)[number];
/** Canonical, parseable, stable across restarts: 'session:<id>' | 'pr:<owner>/<repo>#<n>'
 *  (future 'jira:<KEY>' | 'slack:<channel>/<ts>'). This is also the ack key. */
export type ItemRef = string;
export interface Item {
  source: ItemSource;
  ref: ItemRef;
  id: string;                    // the source-local id: session id, 'owner/name#12', a ticket key…
  title: string;
  repoOrContext: string;         // 'owner/name' for pr/session; a project key or channel later
  attention: AttentionState;
  links: ItemLinks;              // every optional affordance, all nullable — see §4.2
}
```

Consequences that are binding on v1 code, not just on v1 prose:

- The evaluator is split: a **per-source, pure `derive*Reasons`** function, and **one shared, pure
  `evaluateAttention({ reasons, since, ack })`** that owns ordering, the signature and the ack
  comparison. A new source adds a `derive*Reasons` and touches nothing else.
- `AttentionService` composes **`SourceAdapter`s**, one per source; adding Jira/Slack is adding an
  adapter to an array.
- Acknowledgement is keyed by `ItemRef`, and the primary route is the source-agnostic
  `POST /attention/ack { ref }`. The two named routes the user asked for remain, as thin aliases
  that format the ref and delegate — so no client is forced to learn the ref grammar, and no future
  source needs a new bespoke ack route.
- `ATTENTION_REASONS` is an ordered `as const` array and `ItemLinks` is all-nullable, so both extend
  additively without a schema break.
- The panel's list model is the descriptor array of §5.2, whose `build` takes `Item[]`.

**Not implemented in v1:** Jira, Slack, and any reason or link belonging to them.

**R19 (binding, supervisor) — the human-turn refusal is checked twice: advisory before the lock,
authoritative inside it.** R9's locked check is necessary but not sufficient in practice: by the time
`runStageLocked`'s `preRun` runs, `runFindings`/`runDevelop`/`runReview`/`runRereview` have already
called `prepareEnvironment` (`src/pipeline/pipeline-service.ts:292`, `:428`, `:458`, `:585`) — which
can start the local app — and `runRereview` has already run `git fetch` + `git reset --hard` in the
worktree (`:541-546`). Refusing a claimed session only after that has happened means the refusal
mutates the very worktree the human is talking to the agent about. Ruling:

- Each of the five `run*` methods gets an **unlocked advisory check** as the **first statement after
  the existing mode check** — `runFindings` after `:288-290`, `runPlan` after `:328-330`,
  `runDevelop` after `:423-425`, `runReview` after `:453-455`, `runRereview` after `:529-531` (i.e.
  before its `pr`/worktree reads *and* before the git work at `:540-546`) — and therefore before
  every `prepareEnvironment` call. It re-uses the snapshot the mode check just read — no second
  `store.load`, no lock (`session` is that snapshot; the ruling's `fresh` is this same value):
  ```ts
  if (isClaimed(session, this.now())) throw new HumanTurnInProgressError(id);
  ```
  It uses the **same `isClaimed` predicate** as the locked check, so an expired claim is treated as
  absent at *both* sites and there is exactly one definition of "claimed" in the codebase (R20). What
  it does **not** do is *reap* the expired record: that is a write, it belongs under the lock, and
  doing it here would be precisely the unsynchronised write the invariant comment forbids. So the
  advisory check reads, the locked check reads **and** reaps.
- Each of the five **keeps** the authoritative `assertNoHumanTurn(fresh)` as the first statement
  after the fresh load inside its locked `preRun` (§4.5). The advisory check is a fast path, never a
  replacement: it takes no lock, so it can be stale, and MG-A9 still pins the locked one.
- MG-A6 is extended accordingly: with a claim in place, each stage's rejection must also leave
  `FakeGitRunner` with **zero** `fetch`/`reset` calls recorded and `EnvironmentService.start` **never
  called** — which is the only assertion that can tell the advisory check from its absence.

**R20 (binding, supervisor) — a claim expires, and every path that could orphan one clears it.**
A `humanTurn` boolean set by an extension that then crashes, or by a terminal on a machine that
reboots, wedges the session's pipeline forever with no way back short of hand-editing
`session.json`. Ruling — the claim becomes a TTL'd record and gains four recovery paths:

- **Shape.** `session.agent.humanTurn: { claimedAt: string; expiresAt: string } | null` (ISO), default
  `null`. `claimConversation` writes `claimedAt = now`, `expiresAt = now + humanTurnTtlMs`.
- **TTL.** `CoreConfig.humanTurnTtlMs`, default **10 minutes** (`z.number().int().positive().default(600_000)`).
- **Heartbeat.** The extension re-claims every `humanTurnTtlMs / 3` while the chat terminal is open
  (§5.6), so a live conversation never expires; `claim` on an already-claimed session is idempotent
  and simply pushes `expiresAt` forward.
- **Expiry is absence.** `assertNoHumanTurn(fresh)` treats a claim whose `expiresAt <= now` as no
  claim at all, and — because it already runs inside the per-session lock, on a fresh load, on the
  write path — **clears it** (`agent.humanTurn = null`) before proceeding. Expiry is therefore never
  merely ignored: the record is reaped by the first stage that trips over it. The same rule governs
  `AttentionItem.claimed` and `GET /sessions/:id/conversation`'s `claimed`, which are both
  "`humanTurn !== null` **and** not expired" (this supersedes R12's `humanTurn === true` wording).
- **Boot clears everything.** `serve()` clears `agent.humanTurn` on every session in the store before
  it starts listening (no extension can hold a claim across an engine restart it did not survive),
  and logs one `conversation.claims_cleared` line with the count and the ids.
- **A terminal phase clears the claim.** `transition` to a phase in `TERMINAL_PHASES_BY_MODE`
  (`src/workspace/workspace-in-use.ts`) sets `agent.humanTurn = null` in the same locked write — a
  merged/abandoned session has no conversation left to protect, and its worktree may be reclaimed.
- **Manual release.** `cgremlin-core release <session-id>` → `POST /sessions/:id/conversation/release`
  (the route the extension already uses), and `cgremlin-core sessions` gains a `claimed` column so a
  stuck claim is visible without reading JSON.
- **Reconciliation.** A claimed review session is **skipped**, not errored: `planReconciliation`
  pushes a `SkippedTransition` instead of the `rereview` action (§4.5), so the tick's `catch`
  (`src/discovery/reconciliation.ts:205-207`, `:210-212`) never files a `report.errors` entry for a
  claim. Merge/close transitions still apply on schedule and clear the claim as above — a claim
  delays a *re-review*, never the truth about the PR.

**R21 (binding, supervisor) — `/events` fan-out is explicit, ordered, bounded and back-pressured.**
§4.3 described the ring and the replay but left the live half ("then keep writing") implicit, and an
SSE endpoint whose live path is implicit is exactly where duplicate ids, dropped events and a leaked
15 s timer live. Ruling:

- `EventRing` gains `subscribe(cb: (entry: RingEntry) => void): () => void` and the matching
  `unsubscribe`; `push` notifies subscribers **after** appending, so a subscriber always sees the id
  it will later be asked to replay.
- `handleEventStream` hands over from replay to live under a **ring snapshot**: read
  `since(lastEventId)`, write those frames, remember `lastSent = <the last id written>`, and only
  then `subscribe`, with the subscriber filtering `entry.id <= lastSent`. There is no window in which
  an event is written twice or out of order, and no window in which one is lost.
- `since(n)` where `n` is **greater** than the ring's current max id (a client replaying against a
  restarted engine that reused the id space) returns `complete: false` — the client must refetch
  `/prs`, `/sessions`, `/attention` rather than wait for ids that will never come. The same
  `event: resync` frame carries it.
- The connection subscribes **per connection** via `events.on` for every `EngineEventMap` key, and
  unsubscribes every one of them in `req.on('close')` — together with the heartbeat timer, which
  must be `clearInterval`ed there (a `setInterval` that outlives its response is the classic SSE
  leak, and `unref()` does not fix it).
- Every write is guarded by `if (res.destroyed) return;` — including the heartbeat's.
- **Backpressure.** When `res.write` returns `false` the connection is marked *lagging*; while
  lagging, `run.output` frames are **dropped** (they are opt-in, high-volume and reconstructible from
  the ring), every other frame is still queued, and if the pending frame count passes a bounded
  ceiling (256 frames) the connection is `res.destroy()`ed — a stalled reader must never grow the
  engine's heap. `'drain'` clears the lagging flag.
- `run.output` stays opt-in via `?include=run.output` and is redacted on `chunk.data` with
  `redactBypassUrls` — the identical call `serve()` makes at `src/host/serve.ts:98`.
- **The stream is global.** There is no `?session=` filter: clients subscribe *before* the sessions
  they care about exist (a fresh extension window has no session id to filter by, and
  `POST /sessions/developments` must be observable on the connection that predates it), so
  per-session filtering is **client-side**, on `ItemRef`/`sessionId`. Adding a server-side filter
  later is additive; shipping one now would break the create-then-observe flow §5.7 depends on.
- Guard tests: frame **ordering** (no duplicate and no out-of-order id across the replay→live
  handover, asserted over a burst emitted *during* the handover), the `since(n > max)` rule, and the
  `run.output`-drop-while-lagging policy.

**R22 (binding, supervisor) — the core says whether an item needs *you*; the extension only decides
whether that pops.** §2 already rules that "which reasons are needs-you" is core's, but §4.1 put
`NEEDS_YOU_REASONS` in core *and* §5.4 had the extension re-derive the same predicate from the reason
array — two copies of one rule, which is the drift §2 forbids. Ruling:

- `AttentionState` gains `needsYou: boolean`, computed by the core as "at least one reason is in
  `NEEDS_YOU_REASONS`, and the item is not acked". It is the single source of truth.
- The extension's notify policy filters on `item.attention.needsYou` and on the user's
  `notificationLevel` — nothing else. It carries **no** copy of `NEEDS_YOU_REASONS`; that constant is
  deleted from the extension entirely (the alternative — keeping a mirror pinned against `/attention`
  in C1 — was rejected: there is nothing the mirror buys, since every item already arrives with the
  answer).
- **Engine-died is a failure, not a silence.** `lastRun.outcome === 'running'` with `running: false`
  means the host died mid-run: the on-disk record says a run is live and `activeSessionIds()` says
  nothing is. That derives `run_failed`, with `since = lastRun.startedAt` (the only timestamp such a
  record has — `finishedAt` is null by construction). Without this rule the single most alarming
  state in the system is the one state that shows no indicator at all.
- `SessionSourceAdapter.localStatus` attributes the global local app **only to its owner**: the
  `local_prereq_failed` reason is derived for session `id` only when `status.sessionId === id`. This
  is the same W8 ownership rule the API already applies at `src/api/server.ts:305-318`; without it a
  single degraded app raises `local_prereq_failed` on every session in the panel.

**R23 (binding, supervisor) — `POST /reviews` on an already-tracked PR answers 200, exactly like the
inventory route.** The draft §4.8 answered 409 there, reasoning that "create a review" cannot be
satisfied. But the extension's own handling of that 409 was "offer *Open it* and open the existing
session" — i.e. the caller's intent *was* satisfied, and the only difference from
`POST /prs/:owner/:repo/:number/review`'s 200 (`src/api/server.ts:149`) was the status code two
routes with one meaning would disagree on. Ruling: `POST /reviews` on a PR that already has a
non-terminal review session returns **200** `{ session, created: false, started: false }`; a PR
authored by `config.me` still returns **409** (that request genuinely cannot be satisfied, and it is
the one case where a body carrying a session would be wrong). The extension therefore treats a 200
with `created: false` as "reveal the existing item", and 409 as an error to show verbatim.

---

## 4. Core API additions — exact shapes

Every route is on the existing Unix socket (`config.socketPath`, mode 0600,
`src/api/listen.ts:39`), added as a branch in `handleRequest` per the documented "Add a route"
recipe (`docs/ARCHITECTURE.md:371-375`).

### 4.1 Attention — `src/attention/attention.ts` (pure)

```ts
export const ATTENTION_REASONS = [
  'plan_ready',            // investigation is at plan_ready — a human must approve
  'needs_input',           // AGENT_STATE === 'needs-input'
  'blocked',               // AGENT_STATE === 'blocked'
  'run_failed',            // lastRun.outcome === 'failed', OR 'running' with nothing running (engine died, R22)
  'review_ready',          // review session at 'ready' — REVIEW.md is waiting to be read
  'rereview_ready',        // review session at 'ready' with a lastRereviewSummary
  'local_prereq_failed',   // this session's local app degraded to 'unavailable'
  'changes_requested',     // my own PR has CHANGES_REQUESTED or fresh team activity
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** The subset that interrupts. Everything else is badge-only. Lives HERE and nowhere else —
 *  the extension consumes `AttentionState.needsYou` and carries no copy of this list (R22). */
export const NEEDS_YOU_REASONS: readonly AttentionReason[] =
  ['plan_ready', 'needs_input', 'blocked', 'run_failed', 'review_ready', 'rereview_ready', 'changes_requested'];

export interface AttentionState {
  needsAttention: boolean;
  /** R22: at least one reason is in NEEDS_YOU_REASONS and the item is not acked. The core's answer
   *  to "does this want ME", so no client re-derives it. Always false when needsAttention is false. */
  needsYou: boolean;
  reasons: AttentionReason[];                    // canonical order: ATTENTION_REASONS order
  since: string;                                 // ISO
  /** THE canonical signature, defined once: `reasons.join(',') + '|' + since`, with `reasons`
   *  already in ATTENTION_REASONS order. No sort, anywhere. This is also what an ack stores (R10). */
  signature: string;
  acked: boolean;
}

/** A reason plus the timestamp that justifies it — what every per-source deriver returns. */
export interface DerivedReason { reason: AttentionReason; at: string | null }

/** THE shared, source-agnostic evaluator (R18): ordering, signature, ack. Pure; no clock. */
export function evaluateAttention(input: {
  derived: readonly DerivedReason[];
  fallbackSince: string;                         // e.g. session.createdAt / entry.seenAt
  ack: { signature: string; ackedAt: string } | null;
}): AttentionState;

// ---- per-source derivers: pure, one per ItemSource ----
export interface SessionEvidence {
  session: Session;
  agentState: 'working' | 'ready' | 'needs-input' | 'blocked' | null;
  agentStateMtime: string | null;                // ISO; null when AGENT_STATE is absent
  running: boolean;                              // from PipelineService.activeSessionIds()
  /** ONLY this session's own local app: the adapter passes null unless the global app's
   *  `status.sessionId === session.id` — the same W8 ownership rule as `src/api/server.ts:305-318`
   *  (R22), without which one degraded app raises `local_prereq_failed` on every session. */
  localApp: { state: 'running' | 'stopped' | 'unavailable'; reason: string | null } | null;
}
export function deriveSessionReasons(ev: SessionEvidence): DerivedReason[];
export function derivePrReasons(entry: InventoryEntry): DerivedReason[];
// future: deriveJiraReasons, deriveSlackReasons — added without touching evaluateAttention
```

`evaluateAttention` orders `derived` into `ATTENTION_REASONS` order, dedupes, sets
`since = max(at) ?? fallbackSince`, computes the signature, applies the ack, and sets `needsYou`.

`since` derivation (deterministic, in this precedence): `agentStateMtime` for
`needs_input`/`blocked`; `session.lastRun.finishedAt` for `run_failed`/`plan_ready`/`review_ready`/
`rereview_ready`, except the engine-died `run_failed` of R22, whose `since` is
`lastRun.startedAt` (a `'running'` record has no `finishedAt`); `entry.updatedAt` for
`changes_requested`; and the **max** of the contributing values when several reasons fire. Falls back
to `session.createdAt`, then `entry.seenAt`. A `needsAttention` computation with an `ack` whose
`signature` equals the computed signature yields `needsAttention: false, needsYou: false,
acked: true`.

`changes_requested` is the one inventory-only reason: `entry.isMine === true` **and**
(`entry.reviewDecision === 'CHANGES_REQUESTED'` or `entry.teamActivity.length > 0`). It exists so
"my dev work" surfaces my own PRs that people are waiting on me about, and so
`POST /prs/…/ack` has a purpose. No parking-lot entry ever needs attention — that would fight
R5's "nothing auto-reviews".

### 4.2 Attention service and store

```ts
// src/attention/item-ref.ts — the one place the ref grammar lives (R18)
export const ITEM_SOURCES = ['pr', 'session'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];
export type ItemRef = string;
export function sessionRef(id: string): ItemRef;                   // 'session:<id>'
/** THE one PR-ref formatter. There is no second `prAckKey` — the ack key IS the ItemRef. */
export function prRef(repo: string, number: number): ItemRef;      // 'pr:owner/name#12'
export function parseItemRef(ref: string):
  | { source: 'session'; id: string }
  | { source: 'pr'; repo: string; number: number };                // throws ValidationError otherwise
// `parseItemRef` splits on the FIRST ':' and treats the remainder as opaque. That is unambiguous
// because no member of ITEM_SOURCES contains ':', NOT because a session id cannot: checked,
// `assertSafeSessionId` (`src/engine/session-store.ts:26-30`) rejects only '', '/', '\\', '.' and
// '..', so a ':' in a session id is legal and must round-trip. (Session ids sharing one KeyedLock
// keyspace with `local-app:<port>` is pre-existing and documented at `docs/ARCHITECTURE.md:155`;
// Phase 7 neither relies on it nor changes it.)

// src/attention/ack-store.ts
export class AckStore {
  constructor(fs: SessionFileSystem, path: string);                // <stateDir>/attention-acks.json
  load(): Promise<Record<ItemRef, { signature: string; ackedAt: string }>>;
  put(ref: ItemRef, entry: { signature: string; ackedAt: string }): Promise<void>;  // tmp+rename
  prune(liveRefs: readonly ItemRef[]): Promise<void>;              // drops acks for vanished items
}

// src/attention/attention-service.ts
/** Every optional affordance an item may offer. ALL fields nullable, so a new source fills in
 *  what it has and a client feature-detects rather than switching on `source` (R18). */
export interface ItemLinks {
  sessionId: string | null;
  worktreePath: string | null;
  prRepo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  ticket: string | null;         // session.lineage.ticket — the Jira join key (§10)
  /** Populated by SessionSourceAdapter via `pickPrimaryArtifact` (R11), so a row can be opened
   *  from `/attention` alone; null for a source with no artifacts. The extension still calls
   *  `GET /sessions/:id/artifacts` on open, for the mtimes and the freshest answer.
   *  Sequencing: A1 defines the field and leaves it null (it has no `pickPrimaryArtifact` yet);
   *  A2, which introduces `pickPrimaryArtifact` + `statMtimeMs`, is what wires the adapter to
   *  fill it — a two-line change in a file A1 created, landing at the A2→A5 merge. */
  primaryArtifact: string | null;
}

export interface AttentionItem extends Item {
  mode: SessionMode | null;      // null for a non-session source
  stageStatus: string | null;
  running: boolean;
  claimed: boolean;              // humanTurn !== null AND not expired (R12 as amended by R20)
}

/** One per ItemSource. Adding Jira/Slack = adding an adapter to AttentionService's array. */
export interface SourceAdapter {
  readonly source: ItemSource;
  collect(): Promise<Array<{
    ref: ItemRef; id: string; title: string; repoOrContext: string;
    derived: DerivedReason[]; fallbackSince: string;
    mode: SessionMode | null; stageStatus: string | null; running: boolean; claimed: boolean;
    links: ItemLinks;
  }>>;
  /** Recompute exactly one item, for a targeted refresh. `null` when it no longer exists. */
  collectOne(ref: ItemRef): Promise<Awaited<ReturnType<SourceAdapter['collect']>>[number] | null>;
}
export class SessionSourceAdapter implements SourceAdapter { readonly source = 'session'; /* … */ }
export class PrSourceAdapter implements SourceAdapter { readonly source = 'pr'; /* … */ }

/** The one refresh scope shape (§4.2, §4.4, §7). A scope names WHAT changed, not which adapter:
 *  the service maps a scope to the adapters that can answer it. */
export type RefreshScope =
  | { kind: 'all' }
  | { kind: 'session'; id: string }
  | { kind: 'pr'; repo: string; number: number };

export class AttentionService {
  constructor(deps: { adapters: readonly SourceAdapter[]; acks: AckStore; events: EngineEvents; now?: () => Date });
  list(opts?: { all?: boolean }): Promise<{ evaluatedAt: string; items: AttentionItem[] }>;
  ack(ref: ItemRef): Promise<AttentionItem>;                       // the ONE ack path; 404 when the ref names nothing
  /** Recompute a scope and emit `attention.changed` on a real delta. THE one `refresh` signature —
   *  used verbatim by the watcher wiring, the event subscriptions and every test. */
  refresh(scope: RefreshScope): Promise<void>;
  start(): void;   // subscribes to engine events + the SessionWatcher
  stop(): void;
}
```

`SessionSourceAdapter` owns the session-shaped I/O (`SessionStore`, `AGENT_STATE`,
`activeSessionIds`, the local-app status) and calls `deriveSessionReasons`; `PrSourceAdapter` owns
the inventory load and calls `derivePrReasons`. An item present in **both** sources (a review session
whose PR is also an inventory row) is emitted once, as `source: 'session'`, with the PR's fields
merged into `links` — deduped by `links.prRepo`/`links.prNumber` in `AttentionService`, not inside an
adapter.

`AttentionService.refresh` reads `session.json` **without taking any session lock**: `SessionStore.save`
is tmp-then-rename (`src/engine/session-store.ts:60-62`), so an unlocked read can never see a torn
document, and taking the lock here would let a UI refresh block a 40-minute stage. It coalesces
bursts on a 250 ms debounce and, for a `{ kind: 'session' }` scope, recomputes only that session;
`{ kind: 'all' }` happens only on `inventory.updated`.

**Routes**

| Method | Path | Body / query | Response | Codes |
|---|---|---|---|---|
| GET | `/attention` | `?all=1` for every evaluated item; `?source=session\|pr` to filter | `{ evaluatedAt, items: AttentionItem[] }` — default: only `needsAttention` | 200 |
| POST | `/attention/ack` | `{ ref }` | `{ item: AttentionItem }` | 200, 400 unparseable ref, 404 the ref names nothing |
| POST | `/sessions/:id/ack` | — | alias for `{ ref: sessionRef(id) }` | 200, 404 |
| POST | `/prs/:owner/:repo/:number/ack` | — | alias for `{ ref: prRef(slug, n) }` | 200, 404, 404 `NoScanYetError` |

### 4.3 Event stream — `GET /events` (SSE)

```ts
// src/engine/events.ts — EngineEventMap gains:
'attention.changed': { item: AttentionItem };
'artifact.changed': { sessionId: string; name: string; mtime: string };
```

```ts
// src/api/event-stream.ts
export const EVENT_RING_CAPACITY = 256;
/** How many frames one lagging connection may have pending before it is destroyed (R21). */
export const MAX_PENDING_FRAMES = 256;
export interface RingEntry { id: number; type: keyof EngineEventMap; data: unknown }
export class EventRing {
  constructor(capacity?: number);
  push(type: keyof EngineEventMap, data: unknown): RingEntry;
  since(lastEventId: number): { entries: RingEntry[]; complete: boolean };  // complete=false ⇒ resync
  /** R21: live fan-out. `push` appends FIRST, then notifies, so a subscriber never sees an id the
   *  ring cannot replay. Returns its own unsubscribe; `unsubscribe(cb)` is the explicit form. */
  subscribe(cb: (entry: RingEntry) => void): () => void;
  unsubscribe(cb: (entry: RingEntry) => void): void;
  get epoch(): string;      // `${process start ISO}-${random}` — changes on every engine restart
  get lastEventId(): number;
}
export function serializeFrame(entry: RingEntry): string;   // `id: N\nevent: T\ndata: {…}\n\n`
export function handleEventStream(req, res, deps): void;     // the route handler
```

**The stream is global (R21).** `GET /events` carries every event for every session; there is no
`?session=` filter, because a client subscribes *before* the sessions it cares about exist — a fresh
extension window has no id to filter by, and `POST /sessions/developments` must be observable on the
connection that predates it. **Per-session filtering is client-side**, on `sessionId`/`ItemRef`.
A server-side filter is a purely additive v2 change.

Wire behaviour, all verified on this machine against a Node HTTP server on a Unix socket:

- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`; first frame is `retry: 2000\n\n` then
  `event: hello\ndata: {"epoch":"…","lastEventId":N}\n\n`.
- `Last-Event-ID` arrives as a plain request header (verified: `"7"`), and `?lastEventId=N` is
  accepted as a fallback for clients that cannot set headers.
- **Replay, then live, with no gap and no duplicate (R21).** `handleEventStream` reads
  `since(lastEventId)` as a **ring snapshot**, writes those frames, records
  `lastSent = <last id written>`, and *only then* calls `ring.subscribe`, whose callback discards any
  `entry.id <= lastSent`. An event pushed during the handover is therefore delivered exactly once,
  in id order, by whichever half owns it.
- **Resync, in three cases.** `since(n)` reports `complete: false` when `n` is older than the ring's
  oldest id **or** when `n` is *greater* than the ring's current max (a client replaying against a
  restarted engine); a `?epoch=` that differs from the current one is the third. All three emit
  `event: resync\ndata: {"epoch":"…"}\n\n`, and the client must refetch `/prs`, `/sessions`,
  `/attention` — it may not wait for ids that will never arrive.
- **Per-connection subscriptions.** The connection registers `events.on` for **every**
  `EngineEventMap` key (that is what feeds the ring's own push and this connection's writer) and
  unsubscribes every one of them in `req.on('close')`.
- Heartbeat comment `: ping\n\n` every 15 s, on a timer that is **`clearInterval`ed in the same
  `close` handler** — an interval outliving its response is the classic SSE leak, and `unref()` does
  not fix it.
- **Every write is guarded by `if (res.destroyed) return;`** — the replay's, the live writer's and
  the heartbeat's.
- **Backpressure.** When `res.write` returns `false` the connection is marked *lagging* (cleared on
  `'drain'`). While lagging, `run.output` frames are **dropped** — they are opt-in, high-volume and
  replayable from the ring — while every other frame is still queued. If the pending frame count
  passes `MAX_PENDING_FRAMES`, the connection is `res.destroy()`ed: a stalled reader must never grow
  the engine's heap.
- `run.output` only with `?include=run.output`, and always redacted on `chunk.data` by
  `redactBypassUrls` — the identical call `serve()` makes at `src/host/serve.ts:98` (R8).
- Cleanup on `req.on('close')` (subscriptions + heartbeat + lagging state);
  `serve()`'s `server.closeAllConnections()` before `server.close()`
  (`src/host/serve.ts:196-197`) already makes shutdown prompt with an open stream — verified: an
  open SSE connection did not hang `close()`.

### 4.4 Session watch — `src/fs/session-watcher.ts`

```ts
export interface SessionWatchEvent { sessionId: string; name: string }
export interface SessionWatcher {
  start(onChange: (e: SessionWatchEvent) => void): void;
  stop(): void;
}
export class NodeSessionWatcher implements SessionWatcher {
  constructor(sessionsDir: string, opts?: { pollIntervalMs?: number });
}
```

`NodeSessionWatcher` tries `fs.watch(sessionsDir, { recursive: true })` and maps a relative
`"<sessionId>/<name>"` path to an event, **discarding** anything that is not exactly two segments
(verified: the watcher also reports the directory's own basename as a bare one-segment `change`) and
anything whose `name` is not in the artifact allow-list plus `AGENT_STATE`/`AGENT_NOTE`. On
`ENOSYS`/`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` it falls back to a `pollIntervalMs` (default 2000)
mtime scan. It never reads file *contents* — the consumer does.

### 4.5 Human turn and the resume contract

```ts
// src/schema/stage.ts
export const HumanTurnSchema = z.object({           // R20: a claim, not a flag — it expires
  claimedAt: z.string().min(1),                     // ISO
  expiresAt: z.string().min(1),                     // ISO = claimedAt + config.humanTurnTtlMs
});
export const AgentSchema = z.object({
  runner: z.enum(['claude-code', 'codex']),
  resumeId: z.string().min(1).nullable(),
  humanTurn: HumanTurnSchema.nullable().default(null),  // additive + defaulted: every session.json on disk keeps loading
});

// src/config/core-config.ts
humanTurnTtlMs: z.number().int().positive().default(600_000),   // 10 minutes (R20)

// src/pipeline/pipeline-service.ts
export class HumanTurnInProgressError extends Error { /* name: 'HumanTurnInProgressError' */ }
claimConversation(id: string): Promise<Session>;    // lock.withLock; idempotent (pushes expiresAt out); 409 RunInProgressError if live (R9)
releaseConversation(id: string): Promise<Session>;  // lock.withLock; idempotent
conversation(id: string): Promise<{ runner: 'claude-code' | 'codex' | null; resumeId: string | null; worktreePath: string | null; claimed: boolean }>;
/** True when `humanTurn` is present AND `expiresAt > now` — the ONE definition of "claimed",
 *  used by `conversation`, `AttentionItem.claimed`, the `sessions` table and the refusals. */
export function isClaimed(session: Session, now: Date): boolean;
```

`PipelineConfig` gains `runnerKind: 'claude-code' | 'codex'` (passed by `buildEngine` from
`adapters.runnerKind`, `src/host/build-engine.ts:93`) so `claim` on a session that never ran can
create `agent = { runner: <configured>, resumeId: null, humanTurn: { claimedAt, expiresAt } }`.
`PipelineConfig` also gains `humanTurnTtlMs`.

**The refusal is checked twice (R19).**

1. *Advisory, unlocked* — the first statement after each `run*`'s existing mode check, so a refusal
   costs no `prepareEnvironment` and no git work: `runFindings` after
   `src/pipeline/pipeline-service.ts:288-290`, `runPlan` after `:328-330`, `runDevelop` after
   `:423-425`, `runReview` after `:453-455`, `runRereview` after `:529-531` (ahead of its `pr` and
   worktree reads and of the `fetch`/`reset --hard` at `:540-546`). It re-uses the snapshot that
   method already loaded and throws `HumanTurnInProgressError(id)`.
2. *Authoritative, locked* — the **first statement after the fresh load inside each
   `runStageLocked` `preRun`**: `runFindings` (`:296-301`), `runPlan` (`:336-350`), `runDevelop`
   (`:436-441`), `runReview` (`:479-492`), `runRereview` (`:594-615`). It runs **before** each
   preRun's own mode/stageStatus check, so a claimed session is refused as claimed rather than as
   ineligible. One shared helper:

```ts
/** Authoritative. Runs under the per-session lock, on a fresh load, on the write path — which is
 *  why it may also REAP an expired claim (R20) rather than merely ignore it. */
private async assertNoHumanTurn(fresh: Session): Promise<Session> {
  if (fresh.agent?.humanTurn == null) return fresh;
  if (isClaimed(fresh, this.now())) throw new HumanTurnInProgressError(fresh.id);
  const reaped: Session = { ...fresh, agent: { ...fresh.agent, humanTurn: null } };
  await this.deps.store.save(reaped);        // already inside lock.withLock(id) — never nests
  return reaped;
}
```

`mapErrorToHttp` maps `HumanTurnInProgressError` → 409 (`src/api/http-errors.ts:20-26`).

**Two clobber sites must be fixed or `claim` silently un-claims itself.** `StageRunner` constructs a
brand-new `agent` object twice — `src/pipeline/stage-runner.ts:103`
(`agent: { runner: this.deps.runnerKind, resumeId: seedResumeId }`) and `:165`
(`agent: { runner: this.deps.runnerKind, resumeId }`). Both must carry
`humanTurn: priorAgent?.humanTurn ?? null` and `humanTurn: fresh.agent?.humanTurn ?? null`
respectively. This is MG-A7.

**Four recovery paths keep an orphaned claim from wedging a session (R20).**

- *Expiry.* `assertNoHumanTurn` treats an expired claim as absent and reaps it, above.
- *Boot.* `serve()` clears `agent.humanTurn` on every session in the store before it listens, and
  logs one `conversation.claims_cleared` line (`{ count, sessionIds }`) via the existing `logLine`.
- *Terminality.* `transition` into a phase in `TERMINAL_PHASES_BY_MODE`
  (`src/workspace/workspace-in-use.ts`) clears `agent.humanTurn` in the same locked write.
- *By hand.* `cgremlin-core release <session-id>` → `POST /sessions/:id/conversation/release`, and
  `cgremlin-core sessions` (and its `--json`) gains a `claimed` column, so a stuck claim is visible
  without reading `session.json`.

**The reconciliation tick skips, not errors.** `planReconciliation`
(`src/discovery/reconciliation.ts:61-105`) is pure over `{review, view, source}`, so the guard goes
there: `PlanReconciliationInput` gains one additive field, `now: Date` (the function stays pure — it
gains a clock *argument*, not a clock), and when `isClaimed(review, now)` and the plan would push a
`rereview` action (`:101`), it pushes a
`SkippedTransition { sessionId, to: 'reviewing', why: 'conversation claimed by a human turn' }`
instead — **a `skipped` entry, never a `report.errors` entry**. Without this the tick's `catch`
(`:202-206`, `:210-212`) would file an error every `pollIntervalMs` for as long as you have the
conversation open. `transition`-type actions (merged/closed/approved) are **not** guarded: they
apply on schedule and clear the claim as above, because a claim delays a *re-review*, never the
truth about the PR.

| Method | Path | Response | Codes |
|---|---|---|---|
| GET | `/sessions/:id/conversation` | `{ runner, resumeId, worktreePath, claimed }` | 200, 404 |
| POST | `/sessions/:id/conversation/claim` | `{ session }` | 200, 404, 409 run in progress |
| POST | `/sessions/:id/conversation/release` | `{ session }` | 200, 404 |

### 4.6 Artifact listing, primary artifact, and `GET /config`

```ts
// src/fs/session-file-system.ts — additive
statMtimeMs(path: string): Promise<number | null>;   // null when absent

// src/api/artifacts.ts
// There is deliberately NO second allow-list constant: `ARTIFACT_NAME_PATTERN`
// (`src/api/validation.ts:85-86`) is private to that module and `parseArtifactName` is its only
// public gate, so the listing filters `readdir` by calling `parseArtifactName` in a try/catch and
// dropping whatever it rejects. One allow-list, one regex, no drift.
export interface ArtifactListing { name: string; mtime: string; size: number }
export function pickPrimaryArtifact(session: Session, listing: readonly ArtifactListing[]): string | null;  // R11
```

| Method | Path | Response | Codes |
|---|---|---|---|
| GET | `/sessions/:id/artifacts` | `{ artifacts: ArtifactListing[]; primary: string \| null }` | 200, 404 unknown session |
| GET | `/config` | `{ config: CoreConfig }` — through `redactCoreConfig` (`src/config/core-config.ts:114-122`) | 200 |

The listing is produced by `readdir` of the session dir, with each name passed through the
**existing** `parseArtifactName` in a try/catch and dropped when it throws — so `.bypass-secret`,
`session.json` and `logs/` can never appear (MG-A10), and widening the allow-list stays a
one-regex edit. `size` comes from the read length; no new port method beyond `statMtimeMs`.

### 4.7 Direct development session (R16)

```ts
// src/pipeline/pipeline-service.ts
export interface CreateDevelopmentInput {
  repoUrl: string;
  ticket: string | null;
  baseRef?: string;
}
createDevelopmentSession(input: CreateDevelopmentInput): Promise<DevelopmentSession>;
```

Body, mirroring `createInvestigationSession` (`src/pipeline/pipeline-service.ts:230-280`) exactly
except where noted:

1. `id = this.newId('dev', repoSlugFromUrl(repoUrl), ticket ?? 'no-ticket')`, then
   `assertSafeSessionId(id)` **and** the `id.includes('..')` rejection (`:239-241`) — the ticket
   feeds the id which feeds the worktree path.
2. `branch = \`feature/${ticket ?? id}\`` (legacy `feature/<ticket>`; the id fallback mirrors
   investigation's `investigate/${ticket ?? id}` at `:243`).
3. `createWorkspace({ repoUrl, worktreePath: \`${worktreesDir}/${id}\`, branchName: branch,
   baseRef: baseRef ?? config.defaultBaseRef, mode: 'development' })` — the `mode` argument is what
   selects the *development* permission guard (`src/workspace/permission-guard.ts:10-18`: `gh pr
   review|comment|merge|close` denied, `git push`/`gh pr create` allowed), which is precisely the
   difference from an investigation worktree.
4. Record: `{ schemaVersion: 2, mode: 'development', stageStatus: 'active', agent: null,
   lastRun: null, pr: null, lineage: { pipelineId: id, parentSessionId: null, ticket } }` —
   self-rooted, unlike `promote`'s child session (`:398`).
5. On a `store.save` failure, roll the workspace back and rethrow, verbatim as `:268-277`.
6. Emit `session.created`. **Start nothing.** `promote()` still calls `runDevelop` (`:416`); this
   path does not — the UI issues `POST /sessions/:id/run {stage:'develop'}` as a separate,
   explicit act. This is MG-A11.

| Method | Path | Body | Response | Codes |
|---|---|---|---|---|
| POST | `/sessions/developments` | `{ repoUrl, ticket, baseRef? }` | `{ session }` | 201, 400 validation |

`parseCreateDevelopmentRequest` (`src/api/validation.ts`) reuses the investigation request's ticket
rule byte-for-byte — `z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).nullable()` (`:54`) — so the two
creation paths can never disagree about what a safe ticket is.

### 4.8 Manual review from a PR URL (R17)

| Method | Path | Body | Response | Codes |
|---|---|---|---|---|
| POST | `/reviews` | `{ prUrl }` | `{ session, created, started }` | 202 created + started, **200 already tracked** (`created:false, started:false`, R23), 400 `InvalidPrUrlError`, 409 own PR, 404/500 from `gh` |

Handler shape, mirroring `handleReviewStart` (`src/api/server.ts:97-169`) as closely as the absence
of an inventory entry allows:

1. `const ref = parsePrUrl(body.prUrl)` — `InvalidPrUrlError` maps to **400** (a new
   `mapErrorToHttp` entry alongside `ValidationError`).
2. `await lock.withLock(\`pr:${ref.slug}#${ref.number}\`, …)` — the **same** lock key the
   inventory-originated route uses (`:526`), so the two entry points cannot create two sessions for
   one PR concurrently.
3. Inside the lock: search `sessionStore.list()` for a non-terminal review session with that
   `pr.repo`/`pr.number` (the same predicate as `:118-126`). If one exists → **200**
   `{ session, created: false, started: false }` — byte-identical in shape and status to what the
   inventory-originated route answers for the same situation (`src/api/server.ts:149`), per **R23**.
   Two routes with one meaning do not disagree about a status code, and the caller's intent ("get me
   a review of this PR") *is* satisfied by the session that already exists. A **terminal** review
   session (e.g. `dismissed`) is not a match: that falls through to step 4 and creates a new one.
4. `factory.createFromPrUrl(ref.url, { refuseAuthor: config.me })` → `OwnPrError` (409) when the PR's
   author is the configured user, checked from the `mapPrView` the factory already performs — no
   second `gh` call.
5. `await awaitRunStart(events, created.id, pipeline.runReview(created.id))` → **202**
   `{ session, created: true, started: true }`, exactly the detached-run pattern at `:166-168`.

Two additive, non-breaking core edits support step 4:

```ts
// src/gh/own-pr-error.ts (NEW leaf module; src/api/server.ts re-exports OwnPrError from here,
// exactly as Phase 5 moved repoSlugFromUrl to src/gh/repo-slug.ts and re-exported it)
export class OwnPrError extends Error { constructor(repo: string, number: number); }

// src/pipeline/review-session-factory.ts
createFromPrUrl(prUrl: string, opts?: { refuseAuthor?: string }): Promise<ReviewSession>;
// after mapPrView: if opts?.refuseAuthor and mapped.pr.author?.toLowerCase() === refuseAuthor.toLowerCase()
//   -> throw new OwnPrError(slug, number)  BEFORE createWorkspace, so a refusal leaves no worktree
```

`createFromCandidate` and the no-argument `createFromPrUrl(url)` call keep byte-identical behaviour.

---

## 5. Extension architecture (`cgremlin/vscode`)

```
cgremlin/vscode/
  package.json            engines.vscode ^1.85.0, main ./out/extension.js,
                          activationEvents ["onStartupFinished"], contributes {viewsContainers, views, commands, configuration}
  tsconfig.json  vitest.config.ts  eslint.config.js  README.md
  src/
    extension.ts          activate/deactivate — the only composition root
    settings.ts           reads cgremlin.socketPath | cgremlin.notificationLevel (vscode)
    core-client.ts        PURE: http over { socketPath }, typed methods, EngineNotRunningError
    sse.ts                PURE: frame parser + reconnecting consumer (lastEventId, epoch, resync)
    model/items.ts        PURE: ListItem/ListKind types
    model/view-model.ts   PURE: buildLists({prs, groups, sessions, attention}) -> four lists
    model/notify-policy.ts PURE: decideNotifications(prev, next, level) -> Popup[]
    model/workspace-file.ts PURE: managed-workspace content + planWorkspaceAction()
    model/chat-command.ts  PURE: buildChatCommand({runner, resumeId}) -> string
    ui/tree.ts  ui/status-bar.ts  ui/notifications.ts  ui/commands.ts  ui/preview.ts  ui/terminal.ts
  test/                   vitest; test/support/core-harness.ts spawns a real engine on a temp socket
```

### 5.1 Activation and connection

`onStartupFinished`. `activate` builds a `CoreClient` from `cgremlin.socketPath`
(default `~/.cgremlin/engine.sock`), calls `GET /config` to learn `stateDir`, `sessionsDir` and
`worktreesDir` (R-per-§2: never re-derive them), then `GET /prs`, `GET /sessions`,
`GET /attention?all=1`, then opens `GET /events`. Every connect failure (`ENOENT`/`ECONNREFUSED`
on the socket) becomes `EngineNotRunningError` and the not-running UX (§5.7) — never a stack trace,
mirroring `runSocketCommand`'s single friendly message (`docs/ARCHITECTURE.md:297-299`).

### 5.2 View model (pure)

**Extensibility (required by §10's deferred Jira list).** The panel is driven by an ordered array of
list descriptors, not by four hard-coded roots: `LIST_ORDER: readonly ListDescriptor[]` where
`ListDescriptor = { kind: ListKind; title: string; build(input: ViewModelInput): ListItem[] }`. Adding
a fifth source is one array entry plus one `build` function plus one field on `ViewModelInput` — no
restructuring of the tree provider, the status bar, the notification diff (which is keyed by item id,
not by list) or the command `when` clauses (keyed by `contextValue`).

```ts
export type ListKind = 'parking' | 'reviewing' | 'investigations' | 'devwork';   // extensible: | 'tickets' | 'mentions'
/** A ListItem IS an Item plus presentation (R18) — it adds no domain field of its own. */
export interface ListItem {
  kind: ListKind;
  item: AttentionItem;                    // source, ref, id, title, repoOrContext, attention, links
  label: string; description: string;
  indicator: '' | '🔄' | '⏸️' | '✅' | '🛑' | '❗' | '👤';
  contextValue: string;                   // `${kind}:${item.source}:${item.mode ?? 'none'}` — drives menu `when`
}
export interface ViewModelInput {
  items: AttentionItem[];                 // straight from GET /attention?all=1 — the ONLY required input
  groups: InventoryGroups | null;         // optional enrichment (titles, newCommits); null when no scan yet
  sessions: SessionView[];                // for mode/phase detail the attention item does not carry
  // future sources add one optional field each — nothing else changes (R18)
}
export interface ListDescriptor { kind: ListKind; title: string; build(input: ViewModelInput): ListItem[] }
export const LIST_ORDER: readonly ListDescriptor[];
export function buildLists(input: ViewModelInput): Record<ListKind, ListItem[]>;   // iterates LIST_ORDER
```

- `parking` = `groups.unreviewed` — "not mine, no team activity, not ours" is already exactly
  `groupInventory`'s fall-through branch (`src/inventory/inventory.ts:134-140`).
- `reviewing` = **every non-terminal review session**, enriched with its `InventoryEntry` when one
  exists. Not `groups.ours`: an off-config PR reviewed via `POST /reviews` (R17) has no inventory
  entry at all, and a `groups.ours`-only list would render it invisible while its agent runs.
  `groups.ours` remains the source of the PR title/`newCommits` decoration when present.
- `investigations` = sessions with `mode === 'investigation'` and a non-terminal `stageStatus`.
- `devwork` = sessions with `mode === 'development'` and a non-terminal `stageStatus`, **plus**
  `groups.mine` entries with no development session for that PR.
Every `build` selects on `item.mode`, `item.stageStatus`, `item.attention` and `item.links` — all of
which every source carries (nullable) — and **never branches on `item.source`**: no `switch (item.source)`
and no `if (item.source === …)` appears in any `build` function. That is what makes a fifth list an
array entry rather than a refactor, and it is what the B2 guard checks (a source-text grep for the
*absence of branching*, not for a whitelist of field names, which the earlier draft mis-specified).

- Indicator precedence: `👤` claimed → `🔄` running → `🛑` blocked → `❗` run_failed →
  `⏸️` needs_input → `✅` plan_ready/review_ready/rereview_ready/changes_requested → `''`.
  Terminality uses `TERMINAL_PHASES_BY_MODE` (`src/workspace/workspace-in-use.ts`), mirrored as a
  literal table in the extension with a test that pins it against the phase lists.

### 5.3 Tree and status bar

One `viewsContainers.activitybar` entry (`cgremlin`, codicon `$(bug)`), four `TreeDataProvider`s —
or one provider with four static roots; the plan takes one provider with four roots, which keeps a
single `onDidChangeTreeData` for all refreshes. A status-bar item shows, when connected,
`$(pulse) cgremlin: <sessionId> · <phase> — N need you`, naming the session whose worktree the
managed workspace currently holds (R15 makes that the only way to know which repo you are in);
`$(folder) cgremlin: no repo open — N need you` when no session has been opened yet, and
`$(circle-slash) cgremlin: offline` when the engine is unreachable. `N` is
`items.filter(i => i.attention.needsYou).length` — the core's own flag (R22), so the badge count and
the popup predicate can never disagree. Its command opens the panel or the not-running quick pick.
The tooltip lists the current worktree path.

### 5.4 Notification policy (pure)

`decideNotifications(prev, next, level)` diffs two `AttentionItem[]` snapshots **keyed by `ref`,
never by source** (so a future source needs no change here) and returns a popup per item that
**entered** `attention.needsYou` — the core's own answer (R22). The extension holds **no** copy of
`NEEDS_YOU_REASONS` and never re-derives the predicate from `reasons`; `reasons` is used only for
the popup text and the tooltip. Levels: `all` (default) | `needs-you-only` | `off`. A reason set
that changed while already needing attention re-pops **only** if it gained a reason. Everything else
is badge-only (the status-bar count). Popups are `window.showInformationMessage(msg, 'Open', 'Ack')` (verified signature, spike
§2 citation 3); `Open` runs `cgremlin.openItem`, `Ack` runs `cgremlin.ack` (which posts `{ ref }` to `/attention/ack`).

### 5.5 Open item → preview + worktree

1. `GET /sessions/:id/artifacts` → `primary`.
2. `vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(`${sessionsDir}/${id}/${primary}`))`.
   The built-in preview creates a per-resource `FileSystemWatcher` and so auto-refreshes on
   disk-only edits (spike §2 citation 1) — the item is *not* required to be inside the workspace.
   `cgremlin.refreshPreview` (bound to `markdown.preview.refresh`) is the documented fallback.
3. `planWorkspaceAction({ workspaceFile, folders, worktreePath, managedPath, dirtyPaths })` (pure)
   returns one of — **exactly one repo folder is ever present (R15)**:
   - `{ kind: 'noop' }` — `folders` is already exactly `[worktreePath]`;
   - `{ kind: 'swap', uri, removeCount, requiresConfirm }` — the current workspace **is** the managed
     file → `updateWorkspaceFolders(0, removeCount, { uri })`: one call that removes every existing
     folder and adds the new worktree. This is not a documented restart case (those are the *first*
     folder and the single-folder→multi-root *transition*); the managed workspace is already
     multi-root with one folder, so the host survives. VS Code closes the removed folder's editors —
     intended, and warned about once via `showInformationMessage` when `removeCount > 0`.
     **`requiresConfirm` is true when any path in `dirtyPaths` lies inside a folder being removed**
     (`dirtyPaths` = `workspace.textDocuments.filter(d => d.isDirty).map(d => d.uri.fsPath)`, read by
     `extension.ts` and passed in, so the planner stays pure). On `requiresConfirm` the extension
     shows a **modal** `showWarningMessage(msg, { modal: true }, 'Switch anyway')` *before* calling
     `updateWorkspaceFolders`, and does nothing to the workspace if the user dismisses it — the
     preview still opens. Unsaved work is never closed by a click on a tree row;
   - `{ kind: 'offer-open-managed', managedPath, bootstrap }` — the window is not the managed
     workspace: write `bootstrap` to `<stateDir>/cgremlin.code-workspace` if absent, then *offer*
     `vscode.openFolder` on it. **Never forced** — that is a window reload, the one unavoidable
     restart, and the user must consent. Declining still opens the preview (step 2 needs no
     workspace membership).

`planWorkspaceAction` never returns `add`; there is no code path that appends a second repo folder.
That is MG-B5.

Managed file content (`workspace-file.ts`) — one folder, always:

```jsonc
{ "folders": [{ "path": "…/worktrees/<id>", "name": "<id>" }],
  "settings": { "cgremlin.managed": true } }
```

### 5.6 Chat

`GET /sessions/:id/conversation` → `POST …/conversation/claim` → `createTerminal({ name: 'cgremlin: <id>', cwd: worktreePath })` →
`sendText(buildChatCommand({ runner, resumeId }))`, where `buildChatCommand` is pure:

```
claude-code + resumeId  ->  claude --resume '<id>'      (single-quoted; ids are UUID-shaped, validated /^[A-Za-z0-9-]+$/)
claude-code + null      ->  claude
codex + resumeId        ->  codex resume '<id>'
codex + null            ->  codex
```

`cwd` is mandatory and always `worktreePath`, because the transcript store is cwd-keyed
(spike §1: `~/.claude/projects/<path-with-dashes>/`) and `worktreePath` is exactly what the engine
passed as `workingDirectory` (`src/pipeline/stage-runner.ts:113-115`). `window.onDidCloseTerminal`
fires `POST …/conversation/release`; `deactivate` releases every claim it holds.

**Heartbeat (R20).** While the terminal is open the extension re-issues `POST …/conversation/claim`
every `humanTurnTtlMs / 3` (the TTL comes from `GET /config`, so the interval is never hard-coded),
which pushes `expiresAt` forward. That is what makes the claim safe to expire: a live conversation
renews itself, and a crashed extension host, a killed terminal or a rebooted machine stops renewing
and the claim lapses within one TTL instead of wedging the session forever. The interval is cleared
in `onDidCloseTerminal` and in `deactivate`, alongside the release.

### 5.7 Commands and the not-running UX

| Command id | Calls |
|---|---|
| `cgremlin.openItem` | §5.5 |
| `cgremlin.chat` | §5.6 |
| `cgremlin.startReview` | `POST /prs/:owner/:repo/:number/review` (parking-lot rows only) |
| `cgremlin.approvePlan` | `POST /sessions/:id/approve-plan` |
| `cgremlin.stop` | `POST /sessions/:id/stop` |
| `cgremlin.retry` | `POST /sessions/:id/retry` |
| `cgremlin.ack` | `POST /sessions/:id/ack` \| `POST /prs/…/ack` |
| `cgremlin.refreshInventory` | `POST /prs/scan` |
| `cgremlin.newInvestigation` | quick-picks → `POST /sessions/investigations` → `POST /sessions/:id/run {stage:'findings'}` → `cgremlin.openItem` |
| `cgremlin.newDevelopmentSession` | quick-picks → `POST /sessions/developments` → `POST /sessions/:id/run {stage:'develop'}` → `cgremlin.openItem` |
| `cgremlin.newReviewFromUrl` | input box (validated by a mirror of `parsePrUrl`) → `POST /reviews` → `cgremlin.openItem` |
| `cgremlin.refreshPreview` | `markdown.preview.refresh` |
| `cgremlin.startEngine` | `createTerminal({name:'cgremlin-core'}).sendText('cgremlin-core serve')` |

Every 409 response body's `error` string is surfaced verbatim via `showWarningMessage` — the engine's
messages are already written for humans (`README.md:194-212`). On `EngineNotRunningError` the
extension shows `showWarningMessage('cgremlin engine is not running', 'Start it', 'Settings')` and
retries the SSE connection with backoff regardless.

**Creation quick-picks** (`ui/commands.ts`, sequenced, each cancellable with Esc and cancelling the
whole flow):

- *New investigation…* — (1) repo: `showQuickPick(config.repos)` from `GET /config`; (2) ticket:
  `showInputBox` validated live against `/^[A-Za-z0-9._-]+$/` — **the same regex the API enforces**
  (`src/api/validation.ts:54`), so the request can never be rejected for a reason the input box
  accepted; empty input means `null`; (3) `showQuickPick(['Investigate only', 'Development-bound'])`
  → `intent`; (4) `showQuickPick(['Stop at the plan', 'Drive to completion'])` →
  `driveToCompletion`. Then `POST /sessions/investigations`, then one explicit
  `POST /sessions/:id/run {stage:'findings'}`, then open the new item.
- *New development session…* — (1) repo, (2) ticket, same widgets and the same regex. Then
  `POST /sessions/developments`, then one explicit `POST /sessions/:id/run {stage:'develop'}`, then
  open the new item. The agent stops at the PLAN GATE; the extension's `needs_input` notification is
  what tells the user to read `DEVELOPMENT.md` and continue via **Chat** (R16).

- *New review from PR URL…* — one `showInputBox` whose `validateInput` accepts exactly what
  `parsePrUrl` accepts (host `github.com`, path `/<owner>/<repo>/pull/<n>`, optional trailing
  segments) so a rejectable URL never reaches the socket. Then `POST /reviews`. A **202** opens the
  new session. A **200 with `created: false`** (the PR already has a review session, R23) is not an
  error: the extension reveals that session via `cgremlin.openItem` and says so in a
  `showInformationMessage`. A **409** (own PR) and a 400 or `gh`-sourced 500 show the engine's
  message verbatim and open nothing, leaving the input box's value in the error text so the user can
  correct it.

`repoUrl` is built from the picked slug as `https://github.com/<slug>.git`, matching what
`repoSlugFromUrl` round-trips (`src/gh/repo-slug.ts`).

**Settings** (`contributes.configuration`): `cgremlin.socketPath` (string, default
`~/.cgremlin/engine.sock`), `cgremlin.configPath` (string, default `~/.cgremlin/core.json`, used
only in the `Start it` terminal command), `cgremlin.notificationLevel`
(`all` | `needs-you-only` | `off`, default `all`).

---

## 6. Event map after Phase 7

| Event | Payload | New? |
|---|---|---|
| `session.created` | `{ session }` | |
| `session.transitioned` | `{ session, from, to }` | |
| `run.started` | `{ session, stage }` | |
| `run.output` | `{ sessionId, stage, chunk }` | opt-in on `/events` (R8) |
| `run.finished` | `{ session, stage, outcome }` | |
| `inventory.updated` | `{ inventory }` | |
| `attention.changed` | `{ item: AttentionItem }` | **new** |
| `artifact.changed` | `{ sessionId, name, mtime }` | **new** |

## 7. Testing strategy

Core (vitest, existing conventions — fakes per port, `test/support/*`):

- `deriveSessionReasons` / `derivePrReasons` are table-driven over every reason (including R22's
  engine-died `run_failed` and the owner-only `local_prereq_failed`); `evaluateAttention` is
  table-driven over ordering, `since` precedence, the signature, `needsYou` and the ack. **A test
  asserts `evaluateAttention` never mentions a source-specific field** (source read for
  `session.`/`entry.`) — that is what keeps R18 true rather than aspirational.
- `item-ref.ts`: `sessionRef`/`prRef` round-trip through `parseItemRef`; an unknown source, a missing
  separator, and `'pr:o/r#notanumber'` each throw `ValidationError`; `parseItemRef` splits on the
  **first** `:` only, which is unambiguous because no `ItemSource` name contains `:` — **not**
  because a session id cannot: `assertSafeSessionId` (`src/engine/session-store.ts:26-30`) rejects
  only `''`, `/`, `\`, `.` and `..`, so `sessionRef('a:b')` must round-trip and a test pins that it
  does.
- `AckStore` round-trips, tmp+rename, and prunes vanished keys.
- `AttentionService` over two real `SourceAdapter`s (`InMemoryFileSystem`-backed) + a
  `FakeSessionWatcher` + a real `EngineEvents`, plus one test with a **third, stub adapter** proving
  a new source needs no service change:
  emits `attention.changed` only on a real delta, coalesces a burst into one emission, and takes
  **zero** session locks (asserted with a wrapped `KeyedLock` call log — the same technique Phase 5's
  MG-9 used).
- `EventRing`/`serializeFrame` are pure. The `/events` route is tested against a real API server on
  a temp socket with a real HTTP client reading frames — including R21's three guards: **ordering**
  (a burst emitted *during* the replay→live handover arrives once each, in strictly increasing id
  order, with no duplicate), the `since(n > lastEventId)` rule (`complete: false` → `resync`), and
  the **drop policy** (a connection forced into the lagging state loses `run.output` frames and keeps
  every other type, and is destroyed past `MAX_PENDING_FRAMES`).
- `handleEventStream` cleanup: after a client's `close`, the ring has no subscriber left and no
  heartbeat interval is still scheduled (assert both, not just the absence of a crash).
- `NodeSessionWatcher` gets one real-filesystem test (temp dir, recursive watch, assert the
  two-segment filter) plus a forced-fallback test that constructs it with a stubbed `fs.watch`
  thrower and asserts the poll path still reports.
- Human turn: the five-stage refusal matrix at **both** check sites (R19 — advisory before
  `prepareEnvironment`/the git work, authoritative inside the lock), the two `StageRunner`
  preservation sites, the `planReconciliation` skip, the claim-while-running 409, and R20's four
  recovery paths (expiry-is-absence + reaping, `serve()`'s boot clear and its
  `conversation.claims_cleared` log line, the terminal-transition clear, and
  `POST …/conversation/release` / `cgremlin-core release`). The TTL is driven by an injected clock,
  never by sleeping.
- Artifacts: `pickPrimaryArtifact` table, the listing's allow-list filter, `statMtimeMs` added to
  `test/support/file-system-contract.ts` (already run against both the Node and in-memory adapters).

Extension (vitest, `cgremlin/vscode/test`):

- Pure modules directly: `buildLists`, `decideNotifications`, `planWorkspaceAction`,
  `buildChatCommand`, the SSE frame parser (including a frame split across two TCP chunks, an
  unknown event type, and `resync`).
- `CoreClient` and the SSE consumer **against a real engine** on a temp socket
  (`test/support/core-harness.ts`): spawn `node ../core/bin/cgremlin-core serve --config <tmp>` with
  `pollIntervalMs: 3600000`, a temp `stateDir`, and a temp dir **prepended to PATH containing a
  `gh` shell script** that prints fixture JSON — so `POST /prs/scan` produces a real inventory with
  no network and no GitHub. Sessions are seeded by writing valid `schemaVersion: 2` `session.json`
  documents; no git, no agent, no stage is ever run.
- **No `@vscode/test-electron`, in CI or otherwise** — the VS Code API surface is exercised by the
  manual smoke checklist (§8), which is what the layer split in §5 exists to make small.

### Mutation guards

Each is a named test that must be demonstrated failing under its stated mutation.

| Guard | Asserts | Mutation that must fail it |
|---|---|---|
| **MG-A1** `attention-is-pure-and-source-agnostic` | `src/attention/attention.ts` imports nothing from `node:fs`, `../fs/*`, `../engine/*`, and `evaluateAttention`'s body references no `session.`/`entry.` field (source read); a stub third `SourceAdapter` flows end-to-end through `AttentionService` and `/attention` with zero service edits | adding a file read, or an `if (source === 'session')` branch inside the evaluator |
| **MG-A2** `ack-resets-on-a-new-reason` | acking, then gaining a reason, re-raises `needsAttention` | comparing only `reasons.length`, or acking by id alone |
| **MG-A3** `attention-never-locks-a-session` | a full `refresh({kind:'all'})` records zero `lock.enter:<sessionId>` entries | wrapping the recompute in `lock.withLock` |
| **MG-A4** `events-never-leak-the-secret` | `/events` omits `run.output` by default; with `?include=run.output` a chunk containing `x-vercel-protection-bypass=S3CRET-VALUE` arrives as `<redacted>`, and no frame anywhere contains the raw value | dropping `redactBypassUrls`, or defaulting `run.output` on |
| **MG-A5** `sse-replay-is-bounded-and-honest` | the ring never exceeds `EVENT_RING_CAPACITY`; a `Last-Event-ID` older than the oldest entry, **one greater than `lastEventId`** (R21), or a stale `epoch`, each yields `event: resync`; across a replay→live handover no id is duplicated, skipped or out of order; a lagging connection drops only `run.output` and is destroyed past `MAX_PENDING_FRAMES` | silently starting from "now" instead of resyncing; subscribing before the replay snapshot (duplicates); accepting a future `lastEventId` as complete; queueing `run.output` while lagging |
| **MG-A6** `human-turn-blocks-every-headless-turn` | with a live claim, each of the five stages rejects with `HumanTurnInProgressError` (409); `FakeAgentRunner` recorded zero starts; **`FakeGitRunner` recorded zero `fetch`/`reset` calls and `EnvironmentService.start` was never called** (R19 — the advisory check ran before both) | removing `assertNoHumanTurn` from any one stage's locked preRun, or removing the advisory check (which leaves the run's git/environment side effects in place) |
| **MG-A7** `human-turn-survives-a-run` | claim a session with **no** run in flight (writing the claim under the shared per-session lock, since R9 refuses `claim` while a run is live), then start a run and let it complete: the persisted `agent.humanTurn` is **the same claim record** after both of `StageRunner`'s agent-object rebuilds — the pre-run seed (`:103`) and the post-exit merge (`:165`) — and `agent.resumeId` was still recorded | reverting either `StageRunner` agent-object site (`:103`, `:165`) |
| **MG-A8** `no-parking-lot-attention` | no parking-lot item ever reports `needsAttention`: an entry with `isMine: false`, no `ours`, no `teamActivity` and no session derives `reasons: []` | making `changes_requested` fire for a non-`isMine` entry. (The "nothing auto-starts an agent" half is the plan's DoD grep over `src/attention` and `src/api/event-stream.ts`, which is a stronger check than a zero-call assertion on a code path that never had a `runReview` reference to begin with.) |
| **MG-A9** `locking-invariant-unchanged` | `pipeline-service.ts`'s header comment (`:1-14`) is byte-identical to its pre-Phase-7 text (committed as a fixture), and the **authoritative** human-turn refusal happens **inside** the lock: with the wrapped-`KeyedLock` call log, a session claimed *between* the advisory check and the lock is still rejected, and `lock.enter:<id>` precedes that rejection | deleting the locked `assertNoHumanTurn` and relying on R19's advisory check alone (a TOCTOU hole), or moving the locked check outside `runStageLocked` |
| **MG-A10** `artifact-listing-respects-the-allow-list` | `GET /sessions/:id/artifacts` never lists `.bypass-secret`, `session.json`, or `logs`, even when present; `parseArtifactName('.bypass-secret')` still throws | listing a raw `readdir`, or introducing a second allow-list constant instead of calling `parseArtifactName` |
| **MG-A11** `direct-dev-session-starts-nothing` | `createDevelopmentSession` + `POST /sessions/developments` record **zero** `FakeAgentRunner` starts and zero `run.started` events; the subsequent explicit `POST …/run {develop}` produces exactly **one**; `promote()`'s auto-`runDevelop` is unaffected | calling `runDevelop` from the creation path |
| **MG-A12** `any-pr-url-is-reviewable-exactly-once` | `POST /reviews` on a PR that is **not** in the inventory creates a session and starts exactly one review; a second concurrent `POST /reviews` for the same URL (and a concurrent `POST /prs/…/review` for the same PR) yields exactly one session — both take the same `pr:<slug>#<n>` key — and the loser answers **200** `{ created: false, started: false }`, the same status the inventory route gives (R23); an own PR is refused **409 before** `createWorkspace` runs (no worktree, no session on disk) | dropping the lock key, checking the author after the workspace is created, or answering 409 for an already-tracked PR (the two review routes disagreeing) || **MG-B6** `off-config-review-is-visible` | `buildLists` puts a non-terminal review session with **no** matching `InventoryEntry` in `reviewing`; and no `build` function contains a `switch (item.source)` or an `if (item.source === …)` (source read), plus a stub `ListDescriptor` added to a local copy of `LIST_ORDER` yields a fifth list with no other edit | building `reviewing` from `groups.ours`, or branching a `build` on `item.source` |
| **MG-B5** `one-worktree-folder-at-a-time` | `planWorkspaceAction` returns `swap` with `removeCount === folders.length` and never a plan that leaves two repo folders; the managed bootstrap JSON always has exactly one `folders` entry; a dirty document inside a folder being removed sets `requiresConfirm` (R-10a) and the host calls `updateWorkspaceFolders` **only** after the modal is accepted | returning `add`, appending instead of replacing, or swapping over unsaved work without the modal |
| **MG-B1** `pure-modules-are-vscode-free` | no file under `src/core-client.ts`, `src/sse.ts`, `src/model/` contains `'vscode'` (source read) | importing `vscode` into the view model |
| **MG-B2** `only-needs-you-pops` | `decideNotifications` returns popups only for items **entering** `attention.needsYou` — the core's flag (R22); `level: 'off'` returns `[]`; an unchanged snapshot returns `[]`; an item of an **unknown future source** still diffs correctly (keyed by `ref`); and no file in the extension contains the string `NEEDS_YOU_REASONS` (source read — the list lives only in the core) | popping on every `attention.changed`, switching on `source`, or re-deriving needs-you from `reasons` in the extension |
| **MG-B3** `no-extension-host-restart` | `planWorkspaceAction` returns `offer-open-managed` (never `add`) when `workspaceFile` is undefined or is not the managed path | calling `updateWorkspaceFolders` on a single-folder window |
| **MG-B4** `chat-always-runs-in-the-worktree` | `buildChatCommand` never emits `--resume` with a null id, quotes the id, and the terminal factory is always called with `cwd === worktreePath` | dropping `cwd`, or interpolating an unvalidated id |

## 8. Manual smoke checklist (run by whoever lands the phase)

1. **Engine off.** Open VS Code with the extension installed → status bar reads
   `cgremlin: offline`; the panel shows the not-running message with a `Start it` action; clicking it
   opens a terminal running `cgremlin-core serve` and the panel populates within ~2 s of the socket
   appearing.
2. **Four lists.** Compare each list against `cgremlin-core prs` and `cgremlin-core sessions --json`:
   parking lot = `unreviewed`, reviewing = `ours`, and every non-terminal investigation/development
   session appears exactly once.
3. **Notification.** With an investigation mid-turn, `printf needs-input > ~/.cgremlin/sessions/<id>/AGENT_STATE`
   → a popup appears within ~2 s; `Open` reveals and selects that row; the row shows `⏸️`.
4. **Chat (the one thing only a live run can prove).** Click Chat on a session whose `agent.resumeId`
   is non-null → a terminal opens with the worktree as cwd and `claude --resume <id>` **resumes the
   existing transcript** (the engine's own headless turn: no `--no-session-persistence` is passed —
   `src/agent/claude-code-runner.ts:57-74`). Confirm the prior turn's context is present, then
   confirm `POST /sessions/:id/run` returns 409 `HumanTurnInProgressError` while the terminal is open,
   and that closing the terminal releases it. Then the R20 recovery paths, by hand: leave the
   terminal open past one `humanTurnTtlMs` and confirm the claim is **still** held (the heartbeat
   renewed it); `kill -9` the extension host (or close the window) and confirm the claim lapses
   within one TTL and `POST …/run` then succeeds; restart the engine with a claim in place and
   confirm the boot clear logs `conversation.claims_cleared`; and confirm `cgremlin-core sessions`
   shows a `claimed` column and `cgremlin-core release <id>` clears it.
5. **Preview + worktree.** Click a session row → its primary artifact opens as a rendered preview
   and the worktree appears as **the** workspace folder **without** the window reloading (given the
   managed workspace is already open). Append a line to that file from a shell → the preview updates
   without any click. Click a *different* session → the folder swaps (one folder in the explorer, not
   two), the previous folder's editors close, and the status bar now names the new session id and
   phase. Then the dirty-editor case: edit a file in the current worktree **without saving** and
   click a different session → a **modal** confirm appears first; dismissing it leaves the folder and
   the unsaved buffer untouched (and still opens the preview); accepting it swaps as above.
6. **Managed workspace bootstrap.** From a plain single-folder window, click a row → the extension
   *offers* to open `<stateDir>/cgremlin.code-workspace`; declining leaves the window untouched and
   still opens the preview; accepting reloads once and never again.
7. **Create.** *New development session…* → pick a repo and a ticket → a `feature/<ticket>` worktree
   appears under `worktreesDir`, `.claude/settings.local.json` in it carries the *development* deny
   list, `cgremlin-core sessions --json` shows one `mode: 'development'`, `stageStatus: 'active'`
   session with `lineage.parentSessionId: null`, and exactly one develop run started. It stops with
   `AGENT_STATE=needs-input` and a `DEVELOPMENT.md`; Chat then continues it. Repeat for
   *New investigation…* (findings run, `investigate/<ticket>` branch, investigation deny list).
8. **Any PR URL.** *New review from PR URL…* with a PR in a repo **not** listed in `config.repos`
   → 202, the row appears under "PRs we are reviewing" (proving the session-sourced list, not
   `groups.ours`), a worktree exists, and the review runs. Re-issue the same URL → **200**, and the
   extension reveals the existing session rather than showing an error (R23). Paste a non-PR URL → the validation message
   before any request. Paste one of your own PRs → the own-PR refusal, and `ls worktrees/` shows no
   new directory. Let one `pollIntervalMs` tick pass and confirm `cgremlin-core sessions --json`
   still reflects the live PR state for that off-config session (the tick's per-session
   `gh pr view` path).
9. **Commands.** Start review from a parking-lot row (row moves to "reviewing", `cgremlin-core prs`
   agrees), approve a `plan_ready` plan, stop a live run, retry a failed one, ack an item (indicator
   clears; a *new* reason re-raises it).
10. **Resilience.** `kill -9` the engine mid-session → status bar flips to offline within ~15 s
   (heartbeat) and no error dialog storm; restart it → the client resyncs (a fresh `epoch`) and the
   lists are correct with no duplicate rows.
11. **Secrets.** With a `bypassSecret` configured, run a review and confirm no `/events` frame, no
   notification, and no tree label contains the raw secret.

## 9. v2 hooks (must not be precluded, and are not)

- **Our own chat pane** — `/events?include=run.output` already streams the redacted agent text, and
  `epoch`/`resync` already handle an engine restart mid-stream.
- **Structured findings as cards** — `AttentionItem.reasons` is an open array and `REVIEW.md` stays
  unparsed by the core; a future `GET /sessions/:id/findings` would be additive.
- **Core MCP server** — it would be another client of `/attention`, `/events` and the conversation
  routes; `humanTurn` already gives it a mutual-exclusion primitive against the pipeline.
- **Inline screenshots** — the artifact allow-list (`src/api/validation.ts:85-86`) is deliberately
  unchanged in v1; widening that one regex is the single edit that unlocks this, precisely because
  the listing filters through `parseArtifactName` rather than through a second constant (§4.6).
- **Pinned / LRU workspace folders** — `planWorkspaceAction` is a pure function returning a plan, so
  a multi-folder policy is a change to one function plus MG-B5's expectation, nothing else (R15).
- **A formal plan gate for development sessions** — a `plan_ready` phase in the development
  transition table plus an `approve-plan` equivalent, which would let the PLAN GATE be released
  headlessly instead of through Chat (R16). Nothing in v1 depends on that gate being human-only
  beyond the notification copy.

---

## 10. Next phases (explicitly deferred, and the reason v1 is generic)

Each of these is a **new `SourceAdapter` + `derive*Reasons` + `LIST_ORDER` entry** and nothing else
structural — that is the whole point of R18. None of them is implemented in v1.

### 10.1 Jira parking lot

A fifth list — **tickets assigned to me that have no session yet** — with "start an investigation /
development session from this row" as its row action. Deferred out of Phase 7 because it needs its
own grounding pass on authentication, not because the panel cannot hold it.

- **What has to be decided first (the grounding pass):** whether the core holds a Jira API token in
  `core.json` — in which case it inherits the *entire* Vercel-bypass-secret regime: 0600 write with
  the mode set on the temp file before the rename, the group/other-readable load refusal,
  `redactCoreConfig`, and never appearing in a brief, a log line, an event frame or an HTTP response
  (`README.md`'s Secret handling section, and `src/config/core-config.ts:109-166`) — or whether it
  shells out to a Jira CLI the way it shells out to `gh`, which keeps the credential entirely outside
  the engine. That choice is the whole phase's shape, so it is not pre-decided here.
- **Join rule (already satisfiable today):** ticket key ↔ `session.lineage.ticket`. Every session
  carries it (`src/schema/session.ts:15-19`), investigations set it from the create request and
  review sessions derive it from the branch name via `extractTicketKey`
  (`src/pipeline/review-session-factory.ts:73`). A ticket row is "unstarted" exactly when no
  non-terminal session has that `lineage.ticket`.
- **Panel implication:** one more `LIST_ORDER` entry (`kind: 'tickets'`), one `build` function, one
  `ViewModelInput` field, and one `contextValue` for its row actions — which is precisely why §5.2
  requires the descriptor-array shape in v1 rather than four hard-coded roots.
- **Attention implication:** a new `AttentionReason` (e.g. `ticket_assigned`) and a `kind: 'ticket'`
  `AttentionItem` with a `POST /tickets/:key/ack` route; `ATTENTION_REASONS` is an ordered `as const`
  array and `ItemRef` is already a parsed, source-prefixed string, so both extend additively.

### 10.2 Slack mentions inbox

Threads where I am tagged become items with `source: 'slack'`, each carrying an **agent-produced
briefing artifact** (what the message means, the background needed to get up to speed, the sources it
draws on) and a **drafted reply the human edits and sends**.

- **Layer split.** Core: the Slack read side (list mentions, fetch a thread), the session/stage that
  produces the briefing + draft as ordinary on-disk artifacts (the artifact-driven rule holds — the
  agent writes files, never calls back), a `SlackSourceAdapter` + `deriveSlackReasons`, and an
  `ItemRef` of `slack:<channel>/<ts>`. Extension: the list, the briefing rendered as a markdown
  preview (identical mechanism to §5.5), and an editor for the draft.
- **Sending is a separate, human-triggered outward action** — the *same* deferred-poster pattern as
  posting to GitHub (`docs/DECISIONS.md:81-85`): a distinct component that takes structured input
  (channel, thread ts, final text) and performs the write, never reading or knowing the briefing
  artifact's format. Nothing sends automatically, and the engine's "local-only side effects" rule
  (`docs/DECISIONS.md:39-41`) is not weakened by adding a *read* source.
- **Join rule.** A Slack thread is its own item, keyed by its own id; it may *optionally* link to a
  session or a ticket through `ItemLinks.sessionId`/`ItemLinks.ticket` when the mention names one.
  No implicit joining — a mention that references nothing stays standalone.
- **Auth grounding needed first**, exactly as for Jira: a Slack token in `core.json` inherits the
  whole bypass-secret regime (0600, load refusal, `redactCoreConfig`, never in a brief/log/event/
  response), or the engine shells out to a CLI and never holds the credential.
- **Panel implication:** one `LIST_ORDER` entry (`kind: 'mentions'`), one `build`, one optional
  `ViewModelInput` field, one `contextValue`.

### 10.3 Jira comment scanning (companion to 10.1)

Comments on tickets that *already have a session* become brief context and UI detail: the core
fetches them on the same schedule as the inventory scan, feeds them into the stage brief (a new
`## Ticket discussion` section rendered by a pure function in `src/pipeline/prompts.ts`, gated on
"was anything actually fetched" exactly like the environment section's R14 gate), and surfaces a
`ticket_comment` reason on the *session* item. This one needs no new list — which is why the join
rule (`ticket key ↔ session.lineage.ticket`) matters more than the source plumbing.
