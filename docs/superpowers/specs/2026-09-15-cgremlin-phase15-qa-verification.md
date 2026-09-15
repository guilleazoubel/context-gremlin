# cgremlin Phase 15: QA VERIFICATION mode — design spec

**Goal.** A ticket whose PRs have merged and whose Jira status has entered QA gets a **verification agent**: it reads the ACs, exercises the feature in the **shared QA environment** (a fixed URL per repo, configured once), checks the API, the PostHog events and the flags the diff touches, and writes **one report** — `QA.md` — with a verdict of ready / not-ready / blocked. It fires **automatically** ("before we deploy we are always asked to smoke test the tickets in QA — I want that to be automatic"), by hand from the row, or chat-only when the user just has questions.

**Explicitly out of scope (supersedes the user's "open a pr").** No validation code, no branch, no commit, no PR, no Jira/GitHub comment: **the engine performs no outward-facing action** (R55 holds). The deliverable is the report and the conversation. "Open a validation PR" may be a later phase behind an explicit human click; nothing here writes outside the session directory.

## §0 Ground truth this evolves (read before planning)
| Fact | Where |
|---|---|
| 4 modes, union discriminated on `mode`, v1 not extended; **6** stage names; per-mode phases + transition tables | `core/src/schema/session-mode.ts:10`, `session.ts:71-95`, `stage.ts:11`, `pipeline.ts:3-102` |
| Terminal phases and the permission guard are `Record<SessionMode,…>` — a 5th mode is a compile error until wired | `workspace/workspace-in-use.ts:4-9`, `workspace/permission-guard.ts:9-47` |
| Create-and-start in one click, plus the parity rule on a second POST | `api/server.ts:286-350`, `pipeline/respond-session-factory.ts:62-112` |
| `reviewSkillCommand` reaches the PROMPT, not the brief; the brief carries the protocol and degrades when the skill is absent | `prompts.ts:471-479`, `:149-192`, `pipeline-service.ts:751-758` |
| `## Environment` / `## Ticket` sections, both gated to `''`; ticket = description text (the ACs) + status + ≤5 comments | `prompts.ts:73-100`, `:114-144`, `jira/jira-store.ts:98-149`, `host/build-engine.ts:222-235` |
| `BRIEF.md` is written **by StageRunner at run start** — nothing else writes it | `pipeline/stage-runner.ts:89-91` |
| Completion detection + archiving: `parsePlanReviewStatus`, `evaluateReview`, `nextReviewVersion` | `pipeline/artifacts.ts:18-71` |
| Artifact allow-list, primary preference, tab roles/labels; the artifact-read route returns **raw bytes** | `api/validation.ts:105-113`, `api/artifacts.ts:23-63`, `vscode/src/model/artifact-labels.ts:14-49`, `api/server.ts:445-460` |
| Env service: 0600 bypass secret, brief context, Clerk test user; the runner defaults to `--permission-mode bypassPermissions` | `env/environment-service.ts:695-739`, `agent/claude-code-runner.ts:40`, `:63-64` |
| The auto re-review is the tick's only agent-start today (a claim ⇒ *skipped*, never *error*); background legs run after `inventory.updated`, unawaited, single-flight, budgeted, drained | `discovery/reconciliation.ts:173-188`, `:349-366`, `inventory/inventory-scanner.ts:227-259` |
| `myWork` already admits any non-review agent; landed rows sink (`byLanded` is the first key of every order); dismissal auto-clears on `needsYou` | `work/work-item.ts:620-631`, `:545-552`, `:698-711`, `attention/dismiss-store.ts:43-46` |
| The ONE row composer already draws ticket status + a phase cell per agent on `myWork` | `vscode/src/model/row-composition.ts:327-329`, `:353-355` |

## §1 Rulings I had to make (binding)
| # | Ruling | Why |
|---|---|---|
| **R68** | Mode **`qa`**, stage name **`verify`**. | Mode↔stage is never derived (`runStage` is an explicit switch, `pipeline-service.ts:948-963`); "verify" is the verb. |
| **R69** | 7 phases; terminal = `closed`/`abandoned`. `ready` is **not** terminal. | A terminal session may lose its worktree and leaves the live filters; the user keeps chatting and keeps following the ticket until deployed. |
| **R70** | QA sits **after** the forward-only ladder, not on it: `STAGE_ORDER`/`nextStages` untouched (they already return `[]` on a landed item, `row-actions.ts:120`); the QA verbs are their own rule, allowed only when **every PR on the item is `merged`** — `landed` includes `closed`, and a change that was thrown away is not a change to verify (E10). | Grafting a 4th rung re-opens `furthestStage` for every existing row. |
| **R71** | A QA session puts the item in **no new list**: `mode !== 'review'` already routes it to `myWork` (`work-item.ts:630`). Accepted consequence: manually QA-ing a teammate's PR moves that row into `myWork` — correct, the verification is my commitment. | Zero membership code, one behaviour. |
| **R72** | In `byNeedsYouThenRecent` **only**, compare `needsYou` **before** `byLanded`; the other two orders keep `byLanded` first. | A not-ready verdict on a merged item is the top of my work. Minimal rule — it also lifts `run_failed`/`comments_ready` landed rows in `myWork`, which is right. |
| **R73** | Chat-only needs a new primitive: `PipelineService.prepareQaSession(id)` composes and writes `BRIEF.md` with **no** run — no `AGENT_STATE`, no `lastRun`, no phase change; under the per-session lock, refused while a run is in flight. | `StageRunner` is the only writer of `BRIEF.md`; otherwise chat-only hands the user an empty directory. |
| **R74** *(amended by R81)* | QA auth kinds are **`clerk-test` \| `credentials` \| `vercel-bypass` \| `none`**. `vercel-bypass` reuses `vercel.bypassSecret` verbatim; `credentials` adds **exactly one** new secret, `qa.account.password`, under the **same** regime (0600 `core.json`, `hasAnySecret`, `redactCoreConfig`, a 0600 `<sessionDir>/.qa-account` written before the run and removed in teardown, R85's redactor everywhere). | R81 requires a real test identity for the automatic leg, and Clerk test users do not exist in every QA deployment. One secret, one proven regime — not a new one. |
| **R75** | The protocol lives **in the brief** (like `renderUiCheckProtocol`); `qaSkillCommand` (default `/cgremlin:qa-verify`) is an enhancement that degrades silently. The skill SOURCE ships here at `skills/qa-verify/SKILL.md` (Appendix A), installed by the user into `~/.claude/skills/`. | The agent runs in the TARGET repo's worktree, where a cgremlin-repo file does not exist. Mirrors `prompts.ts:478`. |
| **R77** **AMENDED** | A **cold** record (no prior status known) **seeds** `lastStatus`/`ordinal:0` and fires **nothing**: only an *observed* non-QA→QA transition auto-runs. The backlog sitting in QA at install time is surfaced with the `Verify in QA` action lit, one human click each; `qa.backfillOnFirstRun` (default **false**) is the deliberate opt-in. The per-tick cap `qa.maxAutoStartsPerTick` (default **1**, newest first) still applies. | The original R77 would fire one agent per tick forever against an existing backlog — at `pollIntervalMs: 60_000` that is 60 unasked-for agents an hour, which is exactly the standing no-burn rule. A click is cheap; a fleet is not. *(My judgment, not a coordinator ruling — flag it.)* |
| **R80** *(coordinator; supersedes the draft's R76)* | Auto-trigger identity = the **sorted join of `repo#n@mergeOid` over every merged PR on the item**, plus the **QA-entry ordinal**. Every PR must be in the **same** repo and that repo must have a `qa.url`, else the leg skips with `item spans repos`; the manual action stays available. The ordinal increments on each **observed** non-QA→QA transition, and `observedAt` is named as the **tick observation** it is — never presented as a Jira fact. | A two-PR ticket has no single sha; an ordinal makes a re-entry at the same shas unambiguous without pretending we know when Jira changed. |
| **R81** *(coordinator)* | A configured QA **test identity is REQUIRED** for the automatic leg: `auth:'none'` can never auto-run (skip `no qa test account`). A **manual** click may run with `auth:'none'` — a human is watching. | An unattended agent that has to improvise an identity is the failure mode; an attended one can be told. |
| **R82** *(coordinator)* | The permitted/forbidden list in §9 is carried **verbatim** by the spec, the brief and the skill. The spec states plainly that the runner launches with `--permission-mode bypassPermissions`, that the deny list matches **Bash argv only** — so it stops neither `curl -X POST` nor a browser/MCP write — and that **the enforceable boundary is the test identity's own permissions**. | `claude-code-runner.ts:40,63-64`. Claiming enforcement we do not have is worse than naming the real boundary. |
| **R83** *(coordinator)* | The automatic leg runs `qaHealth` **before** creating a session and skips when QA is unreachable — no session, no tokens, but the attempt is recorded. The **manual** click keeps degrade-and-report (§9). | An unattended run against a dead QA burns a whole agent turn to write "blocked". |
| **R84** *(coordinator)* | A ticket entering QA with **no known PRs** gets **one** `gh pr list --repo <slug> --search "<KEY>" --state merged --json …`, bounded by the same once-per-(ticket, ordinal) record; results are written into the **pr-state cache**. | The user's normal case: the PR was merged without a cgremlin session, so `WorkItem.prs` is empty and the leg would never fire. |
| **R85** *(coordinator)* | Redaction widens beyond the Vercel shape to `Authorization:`, `Bearer <token>`, `__session=`, `set-cookie:` (and the configured QA password), in ONE function, applied on the artifact-read route too. | `QA.md` is a new surface that returns raw bytes (`server.ts:445-460`), and a QA run handles session cookies and bearer tokens the review path never saw. |
| **R78** | The leg **closes** a QA session when its ticket's `statusCategory` becomes `Done`. | The natural end; otherwise a `ready` session pins the item in `myWork` forever. Free — the snapshot carries it (`jira-store.ts:29`). |
| **R79** | Report verdict `🚧 Blocked` maps to phase **`not_ready`**; only run-level failure is `failed`. | Blocked = not ready AND needs me: one phase, one attention reason. |

## §2 The mode
`SessionModeSchema` += `'qa'`; `STAGE_NAMES` += `'verify'` (**appended** — R56's three-contracts reasoning holds); a 5th
`SessionSchema` variant `{ mode:'qa', stageStatus: QA_PHASES, qa: { verifiedSha: string|null, verdict:
'ready'|'not_ready'|'blocked'|null } }`, additive and defaulted. The **v1 union is not extended**.

`QA_PHASES = ['queued','verifying','ready','not_ready','failed','closed','abandoned']`. Transitions: `queued → verifying`; `verifying → ready|not_ready|failed`; `ready → verifying|not_ready`; `not_ready → verifying|ready`; `failed → verifying`; **plus `closed` and `abandoned` from every non-terminal phase** (a ticket reaching Done, or a human giving up, is a fact regardless of our phase — respond's `closed` reasoning, `pipeline.ts:82-95`). `closed`/`abandoned` are terminal.

`QA_RUNNABLE_FROM = ['queued','ready','not_ready','failed']`. `runVerify(id)` is the twin of `runRespond`
(`pipeline-service.ts:669-726`): advisory unlocked claim check, fresh load inside the lock, `transitionUnlocked(id,'verifying')` in
`preRun`, `prepareEnvironment` **before** the lock, teardown in the outer `finally`. Workspace `qa-<repo>-<ticket>-<stamp>`, branch
`qa/<TICKET>-<sha7>`, `baseRef` = the PR's **merge commit oid**, `mode:'qa'` (guard = review's deny list ∪ `Bash(gh pr create:*)`,
`Bash(gh issue:*)`, `Bash(gh api:*--method*)`) — which matches **Bash argv only**; §9/E13 states what that does and does not buy.
Nothing is ever committed.

## §3 Three entry points, one contract
`AGENT_MODES` += `'qa'`; `parseAgentsRequest` gains `start?: boolean` (default `true`). Both manual forms take the lock key the
review/respond paths take (`pr:<slug>#<n>`, or `ticket:<KEY>` for a PR-less item), so two clicks yield one session.

1. **Verify in QA** — `POST /items/ticket%2FHB-1489/agents` `{"mode":"qa"}` → `202 {session, created:true, started:true, item}`.
   Creates **and** starts, exactly like respond.
2. **Chat-only** — same URL, `{"mode":"qa","start":false}` → `200 {session, created:true, started:false, item}`. Creates the
   workspace, calls `prepareQaSession` (R73) so `BRIEF.md` exists, leaves the phase at `queued`. `chatTargetOfAgents` already
   admits any non-respond agent (`work-items.ts:844-850`), so **Chat** lights up immediately and the user clicks it.
3. **Automatic** (§7) — no HTTP: the leg calls the factory and `runVerify` directly, as reconciliation does for re-review.

Parity on a second POST: an existing non-terminal `qa` session is **never duplicated** — run in flight ⇒ `200 …started:false, reason:'a qa run is already in flight'`; claimed ⇒ `200 …reason:'a human holds the conversation claim'`; otherwise re-run (or, for `start:false`, recompose `BRIEF.md` and return). `repoUrl` is required for an item with no PR.

## §4 The brief — `renderQaBrief(ctx)` in `pipeline/prompts.ts`
Composed by the engine; the agent never receives a credential. Sections, in order:
1. `# QA VERIFICATION — <TICKET> (<repo>#<n>, merged <sha7>)`.   2. `## Ticket` — `renderTicketSection` **verbatim**: the ACs are the description text, plus status and ≤5 comments, existing caps.
3. `## The change` — PR title, `MERGED`, merge commit, author, merged-at, `changedFiles/+/−` and the **file list**, from
   `gh pr view <n> --repo <slug> --json <PR_QA_VIEW_FIELDS>` (= `PR_VIEW_FIELDS` + `mergeCommit,files`). For a **merged** PR both
   `gh pr diff <n>` and `git fetch origin pull/<n>/head` still work, and the worktree is at the merge commit so
   `git show --stat <sha>` is the offline fallback — state all three.
4. `## What we already know` — `REVIEW.md`, `FINDINGS.md`, `PLAN.md`, `COMMENTS.md` **by absolute path** (existence-checked across
   the sessions whose `lineage.ticket` is this ticket). Paths, not contents: the agent reads what it needs, the brief stays capped.
5. `## QA environment` — `renderQaEnvironmentSection(ctx)`, sibling of `renderEnvironmentSection` with the same `''` gate: QA URL,
   API base URL, the auth line (the **configured test account**: Clerk template + code, or "the email `<…>` with the password in
   `<sessionDir>/.qa-account`", or the bypass secret path), PostHog
   project, flag names, and the standing rule **never print a secret, cookie, token or `Authorization` header** into `QA.md`,
   `AGENT_NOTE` or the transcript.
6. `## How to verify` — Appendix A inlined — plus `notes(sessionDir)` and §9's permitted/forbidden list **verbatim** (R82).
7. `## Output` — the `QA.md` contract (§5), verbatim.

`renderQaPrompt({sessionDir, qaSkillCommand})`, twin of `renderReviewPrompt`: *"Run `<qaSkillCommand>` if available and follow
BRIEF.md; if it is not available follow BRIEF.md's `## How to verify` directly. Write `<sessionDir>/QA.md`. Make no code changes,
open no PR, post nothing."* Cap `QA_MAX_BRIEF_CHARS = 40_000` with `renderRespondBrief`'s truncation note.

## §5 The artifact — `QA.md`
```
# QA Verification: <TICKET> — <summary>
**Verdict:** ✅ Ready to deploy / ❌ Not ready / 🚧 Blocked — <one sentence>
**Environment:** <qa url> · merge commit <sha7> · <ISO timestamp>
## Acceptance criteria
| # | Criterion (from the ticket) | Result | Evidence |
|---|---|---|---|
| 1 | <verbatim AC> | ✅ holds / ❌ fails / ⚠️ partial / ⏭ not testable here | <route + observation, or qa-evidence/q1.png> |
## Checks
- **UI:** <routes, what was seen>  - **API/backend:** <endpoint · method · status · assertion>
- **PostHog events:** <event · seen/not seen · properties>  - **Feature flags:** <flag · state · effect>
- **Regressions / splash zone:** <what else was smoke-tested>
## Problems found
<a id="q1"></a>
### 1. <plain title>
**Severity:** 🔴 Blocker / 🟠 Major / 🟡 Minor   **Where:** <route or endpoint>   **Status:** open
**Expected (AC):** …   **Actual:** …   **Evidence:** qa-evidence/q1.png   **Why it matters:** …   **Next step:** …
## QA Verdict
- Verdict: ✅ Ready to deploy
- Blocking problems: 0
```
**Completion marker**, twin of `parsePlanReviewStatus` (`artifacts.ts:23-37`): `parseQaVerdict` requires **exactly one**
`## QA Verdict` heading (two ⇒ `missing`, fail-safe against a stale block), reads to the next heading, matches `- Verdict:` against
`✅`/`❌`/`🚧`. `evaluateQa(exit, fs, dir)` = `exitedCleanly` ∧ non-empty `QA.md` ∧ a parsed verdict, else `failed`; `ready→ready`,
`not_ready|blocked→not_ready` (R79). The transition and the `qa.verdict`/`qa.verifiedSha` patch land in **one save** (`runReview`'s
single-save discipline, `pipeline-service.ts:794-807`). A re-verification archives the old file to `QA-v<N>.md` via
`nextVersion(fs,dir,stem)`, with `nextReviewVersion` delegating to it (one test pins its behaviour unchanged).
**Plumbing:** `ARTIFACT_NAME_PATTERN` += `QA|QA-v\d+`; `pickPrimaryArtifact` gains `QA_PREFERENCE = ['QA.md','BRIEF.md']`;
`artifactRole` gains `qa` (`/^QA(-V\d+)?$/`), label **"QA verification"**, placed **first** in `PRIMARY_ORDER`.

## §6 Config
```jsonc
"environments": { "aplaceformom/grace-frontend": { "qa": {
  "url": "https://qa.example.com",                    // REQUIRED — only the user knows it
  "apiBaseUrl": "https://api-qa.example.com",         // optional
  "auth": "clerk-test" | "credentials" | "vercel-bypass" | "none",   // default "none"; "none" never auto-runs (R81)
  "account": { "email": "qa-bot@example.com", "password": "…" },     // REQUIRED for auth:"credentials"; the one new secret (R74 amended)
  "healthPath": "/", "healthTimeoutMs": 15000,
  "posthog": { "project": "grace", "host": "https://us.posthog.com" },   // optional
  "featureFlags": ["hb-1489-web-content"] } } },      // optional
"qaSkillCommand": "/cgremlin:qa-verify",
"qa": { "autoVerify": true, "maxAutoStartsPerTick": 1, "maxAttemptsPerEntry": 1, "scanBudgetMs": 20000,
        "backfillOnFirstRun": false, "keepAttemptsPerTicket": 5, "forgetAfterDays": 90 },
"jira": { "qaStatuses": ["QA", "UAT", "Ready for QA"] }
```
Secrets: `vercel.bypassSecret` **and** `qa.account.password` (R74 as amended), both under the one regime — 0600 `core.json`
(`hasAnySecret` extended), `[redacted]` in `redactCoreConfig`, the widened `redactSecrets` (R85) on every free-text path including
the artifact-read route, and 0600 `<sessionDir>/.bypass-secret` / `.qa-account` written before the run and removed in teardown. The
brief carries the **path**, never the value; no secret reaches a brief, a log line, an event frame or `QA.md`.

## §7 The automatic trigger  *(revised twice — review edits E1–E3, E5–E10, E14)*
`QaTriggerLeg` (`src/qa/qa-trigger.ts`), wired into `InventoryScanner` exactly like the Jira/threads/pr-state legs (`inventory-scanner.ts:227-250`): started **after** `inventory.updated`, **not awaited**, **single-flight**, budgeted by `qa.scanBudgetMs`, drained by `stop()`. It reads work items through a thunk (`items: () => workItems.list()`, which takes no session lock — `work/work-item.ts:12-22`) because `workItems` is built after `scanner` (`build-engine.ts:328` vs `:378`) — the shape `reconciler: { reconcile: () => tick.run() }` already uses.

**E3a — the leg is inert unless every precondition holds**, and says so once per engine start, never per tick: no `jira` source, `jira.me === null`, `qa.autoVerify === false`, or no `qa` block on the item's repo ⇒ **nothing is read and nothing is called**.

**Gates, cheapest first** (all must hold, evaluated against data the tick already has): (1) the item has a ticket, `ticket.assignee === jira.me`; (2) **E5 — status hygiene:** `ticket.status ∈ jira.qaStatuses` **and** the stored `lastStatus` was not. A status of `''`, an item with no ticket, or a snapshot whose `kind !== 'ok'` (`jira-store.ts:6,41`) is **not a status**: such a tick reads nothing, writes nothing and starts nothing, and `lastStatus` is written **only** from an `ok` scan. Without this, a Jira outage followed by recovery reads as `'' → UAT` and fires a spurious verification on every ticket at once (`work-item.ts:320-327` seeds `status: ''`). (3) every PR on the item is **`merged`** — `closed` is not landed for this purpose (E10), so a closed one ⇒ skip `pr closed without merging` — all in **one** repo, and that repo has a `qa.url`, else skip `item spans repos` (R80). The leg only ever sees PRs the engine already tracks (the inventory, the pr-state cache, or R84's one search); (4) the repo's `qa.auth !== 'none'` — else skip `no qa test account` (R81); (5) no non-terminal `qa` session for that ticket **whose run is real** (E8) and no recorded attempt for this `(key, ordinal)` (R80); (6) nothing running on that session and no live claim.

**E3b — selection is bounded BEFORE any network call.** The surviving candidates are sorted (ticket `updated` desc, ties on key) and **sliced to `maxAutoStartsPerTick` first**; only the survivors of that slice are allowed to make a `gh` call. Six tickets entering QA on one tick therefore cost **one** `gh pr view`, not six.

**E8 — a crashed `verifying` session does not wedge the ticket.** Gate (5) does not count a `qa` session at `verifying` whose id is **not** in `pipeline.activeSessionIds()`: that is a session the engine died under, not coverage. A boot sweep beside `clearAllHumanTurns` (`pipeline-service.ts:1037`, called at `serve.ts:321`) transitions every such session `verifying → failed` — the same reasoning `server.ts:182-193` already applies to a stale `reviewing`. `failed` is runnable (`QA_RUNNABLE_FROM`) and `run_failed` already makes the row attention-worthy (`attention.ts:148-153`), so the user sees it and can click.

**E10/R84 — the PR-less entry.** A ticket that enters QA with **no known PRs** (the normal case: the PR was merged without a cgremlin session) gets **one** `gh pr list --repo <slug> --search "<KEY>" --state merged --json number,title,mergeCommit,mergedAt,headRefName,author`, bounded by the same once-per-`(ticket, ordinal)` attempt record; every result is written into the **pr-state cache** so the panel keeps the PR after the leg is done. Zero matches ⇒ skip `no merged pr for <KEY>`, attempt recorded, no retry until the next entry.

**E6/R83 — health before creation.** `EnvironmentService.qaHealth(repoUrl)` runs **before** the factory: unreachable ⇒ skip `qa unreachable — <reason>`, **no session, no worktree, no tokens**, attempt recorded as `outcome:'unreachable'`. (The **manual** click keeps degrade-and-report, §9.)

**E2/E9 — reserve, then run, under the SAME lock the manual route takes.** Every start happens under the shared `KeyedLock` that `buildEngine` creates once (`build-engine.ts:127`) and hands to the pipeline, the API server and the reconciliation tick (`:136`, `:310`, `:429`) — and on the **same key** `handleItemAgents` takes: `pr:<slug>#<n>` for an item with a PR, `ticket:<KEY>` for one without. A private `qa:<KEY>` namespace (the previous draft) is a different key, so a tick and a manual POST would both pass their own lock and both create. `qa.scanBudgetMs` bounds **candidate selection and the `gh` calls only**; it never cancels or aborts a run that has started — the run's own lifecycle owns that. Inside it: **(a)** write the attempt record `{ key, identity, ordinal, attempt, reservedAt, sessionId, outcome }` and flush it — `identity` is R80's sorted `repo#n@mergeOid` join, `attempt` is the 1-based counter for this `(key, ordinal)`, and `qa.maxAttemptsPerEntry` (default **1**) is what the gate compares it against, so the cap is **data, not a hard-coded 1** — **(b)** create the session, **(c)** `awaitRunStart(…runVerify(id))`, **(d)** patch `sessionId`, and later the `verdict`. A crash between (a) and (c), or a factory that throws, leaves a record whose `outcome` says why (`reserved`, `create-failed`, `unreachable`) and whose `attempt` has already reached the cap, so the leg **never auto-retries**: the row shows the lit manual action and `qa attempt abandoned — click Verify in QA`. Recording *after* the start (the previous draft) re-fires the whole verification on the next tick after any crash.

**E7 — the Done close (R78) is not a bulldozer.** A ticket reaching `statusCategory: 'Done'` transitions a non-terminal `qa` session to `closed` **only** through `pipeline.transition` (never a direct save), and `pipeline.stop(id)` first — but a **claimed** session is left alone and reported as `skipped` (`reconciliation.ts:183-187`'s rule: a claim delays our housekeeping, never the truth about the ticket).

**E9 — observability.** The leg contributes `ScanReport.qa = { scannedAt, started: string[], skipped: [{ ticket, why }], errors: [] }`, surfaced by `cgremlin-core status` and by the panel's engine line. Every refusal above is a `skipped` **with its reason**, never an `errors` entry — the re-review leg's discipline (`reconciliation.ts:355-365`), so a claimed session cannot file an error every `pollIntervalMs`.

**E3c — the cost, correctly.** Steady state is **zero** extra calls: gates 1–6 read only the Jira snapshot and the work items the tick already has. The previous draft's "0–2 `gh` calls a tick" was wrong — it ignored R84's search and counted per tick rather than per candidate. Because selection is sliced to `maxAutoStartsPerTick` **before** any network call (E3b), the per-tick ceiling is **per slice, not per candidate**: at most `maxAutoStartsPerTick` (default **1**) × [**1** `gh pr list --search` when no PR is known + **1** `gh pr view --json mergeCommit,mergedAt` per PR on that one item + **1** `qaHealth` GET + **1** agent run]. Six tickets entering QA at once cost one of each on that tick, not six. The whole leg sits inside `qa.scanBudgetMs` (20 s) and never re-queries Jira.

**Store.** `QaTriggerStore` → `<stateDir>/qa-verifications.json`, 0600, tmp-then-rename (`DismissStore`'s shape). **E1 — a corrupt, unreadable or absent store SEEDS ONLY and starts nothing on that tick:** it is not "nothing recorded, therefore everything is new". The leg writes `lastStatus` for **every** candidate it can see and starts **at most one** — and with the amended R77 (a cold record is a seed, not an entry) that one is zero unless `backfillOnFirstRun` is set. The failure mode this closes is a truncated write turning into a fleet of verifications. **E14 — hygiene:** `attempts` is capped to the **last 5** per ticket (oldest dropped) and any ticket untouched for **90 days** is dropped entirely, both on write, so the file stays bounded without a migration. Per ticket: `{ lastStatus, lastObservedAt, ordinal, attempts: [{ key, identity, ordinal, attempt, reservedAt, sessionId, outcome }] }`, where `lastObservedAt` is **our tick's** observation time (R80) and is labelled as such wherever it is shown. **Leaves QA:** `lastStatus` updates, nothing fires. **Re-enters:** `ordinal += 1` ⇒ a new verification **even at the same shas**, previous `QA.md` archived. **A new merge while it sits in QA:** a new `key` ⇒ a new verification. **Manual is always available**, regardless of `autoVerify`, status, auth kind or a recorded attempt.

**E7 — two configuration facts an executor must write down and check.** (a) `jira.qaStatuses` must name statuses **outside** Jira's `Done` category, or `jira.jql` must be widened: the default JQL is `assignee = currentUser() AND statusCategory != Done` (`core-config.ts:79`), so a QA status that Jira classifies as Done means the ticket **never appears in the snapshot at all** and the leg can never fire. `cgremlin-core doctor` warns when any `qaStatuses` entry is seen with `statusCategory: 'Done'` in the current snapshot. (b) R78's auto-close depends on the QA session carrying the ticket key in `lineage.ticket` (set at creation) — a session created without one is never closed by the leg and must be closed by hand.

## §8 Attention, lists, the row
- `ATTENTION_REASONS` gains **`qa_not_ready`** **appended last** (position 11) — the array is the ack signature (`attention.ts:18-30`), so nothing may be re-ordered — and joins `NEEDS_YOU_REASONS`. `deriveSessionReasons` gains the twin of the respond clause: `mode==='qa' && stageStatus==='not_ready'` ⇒ `{reason:'qa_not_ready', at: lastRun?.finishedAt}`. A `ready` verdict raises **nothing** (quiet); `failed` is already covered by `run_failed`.
- **Lists:** unchanged (R71) — the item stays in `myWork` while the QA session lives. **Dismissal:** free — `WorkItemService` auto-undismisses an item whose `needsYou` turns true (`dismiss-store.ts:43-46`), so a dismissed row comes back on a not-ready verdict. **Order:** R72.
- **The row:** no second composition site. `rowMetaCells` already draws `ticketStatus` then one `phaseCell` per agent on `myWork` (`row-composition.ts:327-329`), so the row reads `grace-frontend · merged · UAT · ⛋ verifying · running`, then `… · ⛋ not_ready`. Additions are data only: `MODE_LETTER.qa='Q'`, `MODE_GLYPH.qa='⛋'`, `MODE_NAME.qa='QA verification'`, `WorkAgentMode` += `'qa'`, and `phaseCell` gains `tone:'bad'` for `qa`+`not_ready` (one line, one place). A `reserved` attempt with no session (E2) shows as the muted token `qa attempt abandoned` beside the ticket status, built in that same composer.
- **Actions** (`row-actions.ts`, outside the ladder per R70): on `myWork`/`waitingForReview`, when the item has at least one PR, **every PR is `merged`** (not merely landed — a closed-only ticket offers nothing, E10), and the repo has a `qa.url` — `Verify in QA` (`cgremlin.verifyInQa`, primary when no QA agent exists) and `Ask about QA` (`cgremlin.askQa`, inline, `start:false`). Both stay available when the leg skipped (`auth:'none'`, unreachable QA, a seeded cold record — R77 as amended), and both disappear once a non-terminal `qa` agent exists and `Chat` takes over. `itemParts` gains a `qa` part (glyph `⛋`, `stateText` = phase + verdict).

## §9 What the agent may do, and what actually enforces it  *(revised — E11–E13)*
**E12/R82 — the list, carried verbatim by this spec, the brief and the skill.** The agent **may** navigate, fill forms and submit them as a normal user, **using the configured QA test account**. It **must never**: delete records; perform admin operations; trigger anything that emails or texts a real person; capture a payment; touch another user's data; or write to Jira or GitHub. If an acceptance criterion cannot be verified inside that list, the verdict is 🚧 **Blocked** naming what was needed — never an improvised workaround.

**E11/R81 — the identity.** The automatic leg requires a configured test identity (`auth: 'clerk-test' | 'credentials' | 'vercel-bypass'`); `auth:'none'` is skipped as `no qa test account`. A manual click may run with `auth:'none'`, because a human is watching. The agent **uses the configured account and never creates users** — the per-run `+clerk_test` address of the review-path UI check is deleted here. If an AC genuinely needs a fresh account, that is a **human click**, stated in the report.

**E13 — what actually enforces this, stated without flattery.** The runner launches `claude` with `--permission-mode bypassPermissions` by default (`agent/claude-code-runner.ts:40`, `:63-64`). The `qa` deny list in `.claude/settings.local.json` matches **Bash argv patterns only**: it stops `gh pr create`, it does **not** stop `curl -X POST`, and it does **not** stop a chrome-devtools or PostHog MCP write — no `settings.local.json` rule can. **The enforceable boundary is the QA test identity's own permissions**: give it the rights a tester has and nothing more (no admin, no impersonation, no billing). Everything above that line is instruction, not enforcement, and the spec says so rather than implying a sandbox that does not exist.

**Secrets (E13/R85).** One widened redactor, `redactSecrets(text, extra?)`, replacing `redactBypassUrls` at every existing call site: the Vercel shapes it already handles, plus `Authorization: …`, `Bearer <token>`, `__session=<v>`, `set-cookie: …` and the configured `qa.account.password`. Applied on the **artifact-read route** as well (`server.ts:445-460`), because `QA.md` returns raw bytes and a QA run handles cookies and bearer tokens the review path never saw. Config secrets keep the existing regime: 0600 `core.json` (`hasAnySecret`), `[redacted]` in `redactCoreConfig`, a 0600 `<sessionDir>/.qa-account` (and `.bypass-secret`) written before the run and removed in teardown. The brief carries the **path**, never the value.

**QA unreachable (manual path).** `qaHealth` fails ⇒ the environment section reads `QA: UNREACHABLE — <reason>. Do not attempt to start anything`, the agent writes the 🚧 Blocked verdict with that reason and stops ⇒ phase `not_ready` (R79) ⇒ `qa_not_ready` ⇒ the row needs me. **No retry loop.** The automatic path never gets this far (R83).

## §10 Tests and guards an executor must write
| Guard | Assertion |
|---|---|
| **MG-18** | Every fixture in `test/fixtures/sessions-pre-phase15/` still parses; `SessionV1Schema` unchanged; a `qa` document round-trips. |
| **MG-19** | `ATTENTION_REASONS` asserted element-for-element with `qa_not_ready` **last**; an existing stored ack signature still matches. |
| **MG-20** | `parseQaVerdict`: two `## QA Verdict` headings ⇒ `missing`; a verdict in a later section is not read; `🚧` ⇒ `not_ready`. |
| **MG-21** | Grep guard: no bypass-secret value (nor `x-vercel-protection-bypass=<v>`) in a rendered QA brief, a `QA.md` fixture, a log line or an event frame. |
| **MG-22** | The trigger fires **exactly once** per `(key, ordinal)` (R80): three ticks ⇒ one create; leave-and-re-enter ⇒ a second; a new merge sha ⇒ a second; a two-PR item keys on the sorted join, and a two-repo item skips `item spans repos`. |
| **MG-28** (E1) | A **cold** store with a ticket already in a QA status creates **nothing**; the record is seeded; the next observed transition fires exactly one. `backfillOnFirstRun:true` fires at most `maxAutoStartsPerTick`. |
| **MG-29** (E2) | A crash simulated between the reserve and `run.started` leaves a `reserved` attempt and the next tick creates **nothing**; two concurrent ticks (and a tick racing a manual POST) yield **one** session. |
| **MG-30** (E3/E6) | With `auth:'none'`, no `jira.me`, a closed PR in the set, or an unreachable `qaHealth`, the leg creates **no session and no worktree** and emits the exact skip reason; the manual click still runs (and, for unreachable QA, degrades to the Blocked verdict). |
| **MG-31** (E10) | A ticket entering QA with no known PRs makes **one** `gh pr list --search` (fake asserts the argv and the call count), writes the result to the pr-state cache, and does not search again until the next ordinal. |
| **MG-32** (E13/R85) | `redactSecrets` covers `Authorization:`, `Bearer`, `__session=`, `set-cookie:`, the Vercel shapes and the configured password, is idempotent, and is applied by the artifact-read route (a `QA.md` fixture containing a bearer token comes back redacted). |
| **MG-33** (E12/R82) | The permitted/forbidden list is **byte-identical** in the spec, `renderQaBrief`'s output and `skills/qa-verify/SKILL.md` (one fixture, three assertions), and the string `+clerk_test` appears in no QA artifact. |
| **MG-34** (E1) | A **corrupt/unreadable** store with N eligible candidates ⇒ **0 starts and N seeded records**; the next tick, with the store now readable, behaves as the seeded case. |
| **MG-35** (E2) | A factory that throws ⇒ **exactly one** create attempt across **10** ticks, and the persisted record carries `{key, identity, ordinal, attempt, reservedAt, sessionId, outcome:'create-failed'}`; raising `maxAttemptsPerEntry` to 2 yields exactly two (the cap is data). |
| **MG-36** (E3b) | A cold store with **6** tickets transitioning into QA on one tick ⇒ exactly **1** `gh pr view` (fake counts argv), because selection slices before any network call. |
| **MG-37** (E5) | A Jira outage (`kind !== 'ok'`, statuses `''`) followed by recovery to `UAT` ⇒ **0 starts**, and `lastStatus` is unwritten during the outage. |
| **MG-38** (E7) | A `qaStatuses` entry whose snapshot `statusCategory` is `Done` ⇒ `doctor` warns and the leg never fires for it; a QA session with `lineage.ticket === null` is not auto-closed. |
| **MG-39** (E8) | An engine killed mid-verify ⇒ on next boot the session is `failed`, is in `QA_RUNNABLE_FROM`, raises `run_failed`, and gate (5) does **not** treat it as coverage. |
| **MG-40** (E9) | A manual `POST /items/…/agents {mode:'qa'}` and a tick firing for the same item **cannot both create**: the two contend on the *same* `KeyedLock` key (`pr:<slug>#<n>` / `ticket:<KEY>`), and the loser finds the session and returns `created:false`. |
| **MG-41** (E10) | A ticket whose only PR is **closed** shows no `Verify in QA` action, and the leg skips it as `pr closed without merging`. |
| **MG-42** (E14) | A 200-ticket store with 40 attempts each, after one tick, holds ≤5 attempts per ticket, no ticket older than 90 days, and a file **under 64 KB**. |
| **MG-23** | `autoVerify:false` ⇒ zero starts; the manual route still creates and starts. |
| **MG-24** | The leg starts nothing while a run is in flight or the session is claimed, and files a **skipped**, never an **error** (`report.errors` empty). |
| **MG-25** | `maxAutoStartsPerTick` honoured when five tickets transition into QA in one tick; the rest fire on later ticks, newest first. |
| **MG-26** | `start:false` creates the session and writes `BRIEF.md` with `stageRunner.run` never called (fake asserts zero calls); `chatTargetOfAgents` returns its id. |
| **MG-27** | Row-composition guard extended: no module outside `row-composition.ts` composes a QA token; a landed `myWork` row with a `not_ready` QA agent emits `ticketStatus` then the toned phase cell, in that order. |

Plus unit tests per task: transition legality, `QA_RUNNABLE_FROM` refusals, `evaluateQa` (dirty exit / missing file / missing verdict), every brief section rendering `''` when unconfigured, the artifact allow-list, `pickPrimaryArtifact`, and an E2E with a faked `gh`, a stub Jira and a local HTTP server standing in for QA.

## §11 Task breakdown (build in this order)
| # | Task | Tier |
|---|---|---|
| A1 | Schema: mode, stage `verify`, phases + transitions, session variant, `TERMINAL_PHASES_BY_MODE`, permission guard (the `Record<SessionMode,…>` compile errors) | executor |
| A2 | `artifacts.ts`: `parseQaVerdict`, `evaluateQa`, `nextVersion`; `validation.ts` + `api/artifacts.ts` + `artifact-labels.ts` plumbing | executor |
| A3 | `prompts.ts`: `renderQaBrief`, `renderQaEnvironmentSection`, `renderQaPrompt`, caps | executor |
| A4 | Config (`environments[*].qa`, `qaSkillCommand`, `qa.*`, `jira.qaStatuses`) + `EnvironmentService.qaHealth` and the QA brief context | executor |
| A5 | `QaSessionFactory`, `PipelineService.runVerify`, `prepareQaSession` (R73) | **executor-heavy** — locking, run-start and teardown invariants |
| A6 | API: `AGENT_MODES`, the `start` flag, the `qa` branch of `handleItemAgents`, parity rule, lock key | executor |
| A7 | Attention: `qa_not_ready`, deriver clause, `byNeedsYouThenRecent` (R72) | executor |
| A8 | `QaTriggerStore` (ordinal, full attempt record, E1 seed-only-on-corrupt, E14 hygiene), `QaTriggerLeg` (gates incl. E5 status hygiene and E8 crash-aware coverage, E3 slice-before-network, R83 health-first, R84 search, E2 reserve-then-run on the **shared** `KeyedLock` key, E7 claim-safe close, E9 `ScanReport.qa`), boot sweep `verifying → failed`, `InventoryScanner` + `build-engine` wiring, the E7 `doctor` check | **executor-heavy** — the only new agent-start path; cost discipline and the lock-key correctness |
| A9 | `redactSecrets` (R85) replacing `redactBypassUrls` at every call site + the artifact-read route; `qa.account` secret under the 0600 regime | **executor-heavy** — a redaction regression is a secret leak |
| B1 | Extension: `WorkAgentMode`, glyph/letter/name, `phaseCell` tone, `rowActions` verbs, `itemParts` QA part, two commands | executor |
| C1 | `skills/qa-verify/SKILL.md` (Appendix A), README install note, `DECISIONS.md` entries for R70/R72/R74-as-amended/R75/R77-as-amended/R82 | executor |
| C2 | E2E + MG-18…MG-42 | executor-heavy |

**Escalate, do not decide silently:** the QA URLs and auth per repo (**the user must supply them** — nothing in the repo knows them), whether `apiBaseUrl` defaults to `url`, the PostHog project name, and which PostHog MCP tool names are actually available.

## Appendix A — `skills/qa-verify/SKILL.md` (save verbatim; also inlined into the brief)
```markdown
---
name: qa-verify
description: Verify a merged ticket in a shared QA environment and write a QA.md verdict. Read-only.
---
# QA verification
You verify ONE ticket in a SHARED QA environment other people are also using. Your entire output is `QA.md` in the session directory.

**What you may and may not do (this list is binding, and it is the same list your brief carries).** You MAY navigate, fill forms
and submit them as a normal user, using the **configured QA test account**. You must NEVER: delete records; perform admin
operations; trigger anything that emails or texts a real person; capture a payment; touch another user's data; or write to Jira or
GitHub. You do not create accounts — use the account the brief names. If an acceptance criterion cannot be verified inside this
list (it needs a fresh account, a real payment, a real notification), the verdict is 🚧 Blocked naming exactly what was needed; a
human will do that step. Nothing here changes code, opens a branch or a PR, or posts a comment anywhere.

**1. Read the acceptance criteria.** BRIEF.md's `## Ticket` carries the description (the ACs live there), the status and recent
comments. Extract each AC as a numbered, testable statement, verbatim where you can; if there are no explicit ACs, derive them from
the summary + PR description and SAY SO. Then read the paths under `## What we already know` (REVIEW.md / FINDINGS.md / PLAN.md /
COMMENTS.md) for known risks and the splash zone. Do not re-review the code — you check the running system.

**2. Know what changed.** From `## The change`, map the changed files to (a) routes/screens, (b) API endpoints, (c) analytics calls, (d) feature-flag reads. That map IS your test list; anything outside it is a smoke check, not a verification.

**3. UI.** Drive the QA URL with the chrome-devtools MCP (`navigate_page`, `take_screenshot`, `evaluate_script`,
`list_console_messages`, `list_network_requests`). Sign in as **the account the brief names** — never one you invent — reading any
password or bypass secret from the file it points at; the profile is fresh every run, so sign in every run. Per AC: exercise it,
record holds / fails / partial with one line of observation and a screenshot into `qa-evidence/` for anything that is not a clean
pass. Check the console for errors and the network log for 4xx/5xx on the routes you touched. Never submit a destructive form.

**4. API / backend.** For each endpoint the diff touched, call it against the API base URL with the same session: the happy path
(assert shape and status), authentication (unauthenticated ⇒ 401/403, never 200 with data), and one error path (bad input ⇒ a sane
4xx, not a 500). Reads by default; a write only where an AC needs it, only as the configured account, only inside the binding list
above, and recorded in `QA.md` as exactly what you created. Never print an `Authorization` header, a `Bearer` token or a cookie.

**5. PostHog events.** If a PostHog MCP is available, use it READ-ONLY: query recent events for the feature's event names in the QA
project over the last hour, filtered to the test user you just used. Confirm each fires, ONCE (not twice), with the properties the
ticket or the diff implies. If no PostHog MCP is configured, verify the client-side call instead (`list_network_requests` for the
capture request, or the console) and record that as the weaker evidence it is.

**6. Feature flags.** For each flag the brief names or the diff reads, record its state in QA and whether you verified the ON path, the OFF path, or only the current one. A feature behind an OFF flag in QA is **not verified** — say so; it is not a pass.

**7. Evidence.** `qa-evidence/` beside `QA.md`: `q<N>.png` per problem plus any response bodies you assert on (redact tokens). Every problem in the report cites one.

**8. The verdict.** ✅ **Ready to deploy** — every AC holds, no blocker, no major. ❌ **Not ready** — any AC fails, or any
blocker/major problem. 🚧 **Blocked** — you could not verify: QA unreachable, auth failed, the flag is off, the build in QA predates
the merge commit. Say precisely what you needed; do NOT retry in a loop and do NOT guess. Write `QA.md` in the exact shape
BRIEF.md's `## Output` gives, ending with the `## QA Verdict` block the engine parses, then set `AGENT_STATE` to `ready` (verdict
written) or `blocked`, write one line to `AGENT_NOTE`, and STOP.
```
