# Autonomous Investigate / Develop Sessions Design

**Date:** 2026-07-06
**Status:** Draft
**Builds on:** the PR-review Mission-Control tab model, autonomous headless-agent launch, per-mode auto-loaded `CLAUDE.md`, reviewer-comment triage, Atlassian MCP, `GITHUB_ME`.

---

## Problem

Starting an investigation or development session from the web UI is broken: it creates a session that shows "broken session," then the user must click "Start Claude" and paste instructions by hand. The user wants a smooth, autonomous flow: click start → an agent spins up in Mission Control with the right instructions, grabs the input/Jira, and works the problem largely on its own — pausing only for genuine judgment calls — with the user reviewing at defined checkpoints.

**Every task begins as an investigation.** The investigation produces `FINDINGS.md` (understanding + root cause + scoped plan/direction). Sometimes that's the end. When the user decides to proceed, they promote it to a **fresh develop session** seeded with the investigation's `FINDINGS.md` + the Jira. **`FINDINGS.md` is the handoff** — it must be complete and self-contained enough that the develop agent knows exactly what to do without the investigation agent. On promotion, the investigation agent has done its job: its pane **closes**, and develop stands entirely on the findings + Jira.

Investigation and development share a launch and workspace model but differ in deliverable: investigate produces the findings + plan; develop implements it (TDD), verifies on the preview environment, triages bot comments, and hands over a tested draft PR.

---

## Goals

1. **One-click launch, no manual steps.** Web UI "Start Investigation / Start Development" creates the session correctly and auto-launches the agent — no "broken session," no manual "Start Claude," no pasting instructions.
2. **Live in Mission Control.** Each session appears as a titled panel in a single **`🔨 WORK`** tab, tiled so all active investigate/dev work is visible at once.
3. **Jira as source of truth.** The agent works strictly to the Jira ticket (+ any input the user gave). It covers only what the ticket asks; extra work is proposed as a tech-debt Jira, created only with permission.
4. **Autonomous with judgment checkpoints.** The agent gets the grunt work done without prompting for everything. It pauses only where human judgment matters: the plan review, and any comment it's unsure about.
5. **Investigate = plan.** Produces a written understanding + scoped fix plan (`FINDINGS.md`). No code changes.
6. **Develop = plan → TDD → tested draft PR.** Plan gate → user go-ahead → TDD implementation → draft PR → live web tests on the preview URL → bot-comment triage → notify user → user gates to "ready."

---

## Non-goals (deferred)

- **Local app run** from a session folder (single-instance on `local.findcare.dev.aplaceformom.com:8080`, using `.env.local` from `/Users/guilherme.azoubel/Projects/grace-frontend/.env.local`). The initial version verifies against the **Vercel preview environment** of the draft PR instead. Local-run is a separate follow-on spec.

---

## Architecture

### Launch (fixes the broken flow)

**Start = conversational, via the orchestrator** (like reviews). You tell the Mission Control orchestrator pane "I'm picking up HB-1051" (Jira key/URL/description); it runs `cgremlin --investigate <jira>`, creating the investigation session and a `🔍 <JIRA>` pane in the WORK tab that starts investigating. (The web-UI "Start Investigation" button remains as a secondary entry, fixed to the same path.)

**Promote = from the investigation agent.** When `FINDINGS.md` is ready and reviewed, you tell that agent "build it"; it runs `cgremlin --develop <session>`, which copies `FINDINGS.md` into a fresh develop session (`🔨 <JIRA>` pane) and then **closes the investigation pane**. Develop proceeds from `FINDINGS.md` + Jira alone.

Both launches follow the same steps below (differing only in mode and seed input):

1. The dashboard server creates the session **completely before any launch**: clone the repo, write a valid `session.json` (with mode, project, and — if a Jira key is derivable from input/branch — the ticket), fetch Jira context, and write the mode-specific autonomous `CLAUDE.md` (see below). (Root-cause note: the current "broken session" comes from launching the terminal before the session is fully written / from the `${4:-{}}` class of JSON bugs already fixed — this flow will write session state first, then launch.)
2. Launch the agent as a **pane in the `🔨 WORK` tab** of Mission Control:
   - `zellij --session mission-control action go-to-tab-name "🔨 WORK" --create` (creates the tab if absent; its layout includes the `tab-bar` plugin so the user can switch back to `MISSION CONTROL`),
   - then `zellij --session mission-control action new-pane -- bash <wrapper>` to add a tiled pane running the agent.
   - The pane is titled with the session identity (`🔍 <JIRA>` for investigate, `🔨 <JIRA>` for develop).
3. If Mission Control isn't running, fall back to launching it (or an iTerm tab) — but the WORK-tab pane is the primary path.

The agent runs with `cwd` = the session dir and its `CLAUDE.md` auto-loaded (the same reliable mechanism the review-triage agent uses — no dependence on a positional prompt injecting instructions, though a short "begin now" nudge is passed).

### The `🔨 WORK` tab

- A single Mission Control tab, tiled panes — one per active investigate/dev session, each titled. All visible at once for monitoring.
- New sessions add a pane (go-to-tab-name WORK → new-pane). Panes close when the work is done+reviewed or the user closes them.
- Contains the `tab-bar` plugin so `MISSION CONTROL` (and any PR-review tabs) stay one click away.

### Jira as source of truth + scope discipline

- The agent fetches the Jira ticket via the Atlassian MCP (`getJiraIssue`); if unavailable, it falls back to the user's typed input. The ticket's intent/acceptance criteria define scope.
- It covers **only** what the ticket asks. When it identifies necessary-but-out-of-scope work, it **proposes a tech-debt Jira** (summarizing the work) and creates it via Atlassian MCP `createJiraIssue` **only after the user agrees** — labeled/typed as tech debt. It never silently expands scope.

---

## Investigate mode

Deliverable: a plan, no code changes.

1. Read the Jira ticket + user input.
2. Investigate the codebase: trace the relevant paths, reproduce/understand the issue, find the root cause.
3. Write `FINDINGS.md` as a **complete, self-contained handoff**: what's happening, the root cause, the affected files/paths, risks, and a **clear scoped direction/plan** to fix the Jira — enough that a fresh develop agent can execute from it alone.
4. Work autonomously; pause only for genuine approach/design questions.
5. Stop at the plan — the user reviews it. This is the deliverable. If the user wants it built, they promote it via **Develop this** (or by telling the investigation agent "build it"): the agent copies `FINDINGS.md` into a **fresh** develop session (seeded with it + the Jira), then the investigation pane **closes** — its job is done.

---

## Develop mode

Deliverable: a tested draft PR, gated to "ready" by the user. **Seeded** with a copy of the promoting investigation's `FINDINGS.md` + the Jira (fresh, independent session — the investigation agent is gone; `FINDINGS.md` is the only handoff).

1. **Read the seed** (`FINDINGS.md` + Jira), then refine into an implementation plan (root-cause is already established; build on it).
2. **Plan gate (mandatory pause):** present the plan in the pane, explain it, discuss and adjust with the user. Wait for explicit go-ahead. This is the "real ideas" checkpoint.
3. **Implement with TDD:** for each unit — write the failing test, run it to confirm it fails, write minimal code, run to green, commit. Strictly Jira-scoped.
4. **Open a draft PR** on the pushed branch (`gh pr create --draft`), with a body summarizing the change and linking the Jira.
5. **Verify on preview:** get the draft PR's **Vercel preview URL** (from the PR's status checks / deployment) and run a **focused live web test set against it** — NOT the full e2e suite. The set proves the fix actually resolves the Jira issue, plus a complete smoke pass of that feature and its likely **splash-zone regressions** (the areas the change could plausibly affect). Playwright pointed at the preview URL. Iterate until passing.
6. **Bot-comment triage** (reuses the reviewer-comment triage logic): for each gitStream/bot (and any) comment on the PR —
   - false positive → reply "false positive: <reason>" and **resolve the thread**,
   - clearly valid → **fix it** (TDD where code changes),
   - unsure → **surface to the user** to discuss.
7. **Notify the user** that it's tested and comment-clean, so they can watch it run against the preview again and ask questions.
8. **Ready gate:** when the user says they're satisfied, **mark the PR ready** (`gh pr ready`) — via an allowlisted `cgremlin` helper, only on explicit user go-ahead. It then flows into the normal "My PRs" tracking (drafts already show as `📝 draft` there).

### Autonomy boundaries (develop)

Autonomous through: investigation, TDD implementation (after plan approval), draft PR, preview web tests, and triage of clear-cut bot comments. Pauses at: the plan gate, any unsure comment, tech-debt Jira creation, and the final ready gate. Never marks a PR ready or creates a Jira without explicit approval.

---

## Components (files changed — `bin/cgremlin` unless noted)

- **Dashboard server (embedded Python):** fix `create_investigation_session_noninteractive` / `create_development_session_noninteractive` launch to (a) write full session state first, (b) launch into the WORK tab pane instead of the broken/manual flow.
- **New: `create_work_agent_pane(session_dir)`** (or extend the tab machinery): writes the mode-specific autonomous `CLAUDE.md`, the wrapper, and adds a titled pane to the `🔨 WORK` tab.
- **New mode `CLAUDE.md` templates:** investigate (plan-only) and develop (plan-gate → TDD → draft-PR → preview-tests → bot-triage → ready-gate), auto-loaded from the session dir.
- **Reuse:** reviewer-comment triage helpers (`--reply-comment`, plus a new **resolve-thread** helper), `_pr_safety_check` patterns, Atlassian MCP (`getJiraIssue`, `createJiraIssue`), Vercel preview URL discovery (from `statusCheckRollup`/deployment).
- **New helper `--pr-ready <session>`:** `gh pr ready` on the session's PR (allowlisted for the develop agent; only invoked on user go-ahead).
- **New helper `--resolve-comment <session> <thread_id>`:** GraphQL `resolveReviewThread` (used after replying "false positive").
- **Sync:** if the Python server changes, re-run `bash -n` + `ast.parse` on the PYSERVER heredoc.

---

## Error handling

- **Jira unreachable:** fall back to the user's typed input as the scope; note it in `FINDINGS.md`/PR body.
- **Mission Control not running at launch:** launch it (or fall back to an iTerm tab); never leave a "broken session."
- **Preview URL not ready:** the draft PR's Vercel deploy may lag; poll/wait, and if it never appears, tell the user rather than blocking silently.
- **Preview web tests fail:** the agent fixes and re-runs (TDD); if it can't, it surfaces the failure to the user.
- **Bot comment ambiguous:** always defer to the user (never guess on unsure comments).
- **Tech-debt Jira / ready gate:** never acted on without explicit user approval.

---

## Resolved decisions

1. **Every task starts as an investigation** (started conversationally via the orchestrator). Develop is a separate **fresh** session, promoted from within the investigation agent ("build it"), seeded with a **copy** of `FINDINGS.md` + the Jira. On promotion the **investigation pane closes** — `FINDINGS.md` is the sole handoff; develop never depends on the investigation agent.
2. **Preview verification = focused set, not full e2e.** Prove the Jira issue is fixed, plus a complete smoke pass of the feature and its likely splash-zone regressions. Playwright against the preview URL.
3. **WORK tab crowding:** tiled panes shrink with many concurrent sessions — accepted for now (the user wants all visible at once); revisit only if it becomes unusable.
