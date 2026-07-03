# Mission Control + PR Orchestrator Design
**Date:** 2026-06-25
**Status:** Draft — pending user review
**Sub-project:** 1 of 3 (this spec). Later sub-projects: (2) auto-scanner, (3) dev/story side.

---

## Problem

Reviewing PRs through cgremlin today is one-at-a-time and hands-on: you drive each session
through the bash menu or web dashboard, watch an interactive Claude work, and tend it. There is
no way to queue many reviews, walk away, and come back to a set of finished reviews ready to read.
There is also no persistent "home" — closing the terminal loses your working arrangement, even
though the session data itself survives on disk.

We want a Zellij-based **Mission Control**: a long-lived home where you hand PRs to an
orchestrator, it fires off **headless** review workers (many concurrent), and finished reviews
surface as nicely rendered rows you read and refine — without babysitting or hunting across tabs.

---

## Goals

1. Queue many PR reviews at once and let them run unattended (headless), then review the results at leisure.
2. A fixed two-tab Zellij layout that is your daily home and survives restarts.
3. See every review's state at a glance — including "this agent is waiting on me" — without clicking.
4. Reuse cgremlin's existing engine (`--create-session`, Jira lookup, REVIEW.md, comment posting, session persistence). This is an extension, not a rebuild.
5. Enforce the same engineering-quality bar (no hacks, maintainability, scalability) across every agent in the system via a shared prompt fragment.

## Non-Goals (deferred to later sub-projects)

- **Auto-scanner** — timer-based discovery of new PRs from chosen authors (sub-project 2).
- **Dev/story side** — the bottom-half orchestrator for picking up stories (sub-project 3).
- **Worktrees** — keep the existing clone-based session mechanism unchanged.
- Changing what apfm-review produces or REVIEW.md's format.

---

## Architecture Overview

Everything extends `bin/cgremlin`. The orchestrator coexists with the existing web dashboard —
both drive the same engine; use whichever fits the moment.

```
┌─ Tab 1: MISSION CONTROL ───────────┐   ┌─ Tab 2: PRs (stacked panes) ───────────────────────┐
│ orchestrator (interactive Claude)  │   │ ▸ PR #123 · @alice · ✅ ready to review            │
│   > review 123 124 125             │   │ ▾ PR #124 · @bob   · 💬 waiting for your input      │
│                                    │   │     ┌ glow REVIEW.md ─────┬ discussion Claude ───┐ │
│ ── status pane (live watcher) ──   │   │     │ ## Findings…        │ (cold pre-spawn;     │ │
│   #123 @alice  ✅ ready             │   │     │ - Critical: …       │  reads REVIEW.md+    │ │
│   #124 @bob    💬 waiting           │   │     │ - High: …           │  Jira on 1st msg)    │ │
│   #125 @alice  🤔 reviewing…        │   │     └─────────────────────┴──────────────────────┘ │
│   #126 @carol  ⚠ failed             │   │ ▸ PR #125 · @alice · 🤔 reviewing…                 │
└─────────────────────────────────────┘   └─────────────────────────────────────────────────────┘
```

---

## Components (all extend cgremlin)

### 1. Orchestrator mode
A new entry in cgremlin's main menu (alongside Review / Investigate / Develop). Selecting it launches a
long-lived **interactive** Claude in the Mission Control pane with a dedicated orchestrator `CLAUDE.md`/skill.
Its only job: parse requests like "review 123 124 125" and, for each PR, call the helper subcommand below.
It never runs reviews itself.

### 2. `cgremlin --review-pr <n>` (new non-interactive subcommand)
The single call the orchestrator makes per PR. It:
1. Does the Jira lookup (existing `fetch_jira_ticket`, ADF parse, branch auto-detect).
2. Creates the session via the existing `--create-session` path (clone + checkout PR branch + generate reviewer `CLAUDE.md`).
3. Launches a **headless review worker** (below), backgrounded, logging to the session log.
4. Returns immediately. The orchestrator reports "#n queued" and moves on.

### 3. Headless review worker
A backgrounded `claude -p "/APFM:apfm-review …"` run in the session's `repo/`. Writes REVIEW.md, updates
the session's review state, and exits. Because it is headless it **cannot answer permission prompts** — it
relies entirely on pre-approved permissions (see Dependencies). A wrapper sets state `reviewing` on start
and `ready`/`failed` on exit.

### 4. Status watcher
A lightweight script running in the Mission Control status pane. It is the single owner of Tab 2. It:
- Reads every session's `session.json` (state, `pr.author`, triage state) and renders the live status table.
- On launch, **rehydrates Tab 2** from sessions whose triage state is `open` (see Persistence).
- On a review flipping to `ready`, appends that PR's row to Tab 2 **without stealing focus**.
- Renders each row's collapsed title bar with `PR #n · @author · <state>`.
- Detects **interrupted** workers (state says `running` but no live process / REVIEW.md incomplete) and marks them so the orchestrator can offer a clean re-review.
- At rehydrate, runs a bounded `gh pr view --json state` per open session to auto-drop merged/closed PRs.

### 5. glow viewer
Each Tab 2 row renders REVIEW.md via `glow` (installed, v2.1.1) for readable Markdown in the terminal.

### 6. Discussion agent (bare pre-spawn, on-demand context)
When a review finishes, a **cold** interactive Claude is pre-spawned in that PR's row, sitting at an empty
prompt with its discussion `CLAUDE.md` already loaded but **no context read yet** — so no token cost and a
clean status signal (no `Stop` fires until you actually talk to it). On your **first message** it reads
REVIEW.md + the Jira ticket and helps you analyze and refine. The process being already up makes the first
interaction snappy; it only costs memory (one Node process per ready PR).

### 7. Per-session hooks for state
cgremlin already writes `.claude/settings.local.json` per session. We add Claude Code hooks there:
- `Stop` hook → agent finished its turn and is idle → write state `waiting` (for your input).
- `Notification`/`UserPromptSubmit` hook → agent is working → write state `working`.
These tiny state writes feed the watcher and the title bars, so "💬 waiting for your input" appears only on
agents that genuinely paused on a question — never on freshly-spawned cold agents.

### 8. Zellij layout (KDL)
A layout file defining the two fixed tabs: Tab 1 (orchestrator pane + status pane), Tab 2 (stacked PR rows).
Stacked panes keep many PRs listed as collapsed title bars while the focused one expands to
`[glow REVIEW.md | discussion Claude]`. Fullscreen-zoom toggle is the fallback if stacking proves fiddly.

---

## Prompt structure (shared quality bar)

Three prompt pieces, so the engineering standard is identical everywhere:

- **Shared engineering-principles fragment** — no hacks/workarounds, maintainability, scalability, readability,
  follow existing patterns, YAGNI/don't over-engineer. Injected into every agent.
- **Reviewer `CLAUDE.md`** = shared fragment + "run apfm-review, write REVIEW.md, scope gate (changed files only)."
- **Discussion `CLAUDE.md`** = shared fragment + PR/Jira context + "REVIEW.md holds the findings; help the dev
  analyze, answer questions, weigh tradeoffs, refine in place."

This is the concrete home for Phase 3 of the prompt-optimization spec ("shared prompt fragments reused across
session types").

---

## Data Flow

1. You → orchestrator (Tab 1): "review 123 124 125".
2. Orchestrator runs `cgremlin --review-pr` per PR → each creates a session and launches a headless worker.
3. Workers run concurrently, write REVIEW.md + state, exit.
4. Watcher renders status (Tab 1) and appends a `ready` row per finished review to Tab 2, with author + state on the title bar. A cold discussion Claude is pre-spawned in each ready row.
5. At your leisure you switch to Tab 2, expand a `ready` row, read the glow-rendered REVIEW.md, and type to the discussion Claude to refine (it reads REVIEW.md + Jira on first message).
6. You mark a PR `done` (or it auto-drops when merged/closed). Done PRs don't rehydrate next launch.

---

## Persistence & Restoration

State already survives on disk (`session.json` + `REVIEW.md` in `~/.cgremlin/sessions/`). Restoration is
rehydration, not re-running.

- **Triage state** — new `session.json` field: `open` (ready/in-progress, still needs me) vs `done`. Only `open` sessions rebuild into Tab 2 on launch.
- **Restore on launch** — watcher enumerates `open` sessions and rebuilds rows with last-known state.
- **Interrupted-worker handling** — `running` with no live process / incomplete REVIEW.md → `interrupted`; orchestrator offers a clean "re-review #n".
- **Done trigger (both):** explicit dismiss ("done with 123" / keybind) **and** auto-drop when `gh pr view --json state` shows the PR merged/closed at rehydrate.

---

## Prerequisite & Dependencies (the risks)

- **Step 0 — fix the Zellij launch end-to-end.** `zellij run` works when invoked directly; the dashboard path failed on a stale generated `.dashboard_server.py`. Confirm headless worker launch + pane creation work reliably before building on it.
- **Pre-approved permissions are mandatory.** Headless Claude can't answer "allow this tool?". This is **Phase 2 of the prompt-optimization spec** — it becomes a hard prerequisite here (Read, Write REVIEW.md, `gh pr view`, grep/rg, etc., pre-approved per session type).
- **Verify apfm-review runs headless** via `claude -p` before committing to the design — the one genuine unknown. Quick throwaway test.
- **Zellij tab-targeting** — appending a pane to Tab 2 from the background watcher needs care (Zellij acts on the focused tab by default). Solve in the plan phase.
- **Bare pre-spawn signal** — verify a cold-launched Claude fires no `Stop` hook (so "waiting" stays meaningful), and bound the number of idle Node processes.

---

## Verification

- Typing "review <3 PRs>" to the orchestrator launches three headless workers concurrently.
- Mission Control status pane shows them transition `reviewing → ready`, each with its `@author`.
- Tab 2 gains three collapsed rows whose title bars show live state; no focus is stolen on completion.
- Expanding a `ready` row shows the glow-rendered REVIEW.md; a cold discussion Claude is present.
- First message to the discussion Claude has REVIEW.md + Jira in context; it helps refine.
- An agent that pauses on a question shows `💬 waiting for your input` on its title bar; a freshly-spawned cold agent does **not**.
- Closing and relaunching Zellij rehydrates Tab 2 with only the `open` PRs; merged/closed PRs are gone; an interrupted review is offered for re-review.
- Zero "allow this tool?" prompts throughout.

---

## Files Changed (anticipated)

- `bin/cgremlin` — new Orchestrator main-menu mode; new `--review-pr` subcommand (create-session + headless launch); status-watcher script; extend `session.json` with triage + review state; add hooks + pre-approved permissions to per-session `settings.local.json`; reviewer/discussion `CLAUDE.md` generation with shared fragment.
- New Zellij layout file (KDL) for the two-tab Mission Control.
- (Depends on) prompt-optimization Phase 2 permissions work landing first.

---

## Build Order

1. **Step 0:** Fix Zellij launch end-to-end + verify apfm-review headless (gating spikes).
2. Land prompt-optimization Phase 2 pre-approved permissions (prerequisite).
3. `--review-pr` subcommand (create + headless worker + state writes).
4. Status watcher + Zellij layout + glow rows (Tab 2 ownership, rehydrate).
5. Orchestrator mode + orchestrator/discussion `CLAUDE.md` + shared fragment.
6. Hooks for `waiting`/`working` state; title-bar rendering.
7. Persistence: triage state, interrupted detection, auto-drop on merge.
