# cgremlin: WORKPLAN sessions — one session, one plan, many phases, one PR each — design spec (rev 2)

**Goal.** A piece of work (a Jira ticket **or an epic**) becomes **one session** that holds the whole plan. In **one
interactive planning chat** I get grilled until we agree, and the plan comes out as a list of **phases** (vertical
slices). Each phase is executed as its own **draft PR**, one at a time or all in a row, AFK or with me watching. I talk
to the session through **one chat**. Its lead agent reads the live state and reports back, and it proposes changes that
I commit with a click. Nothing is called done because an agent says so: a script checks it, a fresh reviewer checks it,
and the live check signs off to me with evidence. **I** mark PRs ready and merge.

**Why.** Session history (Jan–Sep 2026, ~8.2k typed prompts):
- ~190 "still broken" corrections after "fixed/verified" claims
- ~104 turns of explanations that did not land
- 72 "don't commit/push until I review"
- corrections rise from 7% (prompts 1–10) to ~13% (after prompt 30)
- today: one plan → one develop session → one PR, with no slicing

The answer is shaped by Matt Pocock's workflow (grill → spec → tracer-bullet tickets → AFK loop with TDD →
fresh-context review → human QA) and by the skill-quality research (runnable checks over "double-check" prose, small
focused skills, the Rule of Two).

**Rev 2** folds in three fresh-context reviews (feasibility against the code, an adversarial design review, and Claude
Code facts). The changes are listed in §16.

**Out of scope for v1** (§14): parallel phases, auto-merge, Jira writes, a Docker sandbox, live checks turned into e2e
tests, `retro`. `bin/cgremlin` and the existing investigation → development flow are untouched.

## §0 Ground truth (verified by the feasibility review)
| Fact | Where |
|---|---|
| 5 modes, discriminated on `mode`; new modes are **appended** (R51, R68) | `core/src/schema/session-mode.ts:17-23` |
| Phase enums at 3-57, transition tables at 72-139. `PhaseFor<M>` (62-70) **falls through to `ReviewPhase`**, so a new mode must extend it or it type-checks wrong | `core/src/schema/pipeline.ts` |
| 7 stage names, appended-only (R56). **`plan` is already a stage name**, so the new mode cannot be called `plan` | `core/src/schema/stage.ts:11-19` |
| A V2 session carries **one** `workspace` and **one** `pr` | `core/src/schema/session.ts:57-66` |
| `promote` (592-656) creates a child `development` session that **reuses the parent's worktree** (no new branch). `createDevelopmentSession` hardcodes `feature/${ticket}` and `parentSessionId: null` | `pipeline/pipeline-service.ts:592-656`, `:367-443` |
| `runStageLocked` holds the per-session lock **only until `run.started`** | `pipeline-service.ts:257-271` |
| **`StageRunner.run` always seeds `--resume` from `session.agent.resumeId`**, so every run today continues the prior conversation. `BRIEF.md` is fixed at `${sessionDir}/BRIEF.md` | `pipeline/stage-runner.ts:245,257,278` |
| **Development sessions never get `pr` set and never reach `pr_opened`.** `PR_URL` is written by the agent and read by nobody. Merged is reached only through a linked review session | `reconciliation.ts:147` |
| The runner launches `claude -p … --permission-mode bypassPermissions`; **only `deny` bites** | `agent/claude-code-runner.ts:40-80`, `workspace/permission-guard.ts:1-60` |
| **The `development` profile denies only `NEVER_POST` plus `gh pr merge`/`close`**. `gh pr ready`, `gh pr edit`, `gh api` and force-push are **allowed**. The full list applies to `investigation:development` and `respond` only. Profiles are chosen **per session, not per stage** | `permission-guard.ts:230-244` |
| `refreshWorkspaceGuardrails` **overwrites** `.claude/settings.local.json` on every run, so hooks must be rendered by `renderPermissionSettings` | `permission-guard.ts` |
| **Decisions this spec amends:** "the engine never posts to GitHub"; "artifact-driven completion, not agent callbacks … any GitHub mutation is a later, explicit, user-triggered action". Precedent for such an action: the human approve verb scoped to the reviewed PR | `core/docs/DECISIONS.md:25,34-40`, commit `1461d3a` |
| Work-item grouping is ticket → PR → session. **Lineage is ignored**, so for an epic every child key would become its own row | `work/work-item.ts:457-501` |
| Engine API routes 941-1445; SSE `GET /events` :981; the CLI has serve, prs, review, sessions, scan, config, local, release | `api/server.ts`, `cli/main.ts` |
| Jira is read-only: `search(jql)`, `issue(key)`, `whoami()`. An unknown field in JQL returns 400 → `JiraUnavailableError` | `jira/jira-rest-source.ts:218,280,316` |
| The artifact allowlist rejects new names and nested paths; the Item tab CSP is `img-src 'none'` | `api/validation.ts:107`, `vscode/src/ui/item-tab.ts:46` |
| `previewUrlFor` works for any session **that has a `pr`**. `previewStages` / `localApp.stages` are `StageName[]`. The Vercel bot comment carries **no commit sha**, while `statusCheckRollup` does | `env/environment-service.ts` |
| Chat = a terminal running `claude --resume '<id>'`. A run in flight refuses chat and offers Watch. Claim/release exists | `vscode/src/model/chat-command.ts:33` |
| Claude Code: path deny rules (`Edit(//abs/**)`) hold under bypassPermissions; a PreToolUse hook may return `ask` (in `-p`, `ask` blocks); slash commands expand in `-p`; `--fork-session` does **not** work with `-p`; individual plugin skills cannot be disabled | code.claude.com docs (permissions, hooks, sessions, plugins, skills) |
| grace-frontend `main` ruleset: **squash only**, 1 approval, **dismiss stale reviews on push**, 11 required checks (Lint & Format, Build Storybook, Portal type-check & tests, Workspace tests, Unit Tests, sonarqube, Portal Playwright Smoke, Visual Regression, wait-for-preview ×2, Preview E2E & Visual). It targets **main only**, so stacked PRs (base ≠ main) aren't gated until retargeted. `delete_branch_on_merge: true` → GitHub retargets children to main after a merge | `gh api repos/aplaceformom/grace-frontend{,/rulesets/7254057}` |
| grace-frontend CI `pull-request.yml` runs on **every** PR whatever its base, **drafts included** (no draft filter); Slack PR notify **skips drafts** (fires on ready_for_review) | `.github/workflows/pull-request.yml`, `slack-pr-notify.yml:5,10` |
| The **agentic PR review** (`apfm-agentic-review`) runs on opened / ready_for_review / synchronize for **non-draft** PRs only. An **auto-approve** job follows a successful review (low-risk → approve, often auto-merge). Every push to an open PR re-triggers it | `.github/workflows/agentic-review.yaml:3-24` |

## §1 Rulings (binding unless marked PENDING)
| # | Ruling | Why |
|---|---|---|
| **R86** | **Vocabulary.** *Session* = one plan for one ticket or one epic. The session's steps are **Plan → Execute → Done**. A *phase* is one vertical slice and becomes **one PR**. A *run* is one fresh `claude -p` process, which is plumbing. | Agreed in conversation. |
| **R87** | A sixth mode, **`workplan`**, is appended, with `WORKPLAN_STEPS = ['planning','plan_ready','executing','done','abandoned']`. `PhaseFor`, `TERMINAL_PHASES_BY_MODE`, `DEFAULT_PERMISSIONS` and every per-mode site are extended. **Each phase is a child `development` session** created by a new `createPhaseSession(parent, phase)`: its own worktree, an explicit branch `<type>/<KEY>-<slug>-<nn>` (R117), an explicit `baseRef`, `lineage.parentSessionId` = the workplan, and the same `pipelineId`. | Reuses develop. `plan` is taken as a stage name. `promote` shares the worktree, so it can't be reused. |
| **R88** | **Planning is one interactive chat**, not separate AFK steps. It runs `/mattpocock-skills:grilling`, and fact-finding goes to subagents per the skill. When we agree, it runs `/mattpocock-skills:to-spec` → `SPEC.md`, then `/mattpocock-skills:to-tickets` → `phases/*.md`, each confirmed with me as those skills require. For a bug, `diagnosing-bugs` runs first → `FINDINGS.md`. The planning chat opens with a brief prepared **without a run** (the R73 `prepareQaSession` precedent), in a read-only worktree of the base. | The adversarial review showed that to-spec/to-tickets are interactive by contract and `disable-model-invocation`, so an "AFK slice" step can't exist. This merge also drops DECISIONS.md and three steps. |
| **R89** | **One loop per phase:** ① run → ② **gate** (a script) → ③ fresh review → ④ advance. Failures write `FEEDBACK.md` and start a **new round in a fresh run**. **One budget per phase: 6 runs total** across gate fixes, review fixes and live-check fixes. When it's spent, the phase is `needs_input`. | Replaces three separate caps that summed to 7 while claiming 3. |
| **R90** | **Fresh means fresh.** `StageRunInput` gains `fresh: boolean`. Every phase round runs with `fresh: true` (no `--resume`). `BRIEF.md`/`FEEDBACK.md` are archived per round (the `REVIEW-vN` precedent). Only Take over and the lead chat resume. | Today every run resumes, so a "fresh reviewer" would inherit the implementer's context. |
| **R91** | **PR tracking for development sessions.** After a run, the engine reads `PR_URL` or runs `gh pr list --head <branch>` → `session.pr`, and the phase moves to `pr_opened`. Development joins PR-bearing reconciliation (merged/closed). `runDevelop` is allowed from `pr_opened` for fix rounds. | Preview URLs, restack, merged/done and the board all need this, and it doesn't exist. |
| **R92** | **A stage-aware guard profile `development:phase`.** It keeps `NEVER_POST`, `NEVER_ADMINISTER`, `GH_API_DENY` and `NEVER_FORCE_PUSH`, and denies `gh pr merge/close/edit/ready`. It allows `git commit`, `git push` of its own branch and `gh pr create --draft` (the engine re-checks `isDraft`). **`phase_review` and `live_check` runs additionally deny `git commit`/`git push`.** Every phase run denies `Edit`/`Write` on `//<workplanDir>/**`. `PermissionSubject` gains a `stage`. | The current development profile allows ready, edit, api and force-push, and a review run in a dev worktree could push. |
| **R93** | **Files live outside the repo.** Planning writes into `<workplanDir>`. A phase run gets a **snapshot** of its phase md copied into its own child session dir, hashed at run start (as promote copies PLAN.md). It gets no access to the workplan dir. Engine-local files in worktrees (`.claude/settings.local.json`, `.cgremlin/`, `.env.local`) are added to `.git/info/exclude`. | No changes to team repos, and a build agent can't widen its scope. Deny rules are advisory against Bash `sed -i`, so the hash catches edits. |
| **R94** | **Jira defaults to local-only.** A session links a **parent ticket or an epic, read-only**. Epic children are fetched with **two separate queries** (`parent = KEY`, then `"Epic Link" = KEY`). The import is a **checklist**: not Done, unassigned or mine, and I pick which children to include. Imported children become phases with `jira: KEY`; one too big for one run splits into local phases under the same key. Branches and PR titles carry the key. Before each phase runs, its issue is re-read, and changed ACs **pause the phase until I re-approve**. | Agreed in conversation. An unknown-field 400 fails an OR query, and a 30-child epic needs a filter. |
| **R95** | **One draft PR per phase, in one linear stack, in plan order** (or one stack per Jira, R115). Phase 1 branches from main; each later phase branches from the previous phase's branch. There's no depth limit. **Nothing is merged during Execute**: "we just keep going", and the whole stack stays draft until Ship (R111). | Answer to Q3. A single chain in topological order is the simplest model, and every phase builds on everything before it. |
| **R96** | **Restack (D1 resolved: yes).** *During Execute* (every PR draft, none approved), the engine restacks **automatically** after a lower phase changes, e.g. a fix round: `git rebase --onto <new parent tip> <recorded parent tip> <branch>`, then `git push --force-with-lease` on its own phase branches, then the children's gates run again. **The rule follows PR state, not the step (answer to Q14):** any PR that is **draft and not approved** restacks automatically at any time, including during Ship. Restacking or syncing an **open or approved** PR is **my click**, with an approval-dismissal warning. On conflict: stop, `needs_input`, offer Take over. This amends DECISIONS.md:25/40 for these git writes. | Answer to Q4: commit, push and draft PRs are routine. Automatic is safe while nothing is approved yet. |
| **R111** | **Integration check = "done with this work".** When the last phase passes, the engine runs the **entire AC list** (every phase's ACs plus the parent ticket's or epic's ACs) **locally on the top of the stack**, which contains every change (R100), and writes `WORKPLAN-SIGNOFF.md` under the R101 evidence rules. Pass → step `verified`. Fail → the failing AC maps to its phase, which gets a fix round; the stack restacks and the integration check runs again. | Answer to Q3: "test the last PR for the entire AC list, which tells us we are done." |
| **R113** | **A phase is done when it *could* be opened for review right now** (answer to Q11): local gate ✓, fresh review ✓, its own live check ✓ (Q10), **the repo's CI green on its draft PR**, and **every comment on it handled**. The next phase starts only after that. **On my own PRs** (phase PRs), cgremlin checks each bot or human comment, verifies it, then **fixes it if it's in scope or replies** with the reason, and **resolves the thread**, all automatically (answer to Q13; respond's own-PR precedent). A red CI or a new comment is a fix round on that phase (R99). | "We move on once we are fully done." |
| **R114** | **Ship modes, chosen at Ship time** (answers to Q9/Q15/Q16). When the stack is `verified`, the engine also prepares a **combined draft PR**: branch `<type>/<KEY>-<slug>` (R117) = the top-of-stack tip, base main, a body listing every phase, kept in sync on every restack. I look at both and choose. **One at a time:** open the bottom phase PR for review (rest stay draft); after it merges, restack; open the next. **All at once:** open the combined PR; the phase PRs are closed with a link to it. The unchosen option is closed. **Auto-merge is the repo's CI**, not cgremlin: the agentic review on a non-draft PR auto-approves and often auto-merges low-risk PRs, and riskier ones wait for a human. cgremlin just follows the result (merged → restack → next). | "Many PRs one at a time, or one PR. I look at the complexity and decide." |
| **R115** | **Epic build mode, chosen when the session starts** (answer to Q12). **All at once:** one linear stack for the whole epic (R95). **One Jira at a time:** the whole epic is **planned up front**, with phases grouped by child Jira (Q17), and executed as one stack per child Jira, in order. The next child's stack starts from main **after the previous one merges**, and its phases are **re-checked against the merged code** just before it starts. Integration checks (R111) run per child stack, and once more for the epic ACs at the end. | Matches how the work will ship. |
| **R116** | **Model routing per stage, as config, not code** (§17). `core.json` gains `routing.<stage> = { runner: claude-code\|codex, model, effort, escalate?, secondOpinion? }`, replacing the single engine-wide `runner`/`runnerOptions.model` (`core-config.ts:138`). The Claude runner passes `--model` **and `--effort`**, and the orchestrator unsets `CLAUDE_CODE_EFFORT_LEVEL`. The Codex runner passes `-m` and `-c model_reasoning_effort=…`. **Codex in v1 is report-only**: review, verification and integration second judge, in a `read-only` sandbox, never editing. (Its `workspace-write` makes `.git` read-only, and the evidence shows Codex rewriting correct Claude code.) **Escalation follows the run's progress**, not the task text: fix round 2 raises effort or adds `--advisor fable`, round 3+ switches family or goes to Fable. Every run records `{stage, runner, model, effort, tokens, cost, outcome}`, so routing is tuned by **cost per completed phase**. | Anthropic and OpenAI both say to measure effort per workload. Cross-model review helps only when report-only and verified (arXiv 2607.21656), errors are correlated (2506.07962), and progress-based escalation beats upfront routing (2607.00053). |
| **R117** | **Branch names follow the team convention.** The type comes from the Jira issue type: Bug → `fix/`, everything else → `feature/`. Phase branch: `<type>/<KEY>-<slug>-<nn>` (e.g. `feature/HB-1234-gamified-dashboard-01`). Combined branch (R114): `<type>/<KEY>-<slug>`. In an epic's per-Jira stacks, each child uses its own key and type. PR titles: `<KEY> · <nn>/<N> <title>`. | "A bug is fix/jirakey-description and a feature is feature/jirakey-description." |
| **R118** | **Optimize for rate limits, not dollars** (Claude and Codex are on subscriptions). (a) **Every Claude session delegates substantive work to pinned subagents.** The session orchestrates; trivial one-step edits and answers from context it already has stay inline, because dispatching costs more than it saves. This lives in each stage brief and in `~/.claude/CLAUDE.md` (B8), generalizing context-gremlin's Task Routing table. (b) Subagents use the cheapest model that holds quality: readers, the browser driver and chores on Sonnet or Haiku, which spares Opus quota. (c) Second opinions go to the Codex pool. (d) Run-all pauses on a limit error and resumes later (R105), and can be started at night. (e) No `max` effort by default. (f) Per-run records include limit events, and the §17 routing is tuned by **quota used per completed phase**. | Subagents keep contexts clean and let cheaper models do the reading. They don't cut total tokens by themselves (each one re-reads files), so trivial work isn't delegated. |
| **R112** | **Protected actions = approval-gated, not forbidden.** Opening a PR for review (`gh pr ready`, or a non-draft PR), merging, approving, and **posting review findings on other people's PRs** (review/rereview, R110) need **my explicit approval**. Replying to and resolving comments **on my own PRs** is not protected (R113). a UI button, or `ask` → allow in a chat. Once I approve, the agent or the engine does it. Headless runs never do them. Everything else on its own phase branches is free: commit, push, `--force-with-lease`, draft PRs. | Answer to Q4. |
| **R97** | **Size is information, not a gate.** The board shows each phase's estimate and actual diff, and a large PR gets one line saying why. The planner's rule is **no bundling**: separately reviewable work is split, and I decide. Grouping several Jira children into one phase is allowed only when they aren't separately reviewable. | "A PR is a deliverable; if we can't make it small, we don't." |
| **R98** | **Phase build loop:** implement (`/mattpocock-skills:tdd`, at the **seams confirmed during planning** and written into the phase file) → gate (the repo's `checks` from env config: typecheck, lint, touched tests) → fresh `phase_review` (Opus; `/mattpocock-skills:code-review` with fixed point = **the stack parent tip or the merge-base with main**, plus the phase md as the spec; standards pushed into the prompt; the two axes kept separate, then `VERDICT.json`) → push + draft PR → `live_check` (§6) → sign-off → the phase is `in_qa`, never ready. | Matt's loop, grounded in the skills' actual contracts. |
| **R99** | **QA changes are a new round on the same phase and branch**, not a new phase: the phase goes back to `running` with my notes as feedback. Its children become `stale`. | A new phase off main can't fix an unmerged PR. |
| **R100** | **Live check: where it runs depends on whose work it is.** **Our own work** (phase live checks in Execute, the integration check, and reviews between iterations in interactive dev) runs **locally** in the stack's worktree, before or without a push, for fast feedback. It uses cgremlin's existing per-repo `environments.localApp` (URL, port, dev and install commands, prereqs; e.g. grace-frontend at `local.findcare.dev.aplaceformom.com:8080`) and the existing **test-user mechanism** (`clerk.testEmailTemplate` + verification code, rendered per run). Build identity = the worktree HEAD sha + dev-server start time. **Someone else's PR** (review/rereview) runs against **the PR's Vercel preview**, with build identity from the Vercel check on the head sha in `statusCheckRollup` and a wait of up to 10 min. **The engine decides whether to run** from the diff paths against the env config's `surfaces` globs; if none match, it says *"No live check — no UI/API paths changed"*. ui-driver records; eng/PM/design evaluators judge. A bug in our own work gets a fix run within the phase budget, then a re-check. A visual or taste item never loops (👁). One local app at a time: runs are serialized, and if the port is already taken (e.g. my own dev server), the run reports `needs_input` instead of killing it. | Local is faster and works before a push. A preview is the honest view of someone else's PR. Reuses the local-dev and test-user setup cgremlin already has. |
| **R101** | **The sign-off is written by the engine.** An AC is ✅ only with all of: the build identity (R100) matching **the commit under test**, a step log, an assertion (expected / observed / result), evidence (screenshot + console + network), an evaluator verdict, and the browser mode. Headless is allowed but shown on the sign-off. Anything missing is ❓ with a reason. **It goes stale** on a new commit, a restack or base change, a phase-md edit, a Jira AC change, or an env change. | The "verified live" claims that weren't. |
| **R102** | **Notes** are engine records `{id, target: phase\|session, original, text, at, author: me\|lead, status: new\|applied(round N)\|addressed}`, written under the session lock. **A note I dictate to the lead goes straight in, with no proposal click** (answer to Q5). The lead **may rewrite it so it lands better** (`prompt-master` / prompt-engineering), and the phase receives the rewrite with my `original` quoted beneath it. The board shows both. Only `new` notes go into a round's brief. The phase review must say, per note, whether it was addressed. A note on an `in_qa` or finished phase **starts a round** (R99) after my click. | Tells old from new without trusting the agent, and never drops a note silently. |
| **R103** | **PENDING D2: the lead agent proposes, I commit.** The session chat is an interactive `claude` in the workplan's read-only worktree. It reads **structured state** (`cgremlin-core status --json`, phase states, gate results, sign-offs, `SESSION-LOG.md`), not raw transcripts, Jira text or page logs. It **writes proposals** (`proposals/*.json`: add phase, edit phase, note, run, pause, replan), and the board shows each one with **[Approve]**. It quotes `status` output rather than paraphrasing, and the board is the source of truth. It re-reads state on every question and restarts clean when long. It can't mark ready, merge, post or approve. | Artifact-driven (DECISIONS:34). This closes the injection chain page/Jira text → lead → run → push, and keeps the lead on one Rule-of-Two leg. |
| **R104** | **Changes land at boundaries** (a phase starting, or between rounds), except ⏸ Stop and ⤴ Take over. **One driver at a time**: Take over claims the phase session, and ↩ Hand back resumes from the gate. | A running step never gets conflicting instructions. |
| **R105** | **Run until done, but never stuck** (answer to Q7). There's no cap on phases or duration: Run-all continues until every phase passes and the integration check (R111) passes, or a phase needs me. The guards are against waste, not progress: a **hang** timeout per run (default 45 min); **no-progress** detection (the same gate or review failure in 2 consecutive rounds, or 10 runs on one phase → `needs_input`); a rate-limit error pauses and later resumes; boot-resume after an engine restart (today `failStaleRuns` only fails runs). A token ceiling is optional and off by default. | Nothing is opened or merged without me, so a long run risks only tokens. The loop and hang guards stop that waste. |
| **R106** | **Matt Pocock's skills, unmodified.** Install `mattpocock-skills` (verify the exact install command at install time, since the docs and the repo README differ) and **pin 1.2.3**. Deny the model-invocable skills that write into repos (`domain-modeling`, `prototype`, `wizard`, `pr`, `improve-codebase-architecture`) in cgremlin-rendered settings; they can still be invoked on purpose. Never run `setup-matt-pocock-skills`. Every brief carries the **tracker text** in §7. | Contract clashes found by the review. Individual plugin skills can't be disabled, so deny rules do it. |
| **R107** | **Git policy.** AFK phase runs follow R92/R112. **Interactive working sessions commit a checkpoint every time a step works** and is a step forward, and push their own branch freely. A PreToolUse hook **rendered by cgremlin's `renderPermissionSettings`** (not Matt's script, which exits 2 and can't ask) returns `ask` only for the R112 protected actions, and `deny` for pushes to `main` or protected branches and plain `--force`. | Answer to Q6: checkpoints are what we go back to when things go wrong. |
| **R108** | **UI.** Lineage is added to `ItemLinks` (`pipelineId`, `parentSessionId`) with a lineage grouping step, so a workplan and its phase sessions form **one row**, and epic child keys don't split it. The left **Work** list shows one row per session: step, `Phase n/N`, needs-you count, and one next action. The **Item tab** is the session: step stepper, **phases table**, stack strip, **💬 Chat with session**, and a **Proposals** strip. Existing panes are reused. A new nested-artifact route plus a deliberate CSP relaxation lets evidence screenshots show. The VS Code stage ladder learns `workplan`. | "The session holds the whole plan." |
| **R109** | **Run controls:** ▶ per phase (enabled when blockers are done), **▶▶ Run all ready** (sequential in dependency order; stops at the first `needs_input`, HITL phase, budget, rate limit or stale stack), **⏸ Stop after current**. A HITL phase offers **▶ Run with me**. | "▶ Run next" is just ▶ on the next row. |

| **R110** | **Review and re-review never post on their own.** Headless `review`/`rereview` runs (including the automatic re-review on new commits) write `REVIEW.md` and stop. Their prompt no longer says "then post it" (`prompts.ts:687`, the rereview prompt), and the `## Posting` section is headed "only when the user asks you in this conversation to post". **Enforced:** the per-run guard render (`stage-runner.ts:232`) denies `.cgremlin/post-review` and `.cgremlin/post-comment` for headless review/rereview runs. A **claim** (opening the chat) re-renders the settings to allow them. Contract and guard tests pin both. This also covers **self-review** sessions (`lineage.selfReview`, a review of my own PR): reviewing our own work never posts (§19). `respond` is unchanged: it replies on my own PR. | Regression from `1fd7bec` (2026-09-18), which removed "Do NOT post to GitHub" from the review briefs while extending respond's posting. This reverses the 06-26/07-09/07-10 specs ("the human posts"). The process is: findings doc → I review and talk → it posts when I ask. |

## §2 Lifecycle
```
PLAN (interactive chat, me present)         EXECUTE (per phase, ▶ or Run all)          DONE
 [bug: diagnosing-bugs → FINDINGS.md]        child development session per phase         all phases merged
 grilling → to-spec → SPEC.md                implement → gate → review → draft PR
 to-tickets → phases/*.md (+ seams)          → live check → sign-off → in_qa → my QA
 gate + my ✓ → plan_ready
```
`WORKPLAN_STEPS = ['planning','plan_ready','executing','verified','shipping','done','abandoned']`. Transitions:
`planning → plan_ready|abandoned`; `plan_ready → executing|planning|abandoned`;
`executing → verified|planning|abandoned` (`planning` = Replan); `verified → shipping|executing` (a change re-opens
Execute); `shipping → done|executing|abandoned`. `verified` = the R111 integration check passed. `shipping` = I've
started opening PRs. Stage names **appended**: `phase_review`, `live_check`.
Implementation reuses `develop`. Planning is chat-only (no stage).
**S tier:** planning may end with a single phase and no SPEC.md. The plan gate still applies, since it checks the phase list.

## §3 Gates
| Step | The script checks |
|---|---|
| plan | the phase graph is acyclic; every `blocked_by` resolves; stack depth ≤ 2; each phase has ACs, `afk`/`hitl`, seams, and a size estimate; every SPEC user story maps to ≥1 phase (when SPEC exists); then my ✓ |
| phase build | env `checks` (typecheck, lint, tests for touched files) |
| phase review | `VERDICT.json` parses; every finding cites a file in `git diff --name-only <fixed point>...HEAD`; every `new` note has an addressed/not-addressed line |
| live check | evidence exists for every AC marked ✅ (R101) |

## §4 A phase, end to end
Phase states: `queued → running → checks → review → pr_open → live_check → in_qa → merged`, plus `blocked`,
`needs_input`, `stale`, `timed_out`.
```
▶ → createPhaseSession (worktree <type>/<KEY>-<slug>-<nn> from base, R95) → phase md snapshot + hash
 → implement (fresh, tdd at seams) → GATE ✗ → fix run ─┐
 → phase_review (fresh, Opus, no push) → changes → fix run ─┤ ≤ 6 runs total (R89)
 → push + gh pr create --draft → engine detects PR (R91)    │
 → live_check (engine-decided, fresh, no push) → bug → fix run ─┘
 → engine renders SIGNOFF → in_qa → next (Run all) or stop
```
**My QA:** the sign-off plus the evidence. ✅ → **I** mark ready. Changes → a new round on this branch (R99). After a merge
→ **Restack** (R96).

## §5 Files
```
<sessionsDir>/<workplan-id>/                      # outside every repo
  session.json  SPEC.md  FINDINGS.md?  SESSION-LOG.md
  phases/01-points-on-dashboard.md                # mine + planner's (to-tickets template + the §7 extra fields)
  state/phases.json  state/notes.json            # engine-owned
  proposals/*.json                                # lead → board [Approve]
<sessionsDir>/<phase-session-id>/                 # one per phase (child development session)
  PHASE.md (snapshot, hashed)  rounds/1/{BRIEF.md, FEEDBACK.md, gate.log, VERDICT.json}
  livecheck/{steps.md, *.png, console.md, network.md, ac.json}  SIGNOFF.md
```

## §6 Live check and the Rule of Two
**Secret handling:** the engine injects the Vercel bypass as a **request header through the browser tool's
configuration**, never into agent context, and navigation is **allow-listed** to the preview host (or the local host for our own work) and the Clerk domain.
*Verify at build time that chrome-devtools/playwright MCP supports both; if not, the engine runs a local forwarding
proxy that adds the header and refuses other hosts.* The test user comes from the existing `clerk` block.

| Run | Untrusted input | Sensitive data in agent context | Outward action | Human / reliable gate |
|---|---|---|---|---|
| planning chat | Jira text (delimited) | — | none | I'm present |
| implement / fix | phase files (derived from Jira, **approved by me**) | env tokens in the worktree (`NODE_AUTH_TOKEN`) | push own branch, draft PR; **Bash network is open** | plan approval + Jira-change re-approval; guard; draft only |
| phase review | the diff | — | none (no push) | — |
| live check | the app under test (local, or the preview for others' PRs) | — (header injected, R100) | browser limited to the allow-list | test user's own permissions |
| lead | structured state only | — | proposals only | my [Approve] |
PR review comments (untrusted) are not an input to any Execute run. They stay in the `respond` mode.

## §7 What every brief says to Matt's skills (verbatim contract)
> The issue tracker for this work is provided here, not in `docs/agents/issue-tracker.md`, which is intentionally
> absent. Do **not** suggest `/setup-matt-pocock-skills`. "Publishing a ticket" = writing
> `<workplanDir>/phases/<NN>-<slug>.md` (absolute path). The spec is `<workplanDir>/SPEC.md`. Skip triage labels.
> Each ticket additionally carries: `afk|hitl`, `jira:` (if any), `size:` estimate, `stories:` (SPEC story ids),
> `seams:` (the test seams we confirmed). Ignore the template's `Status:` line; the engine tracks status.

`code-review` additionally receives its fixed point (R98) and the phase md path as the spec, and is asked for
`VERDICT.json` after its report.

## §8 How I interact while it runs
| I want to | UI | Mechanism |
|---|---|---|
| know where we are / what happened | 💬 Chat with session | the lead quotes `status` and SESSION-LOG |
| nudge a phase | tell the lead (→ proposal) or 📝 Note | R102 |
| change a phase that hasn't run | tell the lead (→ proposal) or ✏️ Edit (the md in an editor tab) | the plan gate re-validates on save |
| add something | tell the lead (→ proposal) or **+ Add phase** | a short grill, then a phase md with **needs approval** |
| stop / redirect | ⏸ Stop → change → ▶ | the worktree and commits are kept |
| work inside a phase | ⤴ Take over / ↩ Hand back | claim + `claude --resume` in the phase worktree |
| change the plan | "replan" | `executing → planning`: a diff to the phase list; affected PRs flagged; merged or in-QA phases aren't rewritten |

## §9 UI
```
Left:  ● HB-1234 Gamified dashboard (ticket)  Phase 2/5 · 1 needs you  [QA #2301]

Item:  HB-1234  Gamified dashboard        [💬 Chat with session] [▶▶ Run all ready] [⏸ Stop after current]
       Plan ✓ · Executing phase 2 of 5 · budget 2/5 phases tonight
       PROPOSALS  lead: "add phase 6 — empty-state copy"            [Approve] [Dismiss]
       PHASES                                                        [+ Add phase]
        1 Points on dashboard   212 ln  ✅ In QA      #2301  5/5 ✅  [👁 Evidence] [📝]
        2 Level badge  ← 1      140 ln  ● Live check  #2302  —       [👁 Watch] [📝] [⏸] [⤴]
        3 Streaks               ~180    ◻ Ready              —       [▶] [✏️]
        4 Backfill (HITL)       ~90     ◻ Needs you          —       [▶ Run with me]
       STACK  main ← #2301 (CI ✓ · approved) ← #2302 (draft)          [↻ Restack]
```

## §10 Skills and agents
Planning: `grilling`, `to-spec`, `to-tickets`, `diagnosing-bugs` (bugs). Implement: `tdd` (+ explorer subagents).
Review: `code-review` + cgremlin reviewer/verifier agents. Live check: `cgremlin:ui-check` (ui-driver + eng/PM/design
evaluators), `qa-verify` api/analytics checks. Lead: `cgremlin-core status --json` + the proposals files.

## §11 Edge cases
| Case | Behaviour |
|---|---|
| rate limit / sleep / engine restart | the run is `stopped`; boot-resume continues Run-all from `state/phases.json` (R105) |
| a run hangs | wall-clock timeout → `timed_out`, counts against the phase budget |
| phase budget spent | `needs_input`, Run-all stops, SESSION-LOG says why |
| a parent gets commits after its child was built | the child is `stale` and its sign-off stale; Run-all stops at stale stacks; Restack is my click |
| restack conflict | stop, `needs_input`, offer Take over |
| someone pushes to main | independent phases rebase at their next round (their own branch, no force needed until a PR exists; after that, Restack) |
| Jira ACs change | the phase pauses until I re-approve (R94) |
| PR closed on GitHub | phase `blocked`; the lead proposes drop or reopen |
| a restack would dismiss approvals | a warning with a count; my click |
| the preview isn't ready in 10 min (others' PRs) | fall back to a local app on the PR branch, or ❓ with the reason |
| a lead proposal is stale (the state changed) | the engine re-validates on Approve and refuses stale proposals |

## §12 Acceptance criteria (v1)
1. A workplan can be created from a ticket or an epic, with a checklist import of epic children using two queries.
2. Planning is one chat that produces `phases/*.md` passing the plan gate. `plan_ready` needs my ✓.
3. ▶ creates a child development session on `<type>/<KEY>-<slug>-<nn>` (R117) from the right base, and a draft PR the engine detects into `session.pr`.
4. Every phase round is `fresh` (no `--resume`). Take over and the lead are the only resumed sessions.
5. No phase reaches `in_qa` without a passing gate and a `phase_review` verdict. The 6-run budget is enforced.
6. `phase_review` and `live_check` runs cannot commit or push. No phase run can mark ready, edit, merge, force-push or call `gh api`.
7. An AC is ✅ only with every R101 field present; all staleness triggers fire; the engine-decided "no live check" is shown.
8. Run-all proceeds in dependency order, respects the R105 budgets, stops on the listed conditions, and resumes after an engine restart.
9. The lead answers from `status --json`, and every change it wants appears as a proposal needing my click.
10. Restack (my click) handles a squash-merged parent with `--onto` and the recorded tip, and retargets the base. A conflict produces `needs_input`.
11. No committed content in any repo except the code on phase branches. Engine-local files are git-excluded.

## §13 Build order (each step useful on its own)
| # | Step | Size |
|---|---|---|
| 0a | **R110: stop review/rereview from posting on their own** (regression from `1fd7bec`, 2026-09-18) | S |
| 0b | Fix the respond-brief truncation (`prompts.ts:878-884`) and the rereview "skip everything else" (`:692`) | S |
| 1 | **Harden the `development` guard now** (ready/edit/api/force-push); make profiles stage-aware | S–M |
| 2 | `StageRunInput.fresh` + per-round archive; PR detection → `session.pr`/`pr_opened` + merged reconciliation for development | M |
| 3 | Mode `workplan` + steps + lineage grouping in the Work list | M–L |
| 4 | The planning chat with Matt's skills + plan gate (verify the skill contracts on a real ticket) | L |
| 5 | **One phase via ▶, end to end** (child session, gate, fresh review, draft PR). *First usable milestone.* | L |
| 6 | Live check + engine sign-off (header injection, build identity, staleness) | L |
| 7 | Run-all + budgets + boot-resume | L |
| 8 | Stacking + Restack (needs **D1**) | XL |
| 9 | Lead chat + `status --json` + proposals (needs **D2**) | M |
| 10 | The interactive git hook (R107) | S |

## §14 Later
Parallel independent phases (Sandcastle Docker behind `AgentRunner`), an auto-merge badge (`gh pr merge --auto` as my
click), Jira writes, live checks turned into e2e tests, `retro`, and migrating investigation → development onto
workplans.

## §15 Decisions (grilling round 1, 2026-10-01)
| Q | Decision |
|---|---|
| 1 | First milestone = one phase end to end from ▶ with a hand-written phase file, after steps 0a/0b/1. The planning chat comes second. |
| 2 | Planning is one interactive chat. AFK lives in Execute. |
| 3 | One linear stack of drafts; keep going; integration check on the top PR (R111); I open PRs at the end. |
| 4 | Commit, push, force-with-lease and draft PRs are routine. Opening for review, merging, approving and posting comments need my approval, then Claude does them (R112). The engine restacks automatically during Execute (R96). |
| 5 | Dictated notes go straight in; the lead may rewrite them with my original attached (R102). Other changes are proposals. |
| 6 | Interactive sessions commit checkpoints whenever a step works; push freely (R107). |
| 7 | No phase or duration cap; hang and no-progress guards only (R105). |

**Round 2 (2026-10-01)**
| Q | Decision |
|---|---|
| 8 | A failed integration AC → a fix round in the owning phase, restack, re-run. Unmappable → a new top phase. |
| 9 | Ship modes: one at a time (rest stay draft; small PRs may auto-merge with my OK) or all at once (collapse into one PR). Chosen by size (R114). |
| 10 | Keep per-phase live checks for that phase's own ACs. |
| 11 | Wait for CI and address comments: a phase is done when it could be opened for review (R113). |
| 12 | Decided at session start: an epic as one stack, or one stack per Jira, moving on after each merges (R115). |

**Round 3 (2026-10-01)**
| Q | Decision |
|---|---|
| 13 | On my own PRs: verify each comment, then fix it if in scope or reply, and resolve, automatically. Review findings on others' PRs post only with my approval (R110/R112/R113). |
| 14 | Restack automatically whenever a PR is draft and unapproved, whatever the step (R96). |
| 15 | Both options prepared: the phase stack plus a combined draft PR to main; I choose (R114). |
| 16 | Auto-approve and auto-merge are the repo's CI (agentic review); cgremlin follows the outcome (R114). |
| 17 | An epic in one-Jira-at-a-time mode is planned up front, grouped by Jira; the next child's plan is re-checked just before it starts (R115). |

## §16 Rev 2 changes (from three reviews)
- **Mode and planning:** the mode was renamed `workplan` (the stage `plan` exists). Understand, grill, spec and slice were merged into one interactive planning chat. DECISIONS.md was dropped.
- **Fresh runs and PR tracking:** added `fresh` runs (runs used to always resume) and PR detection for development sessions (it didn't exist).
- **Guard:** the development guard is hardened and stage-aware (it was weaker than rev 1 claimed).
- **Loop and QA:** one 6-run budget per phase; QA changes are a new round on the same branch.
- **Live check and sign-off:** the Vercel secret goes in by header injection with a navigation allow-list; build identity comes from `statusCheckRollup`; the engine decides when to skip the live check; more staleness triggers.
- **Lead:** it proposes and I approve, and it reads structured state only.
- **Matt's skills:** the exact tracker text, the review fixed point = the parent tip, seams in each phase, repo-writing skills denied, pinned version.
- **Jira:** two queries and a checklist import.
- **Restack:** a human click with conflict handling and stack depth ≤ 2; it's flagged as amending DECISIONS.md.
- **Budgets:** timeouts, a per-night phase cap and token ceiling, and boot-resume.
- **UI:** lineage grouping, so an epic stays one row; an artifact route and CSP change for screenshots.

## §17 Default routing table (R116, researched 2026-10-01; tune with data)
These are starting defaults. Both vendors say to run an effort sweep on real work, and judge by **cost per completed phase**.

| Stage | Primary (runner · model · effort) | Escalation / second opinion |
|---|---|---|
| Planning chat | claude · opus · high | Large or ambiguous work: claude · fable · high. Optional: one codex · gpt-6.1-sol · high critique of SPEC.md (report-only) |
| Implement (TDD) | claude · opus · high (xhigh if the phase is expected to run over ~30 min) | Candidate cheaper arm to A/B: claude · sonnet · medium + `--advisor opus` |
| Fix round 1 | same as implement | — |
| Fix round 2 | claude · opus · xhigh, or `--advisor fable` | — |
| Fix round 3+ | switch family or tier: codex · sol · xhigh *(report-only diagnosis in v1)* or claude · fable · high | Never `max` by default (overthinking evidence: 2507.14417, 2502.08235) |
| Phase review | claude · opus · high, read-only | codex review (sol · high) in parallel, **report-only** |
| Finding verification | claude · opus · high; must reproduce each finding with a test or command | The verifier uses **the other family** from whoever raised the finding |
| Live check: ui-driver | claude · sonnet · medium | Complex flows: opus · medium |
| Live check: evaluators | claude · opus · medium, over curated evidence | Optional: one evaluator on codex · sol · medium |
| Comment triage (own PRs) | claude · sonnet · medium | Design decisions: opus · high |
| Integration check | claude · opus · high | codex · sol · high as a second judge; **disagreement → me** |
| Lead chat | claude · sonnet · medium | — |
| Chores (commit messages etc.) | claude · haiku | Git operations are engine code, not a model |

**Notes**
- **Codex model names:** `gpt-6.1-sol` ($2/$10, recommended for complex coding), `gpt-6-astra` ($10/$50, strongest; tends to stop and ask, so prompt it to bias toward action), `gpt-6-luna` ($0.10/$0.50).
- **AGENTS.md:** Codex merges AGENTS.md files from the git root down, capped at 32 KiB. Set `project_doc_fallback_filenames=["CLAUDE.md"]`.
- **Opus vs Fable:** Opus 5.5 matches Fable 5.1 on most work and beats it on Terminal-Bench 4.0 / FrontierCode at max effort, so Fable is an **escalation**, not a default.
- **Planned A/B (after milestone 5):** about 10 real phases. Compare (a) opus · high against (b) sonnet · medium + advisor opus for implement, and measure whether the codex second-opinion review adds confirmed findings.
- **Rate limits:** splitting stages across Claude and Codex also spreads load across two rate-limit pools. History shows 26 limit hits.

## §18 Gaps closed (decisions 2026-10-01)
| # | Decision |
|---|---|
| A1 | **One worktree per stack.** Phases run one after another, so the stack's worktree moves from branch to branch: one install, one `node_modules`. Worktrees are removed after the stack merges or is abandoned. |
| A2 | **Commit frequently** (checkpoints). Push at round boundaries; push frequency doesn't matter. |
| A3 | **The `cgremlin` plugin** (`context-gremlin/plugin/`), installed at user level. Agents: the 12 existing ones, tightened (a `tools` list, an output format, model/effort per §17, a three-way verifier verdict). Skills: `review` (§19), `ui-check`, `qa-verify`, `evidence-bar`, `local-dev`, `rewrite-note`, `improve`. Third-party skills (mattpocock-skills, prompt-master) are installed as-is and never copied. Build step **1b**, after the guard hardening. |
| A4 | **One review skill unifies every copy of the review guidance** (bash, Python, prompts.ts, the missing APFM skill). It takes a **different angle from CI's agentic review**: see §19. `reviewSkillCommand` points to `/cgremlin:review`. |
| A5 | **Freeze `bin/cgremlin`.** No new work goes into it. Retire it once the core path has proven itself. |
| A6 | **Improvement loop**, see §20. |
| A7 | **Evals for every stage skill**: ≥3 scenarios against today's brief as the baseline (`claude plugin eval`). A skill replaces a brief only if it wins. The respond-truncation bug becomes the first regression scenario. |

## §19 `cgremlin:review`: one review skill, a different angle from CI
**Two uses, two behaviours.**
- **Reviewing someone else's PR** (review/rereview): live verification runs on **the PR's preview**. Findings go to REVIEW.md, and **I approve before anything is posted** to the author (R110/R112).
- **Reviewing our own work** (the Execute `phase_review`, or between iterations in interactive dev): **nothing is ever posted.** Findings feed `FEEDBACK.md` for the next fix round, so we iterate until everything that needs fixing is fixed. Live verification runs **locally**, possibly before a push (R100). For draft phases this is the only review, because CI's agentic review skips drafts.

**Complement, don't duplicate.** CI's Gateway review covers:
- CLAUDE.md compliance
- an OWASP-style bug scan (on a small model)
- performance and user-POV checks
- cross-repo integration contracts
- with strong evidence rules and a ≥80 confidence gate

But CI can't run tests or the build, has no Jira, reads only the touched files, and suppresses alternatives and test adequacy. **This skill owns what CI leaves out:**
- **Ticket fit:** Jira ACs against the diff.
- **Placement and folder structure.**
- **Architecture and design fit.**
- **Hacks and workarounds.**
- **Alternatives** (best option vs easiest).
- **Scalability and maintainability.**
- **Regression risk:** callers, blast radius, Hyrum's-law surfaces.
- **Test adequacy:** would a test fail if this line were inverted?
- **Security on trust boundaries,** with a traced path (Next.js: server actions re-validate and re-authorize; `[param]` is user input; `NEXT_PUBLIC_`; route handlers; client props carrying private data).
- **Running** typecheck and the focused tests.
- **Running the change live:** the Jira ACs, Figma fidelity and the API checked live (step 3b: the preview for others' PRs, local for our own).

**Never infer.** Every finding cites code read in this session.

**Process: investigate aggressively, report conservatively.**
1. **Evidence pass** (scripts, then reader subagents on Sonnet): the PR description, the ticket, the full diff, conventions (CLAUDE.md, ADRs, path aliases, lint import rules), `changed-surface` (changed exports, props, routes, schemas, flags, serialized shapes), `callers` (a grep of every caller of each changed export), and `run-checks`.
2. **Lens passes** (parallel subagents, Opus · high). Each lens may raise a finding only with its evidence bar:
   - **Placement:** ≥2 existing files following the convention the PR breaks, or a written rule.
   - **Architecture:** `file:line` of the abstraction being bypassed or duplicated *and* of the new code, plus the quality attribute affected.
   - **Hack:** the cause it avoids, the proper path that exists, and a git log/blame check of any removed guard (Chesterton's fence).
   - **Security:** a traced path from input `file:line` → the missing check → the sensitive operation `file:line`. Without the path, it's a question.
   - **Scalability:** the variable that grows, and the line whose cost scales with it.
   - **Maintainability:** the concrete future change and the N files it would force to change.
   - **Regression:** callers read, covering tests found, the observable-behaviour change named.
3. **Alternatives protocol** (for a new module, abstraction, dependency, data flow or workaround):
   - Name the problem and the decision drivers.
   - List 2–3 options from the repo's own patterns or already-installed libraries (optionally "do nothing / fix at the root").
   - Make a table where each cell cites `file:line` or says "unknown".
   - Judge it: the chosen option is best → no finding; it's the easiest but worse on a key driver → a finding with a migration path; it's a judgment call → a non-blocking thought.
   - The bar is better code health, not perfection.
3b. **Live verification: does it actually work as the ticket and design say?** This reuses the Execute live check (R100/R101) and `cgremlin:ui-check`, and replaces today's separate "LIVE UI CHECK" brief section.
   - **Where:** someone else's PR → its **Vercel preview** (build identity from `statusCheckRollup`). Our own work → **local** in the worktree, with the `localApp` config and a per-run test user (R100).
   - **ACs:** each Jira AC becomes a flow. The ui-driver runs it and records evidence; the **PM evaluator** judges pass, fail or can't-verify per AC.
   - **Design:** when the ticket or PR links a Figma frame, it's fetched through the Figma MCP and compared **side by side** with the screenshot of the app under test. The **design evaluator** reports mismatches.
   - **API / backend:** for API-touching PRs, HTTP checks against the app under test (preview or local), using `qa-verify` api-checks: status, shape, auth and error cases.
   - **Eng evaluator:** console errors, failed requests, broken empty, error and loading states.
   - **Results:** these become findings under lenses `Live: AC`, `Live: Design` and `Live: API`, with the same evidence rules (screenshot, steps, assertion; anything missing is ❓). Visual and taste items go to **👁 for me** and are never posted automatically.
   - **Safety:** the same as §6. On a preview, the bypass header is injected outside the agent and navigation is allow-listed to the preview host. Locally, navigation is allow-listed to the local host. Always a test user, never a real account.
   - **Skipped** only when the engine's `surfaces` rule finds no UI or API paths changed, and the review says so.
4. **Verification:** each candidate is re-checked by a fresh verifier **from the other model family** (§17). Only confirmed findings remain.
5. **Rank and cap:** about 7 findings at most. "No findings" is a valid result.

**Finding format.** The labels are deliberately different from CI's Block / Should Fix / Note:
- **Severity:** `Blocking` / `Important` / `Consider`.
- **Confidence:** `High` (both ends read, or reproduced; required for Blocking and Important) or `Medium` (posted as a **question** that says what wasn't verified). Low-confidence findings are dropped.
- **Fields:** lens · where (full-SHA permalink) · problem · consequence · concrete fix · **Evidence:** · **Not verified:**.
- **Footer:** the lenses checked, plus *"Advisory: complements the CI agentic review"*.
- **Never** CI's `## <Severity> — path:line` heading style, and **never** a competing risk score.

**Anti-noise:**
- Only what the PR introduces or makes worse.
- No nits or style findings, and nothing lint or CI already catches.
- No DoS, rate-limit or generic-validation findings without proven impact.
- Respect comments, tickets and tests that explain odd-looking code.
- PRs over 400 lines are reviewed in units.

**Posting** (R110/R112): only when I ask. When posting on others' PRs, show a reminder first: any posted comment **disables CI auto-merge** and feeds CI's next review run.

**Tools** (`scripts/`): `changed-surface`, `callers`, `run-checks`, `permalink`, `validate-review` (every finding cites a changed file or a caller read, and has Evidence/Not-verified), `review-to-post-json`.

**References:** the lens checklist, the alternatives template, the Next.js security list, and `research/review-best-practices.md` with sources (Google eng-practices, Bacchelli & Bird, Bosu et al., Ousterhout, ATAM/MADR, OWASP ASVS 5 / Secure Code Review, Next.js security, Anthropic Code Review, Cursor Bugbot, GitHub Copilot review, Atlassian RovoDev, HalluJudge).

**Evals (A7)** — scenarios, each against today's brief as the baseline:
- a hack (`as any`, or an empty catch hiding a failure)
- a duplicated abstraction
- a broken caller
- a missing test on a high-blast-radius path
- a server action without re-authorization
- a **clean PR (expect no findings)**
- past false positives taken from `feedback.jsonl`

## §20 The improvement loop: changing cgremlin itself
**Capture**
- **💡 Improve** button: in the panel header, and on any phase, finding, sign-off or row ("this was wrong because…").
- What I type becomes a record in `~/.cgremlin-core/feedback.jsonl`: `{at, text, context: session/phase/stage/artifact links, runner/model/effort}`.
- **Automatic signals** go into the same file: findings I dismiss, sign-offs I contradict, fixes I revert, phases that hit the no-progress guard, and notes I dictate.

**Act**
- **On one item:** `/prompt-master` turns my text into a sharp improvement brief, and cgremlin starts a **workplan session on the context-gremlin repo itself**. It's the same pipeline: grill → spec → phases → draft PRs to cgremlin, and I merge.
- **On the backlog:** **🧭 Review feedback** opens a chat where an agent clusters `feedback.jsonl` by target (UI, agent, skill, engine, routing), proposes changes, grills me, and launches the chosen ones as workplans.

**Guardrails**
- Every change to cgremlin passes the core and vscode test suites, the contract tests, and the skill evals (A7).
- Plugin changes bump the plugin version and the CHANGELOG.
- `docs/PROCESS.md` describes how cgremlin works today, and every improvement updates it.
- Nothing applies itself: improvements arrive as draft PRs to context-gremlin.

## §21 Personal setup track (outside cgremlin; decisions B8–B15)
| # | Item |
|---|---|
| B8 | `~/.claude/CLAUDE.md`, kept short: answer first, then examples or scenarios; no edits while we're still discussing; back claims with `file:line` or a command; one plain question at a time; commit a checkpoint whenever a step works. |
| B9 | Trim plugins *before* installing mattpocock-skills. Enable PostHog/Sanity/Vercel/Figma only per project where used. Remove `ai-firstify`. Dedupe MCP servers: chrome-devtools ×3 → 1, Atlassian ×4 → 1, PostHog ×2 → 1. Check `/skill-doctor`. |
| B10 | Fix `chrome-devtools-visible`, which launches `--headless=new`, so "visible" runs really are headed. |
| B11 | A global PreToolUse hook in `~/.claude/settings.json` (the same R112/R107 rules for plain sessions outside cgremlin). |
| B12 | Remove the stale `autoMode.environment` block. Prune the 71 + 366 one-off allow rules, including the broad ones (`gh api:*`, `python3:*`, `cd *`, `Read(//Users/…/**)`). Add an auth preflight (`gh auth status`, MCP provider status). |
| B13 | **prompt-master = the public `nidhinjs/prompt-master` (MIT, v1.8.0), installed as-is and pinned.** The custom March copy that shadows its name is backed up and retired, along with its duplicate command. `cgremlin:rewrite-note` *wraps* it and adds only cgremlin context (the target phase, my original quoted). |
| B14 | **Local dev that just works:** `cgremlin:local-dev` plus `cgremlin-core local start\|stop` usable from plain sessions, reading the per-repo `environments.localApp` (URL, port, prereqs, Clerk test user). First, investigate the 23 local-dev friction turns to find what actually breaks, and fix it. |
| B15 | Rotate the Jira API token (printed into a session transcript on 2026-09-30). Consider moving secrets to the macOS Keychain. |
