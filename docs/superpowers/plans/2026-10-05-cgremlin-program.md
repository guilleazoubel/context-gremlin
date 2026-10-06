# cgremlin Improvement Program — Master Plan & Tracker

> **For agentic workers:** this is the **master plan**. Do not implement from it directly. Each step below is a
> self-contained hand-off for **one fresh session**. That session (1) reads its step card plus the cited spec
> sections, (2) writes the step's detailed plan with `superpowers:writing-plans` to
> `docs/superpowers/plans/<date>-<step-id>-<slug>.md`, (3) gets my OK, (4) executes it with
> `superpowers:subagent-driven-development` in an isolated worktree, (5) gets a fresh-context review, (6) releases
> per `RELEASES.md`, and (7) **updates this tracker** (status, links, log). Steps use checkbox (`- [ ]`) syntax.

**Goal:** turn cgremlin into the workflow we designed: workplan sessions (plan → phases → stacked draft PRs →
verified → ship), reviews that complement CI and never post on their own, a self-improvement loop, and a clean
personal Claude setup.

**Architecture:** cgremlin core (TypeScript engine) orchestrates fresh `claude -p` / `codex exec` runs per stage; a
`cgremlin` plugin carries the agents and skills used in every repo; third-party skills (mattpocock-skills,
prompt-master) are installed as-is; the VS Code extension is the UI and carries the engine.

**Tech Stack:** TypeScript, Node 24, pnpm, vitest, eslint, VS Code extension (vsce), Claude Code CLI, Codex CLI, gh.

**Spec:** `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md` (rulings R86–R118, §0–§21).
Research: `docs/superpowers/specs/{review-best-practices,model-routing-research,research-sources}.md`.

## How to start a step in a fresh session
Open a terminal **in `~/context-gremlin`**, so its CLAUDE.md task routing and `.claude/agents` load, then:
```bash
cd ~/context-gremlin && claude
```
Paste the step's **Start prompt** (in its card). Before starting, check the tracker: the step must be `ready`,
and everything it depends on must be `done`.

## Global Constraints (apply to every step)
- **Scope:** change only cgremlin (`~/context-gremlin`) and my personal `~/.claude`. **Never** change team repos (grace, grace-frontend, web-fastcar).
- **Protected actions** need my explicit approval: opening a PR for review, merging, approving, and posting review findings on others' PRs (R112). Commit, push to own branches and draft PRs are fine.
- **TDD** for behaviour; `pnpm test`, `pnpm typecheck` and `pnpm lint` pass in `cgremlin/core` and `cgremlin/vscode` before any release.
- **Isolation:** each step works in a worktree under `.claude/worktrees/<step-id>` on a branch named **`step/<step-id>`**, never `cgremlin-<id>`, which is reserved for release tags (a same-named branch and tag make `git push` fail with "matches more than one"). Branch from `mission-control-pr-orchestrator` (`main` is stale, 631 commits behind). **Commit frequently.** Push with explicit refs: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-<id> refs/tags/cgremlin-<id>`. **The release ends with cleanup**: remove the worktree, delete the merged `step/<id>` branch, update the tracker, then `/exit`. Every step starts in a new session; no `/clear` needed.
- **Release:** the `RELEASES.md` checklist: tag `cgremlin-pre-<id>` + `cgremlin-<id>`, save the `.vsix` to `~/cgremlin-releases/`, add a table row, push branch + tags.
- **Delegate** substantive work to subagents pinned per §17; trivial edits inline (R118). Optimize for **rate limits** (subscription).
- `bin/cgremlin` (legacy) is **frozen** (A5).
- **Every step that adds or changes a skill** ships ≥3 eval scenarios against today's brief as the baseline (A7, `claude plugin eval`); it replaces the brief only if it wins.
- **Never read** `~/.cgremlin/config` or `~/.cgremlin-core*/core.json` into a transcript; they contain secrets.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the model actually used).

## Review Focus (cross-cutting failure modes every step's reviewer checks)
1. **Posting without approval:** any path where a headless run posts or opens, merges or approves a PR. Expected: impossible; only after an explicit ask in a held conversation.
2. **Untrusted text displacing instructions:** long Jira, PR, comment or page text truncating or overriding the brief. Expected: data is capped and delimited; instructions are never cut.
3. **Interrupted runs:** rate limit, laptop sleep or engine restart mid-run. Expected: the run is marked `stopped` and resumes from on-disk state; no half-applied phase is reported done.
4. **Shared local resources:** my own dev server on the port, one Chrome instance, the same worktree. Expected: `needs_input`, never killing my processes.
5. **Claims of verification:** any "verified/fixed/done" not backed by an engine-checked artifact (gate log, sign-off evidence, matching build identity). Expected: shown as ❓, not ✅.

---

## Tracker
| ID | Step | Depends on | Status | Detailed plan | Release tag |
|---|---|---|---|---|---|
| 0a | Review/rereview never auto-post (R110) | — | ✅ done 2026-10-05 | (done before this tracker) | `cgremlin-r110` |
| 0b | Respond-brief truncation + rereview "skip everything else" | — | ✅ done 2026-10-05 | `2026-10-05-cgremlin-0b-respond-brief-and-rereview.md` | `cgremlin-0b` |
| 0c | Headless runs: Jira + PR access made visible; preflight; engine-only Jira | — | ✅ done 2026-10-05 | `2026-10-05-cgremlin-0c-headless-access.md` | `cgremlin-0c` |
| 1 | Harden the development guard; stage-aware profiles | 0c (merged) | ✅ done 2026-10-06 | `2026-10-06-cgremlin-step-1-guard.md` | `cgremlin-1` |
| 1b | `cgremlin` plugin: agents + qa-verify, installed at user level | 1 | ready | — | — |
| P1 | Personal: CLAUDE.md, global git hook, settings cleanup, headed Chrome | — | ready | — | n/a |
| P2 | Personal: trim plugins; install mattpocock-skills + prompt-master | P1 | ready after P1 | — | n/a |
| P3 | Personal + cgremlin: local dev that just works | 1b | blocked on 1b | — | — |
| P4 | Personal: rotate the Jira token; secrets to Keychain | — | **my action** | — | n/a |
| 2 | Foundations: fresh runs, PR detection, per-stage routing, feedback.jsonl | 1 | ready | — | — |
| 3 | Mode `workplan` + lineage grouping in the Work list | 2 | blocked | — | — |
| 4 | Planning chat (grilling → to-spec → to-tickets) + plan gate | 3, P2 | blocked | — | — |
| 5 | **Milestone:** one phase end to end from ▶ | 4 | blocked | — | — |
| 6 | Local live check + engine sign-off + `cgremlin:ui-check` | 5, 1b | blocked | — | — |
| 7 | Run-all, budgets, boot-resume, one worktree per stack | 6 | blocked | — | — |
| 8 | Stacking, auto-restack, integration check, ship modes | 7 | blocked | — | — |
| 9 | Lead chat, `status --json`, proposals, notes | 7 | blocked | — | — |
| 10 | `cgremlin:review` (§19) incl. live verification on previews | 6, 1b | blocked | — | — |
| 11 | Improvement loop UI (💡 Improve, 🧭 Review feedback) | 2, 9 | blocked | — | — |
| 12 | Routing A/B on ~10 real phases; tune §17 | 5 | blocked | — | — |

Status values: `ready`, `ready after X`, `blocked`, `in progress (<date>, branch)`, `in review`, `✅ done <date>`, `my action`.

---

## Step cards

### 0b — Respond-brief truncation + rereview contradiction
**Why:** `renderRespondBrief` (`cgremlin/core/src/pipeline/prompts.ts:~878-884`) puts the threads (untrusted) before
the instructions, then truncates the whole brief at 40k chars, which cuts `## What to write` / `## Posting`,
including the injection-refusal rule. Separately, the rereview prompt (`:~692`) says "if the skill exists, follow its
output — skip everything else", which could skip the REVIEW.md contract and `rereview_summary`.
**Spec:** §13 step 0b; Review Focus #2.
**Done when:**
- [ ] A test reproduces the truncation (e.g. 30 threads × 3 comments × 1.5k chars) and fails today.
- [ ] Only the thread *data* is capped (its own budget, with a "truncated" note). Instructions are never cut and come before the data, or the data moves to a delimited file.
- [ ] The rereview prompt no longer lets a skill skip the output contract, the posting rules or `rereview_summary`, with a test.
- [ ] Released as `cgremlin-0b`.
**Start prompt:** `Run step 0b of the cgremlin program. Read docs/superpowers/plans/2026-10-05-cgremlin-program.md (step 0b card, Global Constraints, Review Focus) and the spec sections it cites. Write the detailed plan with superpowers:writing-plans, show it to me, then execute with superpowers:subagent-driven-development in .claude/worktrees/0b, get a fresh-context review, release per RELEASES.md, and update the tracker.`

### 0c — Headless runs must have Jira + PR access, and say so when they don't
**Card:** `docs/superpowers/plans/2026-10-05-cgremlin-0c-headless-access-card.md` (evidence, Done-when, decisions D1/D2, amendments A–D, start prompt).
**Why:** a linked Jira that fails to load is silently dropped (`pipeline-service.ts:193` → empty `## Ticket`), and the review prompt says "skip Jira and proceed" (`prompts.ts:698`). Your requirement: if a Jira is linked, the run needs it.
**Start:** now (step 1 waits until 0c is released). Use the Start prompt in the card.

### 1 — Harden the development guard; stage-aware profiles
**Why:** the `development` profile (`workspace/permission-guard.ts:~238-244`) denies only `NEVER_POST` and
merge/close, so dev sessions can run `gh pr ready`, `gh pr edit`, `gh api` and force-push today. Profiles are chosen
per session, not per stage.
**Spec:** R92, R112, §0 guard rows.
**Done when:**
- [ ] `development` denies `gh pr ready/edit/merge/close`, `gh api:*` and force-push spellings (`--force`, `-f`); keeps commit, push of its own branch and `gh pr create --draft`. Allow `--force-with-lease` only if a later step needs it (not yet).
- [ ] `PermissionSubject` gains `stage`, so a review or live-check stage running in a dev worktree can't commit or push (pinned tests).
- [ ] The guard header comment and DECISIONS updated; respond, QA and review behaviour unchanged (tests).
- [ ] Released as `cgremlin-1`.
**Start prompt:** same template with step `1`.

### 1b — The `cgremlin` plugin (agents + qa-verify)
**Why:** the 12 agents in `context-gremlin/.claude/agents` only load inside the cgremlin repo, and `qa-verify` was
never installed, so stage sessions in other repos can't use them (A3).
**Spec:** §18 A3, §17 (models), the earlier agent audit (no `tools` lists on executor/ui-driver/ui-pm-evaluator; reviewer on Sonnet; binary verifier verdict).
**Done when:**
- [ ] `context-gremlin/plugin/.claude-plugin/plugin.json`, `agents/` (the 12, each with a third-person description, a `tools` list, an output format, and model/effort per §17; reviewer on Opus; verifier verdict CONFIRMED/REFUTED/UNVERIFIABLE), and `skills/qa-verify/` (single source; the engine reads its contract from there; the fence-sync test is kept).
- [ ] A local marketplace entry; installed at user level; `/cgremlin:qa-verify` resolves in a grace-frontend session (verified); `claude plugin validate` passes.
- [ ] `qaSkillCommand` points to it; the project `.claude/agents` keep working for cgremlin development, or are replaced by the plugin (decided in the step plan).
- [ ] Released as `cgremlin-1b`; RELEASES.md notes the plugin version.

### P1 — Personal setup, part 1 (no cgremlin code)
**Spec:** §21 B8, B10, B11, B12.
**Done when:**
- [ ] `~/.claude/CLAUDE.md`, short: answer first then examples or scenarios; no edits while we're still discussing; back claims with `file:line` or a command; one plain question at a time; commit a checkpoint whenever a step works; delegate substantive work to pinned subagents (R118).
- [ ] A global PreToolUse hook (`~/.claude/hooks/`, wired in `~/.claude/settings.json`; user-level, so it also covers R107 inside cgremlin worktrees): `ask` for `gh pr ready`, `gh pr merge`, `gh pr review`/approve and PR comment posting; `deny` push to main or protected branches and plain `--force`. Tested with sample JSON inputs.
- [ ] `autoMode.environment` (stale PR #1876 block) removed; `~/.claude/settings.local.json` pruned to generic rules (drop the one-off commit messages, PIDs and paths; drop `gh api:*`, `python3:*`, `cd *`, `Read(//Users/…/**)`); a backup kept.
- [ ] `chrome-devtools-visible` launches headed (verified with a screenshot of a visible window).
- [ ] An auth preflight script (`gh auth status` + MCP status) documented.

### P2 — Personal setup, part 2
**Spec:** §21 B9, B13; R100/R106.
**Done when:**
- [ ] Plugins trimmed: PostHog, Sanity, Vercel and Figma enabled per project only where used; `ai-firstify` removed; duplicate MCP servers removed (chrome-devtools ×3 → 1, Atlassian ×4 → 1, PostHog ×2 → 1). `/skill-doctor` before and after, recorded.
- [ ] `mattpocock-skills` installed and pinned (verify the exact install command); repo-writing model-invocable skills denied (`domain-modeling`, `prototype`, `wizard`, `pr`, `improve-codebase-architecture`); `setup-matt-pocock-skills` never run.
- [ ] The public `nidhinjs/prompt-master` v1.8.0 installed as-is; the custom March copy backed up and removed, along with the duplicate `~/.claude/commands/prompt-master.md`.

### P3 — Local dev that just works
**Spec:** §21 B14; R100 (local live check).
**Done when:**
- [ ] The 23 local-dev friction turns analysed; the actual failure causes listed.
- [ ] `cgremlin:local-dev` skill + `cgremlin-core local start|stop` usable from plain sessions, reading `environments.localApp` (URL, port, prereqs, Clerk test user); a port already in use → report, never kill.
- [ ] Verified by starting grace-frontend locally and logging in as a test user from a fresh session.

### P4 — Secrets (my action)
- [ ] I rotate the Jira API token (it was printed into a session transcript on 2026-09-30) and update core.json.
- [ ] Optional: move the Jira token and the Vercel bypass secret to the macOS Keychain (a separate cgremlin step if wanted).

### 2 — Foundations
**Spec:** R90, R91, R116, §17, §18 A6.
**Done when:**
- [ ] `StageRunInput.fresh` (no `--resume`); per-round archive of BRIEF/FEEDBACK.
- [ ] PR detection for development sessions → `session.pr` / `pr_opened`, plus merged/closed reconciliation.
- [ ] `routing.<stage>` config (runner, model, effort, escalate, secondOpinion); the Claude runner passes `--effort` and unsets `CLAUDE_CODE_EFFORT_LEVEL`; the Codex runner passes `-c model_reasoning_effort`.
- [ ] Per-run records `{stage, runner, model, effort, tokens, limitEvents, outcome}`.
- [ ] `~/.cgremlin-core/feedback.jsonl` capture of dismissals and rejected verdicts (no UI yet).

### 3 – 12
Cards for these are written when their dependencies are done, from the spec sections in the tracker
(§2–§12, §19, §20, §17). Each card follows the same shape: Why / Spec / Done when / Start prompt.

---

## Log
| Date | Step | What happened |
|---|---|---|
| 2026-10-06 | — | Cleanup is now part of every release (RELEASES.md step 8). Leftover 0c worktree and `step/0c` branch removed. |
| 2026-10-06 | 1 | Done: `development` denies `gh pr ready/edit`, `gh api` and all force-push spellings; `PermissionSubject.stage` + `development:inspect` / `investigation:development:inspect` profiles (review, rereview, phase_review, live_check can't commit/push); stage runner passes the stage. 4 tasks, each reviewed; fresh whole-branch review merge-ready. Merged `b1a096b`, tagged `cgremlin-pre-1` (`8374d87`) / `cgremlin-1`, `.vsix` saved and installed. Note for a later step: a dev session that ran an inspect stage keeps the inspect settings until its next stage run (conversation claim doesn't refresh dev sessions). Branch + tags not yet pushed. |
| 2026-10-05 | 0c / 1 | Order set: 0c runs now; step 1 starts after 0c is released (it was not started yet). |
| 2026-10-05 | 0c | Unblocked: runs in parallel with step 1 (no code dependency); second to release rebases. |
| 2026-10-05 | 0c | Card proposed by the 0b session; accepted with amendments A–D (engine-only Jira, ticket text fenced, D1 stop + override / D2 gated stages, branch step/0c after step 1). Added to the tracker. |
| 2026-10-05 | 0b | Push failed: the project `.claude/settings.json` denies `git push`, and the branch `cgremlin-0b` collided with tag `cgremlin-0b`. Pushed from outside with explicit refs; the naming rule was added to Global Constraints. |
| 2026-10-05 | 0a | R110 implemented TDD in a worktree (6 commits); fresh review found no blocking issues; follow-ups fixed; merged, tagged `cgremlin-pre-r110` / `cgremlin-r110`, extension rebuilt and installed, branch + tags pushed. |
| 2026-10-05 | — | Master plan created. Spec rev 2 + grilling rounds 1–3 + routing (§17) + review skill (§19) + improvement loop (§20) + personal track (§21) recorded. |
