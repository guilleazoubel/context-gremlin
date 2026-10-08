# cgremlin step 2 — Foundations: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can start a stage run fresh (no `--resume`) with the previous round's `BRIEF.md`/`FEEDBACK.md` archived; it records a development session's draft PR (`session.pr`, `active → pr_opened`) and follows it to merged/closed; it routes each stage to a runner/model/effort from `routing.<stage>`; it writes one record per run; and it captures dismissed findings and rejected verdicts to `~/.cgremlin-core/feedback.jsonl`.

**Architecture:** All of it lives in the TypeScript engine (`cgremlin/core`); the VS Code extension only rebuilds to carry it, and no UI is added. `StageRunner` (`src/pipeline/stage-runner.ts`) is the single place every agent run passes through, so it gains: `fresh`/`feedback` inputs and the round archive (Task 1), a per-stage route that picks one of several runners and passes model/effort through `SessionContext` (Tasks 2–3), and a `runs.jsonl` record per run built from new `AgentRunner.getRunStats()` (Task 4). PR tracking is a read-only detection step after every develop run plus a development leg in `ReconciliationTick` (Task 5). Feedback capture is a small `src/feedback/` module fed from four engine hooks; only API routes a person calls are marked `by: 'human'` (Task 6).

**Tech Stack:** TypeScript (Node 24, ES2022/CommonJS), zod 3.25, vitest 2, eslint, pnpm (`cgremlin/core`, `cgremlin/vscode`); Claude Code CLI 2.1.294 (`--effort low|medium|high|xhigh|max`; stream-json `rate_limit_event` and `result.usage`); Codex CLI 0.154 (`-m`, `-c model_reasoning_effort="…"`, `turn.completed.usage`); `gh` (read-only `pr view` / `pr list`).

**Spec:** `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md` — R90 (L60), R91 (L61), R116 (L71), R118(f), §17 (L288-305), §18 A6 (L322), §20 (L409-423). Program card: `docs/superpowers/plans/2026-10-05-cgremlin-program.md` step 2 (lines 149-156), Global Constraints (31-41), Review Focus (43-48).

## Global Constraints

Copied from the program (lines 31-41); the trailer names the model this plan's executors run on.

- **Scope:** change only cgremlin (`~/context-gremlin`) and my personal `~/.claude`. **Never** change team repos (grace, grace-frontend, web-fastcar).
- **Protected actions** need my explicit approval: opening a PR for review, merging, approving, and posting review findings on others' PRs (R112). Commit, push to own branches and draft PRs are fine.
- **TDD** for behaviour; `pnpm test`, `pnpm typecheck` and `pnpm lint` pass in `cgremlin/core` and `cgremlin/vscode` before any release.
- **Isolation:** each step works in a worktree under `.claude/worktrees/<step-id>` on a branch named **`step/<step-id>`**, never `cgremlin-<id>`, which is reserved for release tags (a same-named branch and tag make `git push` fail with "matches more than one"). Branch from `mission-control-pr-orchestrator` (`main` is stale, 631 commits behind). **Commit frequently.** Push with explicit refs: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-<id> refs/tags/cgremlin-<id>`. **The release ends with cleanup**: remove the worktree, delete the merged `step/<id>` branch, update the tracker, then `/exit`. Every step starts in a new session; no `/clear` needed.
- **Release:** the `RELEASES.md` checklist: tag `cgremlin-pre-<id>` + `cgremlin-<id>`, save the `.vsix` to `~/cgremlin-releases/`, add a table row, push branch + tags.
- **Delegate** substantive work to subagents pinned per §17; trivial edits inline (R118). Optimize for **rate limits** (subscription).
- `bin/cgremlin` (legacy) is **frozen** (A5).
- **Every step that adds or changes a skill** ships ≥3 eval scenarios against today's brief as the baseline (A7, `claude plugin eval`); it replaces the brief only if it wins.
- **Never read** `~/.cgremlin/config` or `~/.cgremlin-core*/core.json` into a transcript; they contain secrets.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or the model actually used).

**Step 2 specifics (every task's requirements include these):**
- Worktree `.claude/worktrees/2`, branch `step/2`, from `mission-control-pr-orchestrator`. All paths below are relative to the worktree root; run `pnpm` from `cgremlin/core` unless a step says otherwise.
- `bin/cgremlin` is not touched and **no task touches the bash↔Python-heredoc sync**. Task 7 proves it with an empty `git diff --stat mission-control-pr-orchestrator -- bin/`.
- Step 2 changes **no skill** (nothing under `plugin/skills/`), so the A7 eval rule does not trigger.
- `src/pipeline/pipeline-service.ts` lines 1-14 stay byte-identical (pinned by `pipeline-service.human-turn.test.ts` and `pipeline-service.environment.test.ts`), and `runStageLocked` keeps its `    brief: string | null,` line.
- 0c's preflight (`src/pipeline/preflight.ts` and its two tests) is not touched.
- Every `gh` call this step adds is read-only: `gh pr view` or `gh pr list`. Nothing in this step opens, edits, readies, merges, comments on or approves a PR.
- Tests use `InMemoryFileSystem` or `tmpdir()` paths. No test or command reads a real `core.json`.

## Review Focus

The program's five cross-cutting items, as they apply to this step, then the step's own failure modes. Each line names the test that pins it and the task that owns it.

1. **Posting without approval (program 1).** PR detection runs after every develop run, headless. Expected: it only ever calls `gh pr view` / `gh pr list`; it can never open, ready, edit or post. Pinned: Task 5 `pr-detection.test.ts` "only ever reads: every gh call is pr view or pr list" (and `FakeGhRunner` throws on any mutating token).
2. **Untrusted text displacing instructions (program 2).** `PR_URL` and REVIEW.md titles are agent-written text the engine now reads. Expected: `PR_URL` is a hint parsed by `parsePrUrl` and verified against this repo, this branch and `OPEN`, never trusted alone; feedback text is redacted (`redactSecrets`) and capped at 300 chars. Pinned: Task 5 "a PR_URL naming another repo is never even looked up" / "a stale PR_URL (another branch) is ignored"; Task 6 `feedback-capture.test.ts` "feedback text is one line, redacted and capped".
3. **Interrupted runs (program 3).** A develop run that dies or is stopped after opening its PR; a run that hits a usage limit; a fresh round after a stopped round. Expected: the PR is still recorded (a fact), the run record says `failed`/`stopped` with its limit events, and the next fresh round never reads the stopped round's `FEEDBACK.md`. Pinned: Task 5 "a failed develop run that already opened its PR still records it"; Task 4 "a failed and then a stopped run each append their own record" and "a runner that throws at start still leaves a failed record"; Task 1 "a fresh run with no feedback of its own still moves the stale FEEDBACK.md out of the agent's way".
4. **Shared local resources (program 4).** `feedback.jsonl` is one file for every session; `runs.jsonl` and the round archive share a session dir. Expected: concurrent appends never lose or tear a record; a torn line left by a crash never swallows the next record. Pinned: Task 6 "25 concurrent appends of distinct ids keep all 25"; Task 4 `jsonl.test.ts` "never glues a record onto a torn last line".
5. **Claims of verification (program 5).** `PR_URL` is the agent's claim that it opened a PR. Expected: adopted only after `gh` confirms it is OPEN in this repo with this session's branch as head; a closed or foreign PR is ignored. Pinned: Task 5 "a PR_URL whose PR is closed is not adopted".
6. **A fresh run must not resume.** Expected: `fresh: true` passes no resume id to the runner, whatever `session.agent.resumeId` holds; a non-fresh run still resumes. Pinned: Task 1 "a fresh run never passes the session's resume id" and "a non-fresh run still resumes".
7. **Routing absent → today's behaviour.** A `core.json` with no `routing` key (every existing install). Expected: every stage runs on `runner` with `runnerOptions.model`, no `--effort`, exactly as before. Pinned: Task 2 "absent: every stage keeps the engine-wide runner"; Task 3 "with no routeFor every stage runs on the engine-wide runner with no model or effort"; Task 3 `real-adapters.test.ts`.
8. **Inherited effort env.** VS Code launched from a shell exporting `CLAUDE_CODE_EFFORT_LEVEL`. Expected: the variable never reaches a spawned `claude`; the engine's own env is unchanged. Pinned: Task 2 "an inherited CLAUDE_CODE_EFFORT_LEVEL never reaches the CLI".
9. **`gh` missing or unauthenticated during detection.** Expected: the develop run's result is unaffected, the session stays `active` with `pr: null`, and one log line says why. Pinned: Task 5 `pr-detection.test.ts` "gh missing or unauthenticated is a reason, never a throw" and `pipeline-service.development.test.ts` "gh missing: stays active".
10. **Stop and liveness on a routed run.** A stage routed to codex while the engine-wide runner is claude. Expected: `stop()` and the pid probe go to the runner that started the run. Pinned: Task 3 "stop() stops the runner the stage was routed to" and "liveness asks the routed runner for the pid".
11. **`feedback.jsonl` integrity.** Corrupt line, the same dismissal seen twice, a read of `core.json`. Expected: corrupt lines skipped, each signal recorded once, and the log reads only its own file. Pinned: Task 6 `feedback-log.test.ts` "a torn line…", "10 concurrent appends of the same id write it once", "reads and writes only its own file".
12. **Machine transitions are not human feedback.** The reconciliation tick dismisses a review when its PR merges. Expected: no feedback record; only API routes a person calls (`/transition`, `/approve-pr`) pass `by: 'human'`. Pinned: Task 6 "a reconciliation dismissal records nothing" and the server.ts source pin.
13. **Run-record write failure.** Disk full or an unwritable session dir. Expected: a log line; the run's outcome and `lastRun` are exactly what they would have been. Pinned: Task 4 "a record that cannot be written is a log line, never a failed run".

## Rulings

Judgment calls resolved here so the executors need none. Format: **what** — why — cost if wrong.

- **S2-1 `fresh` is opt-in and has no production caller yet.** `StageRunInput.fresh?: boolean` defaults to `false`; no existing stage passes `true` in step 2, and `runStageLocked` is not changed. — R90 ties fresh runs to phase rounds, which do not exist until step 5; changing review/respond resume behaviour now is outside the card. — If wrong, step 5 adds the callers it needs anyway; nothing to undo.
- **S2-2 The round archive happens only on fresh runs.** One round number `N = max(next BRIEF-vN, next FEEDBACK-vN)` for both files. `BRIEF.md` is **copied** to `BRIEF-vN.md` (the new brief overwrites it, or a run with no brief keeps reading it); `FEEDBACK.md` is **moved** to `FEEDBACK-vN.md` and always removed, even when empty. `StageRunInput.feedback?: string | null` is written to `FEEDBACK.md` by the stage runner (the single writer of both hand-off files). — Mirrors the `REVIEW-vN`/`QA-vN` precedent (`artifacts.ts:nextVersion`); a fresh agent must never read last round's feedback. — If wrong, the archive files are inert extra files; no reader depends on them yet.
- **S2-3 A fresh run that reports no conversation id keeps the previous same-runner id** in `session.agent.resumeId`. — Take over (R90: "only Take over and the lead chat resume") must still find the last conversation. — If wrong, Take over resumes an older conversation instead of none.
- **S2-4 `routing` keys are `StageName`s only, and route objects are strict.** An unknown stage, a misspelt key, an unknown runner or effort is a `ConfigError` at load. — A typo silently routing to defaults is the failure mode worth preventing; later steps extend `STAGE_NAMES` when they add stages. — If wrong, a user with a typo gets a load error instead of a silent default (visible, fixable).
- **S2-5 Model fallback crosses no runner family.** A route with no `model` inherits `runnerOptions.model` only when `route.runner === runner`; otherwise `null` (the CLI's default). Effort has no legacy fallback (`null` → no flag). — `runnerOptions.model` names a model of the legacy runner's family; `opus` passed to `codex -m` would fail. — If wrong, a codex route without a model runs on Codex's default model.
- **S2-6 Codex limits in config.** `runner: 'codex'` with `effort: 'max'` is refused (Codex has no `max`; use `xhigh`), and `routing.develop.runner = 'codex'` is refused (R116: Codex is report-only in v1). The legacy engine-wide `runner: 'codex'` keeps working exactly as today, and step 2 does not otherwise enforce a read-only sandbox. — Cheapest correct enforcement of R116 without changing legacy installs. — If wrong, a user who wants codex development uses the legacy `runner` key.
- **S2-7 `escalate` and `secondOpinion` are parsed and validated only.** Nothing executes them in step 2 (fix rounds are step 5; second opinions steps 10/12). — YAGNI; the card asks for the config shape. — None.
- **S2-8 `CLAUDE_CODE_EFFORT_LEVEL` is removed on every Claude spawn**, routed or not, without touching `process.env`. — R116 says the orchestrator unsets it; an env value inherited from the shell that launched VS Code would silently override routing. — If wrong, a user who set the variable for engine runs must use `routing.<stage>.effort` instead.
- **S2-9 One runner instance per kind; model and effort travel per run** on `SessionContext` (`model?`, `effort?`), overriding the constructor default. `realAdapters` builds both kinds; `EngineAdapters.runners` is optional so every existing test wiring keeps working. A route naming a kind with no runner fails that stage with `RunnerUnavailableError` before any agent starts. — Keeps the `AgentRunner` interface additive. — None expected.
- **S2-10 Run records are per session**: `<sessionsDir>/<id>/runs.jsonl`, one line per run that reached `run.started` (pre-start failures write none). `outcome` is the **process** outcome (`succeeded|failed|stopped`), not the artifact evaluation (`patchLastRun` may later downgrade `lastRun`). `model` = `route.model ?? the model the CLI reported ?? null`. Tokens are raw per-vendor counts (Claude `input` excludes cache; Codex `input` includes cached). No cost field (subscriptions; card omits it). — Keeps a phase's runs with its session for step 7's budgets and step 12's tuning; the record carries `sessionId`/`startedAt` so a later join with `lastRun` is possible. — If wrong, step 12 aggregates across session dirs (one `readdir`).
- **S2-11 Limit events.** Claude: every `rate_limit_event` whose `status` is `allowed_warning` (→ `warning`) or `rejected` (→ `rejected`); plus, only if no `rejected` was seen, an error `result` whose text matches `/usage limit|rate limit|hit your limit|too many requests|\b429\b/i`. Codex: `error`/`turn.failed` messages matching the same pattern, de-duplicated by message. — The shapes are what CLI 2.1.294 and codex 0.154 emit (`rate_limit_event` schema read from the installed binary). — If a CLI changes wording, events are missed (records still written); step 7 revisits with live data.
- **S2-12 JSONL writes rewrite the file tmp-then-rename (0600)**; the engine is the only writer; `FeedbackLog` serializes its appends with its own in-process lock; readers skip blank, torn and schema-foreign lines; a torn last line gets a newline before the next record. No `SessionFileSystem.appendFile` is added. — Atomic against crashes, needs no interface change (four test doubles implement `SessionFileSystem` inline). O(n) per append is fine at these sizes. — If a second writer process appears (step 11's UI), it must write through the engine API; recorded in DECISIONS.
- **S2-13 PR detection runs after every develop run that reached the agent, whatever its outcome**, only for a `development` session at `active` with `pr: null` and a branch. It adopts only an `OPEN` PR whose head is this session's branch in this repo: first the `PR_URL` hint (`gh pr view`), else `gh pr list --repo <slug> --head <branch> --state open --limit 5` with exactly one head match. Adoption is one locked save (`pr` + `active → pr_opened`, one `session.transitioned`). Detection never throws; a miss is a log line. `PipelineServiceDeps.gh` is optional (absent → no detection); `buildEngine` wires it. — R91; a PR the agent opened before dying is still a PR. — If wrong, at most two read-only `gh` calls per develop run.
- **S2-14 A non-draft PR is adopted and flagged**: `lastRun.error` gets "PR #N is open for review, not a draft — opening a PR for review needs your approval (R112)" (appended after any existing error). — It is a fact; hiding it would strand the session; the flag surfaces the protected action that happened. — None.
- **S2-15 `runDevelop` is runnable from `active` and `pr_opened`**, not `superseded`. — The card says `pr_opened`. Note: `linkPrToSource` moves a `pr_opened` dev session to `superseded` when a review of its PR is created; that path is now reachable (Open question for the user). — A user who self-reviews their dev PR cannot run develop fix rounds from cgremlin afterwards (Take over still works).
- **S2-16 Development sessions join PR-bearing reconciliation**: their own PR `MERGED → merged`, `CLOSED → abandoned` (the rule `planReconciliation` already applies to a review's development source, `reconciliation.ts:144-166`); no deliberate-start exception (a dev session only adopts open PRs). — R91. — If wrong, closing a draft to recreate it abandons the session (same as today via the review lineage path).
- **S2-17 "Dismissal" = a REVIEW.md finding whose Status says `dismissed`** (detail block or table row). Captured at: `releaseConversation`, just before `runReview` starts, just before `runRereview` archives REVIEW.md, and on any human transition of a review session. Each finding is recorded once per session (`id = finding_dismissed:<session>:<anchor>`; anchors are stable across re-reviews per the REVIEW.md contract). — Those are the points where the engine sees REVIEW.md change hands; the engine has no dismiss-finding API. — A dismissal made by hand and never followed by one of those events is captured late (next event), never lost.
- **S2-18 "Rejected verdict" = a human API action against an engine verdict**: approving a PR (`/approve-pr`, or `/transition` to `approved`) whose REVIEW.md verdict is `🔄 Request changes` → `verdict_rejected`; a human `/transition` of a review to `dismissed` while REVIEW.md exists → `review_dismissed`; a human `/transition` of an investigation from `plan_ready` to `abandoned` while PLAN.md exists → `verdict_rejected` (the PM + Principal Engineer approved plan was not taken). Only routes pass `{ by: 'human' }`; the reconciliation tick never does. QA verdicts and sign-offs are not covered (no human action contradicts them yet; sign-offs are step 6). — The engine API is the only place a human action is observable today. — If the user considers `review_dismissed` noise, step 11 filters by `kind`.
- **S2-19 `feedback.jsonl` lives at `<stateDir>/feedback.jsonl`** via a new derived `feedbackPath` (like `dismissalsPath`), 0600. Record: `{v, id, at, source:'auto', kind, text, context{sessionId, mode, stage, ticket, pr, artifact, anchor}, producedBy{stage, runner, model, effort}|null, detail}`; `producedBy` is the newest matching record in the session's `runs.jsonl`. `source: 'user'` is reserved for step 11's 💡 button. Capture never throws and never blocks the action it observes. — §20 record shape. — None.
- **S2-20 Nothing new is exposed over the API or in the UI**: `runs.jsonl`, `feedback.jsonl` and `*-vN.md` round archives are not added to the artifact allow-list (`api/validation.ts:109`), and `POST /sessions/:id/run` gains no `fresh` field. — Card: "no UI yet". — None.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `cgremlin/core/src/pipeline/round-archive.ts` (new) | 1 | `archiveRound(fs, sessionDir)`: R90 per-round archive |
| `cgremlin/core/src/pipeline/stage-runner.ts` | 1, 3, 4 | `fresh`/`feedback` inputs; route → runner/model/effort; per-run record |
| `cgremlin/core/src/config/routing.ts` (new) | 2 | `RUNNER_KINDS`, `EFFORT_LEVELS`, route schemas, `resolveStageRoute` |
| `cgremlin/core/src/config/core-config.ts` | 2, 6 | `routing` key; derived `feedbackPath` |
| `cgremlin/core/src/agent/agent-runner.ts` | 2, 4 | `SessionContext.model/effort`; `TokenUsage`, `LimitEvent`, `RunStats`, `getRunStats?` |
| `cgremlin/core/src/agent/claude-code-runner.ts` | 2, 4 | `--model`/`--effort` per run; `claudeEnv`; usage/limit/model capture |
| `cgremlin/core/src/agent/codex-runner.ts` | 2, 4 | `-m`/`-c model_reasoning_effort` per run; usage/limit capture |
| `cgremlin/core/src/agent/run-stats.ts` (new) | 4 | pure parsers for usage and limit events |
| `cgremlin/core/src/fs/jsonl.ts` (new) | 4 | `appendJsonLine`, `readJsonLines` |
| `cgremlin/core/src/pipeline/run-records.ts` (new) | 4 | `RunRecordSchema`, `appendRunRecord`, `readRunRecords` |
| `cgremlin/core/src/host/build-engine.ts` | 3, 5, 6 | wire `runners`/`routeFor`, `gh`, `feedback` |
| `cgremlin/core/src/host/serve.ts` | 3 | `realAdapters` builds one runner per kind |
| `cgremlin/core/src/pipeline/pr-detection.ts` (new) | 5 | `detectDevelopmentPr` (read-only gh) |
| `cgremlin/core/src/pipeline/pipeline-service.ts` | 5, 6 | adopt PR after develop; `runDevelop` from `pr_opened`; feedback hooks; `transition(…, {by})` |
| `cgremlin/core/src/discovery/reconciliation.ts` | 5 | development leg |
| `cgremlin/core/src/feedback/review-findings.ts` (new) | 6 | REVIEW.md findings + verdict parser |
| `cgremlin/core/src/feedback/feedback-log.ts` (new) | 6 | `FeedbackRecordSchema`, `FeedbackLog` |
| `cgremlin/core/src/feedback/feedback-capture.ts` (new) | 6 | signal → record rules |
| `cgremlin/core/src/api/server.ts` | 6 | `/transition` and `/approve-pr` pass `{ by: 'human' }` |
| `cgremlin/core/test/support/{fake-agent-runner,pipeline-harness}.ts`, `test/fixtures/fake-{claude,codex}-cli.js` | 2, 4, 5, 6 | test seams |
| `cgremlin/core/README.md`, `cgremlin/core/docs/DECISIONS.md` | 2, 7 | config docs; decisions |

Task order and agent tier (CLAUDE.md escalation rule; none touches `bin/cgremlin` or the bash↔heredoc sync):

| Task | Deliverable | Tier | Why |
|---|---|---|---|
| 1 | fresh runs + round archive | `executor` | one module + one new helper, fully specified |
| 2 | routing config + runner flags | `executor` | additive schema and argv changes, fully specified |
| 3 | stage runner routes each stage; engine wiring | `executor-heavy` | run-liveness / stop invariants across several runners in the engine's central file |
| 4 | per-run records | `executor-heavy` | >5 interdependent files (runner interface, two runners, JSONL, stage-runner catch path) |
| 5 | PR detection + reconciliation | `executor-heavy` | the session-lock invariant (`pipeline-service.ts:1-14`) and the tick's plan/apply split |
| 6 | feedback.jsonl capture | `executor-heavy` | >5 interdependent files across pipeline, API, config and a new module |
| 7 | docs, DECISIONS, full gates | `executor` | docs + commands |

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
git commit -m "docs(cgremlin): step 2 plan" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
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
git commit -m "feat(cgremlin-core): StageRunInput.fresh (no --resume) and the per-round BRIEF/FEEDBACK archive (R90)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `routing.<stage>` config and per-run model/effort flags (R116)

**Files:**
- Create: `cgremlin/core/src/config/routing.ts`
- Modify: `cgremlin/core/src/config/core-config.ts:134-146` (add `routing` after `runnerOptions`)
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
  - `export const RouteTargetSchema`, `export const StageRouteSchema`, `export const RoutingSchema`; `export type StageRoute = z.infer<typeof StageRouteSchema>`
  - `export interface ResolvedRoute { stage: StageName; runner: RunnerKind; model: string | null; effort: Effort | null; source: 'routing' | 'legacy' }`
  - `export function resolveStageRoute(cfg: RoutingConfigView, stage: StageName): ResolvedRoute`
  - `CoreConfig.routing: Partial<Record<StageName, StageRoute>>` (default `{}`)
  - `SessionContext.model?: string`, `SessionContext.effort?: Effort`
  - `export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` (claude-code-runner.ts)

- [ ] **Step 1: Write the failing config tests.** Create `cgremlin/core/test/config/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadCoreConfig, resolveCoreConfig } from '../../src/config/core-config';
import { resolveStageRoute } from '../../src/config/routing';
import { STAGE_NAMES } from '../../src/schema/stage';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const HOME = '/Users/e2e';
const base = { repos: ['acme/app'], me: 'me' };

describe('routing.<stage> (R116)', () => {
  it('absent: every stage keeps the engine-wide runner and runnerOptions.model, with no effort (legacy)', () => {
    const cfg = resolveCoreConfig({ ...base, runnerOptions: { model: 'opus' } }, HOME);
    expect(cfg.routing).toEqual({});
    for (const stage of STAGE_NAMES) {
      expect(resolveStageRoute(cfg, stage)).toEqual({ stage, runner: 'claude-code', model: 'opus', effort: null, source: 'legacy' });
    }
  });

  it('absent with a legacy codex runner: codex, its model, no effort', () => {
    const cfg = resolveCoreConfig({ ...base, runner: 'codex', runnerOptions: { model: 'gpt-6.1-sol' } }, HOME);
    expect(resolveStageRoute(cfg, 'review')).toEqual({ stage: 'review', runner: 'codex', model: 'gpt-6.1-sol', effort: null, source: 'legacy' });
  });

  it('a routed stage takes runner, model and effort from routing; the others stay legacy', () => {
    const cfg = resolveCoreConfig({ ...base, routing: { review: { runner: 'claude-code', model: 'opus', effort: 'high' } } }, HOME);
    expect(resolveStageRoute(cfg, 'review')).toEqual({ stage: 'review', runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' });
    expect(resolveStageRoute(cfg, 'develop')).toEqual({ stage: 'develop', runner: 'claude-code', model: null, effort: null, source: 'legacy' });
  });

  it('a route with no model inherits runnerOptions.model only from the same runner family', () => {
    const cfg = resolveCoreConfig(
      { ...base, runnerOptions: { model: 'sonnet' }, routing: { plan: { runner: 'claude-code', effort: 'medium' }, verify: { runner: 'codex', effort: 'high' } } },
      HOME,
    );
    expect(resolveStageRoute(cfg, 'plan').model).toBe('sonnet');
    expect(resolveStageRoute(cfg, 'verify').model).toBeNull();
  });

  it('a hand-built config with no routing key at all resolves as legacy', () => {
    expect(resolveStageRoute({ runner: 'claude-code', runnerOptions: {} }, 'findings')).toEqual({
      stage: 'findings', runner: 'claude-code', model: null, effort: null, source: 'legacy',
    });
  });

  it('parses escalate and secondOpinion (consumed by later steps)', () => {
    const cfg = resolveCoreConfig(
      {
        ...base,
        routing: {
          review: {
            runner: 'claude-code', model: 'opus', effort: 'high',
            escalate: [{ runner: 'claude-code', model: 'opus', effort: 'xhigh' }],
            secondOpinion: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
          },
        },
      },
      HOME,
    );
    expect(cfg.routing.review?.escalate).toEqual([{ runner: 'claude-code', model: 'opus', effort: 'xhigh' }]);
    expect(cfg.routing.review?.secondOpinion).toEqual({ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it.each([
    ['an unknown stage', { implement: { runner: 'claude-code' } }],
    ['a misspelt key', { review: { runner: 'claude-code', efort: 'high' } }],
    ['an unknown effort', { review: { runner: 'claude-code', effort: 'ultra' } }],
    ['an unknown runner', { review: { runner: 'gemini' } }],
    ['codex at max effort', { review: { runner: 'codex', effort: 'max' } }],
    ['codex at max effort in an escalation', { review: { runner: 'claude-code', escalate: [{ runner: 'codex', effort: 'max' }] } }],
    ['codex at max effort as a second opinion', { review: { runner: 'claude-code', secondOpinion: { runner: 'codex', effort: 'max' } } }],
    ['codex as the develop runner (report-only in v1)', { develop: { runner: 'codex' } }],
  ])('refuses %s', (_label, routing) => {
    expect(() => resolveCoreConfig({ ...base, routing }, HOME)).toThrow();
  });

  it('loadCoreConfig reports a bad route as a ConfigError naming the problem', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/cfg', { recursive: true });
    await fs.writeFile('/cfg/test-config.json', JSON.stringify({ ...base, routing: { review: { runner: 'codex', effort: 'max' } } }));
    await expect(loadCoreConfig(fs, '/cfg/test-config.json', HOME)).rejects.toThrow(/max/);
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

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/config/routing.test.ts test/agent/claude-code-runner.test.ts test/agent/codex-runner.test.ts` → FAIL (`../../src/config/routing` not found; `claudeEnv` not exported; argv lacks `--effort`/`-c model_reasoning_effort`).

- [ ] **Step 5: Implement `routing.ts`.** Create `cgremlin/core/src/config/routing.ts`:

```ts
import { z } from 'zod';
import { STAGE_NAMES, type StageName } from '../schema/stage';

export const RUNNER_KINDS = ['claude-code', 'codex'] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

/** Claude Code `--effort` levels (CLI 2.1.294). `max` is never a default (R118e). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** One runner · model · effort choice. Strict: a misspelt key must fail at load, not route silently. */
export const RouteTargetSchema = z
  .object({
    runner: z.enum(RUNNER_KINDS),
    model: z.string().min(1).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
  })
  .strict();
export type RouteTarget = z.infer<typeof RouteTargetSchema>;

const CODEX_HAS_NO_MAX = "codex has no 'max' reasoning effort; use 'xhigh'";

/**
 * R116 / §17 — one stage's route. `escalate` (fix round 2, 3+ …) and `secondOpinion` (a
 * report-only second judge) are validated here and consumed by later steps; step 2 runs the
 * primary route only.
 */
export const StageRouteSchema = RouteTargetSchema.extend({
  escalate: z.array(RouteTargetSchema).optional(),
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

/** `routing.<stage>`. Keys are StageNames only; a stage with no entry keeps the legacy runner. */
export const RoutingSchema = z
  .record(z.enum(STAGE_NAMES), StageRouteSchema)
  .default({})
  .superRefine((routing, ctx) => {
    if (routing.develop?.runner === 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['develop', 'runner'],
        message: 'R116: codex is report-only in v1 and may not be the develop runner',
      });
    }
  });

export interface ResolvedRoute {
  stage: StageName;
  runner: RunnerKind;
  model: string | null;
  effort: Effort | null;
  /** 'routing' = `routing.<stage>` in core.json; 'legacy' = the engine-wide `runner`/`runnerOptions`. */
  source: 'routing' | 'legacy';
}

/** The slice of CoreConfig routing reads; `routing` optional so a hand-built config still resolves. */
export interface RoutingConfigView {
  runner: RunnerKind;
  runnerOptions: { model?: string };
  routing?: Partial<Record<StageName, StageRoute>>;
}

/**
 * R116 — the runner, model and effort for one stage. No entry → the engine-wide runner and
 * `runnerOptions.model`, no effort (exactly today). An entry with no model inherits
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

- [ ] **Step 6: Add `routing` to the config schema.** In `src/config/core-config.ts` add `import { RoutingSchema } from './routing';` and, in `CoreConfigSchema` directly after the `runnerOptions: z.object({…}).default({}),` entry, add:

```ts
  /** R116 — per-stage runner/model/effort (src/config/routing.ts). Empty: every stage uses `runner`/`runnerOptions`. */
  routing: RoutingSchema,
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
| `routing.<stage>` | — | R116 per-stage route for `findings`, `plan`, `develop`, `review`, `rereview`, `respond`, `verify`: `{ "runner": "claude-code" \| "codex", "model"?: string, "effort"?: "low" \| "medium" \| "high" \| "xhigh" \| "max", "escalate"?: [route…], "secondOpinion"?: route }`. A stage with no entry uses `runner`/`runnerOptions` exactly as before; a route with no `model` inherits `runnerOptions.model` only from the same runner. Codex has no `max` and may not be the `develop` runner (report-only in v1). `escalate`/`secondOpinion` are validated now and used by later steps. Claude runs never inherit `CLAUDE_CODE_EFFORT_LEVEL`. |
```

- [ ] **Step 11: Run.** `pnpm vitest run test/config test/agent` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 12: Commit.**

```bash
git add cgremlin/core/src/config cgremlin/core/src/agent cgremlin/core/test/config/routing.test.ts cgremlin/core/test/agent cgremlin/core/test/fixtures/fake-claude-cli.js cgremlin/core/README.md
git commit -m "feat(cgremlin-core): routing.<stage> config; runners take model/effort per run; claude never inherits CLAUDE_CODE_EFFORT_LEVEL (R116)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The stage runner routes each stage; the engine wires one runner per kind (R116)

**Files:**
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts` (`StageRunnerDeps` `:47-57`, `ActiveRun` `:91`, `isEntryAlive` `:176-181`, `stop` `:183-189`, `run` `:191-387`)
- Modify: `cgremlin/core/src/host/build-engine.ts:50-63` (`EngineAdapters`), `:249-258` (`new StageRunner`)
- Modify: `cgremlin/core/src/host/serve.ts:469-477` (`realAdapters`)
- Test: `cgremlin/core/test/pipeline/stage-runner.routing.test.ts` (new), `cgremlin/core/test/host/real-adapters.test.ts` (new)

**Interfaces:**
- Consumes: `ResolvedRoute`, `RunnerKind`, `resolveStageRoute` (Task 2); `SessionContext.model/effort` (Task 2); `carriedResumeId`/`seedResumeId` (Task 1).
- Produces:
  - `StageRunnerDeps.runners?: Partial<Record<RunnerKind, AgentRunner>>`, `StageRunnerDeps.routeFor?: (stage: StageName) => ResolvedRoute`; `runnerKind: RunnerKind` (same two values as before).
  - `export class RunnerUnavailableError extends Error` (name `'RunnerUnavailableError'`).
  - Inside `run()`: locals `route: ResolvedRoute` and `runner: AgentRunner` (Task 4 records them).
  - `EngineAdapters.runners?: Partial<Record<RunnerKind, AgentRunner>>`; `realAdapters(config)` returns `runners` with both kinds and `runner === runners[config.runner]`.

- [ ] **Step 1: Write the failing stage-runner tests.** Create `cgremlin/core/test/pipeline/stage-runner.routing.test.ts`:

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
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('buildEngine hands the stage runner every runner and the config’s routes', () => {
    const source = readFileSync(path.join(__dirname, '../../src/host/build-engine.ts'), 'utf8');
    expect(source).toContain('runners: adapters.runners,');
    expect(source).toContain('routeFor: (stage) => resolveStageRoute(config, stage),');
  });
});
```

- [ ] **Step 3: Run to verify failure.** `pnpm vitest run test/pipeline/stage-runner.routing.test.ts test/host/real-adapters.test.ts` → FAIL (`RunnerUnavailableError` not exported; codex never started; `adapters.runners` undefined; source pin missing).

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

- [ ] **Step 5: Wire the engine.** In `src/host/build-engine.ts`: add `import { resolveStageRoute, type RunnerKind } from '../config/routing';`; in `EngineAdapters` change `runnerKind: 'claude-code' | 'codex';` to `runnerKind: RunnerKind;` and add after `runner: AgentRunner;`:

```ts
  /** R116 — one runner per kind for routed stages; absent means every stage uses `runner`. */
  runners?: Partial<Record<RunnerKind, AgentRunner>>;
```

  In the `new StageRunner({ … })` call add, after `runnerKind: adapters.runnerKind,`, exactly these two lines (the source pin matches them):

```ts
    runners: adapters.runners,
    routeFor: (stage) => resolveStageRoute(config, stage),
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

- [ ] **Step 6: Run.** `pnpm vitest run test/pipeline/stage-runner.routing.test.ts test/host/real-adapters.test.ts test/pipeline/stage-runner.test.ts test/pipeline/stage-runner.workspace-refresh.test.ts` → PASS; then `pnpm test && pnpm typecheck && pnpm lint` → PASS (every existing harness constructs `StageRunner` without `runners`/`routeFor`, which is the legacy path).

- [ ] **Step 7: Commit.**

```bash
git add cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/src/host/serve.ts cgremlin/core/test/pipeline/stage-runner.routing.test.ts cgremlin/core/test/host/real-adapters.test.ts
git commit -m "feat(cgremlin-core): the stage runner routes each stage to its runner, model and effort; one runner per kind (R116)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Per-run records `{stage, runner, model, effort, tokens, limitEvents, outcome}` (R116, R118f)

**Files:**
- Create: `cgremlin/core/src/agent/run-stats.ts`, `cgremlin/core/src/fs/jsonl.ts`, `cgremlin/core/src/pipeline/run-records.ts`
- Modify: `cgremlin/core/src/agent/agent-runner.ts` (types + `getRunStats?`), `cgremlin/core/src/agent/claude-code-runner.ts` (`ClaudeAgentState`, `handleLine`, options `now`), `cgremlin/core/src/agent/codex-runner.ts` (`CodexAgentState`, `handleLine`, options `now`)
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts` (deps `log?`; record after every started run)
- Modify: `cgremlin/core/test/support/fake-agent-runner.ts` (`setRunStats`/`getRunStats`), `cgremlin/core/test/fixtures/fake-claude-cli.js`, `cgremlin/core/test/fixtures/fake-codex-cli.js`
- Test: `cgremlin/core/test/agent/run-stats.test.ts` (new), `cgremlin/core/test/fs/jsonl.test.ts` (new), `cgremlin/core/test/pipeline/stage-runner.run-records.test.ts` (new), `test/agent/claude-code-runner.test.ts`, `test/agent/codex-runner.test.ts`

**Interfaces:**
- Consumes: `RUNNER_KINDS`, `EFFORT_LEVELS`, `ResolvedRoute` (Task 2); `route`/`runner` locals (Task 3); `seedResumeId` (Task 1); `redactSecrets` (`src/config/core-config.ts`).
- Produces:
  - `agent-runner.ts`: `TokenUsage { input; output; cacheRead; cacheWrite: number }`, `LimitEvent { at: string; kind: 'warning' | 'rejected'; limitType: string | null; resetsAt: string | null; message: string | null }`, `RunStats { tokens: TokenUsage | null; limitEvents: readonly LimitEvent[]; observedModel: string | null }`, `AgentRunner.getRunStats?(handle): RunStats | undefined`.
  - `src/fs/jsonl.ts`: `JSONL_FILE_MODE = 0o600`, `appendJsonLine(fs, path, value): Promise<void>`, `readJsonLines<T>(fs, path, schema): Promise<T[]>` (Task 6 uses both).
  - `src/pipeline/run-records.ts`: `RUNS_FILE = 'runs.jsonl'`, `RunRecordSchema`, `type RunRecord`, `appendRunRecord(fs, sessionDir, record)`, `readRunRecords(fs, sessionDir): Promise<RunRecord[]>` (Task 6 reads it).
  - `StageRunnerDeps.log?: (line: string) => void`.

- [ ] **Step 1: Write the failing pure tests.** Create `cgremlin/core/test/agent/run-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addTokens,
  limitEventFromClaude,
  limitEventFromMessage,
  tokensFromClaudeUsage,
  tokensFromCodexUsage,
} from '../../src/agent/run-stats';

const AT = new Date('2026-10-08T12:00:00.000Z');

describe('run stats parsers', () => {
  it('reads Claude result.usage, cache counters included', () => {
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

  it('adds token counts across turns', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(addTokens(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
    expect(addTokens(null, a)).toEqual(a);
    expect(addTokens(a, null)).toEqual(a);
    expect(addTokens(null, null)).toBeNull();
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

Create `cgremlin/core/test/fs/jsonl.test.ts`:

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

- [ ] **Step 2: Write the failing runner tests.** Add fixture branches. In `test/fixtures/fake-claude-cli.js`, before the final `} else {` branch, add:

```js
} else if (prompt === 'USAGE_AND_LIMIT') {
  // R118f — the real CLI's shapes: init carries the model, rate_limit_event the quota state,
  // and the result its usage. `allowed` is not a limit event; `allowed_warning` is.
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  line({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: sessionId });
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, uuid: 'u0', session_id: sessionId });
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1791460800, rateLimitType: 'five_hour', utilization: 0.91 }, uuid: 'u1', session_id: sessionId });
  line({
    type: 'result', subtype: 'success', is_error: false, session_id: sessionId,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 },
    total_cost_usd: 0.42,
  });
} else if (prompt === 'LIMIT_REJECTED') {
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791460800, rateLimitType: 'five_hour' }, uuid: 'u2', session_id: sessionId });
  line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1791460800', session_id: sessionId });
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

Append inside `describe('ClaudeCodeRunner', …)`:

```ts
  it('R118f — getRunStats reports the result usage, the non-allowed limit events and the model the CLI reported', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, now: () => new Date('2026-10-08T11:00:00.000Z') });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'USAGE_AND_LIMIT');
    expect(runner.getRunStats(handle)).toEqual({
      tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
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
    expect(runner.getRunStats(handle).limitEvents).toEqual([
      { at: '2026-10-08T11:00:00.000Z', kind: 'rejected', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null },
    ]);
  });

  it('R118f — a run with no usage reports tokens null and no events', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'hello');
    expect(runner.getRunStats(handle)).toEqual({ tokens: null, limitEvents: [], observedModel: null });
  });
```

Append inside `describe('CodexRunner', …)`:

```ts
  it('R118f — getRunStats reports turn.completed usage', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'hello');
    expect(runner.getRunStats(handle)).toEqual({
      tokens: { input: 12886, output: 19, cacheRead: 4480, cacheWrite: 0 }, limitEvents: [], observedModel: null,
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

- [ ] **Step 3: Write the failing stage-runner tests.** First extend `test/support/fake-agent-runner.ts`: import `RunStats` in the type import from `../../src/agent/agent-runner`, add `runStats?: RunStats;` to `FakeAgentState`, and add these methods to `FakeAgentRunner`:

```ts
  /** Undefined until set — a runner that has nothing to report. */
  getRunStats(handle: AgentHandle): RunStats | undefined {
    return this.requireState(handle).runStats;
  }

  setRunStats(handle: AgentHandle, stats: RunStats): void {
    this.requireState(handle).runStats = stats;
  }
```

Create `cgremlin/core/test/pipeline/stage-runner.run-records.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { KeyedLock } from '../../src/api/keyed-lock';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { readRunRecords } from '../../src/pipeline/run-records';
import type { RunStats } from '../../src/agent/agent-runner';
import type { ResolvedRoute } from '../../src/config/routing';
import type { StageName } from '../../src/schema/stage';
import { migrateV1ToV2 } from '../../src/schema/session';

const NOW = '2026-10-08T12:00:00.000Z';
const STATS: RunStats = {
  tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
  limitEvents: [{ at: NOW, kind: 'warning', limitType: 'five_hour', resetsAt: '2026-10-08T15:00:00.000Z', message: null }],
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
  it('a succeeded run appends its route, tokens, limit events and outcome', async () => {
    const { fs, runner, sr } = await setup({
      routeFor: (stage) => ({ stage, runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' }),
    });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# b', prompt: 'go' });
    await flush();
    const h = runner.lastHandle();
    runner.setRunStats(h, STATS);
    runner.emitExit(h, { code: 0, signal: null });
    await p;
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([
      {
        v: 1, sessionId: 'inv-1', stage: 'findings', runner: 'claude-code', model: 'opus', effort: 'high', routeSource: 'routing',
        fresh: false, resumed: false, startedAt: NOW, finishedAt: NOW,
        tokens: STATS.tokens, limitEvents: STATS.limitEvents, outcome: 'succeeded', error: null,
      },
    ]);
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

  it('a failed and then a stopped run each append their own record; a runner with no stats records tokens null and no limit events', async () => {
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
    expect(records.map((r) => [r.outcome, r.error, r.tokens, r.limitEvents])).toEqual([
      ['failed', 'agent exited with code 1', null, []],
      ['stopped', 'stopped by user', null, []],
    ]);
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

  it('a run that never reached the agent (worktree gone) writes no record', async () => {
    const { fs, sr } = await setup({ worktree: false });
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow();
    expect(await readRunRecords(fs, '/sessions/inv-1')).toEqual([]);
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

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/agent test/fs/jsonl.test.ts test/pipeline/stage-runner.run-records.test.ts` → FAIL (modules missing; `getRunStats` absent; no `runs.jsonl`).

- [ ] **Step 5: Implement the types.** Append to `src/agent/agent-runner.ts` (before `export interface AgentRunner`):

```ts
/** Raw per-vendor token counts for one run (R118f). Claude's `input` excludes cache; Codex's includes it. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
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
  readonly limitEvents: readonly LimitEvent[];
  /** The model the CLI reported it ran (Claude's `system/init`); null when it did not say. */
  readonly observedModel: string | null;
}
```

  and inside `AgentRunner`, after `getPid?`:

```ts
  /** R118f — what this handle's run cost and hit, so far. Undefined: the adapter has nothing to report. */
  getRunStats?(handle: AgentHandle): RunStats | undefined;
```

- [ ] **Step 6: Implement `run-stats.ts`.** Create `cgremlin/core/src/agent/run-stats.ts`:

```ts
import type { LimitEvent, TokenUsage } from './agent-runner';
import { redactSecrets } from '../config/core-config';

const MESSAGE_CAP = 200;
const LIMIT_TEXT = /usage limit|rate limit|hit your limit|too many requests|\b429\b/i;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Claude `result.usage`. Null when it carries neither an input nor an output count. */
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
  1. Import `LimitEvent`, `RunStats`, `TokenUsage` types from `./agent-runner` and `addTokens`, `limitEventFromClaude`, `limitEventFromMessage`, `tokensFromClaudeUsage` from `./run-stats`.
  2. `ClaudeAgentState` gains `tokens: TokenUsage | null; limitEvents: LimitEvent[]; observedModel: string | null;`, initialized in `start()` as `tokens: null, limitEvents: [], observedModel: null`.
  3. `ClaudeCodeRunnerOptions` gains `readonly now?: () => Date;`; the class stores `private readonly now: () => Date;` set to `options.now ?? (() => new Date())`.
  4. In `handleLine`, after `const record = event as Record<string, unknown>;` add:

```ts
    if (record.type === 'system' && record.subtype === 'init' && typeof record.model === 'string') {
      state.observedModel = record.model;
    }
    if (record.type === 'rate_limit_event') {
      const limit = limitEventFromClaude(record.rate_limit_info, this.now());
      if (limit !== null) state.limitEvents.push(limit);
    }
```

  and inside the existing `if (record.type === 'result') { … }` block, after the `is_error` forwarding, add:

```ts
      state.tokens = addTokens(state.tokens, tokensFromClaudeUsage(record.usage));
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
    return { tokens: state.tokens, limitEvents: [...state.limitEvents], observedModel: state.observedModel };
  }
```

- [ ] **Step 8: Codex runner stats.** In `src/agent/codex-runner.ts`:
  1. Import the same three types and `addTokens`, `limitEventFromMessage`, `tokensFromCodexUsage`.
  2. `CodexAgentState` gains `tokens: TokenUsage | null; limitEvents: LimitEvent[];` (initialized `null`, `[]` in `start()`); `CodexRunnerOptions` gains `readonly now?: () => Date;` stored as in the Claude runner.
  3. In `handleLine`'s `switch`: add a `case 'turn.completed': { state.tokens = addTokens(state.tokens, tokensFromCodexUsage(record.usage)); break; }` before `default`; in `case 'error'` after forwarding, add `this.noteLimit(state, record.message);` (inside the `typeof record.message === 'string'` branch); in `case 'turn.failed'` after forwarding, add `this.noteLimit(state, (error as Record<string, unknown>).message as string);` inside its existing guard. Update the trailing comment to say `turn.completed` carries usage.
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
    return { tokens: state.tokens, limitEvents: [...state.limitEvents], observedModel: null };
  }
```

- [ ] **Step 9: Implement `jsonl.ts` and `run-records.ts`.** Create `cgremlin/core/src/fs/jsonl.ts`:

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

Create `cgremlin/core/src/pipeline/run-records.ts`:

```ts
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { appendJsonLine, readJsonLines } from '../fs/jsonl';
import { StageNameSchema } from '../schema/stage';
import { EFFORT_LEVELS, RUNNER_KINDS } from '../config/routing';

/** R116/R118f — one line per run that reached `run.started`, in the session dir. */
export const RUNS_FILE = 'runs.jsonl';

export const TokenUsageSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });

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
  /** The routed model, else the one the CLI reported, else null (the CLI default, unreported). */
  model: z.string().nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  routeSource: z.enum(['routing', 'legacy']),
  fresh: z.boolean(),
  resumed: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  tokens: TokenUsageSchema.nullable(),
  limitEvents: z.array(LimitEventSchema),
  /** The PROCESS outcome; an artifact check may still downgrade `lastRun` afterwards (Ruling S2-10). */
  outcome: z.enum(['succeeded', 'failed', 'stopped']),
  error: z.string().nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function runsPath(sessionDir: string): string {
  return `${sessionDir}/${RUNS_FILE}`;
}

export async function appendRunRecord(fs: SessionFileSystem, sessionDir: string, record: RunRecord): Promise<void> {
  await appendJsonLine(fs, runsPath(sessionDir), RunRecordSchema.parse(record));
}

export async function readRunRecords(fs: SessionFileSystem, sessionDir: string): Promise<RunRecord[]> {
  return readJsonLines(fs, runsPath(sessionDir), RunRecordSchema);
}
```

- [ ] **Step 10: Record every started run in `stage-runner.ts`.**
  1. Imports: add `RunStats` to the agent type import; add `import { appendRunRecord, type RunRecord } from './run-records';`.
  2. `StageRunnerDeps` gains:

```ts
  /** One line per degraded side effect (a run record that could not be written). Defaults to `console.warn`, which the engine log captures. */
  log?: (line: string) => void;
```

  3. Add module-level helpers above the class:

```ts
/** What a run record needs that is only known once `run.started` has fired. */
interface RunFacts {
  route: ResolvedRoute;
  runner: AgentRunner;
  startedAt: string;
  seedResumeId: string | null;
}

function statsOf(runner: AgentRunner, handle: AgentHandle | null): RunStats | null {
  if (handle === null) return null;
  try {
    return runner.getRunStats?.(handle) ?? null;
  } catch {
    return null;
  }
}

function runRecordOf(
  input: StageRunInput,
  facts: RunFacts,
  stats: RunStats | null,
  end: { finishedAt: string; outcome: RunRecord['outcome']; error: string | null },
): RunRecord {
  return {
    v: 1,
    sessionId: input.sessionId,
    stage: input.stage,
    runner: facts.route.runner,
    model: facts.route.model ?? stats?.observedModel ?? null,
    effort: facts.route.effort,
    routeSource: facts.route.source,
    fresh: input.fresh === true,
    resumed: facts.seedResumeId !== null,
    startedAt: facts.startedAt,
    finishedAt: end.finishedAt,
    tokens: stats?.tokens ?? null,
    limitEvents: [...(stats?.limitEvents ?? [])],
    outcome: end.outcome,
    error: end.error,
  };
}
```

  4. Add a private method on `StageRunner`:

```ts
  /**
   * R116/R118f — appends the run's record. Never throws: a record that cannot be written is a
   * log line, and the run's outcome and lastRun stay exactly what they were. No lock: a session
   * has at most one run (the `active` reservation), so nothing else writes this file meanwhile.
   */
  private async recordRun(sessionDir: string, record: RunRecord): Promise<void> {
    try {
      await appendRunRecord(this.deps.fs, sessionDir, record);
    } catch (err) {
      (this.deps.log ?? ((line: string) => console.warn(line)))(
        `run record for ${record.sessionId} not written: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

  5. In `run()`, next to `let runStarted = false;` add `let facts: RunFacts | null = null;`. Directly before `this.deps.events.emit('run.started', { session, stage });` add `facts = { route, runner, startedAt, seedResumeId };` (`startedAt` is the existing local set just before the `running` LastRun).
  6. In the success path, directly before `this.deps.events.emit('run.finished', { session, stage, outcome });`, add:

```ts
        await this.recordRun(
          sessionDir,
          runRecordOf(input, facts, statsOf(runner, active.handle), {
            finishedAt: finishedLastRun.finishedAt ?? this.now().toISOString(),
            outcome,
            error,
          }),
        );
```

  7. In the outer `catch (err)` path, directly before its `this.deps.events.emit('run.finished', { session: finishedSession, stage, outcome: 'failed' });`, add:

```ts
        if (facts !== null) {
          await this.recordRun(
            sessionDir,
            runRecordOf(input, facts, statsOf(facts.runner, active.handle), {
              finishedAt: failed.finishedAt ?? this.now().toISOString(),
              outcome: 'failed',
              error: failed.error,
            }),
          );
        }
```

  (`sessionDir` is declared before the inner `try`, so it is in scope in both paths. If TypeScript reports `facts` as possibly null in the success path, narrow with `if (facts === null) throw new Error('unreachable: run.started fired without run facts');` placed right after `const exit = await exitPromise;`.)

- [ ] **Step 11: Run.** `pnpm vitest run test/agent test/fs test/pipeline/stage-runner.run-records.test.ts test/pipeline/stage-runner.test.ts test/pipeline/stage-runner.routing.test.ts` → PASS; `pnpm test && pnpm typecheck && pnpm lint` → PASS. Every stage run now writes `<session>/runs.jsonl`: if a pre-existing test asserts the exact file list of a session dir, or counts watcher/`session.changed` frames for one run, add `runs.jsonl` / its one extra change to that expectation (it is a new engine file, not a regression) and name the test in the commit message. Do not change any production behaviour to avoid it.

- [ ] **Step 12: Commit.**

```bash
git add cgremlin/core/src/agent cgremlin/core/src/fs/jsonl.ts cgremlin/core/src/pipeline/run-records.ts cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/test/agent cgremlin/core/test/fs/jsonl.test.ts cgremlin/core/test/pipeline/stage-runner.run-records.test.ts cgremlin/core/test/support/fake-agent-runner.ts cgremlin/core/test/fixtures/fake-claude-cli.js cgremlin/core/test/fixtures/fake-codex-cli.js
git commit -m "feat(cgremlin-core): per-run records in runs.jsonl with route, tokens, limit events and outcome (R116, R118f)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: PR detection for development sessions; merged/closed reconciliation (R91)

**Files:**
- Create: `cgremlin/core/src/pipeline/pr-detection.ts`
- Modify: `cgremlin/core/src/pipeline/pipeline-service.ts` (deps `gh?`; `log` helper; `runDevelop` `:761-804`; new `adoptDevelopmentPr`)
- Modify: `cgremlin/core/src/discovery/reconciliation.ts:49-52` (comment), `:196-249` (`PrBearingSession`, `planPrSessionReconciliation`), `:387-412` (`runPrBearingSessions` candidates and in-lock check)
- Modify: `cgremlin/core/src/host/build-engine.ts` (`new PipelineService({ … gh: adapters.gh, … })`)
- Modify: `cgremlin/core/test/support/pipeline-harness.ts` (`HarnessOptions.gh`)
- Test: `cgremlin/core/test/pipeline/pr-detection.test.ts` (new), `cgremlin/core/test/pipeline/pipeline-service.development.test.ts`, `cgremlin/core/test/discovery/reconciliation.test.ts`

**Interfaces:**
- Consumes: `parsePrUrl` (`src/gh/pr-url.ts`), `PR_VIEW_FIELDS`, `PR_LIST_FIELDS`, `parsePrView`, `parsePrList`, `mapPrView` (`src/gh/pr-view.ts`), `GhRunner` (`src/gh/gh-runner.ts`), `repoSlugFromUrl`, `applyTransition`, `redactSecrets`.
- Produces:
  - `export type PrDetection = { found: true; pr: PrInfo; isDraft: boolean; via: 'PR_URL' | 'gh pr list' } | { found: false; why: string }`
  - `export async function detectDevelopmentPr(input: { gh: GhRunner; fs: SessionFileSystem; sessionDir: string; repoSlug: string; branch: string }): Promise<PrDetection>`
  - `PipelineServiceDeps.gh?: GhRunner`; `PipelineService` private `log(line: string): void` (Task 6 uses it).
  - `PrBearingSession = RespondSession | InvestigationSession | DevelopmentSession`.
  - `HarnessOptions.gh?: GhRunner`.

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
    state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null, ...overrides,
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
  const detect = () => detectDevelopmentPr({ gh, fs, sessionDir: DIR, repoSlug: 'o/r', branch: BRANCH });
  return { gh, detect };
}

describe('detectDevelopmentPr (R91)', () => {
  it('adopts the PR the agent recorded once gh confirms it is OPEN, in this repo, on this branch', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7\n');
    gh.queueResponse({ stdout: viewJson() });
    expect(await detect()).toEqual({
      found: true, via: 'PR_URL', isDraft: true,
      pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', headSha: SHA, reviewedSha: null, title: baseView.title, author: baseView.author.login },
    });
    expect(gh.calls).toEqual([['pr', 'view', '7', '--repo', 'o/r', '--json', PR_VIEW_FIELDS]]);
  });

  it('a stale PR_URL (another branch) is ignored and gh pr list --head decides', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ headRefName: 'feature/OLD-9' }) });
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    const result = await detect();
    expect(result).toMatchObject({ found: true, via: 'gh pr list', isDraft: true, pr: { number: 9, url: 'https://github.com/o/r/pull/9', headSha: SHA, author: 'me' } });
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
      expect(result.why).toContain(`no open PR has head ${BRANCH}`);
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

  it('two open PRs on the branch: not guessing', async () => {
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

and pass `...(options.gh !== undefined ? { gh: options.gh } : {}),` in the `new PipelineService({ … })` call next to the other optional spreads.

Append to `test/pipeline/pipeline-service.development.test.ts` (add imports: `readFileSync` from `node:fs`, `path` from `node:path`, `FakeGhRunner` from `../support/fake-gh-runner`, `GhCommandError` from `../../src/gh/gh-runner`, `UnsupportedStageError` from `../../src/pipeline/pipeline-service`):

```ts
describe('R91 — a develop run records its draft PR', () => {
  const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));
  const prView = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...baseView, number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'feature/ABC-1',
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
    expect(after.pr).toMatchObject({ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', reviewedSha: null });
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

  it('without gh wired the session stays active with no PR (today)', async () => {
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

  it('runDevelop is refused once the session is merged', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.service.transition(dev.id, 'merged');
    await expect(h.service.runDevelop(dev.id)).rejects.toBeInstanceOf(UnsupportedStageError);
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

  it('a development session with no PR, or already terminal, costs no gh call', async () => {
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

- [ ] **Step 4: Run to verify failure.** `pnpm vitest run test/pipeline/pr-detection.test.ts test/pipeline/pipeline-service.development.test.ts test/discovery/reconciliation.test.ts` → FAIL (`pr-detection` missing; session stays `active`; development leg absent).

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
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactSecrets(text.split('\n')[0].slice(0, 200));
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
 * text): it must parse as a GitHub PR URL, name THIS repo, be OPEN, and have this session's
 * branch as its head — otherwise it is ignored as stale and `gh pr list --head <branch>` decides,
 * adopting only an unambiguous single match. Never throws: a missing or unauthenticated gh is
 * `found: false` with the reason.
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
        if (view.headRefName !== input.branch) {
          notes.push(`PR_URL #${ref.number} is for branch ${view.headRefName}, not ${input.branch}`);
        } else if (view.state !== 'OPEN') {
          notes.push(`PR_URL #${ref.number} is ${view.state}`);
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
    const matches = parsePrList(stdout).filter((item) => item.headRefName === input.branch);
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
        ? `no open PR has head ${input.branch}`
        : `${matches.length} open PRs have head ${input.branch}; not guessing`,
    );
  } catch (err) {
    notes.push(`gh pr list failed: ${messageOf(err)}`);
  }
  return { found: false, why: notes.join('; ') };
}
```

- [ ] **Step 6: Wire detection into `PipelineService`.** In `src/pipeline/pipeline-service.ts` (leave lines 1-14 untouched; add imports below them):
  1. Imports: `import type { GhRunner } from '../gh/gh-runner';`, `import { detectDevelopmentPr } from './pr-detection';`, and add `DevelopmentPhase` to the `import type { RespondPhase, ReviewPhase } from '../schema/pipeline';` line.
  2. In `PipelineServiceDeps`, after `ghAuthOk`, add:

```ts
  /**
   * R91 — read-only PR detection after a develop run (`gh pr view` / `gh pr list` only; never
   * opens or posts). Absent: no detection, and a development session stays `active` (pre-step-2).
   */
  gh?: GhRunner;
```

  3. Add a private helper (next to `sessionDir`):

```ts
  /** One line per degraded side effect. Defaults to `console.warn`, which the engine log captures. */
  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(l)))(line);
  }
```

     and change the existing inline `(this.deps.log ?? ((line: string) => console.warn(line)))(…)` call in `releaseConversation` to `this.log(…)` with the same message.
  4. In `runDevelop`: declare `const DEVELOP_RUNNABLE_FROM: readonly DevelopmentPhase[] = ['active', 'pr_opened'];` as its first statement; replace the comment `// No transition on success: PR detection (which drives active -> pr_opened) is Phase 3b.` with `// R91 — the PR the run opened is detected after it, whatever its outcome (adoptDevelopmentPr). Runnable from pr_opened too: a fix round on the open draft.`; change the in-lock check to `if (fresh.mode !== 'development' || !DEVELOP_RUNNABLE_FROM.includes(fresh.stageStatus)) {`; and change `return result.session;` to `return await this.adoptDevelopmentPr(id, result.session);`.
  5. Add the method after `runDevelop`:

```ts
  /**
   * R91 — after a develop run (any outcome: a PR the agent opened before it died is still a PR),
   * find this session's open PR and record it: `session.pr` + `active → pr_opened` in ONE locked
   * save and one `session.transitioned`. Read-only gh (src/pipeline/pr-detection.ts). A session
   * that already has a PR or is no longer `active` is left alone. Never throws: a miss is one log
   * line and the session as it was. A PR opened for review rather than as a draft is still
   * recorded (it is a fact), and lastRun says it needed approval (R112).
   */
  private async adoptDevelopmentPr(id: string, after: Session): Promise<Session> {
    const gh = this.deps.gh;
    if (gh === undefined) return after;
    if (after.mode !== 'development' || after.pr !== null || after.stageStatus !== 'active') return after;
    const branch = after.workspace.branch;
    if (!branch) return after;
    const detection = await detectDevelopmentPr({
      gh,
      fs: this.deps.fs,
      sessionDir: this.sessionDir(id),
      repoSlug: repoSlugFromUrl(after.workspace.repoUrl),
      branch,
    });
    if (!detection.found) {
      this.log(`PR detection for ${id}: none adopted (${detection.why})`);
      return after;
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

  6. In `src/host/build-engine.ts`, in the `new PipelineService({ … })` call add `gh: adapters.gh,` after `ghAuthOk: …,` (before `respondContext`).

- [ ] **Step 7: Development joins PR-bearing reconciliation.** In `src/discovery/reconciliation.ts`:
  1. Import `DevelopmentSession` with the other session types. Replace the comment above `MERGE_ELIGIBLE_DEVELOPMENT_PHASES` (`:49-51`) with: `// A development session's own PR is reconciled by runPrBearingSessions (R91); this list covers the review-lineage path, and 'active' stays eligible for a session that never recorded its PR.`
  2. `export type PrBearingSession = RespondSession | InvestigationSession | DevelopmentSession;` and update its doc comment's first line to `/** A session that owns a PR without being a review of it: respond, investigation (R51) and development (R91). */`.
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

  4. In `runPrBearingSessions`, change both mode tests from `(s.mode === 'respond' || s.mode === 'investigation')` / `(fresh.mode !== 'respond' && fresh.mode !== 'investigation')` to include development: `(s.mode === 'respond' || s.mode === 'investigation' || s.mode === 'development')` and `(fresh.mode !== 'respond' && fresh.mode !== 'investigation' && fresh.mode !== 'development')`. Update the method's doc comment: "The `respond`/`investigation`/`development` leg".

- [ ] **Step 8: Run.** `pnpm vitest run test/pipeline/pr-detection.test.ts test/pipeline/pipeline-service.development.test.ts test/discovery test/pipeline/pipeline-service.human-turn.test.ts test/pipeline/pipeline-service.environment.test.ts` → PASS. If an existing tick test in `reconciliation.test.ts` now reports an extra `gh` call or a `report.errors` entry, it saved a non-terminal development session with a `pr` that the development leg now visits: queue one more `{ stdout: viewJson({ state: 'OPEN' }) }` for it, and say so in the commit message. Then `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 9: Commit.**

```bash
git add cgremlin/core/src/pipeline/pr-detection.ts cgremlin/core/src/pipeline/pipeline-service.ts cgremlin/core/src/discovery/reconciliation.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/test/support/pipeline-harness.ts cgremlin/core/test/pipeline/pr-detection.test.ts cgremlin/core/test/pipeline/pipeline-service.development.test.ts cgremlin/core/test/discovery/reconciliation.test.ts
git commit -m "feat(cgremlin-core): development sessions record their draft PR (pr_opened) and follow it to merged/closed; runDevelop from pr_opened (R91)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `feedback.jsonl` — dismissed findings and rejected verdicts (§18 A6, §20)

**Files:**
- Create: `cgremlin/core/src/feedback/review-findings.ts`, `cgremlin/core/src/feedback/feedback-log.ts`, `cgremlin/core/src/feedback/feedback-capture.ts`
- Modify: `cgremlin/core/src/config/core-config.ts` (derived `feedbackPath`, `DERIVED_PATH_SUFFIXES`)
- Modify: `cgremlin/core/src/pipeline/pipeline-service.ts` (deps `feedback?`; `transition(id, to, opts)`; `releaseConversation`; `runReview`; `runRereview`; two private capture methods)
- Modify: `cgremlin/core/src/api/server.ts` (the `/transition` and `/approve-pr` routes)
- Modify: `cgremlin/core/src/host/build-engine.ts` (`feedback: new FeedbackLog(…)`)
- Modify: `cgremlin/core/test/support/pipeline-harness.ts` (`HarnessOptions.feedback`, `PipelineHarness.feedback`)
- Test: `cgremlin/core/test/feedback/review-findings.test.ts`, `cgremlin/core/test/feedback/feedback-log.test.ts`, `cgremlin/core/test/feedback/feedback-capture.test.ts`, `cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts` (all new), `cgremlin/core/test/config/core-config.test.ts`

**Interfaces:**
- Consumes: `appendJsonLine`, `readJsonLines` (Task 4); `readRunRecords`, `RunRecord` (Task 4); `RUNNER_KINDS`, `EFFORT_LEVELS` (Task 2); `PipelineService.log` (Task 5); `REVIEW_CONTRACT_EXAMPLE` (`src/pipeline/prompts.ts:337`); `redactSecrets`; `readNonEmpty`.
- Produces:
  - `review-findings.ts`: `interface ReviewFinding { anchor; number; title; severity; where; status; dismissed }`, `type ReviewVerdict = 'approve' | 'request_changes' | 'comment'`, `parseReviewFindings(text): ReviewFinding[]`, `parseReviewVerdict(text): ReviewVerdict | null`.
  - `feedback-log.ts`: `FEEDBACK_KINDS`, `FeedbackRecordSchema`, `type FeedbackRecord`, `class FeedbackLog { constructor(fs, path); appendOnce(record): Promise<boolean>; list(): Promise<FeedbackRecord[]> }`.
  - `feedback-capture.ts`: `FEEDBACK_TEXT_CAP = 300`, `interface CaptureContext { session; sessionDir; at; producedBy }`, `producedByFrom(runs, stages)`, `dismissalRecords(ctx, reviewText)`, `humanTransitionRecords(ctx, from, to, texts)`.
  - `CoreConfig.feedbackPath` (derived `<stateDir>/feedback.jsonl`); `PipelineServiceDeps.feedback?: FeedbackLog`; `PipelineService.transition(id: string, to: string, opts?: { by?: 'human' }): Promise<Session>`.

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
import { dismissalRecords, humanTransitionRecords, producedByFrom, type CaptureContext } from '../../src/feedback/feedback-capture';
import type { RunRecord } from '../../src/pipeline/run-records';
import type { Session } from '../../src/schema/session';

const AT = '2026-10-08T12:00:00.000Z';
const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');

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
  it('one record per dismissed finding, keyed by session and anchor', () => {
    const records = dismissalRecords(ctx(review), DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
    expect(records).toEqual([
      {
        v: 1, id: 'finding_dismissed:rev-1:f2', at: AT, source: 'auto', kind: 'finding_dismissed',
        text: 'Dismissed finding 2 (🔧 Maintainability, ui/list.tsx:40): <plain-English title>',
        context: {
          sessionId: 'rev-1', mode: 'review', stage: 'review', ticket: 'APP-1', pr: { repo: 'acme/app', number: 1 },
          artifact: '/sessions/rev-1/REVIEW.md', anchor: 'f2',
        },
        producedBy: BY,
        detail: { number: 2, severity: '🔧 Maintainability', where: 'ui/list.tsx:40', title: '<plain-English title>' },
      },
    ]);
    expect(dismissalRecords(ctx(review), REVIEW_CONTRACT_EXAMPLE)).toEqual([]);
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
      startedAt: AT, finishedAt: AT, tokens: null, limitEvents: [], outcome: 'succeeded', error: null,
    });
    expect(producedByFrom([run('review', 'a'), run('rereview', 'b'), run('respond', 'c')], ['review', 'rereview'])).toEqual({
      stage: 'rereview', runner: 'claude-code', model: 'b', effort: null,
    });
    expect(producedByFrom([run('respond', 'c')], ['review'])).toBeNull();
  });
});
```

- [ ] **Step 4: Write the failing pipeline tests.** In `test/support/pipeline-harness.ts`: import `FeedbackLog` (`../../src/feedback/feedback-log`); add to `HarnessOptions`:

```ts
  /** §20 — PipelineServiceDeps.feedback, built on the harness's own fs; omitted means no capture. */
  feedback?: (fs: InMemoryFileSystem) => FeedbackLog;
```

  add `feedback: FeedbackLog | undefined;` to `PipelineHarness`; in `createHarness` compute `const feedback = options.feedback?.(fs);`, pass `...(feedback !== undefined ? { feedback } : {}),` to `new PipelineService`, and add `feedback` to the returned object.

Create `cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts`:

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
    expect(records.map((r) => [r.kind, r.id])).toEqual([['finding_dismissed', 'finding_dismissed:rev-1:f2']]);
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
    expect(records.map((r) => r.id)).toEqual(['finding_dismissed:rev-1:f2']);
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

  it('only the API routes a person calls mark a transition as human; the reconciliation tick never does', () => {
    const server = readFileSync(path.join(__dirname, '../../src/api/server.ts'), 'utf8');
    expect(server).toContain("deps.pipeline.transition(id, body.to, { by: 'human' })");
    expect(server).toContain("deps.pipeline.transition(id, 'approved', { by: 'human' })");
    const reconciliation = readFileSync(path.join(__dirname, '../../src/discovery/reconciliation.ts'), 'utf8');
    expect(reconciliation).not.toContain("by: 'human'");
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

- [ ] **Step 5: Run to verify failure.** `pnpm vitest run test/feedback test/pipeline/pipeline-service.feedback.test.ts test/config/core-config.test.ts` → FAIL (modules missing, `transition` ignores `by`, no `feedbackPath`).

- [ ] **Step 6: Implement `review-findings.ts`.** Create `cgremlin/core/src/feedback/review-findings.ts`:

```ts
/**
 * §20 — what the engine reads back out of REVIEW.md: its findings (by stable anchor) and its
 * verdict. The shape is the contract the agents are shown (REVIEW_CONTRACT_EXAMPLE,
 * src/pipeline/prompts.ts); the table row and the detail block each carry a Status, and a
 * finding is dismissed when EITHER says so (the contract keeps them equal; a hand edit may not).
 */
export interface ReviewFinding {
  /** `f1`, `f2`, … — the same finding keeps its anchor across re-reviews. */
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

- [ ] **Step 7: Implement `feedback-log.ts`.** Create `cgremlin/core/src/feedback/feedback-log.ts`:

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

- [ ] **Step 8: Implement `feedback-capture.ts`.** Create `cgremlin/core/src/feedback/feedback-capture.ts`:

```ts
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

/** §20 — one record per finding marked dismissed; the id makes each finding count once per session. */
export function dismissalRecords(ctx: CaptureContext, reviewText: string): FeedbackRecord[] {
  const artifact = `${ctx.sessionDir}/REVIEW.md`;
  return parseReviewFindings(reviewText)
    .filter((f) => f.dismissed)
    .map((f) => {
      const where = f.severity === null ? '' : ` (${f.severity}${f.where === null ? '' : `, ${f.where}`})`;
      return {
        v: 1 as const,
        id: `finding_dismissed:${ctx.session.id}:${f.anchor}`,
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
 * §20 / Ruling S2-18 — a PERSON's API action against an engine verdict. Only called for
 * transitions marked `by: 'human'`; the reconciliation tick's transitions never reach here.
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

  Note on the expected test text in Step 3: the investigation case is attributed with `producedBy` from the context the caller passes (`BY` in the unit test); `PipelineService` passes the newest `plan` run.

- [ ] **Step 9: Derive `feedbackPath`.** In `src/config/core-config.ts`: add to `CoreConfigSchema` (after `dismissalsPath`):

```ts
  /** §20, derived: <stateDir>/feedback.jsonl — dismissed findings and rejected verdicts. */
  feedbackPath: z.string().optional(),
```

  in `resolveCoreConfig`'s return add `feedbackPath: expandOrDerive(parsed.feedbackPath, 'feedback.jsonl'),` after `dismissalsPath`; in `DERIVED_PATH_SUFFIXES` add `feedbackPath: 'feedback.jsonl',` after `dismissalsPath` (both registrations, per the ARCHITECTURE.md:528-534 note at `:249-251`).

- [ ] **Step 10: Hook the pipeline.** In `src/pipeline/pipeline-service.ts` (lines 1-14 untouched):
  1. Imports: `import type { FeedbackLog } from '../feedback/feedback-log';`, `import { dismissalRecords, humanTransitionRecords, producedByFrom, type CaptureContext } from '../feedback/feedback-capture';`, `import { readRunRecords } from './run-records';`.
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

  4. Add the capture methods (after `transition`):

```ts
  private async feedbackContext(session: Session, stages: readonly StageName[]): Promise<CaptureContext> {
    const sessionDir = this.sessionDir(session.id);
    const runs = await readRunRecords(this.deps.fs, sessionDir).catch(() => []);
    return { session, sessionDir, at: this.now().toISOString(), producedBy: producedByFrom(runs, stages) };
  }

  /**
   * §20 / Ruling S2-17 — every finding this review's REVIEW.md marks dismissed, recorded once.
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

  /** §20 / Ruling S2-18 — a person's transition against an engine verdict. Never throws. */
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

- [ ] **Step 11: Mark the human routes and wire the log.** In `src/api/server.ts`:
  - `/transition` route: `const updated = await deps.pipeline.transition(id, body.to);` → `const updated = await deps.pipeline.transition(id, body.to, { by: 'human' });`
  - `/approve-pr` route: `const updated = await deps.pipeline.transition(id, 'approved');` → `const updated = await deps.pipeline.transition(id, 'approved', { by: 'human' });`

  In `src/host/build-engine.ts`: `import { FeedbackLog } from '../feedback/feedback-log';` and in `new PipelineService({ … })` add, after `gh: adapters.gh,`:

```ts
    // §20 — guarded: a hand-built test config may carry no derived feedbackPath, and a FeedbackLog
    // on an undefined path would write a file literally named "undefined".
    ...(config.feedbackPath !== undefined ? { feedback: new FeedbackLog(adapters.fs, config.feedbackPath) } : {}),
```

- [ ] **Step 12: Run.** `pnpm vitest run test/feedback test/pipeline/pipeline-service.feedback.test.ts test/config test/api test/pipeline/pipeline-service.human-turn.test.ts test/pipeline/pipeline-service.review.test.ts test/discovery` → PASS; then `pnpm test && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 13: Commit.**

```bash
git add cgremlin/core/src/feedback cgremlin/core/src/config/core-config.ts cgremlin/core/src/pipeline/pipeline-service.ts cgremlin/core/src/api/server.ts cgremlin/core/src/host/build-engine.ts cgremlin/core/test/feedback cgremlin/core/test/pipeline/pipeline-service.feedback.test.ts cgremlin/core/test/support/pipeline-harness.ts cgremlin/core/test/config/core-config.test.ts
git commit -m "feat(cgremlin-core): feedback.jsonl captures dismissed findings and rejected verdicts; only human API transitions count (§20)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: DECISIONS, docs, full gates

**Files:**
- Modify: `cgremlin/core/docs/DECISIONS.md` (append the section below)
- Verify only: `bin/`, `plugin/skills/`, `src/pipeline/preflight.ts` and its two tests are unchanged

**Interfaces:**
- Consumes: everything Tasks 1-6 produced.
- Produces: the DECISIONS entry the release row and the tracker log point to.

- [ ] **Step 1: DECISIONS entry.** Append to `cgremlin/core/docs/DECISIONS.md`:

```markdown
## 2026-10-08 — Step 2 (Foundations: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl; R90/R91/R116/R118f/§20)

- **Fresh runs (R90).** `StageRunInput.fresh` starts a run with no `--resume`, whatever the
  session's agent record holds; a fresh run that reports no conversation id keeps the previous
  one so Take over still works. Before a fresh round, `BRIEF.md` is copied and `FEEDBACK.md`
  moved to `<STEM>-v<N>.md` under one round number; `StageRunInput.feedback` writes the round's
  `FEEDBACK.md`. No existing stage passes `fresh` yet: phase rounds (step 5) are the first caller.
- **PR tracking (R91).** After every develop run that reached the agent (any outcome), the engine
  looks for the session's OPEN PR with read-only `gh pr view` / `gh pr list` only: the agent's
  `PR_URL` is a hint that must name this repo and this branch and be OPEN, else
  `gh pr list --head <branch> --state open` decides on a single match. Adoption is one locked
  save: `session.pr` + `active → pr_opened`. A non-draft PR is adopted and flagged in
  `lastRun.error` (R112). `runDevelop` runs from `active` and `pr_opened`. Development sessions
  joined PR-bearing reconciliation: their own PR merged → `merged`, closed → `abandoned`.
  Known consequence: a self-review of a dev PR now really moves the dev session to `superseded`
  (`linkPrToSource`), which `runDevelop` does not run from.
- **Routing (R116).** `routing.<stage> = { runner, model?, effort?, escalate?, secondOpinion? }`,
  strict, keyed by StageName. No entry = the legacy `runner`/`runnerOptions` exactly as before; a
  route's missing model inherits `runnerOptions.model` only from the same runner family. Codex
  has no `max` and may not be the `develop` runner (report-only in v1); `escalate` and
  `secondOpinion` are validated but not executed until later steps. One runner instance per
  kind; model and effort travel per run on `SessionContext`. Claude gets `--effort`, Codex
  `-c model_reasoning_effort="…"`, and every Claude spawn drops `CLAUDE_CODE_EFFORT_LEVEL`.
- **Run records (R116/R118f).** `<session>/runs.jsonl`, one line per run that reached
  `run.started`: stage, runner, model (routed, else the CLI-reported one), effort, route source,
  fresh/resumed, times, raw per-vendor tokens, limit events (Claude `rate_limit_event`
  warning/rejected, plus a text fallback; Codex text), process outcome and error. A record that
  cannot be written is a log line, never a failed run. No cost field (subscriptions).
- **Feedback capture (§20).** `<stateDir>/feedback.jsonl` (`feedbackPath`, 0600) records
  `finding_dismissed` (a REVIEW.md finding whose Status says dismissed; once per session+anchor;
  captured at conversation release, before a review run, before a re-review archive, and on a
  person's transition), `verdict_rejected` (approving a PR whose review said 🔄 Request changes;
  abandoning an investigation at `plan_ready`) and `review_dismissed` (a person dismissing a
  review that has a REVIEW.md). Only the `/transition` and `/approve-pr` routes mark
  transitions `by: 'human'`; reconciliation never does. Text is one line, redacted, ≤ 300 chars.
- **JSONL files** are rewritten tmp-then-rename with the engine as the only writer; readers skip
  torn and foreign lines. A future writer outside the engine (step 11's UI) must go through the
  engine API.
- **Not in this step:** no UI or API exposure of runs, feedback or round archives; no executed
  escalation or second opinion; QA verdicts and sign-offs are not captured.
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
git commit -m "docs(cgremlin-core): decisions for step 2" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
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
3. **Clear the untracked plan copy, then merge.** The main checkout holds this plan untracked at the path `step/2` commits it to, which would block the merge. `cd /Users/guilherme.azoubel/context-gremlin && git show step/2:docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md | diff - docs/superpowers/plans/2026-10-08-cgremlin-step-2-foundations.md`; if it prints nothing, move the untracked copy to the scratchpad; if not, stop and ask. Then from `/Users/guilherme.azoubel/context-gremlin` on `mission-control-pr-orchestrator`: `git merge --no-ff step/2 -m "Merge step/2: foundations — fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl (cgremlin-2)"` and `git tag -a cgremlin-2 HEAD -m "step 2: fresh runs, PR tracking, per-stage routing, run records, feedback.jsonl"`. Re-run the core and vscode gates on the merge commit.
4. **Build and save.** `cd cgremlin/vscode && pnpm build && pnpm package`, then `cp cgremlin-vscode-0.0.1.vsix ~/cgremlin-releases/cgremlin-vscode-0.0.1-2-built-<YYYY-MM-DD>.vsix` (check the version in `package.json`).
5. **GATE — ask the user before installing.** Step 2 changes engine runtime code, so the build should be installed, but only on the user's yes: `code --install-extension ~/cgremlin-releases/cgremlin-vscode-0.0.1-2-built-<date>.vsix --force`, then **Developer: Reload Window** → **cgremlin: Restart the engine**. Smoke check (no `core.json` read): the panel lists the existing sessions (the engine loaded a config with no `routing` key) and `~/.cgremlin-core/engine.log` shows no config error since the restart.
6. **Records.** `RELEASES.md`: a `cgremlin-pre-2` baseline row (`b1a096b`, `cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix`, "Baseline: the build that was installed before 2 (identical to `cgremlin-1`)") and a `cgremlin-2` row (merge commit, the saved build and whether it was installed, "**2:** fresh runs (`StageRunInput.fresh`, BRIEF/FEEDBACK round archive); development sessions record their draft PR (`pr_opened`) and follow it to merged/closed; `routing.<stage>` per-stage runner/model/effort (Claude `--effort`, Codex `model_reasoning_effort`, `CLAUDE_CODE_EFFORT_LEVEL` dropped); `runs.jsonl` per session; `~/.cgremlin-core/feedback.jsonl` for dismissed findings and rejected verdicts. No UI change. Existing `core.json` files load unchanged.", roll back to `cgremlin-pre-2`). Refresh `~/cgremlin-releases/README.md` with the same rows. Program tracker (`docs/superpowers/plans/2026-10-05-cgremlin-program.md`): row 2 → `✅ done <date>`, plan = this file, tag `cgremlin-2`; row 3 → `ready` (its only dependency is 2); tick step 2's Done-when boxes; add a Log row (what shipped, the review result, the `superseded` open question if still open). Commit `docs(cgremlin): release 2 in RELEASES.md; tracker marks 2 done`.
7. **GATE — ask the user, then push** exactly: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-2 refs/tags/cgremlin-2` (the user gets the permission prompt). Note the push in the Log row.
8. **Cleanup** after the user confirms: `git worktree remove .claude/worktrees/2 && git branch -d step/2`, then `/exit`.

## Self-review

- **Spec coverage.** R90 fresh + per-round BRIEF/FEEDBACK archive → Task 1. R91 PR_URL or `gh pr list --head` → `session.pr` / `pr_opened`, development in merged/closed reconciliation, `runDevelop` from `pr_opened` → Task 5. R116 `routing.<stage> {runner, model, effort, escalate, secondOpinion}`, Claude `--model`+`--effort`, `CLAUDE_CODE_EFFORT_LEVEL` unset, Codex `-m` + `-c model_reasoning_effort`, Codex report-only (develop refused; read-only sandbox for second opinions deferred with them) → Tasks 2-3. R116/R118f per-run `{stage, runner, model, effort, tokens, limitEvents, outcome}` → Task 4 (cost deliberately omitted, S2-10). §18 A6 / §20 automatic signals "findings I dismiss" and "sign-offs I contradict" (today: verdicts) → Task 6; "fixes I revert", "no-progress guard" and notes are later steps (no engine signal exists yet). §17 table values are defaults for the user's `core.json`, not code; step 12 tunes them.
- **Placeholder scan.** Every code step carries the code; the only conditional instructions are Task 4 Step 10's TypeScript narrowing fallback and Task 5 Step 8's "queue one more OPEN view" for a pre-existing tick test, both with the exact code to use.
- **Type consistency.** `RunnerKind`, `Effort`, `RUNNER_KINDS`, `EFFORT_LEVELS`, `ResolvedRoute{stage, runner, model, effort, source}` (Task 2) are used unchanged in Tasks 3, 4, 6. `RunStats{tokens, limitEvents, observedModel}` (Task 4) matches the fake runner and both CLIs. `RunRecord` fields (Task 4) match `producedByFrom` (Task 6). `PrDetection`/`detectDevelopmentPr` (Task 5) and `PipelineService.log` (Task 5, reused in Task 6) are named identically. `transition(id, to, { by: 'human' })` matches the server.ts source pin.
- **Review Focus.** Items 1-13 each name their pinning test in the owning task (Tasks 1, 2, 3, 4, 5, 6).
- **bash↔Python heredoc.** No task touches `bin/cgremlin`; Task 7 Step 3 proves it.

## Open questions for the user

1. **`superseded` now reachable.** Creating a review session for your own dev PR moves the dev session `pr_opened → superseded` (`link-pr-to-source.ts:55`, `review-session-factory.ts:118-122`), and `runDevelop` does not run from `superseded` (S2-15, per the card). Keep that, or should step 2 also allow `superseded` (or stop superseding on self-reviews)?
2. **`review_dismissed` as feedback.** S2-18 records a person dismissing a review that has a REVIEW.md. If "not interested" dismissals would be noise in step 11, drop that kind (one branch in `humanTransitionRecords`).
