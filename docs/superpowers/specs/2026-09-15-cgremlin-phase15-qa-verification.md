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
| Artifact allow-list, primary preference, tab roles/labels | `api/validation.ts:105-113`, `api/artifacts.ts:23-63`, `vscode/src/model/artifact-labels.ts:14-49` |
| Env service: 0600 bypass secret, brief context, Clerk test user | `env/environment-service.ts:695-739` |
| The auto re-review is the tick's only agent-start today (a claim ⇒ *skipped*, never *error*); background legs run after `inventory.updated`, unawaited, single-flight, budgeted, drained | `discovery/reconciliation.ts:173-188`, `:349-366`, `inventory/inventory-scanner.ts:227-259` |
| `myWork` already admits any non-review agent; landed rows sink (`byLanded` is the first key of every order); dismissal auto-clears on `needsYou` | `work/work-item.ts:620-631`, `:545-552`, `:698-711`, `attention/dismiss-store.ts:43-46` |
| The ONE row composer already draws ticket status + a phase cell per agent on `myWork` | `vscode/src/model/row-composition.ts:327-329`, `:353-355` |

## §1 Rulings I had to make (binding)
| # | Ruling | Why |
|---|---|---|
| **R68** | Mode **`qa`**, stage name **`verify`**. | Mode↔stage is never derived (`runStage` is an explicit switch, `pipeline-service.ts:948-963`); "verify" is the verb. |
| **R69** | 7 phases; terminal = `closed`/`abandoned`. `ready` is **not** terminal. | A terminal session may lose its worktree and leaves the live filters; the user keeps chatting and keeps following the ticket until deployed. |
| **R70** | QA sits **after** the forward-only ladder, not on it: `STAGE_ORDER`/`nextStages` untouched (they already return `[]` on a landed item, `row-actions.ts:120`); the QA verbs are their own rule, allowed only when **every** PR has landed. | Grafting a 4th rung re-opens `furthestStage` for every existing row. |
| **R71** | A QA session puts the item in **no new list**: `mode !== 'review'` already routes it to `myWork` (`work-item.ts:630`). Accepted consequence: manually QA-ing a teammate's PR moves that row into `myWork` — correct, the verification is my commitment. | Zero membership code, one behaviour. |
| **R72** | In `byNeedsYouThenRecent` **only**, compare `needsYou` **before** `byLanded`; the other two orders keep `byLanded` first. | A not-ready verdict on a merged item is the top of my work. Minimal rule — it also lifts `run_failed`/`comments_ready` landed rows in `myWork`, which is right. |
| **R73** | Chat-only needs a new primitive: `PipelineService.prepareQaSession(id)` composes and writes `BRIEF.md` with **no** run — no `AGENT_STATE`, no `lastRun`, no phase change; under the per-session lock, refused while a run is in flight. | `StageRunner` is the only writer of `BRIEF.md`; otherwise chat-only hands the user an empty directory. |
| **R74** | v1 QA auth is **`clerk-test` \| `vercel-bypass` \| `none`** and adds **no new secret**: `vercel-bypass` reuses `vercel.bypassSecret`, the 0600 `.bypass-secret` file and `redactBypassUrls`. A bespoke QA token is a later phase under the same regime. | A new secret needs `hasAnySecret` + `redactCoreConfig` + a redactor + teardown; reusing the proven one is free. |
| **R75** | The protocol lives **in the brief** (like `renderUiCheckProtocol`); `qaSkillCommand` (default `/cgremlin:qa-verify`) is an enhancement that degrades silently. The skill SOURCE ships here at `skills/qa-verify/SKILL.md` (Appendix A), installed by the user into `~/.claude/skills/`. | The agent runs in the TARGET repo's worktree, where a cgremlin-repo file does not exist. Mirrors `prompts.ts:478`. |
| **R76** | Auto-trigger identity = **(ticketKey, merge sha, QA-entry timestamp)**, persisted. | "Exactly once" must survive a re-scan and a restart; a new merge and a re-entry are both real new events. |
| **R77** | A **cold** record (no prior status known) counts as an entry, but the leg starts at most `qa.maxAutoStartsPerTick` (default **1**) per tick, newest ticket first. | Honours "make it automatic" without turning the first tick after install into a fleet (standing no-burn rule). |
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
`Bash(gh issue:*)`, `Bash(gh api:*--method*)`). Nothing is ever committed.

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
   API base URL, the auth line (Clerk test template + code, or "read the single line in `<sessionDir>/.bypass-secret`"), PostHog
   project, flag names, and the standing rule **never print a secret, cookie, token or `Authorization` header** into `QA.md`,
   `AGENT_NOTE` or the transcript.
6. `## How to verify` — Appendix A inlined — plus `notes(sessionDir)`.   7. `## Output` — the `QA.md` contract (§5), verbatim.

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
  "auth": "clerk-test" | "vercel-bypass" | "none",    // default "none" (R74)
  "healthPath": "/", "healthTimeoutMs": 15000,
  "posthog": { "project": "grace", "host": "https://us.posthog.com" },   // optional
  "featureFlags": ["hb-1489-web-content"] } } },      // optional
"qaSkillCommand": "/cgremlin:qa-verify",
"qa": { "autoVerify": true, "maxAutoStartsPerTick": 1, "scanBudgetMs": 20000 },
"jira": { "qaStatuses": ["QA", "UAT", "Ready for QA"] }
```
Secrets keep the existing regime exactly: `vercel.bypassSecret` only, 0600 `core.json` (`hasAnySecret`), `[redacted]` in
`redactCoreConfig`, `redactBypassUrls` on every free-text path, the 0600 `.bypass-secret` file written before the run and removed in
teardown. The brief carries the **path**, never the value; no secret reaches a brief, a log line, an event frame or `QA.md`.

## §7 The automatic trigger
`QaTriggerLeg` (`src/qa/qa-trigger.ts`), wired into `InventoryScanner` exactly like the Jira/threads/pr-state legs
(`inventory-scanner.ts:227-250`): started **after** `inventory.updated`, **not awaited**, **single-flight**, budgeted by
`qa.scanBudgetMs`, drained by `stop()`. It reads work items through a thunk (`items: () => workItems.list()`) because `workItems` is
built after `scanner` (`build-engine.ts:328` vs `:378`) — the shape `reconciler: { reconcile: () => tick.run() }` already uses.

**Fires when all hold** (cheapest first): (1) `qa.autoVerify !== false` and the item's repo has a `qa.url`; (2) the item has a
ticket and `ticket.assignee === jira.me`; (3) `ticket.status ∈ jira.qaStatuses` **and** the stored `lastStatus` was **not** — an
*entry*, not a presence; a cold record counts as an entry (R77); (4) `prs.length > 0` and **every** PR is `merged` (not `closed`);
(5) no non-terminal `qa` session for that ticket and no recorded `(ticket, sha, enteredAt)` triple (R76); (6) nothing running on
that session and no live claim. Then one `gh pr view --json mergeCommit,mergedAt` per surviving candidate (0–2 a tick) for the sha,
create, `awaitRunStart(…runVerify(id))`, record the triple. **At most `maxAutoStartsPerTick` starts per tick**, ordered by ticket
`updated` desc. Every refusal is a `skipped` with a reason, never an `errors` entry — the re-review leg's discipline
(`reconciliation.ts:355-365`), so a claimed session cannot file an error every `pollIntervalMs`.

**Store:** `QaTriggerStore` → `<stateDir>/qa-verifications.json`, 0600, tmp-then-rename, a corrupt file means "nothing recorded"
(`DismissStore`'s shape verbatim). Per ticket: `{ lastStatus, lastStatusAt, runs: [{ sha, enteredAt, sessionId, verdict }] }`.
**Leaves QA:** `lastStatus` updates, nothing fires. **Re-enters:** a new `enteredAt` ⇒ a new verification **even at the same sha**,
and the previous `QA.md` is archived. **A new merge while it sits in QA:** a new sha ⇒ a new verification. **Manual is always
available**, regardless of `autoVerify`, status or a recorded triple. **`statusCategory` becomes `Done`** ⇒ `pipeline.stop(id)`
then a transition to `closed` (R78).

## §8 Attention, lists, the row
- `ATTENTION_REASONS` gains **`qa_not_ready`** **appended last** (position 11) — the array is the ack signature
  (`attention.ts:18-30`), so nothing may be re-ordered — and joins `NEEDS_YOU_REASONS`. `deriveSessionReasons` gains the twin of
  the respond clause: `mode==='qa' && stageStatus==='not_ready'` ⇒ `{reason:'qa_not_ready', at: lastRun?.finishedAt}`. A `ready`
  verdict raises **nothing** (quiet); `failed` is already covered by `run_failed`.
- **Lists:** unchanged (R71) — the item stays in `myWork` while the QA session lives. **Dismissal:** free — `WorkItemService`
  auto-undismisses an item whose `needsYou` turns true (`dismiss-store.ts:43-46`), so a dismissed row comes back on a not-ready
  verdict. **Order:** R72.
- **The row:** no second composition site. `rowMetaCells` already draws `ticketStatus` then one `phaseCell` per agent on `myWork`
  (`row-composition.ts:327-329`), so the row reads `grace-frontend · merged · UAT · ⛋ verifying · running`, then `… · ⛋ not_ready`.
  Additions are data only: `MODE_LETTER.qa='Q'`, `MODE_GLYPH.qa='⛋'`, `MODE_NAME.qa='QA verification'`, `WorkAgentMode` += `'qa'`,
  and `phaseCell` gains `tone:'bad'` for `qa`+`not_ready` (one line, one place).
- **Actions** (`row-actions.ts`, outside the ladder per R70): on `myWork`/`waitingForReview`, when every PR has landed and the repo
  has a `qa.url` — `Verify in QA` (`cgremlin.verifyInQa`, primary when no QA agent exists) and `Ask about QA` (`cgremlin.askQa`,
  inline, `start:false`). Both disappear once a non-terminal `qa` agent exists and `Chat` takes over. `itemParts` gains a `qa` part
  (glyph `⛋`, `stateText` = phase + verdict), shown only where a QA agent or a QA verb exists.

## §9 Safety
- **Read-only against QA.** The brief forbids creating, editing or deleting data: GET-shaped API calls and navigation that does not submit. Where an AC cannot be verified without a write, the skill names the one safe path — a disposable `+clerk_test` account — and `QA.md` records exactly what was created.
- **No mutating `gh`, Jira or PostHog.** Enforced by the `qa` permission guard (§2), the brief's explicit prohibition, and
  read-only MCP queries. *Residual risk, stated plainly:* the guard covers `Bash(…)` only — an MCP server exposing a write tool is
  **not** blocked by `settings.local.json`. The brief must name the read-only tools explicitly; an executor must not claim
  enforcement it does not have.
- **Secrets.** §6, plus `redactBypassUrls` on `QA.md`/`AGENT_NOTE` at the API edge (`localStatusHttp`'s belt-and-braces, `server.ts:538-549`).
- **QA unreachable.** Before the run, `EnvironmentService.qaHealth(repoUrl)` does one `GET <url><healthPath>` within
  `healthTimeoutMs`. Failure **degrades, never throws** (R5's posture): the section reads `QA: UNREACHABLE — <reason>. Do not
  attempt to start anything`, and the agent writes the `🚧 Blocked` verdict with that reason and stops ⇒ phase `not_ready` (R79) ⇒
  `qa_not_ready` ⇒ the row needs me. **No retry loop**, and the trigger does not re-fire for the same triple — a second attempt is
  a human click.

## §10 Tests and guards an executor must write
| Guard | Assertion |
|---|---|
| **MG-18** | Every fixture in `test/fixtures/sessions-pre-phase15/` still parses; `SessionV1Schema` unchanged; a `qa` document round-trips. |
| **MG-19** | `ATTENTION_REASONS` asserted element-for-element with `qa_not_ready` **last**; an existing stored ack signature still matches. |
| **MG-20** | `parseQaVerdict`: two `## QA Verdict` headings ⇒ `missing`; a verdict in a later section is not read; `🚧` ⇒ `not_ready`. |
| **MG-21** | Grep guard: no bypass-secret value (nor `x-vercel-protection-bypass=<v>`) in a rendered QA brief, a `QA.md` fixture, a log line or an event frame. |
| **MG-22** | The trigger fires **exactly once** per (ticket, sha, entry): three ticks ⇒ one create; leave-and-re-enter ⇒ a second; a new merge sha ⇒ a second. |
| **MG-23** | `autoVerify:false` ⇒ zero starts; the manual route still creates and starts. |
| **MG-24** | The leg starts nothing while a run is in flight or the session is claimed, and files a **skipped**, never an **error** (`report.errors` empty). |
| **MG-25** | `maxAutoStartsPerTick` honoured on a cold store holding five eligible tickets. |
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
| A8 | `QaTriggerStore`, `QaTriggerLeg`, `InventoryScanner` + `build-engine` wiring, the R78 close | **executor-heavy** — the only new agent-start path; cost discipline |
| B1 | Extension: `WorkAgentMode`, glyph/letter/name, `phaseCell` tone, `rowActions` verbs, `itemParts` QA part, two commands | executor |
| C1 | `skills/qa-verify/SKILL.md` (Appendix A), README install note, `DECISIONS.md` entries for R70/R72/R74/R75 | executor |
| C2 | E2E + MG-18…MG-27 | executor-heavy |

**Escalate, do not decide silently:** the QA URLs and auth per repo (**the user must supply them** — nothing in the repo knows them), whether `apiBaseUrl` defaults to `url`, the PostHog project name, and which PostHog MCP tool names are actually available.

## Appendix A — `skills/qa-verify/SKILL.md` (save verbatim; also inlined into the brief)
```markdown
---
name: qa-verify
description: Verify a merged ticket in a shared QA environment and write a QA.md verdict. Read-only.
---
# QA verification
You verify ONE ticket in a SHARED QA environment other people are also using. You change nothing: no code, no branch, no PR, no GitHub or Jira comment, no data you were not told to create. Your entire output is `QA.md` in the session directory.

**1. Read the acceptance criteria.** BRIEF.md's `## Ticket` carries the description (the ACs live there), the status and recent
comments. Extract each AC as a numbered, testable statement, verbatim where you can; if there are no explicit ACs, derive them from
the summary + PR description and SAY SO. Then read the paths under `## What we already know` (REVIEW.md / FINDINGS.md / PLAN.md /
COMMENTS.md) for known risks and the splash zone. Do not re-review the code — you check the running system.

**2. Know what changed.** From `## The change`, map the changed files to (a) routes/screens, (b) API endpoints, (c) analytics calls, (d) feature-flag reads. That map IS your test list; anything outside it is a smoke check, not a verification.

**3. UI.** Drive the QA URL with the chrome-devtools MCP (`navigate_page`, `take_screenshot`, `evaluate_script`,
`list_console_messages`, `list_network_requests`). Authenticate as the brief says — a `+clerk_test` email plus the verification
code, or the bypass secret read from the file it names; the profile is fresh every run, so do it every run. Per AC: exercise it,
record holds / fails / partial with one line of observation and a screenshot into `qa-evidence/` for anything that is not a clean
pass. Check the console for errors and the network log for 4xx/5xx on the routes you touched. Never submit a destructive form.

**4. API / backend.** For each endpoint the diff touched, call it against the API base URL with the same session: the happy path
(assert shape and status), authentication (unauthenticated ⇒ 401/403, never 200 with data), and one error path (bad input ⇒ a sane
4xx, not a 500). GET-shaped calls only, unless an AC cannot be verified without a write — then use a disposable test account and
record exactly what you created. Never print an `Authorization` header, a cookie or a token.

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
