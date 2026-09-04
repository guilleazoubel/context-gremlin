# cgremlin/core Phase 3 — Pipelines: Design

Date: 2026-09-04
Status: approved by supervising session; rulings recorded in section 2, user may override
Parent spec: `2026-08-28-cgremlin-core-rebuild-design.md` (sections 3, 6, 7, 11)
Grounding: legacy `bin/cgremlin` behavior extracted at commit `ef665e2` (functions and
line numbers cited inline); `claude --help` verified live for `--add-dir`, `--resume`,
`--output-format stream-json`; `gh` 2.72.0 authenticated on this machine.

## 0. What Phase 3 is

Phases 0–2a built the parts: a typed session schema with per-mode transition tables, a
`SessionStore`, git-worktree workspace isolation, a local HTTP-over-Unix-socket API, the
`AgentRunner` interface, and a real `ClaudeCodeRunner`. Nothing yet *drives* an agent
through a pipeline. Phase 3 adds the orchestration layer:

- **3a — Pipeline engine.** Stage runs (investigate → plan → develop; review; re-review) that
  build a brief + prompt + permission guard, run the agent via `AgentRunner`, inspect the
  artifacts the agent leaves in the session directory, and perform the resulting state
  transition. The plan-approval gate. Session creation as a use case (session + workspace
  together). Promotion of an approved investigation into a development session with shared
  workspace. API routes for all of it. Typed engine events for the future dashboard.
- **3b — PR discovery and lineage.** A `GhRunner` port (read-only `gh` calls) with a fake,
  review-session creation from a PR URL, the `PRDiscoveryStrategy` interface with the
  default policy reproducing today's filters, PR↔source-session linking, and a
  reconciliation tick (merged/closed/approved/new-commits → transitions or re-review).

Each gets its own implementation plan. 3a has no dependency on 3b; 3b depends on 3a's
schema additions and the review/re-review runners.

## 1. Scope

**In**
- Investigation pipeline as headless stage runs; plan gate; promotion to development;
  development stage run.
- Review and re-review stage runs with the legacy `REVIEW.md` contract, archive versioning,
  and diff-aware prompt.
- Failure recording for stage runs; retry; stop.
- Session creation use cases (`createInvestigationSession`, `createReviewSessionFromPr`).
- Shared-workspace ownership rules between an investigation and its promoted development
  session.
- `GhRunner` port, PR discovery strategy, lineage linking, reconciliation tick with an
  injectable clock (no wall-clock timers in tests).
- Typed `EngineEvents` emitter (state changes, run lifecycle) — the hook Phase 4's SSE needs.
- Prompt templates as a typed module with defaults that reproduce legacy text; the
  repo-specific bits (review skill command, live-UI-check paragraph, local URL) are template
  parameters with legacy defaults. Full per-repo typed config is Phase 5.

**Out (parked, with reason)**
- *Posting anything to GitHub from the engine* (`gh pr review --approve`, comments, merges).
  Ruling 2 below. The dev agent still runs `git push` / `gh pr create --draft` itself as
  legacy does; that is the agent's action inside its guard, not the engine's.
- *Own-PR tracking and reviewer-comment triage* (`--track-my-pr`, `--triage-comments`,
  `--reply-comment`, `--resolve-comment`, `--pr-threads`). Not in the parent spec §6–7;
  it is a distinct feature with its own GraphQL polling and mutation surface. Parked until
  after Phase 4.
- *`--run-local` / `--stop-local` and browser-test flows.* Phase 5. Briefs in Phase 3 omit
  those steps; the template has a slot Phase 5 fills.
- *A `cgremlin` CLI thin client.* Not needed under ruling 1; Phase 4/6 decide.
- *`CodexRunner`.* Phase 2b, blocked on `codex` auth (verified still broken 2026-09-04).

## 2. Rulings (made by the supervising session, recorded for override)

1. **Artifact-driven completion, not agent callbacks.** Legacy briefs tell the agent to
   run `cgremlin --plan-start/--plan-ready/--develop/--agent-state/--agent-note`
   (`write_investigate_brief`, bin/cgremlin:14162–14268). In the rebuild the engine runs
   each stage as a headless `claude -p` invocation, waits for exit, reads the session
   directory, and performs the transition itself. The agent never mutates state. Rationale:
   deterministic, fully testable with `FakeAgentRunner` + `InMemoryFileSystem`, no CLI
   client shipped inside the worktree, and it removes the class of bug where an agent
   skips or misorders a callback. Agent "notes" and "state" survive as plain files the
   brief tells the agent to write (`AGENT_NOTE`, `AGENT_STATE` in the session dir) that
   the engine surfaces read-only.
2. **Local-only side effects in Phase 3.** Read-only `gh` (`pr view`, `pr list`) is used by
   the engine. Any GitHub mutation from the engine is deferred to a later phase as an
   explicit user-triggered action with the legacy safety check.
3. **Own-PR comment triage deferred** (see Out).
4. **Failure is a phase only where the phase is an activity.** Review phases are activity
   states, so `REVIEW_PHASES` gains `failed` (`reviewing → failed`, `failed → reviewing`
   for retry, `failed → dismissed`). Investigation and development phases are artifact
   milestones, so a failed run there leaves `stageStatus` unchanged and is recorded in
   `lastRun`. Also add `ready → reviewing` so a PR updated before the human acts can be
   re-reviewed (legacy re-reviews on any new `headRefOid`).
5. **Promotion creates a new development session that inherits the workspace.** Legacy
   flips `mode` in place (`develop_start`, bin/cgremlin:14501). The new schema makes
   `promoted_to_development` terminal, so promotion creates a development session with the
   same `pipelineId`, `parentSessionId` = investigation id, same `ticket`, and the same
   `workspace` (worktree + branch). Workspace removal refuses while any other
   non-terminal session references the same `worktreePath`.
6. **Brief goes in the session directory, not the worktree.** Legacy wrote `CLAUDE.md`
   into the session dir with the repo at `./repo/`. Worktrees are the cwd now, so the
   brief is `<sessionDir>/BRIEF.md`, passed via `--add-dir <sessionDir>` (verified flag),
   and the prompt tells the agent to read it. The worktree stays clean of engine files
   except `.claude/settings.local.json` (already the Phase 1b convention).
7. **Multi-turn within a stage sequence uses `--resume`.** Investigation's findings →
   plan steps run as successive `sendPrompt` calls on one handle so the planning turn
   keeps the investigation context. `ClaudeCodeRunner` already captures `session_id` and
   resumes; the id is persisted on the session (`agent.resumeId`) so a restarted engine
   can continue.

## 3. Schema changes (schemaVersion 1 → 2)

Additions to the base object (all optional-or-nullable so v1 documents migrate with a
pure function `migrateV1ToV2`):

```ts
agent: { runner: 'claude-code' | 'codex'; resumeId: string | null } | null
lastRun: {
  stage: StageName; startedAt: string; finishedAt: string | null;
  exitCode: number | null; signal: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'stopped'; error: string | null
} | null
pr: { repo: string; number: number; url: string; headSha: string | null;
      reviewedSha: string | null; title: string | null; author: string | null } | null
```

Mode-specific additions:
- investigation: `intent: 'investigate_only' | 'development'`,
  `driveToCompletion: boolean` (legacy `plan_review.drive_to_completion`).
- review: `reviewVersion: number` (count of archived `REVIEW-v*.md`, computed by the
  engine and stored for display; files remain the source of truth for the next number).

`StageName = 'findings' | 'plan' | 'develop' | 'review' | 'rereview'`.

Transition table changes: review gains `failed` (ruling 4) and `ready → reviewing`;
investigation gains the direct edge `plan_ready → promoted_to_development`, taken only
when `PlanGate.canPromote` holds via `driveToCompletion` (amended 2026-09-04 during 3a
Task 8: the table originally lacked this edge and an implementation synthesized a
`plan_ready → approved` hop nobody took; the audit trail must never show an approval
that did not happen — legacy drive-to-completion likewise skipped `--approve-plan`).
Amended 2026-09-04 during 3b Task 6 review — GitHub facts apply regardless of local phase
(legacy applied them unconditionally): review `queued → approved | dismissed`,
`changes_requested → approved`, `failed → approved`; development `active → merged` (3a
records no `pr_opened`, so a merged PR must still terminate its development session).
No other table changes.

## 4. Components (3a)

### 4.1 `PromptTemplates` (`src/pipeline/prompts.ts`)
Pure functions `renderFindingsBrief`, `renderPlanBrief`, `renderDevelopBrief`,
`renderReviewPrompt`, `renderRereviewPrompt`, each taking a typed params object and
returning a string. Legacy text is the default (review prompt bin/cgremlin:14557,
re-review prompt :14727, investigate brief :14169–14268, develop brief :14330–14420),
with the `cgremlin --…` callback lines replaced by "write `<sessionDir>/AGENT_NOTE`" /
"write `<sessionDir>/AGENT_STATE`" instructions and the `--run-local` steps removed.
Template parameters: `sessionDir`, `ticket`, `intent`, `reviewSkillCommand`
(default `/APFM:apfm-review`), `includeLiveUiCheck` (default true), `prNumber`,
`commitCount`, `newCommitsText`, `changesSince`.

### 4.2 `ArtifactEvaluators` (`src/pipeline/artifacts.ts`)
Pure functions over `SessionFileSystem` reads:
- `evaluateFindings(sessionDir)` → `{ hasFindings }` (FINDINGS.md exists and non-empty).
- `evaluatePlan(sessionDir)` → `{ hasPlan, reviewStatus: 'approved' | 'unresolved' | 'missing' }`
  by locating `## Review Status` with both `✅` lines, or `## Unresolved Review Disagreement`.
- `evaluateReview(exit, sessionDir)` → `'ready' | 'failed'` (legacy: `rc == 0 && -s REVIEW.md`).
- `evaluateRereview(exit, sessionDir)` → same plus parsed `rereview_summary`
  (`✅ N/N resolved` | `⚠️ K/N resolved, M new`) returned as data, not a transition.
- `nextReviewVersion(sessionDir)` → smallest N with no `REVIEW-vN.md` (legacy loop :14668).

### 4.3 `PlanGate` (`src/pipeline/plan-gate.ts`)
`canPromote(session): boolean` = `stageStatus === 'approved' || (driveToCompletion &&
stageStatus === 'plan_ready')`. Single rule, exported, used by `promote()`. No `--force`
equivalent (legacy had one; the API can call `transition` explicitly if a human insists).

### 4.4 `StageRunner` (`src/pipeline/stage-runner.ts`)
Owns "run one agent turn for one session":
1. Write brief/guard (`writePermissionSettings` with the revised per-mode config; the
   investigation/development allow-lists drop the dead `cgremlin --…` entries and become
   `{}` for investigation, a small deny-list for development matching legacy's "only via
   helpers" intent: deny `gh pr review`, `gh pr comment`, `gh pr merge`, `gh pr close`).
2. Record `lastRun = running`, emit `run.started`.
3. `runner.start(ctx)` (or reuse handle if `agent.resumeId` set), `sendPrompt`.
4. On exit, evaluate artifacts, transition via `SessionStore.transition`, record
   `lastRun`, persist `agent.resumeId`, emit `run.finished` / `session.transitioned`.
5. One active run per session (in-memory map); `stop(sessionId)` calls `runner.stop`,
   records `outcome: 'stopped'`.

`ClaudeCodeRunner` gains `additionalDirs?: string[]` → `--add-dir` (ruling 6). The
`SessionContext` gains `additionalDirs?: readonly string[]` so the runner interface stays
adapter-agnostic.

### 4.5 `PipelineService` (`src/pipeline/pipeline-service.ts`)
Use cases, each a method taking a session id and returning the updated session:
- `createInvestigationSession({ repoUrl, ticket, intent, driveToCompletion, baseRef })`:
  id `inv-<repo>-<ticket>-<timestamp>`, workspace via `WorkspaceManager` (branch
  `investigate/<ticket>`), session saved at `findings`.
- `runFindings(id)`: stage `findings`; on success and `intent === 'development'` chains
  `runPlan` (legacy auto-continue); else stops at `findings` with `hasFindings` surfaced.
- `runPlan(id)`: `findings → planning` before the run; after: `approved` review status →
  `plan_ready`; `unresolved` → stay `planning`, `lastRun.error = 'unresolved review
  disagreement'`, `AGENT_STATE` shows `needs-input`; missing → failed run.
  If `driveToCompletion` and `plan_ready`, chains `promote`.
- `approvePlan(id)`: `plan_ready → approved` (human action).
- `promote(id)`: `PlanGate.canPromote` else `PlanGateError` (→ 409). Transition
  investigation to `promoted_to_development`; create development session (ruling 5) at
  `active`; run `develop` stage.
- `runDevelop(id)`: stage `develop`; no transition on success (PR detection is 3b; the API
  exposes `transition` to `pr_opened` for now).
- `runReview(id)`: `queued|changes_requested|ready → reviewing`; on exit `ready` or `failed`.
- `runRereview(id)`: archive `REVIEW.md → REVIEW-vN.md`, fetch `pull/N/head` into the
  worktree and hard-reset it (GitRunner, cwd = worktree), compute `old..new` log and
  diffstat, set `pr.reviewedSha`, `reviewVersion`, prompt via `renderRereviewPrompt`,
  then same as `runReview`.
- `stop(id)`, `retry(id)` (re-runs `lastRun.stage`).

### 4.6 `EngineEvents` (`src/engine/events.ts`)
Typed emitter: `session.created`, `session.transitioned`, `run.started`, `run.finished`,
each carrying the session snapshot. In-process only in Phase 3.

### 4.7 API additions (`src/api/server.ts`)
- `POST /sessions/investigations` → `createInvestigationSession`.
- `POST /sessions/:id/run` body `{ stage }` → the matching `run*` method.
- `POST /sessions/:id/approve-plan`, `POST /sessions/:id/promote`,
  `POST /sessions/:id/rereview`, `POST /sessions/:id/stop`, `POST /sessions/:id/retry`.
- `GET /sessions/:id/artifacts/:name` for `FINDINGS.md`, `PLAN.md`, `DEVELOPMENT.md`,
  `REVIEW.md`, `REVIEW-vN.md`, `AGENT_NOTE`, `AGENT_STATE` (allow-list, no traversal).
- `DELETE /workspaces` gains the shared-workspace refusal (ruling 5) → 409.
- All per-session routes go through the existing `KeyedLock`.
- Error mapping: `PlanGateError`, `RunInProgressError`, `WorkspaceInUseError` → 409;
  `ArtifactNotFoundError` → 404.

## 5. Components (3b)

- `GhRunner` port (`run(args, {cwd}) → {stdout, stderr}`), `NodeGhRunner`, `FakeGhRunner`
  with canned JSON. Only read subcommands are ever invoked by the engine; the fake rejects
  any argv containing `review`, `comment`, `merge`, `close`, `edit`, `create`, or
  `--method` so a test proves the engine never mutates.
- `parsePrUrl(url) → { owner, repo, number }`.
- `createReviewSessionFromPr({ prUrl })`: `gh pr view --json number,title,author,
  headRefName,headRefOid,baseRefName,url` first (legacy order, for instant visibility),
  then workspace with branch `pr-<N>` from `refs/pull/<N>/head` — `ensureMirror` gains a
  second fetch refspec `+refs/pull/*/head:refs/remotes/origin/pr/*` so worktrees can be
  based on PR heads; then `linkPrToSource`; session at `queued`.
- `PRDiscoveryStrategy { poll(config): Promise<CandidatePR[]> }` and
  `DefaultPRDiscoveryStrategy`: `gh pr list --repo R --state open --limit 50 --json
  number,url,author,isDraft,reviewDecision,headRefOid`; filters: drop
  `reviewDecision === 'APPROVED'`, author in `watchAuthors` (case-insensitive), drop
  drafts unless author is `me`, drop PRs that already have a review session for the same
  repo+number. `me` PRs are reported with `kind: 'own'` and ignored by the tick in Phase 3
  (ruling 3).
- `linkPrToSource(prSession, allSessions)`: pass 1 same repo + `pr.number`; pass 2
  `lineage.ticket`; on match inherit `pipelineId`, set `parentSessionId`, `ticket`, and
  transition the source development session `pr_opened → superseded`.
- `ReconciliationTick`: for each review session, `gh pr view` → merged: source
  `→ merged`, review `→ dismissed`; closed: source `→ abandoned`, review `→ dismissed`;
  `reviewDecision === 'APPROVED'`: review `→ approved`; `headRefOid !== pr.reviewedSha`
  and phase in `{ready, changes_requested}`: `runRereview`. Then `poll()` and
  `createReviewSessionFromPr` for each new `kind: 'review'` candidate.
- `DiscoveryScheduler`: `start()/stop()` around an injected `setInterval`-like clock,
  default 60s (legacy), never overlapping ticks.
- API: `POST /discovery/tick` (manual), `GET /discovery/config`.

## 6. Testing

- All 3a logic tested with `FakeAgentRunner`, `InMemoryFileSystem`, `FakeGitRunner`;
  no subprocess. Every transition the evaluators can produce has a test; every illegal
  path (promote without approval, run while running, remove shared workspace) has a test
  asserting the error class.
- Mutation checks the plan must include (the "prove the test can fail" discipline):
  removing the `canPromote` check must fail a test; making `evaluateReview` ignore exit
  code must fail a test; removing the shared-workspace refusal must fail a test; the
  `FakeGhRunner` mutation guard must trip if any engine path issues a write subcommand.
- `ClaudeCodeRunner` `--add-dir` argv pinned by an exact-argv test against the existing
  fixture CLI.
- Live smoke (manual, supervisor-run before merge): one real `runReview` against a small
  public PR in a scratch repo with `reviewSkillCommand` pointed at a no-op, asserting
  `REVIEW.md` non-empty and phase `ready`.

## 7. Migration and compatibility

- `migrateV1ToV2` is pure, idempotent, and covered by round-trip tests; `parseSession`
  accepts both versions and returns v2.
- `LegacySessionMigrator` maps `plan_review.drive_to_completion → driveToCompletion`,
  `intent`, `pr.number/url`, `reviewed_sha → pr.reviewedSha`.

## 8. Roadmap addition proposed by the user (2026-09-04): a supervising agent

The user asked for a cgremlin "supervising agent": one agent session that has visibility
into every in-progress session, that the user can talk to directly (or bypass and talk to
the working agent), and that dispatches work to working agents and supervises them for
staying on track and making good decisions — the role the human-driven supervising session
plays during this rebuild.

Ruling: record as a new phase **after Phase 4 (dashboard)**, before Phase 5, with its own
brainstorming pass. Reasons: (a) it is a *client* of the Phase 3 engine API plus the Phase 4
event stream, so it needs both to exist first; (b) it introduces a second agent-runner shape
(long-lived interactive sessions that can be messaged, alongside today's headless runs),
which is a real design fork the parent spec's §5 did not anticipate; (c) it is outside the
parent spec's non-goal "no new agent capabilities", so it is a roadmap decision the user
owns, not a scope expansion to slip into Phase 3. Nothing in Phase 3 should preclude it:
every state change goes through the API, every artifact is readable through the API, and
`AgentRunner` stays adapter-agnostic.
