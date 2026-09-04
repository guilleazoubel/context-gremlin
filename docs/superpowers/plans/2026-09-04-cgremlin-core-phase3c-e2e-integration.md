# cgremlin/core Phase 3c: End-to-End Integration Test (real fs, real git, fake agent) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One integration test that drives the merged Phase 3 engine through its real HTTP-over-Unix-socket API against a temp sessions dir, a temp mirrors/worktrees dir, a real local bare git repo as "origin", `NodeFileSystem`, `NodeGitRunner`, and `FakeAgentRunner` — from `POST /sessions/investigations` through findings → plan → approve → promote → develop, plus a review session created from a fake `gh` view and driven to `ready`, with artifacts read back over the API. This is the spec §10 "API layer: integration tests against the real local API server, operating on a temp sessions directory" tier, which so far exists only with `InMemoryFileSystem`/`FakeGitRunner`.

**Architecture:** A single vitest file `test/e2e/pipeline.e2e.test.ts` (own `describe`, ~60 s timeout) that builds the full production wiring except the agent and gh adapters: real `NodeFileSystem`, real `NodeGitRunner`, real `WorkspaceManager`, real `SessionStore`, real `StageRunner`/`PipelineService`/`ReviewSessionFactory`/`ReconciliationTick`, `createApiServer` + `listenOnSocket` on a temp socket path; `FakeAgentRunner` plays the agent (the test writes the artifacts an agent would), `FakeGhRunner` plays gh (queued from the real fixtures in `test/fixtures/gh/`). No network, no real `claude`/`codex`/`gh`.

**Tech Stack:** vitest, `node:fs/promises`, `node:child_process` (via NodeGitRunner), `node:http` over a Unix socket.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-04-cgremlin-core-phase3-pipelines-design.md` §6 (Testing), parent spec §10.

## Global Constraints

- Node 24, pnpm 10.10.0, commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint` green at every commit.
- No real agent CLI, no `gh`, no network. Real `git` only (like `test/workspace/repo-mirror-worktree.integration.test.ts`; skip the suite if `git` is missing, using that file's pattern).
- All temp state under one `mkdtemp` root removed in `afterAll`; the socket path must be short (macOS 104-byte limit) — use `path.join(os.tmpdir(), 'cg-e2e-<rand>.sock')`.
- The test may not modify any `src/` file. If it exposes a real engine bug, STOP and report it to the supervisor with the failing assertion instead of patching around it.
- Branch `phase3c-e2e` off `mission-control-pr-orchestrator`; supervisor merges.

## File Structure

- `test/e2e/pipeline.e2e.test.ts` — the test
- `test/support/e2e-harness.ts` — wiring helpers: `createOriginRepo(root)` (bare repo with one commit on `main` and a `refs/pull/12/head` ref pointing at a second commit on a branch), `startEngine(root, fakes)` (returns `{ socketPath, request(method, path, body), runner, gh, events, close() }`), `finishRun(runner, files, exit)` (write artifact files into the session dir on the REAL fs, then `emitExit` on `runner.lastHandle()`), `waitFor(predicate, timeoutMs)` polling `GET /sessions/:id`.

---

### Task 1: e2e harness and the investigation → development flow

**Files:**
- Create: `test/support/e2e-harness.ts`, `test/e2e/pipeline.e2e.test.ts`

**Interfaces:** as listed under File Structure. `createOriginRepo` must produce a repo URL usable by `ensureMirror` (an absolute filesystem path to a bare repo is a valid git URL) with `main` as the default branch; `defaultBaseRef` in `PipelineConfig` is `'origin/main'`.

- [ ] **Step 1: Write the failing test** (`describe.skipIf(!hasGit())`):
  1. `POST /sessions/investigations { repoUrl: <origin path>, ticket: 'APP-1', intent: 'development', driveToCompletion: true }` → 201; assert on disk: `<worktrees>/<id>` is a git worktree on branch `investigate/APP-1` (`git rev-parse --abbrev-ref HEAD` there), `<sessions>/<id>/session.json` parses as v2 at `findings`, `.claude/settings.local.json` in the worktree equals `{"permissions": {}}`.
  2. `POST /sessions/<id>/run { stage: 'findings' }` → 202 with `lastRun.outcome 'running'`; assert `<sessions>/<id>/BRIEF.md` exists on disk and contains `FINDINGS.md`; assert `runner.getContext(runner.lastHandle())` has `workingDirectory === <worktrees>/<id>` and `additionalDirs === [<sessions>/<id>]`.
  3. `finishRun(runner, { 'FINDINGS.md': '# Findings\nroot cause' }, { code: 0, signal: null })`; `waitFor` phase `planning` and a NEW handle whose BRIEF.md contains `## Review Status` (the chained plan turn); assert that handle's `ctx.resumeId` equals the resume id you set on the first handle via `runner.setResumeId` before emitting exit.
  4. `finishRun(runner, { 'PLAN.md': '## Review Status\n- PM: ✅ Approved — a\n- Principal Engineer: ✅ Approved — b\n\n# Plan\n' }, { code: 0, signal: null })`; `waitFor` the investigation at `promoted_to_development`; `GET /sessions` → exactly one development session with `lineage.parentSessionId === <inv id>`, same `workspace.worktreePath`, at `active`, with `lastRun.outcome 'running'`; on disk `<sessions>/<dev>/PLAN.md` and `FINDINGS.md` exist (copied); `GET /sessions/<dev>/artifacts/PLAN.md` → 200 text containing `Review Status`.
  5. `DELETE /workspaces { repoUrl, worktreePath, branchName: 'investigate/APP-1' }` → 409 (development session still active); `finishRun(runner, {}, { code: 0, signal: null })` for the develop turn; `POST /sessions/<dev>/transition { to: 'abandoned' }` → 200; `DELETE /workspaces …` → 204; assert the worktree directory is gone and `git worktree list` in the mirror no longer lists it.
  6. Events: subscribe before step 1 to `session.created`, `session.transitioned`, `run.started`, `run.finished` and assert the exact ordered list of `(type, sessionId, to?)` for the whole flow — this is the sequence Phase 4's live view will render, so pin it.
- [ ] **Step 2: RED** — harness module not found.
- [ ] **Step 3: Implement** the harness (wiring mirrors `test/support/pipeline-harness.ts` but with `NodeFileSystem`/`NodeGitRunner`, real dirs, `createApiServer({ sessionStore, workspaceManager, pipeline, fs, sessionsDir, events, lock })`, `listenOnSocket`). Give `createOriginRepo` a `git init --bare`, then a temp clone to commit `README.md` on `main` and push, then a branch `feature/APP-12` with a second commit pushed to `refs/pull/12/head` (`git push origin HEAD:refs/pull/12/head`).
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`. Record the wall time of the e2e file; if > 20 s, report it.
- [ ] **Step 5: Commit** — `git commit -m "test(cgremlin-core): end-to-end investigation→development flow over the real API with real fs/git and a fake agent"`

---

### Task 2: review session from a PR, review run, re-review, reconciliation tick

**Files:**
- Modify: `test/e2e/pipeline.e2e.test.ts`, `test/support/e2e-harness.ts`

- [ ] **Step 1: Write the failing test** (second `describe` in the same file, fresh engine):
  1. Queue on `FakeGhRunner` a `pr view` response built from `test/fixtures/gh/pr-view-open-approved.json` with `number` 12, `headRefName 'feature/APP-12'`, `headRefOid` = the real sha of `refs/pull/12/head` in the origin repo, `reviewDecision ''`, `state 'OPEN'`, `url` `https://github.com/acme/app/pull/12`. Call `ReviewSessionFactory.createFromPrUrl('https://github.com/acme/app/pull/12')` directly (there is no HTTP route for it yet — note that in the report) BUT with the factory's `repoUrl` derivation overridden: the harness passes a `repoUrlFor(slug)` option → this REQUIRES a small production change? NO — check `review-session-factory.ts`: it builds `https://github.com/<slug>.git`. That cannot resolve offline. Ruling: the harness pre-creates the mirror at `<mirrors>/<mirrorDirName('https://github.com/acme/app.git')>` by cloning the local origin bare repo with `git clone --bare <origin> <that path>` and setting `remote.origin.url` to the local origin path, so `ensureMirror` finds a valid mirror and its `fetch --prune origin` hits the local origin. Assert the review session: `queued`, `pr.number 12`, `pr.headSha` = real sha, `lineage.ticket 'APP-12'` (derived from the branch), worktree on branch `pr-12` whose HEAD sha equals `refs/pull/12/head`.
  2. `POST /sessions/<rev>/run { stage: 'review' }` → 202, phase `reviewing`; `runner.getPrompts(lastHandle)[0]` contains `Write the output to <sessions>/<rev>/REVIEW.md`; `finishRun(runner, { 'REVIEW.md': '# PR Review' }, ok)`; `waitFor` `ready`; `pr.reviewedSha` equals the head sha.
  3. Push a third commit to `refs/pull/12/head` in the origin (harness helper `pushPrCommit(origin, 12)` returning the new sha). Queue a `pr view` with the new `headRefOid`. Run one `ReconciliationTick` (construct it with the harness's lock/events/pipeline/factory/strategy and a `DiscoveryConfig` with `repos: ['acme/app']`; queue an empty `pr list` `[]` for the poll) → `report.actions` contains a `rereview` for `<rev>`; `waitFor` `reviewing`; on disk `REVIEW-v1.md` equals `'# PR Review'`, `RE-REVIEW.md` names both shas; the worktree HEAD now equals the new sha; `finishRun(runner, { 'REVIEW.md': '# PR Review v2', rereview_summary: '✅ 1/1 resolved' }, ok)` → `waitFor` `ready`, `reviewVersion 1`, `lastRereviewSummary { resolved: 1, total: 1, newFindings: 0 }`, `pr.reviewedSha` = new sha.
  4. Queue a `pr view` with `state 'MERGED'`, `mergedAt` set; run the tick → review `dismissed`; `GET /sessions/<rev>/artifacts/REVIEW-v1.md` → 200.
  5. Mutation-style assertion: throughout, `gh.calls` contains only `pr view`/`pr list` argv (assert every call's `[0..1]` is `['pr','view']` or `['pr','list']`).
- [ ] **Step 2: RED.** **Step 3: Implement** harness additions. **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "test(cgremlin-core): end-to-end review/re-review/reconciliation flow over real fs/git with fake gh and agent"`

---

## Definition of Done

- Both e2e describes pass with real `git` and skip cleanly without it; total added wall time reported; `pnpm test && pnpm typecheck && pnpm lint` green.
- No `src/` change. Any engine defect found is reported to the supervisor as a failing assertion (that is a success of this phase, not a failure).
- The pinned event sequence from Task 1 step 6 is present as an exact-array assertion.
