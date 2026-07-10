# Model Router — Design Spec

**Date:** 2026-07-10
**Project:** context-gremlin (cgremlin)
**Status:** Approved design, pending implementation plan

## Problem

The user works across tasks with very different model needs — mechanical code reading (Haiku-grade), finding-vs-finding matching (Sonnet-grade), investigation/planning (Opus xhigh), execution (Sonnet or Opus) — but the session model handles everything at whatever tier it's set to. Manually switching models per message is not realistic. The result is either overpaying (Opus for trivial reads) or underpowering (Haiku/Sonnet for hard planning).

## Goal

Automatic, per-task model/effort routing: the main session acts as router + synthesizer, delegating all substantive work to subagents whose model and effort are pinned to match the task. Fast where speed matters, strong where judgment matters, with zero manual switching. Initially scoped to this project; portable to others by copying three artifacts.

## Architecture

Three layers, all in this repo:

```
.claude/agents/*.md        ← 12 pinned agent types (model + effort + tools locked per tier)
CLAUDE.md                  ← "Task Routing" section (task → agent-type table + pipelines)
.claude/settings.json      ← UserPromptSubmit hook + autonomy permissions
```

The main session model (Sonnet recommended, but any) never does substantive work itself — it classifies the request, delegates to the right pinned agent type(s), and synthesizes results. Because agent types pin their own model in frontmatter, the executing model always matches the task regardless of session model.

**Portability:** copying `.claude/agents/`, the CLAUDE.md routing block, and the settings hook/permissions entries to another repo graduates the router there.

## Agent roster

Each agent is a `.claude/agents/<name>.md` file with `model` (and reasoning effort, expressed in the agent's instructions) pinned in frontmatter, a tight `description` that routing keys off, and a scoped `tools` list.

| Agent | Model / Effort | Purpose | Tools |
|---|---|---|---|
| `reader` | haiku / low | Read code, trace flows, collect facts, summarize diffs | Read, Grep, Glob, read-only Bash |
| `chore` | haiku / low | Git ops, gh CLI, running tests, mechanical shell chores | Bash, Read |
| `reviewer` | sonnet / high | Find real bugs in a diff or file set | Read, Grep, Glob, read-only Bash |
| `matcher` | sonnet / medium | Match new findings against prior findings; dedup | Read, Grep, Glob |
| `verifier` | sonnet / high | Adversarially verify a finding is real | Read, Grep, Glob, read-only Bash |
| `planner` | opus / xhigh | Investigations, root-causing, ticket planning, architecture | Read-only + WebSearch/WebFetch |
| `executor` | sonnet / high | Implement a well-specified plan | All tools |
| `executor-heavy` | opus / high | Implement plans with unresolved judgment calls | All tools |
| `ui-driver` | sonnet / medium | Drive browser flows; capture screenshots, console, network logs | Browser MCP tools, Read, Write |
| `ui-eng-evaluator` | sonnet / high | Evaluate captured evidence: errors, network, perf, a11y | Read |
| `ui-design-evaluator` | opus / high | Evaluate visual polish, layout, spacing, UX feel | Read |
| `ui-pm-evaluator` | opus / high | Evaluate user-problem fit, edge cases, flow sense | Read, browser tools |

Rationale for non-obvious picks:

- **Review is Sonnet, not Haiku** — spotting subtle bugs is judgment. Haiku gathers context; Sonnet judges.
- **UI driving is Sonnet, not Haiku** — browser tools misfire (stale snapshots, timing); recovery takes real reasoning. Haiku retry-loops cost more than they save.
- **Design/PM evaluation is Opus** — aesthetic and user-modeling judgment is where smaller models are weakest; they approve things that aren't right.
- **Read-only tool scoping on cheap tiers is a safety property** — a Haiku agent can never accidentally edit code.

## Routing rules (CLAUDE.md `## Task Routing` block)

**Dispatch rule:** for every substantive request, pick the agent type(s) from the table and delegate. Answer inline only for: conversational turns, trivial questions answerable from context already in the session, or a single quick file edit.

**Task table** (task → agent):

| Task | Route to |
|---|---|
| Reading code, tracing flows, collecting facts | `reader` |
| Summarizing a diff / PR | `reader` |
| Code review (finding bugs) | Review pipeline (below) |
| Re-review vs prior findings | Re-review pipeline (below) |
| Verifying a single finding | `verifier` |
| Investigation / root-cause / ticket planning | `planner` |
| Executing a plan | `executor` (escalation rule below) |
| Quick one-file obvious fix | inline (main session) |
| Git/gh/test/mechanical chores | `chore` |
| PR comments, human-facing writeups | main session (sonnet-grade synthesis) |
| Second opinion on a plan/approach | `planner` |
| Live UI testing | UI-test pipeline (below) |

**Pipelines:**

- **Review:** `reader`(s) gather context in parallel → `reviewer` finds issues → `verifier` adversarially checks each finding → main session reports.
- **Re-review:** Review pipeline + `matcher` compares findings against the prior REVIEW.md (cgremlin session dir) before reporting, so resolved items aren't re-raised.
- **UI test:** `ui-driver` drives the flow and saves screenshots + console/network logs to a session evidence directory → `ui-eng-evaluator`, `ui-design-evaluator`, `ui-pm-evaluator` run in parallel over the evidence → main session synthesizes one report. Capture-once, evaluate-many: browser MCP tools share one Chrome instance, so evaluators work from captured evidence; only `ui-pm-evaluator` may take a second live-driving pass if it needs to try an alternate flow.

**Executor escalation rule:** default `executor` (sonnet). Use `executor-heavy` (opus) when the plan: contains unresolved judgment calls ("figure out the best way to…"), touches >5 interdependent files, or touches the bash↔Python-heredoc sync in `bin/cgremlin`.

**Failure handling:** if a delegated agent fails or returns garbage, retry once at the same tier, then escalate one tier up. Never silently absorb the work at session tier.

**User override:** an explicit instruction ("do this yourself", "use opus for this") always beats the table.

## Hook

One `UserPromptSubmit` hook in `.claude/settings.json` that injects a one-line reminder each message: routing is active — consult the Task Routing table before doing substantive work in the main session. No classification logic in the hook; the session model judges. Its only job is preventing rule-fade in long sessions.

## Autonomy / permissions

In `.claude/settings.json` (project-level, applies to main session and all subagents):

- `"defaultMode": "acceptEdits"` — edits within the project auto-apply.
- `allow` list: `Read`/`Edit`/`Write` on the project and `~/.cgremlin/**`; the Bash patterns in routine use here (`git *`, `gh pr *`, `bash -n bin/cgremlin`, `bin/cgremlin *`, `python3 *`, `zellij *`), folding in the accumulated entries from `settings.local.json`; browser MCP tools for the UI pipeline.
- **Still gated (asks first):** writes outside the project, destructive patterns (`rm -rf` etc.), `git push`, PR creation, and other outward-facing/publishing actions.

## Testing

1. Verify every agent file is recognized (agents appear in the Agent tool's available types).
2. Live probe per pipeline:
   - small review on a real diff → confirm haiku readers + sonnet reviewer/verifier ran (via transcript);
   - trivial execute task → confirm sonnet executor ran without permission prompts;
   - UI smoke test against the cgremlin dashboard → confirm driver captured evidence and all three evaluators ran on it.
3. Confirm the hook fires (reminder visible in context each message).

## Out of scope

- Changing the main session's model automatically (not possible via hooks; session model is user-controlled).
- Auto-classification inside the hook itself.
- Rollout to other projects (manual copy is the mechanism, later).

## Known limitations (from final review)

- **The deny list signals intent; it is not a hard boundary.** Allowed entries like `Bash(python3 *)` and `Bash(bin/cgremlin *)` can invoke `git push`, deletes, or PR creation via subprocess, bypassing the deny patterns. Acceptable for a single-user dev tool; do not rely on deny as enforcement.
- **"Read-only tiers can never edit code" is instruction-enforced, not tool-enforced, for agents with Bash.** Claude Code has no read-only Bash scope, so `reader`/`chore` could technically write via shell. The tools list still blocks the Edit/Write tools themselves.
