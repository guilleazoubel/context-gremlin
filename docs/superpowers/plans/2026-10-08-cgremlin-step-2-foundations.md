# cgremlin step 2 — Foundations: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can start a stage run fresh (no `--resume`) with the previous round's `BRIEF.md`/`FEEDBACK.md` archived; it records a development session's draft PR (`session.pr`, `active → pr_opened`) and follows it to merged/closed; it routes each stage to a model/effort from `routing.<stage>`; it writes one record per run (cost and per-model usage included); and it captures dismissed findings and rejected verdicts to `~/.cgremlin-core/feedback.jsonl`.

**Architecture:** All of it lives in the TypeScript engine (`cgremlin/core`); the VS Code extension only rebuilds to carry it, and no UI is added. `StageRunner` (`src/pipeline/stage-runner.ts`) is the single place every agent run passes through, so it gains: `fresh`/`feedback` inputs and the round archive (Task 1), a per-stage route that picks a runner and passes model/effort through `SessionContext` (Tasks 2–3), and a `runs.jsonl` record per run built from `AgentRunner.getRunStats()` (Tasks 4a–4b; a run the engine died under is recorded when it is healed). PR tracking is a read-only detection step after every develop run and on every reconciliation tick, plus a development leg for merged/closed (Task 5). Feedback capture is a `src/feedback/` module fed from engine hooks; only API routes a person calls are marked `by: 'human'` (Tasks 6a–6b).

**Tech Stack:** TypeScript (Node 24, ES2022/CommonJS), zod 3.25, vitest 2, eslint, pnpm (`cgremlin/core`, `cgremlin/vscode`); Claude Code CLI 2.1.294 (`--effort low|medium|high|xhigh|max`; stream-json `rate_limit_event`, `assistant.message.usage`, `result.usage` / `total_cost_usd` / `modelUsage`); Codex CLI 0.154 (`-m`, `-c model_reasoning_effort="…"`, `turn.completed.usage`); `gh` (read-only `pr view` / `pr list`).

**Spec:** `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md` — R90 (L60), R91 (L61), R116 (L71), R118(f), §17 (L288-305), §18 A6 (L322), §20 (L409-423). Program card: `docs/superpowers/plans/2026-10-05-cgremlin-program.md` step 2 (lines 149-156), Global Constraints (31-41), Review Focus (43-48). Decisions D1-D3 (relayed 2026-10-08, pending the user's confirmation) are folded in as Rulings S2-21 to S2-23.

## Global Constraints

Copied from the program (lines 31-41); the trailer line is generalized per Ruling S2-29.

- **Scope:** change only cgremlin (`~/context-gremlin`) and my personal `~/.claude`. **Never** change team repos (grace, grace-frontend, web-fastcar).
- **Protected actions** need my explicit approval: opening a PR for review, merging, approving, and posting review findings on others' PRs (R112). Commit, push to own branches and draft PRs are fine.
- **TDD** for behaviour; `pnpm test`, `pnpm typecheck` and `pnpm lint` pass in `cgremlin/core` and `cgremlin/vscode` before any release.
- **Isolation:** each step works in a worktree under `.claude/worktrees/<step-id>` on a branch named **`step/<step-id>`**, never `cgremlin-<id>`, which is reserved for release tags (a same-named branch and tag make `git push` fail with "matches more than one"). Branch from `mission-control-pr-orchestrator` (`main` is stale, 631 commits behind). **Commit frequently.** Push with explicit refs: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-<id> refs/tags/cgremlin-<id>`. **The release ends with cleanup**: remove the worktree, delete the merged `step/<id>` branch, update the tracker, then `/exit`. Every step starts in a new session; no `/clear` needed.
- **Release:** the `RELEASES.md` checklist: tag `cgremlin-pre-<id>` + `cgremlin-<id>`, save the `.vsix` to `~/cgremlin-releases/`, add a table row, push branch + tags.
- **Delegate** substantive work to subagents pinned per §17; trivial edits inline (R118). Optimize for **rate limits** (subscription).
- `bin/cgremlin` (legacy) is **frozen** (A5).
- **Every step that adds or changes a skill** ships ≥3 eval scenarios against today's brief as the baseline (A7, `claude plugin eval`); it replaces the brief only if it wins.
- **Never read** `~/.cgremlin/config` or `~/.cgremlin-core*/core.json` into a transcript; they contain secrets.
- Commit trailer: `Co-Authored-By: <model actually used> <noreply@anthropic.com>`. The task brief states the model: `executor` = Claude Sonnet 5.5, `executor-heavy` = Claude Opus 5.5. Every commit command below writes `<model actually used>`; substitute the model's name (e.g. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

**Step 2 specifics (every task's requirements include these):**
- Worktree `.claude/worktrees/2`, branch `step/2`, from `mission-control-pr-orchestrator`. All paths below are relative to the worktree root; run `pnpm` from `cgremlin/core` unless a step says otherwise.
- `bin/cgremlin` is not touched and **no task touches the bash↔Python-heredoc sync**. Task 7 proves it with an empty `git diff --stat mission-control-pr-orchestrator -- bin/`.
- Step 2 changes **no skill** (nothing under `plugin/skills/`), so the A7 eval rule does not trigger.
- `src/pipeline/pipeline-service.ts` lines 1-14 stay byte-identical (pinned by `pipeline-service.human-turn.test.ts` and `pipeline-service.environment.test.ts`), and `runStageLocked` keeps its `    brief: string | null,` line.
- 0c's preflight (`src/pipeline/preflight.ts` and its two tests) is not touched.
- Every `gh` call this step adds is read-only: `gh pr view` or `gh pr list`. Nothing in this step opens, edits, readies, merges, comments on or approves a PR.
- Tests use `InMemoryFileSystem` or `tmpdir()` paths. No test or command reads a real `core.json`.
- A test labelled **regression pin** passes before its task's change on purpose: it pins today's behaviour so the change cannot break it. Its "run to verify failure" step does not expect it to fail.

## Review Focus

The program's five cross-cutting items, as they apply to this step, then the step's own failure modes. Each line names the test that pins it and the task that owns it.

1. **Posting without approval (program 1).** PR detection runs headless after every develop run and on every tick. Expected: it only ever calls `gh pr view` / `gh pr list`; it can never open, ready, edit or post. Pinned: Task 5 `pr-detection.test.ts` "only ever reads: every gh call is pr view or pr list" (and `FakeGhRunner` throws on any mutating token).
2. **Untrusted text displacing instructions (program 2).** `PR_URL` and REVIEW.md titles are agent-written text the engine now reads. Expected: `PR_URL` is a hint verified against this repo, this branch, this author and `OPEN`; feedback text is redacted and capped at 300 chars. Pinned: Task 5 "a PR_URL naming another repo is never even looked up", "a stale PR_URL (another branch) is ignored", "a same-branch PR by another author is not adopted"; Task 6a "feedback text is one line, redacted and capped".
3. **Interrupted runs (program 3).** A develop run that dies or is stopped after opening its PR; a run that hits a usage limit; a run the engine dies under; a fresh round after a stopped round. Expected: the PR is still recorded (a fact); a limit-hit run's record says `stopped` with `stopReason: 'limit'`; a run the engine died under gets an `interrupted` record when healed; the next fresh round never reads the stopped round's `FEEDBACK.md`. Pinned: Task 5 "a failed develop run that already opened its PR still records it"; Task 4b "a run that hit a rejected rate limit is recorded as stopped by the limit" and "a run the engine lost gets an interrupted record when healed, and only one"; Task 1 "a fresh run with no feedback of its own still moves the stale FEEDBACK.md out of the agent's way".
4. **Shared local resources (program 4).** `feedback.jsonl` is one file for every session; `runs.jsonl` and the round archive share a session dir. Expected: concurrent appends never lose or tear a record; a torn line never swallows the next record. Pinned: Task 6a "25 concurrent appends of distinct ids keep all 25"; Task 4b `jsonl.test.ts` "never glues a record onto a torn last line".
5. **Claims of verification (program 5).** `PR_URL` is the agent's claim that it opened a PR. Expected: adopted only after `gh` confirms it is OPEN, in this repo, on this branch and by `me`; a closed, foreign or other-author PR is ignored. Pinned: Task 5 "a PR_URL whose PR is closed is not adopted" and "a same-branch PR by another author is not adopted".
6. **A fresh run must not resume.** Expected: `fresh: true` passes no resume id; a non-fresh run still resumes. Pinned: Task 1 "a fresh run never passes the session's resume id" and "a non-fresh run still resumes".
7. **Routing absent → today's behaviour.** A `core.json` with no `routing` key (every existing install). Expected: every stage runs on `runner` with `runnerOptions.model`, no `--effort`. Pinned: Task 2 "absent: every stage keeps the engine-wide runner"; Task 3 "with no routeFor every stage runs on the engine-wide runner with no model or effort" and `real-adapters.test.ts`.
8. **Inherited effort env.** VS Code launched from a shell exporting `CLAUDE_CODE_EFFORT_LEVEL`. Expected: it never reaches a spawned `claude`; the engine's env is unchanged. Pinned: Task 2 "an inherited CLAUDE_CODE_EFFORT_LEVEL never reaches the CLI".
9. **`gh` missing or unauthenticated during detection.** Expected: the develop run's result is unaffected, the session stays `active`, one log line says why. Pinned: Task 5 `pr-detection.test.ts` "gh missing or unauthenticated is a reason, never a throw" and `pipeline-service.development.test.ts` "gh missing: stays active".
10. **Stop and liveness on a routed run.** A stage routed to a runner other than the engine-wide one. Expected: `stop()` and the pid probe go to the runner that started the run. Pinned: Task 3 "stop() stops the runner the stage was routed to" and "liveness asks the routed runner for the pid".
11. **`feedback.jsonl` integrity.** Corrupt line, the same dismissal seen twice, a read of `core.json`. Expected: corrupt lines skipped, each signal recorded once, only its own file read. Pinned: Task 6a `feedback-log.test.ts` "a torn line…", "10 concurrent appends of the same id write it once", "reads and writes only its own file".
12. **Machine transitions are not human feedback.** The reconciliation tick dismisses a review when its PR merges. Expected: no feedback record; only the `/transition` and `/approve-pr` routes count. Pinned: Task 6b "a reconciliation dismissal records nothing" and `feedback-routes.test.ts` (through the API server).
13. **Run-record write failure.** Disk full or an unwritable session dir. Expected: a log line; the run's outcome and `lastRun` are unchanged. Pinned: Task 4b "a record that cannot be written is a log line, never a failed run".
14. **Restart after a PR was opened (I1).** The engine dies after the agent opened its draft PR but before detection, or the PR is opened in a Take over chat. Expected: the next reconciliation tick adopts it; a session with a live run is skipped. Pinned: Task 5 "a PR opened before an engine restart is adopted on the next tick" and "the tick leaves a session with a live run alone".
15. **A killed run has a record (I2).** Expected: a run the engine died under gets `interrupted: true` with its route; a run killed before its `result` event still reports tokens from per-message usage. Pinned: Task 4b "a run the engine lost gets an interrupted record when healed, and only one"; Task 4a "a run killed before its result reports the per-message usage".
16. **Codex as a primary runner (D1).** `routing.<stage>.runner = 'codex'` for any stage. Expected: refused (logged, that stage stays legacy); codex is still accepted inside `escalate`/`secondOpinion`; the legacy `runner: 'codex'` key is unchanged. Pinned: Task 2 "D1 — codex as the primary <stage> runner is refused" (one case per stage) and "absent with a legacy codex runner".
17. **A bad routing entry (D3).** A typo in one stage's route. Expected: the engine still boots; that stage uses the legacy runner; one log line names the entry; the other routes still apply. Pinned: Task 2 "D3 — … is reported and that stage falls back" and "loadCoreConfig loads a file with a bad routing entry"; Task 3 "D3 — a bad entry does not stop the engine".
18. **Restarted finding anchors (I4).** A fresh review run restarts at `f1`. Expected: a different finding dismissed under a reused anchor is a new record; the same finding seen twice is one. Pinned: Task 6a "a review that restarts its anchors does not swallow a different dismissed finding".

## Rulings

Judgment calls resolved here so the executors need none. Format: **what** — why — cost if wrong. S2-21 to S2-35 were added in revision 2 (2026-10-08); where they replace an earlier ruling, the earlier one is marked.

- **S2-1 `fresh` is opt-in and has no production caller yet.** `StageRunInput.fresh?: boolean` defaults to `false`; no existing stage passes `true` in step 2, and `runStageLocked` is not changed. — R90 ties fresh runs to phase rounds, which arrive in step 5. — If wrong, step 5 adds the callers it needs; nothing to undo.
- **S2-2 The round archive happens only on fresh runs.** One round number `N = max(next BRIEF-vN, next FEEDBACK-vN)` for both files. `BRIEF.md` is copied; `FEEDBACK.md` is moved and always removed. `StageRunInput.feedback` is written by the stage runner. — The `REVIEW-vN`/`QA-vN` precedent; a fresh agent must never read last round's feedback. — If wrong, the archives are inert extra files.
- **S2-3 A fresh run that reports no conversation id keeps the previous same-runner id.** — Take over must still find the last conversation. — If wrong, Take over resumes an older conversation.
- **S2-4 (revised by S2-23)** `routing` keys are `StageName`s only and route objects are strict. Originally a load error; now an offending entry is logged and ignored (S2-23).
- **S2-5 Model fallback crosses no runner family.** A route with no `model` inherits `runnerOptions.model` only when `route.runner === runner`; otherwise `null`. Effort has no legacy fallback. — `runnerOptions.model` names a model of the legacy runner's family. — If wrong, a route without a model runs on its CLI's default.
- **S2-6 (superseded for routes by S2-21)** Codex with `effort: 'max'` is refused inside `escalate`/`secondOpinion` (Codex has no `max`); the rest of S2-6 is replaced by S2-21.
- **S2-7 `escalate` and `secondOpinion` are parsed and validated only.** Nothing executes them in step 2. — YAGNI; the card asks for the config shape. — None.
- **S2-8 `CLAUDE_CODE_EFFORT_LEVEL` is removed on every Claude spawn**, routed or not, without touching `process.env`. — R116; a shell-inherited value would override routing. — A user who relied on it uses `routing.<stage>.effort`.
- **S2-9 One runner instance per kind; model and effort travel per run** on `SessionContext`. `EngineAdapters.runners` is optional; a route naming a kind with no runner fails that stage with `RunnerUnavailableError` before any agent starts. — Additive interface. — None expected.
- **S2-10 (partly superseded by S2-22, S2-25, S2-35)** Run records are per session (`<sessionsDir>/<id>/runs.jsonl`), one line per run that reached `run.started`; pre-start failures write none. `model` = routed model, else the CLI-reported one. Tokens are raw per-vendor counts. Superseded parts: "no cost field" (S2-22), "only runs that finished in-process" (S2-25), "outcome is always the process outcome" (S2-35).
- **S2-11 Limit events.** Claude: `rate_limit_event` with status `allowed_warning` (→ `warning`) or `rejected` (→ `rejected`), plus a text fallback on an error `result` only when no `rejected` was seen. Codex: `error`/`turn.failed` text matching `/usage limit|rate limit|hit your limit|too many requests|\b429\b/i`, de-duplicated. — The shapes the installed CLIs emit. — A wording change misses events; records are still written.
- **S2-12 JSONL writes rewrite the file tmp-then-rename (0600)**, the engine is the only writer, `FeedbackLog` serializes its appends in-process, and readers skip blank, torn and foreign lines. No `SessionFileSystem.appendFile` is added. — Atomic, no interface change. — A second writer process (step 11's UI) must go through the engine API.
- **S2-13 (extended by S2-24 and S2-31) PR detection after every develop run that reached the agent, whatever its outcome**, only for a `development` session at `active` with `pr: null` and a branch. It adopts only an `OPEN` PR whose head is this branch in this repo: the `PR_URL` hint first (`gh pr view`), else `gh pr list --head <branch> --state open --limit 5` with exactly one match. Adoption is one locked save. Never throws. `PipelineServiceDeps.gh` is optional. — R91. — At most two read-only `gh` calls per develop run.
- **S2-14 A non-draft PR is adopted and flagged** in `lastRun.error` (appended after any existing error). — It is a fact; the flag surfaces the protected action. — None.
- **S2-15 `runDevelop` is runnable from `active` and `pr_opened`**, not `superseded`. — The card says `pr_opened`. A self-review of a detected dev PR now really moves it to `superseded` (open question). — That user cannot run develop fix rounds from cgremlin afterwards (Take over still works).
- **S2-16 Development sessions join PR-bearing reconciliation**: own PR `MERGED → merged`, `CLOSED → abandoned`; no deliberate-start exception. — R91, and the rule the review-lineage path already applies. — Closing a draft to recreate it abandons the session.
- **S2-17 (id revised by S2-27) "Dismissal" = a REVIEW.md finding whose Status says `dismissed`** (detail block or table row), captured at `releaseConversation`, before `runReview` starts, before `runRereview` archives REVIEW.md, and on a person's transition of a review. — The engine has no dismiss-finding API; these are where REVIEW.md changes hands. — A hand edit with no later event is captured late, never lost.
- **S2-18 (scope clarified by S2-28) "Rejected verdict" = a person's API action against an engine verdict**: approving over `🔄 Request changes` → `verdict_rejected`; dismissing a review with a REVIEW.md → `review_dismissed`; abandoning an investigation at `plan_ready` with a PLAN.md → `verdict_rejected`. Only routes pass `{ by: 'human' }`. QA verdicts and sign-offs are not covered. — The API is where a person's action is observable. — None.
- **S2-19 `feedback.jsonl` lives at `<stateDir>/feedback.jsonl`** (derived `feedbackPath`, 0600); record `{v, id, at, source:'auto', kind, text, context{sessionId, mode, stage, ticket, pr, artifact, anchor}, producedBy{stage, runner, model, effort}|null, detail}`. Capture never throws or blocks. — §20 shape. — None.
- **S2-20 Nothing new is exposed over the API or in the UI**: no artifact allow-list change (`api/validation.ts:109`), no `fresh` on `POST /sessions/:id/run`. — Card: "no UI yet". — None.
- **S2-21 (D1) Codex is forbidden as a primary stage runner.** Any `routing.<stage>` whose `runner` is `codex` is refused for every stage (logged and ignored per S2-23, so the stage stays legacy). Codex stays allowed but inert inside `escalate` and `secondOpinion`. The legacy engine-wide `runner: 'codex'` is unchanged. — R116: Codex is report-only in v1, and step 2 has no report-only plumbing. — A user who wants a codex stage uses the legacy key until a later step lifts this.
- **S2-22 (D2) Run records include cost and per-model usage**: `costUsd` (Claude `result.total_cost_usd`) and `modelUsage` (Claude `result.modelUsage`, normalized to `{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUsd}` per model), both `null` when the CLI does not report them (Codex, an error `result` with `modelUsage: {}`, a killed run). The latest `result` wins rather than a sum, per the CLI's own note ("read the latest result rather than summing across results", CLI 2.1.294). — Lets step 12 compare cost per completed phase alongside quota. — On subscriptions `total_cost_usd` is an estimate; it is recorded, not trusted for billing.
- **S2-23 (D3) A bad routing entry is logged and that stage falls back to the legacy runner; the engine still boots.** `CoreConfigSchema.routing` is `z.unknown()` (raw), so `loadCoreConfig` never fails on it (today any schema error stops boot, `core-config.ts:355-359`). `parseRouting(raw)` returns `{ routes, problems }`: each unknown stage, invalid entry or D1-refused entry becomes one problem line naming `routing.<key>` and is left out of `routes`; a non-object `routing` is one problem and no routes. `buildEngine` logs each problem through a new `BuildEngineOptions.warn` (default `console.warn`, which the engine log captures). — A typo must not cost the user their whole engine. — A user can miss the log line and run on legacy without noticing; the line is written at every boot.
- **S2-24 (I1) The reconciliation tick also adopts PRs** for every `development` session that is `active`, has `pr: null`, has a branch and has no live run, by calling the now-public `PipelineService.adoptDevelopmentPr(id)` (same detection, same single locked save, same liveness and `me` checks). — Covers a run the engine died under (healed by `failStaleRuns` at boot, `serve.ts:336`) and a PR opened in a Take over chat. — One `gh pr list` per such session per tick (default 60 s); acceptable for a handful of active dev sessions.
- **S2-25 (I2) A run the engine died under gets a record.** At `run.started` the stage runner writes `<session>/.run-facts.json` (the record's known prefix: route, fresh, resumed, startedAt). Whoever removes that file writes the run's record: the stage runner when the run ends in-process, or `reconcileCrashedRun` (boot `failStaleRuns`, or a lazy heal) with `outcome: 'failed'`, `error: CRASHED_RUN_ERROR`, `interrupted: true`, no tokens. So a run healed and later reporting its exit is recorded once. A run started by a pre-step-2 engine has no facts file and gets no interrupted record. — R118f wants every run counted. — If the facts write itself fails, that run gets no interrupted record (logged).
- **S2-26 (I2) Per-message usage is the token fallback.** The Claude runner keeps each `assistant` message's `usage` by `message.id` (last one wins, since a message streams as several records), and reports their sum with `tokensSource: 'assistant'` when no `result` usage arrived (a stopped or killed run). `tokensSource` is `'result'`, `'assistant'` or `null`. — A stopped run still used quota. — The per-message sum can differ slightly from the CLI's own total.
- **S2-27 (I4) A dismissal's id includes a hash of the finding**: `finding_dismissed:<session>:<anchor>:<12 hex of sha256(normalized title + "\n" + normalized where)>`. — A fresh `runReview` restarts anchors at `f1`, so session + anchor alone would silently drop a different finding dismissed later under a reused anchor. — Editing a finding's title or location after dismissing it records it again (rare, harmless duplicate).
- **S2-28 (I5) `review_dismissed` and the plan-abandon `verdict_rejected` stay**, but they fire only from raw API calls today: the extension never calls `/transition`. The live hooks are `/approve-pr` and `/conversation/release` (plus the pre-run review/re-review captures). DECISIONS says so. — Keeps the capture complete for step 9/11 callers without pretending it is exercised now. — None.
- **S2-29 (M1) The commit trailer names the model actually used**: `Co-Authored-By: <model actually used> <noreply@anthropic.com>`, where the task brief states the model (`executor` = Claude Sonnet 5.5, `executor-heavy` = Claude Opus 5.5). — Tasks now run on different tiers. — None.
- **S2-30 (M3) `escalate` targets accept `advisor?: string`** (e.g. `fable`), validated and inert. — §17 fix round 2 is "opus · xhigh, or `--advisor fable`". — None.
- **S2-31 (M4) A PR is adopted only if its author is `me`** (case-insensitive). `me` is `CoreConfig.me`, which the schema requires (`core-config.ts:137`), passed to `PipelineConfig.me`; a pipeline wired without `me` does no detection, as with no `gh`. No extra `gh api user` call is made. — A same-branch PR by someone else (a fork, a teammate's push) is not this session's. — If `me` in `core.json` is not the gh login actually used, no PR is ever adopted (visible: sessions stay `active`; the log line says "by X, not me").
- **S2-32 (M5) A develop fix round from `pr_opened` reuses today's develop brief**, which still tells the agent to `gh pr create --draft` (`prompts.ts:643`). Recorded in DECISIONS; step 5 adds a fix-round brief. — Out of this card's scope. — The agent may try to open a second PR; `gh pr create` fails for a branch that already has one.
- **S2-33 (M6) Wiring is pinned by behaviour, not by source strings.** `buildEngine`'s routing is tested by running a stage through a built engine, and the human routes by calling the API server. Tests that pass before their task's change are labelled regression pins. — Source pins break on harmless refactors and prove nothing about behaviour. — None.
- **S2-34 (M7) `runs.jsonl` and `.run-facts.json` sit in the session dir, which the agent can write** (`--add-dir`, `stage-runner.ts:279`). Records are telemetry, not evidence: nothing gates on them in step 2. Recorded in DECISIONS. — Moving them out of the session dir is a larger change than the card. — An agent could forge or delete records; step 7/12 must not treat them as verified.
- **S2-35 (M8) A run with a `rejected` limit event is recorded with `outcome: 'stopped'` and `stopReason: 'limit'`**; a user stop is `stopReason: 'user'`; otherwise `stopReason` is `null`. A `warning` event alone does not change the outcome. `lastRun` keeps the process outcome (`failed`) in step 2; step 7's boot-resume decides how a limit-stopped run resumes. — Program Review Focus 3: a rate-limited run is "stopped", not failed. — Until step 7 the panel still shows such a run as failed.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `cgremlin/core/src/pipeline/round-archive.ts` (new) | 1 | `archiveRound(fs, sessionDir)`: R90 per-round archive |
| `cgremlin/core/src/pipeline/stage-runner.ts` | 1, 3, 4b | `fresh`/`feedback` inputs; route → runner/model/effort; run facts and per-run record |
| `cgremlin/core/src/config/routing.ts` (new) | 2 | `RUNNER_KINDS`, `EFFORT_LEVELS`, route schemas, `parseRouting`, `resolveStageRoute` |
| `cgremlin/core/src/config/core-config.ts` | 2, 6a | raw `routing` key; derived `feedbackPath` |
| `cgremlin/core/src/agent/agent-runner.ts` | 2, 4a | `SessionContext.model/effort`; `TokenUsage`, `ModelUsage`, `LimitEvent`, `RunStats`, `getRunStats?` |
| `cgremlin/core/src/agent/claude-code-runner.ts` | 2, 4a | `--model`/`--effort` per run; `claudeEnv`; usage/cost/limit/model capture |
| `cgremlin/core/src/agent/codex-runner.ts` | 2, 4a | `-m`/`-c model_reasoning_effort` per run; usage/limit capture |
| `cgremlin/core/src/agent/run-stats.ts` (new) | 4a | pure parsers for usage, cost, model usage and limit events |
| `cgremlin/core/src/fs/jsonl.ts` (new) | 4b | `appendJsonLine`, `readJsonLines` |
| `cgremlin/core/src/pipeline/run-records.ts` (new) | 4b | `RunRecordSchema`, run facts file, `appendRunRecord`, `readRunRecords` |
| `cgremlin/core/src/host/build-engine.ts` | 3, 5, 6b | wire `runners`/`routeFor`/`warn`, `gh`/`me`, `feedback` |
| `cgremlin/core/src/host/serve.ts` | 3 | `realAdapters` builds one runner per kind |
| `cgremlin/core/src/pipeline/pr-detection.ts` (new) | 5 | `detectDevelopmentPr` (read-only gh, author check) |
| `cgremlin/core/src/pipeline/pipeline-service.ts` | 4b, 5, 6b | `log` helper and interrupted records; public `adoptDevelopmentPr`; `runDevelop` from `pr_opened`; feedback hooks; `transition(…, {by})` |
| `cgremlin/core/src/discovery/reconciliation.ts` | 5 | development leg (merged/closed) and PR-adoption leg |
| `cgremlin/core/src/feedback/{review-findings,feedback-log,feedback-capture}.ts` (new) | 6a | REVIEW.md parser; `FeedbackLog`; signal → record rules |
| `cgremlin/core/src/api/server.ts` | 6b | `/transition` and `/approve-pr` pass `{ by: 'human' }` |
| `cgremlin/core/test/support/{fake-agent-runner,pipeline-harness}.ts`, `test/fixtures/fake-{claude,codex}-cli.js` | 2, 4a, 4b, 5, 6b | test seams |
| `cgremlin/core/README.md`, `cgremlin/core/docs/DECISIONS.md` | 2, 7 | config docs; decisions |

Task order and agent tier (CLAUDE.md escalation rule; none touches `bin/cgremlin` or the bash↔heredoc sync):

| Task | Deliverable | Tier |
|---|---|---|
| 1 | fresh runs + round archive | `executor` |
| 2 | routing config (D1, D3, advisor) + runner model/effort flags | `executor` |
| 3 | stage runner routes each stage; engine wiring, `warn`, behaviour tests through `buildEngine` | `executor-heavy` |
| 4a | run stats: usage, cost, model usage, limit events, per-message fallback in both runners | `executor-heavy` |
| 4b | JSONL, run records, run facts, stage-runner records, interrupted records on heal | `executor-heavy` |
| 5 | PR detection (author check), tick adoption leg, merged/closed reconciliation | `executor-heavy` |
| 6a | pure feedback modules + `feedbackPath` | `executor-heavy` |
| 6b | feedback hooks in pipeline, API routes, engine wiring | `executor-heavy` |
| 7 | DECISIONS, docs, full gates | `executor` |

---

### Task 1: Fresh runs and the per-round archive (R90)

**Files:**
- Create: `cgremlin/core/src/pipeline/round-archive.ts`
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts:58` (`StageRunInput`), `:246-247` (BRIEF write), `:252-259` (resume seed), `:321` (resume id after exit)
- Test: `cgremlin/core/test/pipeline/stage-runner.test.ts` (append a describe)

**Interfaces:**
- Consumes: `nextVersion(fs, sessionDir, stem)` and `readNonEmpty(fs, path)` from `src/pipeline/artifacts.ts`.
- Produces:
  - `StageRunInput = { sessionId: string; stage: StageName; brief: string | null; prompt: string; fresh?: boolean; feedback?: string | null }`
  - `export const ROUND_FILES = ['BRIEF', 'FEEDBACK'] as const;`
  - `export async function archiveRound(fs: SessionFileSystem, sessionDir: string): Promise<number | null>` (the round number used, or `null` when nothing was archived)
  - In `StageRunner.run`: local `carriedResumeId` (the conversation this session would continue) and `seedResumeId` (`null` when fresh). Task 3 replaces `this.deps.runnerKind` in the `runnerMismatch` line; Task 4 reads `seedResumeId`.

- [ ] **Step 1: Create the worktree and baseline.** From `/Users/guilherme.azoubel/context-gremlin`:

```bash
git worktree add .claude/worktrees/2 -b step/2 mission-control-pr-orchestrator
cd .claude/worktrees/2
cp /Users/guilherme.azoubel/context-gremlin/docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md docs/superpowers/plans/
git add docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md
git commit -m "docs(cgremlin): step 2 plan" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
(cd cgremlin/core && pnpm install --frozen-lockfile && pnpm test)
(cd cgremlin/vscode && pnpm install --frozen-lockfile)
```

Expected: core suite PASS (baseline). If it is not green before any change, stop and report.

- [ ] **Step 2: Write the failing tests.** Append to `cgremlin/core/test/pipeline/stage-runner.test.ts` (the file's `setup`, `inv`, `flush` and `InMemoryFileSystem` import already exist):

```ts
describe('R90 — fresh runs and the per-round archive', () => {
  async function seedRound(fs: InMemoryFileSystem, files: Record<string, string>): Promise<void> {
    await fs.mkdir('/sessions/inv-1', { recursive: true });
    for (const [name, text] of Object.entries(files)) await fs.writeFile(`/sessions/inv-1/${name}`, text);
  }

  it('a fresh run never passes the session’s resume id, and records the new conversation', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    const h = runner.lastHandle();
    expect(runner.getContext(h).resumeId).toBeUndefined();
    runner.setResumeId(h, 'round-2');
    runner.emitExit(h, { code: 0, signal: null });
    const { session } = await p;
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'round-2', humanTurn: null });
  });

  it('a fresh run whose agent reported no conversation id keeps the previous one, so Take over can still resume', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    const { session } = await p;
    expect(session.agent?.resumeId).toBe('prev');
  });

  it('a non-fresh run still resumes (today’s behaviour) and archives nothing', async () => {
    const { fs, runner, sr } = await setup(inv({ resumeId: 'prev' }));
    await seedRound(fs, { 'BRIEF.md': 'old brief', 'FEEDBACK.md': 'old feedback' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'new brief', prompt: 'go' });
    await flush();
    expect(runner.getContext(runner.lastHandle()).resumeId).toBe('prev');
    expect(await fs.exists('/sessions/inv-1/BRIEF-v1.md')).toBe(false);
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('new brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK.md')).toBe('old feedback');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run archives the previous round’s BRIEF.md and FEEDBACK.md under one round number, then writes its own', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'round 1 brief', 'FEEDBACK.md': 'round 1 feedback' });
    const p = sr.run({
      sessionId: 'inv-1', stage: 'plan', brief: 'round 2 brief', prompt: 'go', fresh: true, feedback: 'round 2 feedback',
    });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v1.md')).toBe('round 1 brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v1.md')).toBe('round 1 feedback');
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('round 2 brief');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK.md')).toBe('round 2 feedback');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('round numbers are shared: a round that had no FEEDBACK.md still advances the number both files use', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF-v1.md': 'r0', 'BRIEF.md': 'r1', 'FEEDBACK.md': 'f1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r2', prompt: 'go', fresh: true });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v2.md')).toBe('r1');
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v2.md')).toBe('f1');
    expect(await fs.exists('/sessions/inv-1/FEEDBACK-v1.md')).toBe(false);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run with no feedback of its own still moves the stale FEEDBACK.md out of the agent’s way', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'r1', 'FEEDBACK.md': 'stale' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r2', prompt: 'go', fresh: true });
    await flush();
    expect(await fs.exists('/sessions/inv-1/FEEDBACK.md')).toBe(false);
    expect(await fs.readFile('/sessions/inv-1/FEEDBACK-v1.md')).toBe('stale');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh run with no new brief keeps reading the current BRIEF.md (copied, not moved)', async () => {
    const { fs, runner, sr } = await setup();
    await seedRound(fs, { 'BRIEF.md': 'r1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'go', fresh: true });
    await flush();
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('r1');
    expect(await fs.readFile('/sessions/inv-1/BRIEF-v1.md')).toBe('r1');
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a fresh first round has nothing to archive', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: 'r1', prompt: 'go', fresh: true });
    await flush();
    expect((await fs.readdir('/sessions/inv-1')).filter((f) => /-v\d+\.md$/.test(f))).toEqual([]);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
  });
});
```

- [ ] **Step 3: Run to verify failure.** `cd cgremlin/core && pnpm vitest run test/pipeline/stage-runner.test.ts -t "R90"` → FAIL: the resume id is still `'prev'` and no `BRIEF-v1.md`/`FEEDBACK-v1.md` exist (vitest strips types, so the new fields compile but do nothing yet). The "keeps the previous one" and "non-fresh" cases may already pass: they pin today's behaviour.

- [ ] **Step 4: Implement `round-archive.ts`.** Create `cgremlin/core/src/pipeline/round-archive.ts`:

```ts
import type { SessionFileSystem } from '../fs/session-file-system';
import { nextVersion, readNonEmpty } from './artifacts';

/** R90 — the two files one round of a session hands its agent. */
export const ROUND_FILES = ['BRIEF', 'FEEDBACK'] as const;

/**
 * R90 — before a FRESH round writes its own hand-off, the previous round's copies are kept as
 * `<STEM>-v<N>.md`, ONE N for both files (the round they belonged to), the `REVIEW-vN`/`QA-vN`
 * precedent. BRIEF.md is COPIED: the new brief overwrites it, or a run with no new brief keeps
 * reading it. FEEDBACK.md is MOVED, and removed even when empty: a fresh agent must never read
 * the last round's feedback as this round's. Returns the round number used, or null when there
 * was nothing to archive.
 */
export async function archiveRound(fs: SessionFileSystem, sessionDir: string): Promise<number | null> {
  const present: Array<{ stem: (typeof ROUND_FILES)[number]; text: string }> = [];
  for (const stem of ROUND_FILES) {
    const text = await readNonEmpty(fs, `${sessionDir}/${stem}.md`);
    if (text !== null) present.push({ stem, text });
  }
  if (present.length === 0) {
    await fs.remove(`${sessionDir}/FEEDBACK.md`);
    return null;
  }
  let round = 1;
  for (const stem of ROUND_FILES) round = Math.max(round, await nextVersion(fs, sessionDir, stem));
  for (const { stem, text } of present) {
    await fs.writeFile(`${sessionDir}/${stem}-v${round}.md`, text);
  }
  await fs.remove(`${sessionDir}/FEEDBACK.md`);
  return round;
}
```

- [ ] **Step 5: Implement the stage-runner changes.** In `cgremlin/core/src/pipeline/stage-runner.ts`:

  1. Add `import { archiveRound } from './round-archive';` with the other imports.
  2. Replace line 58 (`export interface StageRunInput { … }`) with:

```ts
export interface StageRunInput {
  sessionId: string;
  stage: StageName;
  brief: string | null;
  prompt: string;
  /**
   * R90 — fresh means fresh: no `--resume`, whatever the session's agent record holds, and the
   * previous round's BRIEF.md/FEEDBACK.md are archived first (src/pipeline/round-archive.ts).
   * Absent/false is today's behaviour: the session's own conversation is resumed.
   */
  fresh?: boolean;
  /** R90 — this round's FEEDBACK.md, written beside BRIEF.md. Null/absent writes none. */
  feedback?: string | null;
}
```

  3. Replace the two lines at `:246-247`:

```ts
        await this.deps.fs.mkdir(sessionDir, { recursive: true });
        if (input.brief !== null) await this.deps.fs.writeFile(`${sessionDir}/BRIEF.md`, input.brief);
```

  with:

```ts
        await this.deps.fs.mkdir(sessionDir, { recursive: true });
        // R90 — a fresh round first moves the previous round's hand-off aside.
        if (input.fresh === true) await archiveRound(this.deps.fs, sessionDir);
        if (input.brief !== null) await this.deps.fs.writeFile(`${sessionDir}/BRIEF.md`, input.brief);
        if (input.feedback != null) await this.deps.fs.writeFile(`${sessionDir}/FEEDBACK.md`, input.feedback);
```

  4. Replace line `:259` (`const seedResumeId = runnerMismatch ? null : (priorAgent?.resumeId ?? null);`) with:

```ts
        // The conversation this session would continue: what a non-fresh run resumes, and what a
        // fresh run still records if its own agent reported no id (R90 — Take over must still
        // find the last conversation).
        const carriedResumeId = runnerMismatch ? null : (priorAgent?.resumeId ?? null);
        const seedResumeId = input.fresh === true ? null : carriedResumeId;
```

  5. In the post-exit block, change `?? seedResumeId;` at the end of the `const resumeId = …` line (`:321`) to `?? carriedResumeId;`.

- [ ] **Step 6: Run the tests.** `pnpm vitest run test/pipeline/stage-runner.test.ts` → PASS (new and existing). Then `pnpm test` → PASS and `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add cgremlin/core/src/pipeline/round-archive.ts cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/test/pipeline/stage-runner.test.ts
git commit -m "feat(cgremlin-core): StageRunInput.fresh (no --resume) and the per-round BRIEF/FEEDBACK archive (R90)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 2: `routing.<stage>` config and per-run model/effort flags (R116, D1, D3, M3)

**Tier / trailer:** `executor` (Claude Sonnet 5.5) — use that model in the commit trailer.

**Files:**
- Create: `cgremlin/core/src/config/routing.ts`
- Modify: `cgremlin/core/src/config/core-config.ts:134-146` (add the raw `routing` key after `runnerOptions`)
- Modify: `cgremlin/core/src/agent/agent-runner.ts:5-12` (`SessionContext`)
- Modify: `cgremlin/core/src/agent/claude-code-runner.ts:66-90` (argv, spawn env)
- Modify: `cgremlin/core/src/agent/codex-runner.ts:114-150` (`buildArgs`)
- Modify: `cgremlin/core/test/fixtures/fake-claude-cli.js` (env log)
- Modify: `cgremlin/core/README.md:63-65` (config table)
- Test: `cgremlin/core/test/config/routing.test.ts` (new), `cgremlin/core/test/agent/claude-code-runner.test.ts`, `cgremlin/core/test/agent/codex-runner.test.ts`

**Interfaces:**
- Consumes: `STAGE_NAMES`, `StageName` from `src/schema/stage.ts`.
- Produces (all in `src/config/routing.ts`):
  - `export const RUNNER_KINDS = ['claude-code', 'codex'] as const; export type RunnerKind`
  - `export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const; export type Effort`
  - `export const RouteTargetSchema`, `export const EscalationTargetSchema` (adds `advisor?: string`), `export const StageRouteSchema`; `export type RouteTarget`, `export type StageRoute = z.infer<typeof StageRouteSchema>`
  - `export interface ParsedRouting { routes: Partial<Record<StageName, StageRoute>>; problems: string[] }`; `export function parseRouting(raw: unknown): ParsedRouting` (never throws; Task 3 calls it once per engine build)
  - `export interface ResolvedRoute { stage: StageName; runner: RunnerKind; model: string | null; effort: Effort | null; source: 'routing' | 'legacy' }`
  - `export interface RoutingConfigView { runner: RunnerKind; runnerOptions: { model?: string }; routing?: Partial<Record<StageName, StageRoute>> }`; `export function resolveStageRoute(cfg: RoutingConfigView, stage: StageName): ResolvedRoute`
  - `CoreConfig.routing: unknown` (raw, default `{}`; S2-23)
  - `SessionContext.model?: string`, `SessionContext.effort?: Effort`
  - `export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` (claude-code-runner.ts)

- [ ] **Step 1: Write the failing config tests.** Create `cgremlin/core/test/config/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadCoreConfig, resolveCoreConfig } from '../../src/config/core-config';
import { parseRouting, resolveStageRoute } from '../../src/config/routing';
import { STAGE_NAMES } from '../../src/schema/stage';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const HOME = '/Users/e2e';
const base = { repos: ['acme/app'], me: 'me' };

/** What buildEngine does (Task 3): parse the raw routing once, resolve stages against the parsed routes. */
function viewOf(raw: Record<string, unknown>) {
  const cfg = resolveCoreConfig({ ...base, ...raw }, HOME);
  const parsed = parseRouting(cfg.routing);
  return { view: { runner: cfg.runner, runnerOptions: cfg.runnerOptions, routing: parsed.routes }, problems: parsed.problems };
}

describe('routing.<stage> (R116)', () => {
  it('absent: every stage keeps the engine-wide runner and runnerOptions.model, with no effort (legacy)', () => {
    const { view, problems } = viewOf({ runnerOptions: { model: 'opus' } });
    expect(problems).toEqual([]);
    for (const stage of STAGE_NAMES) {
      expect(resolveStageRoute(view, stage)).toEqual({ stage, runner: 'claude-code', model: 'opus', effort: null, source: 'legacy' });
    }
  });

  it('absent with a legacy codex runner: codex, its model, no effort (the legacy key is unchanged by D1)', () => {
    const { view, problems } = viewOf({ runner: 'codex', runnerOptions: { model: 'gpt-6.1-sol' } });
    expect(problems).toEqual([]);
    expect(resolveStageRoute(view, 'review')).toEqual({ stage: 'review', runner: 'codex', model: 'gpt-6.1-sol', effort: null, source: 'legacy' });
  });

  it('a routed stage takes runner, model and effort from routing; the others stay legacy', () => {
    const { view } = viewOf({ routing: { review: { runner: 'claude-code', model: 'opus', effort: 'high' } } });
    expect(resolveStageRoute(view, 'review')).toEqual({ stage: 'review', runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' });
    expect(resolveStageRoute(view, 'develop')).toEqual({ stage: 'develop', runner: 'claude-code', model: null, effort: null, source: 'legacy' });
  });

  it('a route with no model inherits runnerOptions.model only from the same runner family', () => {
    expect(resolveStageRoute(viewOf({ runnerOptions: { model: 'sonnet' }, routing: { plan: { runner: 'claude-code', effort: 'medium' } } }).view, 'plan').model).toBe('sonnet');
    expect(
      resolveStageRoute(viewOf({ runner: 'codex', runnerOptions: { model: 'gpt-6.1-sol' }, routing: { plan: { runner: 'claude-code', effort: 'medium' } } }).view, 'plan').model,
    ).toBeNull();
  });

  it('a hand-built view with no routing at all resolves as legacy', () => {
    expect(resolveStageRoute({ runner: 'claude-code', runnerOptions: {} }, 'findings')).toEqual({
      stage: 'findings', runner: 'claude-code', model: null, effort: null, source: 'legacy',
    });
  });

  it('parses escalate (with an advisor) and secondOpinion; codex is accepted there, and inert in step 2', () => {
    const { view, problems } = viewOf({
      routing: {
        review: {
          runner: 'claude-code', model: 'opus', effort: 'high',
          escalate: [{ runner: 'claude-code', model: 'opus', effort: 'xhigh', advisor: 'fable' }, { runner: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }],
          secondOpinion: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        },
      },
    });
    expect(problems).toEqual([]);
    expect(view.routing.review?.escalate).toEqual([
      { runner: 'claude-code', model: 'opus', effort: 'xhigh', advisor: 'fable' },
      { runner: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
    ]);
    expect(view.routing.review?.secondOpinion).toEqual({ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it.each(STAGE_NAMES)('D1 — codex as the primary %s runner is refused: logged, and the stage stays legacy', (stage) => {
    const { view, problems } = viewOf({ routing: { [stage]: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } });
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^routing\\.${stage}: .*codex`))]);
    expect(resolveStageRoute(view, stage)).toMatchObject({ runner: 'claude-code', source: 'legacy' });
  });

  it.each([
    ['an unknown stage', { implement: { runner: 'claude-code' } }],
    ['a misspelt key', { plan: { runner: 'claude-code', efort: 'high' } }],
    ['an unknown effort', { plan: { runner: 'claude-code', effort: 'ultra' } }],
    ['an unknown runner', { plan: { runner: 'gemini' } }],
    ['codex at max effort in an escalation', { plan: { runner: 'claude-code', escalate: [{ runner: 'codex', effort: 'max' }] } }],
    ['codex at max effort as a second opinion', { plan: { runner: 'claude-code', secondOpinion: { runner: 'codex', effort: 'max' } } }],
    ['a misspelt advisor key', { plan: { runner: 'claude-code', escalate: [{ runner: 'claude-code', advsor: 'fable' }] } }],
  ])('D3 — %s is reported by name, that stage falls back, and the good entries still apply', (_label, entry) => {
    const { view, problems } = viewOf({ routing: { ...entry, review: { runner: 'claude-code', effort: 'high' } } });
    expect(problems).toEqual([expect.stringMatching(/^routing\.(plan|implement): /)]);
    expect(resolveStageRoute(view, 'plan').source).toBe('legacy');
    expect(resolveStageRoute(view, 'review')).toMatchObject({ effort: 'high', source: 'routing' });
  });

  it('D3 — a routing value that is not an object is one problem, and every stage is legacy', () => {
    const { view, problems } = viewOf({ routing: 'opus everywhere' });
    expect(problems).toEqual([expect.stringMatching(/^routing: /)]);
    expect(resolveStageRoute(view, 'review').source).toBe('legacy');
  });

  it('D3 — loadCoreConfig loads a file with a bad routing entry (boot is not stopped; buildEngine reports it)', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/cfg', { recursive: true });
    const raw = { ...base, routing: { review: { runner: 'claude-code', efort: 'max' } } };
    await fs.writeFile('/cfg/test-config.json', JSON.stringify(raw));
    const cfg = await loadCoreConfig(fs, '/cfg/test-config.json', HOME);
    expect(cfg.routing).toEqual(raw.routing);
    expect(parseRouting(cfg.routing).problems).toEqual([expect.stringContaining('routing.review')]);
  });
});
```

- [ ] **Step 2: Write the failing runner tests.** Append inside `describe('ClaudeCodeRunner', …)` in `test/agent/claude-code-runner.test.ts` (add `claudeEnv` to the import from `../../src/agent/claude-code-runner`):

```ts
  it('R116 — per-run model and effort from the context override the constructor model, in a pinned argv order', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-effort-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, model: 'sonnet' });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir(), resumeId: 'seed-1', model: 'opus', effort: 'high' });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).toEqual([
        '-p', 'hello',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        '--model', 'opus',
        '--effort', 'high',
        '--resume', 'seed-1',
      ]);
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('R116 — passes no --effort when the context names none', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-noeffort-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir() });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).not.toContain('--effort');
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('R116 — an inherited CLAUDE_CODE_EFFORT_LEVEL never reaches the CLI, and the engine’s own env is left as it was', async () => {
    const envLogPath = path.join(tmpdir(), `claude-code-runner-env-${Date.now()}.json`);
    const before = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
    process.env.FAKE_CLI_ENV_LOG = envLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir(), effort: 'medium' });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(envLogPath, 'utf8'))).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: null, PATH_SET: true });
      expect(process.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
    } finally {
      delete process.env.FAKE_CLI_ENV_LOG;
      if (before === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = before;
      await rm(envLogPath, { force: true });
    }
  });

  it('claudeEnv drops only CLAUDE_CODE_EFFORT_LEVEL and never mutates its input', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_EFFORT_LEVEL: 'high', HOME: '/h' };
    expect(claudeEnv(base)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(base.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });
```

Append inside `describe('CodexRunner', …)` in `test/agent/codex-runner.test.ts`:

```ts
  it('R116 — per-run model and effort on a first turn: -m from the context, then -c model_reasoning_effort', async () => {
    await withArgvLog('effort-first', async (argvLogPath) => {
      const runner = new CodexRunner({ codexBinary: FIXTURE, sandbox: 'read-only', model: 'gpt-6-luna' });
      const handle = await runner.start({
        sessionId: 'inv-1', workingDirectory: process.cwd(), additionalDirs: ['/s/one'], model: 'gpt-6.1-sol', effort: 'high',
      });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).toEqual([
        'exec', '--json', '-s', 'read-only', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"',
        '--add-dir', '/s/one', 'hello',
      ]);
    });
  });

  it('R116 — and on a resumed turn', async () => {
    await withArgvLog('effort-resume', async (argvLogPath) => {
      const runner = new CodexRunner({ codexBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd(), resumeId: 'thread-9', effort: 'xhigh' });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).toEqual([
        'exec', 'resume', 'thread-9', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'model_reasoning_effort="xhigh"', 'hello',
      ]);
    });
  });
```

- [ ] **Step 3: Teach the fake Claude CLI to report its env.** In `test/fixtures/fake-claude-cli.js`, directly after the `if (process.env.FAKE_CLI_ARGV_LOG) { … }` block, add:

```js
if (process.env.FAKE_CLI_ENV_LOG) {
  // R116 — proves what the runner put in the child's environment, not the test's own.
  fs.writeFileSync(
    process.env.FAKE_CLI_ENV_LOG,
    JSON.stringify({
      CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
      PATH_SET: typeof process.env.PATH === 'string',
    }),
  );
}
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/config/routing.test.ts test/agent/claude-code-runner.test.ts test/agent/codex-runner.test.ts` → FAIL (`../../src/config/routing` (and `parseRouting`) not found; `claudeEnv` not exported; argv lacks `--effort`/`-c model_reasoning_effort`).

- [ ] **Step 5: Implement `routing.ts`.** Create `cgremlin/core/src/config/routing.ts`:

```ts
import { z } from 'zod';
import { STAGE_NAMES, type StageName } from '../schema/stage';

export const RUNNER_KINDS = ['claude-code', 'codex'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** Claude Code `--effort` levels (CLI 2.1.294). `max` is never a default (R118e). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** One runner · model · effort choice. Strict: a misspelt key is a problem, never a silent default. */
export const RouteTargetSchema = z
  .object({
    runner: z.enum(RUNNER_KINDS),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
  })
  .strict();
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

/** S2-30 — an escalation step may also name an advisor (`--advisor fable`, §17). Validated; inert in step 2. */
export const EscalationTargetSchema = RouteTargetSchema.extend({ advisor: z.string().min(1).optional() }).strict();

const CODEX_HAS_NO_MAX = "codex has no 'max' reasoning effort; use 'xhigh'";

/**
 * R116 / §17 — one stage's route. `escalate` (fix round 2, 3+ …) and `secondOpinion` (a
 * report-only second judge) are validated here and consumed by later steps; step 2 runs the
 * primary route only. Codex is allowed in them (inert); as the primary runner it is refused by
 * parseRouting (S2-21).
 */
export const StageRouteSchema = RouteTargetSchema.extend({
  escalate: z.array(EscalationTargetSchema).optional(),
  secondOpinion: RouteTargetSchema.optional(),
})
  .strict()
  .superRefine((route, ctx) => {
    const targets: Array<{ target: RouteTarget; path: Array<string | number> }> = [
      { target: route, path: [] },
      ...(route.escalate ?? []).map((target, i) => ({ target, path: ['escalate', i] })),
      ...(route.secondOpinion ? [{ target: route.secondOpinion, path: ['secondOpinion'] }] : []),
    ];
    for (const { target, path } of targets) {
      if (target.runner === 'codex' && target.effort === 'max') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'effort'], message: CODEX_HAS_NO_MAX });
      }
    }
  });
export type StageRoute = z.infer<typeof StageRouteSchema>;

export interface ParsedRouting {
  routes: Partial<Record<StageName, StageRoute>>;
  /** One line per ignored entry, naming it: `routing.<key>: <why>; using the legacy runner`. */
  problems: string[];
}

const STAGE_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

/**
 * D3 / S2-23 — `core.json`'s raw `routing`, parsed entry by entry. A bad entry (unknown stage,
 * invalid shape, or codex as a primary runner, S2-21) becomes ONE problem line and is left out,
 * so that stage uses the legacy runner; the other entries still apply. Never throws: the engine
 * must boot whatever this key holds.
 */
export function parseRouting(raw: unknown): ParsedRouting {
  const routes: Partial<Record<StageName, StageRoute>> = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { routes, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { routes, problems: ['routing: expected an object of stage routes; ignoring it, every stage uses the legacy runner'] };
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAGE_SET.has(key)) {
      problems.push(`routing.${key}: unknown stage (expected one of ${STAGE_NAMES.join(', ')}); ignored`);
      continue;
    }
    const result = StageRouteSchema.safeParse(value);
    if (!result.success) {
      const why = result.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'entry'}: ${i.message}`).join('; ');
      problems.push(`routing.${key}: ${why}; using the legacy runner`);
      continue;
    }
    if (result.data.runner === 'codex') {
      problems.push(`routing.${key}: codex is report-only in v1 and may not be a primary stage runner (R116); using the legacy runner`);
      continue;
    }
    routes[key as StageName] = result.data;
  }
  return { routes, problems };
}

export interface ResolvedRoute {
  stage: StageName;
  runner: RunnerKind;
  model: string | null;
  effort: Effort | null;
  /** 'routing' = a valid `routing.<stage>` entry; 'legacy' = the engine-wide `runner`/`runnerOptions`. */
  source: 'routing' | 'legacy';
}

/** What routing resolves against: the legacy keys plus the routes parseRouting accepted. */
export interface RoutingConfigView {
  runner: RunnerKind;
  runnerOptions: { model?: string };
  routing?: Partial<Record<StageName, StageRoute>>;
}

/**
 * R116 — the runner, model and effort for one stage. No (valid) entry → the engine-wide runner
 * and `runnerOptions.model`, no effort (exactly today). An entry with no model inherits
 * `runnerOptions.model` only when it names the same runner family.
 */
export function resolveStageRoute(cfg: RoutingConfigView, stage: StageName): ResolvedRoute {
  const route = cfg.routing?.[stage];
  if (route === undefined) {
    return { stage, runner: cfg.runner, model: cfg.runnerOptions.model ?? null, effort: null, source: 'legacy' };
  }
  const model = route.model ?? (route.runner === cfg.runner ? (cfg.runnerOptions.model ?? null) : null);
  return { stage, runner: route.runner, model, effort: route.effort ?? null, source: 'routing' };
}
```

- [ ] **Step 6: Add the raw `routing` key to the config schema.** In `src/config/core-config.ts`, in `CoreConfigSchema` directly after the `runnerOptions: z.object({…}).default({}),` entry, add (no import needed):

```ts
  /**
   * R116 — per-stage routes, kept RAW here and parsed by `parseRouting` (src/config/routing.ts)
   * when the engine is built: a bad entry is logged and that stage falls back to `runner`/
   * `runnerOptions` (D3, Ruling S2-23), instead of failing the whole load like every other key.
   */
  routing: z.unknown().default({}),
```

- [ ] **Step 7: `SessionContext` gains model and effort.** In `src/agent/agent-runner.ts` add `import type { Effort } from '../config/routing';` and, inside `SessionContext` after `resumeId`, add:

```ts
  /** R116 — the model for THIS run (`--model` / `-m`); overrides the runner's constructor default. */
  readonly model?: string;
  /** R116 — the effort for THIS run (Claude `--effort`, Codex `-c model_reasoning_effort`). Absent: the CLI's own default. */
  readonly effort?: Effort;
```

- [ ] **Step 8: Claude runner.** In `src/agent/claude-code-runner.ts`:

  1. Add above the class:

```ts
/**
 * R116 — the stage's route decides the effort, so a `CLAUDE_CODE_EFFORT_LEVEL` inherited from
 * whatever launched the engine (VS Code started from a shell that exported it) must not
 * override it. Removed on every spawn, routed or not; the engine's own env is never touched.
 */
export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}
```

  2. Replace the `if (this.model) { args.push('--model', this.model); }` block (`:78-80`) with:

```ts
    const model = state.ctx.model ?? this.model;
    if (model) {
      args.push('--model', model);
    }
    if (state.ctx.effort) {
      args.push('--effort', state.ctx.effort);
    }
```

  3. In the `spawn(...)` options object (`:86-90`) add `env: claudeEnv(process.env),` after `detached: true,`.

- [ ] **Step 9: Codex runner.** In `src/agent/codex-runner.ts` `buildArgs`, replace `if (this.model) { args.push('-m', this.model); }` with:

```ts
    const model = state.ctx.model ?? this.model;
    if (model) {
      args.push('-m', model);
    }
    if (state.ctx.effort) {
      // R116 — TOML-quoted like sandbox_mode above; accepted on `exec` and `exec resume`.
      args.push('-c', `model_reasoning_effort="${state.ctx.effort}"`);
    }
```

- [ ] **Step 10: Document the key.** In `cgremlin/core/README.md`, after the `runnerOptions.sandbox` row (line 65) add:

```markdown
| `routing.<stage>` | — | R116 per-stage route for `findings`, `plan`, `develop`, `review`, `rereview`, `respond`, `verify`: `{ "runner": "claude-code", "model"?: string, "effort"?: "low" \| "medium" \| "high" \| "xhigh" \| "max", "escalate"?: [route + "advisor"?…], "secondOpinion"?: route }`. A stage with no entry uses `runner`/`runnerOptions` exactly as before; a route with no `model` inherits `runnerOptions.model` only from the same runner. Codex may not be a primary stage runner in this version (it is accepted, unused, inside `escalate`/`secondOpinion`, and has no `max`). A bad entry never stops the engine: it is logged at start-up as `routing.<stage>: …` and that stage uses the legacy runner. `escalate`/`secondOpinion` are validated now and used by later steps. Claude runs never inherit `CLAUDE_CODE_EFFORT_LEVEL`. |
```

- [ ] **Step 11: Run.** `pnpm vitest run test/config test/agent` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 12: Commit.**

```bash
git add cgremlin/core/src/config cgremlin/core/src/agent cgremlin/core/test/config/routing.test.ts cgremlin/core/test/agent cgremlin/core/test/fixtures/fake-claude-cli.js cgremlin/core/README.md
git commit -m "feat(cgremlin-core): routing.<stage> config; runners take model/effort per run; claude never inherits CLAUDE_CODE_EFFORT_LEVEL (R116)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 3: The stage runner routes each stage; the engine wires one runner per kind (R116, D3, M6)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts` (`StageRunnerDeps` `:47-57`, `ActiveRun` `:91`, `isEntryAlive` `:176-181`, `stop` `:183-189`, `run` `:191-387`)
- Modify: `cgremlin/core/src/host/build-engine.ts:50-63` (`EngineAdapters`), `BuildEngineOptions` (`warn`), `:236-258` (parse `routing`; `new StageRunner`)
- Modify: `cgremlin/core/src/host/serve.ts:469-477` (`realAdapters`)
- Test: `cgremlin/core/test/pipeline/stage-runner.routing.test.ts` (new), `cgremlin/core/test/host/real-adapters.test.ts` (new), `cgremlin/core/test/host/build-engine.routing.test.ts` (new)

**Interfaces:**
- Consumes: `ResolvedRoute`, `RunnerKind`, `parseRouting`, `resolveStageRoute` (Task 2); `SessionContext.model/effort` (Task 2); `carriedResumeId`/`seedResumeId` (Task 1).
- Produces:
  - `StageRunnerDeps.runners?: Partial<Record<RunnerKind, AgentRunner>>`, `StageRunnerDeps.routeFor?: (stage: StageName) => ResolvedRoute`; `runnerKind: RunnerKind` (same two values as before).
  - `export class RunnerUnavailableError extends Error` (name `'RunnerUnavailableError'`).
  - Inside `run()`: locals `route: ResolvedRoute` and `runner: AgentRunner` (Task 4b records them).
  - `BuildEngineOptions.warn?: (line: string) => void` (D3 problems are logged through it).
  - `EngineAdapters.runners?: Partial<Record<RunnerKind, AgentRunner>>`; `realAdapters(config)` returns `runners` with both kinds and `runner === runners[config.runner]`.

- [ ] **Step 1: Write the failing stage-runner tests.** These drive `StageRunner` with an injected `routeFor`, so they may route to codex: config refuses codex as a PRIMARY route (S2-21), but escalation and second-opinion steps will route to it later, so the runner must handle any kind. Create `cgremlin/core/test/pipeline/stage-runner.routing.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { KeyedLock } from '../../src/api/keyed-lock';
import { RunnerUnavailableError, StageRunner } from '../../src/pipeline/stage-runner';
import type { ResolvedRoute } from '../../src/config/routing';
import type { StageName } from '../../src/schema/stage';
import { migrateV1ToV2 } from '../../src/schema/session';

const sessionsDir = '/sessions';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function inv(resumeId: string | null) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if (resumeId !== null) s.agent = { runner: 'claude-code', resumeId, humanTurn: null };
  return s;
}

const toCodex = (stage: StageName): ResolvedRoute =>
  stage === 'review'
    ? { stage, runner: 'codex', model: 'gpt-6.1-sol', effort: 'high', source: 'routing' }
    : { stage, runner: 'claude-code', model: null, effort: null, source: 'legacy' };

function started(runner: FakeAgentRunner): boolean {
  try {
    runner.lastHandle();
    return true;
  } catch {
    return false;
  }
}

async function setup(opts: { routeFor?: (stage: StageName) => ResolvedRoute; withCodex?: boolean; resumeId?: string | null } = {}) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, sessionsDir);
  await store.save(inv(opts.resumeId ?? null));
  await fs.mkdir('/w/inv-1', { recursive: true });
  const claude = new FakeAgentRunner();
  const codex = new FakeAgentRunner();
  const sr = new StageRunner({
    runner: claude,
    runnerKind: 'claude-code',
    ...(opts.withCodex === false ? {} : { runners: { 'claude-code': claude, codex } }),
    ...(opts.routeFor ? { routeFor: opts.routeFor } : {}),
    store, fs, events: new EngineEvents(), sessionsDir,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    lock: new KeyedLock(),
  });
  return { fs, store, claude, codex, sr };
}

describe('R116 — the stage runner routes each stage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a stage routed to codex starts on the codex runner with the route’s model and effort; the engine-wide runner is never started', async () => {
    const { claude, codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: '# b', prompt: 'go' });
    await flush();
    expect(started(claude)).toBe(false);
    expect(codex.getContext(codex.lastHandle())).toEqual({
      sessionId: 'inv-1', workingDirectory: '/w/inv-1', additionalDirs: ['/sessions/inv-1'], resumeId: undefined,
      model: 'gpt-6.1-sol', effort: 'high',
    });
    codex.emitExit(codex.lastHandle(), { code: 0, signal: null });
    const { session } = await p;
    expect(session.agent?.runner).toBe('codex');
  });

  it('a stage the route leaves on legacy runs on the engine-wide runner', async () => {
    const { claude, codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    expect(started(codex)).toBe(false);
    claude.emitExit(claude.lastHandle(), { code: 0, signal: null });
    expect((await p).session.agent?.runner).toBe('claude-code');
  });

  it('with no routeFor every stage runs on the engine-wide runner with no model or effort in the context (legacy)', async () => {
    const { claude, sr } = await setup({ withCodex: false });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const ctx = claude.getContext(claude.lastHandle());
    expect('model' in ctx).toBe(false);
    expect('effort' in ctx).toBe(false);
    claude.emitExit(claude.lastHandle(), { code: 0, signal: null });
    await p;
  });

  it('a route naming a runner the engine does not have fails the stage before any agent starts', async () => {
    const { claude, store, sr } = await setup({ routeFor: toCodex, withCodex: false });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' })).rejects.toBeInstanceOf(
      RunnerUnavailableError,
    );
    expect(started(claude)).toBe(false);
    expect((await store.load('inv-1')).lastRun).toMatchObject({
      stage: 'review', outcome: 'failed', error: expect.stringContaining("routed to runner 'codex'"),
    });
    expect(sr.activeSessionIds()).toEqual([]);
  });

  it('stop() stops the runner the stage was routed to', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const h = codex.lastHandle();
    expect(await sr.stop('inv-1')).toBe(true);
    expect(codex.isStopped(h)).toBe(true);
    codex.emitExit(h, { code: null, signal: 'SIGTERM' });
    expect((await p).outcome).toBe('stopped');
  });

  it('liveness asks the routed runner for the pid', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    const h = codex.lastHandle();
    codex.setPid(h, 4242);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(sr.activeSessionIds()).toEqual([]);
    codex.emitExit(h, { code: null, signal: 'SIGKILL' });
    await p;
  });

  it('a session last run on claude-code, routed to codex, starts a fresh conversation and notes the switch', async () => {
    const { codex, sr } = await setup({ routeFor: toCodex, resumeId: 'claude-sess-1' });
    const p = sr.run({ sessionId: 'inv-1', stage: 'review', brief: null, prompt: 'go' });
    await flush();
    expect(codex.getContext(codex.lastHandle()).resumeId).toBeUndefined();
    codex.emitExit(codex.lastHandle(), { code: 0, signal: null });
    const { session } = await p;
    expect(session.lastRun?.error).toBe('runner changed from claude-code to codex; started a fresh conversation');
  });
});
```

- [ ] **Step 2: Write the failing wiring tests.** Create `cgremlin/core/test/host/real-adapters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { realAdapters } from '../../src/host/serve';
import { resolveCoreConfig } from '../../src/config/core-config';
import { ClaudeCodeRunner } from '../../src/agent/claude-code-runner';
import { CodexRunner } from '../../src/agent/codex-runner';

describe('R116 — one runner per kind', () => {
  it.each(['claude-code', 'codex'] as const)('engine-wide runner %s is the same instance as runners[kind], and both kinds exist', (kind) => {
    const adapters = realAdapters(resolveCoreConfig({ me: 'me', runner: kind }, '/h'));
    expect(adapters.runnerKind).toBe(kind);
    expect(adapters.runners?.['claude-code']).toBeInstanceOf(ClaudeCodeRunner);
    expect(adapters.runners?.codex).toBeInstanceOf(CodexRunner);
    expect(adapters.runner).toBe(adapters.runners?.[kind]);
  });
});
```

Create `cgremlin/core/test/host/build-engine.routing.test.ts` (M6: the wiring is pinned by running a stage through a built engine, not by a source string):

```ts
import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig } from '../../src/config/core-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import type { SessionContext } from '../../src/agent/agent-runner';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function engineWith(routing: unknown) {
  const fs = new InMemoryFileSystem();
  const runner = new FakeAgentRunner();
  const warnings: string[] = [];
  const config = resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', sessionsDir: '/sessions', worktreesDir: '/worktrees', mirrorsDir: '/mirrors', routing },
    '/home/e2e',
  );
  const adapters: EngineAdapters = {
    fs, git: new FakeGitRunner(fs), gh: new FakeGhRunner(), runner, runnerKind: 'claude-code',
    clock: new FakeClock(), now: () => new Date('2026-10-08T12:00:00.000Z'),
  };
  const engine = buildEngine(config, adapters, { warn: (line) => warnings.push(line) });
  return { engine, runner, warnings };
}

/** Runs a findings stage through the built engine and returns the context its agent was started with. */
async function findingsContext(engine: ReturnType<typeof buildEngine>, runner: FakeAgentRunner): Promise<SessionContext> {
  const session = await engine.pipeline.createInvestigationSession({
    repoUrl: '/origin/acme-app', ticket: 'APP-1', intent: 'investigate_only', driveToCompletion: false,
  });
  const run = engine.pipeline.runFindings(session.id);
  await flush();
  await flush();
  const ctx = runner.getContext(runner.lastHandle());
  runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
  await run;
  return ctx;
}

describe('buildEngine routes stages from core.json (R116)', () => {
  it('a routed stage reaches the runner with its model and effort', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'claude-code', model: 'opus', effort: 'high' } });
    expect(warnings).toEqual([]);
    expect(await findingsContext(engine, runner)).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('D3 — a bad entry does not stop the engine: it is logged by name and that stage runs on the legacy runner', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'claude-code', efort: 'high' } });
    expect(warnings).toEqual([expect.stringContaining('routing.findings')]);
    const ctx = await findingsContext(engine, runner);
    expect('effort' in ctx).toBe(false);
    expect('model' in ctx).toBe(false);
  });

  it('D1 — codex named as a primary runner is logged and ignored', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'codex', effort: 'high' } });
    expect(warnings).toEqual([expect.stringMatching(/routing\.findings: .*codex/)]);
    expect('effort' in (await findingsContext(engine, runner))).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure.** `pnpm vitest run test/pipeline/stage-runner.routing.test.ts test/host/real-adapters.test.ts test/host/build-engine.routing.test.ts` → FAIL (`RunnerUnavailableError` not exported; codex never started; `adapters.runners` undefined; `buildEngine` ignores `routing` and has no `warn` option).

- [ ] **Step 4: Implement in `stage-runner.ts`.**

  1. Imports: change the agent import to `import type { AgentExitResult, AgentHandle, AgentRunner } from '../agent/agent-runner';` (unchanged) and add `import type { ResolvedRoute, RunnerKind } from '../config/routing';`.
  2. Add after `WorktreeGoneError`:

```ts
/** R116 — a stage routed to a runner kind this engine was not given. Fails the stage before any agent starts. */
export class RunnerUnavailableError extends Error {
  constructor(stage: StageName, kind: RunnerKind) {
    super(`Stage '${stage}' is routed to runner '${kind}', but no ${kind} runner is wired in this engine`);
    this.name = 'RunnerUnavailableError';
  }
}
```

  3. In `StageRunnerDeps`, change `runnerKind: 'claude-code' | 'codex';` to `runnerKind: RunnerKind;` and add after `runner: AgentRunner;`:

```ts
  /**
   * R116 — one runner per kind, for stages routed away from `runnerKind`. `runner` is used for
   * `runnerKind` when this has no entry for it. A route naming a kind found in neither fails
   * that stage with RunnerUnavailableError.
   */
  runners?: Partial<Record<RunnerKind, AgentRunner>>;
  /** R116 — the route for a stage. Absent: every stage is `{ runner: runnerKind, model: null, effort: null }` (today). */
  routeFor?: (stage: StageName) => ResolvedRoute;
```

  4. `interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean }` becomes:

```ts
/** `runner` is the runner THIS run was routed to: stop() and the pid probe must ask it, not the default. */
interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean; runner: AgentRunner }
```

  5. In `isEntryAlive`, `this.deps.runner.getPid?.(run.handle)` → `run.runner.getPid?.(run.handle)`. In `stop`, `this.deps.runner.stop(run.handle)` → `run.runner.stop(run.handle)`.
  6. Add two private methods after `stop`:

```ts
  /** R116 — the route for `stage`; without `routeFor`, today's single engine-wide runner. */
  private routeOf(stage: StageName): ResolvedRoute {
    return this.deps.routeFor?.(stage) ?? { stage, runner: this.deps.runnerKind, model: null, effort: null, source: 'legacy' };
  }

  private runnerOf(stage: StageName, kind: RunnerKind): AgentRunner {
    const runner = this.deps.runners?.[kind] ?? (kind === this.deps.runnerKind ? this.deps.runner : undefined);
    if (runner === undefined) throw new RunnerUnavailableError(stage, kind);
    return runner;
  }
```

  7. In `run()`: the reservation becomes `const active: ActiveRun = { handle: null, stopRequested: false, runner: this.deps.runner };`. As the FIRST statements inside the inner `try {` (before the `if (!(await this.deps.fs.exists(worktreePath)))` check) add:

```ts
        // R116 — the stage's route picks the runner, model and effort. Resolved first, inside this
        // try, so a route naming a runner this engine lacks fails the stage (recorded in lastRun)
        // before the worktree is touched or any agent starts.
        const route = this.routeOf(stage);
        const runner = this.runnerOf(stage, route.runner);
        active.runner = runner;
```

  8. Inside the inner try, replace every remaining `this.deps.runnerKind` with `route.runner` (the `runnerMismatch` line, the pre-run `agent:` record, the runner-change note and the post-exit merged `agent:` record) and every remaining `this.deps.runner` with `runner` (`start`, `onOutput`, `onExit`, `stop`, `sendPrompt`, `getResumeId`).
  9. Replace the `runner.start({ … })` argument with:

```ts
            const handle = await runner.start({
              sessionId,
              workingDirectory: worktreePath,
              additionalDirs: [sessionDir],
              resumeId: seedResumeId ?? undefined,
              // R116 — only what the route names; absent keeps the runner's own default.
              ...(route.model !== null ? { model: route.model } : {}),
              ...(route.effort !== null ? { effort: route.effort } : {}),
            });
```

  Verify with `grep -n "this.deps.runner" src/pipeline/stage-runner.ts` → only the `runnerOf` fallback and the reservation line remain.

- [ ] **Step 5: Wire the engine.** In `src/host/build-engine.ts`: add `import { parseRouting, resolveStageRoute, type RunnerKind } from '../config/routing';`; in `EngineAdapters` change `runnerKind: 'claude-code' | 'codex';` to `runnerKind: RunnerKind;` and add after `runner: AgentRunner;`:

```ts
  /** R116 — one runner per kind for routed stages; absent means every stage uses `runner`. */
  runners?: Partial<Record<RunnerKind, AgentRunner>>;
```

  In `BuildEngineOptions` add:

```ts
  /** One line per degraded start-up condition (a `routing` entry that was ignored, D3). Defaults to `console.warn`, which the engine log captures. */
  warn?: (line: string) => void;
```

  At the top of `buildEngine`'s body (after the `const … = config.…!` lines), add:

```ts
  // D3 / S2-23 — `routing` is parsed here, once per boot: a bad entry is logged by name and
  // that stage keeps the legacy runner; it never stops the engine.
  const routing = parseRouting(config.routing);
  for (const problem of routing.problems) (opts.warn ?? ((line: string) => console.warn(line)))(`config: ${problem}`);
  const routingView = { runner: config.runner, runnerOptions: config.runnerOptions, routing: routing.routes };
```

  In the `new StageRunner({ … })` call add, after `runnerKind: adapters.runnerKind,`:

```ts
    runners: adapters.runners,
    routeFor: (stage) => resolveStageRoute(routingView, stage),
```

  In `src/host/serve.ts` replace `realAdapters`' runner construction (`:472-476`) with:

```ts
  // R116 — one runner per kind. The engine-wide `runnerOptions.model` belongs to the engine-wide
  // runner's family only; routed runs pass their own model per run.
  const runners = {
    'claude-code': new ClaudeCodeRunner({
      model: config.runner === 'claude-code' ? config.runnerOptions.model : undefined,
      permissionMode: config.runnerOptions.permissionMode,
    }),
    codex: new CodexRunner({
      model: config.runner === 'codex' ? config.runnerOptions.model : undefined,
      sandbox: config.runnerOptions.sandbox,
    }),
  };
  return { fs, git, gh, runner: runners[config.runner], runners, runnerKind: config.runner, localApp: new NodeLocalAppRunner() };
```

- [ ] **Step 6: Run.** `pnpm vitest run test/pipeline/stage-runner.routing.test.ts test/host/real-adapters.test.ts test/host/build-engine.routing.test.ts test/host/build-engine.test.ts test/pipeline/stage-runner.test.ts test/pipeline/stage-runner.workspace-refresh.test.ts` → PASS; then `pnpm test && pnpm typecheck && pnpm lint` → PASS (every existing harness constructs `StageRunner` without `runners`/`routeFor`, which is the legacy path).

- [ ] **Step 7: Commit.**

```bash
git add cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/src/host/serve.ts cgremlin/core/test/pipeline/stage-runner.routing.test.ts cgremlin/core/test/host/real-adapters.test.ts cgremlin/core/test/host/build-engine.routing.test.ts
git commit -m "feat(cgremlin-core): the stage runner routes each stage to its runner, model and effort; one runner per kind (R116)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 4a: Run stats in both runners — usage, cost, model usage, limit events (R116, R118f, D2)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Create: `cgremlin/core/src/agent/run-stats.ts`
- Modify: `cgremlin/core/src/agent/agent-runner.ts` (types + `getRunStats?`)
- Modify: `cgremlin/core/src/agent/claude-code-runner.ts` (`ClaudeCodeRunnerOptions.now`, `ClaudeAgentState`, `handleLine`, `getRunStats`)
- Modify: `cgremlin/core/src/agent/codex-runner.ts` (`CodexRunnerOptions.now`, `CodexAgentState`, `handleLine`, `getRunStats`)
- Modify: `cgremlin/core/test/fixtures/fake-claude-cli.js`, `cgremlin/core/test/fixtures/fake-codex-cli.js`
- Test: `cgremlin/core/test/agent/run-stats.test.ts` (new), `cgremlin/core/test/agent/claude-code-runner.test.ts`, `cgremlin/core/test/agent/codex-runner.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` (`src/config/core-config.ts`).
- Produces (in `src/agent/agent-runner.ts`):
  - `TokenUsage { input; output; cacheRead; cacheWrite: number }`
  - `ModelUsage { inputTokens; outputTokens; cacheReadInputTokens; cacheCreationInputTokens; webSearchRequests: number; costUsd: number | null }`
  - `LimitEvent { at: string; kind: 'warning' | 'rejected'; limitType: string | null; resetsAt: string | null; message: string | null }`
  - `RunStats { tokens: TokenUsage | null; tokensSource: 'result' | 'assistant' | null; costUsd: number | null; modelUsage: Readonly<Record<string, ModelUsage>> | null; limitEvents: readonly LimitEvent[]; observedModel: string | null }`
  - `AgentRunner.getRunStats?(handle: AgentHandle): RunStats | undefined`
  - `src/agent/run-stats.ts`: `tokensFromClaudeUsage`, `tokensFromCodexUsage`, `addTokens`, `modelUsageFromClaude`, `costFromClaude`, `limitEventFromClaude`, `limitEventFromMessage`.

- [ ] **Step 1: Write the failing pure tests.** Create `cgremlin/core/test/agent/run-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addTokens,
  costFromClaude,
  limitEventFromClaude,
  limitEventFromMessage,
  modelUsageFromClaude,
  tokensFromClaudeUsage,
  tokensFromCodexUsage,
} from '../../src/agent/run-stats';

const AT = new Date('2026-10-08T12:00:00.000Z');

describe('run stats parsers', () => {
  it('reads Claude usage, cache counters included', () => {
    expect(tokensFromClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 })).toEqual({
      input: 10, output: 5, cacheRead: 100, cacheWrite: 7,
    });
    expect(tokensFromClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null })).toEqual({
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
    });
    expect(tokensFromClaudeUsage(undefined)).toBeNull();
    expect(tokensFromClaudeUsage({ server_tool_use: {} })).toBeNull();
  });

  it('reads Codex turn.completed.usage', () => {
    expect(tokensFromCodexUsage({ input_tokens: 12886, cached_input_tokens: 4480, cache_write_input_tokens: 0, output_tokens: 19, reasoning_output_tokens: 11 })).toEqual({
      input: 12886, output: 19, cacheRead: 4480, cacheWrite: 0,
    });
    expect(tokensFromCodexUsage('nope')).toBeNull();
  });

  it('adds token counts', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(addTokens(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
    expect(addTokens(null, a)).toEqual(a);
    expect(addTokens(a, null)).toEqual(a);
    expect(addTokens(null, null)).toBeNull();
  });

  it('D2 — reads Claude modelUsage per model and total_cost_usd; an empty modelUsage is null', () => {
    expect(
      modelUsageFromClaude({
        'claude-opus-5-5': {
          inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800,
          webSearchRequests: 0, costUSD: 0.42, contextWindow: 200000, maxOutputTokens: 64000,
        },
        'claude-haiku-5': { inputTokens: 10, outputTokens: 2 },
      }),
    ).toEqual({
      'claude-opus-5-5': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800, webSearchRequests: 0, costUsd: 0.42 },
      'claude-haiku-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUsd: null },
    });
    expect(modelUsageFromClaude({})).toBeNull();
    expect(modelUsageFromClaude(undefined)).toBeNull();
    expect(costFromClaude(0.42)).toBe(0.42);
    expect(costFromClaude('0.42')).toBeNull();
  });

  it('Claude rate_limit_event: allowed is no event; allowed_warning is a warning; rejected is rejected', () => {
    expect(limitEventFromClaude({ status: 'allowed', rateLimitType: 'five_hour' }, AT)).toBeNull();
    expect(limitEventFromClaude({ status: 'allowed_warning', resetsAt: 1791460800, rateLimitType: 'five_hour', utilization: 0.91 }, AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'warning', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null,
    });
    expect(limitEventFromClaude({ status: 'rejected' }, AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null, message: null,
    });
    expect(limitEventFromClaude(null, AT)).toBeNull();
  });

  it('a limit message is a rejected event with its first line, capped; anything else is not', () => {
    expect(limitEventFromMessage("You've hit your usage limit. Try again in 2 hours.\nmore", AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null,
      message: "You've hit your usage limit. Try again in 2 hours.",
    });
    expect(limitEventFromMessage('429 Too Many Requests', AT)?.kind).toBe('rejected');
    expect(limitEventFromMessage(`rate limit ${'x'.repeat(400)}`, AT)?.message?.length).toBe(201);
    expect(limitEventFromMessage('Failed to authenticate: OAuth session expired', AT)).toBeNull();
  });
});
```

- [ ] **Step 2: Add the fixture branches.** In `test/fixtures/fake-claude-cli.js`, before the final `} else {` branch, add:

```js
} else if (prompt === 'USAGE_AND_LIMIT') {
  // R118f/D2 — the real CLI's shapes (2.1.294): init carries the model, rate_limit_event the
  // quota state, and the result its usage, cost and per-model usage. `allowed` is no event.
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: sessionId });
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, uuid: 'u0', session_id: sessionId });
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1791460800, rateLimitType: 'five_hour', utilization: 0.91 }, uuid: 'u1', session_id: sessionId });
  line({
    type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 },
    total_cost_usd: 0.42,
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800,
        webSearchRequests: 0, costUSD: 0.42, contextWindow: 200000, maxOutputTokens: 64000,
      },
    },
  });
} else if (prompt === 'LIMIT_REJECTED') {
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791460800, rateLimitType: 'five_hour' }, uuid: 'u2', session_id: sessionId });
  line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1791460800', session_id: sessionId, total_cost_usd: 0, modelUsage: {} });
  process.exitCode = 1;
} else if (prompt === 'ASSISTANT_ONLY') {
  // I2 — a run killed before its result: only per-message usage is left. A message streams as
  // several records with the same id; the last one carries its final usage.
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  line({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
  line({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 10, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
  line({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'c' }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 20 } } });
  process.exitCode = 1;
```

In `test/fixtures/fake-codex-cli.js`, before the final `} else {` branch, add:

```js
} else if (prompt === 'LIMIT_HIT') {
  emit({ type: 'turn.started' });
  emit({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours." });
  emit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours." } });
  process.exitCode = 1;
```

- [ ] **Step 3: Write the failing runner tests.** Append inside `describe('ClaudeCodeRunner', …)`:

```ts
  it('R118f/D2 — getRunStats reports result usage, cost, per-model usage, non-allowed limit events and the reported model', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, now: () => new Date('2026-10-08T11:00:00.000Z') });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'USAGE_AND_LIMIT');
    expect(runner.getRunStats(handle)).toEqual({
      tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
      tokensSource: 'result',
      costUsd: 0.42,
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800, webSearchRequests: 0, costUsd: 0.42 },
      },
      limitEvents: [
        { at: '2026-10-08T11:00:00.000Z', kind: 'warning', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null },
      ],
      observedModel: 'claude-opus-5-5',
    });
  });

  it('R118f — a rejected limit is recorded once, not again from the error result text', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, now: () => new Date('2026-10-08T11:00:00.000Z') });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'LIMIT_REJECTED');
    const stats = runner.getRunStats(handle);
    expect(stats.limitEvents).toEqual([
      { at: '2026-10-08T11:00:00.000Z', kind: 'rejected', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null },
    ]);
    expect(stats.modelUsage).toBeNull();
    expect(stats.costUsd).toBe(0);
  });

  it('I2 — a run killed before its result reports the per-message usage, each message counted once', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'ASSISTANT_ONLY');
    expect(runner.getRunStats(handle)).toMatchObject({
      tokens: { input: 15, output: 37, cacheRead: 100, cacheWrite: 20 },
      tokensSource: 'assistant',
      costUsd: null,
      modelUsage: null,
    });
  });

  it('R118f — a run with no usage reports nothing', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'hello');
    expect(runner.getRunStats(handle)).toEqual({
      tokens: null, tokensSource: null, costUsd: null, modelUsage: null, limitEvents: [], observedModel: null,
    });
  });
```

Append inside `describe('CodexRunner', …)`:

```ts
  it('R118f — getRunStats reports turn.completed usage; Codex reports no cost or per-model usage', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'hello');
    expect(runner.getRunStats(handle)).toEqual({
      tokens: { input: 12886, output: 19, cacheRead: 4480, cacheWrite: 0 }, tokensSource: 'result',
      costUsd: null, modelUsage: null, limitEvents: [], observedModel: null,
    });
  });

  it('R118f — a usage-limit failure is one rejected event (error and turn.failed repeat the text)', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE, now: () => new Date('2026-10-08T11:00:00.000Z') });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'LIMIT_HIT');
    expect(runner.getRunStats(handle).limitEvents).toEqual([
      { at: '2026-10-08T11:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null, message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours." },
    ]);
  });

  it('R118f — an ordinary failure is not a limit event', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'FAIL_LOUDLY');
    expect(runner.getRunStats(handle).limitEvents).toEqual([]);
  });
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/agent` → FAIL (`run-stats` missing; `getRunStats` not a function; `now` option unknown).

- [ ] **Step 5: Implement the types.** Append to `src/agent/agent-runner.ts` (before `export interface AgentRunner`):

```ts
/** Raw per-vendor token counts for one run (R118f). Claude's `input` excludes cache; Codex's includes it. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** D2 — one model's share of a run, as Claude's `result.modelUsage` reports it (`costUSD` → `costUsd`). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUsd: number | null;
}

/** A quota or rate-limit signal seen during a run (R118f). */
export interface LimitEvent {
  /** When the runner saw it (ISO). */
  readonly at: string;
  readonly kind: 'warning' | 'rejected';
  /** e.g. `five_hour`, `seven_day` (Claude); null when the CLI does not say. */
  readonly limitType: string | null;
  /** When the limit resets (ISO), when the CLI says. */
  readonly resetsAt: string | null;
  /** The CLI's own sentence for a text-detected limit (first line, capped, redacted). */
  readonly message: string | null;
}

export interface RunStats {
  readonly tokens: TokenUsage | null;
  /** 'result' = the CLI's final usage; 'assistant' = the per-message sum of a run that never reached its result (S2-26). */
  readonly tokensSource: 'result' | 'assistant' | null;
  /** D2 — Claude's `total_cost_usd` (an estimate on a subscription); null when not reported. */
  readonly costUsd: number | null;
  /** D2 — Claude's `modelUsage`, normalized; null when not reported or empty. */
  readonly modelUsage: Readonly<Record<string, ModelUsage>> | null;
  readonly limitEvents: readonly LimitEvent[];
  /** The model the CLI reported it ran (Claude's `system/init`); null when it did not say. */
  readonly observedModel: string | null;
}
```

  and inside `AgentRunner`, after `getPid?`:

```ts
  /** R118f — what this handle's run used and hit, so far. Undefined: the adapter has nothing to report. */
  getRunStats?(handle: AgentHandle): RunStats | undefined;
```

- [ ] **Step 6: Implement `run-stats.ts`.** Create `cgremlin/core/src/agent/run-stats.ts`:

```ts
import type { LimitEvent, ModelUsage, TokenUsage } from './agent-runner';
import { redactSecrets } from '../config/core-config';

const MESSAGE_CAP = 200;
const LIMIT_TEXT = /usage limit|rate limit|hit your limit|too many requests|\b429\b/i;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Claude `usage` (on `result` and on each `assistant` message). Null when it carries neither an input nor an output count. */
export function tokensFromClaudeUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  };
}

/** Codex `turn.completed.usage`; its `input_tokens` already includes `cached_input_tokens`. */
export function tokensFromCodexUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cached_input_tokens) ?? 0,
    cacheWrite: num(u.cache_write_input_tokens) ?? 0,
  };
}

export function addTokens(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** D2 — Claude `result.modelUsage` (CLI 2.1.294 shape), normalized. `{}` (an error result) is null. */
export function modelUsageFromClaude(raw: unknown): Record<string, ModelUsage> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, ModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out[model] = {
      inputTokens: num(v.inputTokens) ?? 0,
      outputTokens: num(v.outputTokens) ?? 0,
      cacheReadInputTokens: num(v.cacheReadInputTokens) ?? 0,
      cacheCreationInputTokens: num(v.cacheCreationInputTokens) ?? 0,
      webSearchRequests: num(v.webSearchRequests) ?? 0,
      costUsd: num(v.costUSD),
    };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** D2 — Claude `result.total_cost_usd`. */
export function costFromClaude(value: unknown): number | null {
  return num(value);
}

/** Claude `rate_limit_event.rate_limit_info`: `allowed` is no event; `allowed_warning` and `rejected` are. */
export function limitEventFromClaude(info: unknown, at: Date): LimitEvent | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const kind = i.status === 'allowed_warning' ? 'warning' : i.status === 'rejected' ? 'rejected' : null;
  if (kind === null) return null;
  const resetsAt = num(i.resetsAt);
  return {
    at: at.toISOString(),
    kind,
    limitType: typeof i.rateLimitType === 'string' ? i.rateLimitType : null,
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
    message: null,
  };
}

/** A failure sentence that says a quota or rate limit stopped the run (Codex has no structured event). */
export function limitEventFromMessage(message: string, at: Date): LimitEvent | null {
  if (!LIMIT_TEXT.test(message)) return null;
  const line = redactSecrets(message.split('\n')[0].trim());
  return {
    at: at.toISOString(),
    kind: 'rejected',
    limitType: null,
    resetsAt: null,
    message: line.length > MESSAGE_CAP ? `${line.slice(0, MESSAGE_CAP)}…` : line,
  };
}
```

- [ ] **Step 7: Claude runner stats.** In `src/agent/claude-code-runner.ts`:
  1. Import the types `LimitEvent`, `ModelUsage`, `RunStats`, `TokenUsage` from `./agent-runner` and `addTokens`, `costFromClaude`, `limitEventFromClaude`, `limitEventFromMessage`, `modelUsageFromClaude`, `tokensFromClaudeUsage` from `./run-stats`.
  2. `ClaudeAgentState` gains:

```ts
  /** The `result` usage (summed if a handle ever sends more than one prompt). */
  tokens: TokenUsage | null;
  /** S2-26 — each assistant message's latest usage, by message id: the fallback when no result arrives. */
  assistantUsage: Map<string, TokenUsage>;
  /** D2 — the latest result's values (the CLI says: read the latest result, do not sum). */
  costUsd: number | null;
  modelUsage: Record<string, ModelUsage> | null;
  limitEvents: LimitEvent[];
  observedModel: string | null;
```

     initialized in `start()` as `tokens: null, assistantUsage: new Map(), costUsd: null, modelUsage: null, limitEvents: [], observedModel: null`.
  3. `ClaudeCodeRunnerOptions` gains `readonly now?: () => Date;`; the class stores `private readonly now: () => Date;` set to `options.now ?? (() => new Date())` in the constructor.
  4. In `handleLine`, after `const record = event as Record<string, unknown>;`, add:

```ts
    if (record.type === 'system' && record.subtype === 'init' && typeof record.model === 'string') {
      state.observedModel = record.model;
    }
    if (record.type === 'rate_limit_event') {
      const limit = limitEventFromClaude(record.rate_limit_info, this.now());
      if (limit !== null) state.limitEvents.push(limit);
    }
    if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
      const message = record.message as Record<string, unknown>;
      const usage = tokensFromClaudeUsage(message.usage);
      if (typeof message.id === 'string' && usage !== null) state.assistantUsage.set(message.id, usage);
    }
```

     and inside the existing `if (record.type === 'result') { … }` block, after the `is_error` forwarding, add:

```ts
      state.tokens = addTokens(state.tokens, tokensFromClaudeUsage(record.usage));
      const cost = costFromClaude(record.total_cost_usd);
      if (cost !== null) state.costUsd = cost;
      state.modelUsage = modelUsageFromClaude(record.modelUsage) ?? state.modelUsage;
      // Fallback only: a structured `rejected` rate_limit_event already said it.
      if (
        record.is_error === true &&
        typeof record.result === 'string' &&
        !state.limitEvents.some((e) => e.kind === 'rejected')
      ) {
        const limit = limitEventFromMessage(record.result, this.now());
        if (limit !== null) state.limitEvents.push(limit);
      }
```

  5. Add the method:

```ts
  getRunStats(handle: AgentHandle): RunStats {
    const state = this.requireState(handle);
    const fromMessages = [...state.assistantUsage.values()].reduce<TokenUsage | null>((sum, usage) => addTokens(sum, usage), null);
    const tokens = state.tokens ?? fromMessages;
    return {
      tokens,
      tokensSource: state.tokens !== null ? 'result' : fromMessages !== null ? 'assistant' : null,
      costUsd: state.costUsd,
      modelUsage: state.modelUsage,
      limitEvents: [...state.limitEvents],
      observedModel: state.observedModel,
    };
  }
```

- [ ] **Step 8: Codex runner stats.** In `src/agent/codex-runner.ts`:
  1. Import `LimitEvent`, `RunStats`, `TokenUsage` types and `addTokens`, `limitEventFromMessage`, `tokensFromCodexUsage`.
  2. `CodexAgentState` gains `tokens: TokenUsage | null; limitEvents: LimitEvent[];` (initialized `null`, `[]` in `start()`); `CodexRunnerOptions` gains `readonly now?: () => Date;`, stored as in the Claude runner.
  3. In `handleLine`'s `switch`: add `case 'turn.completed': { state.tokens = addTokens(state.tokens, tokensFromCodexUsage(record.usage)); break; }` before `default`; in `case 'error'`, inside its `typeof record.message === 'string'` branch after forwarding, add `this.noteLimit(state, record.message);`; in `case 'turn.failed'`, inside its existing guard after forwarding, add `this.noteLimit(state, (error as Record<string, unknown>).message as string);`. Change the trailing comment to: `// 'turn.started' and any other event type carry nothing the AgentRunner contract needs — ignored. ('turn.completed' carries the usage, above.)`
  4. Add:

```ts
  /** `error` and `turn.failed` repeat the same sentence: one event per distinct message. */
  private noteLimit(state: CodexAgentState, message: string): void {
    const limit = limitEventFromMessage(message, this.now());
    if (limit === null) return;
    if (state.limitEvents.some((e) => e.message === limit.message)) return;
    state.limitEvents.push(limit);
  }

  getRunStats(handle: AgentHandle): RunStats {
    const state = this.requireState(handle);
    return {
      tokens: state.tokens,
      tokensSource: state.tokens === null ? null : 'result',
      costUsd: null,
      modelUsage: null,
      limitEvents: [...state.limitEvents],
      observedModel: null,
    };
  }
```

- [ ] **Step 9: Run.** `pnpm vitest run test/agent` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 10: Commit.**

```bash
git add cgremlin/core/src/agent cgremlin/core/test/agent cgremlin/core/test/fixtures/fake-claude-cli.js cgremlin/core/test/fixtures/fake-codex-cli.js
git commit -m "feat(cgremlin-core): runners report usage, cost, per-model usage and limit events per run (R118f, D2)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 4b: Per-run records, run facts and interrupted records (R116, R118f, D2, I2)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Create: `cgremlin/core/src/fs/jsonl.ts`, `cgremlin/core/src/pipeline/run-records.ts`
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts` (deps `log?`; run facts at `run.started`; record after every started run)
- Modify: `cgremlin/core/src/pipeline/pipeline-service.ts` (private `log` helper; `reconcileCrashedRun` `:1476-1497` writes the interrupted record)
- Modify: `cgremlin/core/test/support/fake-agent-runner.ts` (`setRunStats`/`getRunStats`)
- Test: `cgremlin/core/test/fs/jsonl.test.ts` (new), `cgremlin/core/test/pipeline/stage-runner.run-records.test.ts` (new), `cgremlin/core/test/pipeline/crashed-run-heal.test.ts` (append)

**Interfaces:**
- Consumes: `RunStats`, `ModelUsage`, `LimitEvent` (Task 4a); `RUNNER_KINDS`, `EFFORT_LEVELS`, `ResolvedRoute` (Task 2); `route`/`runner` locals in `StageRunner.run` (Task 3); `seedResumeId` (Task 1 — its "Task 4" reference means this task); `CRASHED_RUN_ERROR` (`src/pipeline/run-liveness.ts`).
- Produces:
  - `src/fs/jsonl.ts`: `JSONL_FILE_MODE = 0o600`, `appendJsonLine(fs, path, value): Promise<void>`, `readJsonLines<T>(fs, path, schema): Promise<T[]>` (Task 6a uses both).
  - `src/pipeline/run-records.ts`: `RUNS_FILE = 'runs.jsonl'`, `RUN_FACTS_FILE = '.run-facts.json'`, `RunRecordSchema`, `type RunRecord`, `PendingRunSchema`, `type PendingRun`, `appendRunRecord(fs, sessionDir, record)`, `readRunRecords(fs, sessionDir): Promise<RunRecord[]>`, `writeRunFacts(fs, sessionDir, pending)`, `takeRunFacts(fs, sessionDir): Promise<PendingRun | null>` (Task 6a reads `readRunRecords`).
  - `StageRunnerDeps.log?: (line: string) => void`; `PipelineService` private `log(line: string): void` (Tasks 5 and 6b use it).

- [ ] **Step 1: Write the failing JSONL tests.** Create `cgremlin/core/test/fs/jsonl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { JSONL_FILE_MODE, appendJsonLine, readJsonLines } from '../../src/fs/jsonl';

const Rec = z.object({ n: z.number() });

describe('jsonl', () => {
  it('creates the file and its directory at 0600, one line per append, and reads them back', async () => {
    const fs = new InMemoryFileSystem();
    await appendJsonLine(fs, '/state/x.jsonl', { n: 1 });
    await appendJsonLine(fs, '/state/x.jsonl', { n: 2 });
    expect(await fs.readFile('/state/x.jsonl')).toBe('{"n":1}\n{"n":2}\n');
    expect(await fs.statMode('/state/x.jsonl')).toBe(JSONL_FILE_MODE);
    expect(await readJsonLines(fs, '/state/x.jsonl', Rec)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('never glues a record onto a torn last line, and the reader skips torn, blank and foreign lines', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/x.jsonl', '{"n":1}\n\n{"n":"two"}\n{"n":3');
    await appendJsonLine(fs, '/state/x.jsonl', { n: 4 });
    expect(await fs.readFile('/state/x.jsonl')).toBe('{"n":1}\n\n{"n":"two"}\n{"n":3\n{"n":4}\n');
    expect(await readJsonLines(fs, '/state/x.jsonl', Rec)).toEqual([{ n: 1 }, { n: 4 }]);
  });

  it('a missing file reads as no records', async () => {
    expect(await readJsonLines(new InMemoryFileSystem(), '/nope/x.jsonl', Rec)).toEqual([]);
  });

  it('leaves no temporary file behind', async () => {
    const fs = new InMemoryFileSystem();
    await appendJsonLine(fs, '/state/x.jsonl', { n: 1 });
    expect(await fs.readdir('/state')).toEqual(['x.jsonl']);
  });
});
```

- [ ] **Step 2: Extend the fake runner.** In `test/support/fake-agent-runner.ts`: add `RunStats` to the type import from `../../src/agent/agent-runner`, add `runStats?: RunStats;` to `FakeAgentState`, and add to `FakeAgentRunner`:

```ts
  /** Undefined until set — a runner that has nothing to report. */
  getRunStats(handle: AgentHandle): RunStats | undefined {
    return this.requireState(handle).runStats;
  }

  setRunStats(handle: AgentHandle, stats: RunStats): void {
    this.requireState(handle).runStats = stats;
  }
```

- [ ] **Step 3: Write the failing stage-runner tests.** Create `cgremlin/core/test/pipeline/stage-runner.run-records.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { KeyedLock } from '../../src/api/keyed-lock';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { RUN_FACTS_FILE, readRunRecords } from '../../src/pipeline/run-records';
import type { RunStats } from '../../src/agent/agent-runner';
import type { ResolvedRoute } from '../../src/config/routing';
import type { StageName } from '../../src/schema/stage';
import { migrateV1ToV2 } from '../../src/schema/session';

const NOW = '2026-10-08T12:00:00.000Z';
const WARNING = { at: NOW, kind: 'warning' as const, limitType: 'five_hour', resetsAt: '2026-10-08T15:00:00.000Z', message: null };
const STATS: RunStats = {
  tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
  tokensSource: 'result',
  costUsd: 0.42,
  modelUsage: {
    'claude-opus-5-5': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800, webSearchRequests: 0, costUsd: 0.42 },
  },
  limitEvents: [WARNING],
  observedModel: 'claude-opus-5-5',
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function setup(opts: { routeFor?: (stage: StageName) => ResolvedRoute; worktree?: boolean; resumeId?: string } = {}) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, '/sessions');
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if (opts.resumeId !== undefined) s.agent = { runner: 'claude-code', resumeId: opts.resumeId, humanTurn: null };
  await store.save(s);
  if (opts.worktree !== false) await fs.mkdir('/w/inv-1', { recursive: true });
  const runner = new FakeAgentRunner();
  const logs: string[] = [];
  const sr = new StageRunner({
    runner, runnerKind: 'claude-code', store, fs, events: new EngineEvents(), sessionsDir: '/sessions',
    now: () => new Date(NOW), lock: new KeyedLock(), log: (line) => logs.push(line),
    ...(opts.routeFor ? { routeFor: opts.routeFor } : {}),
  });
  return { fs, store, runner, sr, logs };
}

describe('R116/R118f — one record per run in <session>/runs.jsonl', () => {
  it('a succeeded run appends its route, tokens, cost, per-model usage, limit events and outcome', async () => {
    const { fs, runner, sr } = await setup({
      routeFor: (stage) => ({ stage, runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' }),
    });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# b', prompt: 'go' });
    await flush();
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(true);
    const h = runner.lastHandle();
    runner.setRunStats(h, STATS);
    runner.emitExit(h, { code: 0, signal: null });
    await p;
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([
      {
        v: 1, sessionId: 'inv-1', stage: 'findings', runner: 'claude-code', model: 'opus', effort: 'high', routeSource: 'routing',
        fresh: false, resumed: false, startedAt: NOW, finishedAt: NOW,
        tokens: STATS.tokens, tokensSource: 'result', costUsd: 0.42, modelUsage: STATS.modelUsage, limitEvents: [WARNING],
        outcome: 'succeeded', stopReason: null, error: null, interrupted: false,
      },
    ]);
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(false);
  });

  it('with no model routed, the record names the model the CLI reported', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.setRunStats(runner.lastHandle(), STATS);
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await p;
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ model: 'claude-opus-5-5', effort: null, routeSource: 'legacy' });
  });

  it('a failed and then a stopped run each append their own record; a runner with no stats records nulls', async () => {
    const { fs, runner, sr } = await setup();
    const first = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    await first;
    const second = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    await sr.stop('inv-1');
    runner.emitExit(runner.lastHandle(), { code: null, signal: 'SIGTERM' });
    await second;
    const records = await readRunRecords(fs, '/sessions/inv-1');
    expect(records.map((r) => [r.outcome, r.stopReason, r.error, r.tokens, r.costUsd, r.modelUsage, r.limitEvents])).toEqual([
      ['failed', null, 'agent exited with code 1', null, null, null, []],
      ['stopped', 'user', 'stopped by user', null, null, null, []],
    ]);
  });

  it('M8 — a run that hit a rejected rate limit is recorded as stopped by the limit; lastRun keeps the process outcome', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    const rejected = { at: NOW, kind: 'rejected' as const, limitType: 'five_hour', resetsAt: null, message: null };
    runner.setRunStats(runner.lastHandle(), { ...STATS, limitEvents: [WARNING, rejected] });
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    const result = await p;
    expect(result.session.lastRun?.outcome).toBe('failed');
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ outcome: 'stopped', stopReason: 'limit', limitEvents: [WARNING, rejected] });
  });

  it('a warning alone does not change the outcome', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.setRunStats(runner.lastHandle(), STATS);
    runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
    await p;
    expect((await readRunRecords(fs, '/sessions/inv-1'))[0]).toMatchObject({ outcome: 'failed', stopReason: null });
  });

  it('a fresh run is recorded as fresh and not resumed; a resumed one as resumed', async () => {
    const { fs, runner, sr } = await setup({ resumeId: 'prev' });
    const a = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await a;
    const b = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# b', prompt: 'go', fresh: true });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    await b;
    expect((await readRunRecords(fs, '/sessions/inv-1')).map((r) => [r.fresh, r.resumed])).toEqual([
      [false, true],
      [true, false],
    ]);
  });

  it('a runner that throws at start still leaves a failed record', async () => {
    const { fs, runner, sr } = await setup();
    runner.start = async () => {
      throw new Error('spawn claude ENOENT');
    };
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow('spawn claude ENOENT');
    expect((await readRunRecords(fs, '/sessions/inv-1')).map((r) => [r.outcome, r.error])).toEqual([['failed', 'spawn claude ENOENT']]);
  });

  it('a run that never reached the agent (worktree gone) writes no record and no facts', async () => {
    const { fs, sr } = await setup({ worktree: false });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow();
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([]);
    expect(await fs.exists(`/sessions/inv-1/${RUN_FACTS_FILE}`)).toBe(false);
  });

  it('a record that cannot be written is a log line, never a failed run', async () => {
    const { fs, runner, sr, logs } = await setup();
    const realRename = fs.rename.bind(fs);
    fs.rename = async (from: string, to: string) => {
      if (to.endsWith('/runs.jsonl')) throw new Error('disk full');
      return realRename(from, to);
    };
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await flush();
    runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
    expect(result.session.lastRun).toMatchObject({ outcome: 'succeeded', error: null });
    expect(logs).toEqual([expect.stringContaining('run record for inv-1 not written: disk full')]);
  });
});
```

Append to `cgremlin/core/test/pipeline/crashed-run-heal.test.ts` (it already imports `describe, expect, it`, `createHarness, createInvestigation, flush` and `CRASHED_RUN_ERROR`; add `vi` to the vitest import, `SESSIONS_DIR` to the harness import, and `readRunRecords` from `../../src/pipeline/run-records`):

```ts
describe('I2 — a run the engine lost still gets its record', () => {
  it('a run the engine lost gets an interrupted record when healed, and only one', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const run = h.service.runFindings(inv.id);
    await flush();
    const handle = h.runner.lastHandle();
    h.runner.setPid(handle, 4242);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([inv.id]);
    kill.mockRestore();
    const dir = `${SESSIONS_DIR}/${inv.id}`;
    expect(await readRunRecords(h.fs, dir)).toEqual([
      expect.objectContaining({
        stage: 'findings', runner: 'claude-code', outcome: 'failed', error: CRASHED_RUN_ERROR, interrupted: true,
        tokens: null, tokensSource: null, costUsd: null, modelUsage: null,
      }),
    ]);
    // The lost child reports its exit after all: the record was already written, so no second one.
    h.runner.emitExit(handle, { code: null, signal: 'SIGKILL' });
    await run;
    expect(await readRunRecords(h.fs, dir)).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/fs/jsonl.test.ts test/pipeline/stage-runner.run-records.test.ts test/pipeline/crashed-run-heal.test.ts` → FAIL (modules missing; no `runs.jsonl`).

- [ ] **Step 5: Implement `jsonl.ts`.** Create `cgremlin/core/src/fs/jsonl.ts`:

```ts
import type { z } from 'zod';
import type { SessionFileSystem } from './session-file-system';

/** Engine state files are never world-readable (the dismissals / attention-acks posture). */
export const JSONL_FILE_MODE = 0o600;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Appends ONE JSON line. The whole file is rewritten tmp-then-rename, so a crash mid-write
 * leaves the previous file intact rather than a torn record; a last line torn by something
 * else first gets a newline, so the new record never lands glued onto it. One writer per file
 * (the engine); callers that can race serialize their own appends (FeedbackLog does).
 */
export async function appendJsonLine(fs: SessionFileSystem, path: string, value: unknown): Promise<void> {
  const line = JSON.stringify(value);
  await fs.mkdir(dirnameOf(path), { recursive: true });
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const tmpPath = `${path}.${randomSuffix()}.tmp`;
  await fs.writeFile(tmpPath, `${existing}${separator}${line}\n`, { mode: JSONL_FILE_MODE });
  await fs.rename(tmpPath, path);
}

/** Every line that parses and matches `schema`. Blank, torn and foreign lines are skipped, never thrown; a missing or unreadable file is []. */
export async function readJsonLines<T>(fs: SessionFileSystem, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
  if (!(await fs.exists(path))) return [];
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) out.push(result.data);
  }
  return out;
}
```

- [ ] **Step 6: Implement `run-records.ts`.** Create `cgremlin/core/src/pipeline/run-records.ts`:

```ts
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { appendJsonLine, readJsonLines } from '../fs/jsonl';
import { StageNameSchema } from '../schema/stage';
import { EFFORT_LEVELS, RUNNER_KINDS } from '../config/routing';

/**
 * R116/R118f — one line per run that reached `run.started`, in the session dir. The session dir
 * is agent-writable (`--add-dir`), so these records are telemetry, never evidence (S2-34).
 */
export const RUNS_FILE = 'runs.jsonl';
/** S2-25 — the record's known prefix, written at `run.started`; whoever removes it writes the record. */
export const RUN_FACTS_FILE = '.run-facts.json';

export const TokenUsageSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUsd: z.number().nullable(),
});

export const LimitEventSchema = z.object({
  at: z.string(),
  kind: z.enum(['warning', 'rejected']),
  limitType: z.string().nullable(),
  resetsAt: z.string().nullable(),
  message: z.string().nullable(),
});

export const RunRecordSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  stage: StageNameSchema,
  runner: z.enum(RUNNER_KINDS),
  /** The routed model, else the one the CLI reported, else null. */
  model: z.string().nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  routeSource: z.enum(['routing', 'legacy']),
  fresh: z.boolean(),
  resumed: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  tokens: TokenUsageSchema.nullable(),
  tokensSource: z.enum(['result', 'assistant']).nullable(),
  /** D2 — Claude's total_cost_usd; null when not reported. */
  costUsd: z.number().nullable(),
  /** D2 — Claude's per-model usage; null when not reported. */
  modelUsage: z.record(z.string(), ModelUsageSchema).nullable(),
  limitEvents: z.array(LimitEventSchema),
  /** The process outcome, except a run that hit a `rejected` limit is `stopped` (S2-35). */
  outcome: z.enum(['succeeded', 'failed', 'stopped']),
  stopReason: z.enum(['user', 'limit']).nullable(),
  error: z.string().nullable(),
  /** S2-25 — the engine died under this run; it was recorded when the run was healed. */
  interrupted: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const PendingRunSchema = RunRecordSchema.pick({
  v: true, sessionId: true, stage: true, runner: true, model: true, effort: true, routeSource: true, fresh: true, resumed: true, startedAt: true,
});
export type PendingRun = z.infer<typeof PendingRunSchema>;

export function runsPath(sessionDir: string): string {
  return `${sessionDir}/${RUNS_FILE}`;
}

function factsPath(sessionDir: string): string {
  return `${sessionDir}/${RUN_FACTS_FILE}`;
}

export async function appendRunRecord(fs: SessionFileSystem, sessionDir: string, record: RunRecord): Promise<void> {
  await appendJsonLine(fs, runsPath(sessionDir), RunRecordSchema.parse(record));
}

export async function readRunRecords(fs: SessionFileSystem, sessionDir: string): Promise<RunRecord[]> {
  return readJsonLines(fs, runsPath(sessionDir), RunRecordSchema);
}

export async function writeRunFacts(fs: SessionFileSystem, sessionDir: string, pending: PendingRun): Promise<void> {
  await fs.writeFile(factsPath(sessionDir), JSON.stringify(PendingRunSchema.parse(pending)), { mode: 0o600 });
}

/** Reads and REMOVES the run facts: the caller now owns writing this run's record. Null when absent or unreadable. */
export async function takeRunFacts(fs: SessionFileSystem, sessionDir: string): Promise<PendingRun | null> {
  const path = factsPath(sessionDir);
  if (!(await fs.exists(path))) return null;
  let pending: PendingRun | null = null;
  try {
    const parsed = PendingRunSchema.safeParse(JSON.parse(await fs.readFile(path)));
    pending = parsed.success ? parsed.data : null;
  } catch {
    pending = null;
  }
  await fs.remove(path);
  return pending;
}
```

- [ ] **Step 7: Record every started run in `stage-runner.ts`.**
  1. Imports: add `RunStats` to the agent type import; add `import { appendRunRecord, takeRunFacts, writeRunFacts, type PendingRun, type RunRecord } from './run-records';`.
  2. `StageRunnerDeps` gains:

```ts
  /** One line per degraded side effect (run facts or a run record that could not be written). Defaults to `console.warn`, which the engine log captures. */
  log?: (line: string) => void;
```

  3. Add module-level helpers above the class:

```ts
function statsOf(runner: AgentRunner, handle: AgentHandle | null): RunStats | null {
  if (handle === null) return null;
  try {
    return runner.getRunStats?.(handle) ?? null;
  } catch {
    return null;
  }
}

function pendingRunOf(input: StageRunInput, route: ResolvedRoute, startedAt: string, seedResumeId: string | null): PendingRun {
  return {
    v: 1, sessionId: input.sessionId, stage: input.stage, runner: route.runner, model: route.model, effort: route.effort,
    routeSource: route.source, fresh: input.fresh === true, resumed: seedResumeId !== null, startedAt,
  };
}

/** S2-35 — a `rejected` limit means the run was stopped by the limit, whatever the exit code said. */
function runRecordOf(
  pending: PendingRun,
  stats: RunStats | null,
  end: { finishedAt: string; outcome: RunRecord['outcome']; error: string | null },
): RunRecord {
  const limited = (stats?.limitEvents ?? []).some((e) => e.kind === 'rejected');
  const outcome: RunRecord['outcome'] = limited ? 'stopped' : end.outcome;
  return {
    ...pending,
    model: pending.model ?? stats?.observedModel ?? null,
    finishedAt: end.finishedAt,
    tokens: stats?.tokens ?? null,
    tokensSource: stats?.tokensSource ?? null,
    costUsd: stats?.costUsd ?? null,
    modelUsage: stats?.modelUsage ? { ...stats.modelUsage } : null,
    limitEvents: [...(stats?.limitEvents ?? [])],
    outcome,
    stopReason: limited ? 'limit' : outcome === 'stopped' ? 'user' : null,
    error: end.error,
    interrupted: false,
  };
}
```

  4. Add private methods on `StageRunner`:

```ts
  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }

  /** S2-25 — the record's known prefix, so a run the engine dies under can still be recorded on heal. Never throws. */
  private async writeFacts(sessionDir: string, pending: PendingRun): Promise<boolean> {
    try {
      await writeRunFacts(this.deps.fs, sessionDir, pending);
      return true;
    } catch (err) {
      this.log(`run facts for ${pending.sessionId} not written: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * R116/R118f — appends the run's record. If facts were written and are gone, the crash heal
   * already recorded this run (S2-25): write nothing. Never throws: a failure is a log line and
   * the run's outcome and lastRun stay exactly what they were. No lock: a session has at most
   * one run (the `active` reservation), so nothing else writes these files meanwhile.
   */
  private async recordRun(sessionDir: string, factsWritten: boolean, record: RunRecord): Promise<void> {
    try {
      if (factsWritten && (await takeRunFacts(this.deps.fs, sessionDir)) === null) return;
      await appendRunRecord(this.deps.fs, sessionDir, record);
    } catch (err) {
      this.log(`run record for ${record.sessionId} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

  5. In `run()`, next to `let runStarted = false;` add `let pending: PendingRun | null = null;` and `let factsWritten = false;`. Directly before `this.deps.events.emit('run.started', { session, stage });` add:

```ts
        pending = pendingRunOf(input, route, startedAt, seedResumeId);
        factsWritten = await this.writeFacts(sessionDir, pending);
```

     (`startedAt` is the existing local set just before the `running` LastRun.)
  6. In the success path, directly before `this.deps.events.emit('run.finished', { session, stage, outcome });`, add:

```ts
        await this.recordRun(
          sessionDir,
          factsWritten,
          runRecordOf(pending, statsOf(runner, active.handle), {
            finishedAt: finishedLastRun.finishedAt ?? this.now().toISOString(),
            outcome,
            error,
          }),
        );
```

     If TypeScript reports `pending` as possibly null there, add `if (pending === null) throw new Error('unreachable: run.started fired without run facts');` right after `const exit = await exitPromise;`.
  7. In the outer `catch (err)` path, directly before its `this.deps.events.emit('run.finished', { session: finishedSession, stage, outcome: 'failed' });`, add:

```ts
        if (pending !== null) {
          await this.recordRun(
            sessionDir,
            factsWritten,
            runRecordOf(pending, statsOf(active.runner, active.handle), {
              finishedAt: failed.finishedAt ?? this.now().toISOString(),
              outcome: 'failed',
              error: failed.error,
            }),
          );
        }
```

     (`sessionDir` is declared before the inner `try`, so it is in scope in both paths.)

- [ ] **Step 8: Record interrupted runs on heal.** In `src/pipeline/pipeline-service.ts` (lines 1-14 untouched):
  1. Imports: `import { appendRunRecord, takeRunFacts } from './run-records';` (`CRASHED_RUN_ERROR` is already imported from `./run-liveness`).
  2. Add a private helper next to `sessionDir`:

```ts
  /** One line per degraded side effect. Defaults to `console.warn`, which the engine log captures. */
  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }
```

     and change the inline `(this.deps.log ?? ((line: string) => console.warn(line)))(…)` call in `releaseConversation` to `this.log(…)` with the same message.
  3. Add the method after `reconcileCrashedRun`:

```ts
  /**
   * I2 / S2-25 — a run the engine died under still gets its record, from the facts the stage
   * runner left at `run.started`. Taking the facts claims the record, so the run's own late exit
   * (if the child ever reports one) writes nothing. Never throws.
   */
  private async recordInterruptedRun(id: string): Promise<void> {
    const sessionDir = this.sessionDir(id);
    try {
      const pending = await takeRunFacts(this.deps.fs, sessionDir);
      if (pending === null) return;
      await appendRunRecord(this.deps.fs, sessionDir, {
        ...pending,
        finishedAt: this.now().toISOString(),
        tokens: null,
        tokensSource: null,
        costUsd: null,
        modelUsage: null,
        limitEvents: [],
        outcome: 'failed',
        stopReason: null,
        error: CRASHED_RUN_ERROR,
        interrupted: true,
      });
    } catch (err) {
      this.log(`interrupted run record for ${id} not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

  4. In `reconcileCrashedRun`, inside the locked callback directly after `if (!this.isStale(fresh)) return false;`, add `if (fresh.lastRun?.outcome === 'running') await this.recordInterruptedRun(id);`.

- [ ] **Step 9: Run.** `pnpm vitest run test/fs test/pipeline/stage-runner.run-records.test.ts test/pipeline/crashed-run-heal.test.ts test/pipeline/stage-runner.test.ts test/pipeline/stage-runner.routing.test.ts` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS. Every stage run now writes `<session>/runs.jsonl` (and briefly `.run-facts.json`): if a pre-existing test asserts the exact file list of a session dir, or counts watcher/`artifact.changed` frames for one run, add those files / changes to that expectation (new engine files, not a regression) and name the test in the commit message. Do not change production behaviour to avoid it.

- [ ] **Step 10: Commit.**

```bash
git add cgremlin/core/src/fs/jsonl.ts cgremlin/core/src/pipeline/run-records.ts cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/src/pipeline/pipeline-service.ts cgremlin/core/test/fs/jsonl.test.ts cgremlin/core/test/pipeline/stage-runner.run-records.test.ts cgremlin/core/test/pipeline/crashed-run-heal.test.ts cgremlin/core/test/support/fake-agent-runner.ts
git commit -m "feat(cgremlin-core): per-run records in runs.jsonl with route, tokens, cost and limits; interrupted runs recorded on heal (R116, R118f, D2, I2)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 5: PR detection for development sessions; tick adoption; merged/closed reconciliation (R91, I1, M4)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Create: `cgremlin/core/src/pipeline/pr-detection.ts`
- Modify: `cgremlin/core/src/pipeline/pipeline-service.ts` (`PipelineConfig.me?`; deps `gh?`; `runDevelop` `:761-804`; new public `adoptDevelopmentPr`)
- Modify: `cgremlin/core/src/discovery/reconciliation.ts:49-52` (comment), `:196-249` (`PrBearingSession`, `planPrSessionReconciliation`), `:376` and `:387-412` (`run` calls a new adoption leg; `runPrBearingSessions` candidates and in-lock check)
- Modify: `cgremlin/core/src/host/build-engine.ts` (`new PipelineService({ … gh: adapters.gh, config: { … me: config.me } })`)
- Modify: `cgremlin/core/test/support/pipeline-harness.ts` (`HarnessOptions.gh`; `me: 'me'` in its `PipelineConfig`)
- Test: `cgremlin/core/test/pipeline/pr-detection.test.ts` (new), `cgremlin/core/test/pipeline/pipeline-service.development.test.ts`, `cgremlin/core/test/discovery/reconciliation.test.ts`

**Interfaces:**
- Consumes: `parsePrUrl` (`src/gh/pr-url.ts`), `PR_VIEW_FIELDS`, `PR_LIST_FIELDS`, `parsePrView`, `parsePrList`, `mapPrView` (`src/gh/pr-view.ts`), `GhRunner`, `repoSlugFromUrl`, `applyTransition`, `redactSecrets`, `runLivenessOf`; `PipelineService.log` (Task 4b).
- Produces:
  - `export type PrDetection = { found: true; pr: PrInfo; isDraft: boolean; via: 'PR_URL' | 'gh pr list' } | { found: false; why: string }`
  - `export async function detectDevelopmentPr(input: { gh: GhRunner; fs: SessionFileSystem; sessionDir: string; repoSlug: string; branch: string; me: string }): Promise<PrDetection>`
  - `PipelineConfig.me?: string`; `PipelineServiceDeps.gh?: GhRunner`; `PipelineService.adoptDevelopmentPr(id: string): Promise<Session>` (public; the tick calls it).
  - `PrBearingSession = RespondSession | InvestigationSession | DevelopmentSession`; `ReconciliationTick` adoption leg (report action `{ type: 'transition', sessionId, to: 'pr_opened', reason: 'PR detected' }`).
  - `HarnessOptions.gh?: GhRunner`; the harness `PipelineConfig` carries `me: 'me'`.

- [ ] **Step 1: Write the failing detection tests.** Create `cgremlin/core/test/pipeline/pr-detection.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { GhCommandError } from '../../src/gh/gh-runner';
import { PR_LIST_FIELDS, PR_VIEW_FIELDS } from '../../src/gh/pr-view';
import { detectDevelopmentPr } from '../../src/pipeline/pr-detection';

const DIR = '/sessions/dev-1';
const BRANCH = 'feature/ABC-1';
const SHA = 'b'.repeat(40);
const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));

function viewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...baseView, number: 7, url: 'https://github.com/o/r/pull/7', headRefName: BRANCH, headRefOid: SHA,
    author: { login: 'Me', is_bot: false }, state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null, ...overrides,
  });
}

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 9, url: 'https://github.com/o/r/pull/9', author: { login: 'me' }, isDraft: true, reviewDecision: '',
    headRefOid: SHA, headRefName: BRANCH, baseRefName: 'main', title: 'ABC-1 thing', updatedAt: '2026-10-08T12:00:00Z',
    ...overrides,
  };
}

const LIST_CALL = ['pr', 'list', '--repo', 'o/r', '--head', BRANCH, '--state', 'open', '--json', PR_LIST_FIELDS, '--limit', '5'];

async function setup(prUrl?: string) {
  const fs = new InMemoryFileSystem();
  await fs.mkdir(DIR, { recursive: true });
  if (prUrl !== undefined) await fs.writeFile(`${DIR}/PR_URL`, prUrl);
  const gh = new FakeGhRunner();
  const detect = () => detectDevelopmentPr({ gh, fs, sessionDir: DIR, repoSlug: 'o/r', branch: BRANCH, me: 'me' });
  return { gh, detect };
}

describe('detectDevelopmentPr (R91)', () => {
  it('adopts the PR the agent recorded once gh confirms it is OPEN, in this repo, on this branch, by me (any case)', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7\n');
    gh.queueResponse({ stdout: viewJson() });
    expect(await detect()).toEqual({
      found: true, via: 'PR_URL', isDraft: true,
      pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', headSha: SHA, reviewedSha: null, title: baseView.title, author: 'Me' },
    });
    expect(gh.calls).toEqual([['pr', 'view', '7', '--repo', 'o/r', '--json', PR_VIEW_FIELDS]]);
  });

  it('a stale PR_URL (another branch) is ignored and gh pr list --head decides', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ headRefName: 'feature/OLD-9' }) });
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list', isDraft: true, pr: { number: 9, url: 'https://github.com/o/r/pull/9', headSha: SHA, author: 'me' } });
    expect(gh.calls[1]).toEqual(LIST_CALL);
  });

  it('a PR_URL whose PR is closed is not adopted, and nothing open on the branch means nothing found', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ state: 'CLOSED', closedAt: '2026-10-07T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('is CLOSED');
      expect(result.why).toContain(`no open PR by me has head ${BRANCH}`);
    }
  });

  it('M4 — a same-branch PR by another author is not adopted, by either path', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ author: { login: 'teammate', is_bot: false } }) });
    gh.queueResponse({ stdout: JSON.stringify([listItem({ author: { login: 'teammate' } })]) });
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL #7 is by teammate, not me');
      expect(result.why).toContain(`no open PR by me has head ${BRANCH}`);
    }
  });

  it('a PR_URL naming another repo is never even looked up', async () => {
    const { gh, detect } = await setup('https://github.com/evil/r/pull/7');
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list' });
    expect(gh.calls).toEqual([LIST_CALL]);
  });

  it('a PR_URL that is not a pull request URL falls back to the list', async () => {
    const { gh, detect } = await setup('see https://example.com for the PR');
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list' });
  });

  it('two open PRs by me on the branch: not guessing', async () => {
    const { gh, detect } = await setup();
    gh.queueResponse({ stdout: JSON.stringify([listItem(), listItem({ number: 10, url: 'https://github.com/o/r/pull/10' })]) });
    const result = await detect();
    expect(result).toMatchObject({ found: false });
    if (!result.found) expect(result.why).toContain('not guessing');
  });

  it('a list item on a different head is ignored', async () => {
    const { gh, detect } = await setup();
    gh.queueResponse({ stdout: JSON.stringify([listItem({ headRefName: 'feature/ABC-10' })]) });
    expect((await detect()).found).toBe(false);
  });

  it('gh missing or unauthenticated is a reason, never a throw', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse(new GhCommandError(['pr', 'view'], null, 'spawn gh ENOENT'));
    gh.queueResponse(new GhCommandError(['pr', 'list'], 4, 'gh auth login required'));
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL unusable');
      expect(result.why).toContain('gh pr list failed');
    }
  });

  it('only ever reads: every gh call is pr view or pr list', async () => {
    const scenarios: Array<{ prUrl?: string; responses: string[] }> = [
      { prUrl: 'https://github.com/o/r/pull/7', responses: [viewJson()] },
      { prUrl: 'https://github.com/o/r/pull/7', responses: [viewJson({ state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z' }), '[]'] },
      { responses: [JSON.stringify([listItem()])] },
    ];
    for (const s of scenarios) {
      const { gh, detect } = await setup(s.prUrl);
      for (const stdout of s.responses) gh.queueResponse({ stdout });
      await detect();
      for (const call of gh.calls) expect([['pr', 'view'], ['pr', 'list']]).toContainEqual(call.slice(0, 2));
    }
  });
});
```

- [ ] **Step 2: Write the failing pipeline tests.** In `test/support/pipeline-harness.ts`: import `type { GhRunner } from '../../src/gh/gh-runner'`; add to `HarnessOptions`:

```ts
  /** R91 — PipelineServiceDeps.gh; omitted means no PR detection (today's behaviour). */
  gh?: GhRunner;
```

pass `...(options.gh !== undefined ? { gh: options.gh } : {}),` in the `new PipelineService({ … })` call next to the other optional spreads, and add `me: 'me',` to the harness's `PipelineConfig` literal (after `runnerKind,`).

Append to `test/pipeline/pipeline-service.development.test.ts` (add imports: `readFileSync` from `node:fs`, `path` from `node:path`, `FakeGhRunner` from `../support/fake-gh-runner`, `GhCommandError` from `../../src/gh/gh-runner`, `UnsupportedStageError` from `../../src/pipeline/pipeline-service`, `ReconciliationTick` from `../../src/discovery/reconciliation`, `flush` is already imported from the harness):

```ts
describe('R91 — a develop run records its draft PR', () => {
  const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));
  const prView = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...baseView, number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'feature/ABC-1', author: { login: 'me', is_bot: false },
      state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null, ...overrides,
    });

  async function runDevelopWith(h: ReturnType<typeof createHarness>, id: string, files: Record<string, string>, code = 0) {
    const p = h.service.runDevelop(id);
    await h.finishRun(files, { code, signal: null });
    return p;
  }

  it('records the draft PR and moves active -> pr_opened in one save', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const transitions: string[] = [];
    h.events.on('session.transitioned', (e) => transitions.push(`${e.from}->${e.to}`));
    gh.queueResponse({ stdout: prView() });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7\n' });
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.pr).toMatchObject({ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', reviewedSha: null, author: 'me' });
    expect(transitions).toEqual(['active->pr_opened']);
    expect(await h.store.load(dev.id)).toEqual(after);
  });

  it('a failed develop run that already opened its PR still records it', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView() });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' }, 1);
    expect(after.lastRun?.outcome).toBe('failed');
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.pr?.number).toBe(7);
  });

  it('regression pin: without gh wired the session stays active with no PR (today)', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
  });

  it('gh missing: stays active with no PR, the run is not failed, and one log line says why', async () => {
    const gh = new FakeGhRunner();
    const logs: string[] = [];
    const h = createHarness({ gh, log: (line) => logs.push(line) });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse(new GhCommandError(['pr', 'list'], null, 'spawn gh ENOENT'));
    const after = await runDevelopWith(h, dev.id, {});
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
    expect(after.lastRun).toMatchObject({ outcome: 'succeeded', error: null });
    expect(logs).toEqual([expect.stringContaining(`PR detection for ${dev.id}: none adopted`)]);
  });

  it('a stale PR_URL pointing at a closed PR leaves the session active', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView({ state: 'CLOSED', closedAt: '2026-10-07T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
  });

  it('a PR opened for review (not a draft) is recorded, and lastRun says it needed approval', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView({ isDraft: false }) });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.lastRun?.error).toBe('PR #7 is open for review, not a draft — opening a PR for review needs your approval (R112)');
  });

  it('runDevelop runs again from pr_opened (a fix round) and does not look the PR up again', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView() });
    await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(gh.calls).toHaveLength(1);
    const again = await runDevelopWith(h, dev.id, {});
    expect(again.stageStatus).toBe('pr_opened');
    expect(again.lastRun?.outcome).toBe('succeeded');
    expect(gh.calls).toHaveLength(1);
  });

  it('regression pin: runDevelop is refused once the session is merged', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.service.transition(dev.id, 'merged');
    await expect(h.service.runDevelop(dev.id)).rejects.toBeInstanceOf(UnsupportedStageError);
  });

  it('I1 — a PR opened before an engine restart is adopted on the next tick', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    // The engine died mid-run: the file still says `running`, nothing holds the run, and the
    // agent had already written PR_URL.
    await h.store.save({
      ...(await h.store.load(dev.id)),
      lastRun: { stage: 'develop', startedAt: '2026-09-04T11:00:00.000Z', finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null },
    });
    await h.fs.writeFile(`${SESSIONS_DIR}/${dev.id}/PR_URL`, 'https://github.com/o/r/pull/7\n');
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([dev.id]);
    gh.queueResponse({ stdout: prView() });
    const report = await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect(report.errors).toEqual([]);
    expect(report.actions).toContainEqual({ type: 'transition', sessionId: dev.id, to: 'pr_opened', reason: 'PR detected' });
    expect((await h.store.load(dev.id)).stageStatus).toBe('pr_opened');
  });

  it('I1 — the tick leaves a session with a live run alone', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const run = h.service.runDevelop(dev.id);
    await flush();
    await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect(gh.calls).toEqual([]);
    gh.queueResponse({ stdout: '[]' });
    h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
    expect((await run).stageStatus).toBe('active');
  });
});
```


- [ ] **Step 3: Write the failing reconciliation tests.** Append to `test/discovery/reconciliation.test.ts` (add `PR_VIEW_FIELDS` to the `../../src/gh/pr-view` import and `type DevelopmentSession` to the schema import):

```ts
describe('R91 — development sessions follow their own PR', () => {
  it('planPrSessionReconciliation: MERGED -> merged, CLOSED -> abandoned, OPEN -> nothing', () => {
    const dev = developmentSession('dev-1', 'pr_opened') as DevelopmentSession;
    expect(planPrSessionReconciliation({ session: dev, view: view({ state: 'MERGED' }) }).actions).toEqual([
      { type: 'transition', sessionId: 'dev-1', to: 'merged', reason: 'PR merged' },
    ]);
    expect(planPrSessionReconciliation({ session: dev, view: view({ state: 'CLOSED' }) }).actions).toEqual([
      { type: 'transition', sessionId: 'dev-1', to: 'abandoned', reason: 'PR closed without merging' },
    ]);
    expect(planPrSessionReconciliation({ session: dev, view: view() })).toEqual({ actions: [], skipped: [] });
  });

  it('the tick merges a development session whose own PR merged', async () => {
    const { h, gh, lock } = tickHarness();
    await h.store.save(developmentSession('dev-1', 'pr_opened'));
    gh.queueResponse({ stdout: viewJson({ state: 'MERGED', mergedAt: '2026-09-05T00:00:00Z' }) });
    const report = await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW }).run();
    expect(report.errors).toEqual([]);
    expect(gh.calls).toEqual([['pr', 'view', '5', '--repo', 'acme/app', '--json', PR_VIEW_FIELDS]]);
    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
  });

  it('the tick abandons a development session whose own PR was closed', async () => {
    const { h, gh, lock } = tickHarness();
    await h.store.save(developmentSession('dev-1', 'pr_opened'));
    gh.queueResponse({ stdout: viewJson({ state: 'CLOSED', closedAt: '2026-09-05T00:00:00Z' }) });
    await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW }).run();
    expect((await h.store.load('dev-1')).stageStatus).toBe('abandoned');
  });

  it('a terminal development session, or one with no PR and no gh wired in the pipeline, costs no gh call', async () => {
    const { h, gh, lock } = tickHarness();
    await h.store.save({ ...developmentSession('dev-2', 'active'), pr: null });
    await h.store.save(developmentSession('dev-3', 'merged'));
    const report = await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW }).run();
    expect(gh.calls).toEqual([]);
    expect(report.reconciled).toBe(0);
  });

  it('a review that already merged its lineage source in the same tick leaves the development leg nothing to do', async () => {
    const { h, gh, lock } = tickHarness();
    await h.store.save(developmentSession('dev-1', 'pr_opened', 'acme/app', 42));
    await h.store.save(reviewSession({ id: 'pr-app-42-x', stageStatus: 'ready', repo: 'acme/app', number: 42, parentSessionId: 'dev-1' }));
    gh.queueResponse({
      stdout: viewJson({ number: 42, url: 'https://github.com/acme/app/pull/42', state: 'MERGED', mergedAt: '2026-09-05T01:00:00Z' }),
    });
    const report = await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock, now: () => NOW }).run();
    expect(report.errors).toEqual([]);
    expect(gh.calls).toHaveLength(1);
    expect((await h.store.load('dev-1')).stageStatus).toBe('merged');
  });
});
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/pipeline/pr-detection.test.ts test/pipeline/pipeline-service.development.test.ts test/discovery/reconciliation.test.ts` → FAIL (`pr-detection` missing; session stays `active`; no development or adoption leg). The two regression pins pass already.

- [ ] **Step 5: Implement `pr-detection.ts`.** Create `cgremlin/core/src/pipeline/pr-detection.ts`:

```ts
import type { GhRunner } from '../gh/gh-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { PrInfo } from '../schema/stage';
import { parsePrUrl } from '../gh/pr-url';
import { PR_LIST_FIELDS, PR_VIEW_FIELDS, mapPrView, parsePrList, parsePrView } from '../gh/pr-view';
import { redactSecrets } from '../config/core-config';

export type PrDetection =
  | { found: true; pr: PrInfo; isDraft: boolean; via: 'PR_URL' | 'gh pr list' }
  | { found: false; why: string };

export interface DetectPrInput {
  gh: GhRunner;
  fs: SessionFileSystem;
  sessionDir: string;
  /** "owner/name" of the session's repo. */
  repoSlug: string;
  /** The session's own branch: the only head a PR may have to be this session's. */
  branch: string;
  /** CoreConfig.me — the only author a PR may have to be this session's (S2-31). */
  me: string;
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text.split('\n')[0].slice(0, 200));
}

function isMe(login: string, me: string): boolean {
  return login.toLowerCase() === me.toLowerCase();
}

async function prUrlHint(fs: SessionFileSystem, sessionDir: string): Promise<string | null> {
  const text = await fs.readFile(`${sessionDir}/PR_URL`).catch(() => null);
  if (text === null) return null;
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? null;
}

/**
 * R91 — which OPEN pull request this development session's branch has, if any.
 *
 * READ-ONLY: the only gh verbs used are `pr view` and `pr list`; nothing here opens, readies,
 * edits or posts. The agent's PR_URL is a hint, never trusted on its own (it is agent-written
 * text): it must parse as a GitHub PR URL, name THIS repo, be OPEN, have this session's branch
 * as its head and be authored by `me` — otherwise it is ignored and `gh pr list --head <branch>`
 * decides, adopting only an unambiguous single match by `me`. Never throws: a missing or
 * unauthenticated gh is `found: false` with the reason.
 */
export async function detectDevelopmentPr(input: DetectPrInput): Promise<PrDetection> {
  const notes: string[] = [];
  const hint = await prUrlHint(input.fs, input.sessionDir);
  if (hint !== null) {
    try {
      const ref = parsePrUrl(hint);
      if (ref.slug.toLowerCase() !== input.repoSlug.toLowerCase()) {
        notes.push(`PR_URL names ${ref.slug}, not ${input.repoSlug}`);
      } else {
        const { stdout } = await input.gh.run([
          'pr', 'view', String(ref.number), '--repo', input.repoSlug, '--json', PR_VIEW_FIELDS,
        ]);
        const view = mapPrView(input.repoSlug, parsePrView(stdout));
        const author = view.pr.author ?? '';
        if (view.headRefName !== input.branch) {
          notes.push(`PR_URL #${ref.number} is for branch ${view.headRefName}, not ${input.branch}`);
        } else if (view.state !== 'OPEN') {
          notes.push(`PR_URL #${ref.number} is ${view.state}`);
        } else if (!isMe(author, input.me)) {
          notes.push(`PR_URL #${ref.number} is by ${author}, not ${input.me}`);
        } else {
          return { found: true, pr: view.pr, isDraft: view.isDraft, via: 'PR_URL' };
        }
      }
    } catch (err) {
      notes.push(`PR_URL unusable: ${messageOf(err)}`);
    }
  }
  try {
    const { stdout } = await input.gh.run([
      'pr', 'list', '--repo', input.repoSlug, '--head', input.branch, '--state', 'open', '--json', PR_LIST_FIELDS, '--limit', '5',
    ]);
    const matches = parsePrList(stdout).filter((item) => item.headRefName === input.branch && isMe(item.author.login, input.me));
    if (matches.length === 1) {
      const item = matches[0];
      return {
        found: true,
        via: 'gh pr list',
        isDraft: item.isDraft,
        pr: {
          repo: input.repoSlug, number: item.number, url: item.url, headSha: item.headRefOid,
          reviewedSha: null, title: item.title, author: item.author.login,
        },
      };
    }
    notes.push(
      matches.length === 0
        ? `no open PR by ${input.me} has head ${input.branch}`
        : `${matches.length} open PRs by ${input.me} have head ${input.branch}; not guessing`,
    );
  } catch (err) {
    notes.push(`gh pr list failed: ${messageOf(err)}`);
  }
  return { found: false, why: notes.join('; ') };
}
```

- [ ] **Step 6: Wire detection into `PipelineService`.** In `src/pipeline/pipeline-service.ts` (leave lines 1-14 untouched; add imports below them):
  1. Imports: `import type { GhRunner } from '../gh/gh-runner';`, `import { detectDevelopmentPr } from './pr-detection';`, and add `DevelopmentPhase` to the `import type { RespondPhase, ReviewPhase } from '../schema/pipeline';` line.
  2. In `PipelineConfig`, after `humanTurnTtlMs`, add:

```ts
  /** S2-31 — CoreConfig.me: only a PR by this login is adopted. Absent: no PR detection. */
  me?: string;
```

  3. In `PipelineServiceDeps`, after `ghAuthOk`, add:

```ts
  /**
   * R91 — read-only PR detection after a develop run and on every tick (`gh pr view` /
   * `gh pr list` only; never opens or posts). Absent: no detection, and a development session
   * stays `active` (pre-step-2).
   */
  gh?: GhRunner;
```

  4. In `runDevelop`: declare `const DEVELOP_RUNNABLE_FROM: readonly DevelopmentPhase[] = ['active', 'pr_opened'];` as its first statement; replace the comment `// No transition on success: PR detection (which drives active -> pr_opened) is Phase 3b.` with `// R91 — the PR the run opened is detected after it, whatever its outcome (adoptDevelopmentPr). Runnable from pr_opened too: a fix round on the open draft.`; change the in-lock check to `if (fresh.mode !== 'development' || !DEVELOP_RUNNABLE_FROM.includes(fresh.stageStatus)) {`; change `const result = await this.runStageLocked(id, 'develop', …` to `await this.runStageLocked(id, 'develop', …` (its result is no longer read); and change `return result.session;` to `return await this.adoptDevelopmentPr(id);`.
  5. Add the public method after `runDevelop` (uses the `log` helper from Task 4b):

```ts
  /**
   * R91 — find this development session's open PR and record it: `session.pr` + `active →
   * pr_opened` in ONE locked save and one `session.transitioned`. Called after every develop run
   * (any outcome: a PR the agent opened before it died is still a PR) and by the reconciliation
   * tick (I1: a run the engine died under, a PR opened in a Take over chat). Read-only gh
   * (src/pipeline/pr-detection.ts). A session that already has a PR, is not `active`, has no
   * branch, or has a live run is left alone; so is every session when `gh` or `me` is not wired.
   * Never throws for a detection miss: that is one log line and the session as it was. A PR
   * opened for review rather than as a draft is still recorded, and lastRun says it needed
   * approval (R112).
   */
  async adoptDevelopmentPr(id: string): Promise<Session> {
    const current = await this.deps.store.load(id);
    const gh = this.deps.gh;
    const me = this.deps.config.me;
    if (gh === undefined || me === undefined) return current;
    if (current.mode !== 'development' || current.pr !== null || current.stageStatus !== 'active') return current;
    if (this.runLivenessOf(current) === 'live') return current;
    const branch = current.workspace.branch;
    if (!branch) return current;
    const detection = await detectDevelopmentPr({
      gh,
      fs: this.deps.fs,
      sessionDir: this.sessionDir(id),
      repoSlug: repoSlugFromUrl(current.workspace.repoUrl),
      branch,
      me,
    });
    if (!detection.found) {
      this.log(`PR detection for ${id}: none adopted (${detection.why})`);
      return current;
    }
    const adopted = await this.lock.withLock(id, async () => {
      const before = await this.deps.store.load(id);
      if (before.mode !== 'development' || before.pr !== null || before.stageStatus !== 'active') return null;
      const next: Session = { ...applyTransition(before, 'pr_opened'), pr: detection.pr };
      await this.deps.store.save(next);
      this.deps.events.emit('session.transitioned', { session: next, from: before.stageStatus, to: 'pr_opened' });
      return next;
    });
    if (adopted === null) return this.deps.store.load(id);
    if (detection.isDraft) return adopted;
    const note = `PR #${detection.pr.number} is open for review, not a draft — opening a PR for review needs your approval (R112)`;
    const prior = adopted.lastRun?.error ?? null;
    return this.patchLastRun(id, { error: prior === null ? note : `${prior}; ${note}` });
  }
```

  6. In `src/host/build-engine.ts`, in the `new PipelineService({ … })` call: add `gh: adapters.gh,` after `ghAuthOk: …,` (before `respondContext`), and add `me: config.me,` inside its `config: { … }` object after `humanTurnTtlMs: config.humanTurnTtlMs,`.

- [ ] **Step 7: Development joins reconciliation; the tick adopts PRs.** In `src/discovery/reconciliation.ts`:
  1. Import `DevelopmentSession` with the other session types. Replace the comment above `MERGE_ELIGIBLE_DEVELOPMENT_PHASES` (`:49-51`) with: `// A development session's own PR is reconciled by runPrBearingSessions and adopted by adoptDevelopmentPrs (R91); this list covers the review-lineage path, and 'active' stays eligible for a session that never recorded its PR.`
  2. `export type PrBearingSession = RespondSession | InvestigationSession | DevelopmentSession;` with the doc comment's first line `/** A session that owns a PR without being a review of it: respond, investigation (R51) and development (R91). */`.
  3. In `planPrSessionReconciliation`, after the `if (session.mode === 'investigation') { … }` block, add:

```ts
  if (session.mode === 'development') {
    // R91 — a development session's own PR ending ends it: merged → merged, closed → abandoned,
    // the rule planReconciliation already applies to a review's development source. No
    // deliberate-start exception: a development session only ever adopts an OPEN PR.
    const to = view.state === 'MERGED' ? 'merged' : 'abandoned';
    proposeTransition(actions, skipped, 'development', session.id, session.stageStatus, to, reason);
    return { actions, skipped };
  }
```

  4. In `runPrBearingSessions`, change both mode tests to include development: `(s.mode === 'respond' || s.mode === 'investigation' || s.mode === 'development')` and `(fresh.mode !== 'respond' && fresh.mode !== 'investigation' && fresh.mode !== 'development')`; its doc comment says "The `respond`/`investigation`/`development` leg".
  5. Add a private method to `ReconciliationTick`:

```ts
  /**
   * R91 / I1 — every development session that is `active`, has no PR yet and has a branch: look
   * for its PR. Catches a PR opened by a run the engine died under (healed at boot by
   * failStaleRuns) and one opened in a Take over chat. Detection, the liveness skip and the
   * single locked save are PipelineService.adoptDevelopmentPr's; a miss is not an error.
   */
  private async adoptDevelopmentPrs(sessions: readonly Session[], report: TickReport): Promise<void> {
    const candidates = sessions.filter(
      (s) => s.mode === 'development' && s.stageStatus === 'active' && s.pr === null && Boolean(s.workspace.branch),
    );
    for (const candidate of candidates) {
      try {
        const after = await this.deps.pipeline.adoptDevelopmentPr(candidate.id);
        if (after.stageStatus === 'pr_opened') {
          report.actions.push({ type: 'transition', sessionId: candidate.id, to: 'pr_opened', reason: 'PR detected' });
          report.reconciled += 1;
        }
      } catch (err) {
        report.errors.push({ where: candidate.id, error: errorMessage(err) });
      }
    }
  }
```

     and in `run()`, directly after `await this.runPrBearingSessions(sessions, report);`, add `await this.adoptDevelopmentPrs(sessions, report);`.

- [ ] **Step 8: Run.** `pnpm vitest run test/pipeline/pr-detection.test.ts test/pipeline/pipeline-service.development.test.ts test/discovery test/pipeline/pipeline-service.human-turn.test.ts test/pipeline/pipeline-service.environment.test.ts test/host` → PASS. If an existing tick test in `reconciliation.test.ts` now reports an extra `gh` call or a `report.errors` entry, it saved a non-terminal development session with a `pr` that the development leg now visits: queue one more `{ stdout: viewJson({ state: 'OPEN' }) }` for it, and say so in the commit message. Then `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 9: Commit.**

```bash
git add cgremlin/core/src/pipeline/pr-detection.ts cgremlin/core/src/pipeline/pipeline-service.ts cgremlin/core/src/discovery/reconciliation.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/test/support/pipeline-harness.ts cgremlin/core/test/pipeline/pr-detection.test.ts cgremlin/core/test/pipeline/pipeline-service.development.test.ts cgremlin/core/test/discovery/reconciliation.test.ts
git commit -m "feat(cgremlin-core): development sessions record their own draft PR (pr_opened), also on the tick, and follow it to merged/closed (R91)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 6a: Feedback modules — REVIEW.md parser, `FeedbackLog`, capture rules, `feedbackPath` (§18 A6, §20, I4)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Create: `cgremlin/core/src/feedback/review-findings.ts`, `cgremlin/core/src/feedback/feedback-log.ts`, `cgremlin/core/src/feedback/feedback-capture.ts`
- Modify: `cgremlin/core/src/config/core-config.ts` (derived `feedbackPath`, `DERIVED_PATH_SUFFIXES`)
- Test: `cgremlin/core/test/feedback/review-findings.test.ts`, `cgremlin/core/test/feedback/feedback-log.test.ts`, `cgremlin/core/test/feedback/feedback-capture.test.ts` (all new), `cgremlin/core/test/config/core-config.test.ts`

**Interfaces:**
- Consumes: `appendJsonLine`, `readJsonLines`, `RunRecord` (Task 4b); `RUNNER_KINDS`, `EFFORT_LEVELS` (Task 2); `REVIEW_CONTRACT_EXAMPLE` (`src/pipeline/prompts.ts:337`); `redactSecrets`; `KeyedLock`.
- Produces:
  - `review-findings.ts`: `interface ReviewFinding { anchor; number; title; severity; where; status; dismissed }`, `type ReviewVerdict = 'approve' | 'request_changes' | 'comment'`, `parseReviewFindings(text): ReviewFinding[]`, `parseReviewVerdict(text): ReviewVerdict | null`.
  - `feedback-log.ts`: `FEEDBACK_KINDS`, `FeedbackRecordSchema`, `type FeedbackRecord`, `class FeedbackLog { constructor(fs, path); appendOnce(record): Promise<boolean>; list(): Promise<FeedbackRecord[]> }`.
  - `feedback-capture.ts`: `FEEDBACK_TEXT_CAP = 300`, `interface CaptureContext { session; sessionDir; at; producedBy }`, `findingKey(title, where): string`, `producedByFrom(runs, stages)`, `dismissalRecords(ctx, reviewText)`, `humanTransitionRecords(ctx, from, to, texts)`.
  - `CoreConfig.feedbackPath` (derived `<stateDir>/feedback.jsonl`). Task 6b consumes all of the above.

- [ ] **Step 1: Write the failing parser tests.** Create `cgremlin/core/test/feedback/review-findings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import { parseReviewFindings, parseReviewVerdict } from '../../src/feedback/review-findings';

const DISMISS_F2_DETAIL = (text: string): string =>
  text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const DISMISS_F3_ROW = (text: string): string => text.replace(/(\| \[3\]\(#f3\) \|.*\|) open \|$/m, '$1 🔇 dismissed |');

describe('REVIEW.md findings (the contract the agents are shown)', () => {
  it('reads the four findings of the contract example, none dismissed, and its verdict', () => {
    const findings = parseReviewFindings(REVIEW_CONTRACT_EXAMPLE);
    expect(findings.map((f) => f.anchor)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(findings.every((f) => !f.dismissed)).toBe(true);
    expect(findings[0]).toMatchObject({ number: 1, severity: '🔴 Critical', where: 'src/api/web-content.ts:88', status: 'open' });
    expect(findings[1]).toMatchObject({ number: 2, severity: '🔧 Maintainability', where: 'ui/list.tsx:40', title: '<plain-English title>' });
    expect(findings[2].where).toBe('/search');
    expect(parseReviewVerdict(REVIEW_CONTRACT_EXAMPLE)).toBe('request_changes');
  });

  it('a finding marked dismissed in its detail block, or only in its table row, is dismissed', () => {
    const findings = parseReviewFindings(DISMISS_F3_ROW(DISMISS_F2_DETAIL(REVIEW_CONTRACT_EXAMPLE)));
    expect(findings.map((f) => [f.anchor, f.dismissed])).toEqual([['f1', false], ['f2', true], ['f3', true], ['f4', false]]);
    expect(findings[1].status).toBe('🔇 dismissed');
  });

  it('a clean review has no findings; a file with no verdict line has no verdict', () => {
    const clean = '# PR Review: #1 — t\n**Verdict:** ✅ Approve — fine\n\n## Summary\nNothing worth flagging — looks good to me.\n\n## Details\n';
    expect(parseReviewFindings(clean)).toEqual([]);
    expect(parseReviewVerdict(clean)).toBe('approve');
    expect(parseReviewVerdict('**Verdict:** 💬 Comment — fyi')).toBe('comment');
    expect(parseReviewVerdict('# nothing here')).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing log tests.** Create `cgremlin/core/test/feedback/feedback-log.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FeedbackLog, type FeedbackRecord } from '../../src/feedback/feedback-log';
import { JSONL_FILE_MODE } from '../../src/fs/jsonl';

const PATH = '/state/feedback.jsonl';

function rec(id: string): FeedbackRecord {
  return {
    v: 1, id, at: '2026-10-08T12:00:00.000Z', source: 'auto', kind: 'finding_dismissed', text: `t ${id}`,
    context: { sessionId: 's', mode: 'review', stage: null, ticket: null, pr: null, artifact: null, anchor: null },
    producedBy: null, detail: {},
  };
}

describe('FeedbackLog (§20)', () => {
  it('appendOnce writes a record once per id, in a 0600 file', async () => {
    const fs = new InMemoryFileSystem();
    const log = new FeedbackLog(fs, PATH);
    expect(await log.appendOnce(rec('a'))).toBe(true);
    expect(await log.appendOnce(rec('a'))).toBe(false);
    expect((await log.list()).map((r) => r.id)).toEqual(['a']);
    expect(await fs.statMode(PATH)).toBe(JSONL_FILE_MODE);
  });

  it('25 concurrent appends of distinct ids keep all 25', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    await Promise.all(ids.map((id) => log.appendOnce(rec(id))));
    expect((await log.list()).map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('10 concurrent appends of the same id write it once', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    const wrote = await Promise.all(Array.from({ length: 10 }, () => log.appendOnce(rec('same'))));
    expect(wrote.filter(Boolean)).toHaveLength(1);
    expect(await log.list()).toHaveLength(1);
  });

  it('a torn line from a crash is skipped by list(), and the next record lands on its own line', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile(PATH, `${JSON.stringify(rec('a'))}\n{"v":1,"id":"torn`);
    const log = new FeedbackLog(fs, PATH);
    expect(await log.appendOnce(rec('b'))).toBe(true);
    expect((await log.list()).map((r) => r.id)).toEqual(['a', 'b']);
    expect((await fs.readFile(PATH)).split('\n')).toHaveLength(4);
  });

  it('refuses a malformed record instead of writing it', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    await expect(log.appendOnce({ ...rec('x'), kind: 'nope' } as unknown as FeedbackRecord)).rejects.toThrow();
    expect(await log.list()).toEqual([]);
  });

  it('reads and writes only its own file — never core.json or anything else in the state dir', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', '{"jira":{"apiToken":"SECRET"}}');
    const touched: string[] = [];
    const realRead = fs.readFile.bind(fs);
    fs.readFile = async (p: string) => {
      touched.push(p);
      return realRead(p);
    };
    const log = new FeedbackLog(fs, PATH);
    await log.appendOnce(rec('a'));
    await log.appendOnce(rec('b'));
    await log.list();
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((p) => p === PATH)).toBe(true);
  });
});
```

- [ ] **Step 3: Write the failing capture tests.** Create `cgremlin/core/test/feedback/feedback-capture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import {
  dismissalRecords,
  findingKey,
  humanTransitionRecords,
  producedByFrom,
  type CaptureContext,
} from '../../src/feedback/feedback-capture';
import type { RunRecord } from '../../src/pipeline/run-records';
import type { Session } from '../../src/schema/session';

const AT = '2026-10-08T12:00:00.000Z';
const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const DISMISS_F1 = (text: string): string => text.replace(/(<a id="f1"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');

const review: Session = {
  schemaVersion: 2, id: 'rev-1', mode: 'review', createdAt: AT,
  workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/w/rev-1', branch: 'pr-1' },
  lineage: { pipelineId: 'rev-1', parentSessionId: null, ticket: 'APP-1', selfReview: false },
  stageStatus: 'ready', agent: null, lastRun: null,
  pr: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1', headSha: null, reviewedSha: null, title: 'T', author: 'bob' },
  reviewVersion: 0, lastRereviewSummary: null,
};
const investigation: Session = {
  schemaVersion: 2, id: 'inv-1', mode: 'investigation', createdAt: AT,
  workspace: { repoUrl: 'git@github.com:acme/app.git' },
  lineage: { pipelineId: 'inv-1', parentSessionId: null, ticket: 'APP-1', selfReview: false },
  stageStatus: 'plan_ready', agent: null, lastRun: null, pr: null, intent: 'investigate_only', driveToCompletion: false,
};
const BY = { stage: 'review' as const, runner: 'claude-code' as const, model: 'opus', effort: 'high' as const };
const ctx = (session: Session): CaptureContext => ({ session, sessionDir: `/sessions/${session.id}`, at: AT, producedBy: BY });

describe('feedback capture rules (§20)', () => {
  it('one record per dismissed finding, keyed by session, anchor and the finding itself', () => {
    const records = dismissalRecords(ctx(review), DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
    expect(records).toEqual([
      {
        v: 1, id: `finding_dismissed:rev-1:f2:${findingKey('<plain-English title>', 'ui/list.tsx:40')}`, at: AT, source: 'auto', kind: 'finding_dismissed',
        text: 'Dismissed finding 2 (🔧 Maintainability, ui/list.tsx:40): <plain-English title>',
        context: {
          sessionId: 'rev-1', mode: 'review', stage: 'review', ticket: 'APP-1', pr: { repo: 'acme/app', number: 1 },
          artifact: '/sessions/rev-1/REVIEW.md', anchor: 'f2',
        },
        producedBy: BY,
        detail: { number: 2, severity: '🔧 Maintainability', where: 'ui/list.tsx:40', title: '<plain-English title>' },
      },
    ]);
    expect(records[0].id).toMatch(/^finding_dismissed:rev-1:f2:[0-9a-f]{12}$/);
    expect(dismissalRecords(ctx(review), REVIEW_CONTRACT_EXAMPLE)).toEqual([]);
  });

  it('I4 — a review that restarts its anchors does not swallow a different dismissed finding', () => {
    const first = DISMISS_F1(REVIEW_CONTRACT_EXAMPLE);
    const rerun = DISMISS_F1(REVIEW_CONTRACT_EXAMPLE.replace('### 1. <plain-English title of the problem>', '### 1. a different problem'));
    const [a] = dismissalRecords(ctx(review), first);
    const [b] = dismissalRecords(ctx(review), rerun);
    const [again] = dismissalRecords(ctx(review), first);
    expect(a.context.anchor).toBe('f1');
    expect(b.context.anchor).toBe('f1');
    expect(a.id).not.toBe(b.id);
    expect(again.id).toBe(a.id);
    expect(findingKey('  Same  Title ', 'a.ts:1')).toBe(findingKey('same title', 'a.ts:1'));
  });

  it('feedback text is one line, redacted and capped', () => {
    const nasty = DISMISS_F2(
      REVIEW_CONTRACT_EXAMPLE.replace('### 2. <plain-English title>', `### 2. leaks Authorization: Bearer abcdefghijklmnop and ${'x'.repeat(400)}`),
    );
    const [record] = dismissalRecords(ctx(review), nasty);
    expect(record.text).not.toContain('abcdefghijklmnop');
    expect(record.text).toContain('<redacted>');
    expect(record.text).not.toContain('\n');
    expect(record.text.length).toBeLessThanOrEqual(301);
    expect(String(record.detail.title)).not.toContain('abcdefghijklmnop');
  });

  it('approving a PR the review asked changes on is a rejected verdict; approving an approved one is not', () => {
    const rejected = humanTransitionRecords(ctx(review), 'ready', 'approved', { review: REVIEW_CONTRACT_EXAMPLE, plan: null });
    expect(rejected.map((r) => [r.kind, r.id, r.detail])).toEqual([
      ['verdict_rejected', 'verdict_rejected:rev-1:REVIEW.md', { verdict: 'request_changes', action: 'approved', openFindings: 4, from: 'ready' }],
    ]);
    const approve = REVIEW_CONTRACT_EXAMPLE.replace('**Verdict:** 🔄 Request changes', '**Verdict:** ✅ Approve');
    expect(humanTransitionRecords(ctx(review), 'ready', 'approved', { review: approve, plan: null })).toEqual([]);
  });

  it('a person dismissing a review with a REVIEW.md is review_dismissed; with none it is nothing', () => {
    expect(humanTransitionRecords(ctx(review), 'ready', 'dismissed', { review: REVIEW_CONTRACT_EXAMPLE, plan: null }).map((r) => r.id)).toEqual([
      'review_dismissed:rev-1',
    ]);
    expect(humanTransitionRecords(ctx(review), 'ready', 'dismissed', { review: null, plan: null })).toEqual([]);
  });

  it('abandoning an investigation at plan_ready with a PLAN.md rejects the plan verdict; from planning it does not', () => {
    expect(humanTransitionRecords(ctx(investigation), 'plan_ready', 'abandoned', { review: null, plan: '# plan' }).map((r) => r.id)).toEqual([
      'verdict_rejected:inv-1:PLAN.md',
    ]);
    expect(humanTransitionRecords(ctx(investigation), 'planning', 'abandoned', { review: null, plan: '# plan' })).toEqual([]);
    expect(humanTransitionRecords(ctx(investigation), 'plan_ready', 'abandoned', { review: null, plan: null })).toEqual([]);
  });

  it('producedByFrom picks the newest run of the given stages', () => {
    const run = (stage: RunRecord['stage'], model: string): RunRecord => ({
      v: 1, sessionId: 'rev-1', stage, runner: 'claude-code', model, effort: null, routeSource: 'legacy', fresh: false, resumed: false,
      startedAt: AT, finishedAt: AT, tokens: null, tokensSource: null, costUsd: null, modelUsage: null, limitEvents: [],
      outcome: 'succeeded', stopReason: null, error: null, interrupted: false,
    });
    expect(producedByFrom([run('review', 'a'), run('rereview', 'b'), run('respond', 'c')], ['review', 'rereview'])).toEqual({
      stage: 'rereview', runner: 'claude-code', model: 'b', effort: null,
    });
    expect(producedByFrom([run('respond', 'c')], ['review'])).toBeNull();
  });
});
```

Append to `test/config/core-config.test.ts` (inside `describe('resolveCoreConfig', …)`):

```ts
  it('derives feedbackPath under stateDir (§20)', () => {
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    expect(cfg.feedbackPath).toBe(`${HOME}/.cgremlin-core/feedback.jsonl`);
  });
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/feedback test/config/core-config.test.ts` → FAIL (modules missing; no `feedbackPath`).

- [ ] **Step 5: Implement `review-findings.ts`.** Create `cgremlin/core/src/feedback/review-findings.ts`:

```ts
/**
 * §20 — what the engine reads back out of REVIEW.md: its findings (by stable anchor) and its
 * verdict. The shape is the contract the agents are shown (REVIEW_CONTRACT_EXAMPLE,
 * src/pipeline/prompts.ts); the table row and the detail block each carry a Status, and a
 * finding is dismissed when EITHER says so (the contract keeps them equal; a hand edit may not).
 */
export interface ReviewFinding {
  /** `f1`, `f2`, … — stable across re-reviews, but a fresh review restarts them (S2-27). */
  anchor: string;
  number: number;
  title: string | null;
  severity: string | null;
  /** `Where` (a path:line) or, for 📋/🎨 findings, `Route`. */
  where: string | null;
  /** The detail block's Status, else the table row's. */
  status: string | null;
  dismissed: boolean;
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

const TABLE_ROW = /^\|\s*\[(\d+)\]\(#(f\d+)\)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;
const ANCHOR = /^<a id="(f\d+)"><\/a>$/;
const DETAIL_HEADING = /^###\s+\d+\.\s+(.+)$/;
const FIELD = /^-\s+\*\*(Severity|Where|Route|Status):\*\*\s*(.*)$/;
const SECTION = /^#{1,2}\s/;
const DISMISSED = /dismissed/i;
const VERDICT = /^\*\*Verdict:\*\*\s*(✅|🔄|💬)/mu;

interface Draft {
  anchor: string;
  number: number;
  title: string | null;
  severity: string | null;
  where: string | null;
  tableStatus: string | null;
  detailStatus: string | null;
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function unticked(value: string): string {
  return value.trim().replace(/^`(.*)`$/, '$1');
}

export function parseReviewFindings(text: string): ReviewFinding[] {
  const drafts = new Map<string, Draft>();
  const draftFor = (anchor: string): Draft => {
    let draft = drafts.get(anchor);
    if (draft === undefined) {
      draft = { anchor, number: Number(anchor.slice(1)), title: null, severity: null, where: null, tableStatus: null, detailStatus: null };
      drafts.set(anchor, draft);
    }
    return draft;
  };
  let current: Draft | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const row = TABLE_ROW.exec(line);
    if (row) {
      const draft = draftFor(row[2]);
      draft.number = Number(row[1]);
      if (draft.severity === null) draft.severity = orNull(row[3]);
      if (draft.where === null) draft.where = orNull(unticked(row[4]));
      if (draft.title === null) draft.title = orNull(row[5]);
      draft.tableStatus = orNull(row[6]);
      continue;
    }
    const anchor = ANCHOR.exec(line);
    if (anchor) {
      current = draftFor(anchor[1]);
      continue;
    }
    if (current === null) continue;
    if (SECTION.test(line)) {
      current = null;
      continue;
    }
    const heading = DETAIL_HEADING.exec(line);
    if (heading) {
      current.title = heading[1].trim();
      continue;
    }
    const field = FIELD.exec(line);
    if (field) {
      if (field[1] === 'Severity') current.severity = orNull(field[2]);
      else if (field[1] === 'Status') current.detailStatus = orNull(field[2]);
      else current.where = orNull(unticked(field[2]));
    }
  }
  return [...drafts.values()]
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      anchor: d.anchor,
      number: d.number,
      title: d.title,
      severity: d.severity,
      where: d.where,
      status: d.detailStatus ?? d.tableStatus,
      dismissed: DISMISSED.test(d.detailStatus ?? '') || DISMISSED.test(d.tableStatus ?? ''),
    }));
}

/** Line 2 of REVIEW.md: `**Verdict:** <glyph> <label> — …`. */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const match = VERDICT.exec(text);
  if (match === null) return null;
  return match[1] === '✅' ? 'approve' : match[1] === '🔄' ? 'request_changes' : 'comment';
}
```

- [ ] **Step 6: Implement `feedback-log.ts`.** Create `cgremlin/core/src/feedback/feedback-log.ts`:

```ts
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { appendJsonLine, readJsonLines } from '../fs/jsonl';
import { KeyedLock } from '../api/keyed-lock';
import { StageNameSchema } from '../schema/stage';
import { EFFORT_LEVELS, RUNNER_KINDS } from '../config/routing';

export const FEEDBACK_KINDS = ['finding_dismissed', 'review_dismissed', 'verdict_rejected'] as const;

/**
 * §20 — one line of `<stateDir>/feedback.jsonl`. `id` is deterministic per signal, so the same
 * dismissal seen at two hand-over points is one record. `source: 'user'` is reserved for the
 * 💡 Improve button (step 11); step 2 writes only `auto`.
 */
export const FeedbackRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  at: z.string(),
  source: z.enum(['auto', 'user']),
  kind: z.enum(FEEDBACK_KINDS),
  text: z.string(),
  context: z.object({
    sessionId: z.string().min(1),
    mode: z.string(),
    stage: StageNameSchema.nullable(),
    ticket: z.string().nullable(),
    pr: z.object({ repo: z.string(), number: z.number().int() }).nullable(),
    /** Absolute path of the file the signal is about. */
    artifact: z.string().nullable(),
    /** A finding's anchor (`f2`), when the signal is about one finding. */
    anchor: z.string().nullable(),
  }),
  /** The run that produced the artifact (newest matching record in the session's runs.jsonl). */
  producedBy: z
    .object({ stage: StageNameSchema, runner: z.enum(RUNNER_KINDS), model: z.string().nullable(), effort: z.enum(EFFORT_LEVELS).nullable() })
    .nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

const IdOnly = z.object({ id: z.string() }).passthrough();

/**
 * The engine's single writer of feedback.jsonl. Appends are serialized in-process (its own
 * lock, not the session lock) and each one rewrites the file tmp-then-rename (src/fs/jsonl.ts),
 * so concurrent signals never lose or tear a record. It reads and writes ONLY `path`.
 */
export class FeedbackLog {
  private readonly lock = new KeyedLock();

  constructor(
    private readonly fs: SessionFileSystem,
    readonly path: string,
  ) {}

  /** Appends unless a record with this id is already there. Returns whether it wrote. */
  async appendOnce(record: FeedbackRecord): Promise<boolean> {
    const valid = FeedbackRecordSchema.parse(record);
    return this.lock.withLock('append', async () => {
      const existing = await readJsonLines(this.fs, this.path, IdOnly);
      if (existing.some((r) => r.id === valid.id)) return false;
      await appendJsonLine(this.fs, this.path, valid);
      return true;
    });
  }

  async list(): Promise<FeedbackRecord[]> {
    return readJsonLines(this.fs, this.path, FeedbackRecordSchema);
  }
}
```

- [ ] **Step 7: Implement `feedback-capture.ts`.** Create `cgremlin/core/src/feedback/feedback-capture.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Session } from '../schema/session';
import type { StageName } from '../schema/stage';
import type { RunRecord } from '../pipeline/run-records';
import { redactSecrets } from '../config/core-config';
import type { FeedbackRecord } from './feedback-log';
import { parseReviewFindings, parseReviewVerdict, type ReviewVerdict } from './review-findings';

/** Feedback text is data an agent wrote: one line, redacted, capped. */
export const FEEDBACK_TEXT_CAP = 300;

export interface CaptureContext {
  session: Session;
  sessionDir: string;
  /** ISO time of the observation. */
  at: string;
  producedBy: FeedbackRecord['producedBy'];
}

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: '✅ Approve',
  request_changes: '🔄 Request changes',
  comment: '💬 Comment',
};

function clean(text: string): string {
  const oneLine = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return oneLine.length > FEEDBACK_TEXT_CAP ? `${oneLine.slice(0, FEEDBACK_TEXT_CAP)}…` : oneLine;
}

/**
 * I4 / S2-27 — 12 hex of sha256 over the normalized title and location: what makes a finding
 * the same finding when a fresh review restarts its anchors at f1.
 */
export function findingKey(title: string | null, where: string | null): string {
  const norm = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(`${norm(title)}\n${norm(where)}`).digest('hex').slice(0, 12);
}

function contextOf(ctx: CaptureContext, artifact: string, anchor: string | null): FeedbackRecord['context'] {
  const s = ctx.session;
  return {
    sessionId: s.id,
    mode: s.mode,
    stage: ctx.producedBy?.stage ?? null,
    ticket: s.lineage.ticket,
    pr: s.pr === null ? null : { repo: s.pr.repo, number: s.pr.number },
    artifact,
    anchor,
  };
}

/** The newest run of one of `stages` in a session's runs.jsonl: who produced the artifact. */
export function producedByFrom(runs: readonly RunRecord[], stages: readonly StageName[]): FeedbackRecord['producedBy'] {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (stages.includes(run.stage)) return { stage: run.stage, runner: run.runner, model: run.model, effort: run.effort };
  }
  return null;
}

/** §20 — one record per finding marked dismissed; the id makes each finding count once (S2-27). */
export function dismissalRecords(ctx: CaptureContext, reviewText: string): FeedbackRecord[] {
  const artifact = `${ctx.sessionDir}/REVIEW.md`;
  return parseReviewFindings(reviewText)
    .filter((f) => f.dismissed)
    .map((f) => {
      const where = f.severity === null ? '' : ` (${f.severity}${f.where === null ? '' : `, ${f.where}`})`;
      return {
        v: 1 as const,
        id: `finding_dismissed:${ctx.session.id}:${f.anchor}:${findingKey(f.title, f.where)}`,
        at: ctx.at,
        source: 'auto' as const,
        kind: 'finding_dismissed' as const,
        text: clean(`Dismissed finding ${f.number}${where}: ${f.title ?? '(untitled)'}`),
        context: contextOf(ctx, artifact, f.anchor),
        producedBy: ctx.producedBy,
        detail: {
          number: f.number,
          severity: f.severity,
          where: f.where === null ? null : clean(f.where),
          title: f.title === null ? null : clean(f.title),
        },
      };
    });
}

/**
 * §20 / S2-18 — a PERSON's API action against an engine verdict. Only called for transitions
 * marked `by: 'human'`; the reconciliation tick's transitions never reach here. Today only
 * `/approve-pr` exercises this from the extension; the rest fire from raw API calls (S2-28).
 */
export function humanTransitionRecords(
  ctx: CaptureContext,
  from: string,
  to: string,
  texts: { review: string | null; plan: string | null },
): FeedbackRecord[] {
  const s = ctx.session;
  const out: FeedbackRecord[] = [];
  if (s.mode === 'review' && texts.review !== null) {
    const verdict = parseReviewVerdict(texts.review);
    const open = parseReviewFindings(texts.review).filter((f) => !f.dismissed && !/resolved/i.test(f.status ?? '')).length;
    const findingsText = `${open} open finding${open === 1 ? '' : 's'}`;
    const artifact = `${ctx.sessionDir}/REVIEW.md`;
    if (to === 'approved' && verdict === 'request_changes') {
      out.push({
        v: 1, id: `verdict_rejected:${s.id}:REVIEW.md`, at: ctx.at, source: 'auto', kind: 'verdict_rejected',
        text: clean(`Approved the PR although the review said ${VERDICT_LABEL[verdict]} (${findingsText})`),
        context: contextOf(ctx, artifact, null), producedBy: ctx.producedBy,
        detail: { verdict, action: 'approved', openFindings: open, from },
      });
    }
    if (to === 'dismissed') {
      out.push({
        v: 1, id: `review_dismissed:${s.id}`, at: ctx.at, source: 'auto', kind: 'review_dismissed',
        text: clean(`Dismissed the review (verdict ${verdict === null ? 'none' : VERDICT_LABEL[verdict]}, ${findingsText})`),
        context: contextOf(ctx, artifact, null), producedBy: ctx.producedBy,
        detail: { verdict, action: 'dismissed', openFindings: open, from },
      });
    }
  }
  if (s.mode === 'investigation' && from === 'plan_ready' && to === 'abandoned' && texts.plan !== null) {
    out.push({
      v: 1, id: `verdict_rejected:${s.id}:PLAN.md`, at: ctx.at, source: 'auto', kind: 'verdict_rejected',
      text: 'Abandoned the investigation at plan_ready: the plan the PM and Principal Engineer reviewers approved was not taken',
      context: contextOf(ctx, `${ctx.sessionDir}/PLAN.md`, null), producedBy: ctx.producedBy,
      detail: { verdict: 'approved', action: 'abandoned', from },
    });
  }
  return out;
}
```

- [ ] **Step 8: Derive `feedbackPath`.** In `src/config/core-config.ts`: add to `CoreConfigSchema` (after `dismissalsPath`):

```ts
  /** §20, derived: <stateDir>/feedback.jsonl — dismissed findings and rejected verdicts. */
  feedbackPath: z.string().optional(),
```

  in `resolveCoreConfig`'s return add `feedbackPath: expandOrDerive(parsed.feedbackPath, 'feedback.jsonl'),` after `dismissalsPath`; in `DERIVED_PATH_SUFFIXES` add `feedbackPath: 'feedback.jsonl',` after `dismissalsPath` (both registrations, per the note at `:249-251`).

- [ ] **Step 9: Run.** `pnpm vitest run test/feedback test/config` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 10: Commit.**

```bash
git add cgremlin/core/src/feedback cgremlin/core/src/config/core-config.ts cgremlin/core/test/feedback cgremlin/core/test/config/core-config.test.ts
git commit -m "feat(cgremlin-core): feedback modules — REVIEW.md findings, FeedbackLog, capture rules, feedbackPath (§20)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 6b: Feedback hooks — pipeline, API routes, engine wiring (§20, I5, M6)

**Tier / trailer:** `executor-heavy` (Claude Opus 5.5) — use that model in the commit trailer.

**Files:**
- Modify: `cgremlin/core/src/pipeline/pipeline-service.ts` (deps `feedback?`; `transition(id, to, opts)`; `releaseConversation`; `runReview`; `runRereview`; three private capture methods)
- Modify: `cgremlin/core/src/api/server.ts` (the `/transition` and `/approve-pr` routes)
- Modify: `cgremlin/core/src/host/build-engine.ts` (`feedback: new FeedbackLog(…)`)
- Modify: `cgremlin/core/test/support/pipeline-harness.ts` (`HarnessOptions.feedback`, `PipelineHarness.feedback`)
- Test: `cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts` (new), `cgremlin/core/test/api/feedback-routes.test.ts` (new)

**Interfaces:**
- Consumes: everything Task 6a produces; `readRunRecords` (Task 4b); `PipelineService.log` (Task 4b); `readNonEmpty`.
- Produces: `PipelineServiceDeps.feedback?: FeedbackLog`; `PipelineService.transition(id: string, to: string, opts?: { by?: 'human' }): Promise<Session>`; `HarnessOptions.feedback?: (fs: InMemoryFileSystem) => FeedbackLog`; `PipelineHarness.feedback: FeedbackLog | undefined`.

- [ ] **Step 1: Extend the harness.** In `test/support/pipeline-harness.ts`: import `FeedbackLog` from `../../src/feedback/feedback-log`; add to `HarnessOptions`:

```ts
  /** §20 — PipelineServiceDeps.feedback, built on the harness's own fs; omitted means no capture. */
  feedback?: (fs: InMemoryFileSystem) => FeedbackLog;
```

  add `feedback: FeedbackLog | undefined;` to `PipelineHarness`; in `createHarness` compute `const feedback = options.feedback?.(fs);`, pass `...(feedback !== undefined ? { feedback } : {}),` to `new PipelineService`, and add `feedback` to the returned object.

- [ ] **Step 2: Write the failing pipeline tests.** Create `cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FeedbackLog } from '../../src/feedback/feedback-log';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';

const FEEDBACK = '/state/feedback.jsonl';
const DISMISSED_F2_ID = /^finding_dismissed:rev-1:f2:[0-9a-f]{12}$/;
const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));

function review(id: string, stageStatus: 'queued' | 'ready' = 'ready'): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus, agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 'T', author: 'bob' },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

function planReady(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'investigate/APP-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus: 'plan_ready', agent: null, lastRun: null, pr: null, intent: 'investigate_only', driveToCompletion: false,
  };
}

function withFeedback(log?: (line: string) => void): PipelineHarness {
  return createHarness({ feedback: (fs) => new FeedbackLog(fs, FEEDBACK), ...(log ? { log } : {}) });
}

async function artifact(h: PipelineHarness, id: string, name: string, text: string): Promise<void> {
  await h.fs.mkdir(`${SESSIONS_DIR}/${id}`, { recursive: true });
  await h.fs.writeFile(`${SESSIONS_DIR}/${id}/${name}`, text);
}

describe('§20 — the engine captures dismissals and rejected verdicts', () => {
  it('releasing the conversation records each dismissed finding once, and reads no config file', async () => {
    const h = withFeedback();
    const reads: string[] = [];
    const realRead = h.fs.readFile.bind(h.fs);
    h.fs.readFile = async (p: string) => {
      reads.push(p);
      return realRead(p);
    };
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
    await h.service.releaseConversation('rev-1');
    await h.service.releaseConversation('rev-1');
    const records = await h.feedback!.list();
    expect(records.map((r) => r.kind)).toEqual(['finding_dismissed']);
    expect(records[0].id).toMatch(DISMISSED_F2_ID);
    expect(records[0].context).toMatchObject({ sessionId: 'rev-1', mode: 'review', pr: { repo: 'acme/app', number: 1 }, artifact: `${SESSIONS_DIR}/rev-1/REVIEW.md`, anchor: 'f2' });
    expect(reads.some((p) => p.endsWith('core.json') || p.endsWith('/config'))).toBe(false);
  });

  it('a review run records dismissals before the agent rewrites REVIEW.md, attributed to the run that wrote it', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1', 'queued'));
    const first = h.service.runReview('rev-1');
    await h.finishRun({ 'REVIEW.md': DISMISS_F2(REVIEW_CONTRACT_EXAMPLE) }, { code: 0, signal: null });
    await first;
    expect(await h.feedback!.list()).toEqual([]);
    const second = h.service.runReview('rev-1');
    await h.finishRun({ 'REVIEW.md': REVIEW_CONTRACT_EXAMPLE }, { code: 0, signal: null });
    await second;
    const records = await h.feedback!.list();
    expect(records).toHaveLength(1);
    expect(records[0].id).toMatch(DISMISSED_F2_ID);
    expect(records[0].producedBy).toEqual({ stage: 'review', runner: 'claude-code', model: null, effort: null });
  });

  it('a person approving a PR the review asked changes on, or dismissing a review, is recorded', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1'));
    await h.store.save(review('rev-2'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await artifact(h, 'rev-2', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await h.service.transition('rev-1', 'approved', { by: 'human' });
    await h.service.transition('rev-2', 'dismissed', { by: 'human' });
    expect((await h.feedback!.list()).map((r) => [r.kind, r.id])).toEqual([
      ['verdict_rejected', 'verdict_rejected:rev-1:REVIEW.md'],
      ['review_dismissed', 'review_dismissed:rev-2'],
    ]);
  });

  it('a person abandoning an investigation at plan_ready rejects its plan verdict', async () => {
    const h = withFeedback();
    await h.store.save(planReady('inv-1'));
    await artifact(h, 'inv-1', 'PLAN.md', '# plan');
    await h.service.transition('inv-1', 'abandoned', { by: 'human' });
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['verdict_rejected:inv-1:PLAN.md']);
  });

  it('a reconciliation dismissal records nothing — only a person’s API action is feedback', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: JSON.stringify({ ...baseView, number: 1, url: 'https://github.com/acme/app/pull/1', state: 'MERGED', mergedAt: '2026-10-09T00:00:00Z' }) });
    await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect((await h.store.load('rev-1')).stageStatus).toBe('dismissed');
    await h.store.save(review('rev-2'));
    await artifact(h, 'rev-2', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await h.service.transition('rev-2', 'dismissed');
    expect(await h.feedback!.list()).toEqual([]);
  });

  it('a capture failure never blocks the transition it observes', async () => {
    const logs: string[] = [];
    const h = createHarness({
      log: (line) => logs.push(line),
      feedback: (fs) => {
        const log = new FeedbackLog(fs, FEEDBACK);
        log.appendOnce = async () => {
          throw new Error('disk full');
        };
        return log;
      },
    });
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    const after = await h.service.transition('rev-1', 'approved', { by: 'human' });
    expect(after.stageStatus).toBe('approved');
    expect(logs).toEqual([expect.stringContaining('feedback capture for rev-1 failed: disk full')]);
  });
});
```

- [ ] **Step 3: Write the failing route tests (M6: behaviour through the API server, not a source pin).** Create `cgremlin/core/test/api/feedback-routes.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { FeedbackLog } from '../../src/feedback/feedback-log';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath, path: urlPath, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function review(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'ready', agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob' },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

async function withReview(id: string): Promise<void> {
  await h.store.save(review(id));
  await h.fs.mkdir(`${SESSIONS_DIR}/${id}`, { recursive: true });
  await h.fs.writeFile(`${SESSIONS_DIR}/${id}/REVIEW.md`, REVIEW_CONTRACT_EXAMPLE);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-feedback-routes-'));
  socketPath = path.join(dir, 'api.sock');
  h = createHarness({ feedback: (fs) => new FeedbackLog(fs, '/state/feedback.jsonl') });
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    prApprover: { approve: async () => undefined },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('§20 — the routes a person calls are the human transitions', () => {
  it('POST /approve-pr over a 🔄 Request changes review records a rejected verdict', async () => {
    await withReview('rev-1');
    expect((await request('POST', '/sessions/rev-1/approve-pr')).status).toBe(200);
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['verdict_rejected:rev-1:REVIEW.md']);
  });

  it('POST /transition to dismissed records review_dismissed', async () => {
    await withReview('rev-2');
    expect((await request('POST', '/sessions/rev-2/transition', { to: 'dismissed' })).status).toBe(200);
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['review_dismissed:rev-2']);
  });
});
```

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/pipeline/pipeline-service.feedback.test.ts test/api/feedback-routes.test.ts` → FAIL (`transition` ignores `by`; nothing captured; the harness has no `feedback`).

- [ ] **Step 5: Hook the pipeline.** In `src/pipeline/pipeline-service.ts` (lines 1-14 untouched):
  1. Imports: `import type { FeedbackLog } from '../feedback/feedback-log';`, `import { dismissalRecords, humanTransitionRecords, producedByFrom, type CaptureContext } from '../feedback/feedback-capture';`, and add `readRunRecords` to the existing `./run-records` import (Task 4b).
  2. `PipelineServiceDeps` gains:

```ts
  /**
   * §20 — where dismissed findings and rejected verdicts are recorded. Absent: nothing is
   * captured. Capture never throws and never blocks the action it observes.
   */
  feedback?: FeedbackLog;
```

  3. Replace `transition`:

```ts
  /**
   * `by: 'human'` marks a transition a person asked for through the API (`/transition`,
   * `/approve-pr`) — the only kind that can reject an engine verdict (§20). The reconciliation
   * tick never passes it, so a merged PR dismissing its review is never recorded as feedback.
   */
  async transition(id: string, to: string, opts: { by?: 'human' } = {}): Promise<Session> {
    if (opts.by !== 'human' || this.deps.feedback === undefined) {
      return this.lock.withLock(id, () => this.transitionUnlocked(id, to));
    }
    const { before, after } = await this.lock.withLock(id, async () => {
      const before = await this.deps.store.load(id);
      const after = await this.transitionUnlocked(id, to);
      return { before, after };
    });
    await this.captureHumanTransition(before, to);
    return after;
  }
```

  4. Add the capture methods after `transition`:

```ts
  private async feedbackContext(session: Session, stages: readonly StageName[]): Promise<CaptureContext> {
    const sessionDir = this.sessionDir(session.id);
    const runs = await readRunRecords(this.deps.fs, sessionDir).catch(() => []);
    return { session, sessionDir, at: this.now().toISOString(), producedBy: producedByFrom(runs, stages) };
  }

  /**
   * §20 / S2-17 — every finding this review's REVIEW.md marks dismissed, recorded once (S2-27).
   * Called where REVIEW.md changes hands: a conversation release, just before a review run
   * rewrites it, just before a re-review archives it, and on a person's transition. Unlocked:
   * it reads session-dir files and writes only feedback.jsonl. Never throws.
   */
  private async captureDismissals(session: Session, reviewText?: string | null): Promise<void> {
    const feedback = this.deps.feedback;
    if (feedback === undefined || session.mode !== 'review') return;
    try {
      const text = reviewText !== undefined ? reviewText : await readNonEmpty(this.deps.fs, `${this.sessionDir(session.id)}/REVIEW.md`);
      if (text === null) return;
      const ctx = await this.feedbackContext(session, ['review', 'rereview']);
      for (const record of dismissalRecords(ctx, text)) await feedback.appendOnce(record);
    } catch (err) {
      this.log(`feedback capture for ${session.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** §20 / S2-18 — a person's transition against an engine verdict. Never throws. */
  private async captureHumanTransition(before: Session, to: string): Promise<void> {
    const feedback = this.deps.feedback;
    if (feedback === undefined) return;
    try {
      const dir = this.sessionDir(before.id);
      const review = before.mode === 'review' ? await readNonEmpty(this.deps.fs, `${dir}/REVIEW.md`) : null;
      const plan = before.mode === 'investigation' ? await readNonEmpty(this.deps.fs, `${dir}/PLAN.md`) : null;
      if (review !== null) await this.captureDismissals(before, review);
      const ctx = await this.feedbackContext(before, before.mode === 'investigation' ? ['plan'] : ['review', 'rereview']);
      for (const record of humanTransitionRecords(ctx, before.stageStatus, to, { review, plan })) {
        await feedback.appendOnce(record);
      }
    } catch (err) {
      this.log(`feedback capture for ${before.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

  5. `releaseConversation`: change `return this.lock.withLock(id, async () => { … return result; });` to `const released = await this.lock.withLock(id, async () => { … return result; }); await this.captureDismissals(released); return released;` (the locked body is unchanged; capture runs after the lock is released).
  6. `runReview`: directly after `if (pf.blocked !== null) return pf.blocked;` add `await this.captureDismissals(session); // §20 — before the agent rewrites REVIEW.md`.
  7. `runRereview`: directly after `const existingReview = await readNonEmpty(this.deps.fs, `${sessionDir}/REVIEW.md`);` add `await this.captureDismissals(session, existingReview); // §20 — before it is archived`.

- [ ] **Step 6: Mark the human routes and wire the log.** In `src/api/server.ts`:
  - `/transition` route: `const updated = await deps.pipeline.transition(id, body.to);` → `const updated = await deps.pipeline.transition(id, body.to, { by: 'human' });`
  - `/approve-pr` route: `const updated = await deps.pipeline.transition(id, 'approved');` → `const updated = await deps.pipeline.transition(id, 'approved', { by: 'human' });`

  In `src/host/build-engine.ts`: `import { FeedbackLog } from '../feedback/feedback-log';` and in `new PipelineService({ … })` add, after `gh: adapters.gh,`:

```ts
    // §20 — guarded: a hand-built test config may carry no derived feedbackPath, and a FeedbackLog
    // on an undefined path would write a file literally named "undefined".
    ...(config.feedbackPath !== undefined ? { feedback: new FeedbackLog(adapters.fs, config.feedbackPath) } : {}),
```

- [ ] **Step 7: Run.** `pnpm vitest run test/pipeline/pipeline-service.feedback.test.ts test/api test/pipeline/pipeline-service.human-turn.test.ts test/pipeline/pipeline-service.review.test.ts test/discovery test/host` → PASS; then `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 8: Commit.**

```bash
git add cgremlin/core/src/pipeline/pipeline-service.ts cgremlin/core/src/api/server.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/test/support/pipeline-harness.ts cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts cgremlin/core/test/api/feedback-routes.test.ts
git commit -m "feat(cgremlin-core): feedback.jsonl captures dismissed findings and rejected verdicts; only human API routes count (§20)" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

### Task 7: DECISIONS, docs, full gates

**Tier / trailer:** `executor` (Claude Sonnet 5.5) — use that model in the commit trailer.

**Files:**
- Modify: `cgremlin/core/docs/DECISIONS.md` (append the section below)
- Verify only: `bin/`, `plugin/skills/`, `src/pipeline/preflight.ts` and its two tests are unchanged

**Interfaces:**
- Consumes: everything Tasks 1-6b produced.
- Produces: the DECISIONS entry the release row and the tracker log point to.

- [ ] **Step 1: DECISIONS entry.** Append to `cgremlin/core/docs/DECISIONS.md`:

```markdown
## 2026-10-08 — Step 2 (Foundations: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl; R90/R91/R116/R118f/§20)

- **Fresh runs (R90).** `StageRunInput.fresh` starts a run with no `--resume`, whatever the
  session's agent record holds; a fresh run that reports no conversation id keeps the previous
  one so Take over still works. Before a fresh round, `BRIEF.md` is copied and `FEEDBACK.md`
  moved to `<STEM>-v<N>.md` under one round number; `StageRunInput.feedback` writes the round's
  `FEEDBACK.md`. No existing stage passes `fresh` yet: phase rounds (step 5) are the first caller.
- **PR tracking (R91).** After every develop run that reached the agent (any outcome), and on
  every reconciliation tick for an `active` development session with no PR and no live run, the
  engine looks for the session's OPEN PR with read-only `gh pr view` / `gh pr list`. The agent's
  `PR_URL` is a hint that must name this repo and this branch, be OPEN and be authored by `me`
  (`core.json`), else `gh pr list --head <branch> --state open` decides on a single match by `me`.
  Adoption is one locked save: `session.pr` + `active → pr_opened`. A non-draft PR is adopted
  and flagged in `lastRun.error` (R112). Development sessions follow their own PR: merged →
  `merged`, closed → `abandoned`. `runDevelop` runs from `active` and `pr_opened`.
  - A fix round from `pr_opened` reuses today's develop brief, which still says
    `gh pr create --draft` (`prompts.ts:643`), until step 5 adds a fix-round brief.
  - A self-review of a dev PR now really moves the dev session to `superseded`
    (`linkPrToSource`), which `runDevelop` does not run from.
  - The tick costs one `gh pr list` per active dev session without a PR, per poll.
- **Routing (R116).** `routing.<stage> = { runner, model?, effort?, escalate?, secondOpinion? }`,
  keyed by StageName; `escalate` targets may name an `advisor`. `core.json` keeps it raw and the
  engine parses it at build time: an unknown stage, an invalid entry, or **codex as a primary
  runner (refused for every stage in step 2)** is logged once per boot as
  `routing.<stage>: …` and that stage uses the legacy `runner`/`runnerOptions`; the engine
  still boots. Codex is accepted (inert) inside `escalate`/`secondOpinion`; the legacy
  `runner: 'codex'` is unchanged. A route's missing model inherits `runnerOptions.model` only
  from the same family. One runner instance per kind; model and effort travel per run. Claude
  gets `--effort`, Codex `-c model_reasoning_effort="…"`, and every Claude spawn drops
  `CLAUDE_CODE_EFFORT_LEVEL`.
- **Run records (R116/R118f).** `<session>/runs.jsonl`, one line per run that reached
  `run.started`: stage, runner, model, effort, route source, fresh/resumed, times, raw tokens
  (`tokensSource` `result`, or `assistant` per-message usage when the run never reached its
  result), `costUsd` and per-model `modelUsage` from Claude's result (latest result wins; null
  for Codex), limit events, outcome, `stopReason`, error and `interrupted`. A run that hit a
  `rejected` rate limit is recorded `stopped` / `stopReason: 'limit'` (its `lastRun` still says
  `failed` until step 7). A run the engine died under is recorded `interrupted` when it is
  healed, from the `.run-facts.json` the stage runner wrote at `run.started`. A record that
  cannot be written is a log line, never a failed run.
  - **These files are telemetry, not evidence:** they live in the session dir, which the agent
    can write (`--add-dir`, `stage-runner.ts:279`). Nothing may gate on them unverified.
- **Feedback capture (§20).** `<stateDir>/feedback.jsonl` (`feedbackPath`, 0600) records
  `finding_dismissed` (a REVIEW.md finding whose Status says dismissed; id = session + anchor +
  a hash of title and location, so a fresh review restarting at `f1` cannot hide a different
  finding), `verdict_rejected` (approving a PR whose review said 🔄 Request changes; abandoning
  an investigation at `plan_ready`) and `review_dismissed` (dismissing a review that has a
  REVIEW.md). Only the `/transition` and `/approve-pr` routes mark transitions `by: 'human'`;
  reconciliation never does. Text is one line, redacted, ≤ 300 chars.
  - **What fires today:** the extension calls `/approve-pr` and `/conversation/release`; dismissals
    are also captured before a review run rewrites REVIEW.md and before a re-review archives it.
    `review_dismissed` and the plan-abandon `verdict_rejected` fire only from raw API calls:
    the extension never calls `/transition`.
- **JSONL files** are rewritten tmp-then-rename with the engine as the only writer; readers skip
  torn and foreign lines. A future writer outside the engine (step 11's UI) must go through the
  engine API.
- **Not in this step:** no UI or API exposure of runs, feedback or round archives; no executed
  escalation, advisor or second opinion; QA verdicts and sign-offs are not captured. Decisions
  D1-D3 (codex not primary, cost recorded, bad routing falls back) were relayed for the user's
  confirmation on 2026-10-08.
```

- [ ] **Step 2: Full gates.** In `cgremlin/core`: `pnpm test && pnpm typecheck && pnpm lint`. In `cgremlin/vscode`: `pnpm test && pnpm typecheck && pnpm lint`. All PASS; paste the summary lines in the task report.

- [ ] **Step 3: Prove the frozen and untouched paths.**

```bash
git diff --stat mission-control-pr-orchestrator -- bin/ plugin/skills/ cgremlin/core/src/pipeline/preflight.ts cgremlin/core/test/pipeline/preflight.test.ts cgremlin/core/test/pipeline/pipeline-service.preflight.test.ts
```

Expected: empty output (no bash↔heredoc change, no skill change → no evals, 0c intact).

- [ ] **Step 4: Commit.**

```bash
git add cgremlin/core/docs/DECISIONS.md
git commit -m "docs(cgremlin-core): decisions for step 2" -m "Co-Authored-By: <model actually used> <noreply@anthropic.com>"
```

---

## After the tasks (not implementer work — run by the main session / chore agents)

1. **Fresh-context whole-branch review** of `mission-control-pr-orchestrator..step/2` (CLAUDE.md Review pipeline: `reader`s gather the diff → `reviewer` against this plan's Review Focus and the program's five items → one `verifier` per finding). Fix every CONFIRMED finding test-first, re-run the Task 7 gates, commit. List UNVERIFIABLE findings for the user.
2. **Confirm the installed build, then tag the baseline.** The baseline is the commit of the extension installed right now. Verified by the planner on 2026-10-08: the installed `engine/engine.js` and `engine/bridge.js` hash to the `cgremlin-1` build (`4461b1f7f4646d8a…` / `274de4c2da009dce…`), not the `cgremlin-1b` build (`d0b077ed…`, saved but not installed). Re-check at release time:

```bash
E=~/.vscode/extensions/cgremlin.cgremlin-vscode-0.0.1
S=$SCRATCH/pre2-check && mkdir -p "$S"   # $SCRATCH = the session scratchpad
unzip -o -q ~/cgremlin-releases/cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix 'extension/engine/*' -d "$S/v1"
shasum -a 256 "$E/engine/engine.js" "$S/v1/extension/engine/engine.js" "$E/engine/bridge.js" "$S/v1/extension/engine/bridge.js"
git rev-list -n1 cgremlin-1    # expect b1a096bfbd6e3dfe556a59413b608478b5bd369c
```

   If the installed hashes equal the `cgremlin-1` vsix's: `git tag -a cgremlin-pre-2 b1a096b -m "installed before step 2 (the cgremlin-1 build)"`. If they differ, stop and ask the user which build is installed. Show the user the commit and the hashes.
3. **Clear the untracked plan copy, then merge.** The main checkout may still hold an untracked copy of this plan at the path `step/2` commits it to, which would block the merge. `cd /Users/guilherme.azoubel/context-gremlin && git show step/2:docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md | diff - docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md`; if the untracked copy is older (this revision changed the committed one), move it to the scratchpad after confirming the committed copy is the newer one; if it has edits the committed copy lacks, stop and ask. Then from `/Users/guilherme.azoubel/context-gremlin` on `mission-control-pr-orchestrator`: `git merge --no-ff step/2 -m "Merge step/2: foundations — fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl (cgremlin-2)"` and `git tag -a cgremlin-2 HEAD -m "step 2: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl"`. Re-run the core and vscode gates on the merge commit.
4. **Build and save.** `cd cgremlin/vscode && pnpm build && pnpm package`, then `cp cgremlin-vscode-0.0.1.vsix ~/cgremlin-releases/cgremlin-vscode-0.0.1-2-built-<YYYY-MM-DD>.vsix` (check the version in `package.json`).
5. **GATE — ask the user before installing.** Step 2 changes engine runtime code, so the build should be installed, but only on the user's yes: `code --install-extension ~/cgremlin-releases/cgremlin-vscode-0.0.1-2-built-<date>.vsix --force`, then **Developer: Reload Window** → **cgremlin: Restart the engine**. Smoke check (no `core.json` read): the panel lists the existing sessions, and `~/.cgremlin-core/engine.log` since the restart shows no config error and no `routing.` line (the user's `core.json` has no `routing` key) — or, if it does show one, report it to the user verbatim.
6. **Records.** `RELEASES.md`: a `cgremlin-pre-2` baseline row (`b1a096b`, `cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix`, "Baseline: the build that was installed before 2 (identical to `cgremlin-1`)") and a `cgremlin-2` row (merge commit, the saved build and whether it was installed, "**2:** fresh runs (`StageRunInput.fresh`, BRIEF/FEEDBACK round archive); development sessions record their own draft PR (`pr_opened`, also picked up on the tick after a restart) and follow it to merged/closed; `routing.<stage>` per-stage model/effort (Claude `--effort`, Codex `model_reasoning_effort`, `CLAUDE_CODE_EFFORT_LEVEL` dropped; codex not allowed as a primary runner; a bad entry is logged and falls back); `runs.jsonl` per session with tokens, cost, per-model usage and limit events; `~/.cgremlin-core/feedback.jsonl` for dismissed findings and rejected verdicts. No UI change. Existing `core.json` files load unchanged.", roll back to `cgremlin-pre-2`). Refresh `~/cgremlin-releases/README.md` with the same rows. Program tracker (`docs/superpowers/plans/2026-10-05-cgremlin-program.md`): row 2 → `✅ done <date>`, plan = this file, tag `cgremlin-2`; row 3 → `ready` (its only dependency is 2); tick step 2's Done-when boxes; add a Log row (what shipped, the review result, D1-D3 confirmation status, and the `superseded` open question if still open). Commit `docs(cgremlin): release 2 in RELEASES.md; tracker marks 2 done`.
7. **GATE — ask the user, then push** exactly: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-2 refs/tags/cgremlin-2` (the user gets the permission prompt). Note the push in the Log row.
8. **Cleanup** after the user confirms: `git worktree remove .claude/worktrees/2 && git branch -d step/2`, then `/exit`.

## Self-review

- **Spec coverage.** R90 fresh + per-round BRIEF/FEEDBACK archive → Task 1. R91 PR_URL or `gh pr list --head` → `session.pr` / `pr_opened`, development in merged/closed reconciliation, `runDevelop` from `pr_opened` → Task 5 (plus the tick leg, I1). R116 `routing.<stage> {runner, model, effort, escalate, secondOpinion}`, Claude `--model`+`--effort`, `CLAUDE_CODE_EFFORT_LEVEL` unset, Codex `-m` + `-c model_reasoning_effort`, Codex report-only (refused as primary, D1) → Tasks 2-3. R116/R118f per-run `{stage, runner, model, effort, tokens, limitEvents, outcome}` plus cost and per-model usage (D2) and interrupted runs (I2) → Tasks 4a-4b. §18 A6 / §20 "findings I dismiss" and "sign-offs I contradict" (today: verdicts) → Tasks 6a-6b; "fixes I revert", the no-progress guard and dictated notes have no engine signal yet (later steps). §17's table values are defaults for the user's `core.json`, not code; step 12 tunes them.
- **Revision 2 coverage.** D1 → S2-21, Task 2; D2 → S2-22, Tasks 4a-4b; D3 → S2-23, Tasks 2-3; I1 → S2-24, Task 5; I2 → S2-25/26, Tasks 4a-4b; I3 → S2-22; I4 → S2-27, Task 6a; I5 → S2-28, Task 7; I6 → Tasks 4a/4b and 6a/6b; M1 → S2-29, every commit; M3 → S2-30, Task 2; M4 → S2-31, Task 5; M5 → S2-32, Task 7; M6 → S2-33, Tasks 3, 5, 6b; M7 → S2-34, Task 7; M8 → S2-35, Task 4b.
- **Placeholder scan.** Every code step carries the code. Conditional instructions are limited to Task 4b's TypeScript narrowing fallback, Task 4b/5's "adjust a pre-existing test that counts session-dir files or tick gh calls", and the release's verification gates, each with the exact action. The `<model actually used>` in commit commands is the deliberate trailer template (S2-29); each task's "Tier / trailer" line names the model.
- **Type consistency.** `RunnerKind`, `Effort`, `RUNNER_KINDS`, `EFFORT_LEVELS`, `ResolvedRoute{stage, runner, model, effort, source}`, `parseRouting` (Task 2) are used unchanged in Tasks 3, 4b, 6a. `RunStats{tokens, tokensSource, costUsd, modelUsage, limitEvents, observedModel}` and `ModelUsage` (Task 4a) match the fake runner and `RunRecordSchema` (Task 4b). `RunRecord` fields (Task 4b) match `producedByFrom`'s test fixture (Task 6a). `detectDevelopmentPr({…, me})`, public `adoptDevelopmentPr(id)` (Task 5) match the tick leg. `PipelineService.log` is introduced in Task 4b and used in Tasks 5 and 6b. `transition(id, to, { by: 'human' })` matches the routes and `feedback-routes.test.ts`.
- **Review Focus.** Items 1-18 each name their pinning test and its task (Tasks 1, 2, 3, 4a, 4b, 5, 6a, 6b).
- **Task 1 unchanged.** Only its two trailer lines changed in revision 2; its "Task 4" interface reference means Task 4b.
- **bash↔Python heredoc.** No task touches `bin/cgremlin`; Task 7 Step 3 proves it.

## Open questions for the user

1. **D1-D3 confirmation.** They are written in as S2-21 to S2-23, pending your confirmation in this terminal.
2. **`superseded` now reachable.** Creating a review session for your own dev PR moves the dev session `pr_opened → superseded` (`link-pr-to-source.ts:55`, `review-session-factory.ts:118-122`), and `runDevelop` does not run from `superseded` (S2-15, per the card). Keep that, or allow it?
3. **Limit-stopped runs in `lastRun`.** S2-35 marks them `stopped` only in `runs.jsonl`; `lastRun` (what the panel shows) stays `failed` until step 7. Say if you want `lastRun` changed in step 2 too.
