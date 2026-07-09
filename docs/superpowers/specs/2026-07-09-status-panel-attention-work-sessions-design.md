# Status-Panel Attention States + WORK Sessions Design

**Date:** 2026-07-09
**Status:** Draft
**Builds on:** the Mission-Control status pane (`review_list_grouped` / `--status-pane`), the per-session `.cg_agent_state` hook signal, the WORK-tab model (`create_work_agent_pane`, `work_agent_tab_name`), the tab-jump path (`open_pr_row`), and the investigate/develop/review briefs.

---

## Problem

With many open tabs (PR reviews + investigate/develop work), the user has to walk around every tab to find which agent actually needs them. Two gaps cause this:

1. **WORK (investigate/develop) sessions aren't in the status pane at all** — they live as tiled panes in one `🔨 WORK` tab, with no list entry and nothing to click.
2. **The status pane can't say what an agent needs.** The hook signal (`.cg_agent_state`) only distinguishes `working` from `waiting` — it can't tell "waiting for my input to continue" apart from "done, ready for my review," so the user still has to open the tab to find out.

Goal: the status pane becomes the single place that answers "where do I need to go?" — every session (PR + WORK) shows a clear attention state, and clicking jumps to that exact agent.

---

## Goals

1. **Four attention states, shown per item:** 🔄 Working, ⏸️ Needs your input, ✅ Ready for your review, 🛑 Blocked/error (plus 💤 idle when nothing is declared).
2. **WORK sessions listed in the status pane** with Jira key + Jira summary + a live agent one-liner, and clickable to jump straight to that agent.
3. **One tab per WORK session** (named, like PR reviews) so a click lands on exactly that agent — replacing the single tiled `🔨 WORK` tab.
4. **Attention state on every item** (PR reviews and WORK alike), so ⏸️/✅/🛑 are the only things that pull the user's eye.
5. **Cheap and robust:** reuse the existing hook + tab-jump machinery; no new long-running processes.

---

## Non-goals

- Desktop/OS notifications or sound. The status pane is the surface.
- Per-pane focus inside a tiled tab (obsolete once each WORK session is its own tab; Zellij can't target a pane by name anyway).
- Tracking sub-agents spawned by an agent — only the top-level session agent's state is shown.

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| Attention states | 🔄 Working / ⏸️ Needs input / ✅ Ready to review / 🛑 Blocked (+ 💤 idle default) |
| WORK navigation | One named tab per WORK session (click jumps precisely) |
| Description | Jira summary **and** a live agent one-liner |
| Idle default | An agent that stops without declaring anything shows 💤 idle (not a false "needs you"). PR discussion agents keep today's ⏸️ (waiting = your turn). |

---

## Architecture

### Attention model — two signals, combined

- **Activity signal `.cg_agent_state`** (hook-managed, already exists): `working` written by the `UserPromptSubmit` hook, `waiting` written by the `Stop` hook.
- **Semantic signal `.cg_attention`** (new, agent-declared): one of `needs-input`, `ready`, `blocked`.
- The `UserPromptSubmit` hook is extended to **also clear `.cg_attention`** (`rm -f`), so a new turn wipes stale semantic state and the agent re-declares at its next gate. Both the bash hook definition and its Python `PYSERVER` copy are updated in lockstep.

**Resolver** (in the status renderer) maps the pair to an icon:

| `.cg_agent_state` | `.cg_attention` | Shown |
|---|---|---|
| `working` | (any) | 🔄 Working |
| `waiting` | `blocked` | 🛑 Blocked |
| `waiting` | `ready` | ✅ Ready to review |
| `waiting` | `needs-input` | ⏸️ Needs your input |
| `waiting` | (none) | 💤 idle — but a PR **discussion** agent shows ⏸️ (waiting = your turn) |

Additionally, a PR session whose `review_state` is `failed` shows 🛑 Blocked regardless.

### Agent declares its state

New allowlisted helper: **`cgremlin --agent-state <session> <needs-input|ready|blocked>`** — validates the value and writes it to `<session>/.cg_attention` (compact, single token). Wired into the briefs at the existing gates:

- **Develop:** plan gate → `needs-input`; unsure bot comment → `needs-input`; "tested & comment-clean, notify me" → `ready`; ready gate (waiting for "I'm satisfied") → `needs-input`; a blocker it cannot pass (e.g., preview never deploys, environment broken) → `blocked`.
- **Investigate:** genuine approach/design question → `needs-input`; `FINDINGS.md` complete → `ready`.
- **Review discussion agent:** already implicitly ⏸️ when waiting; no change required, but it may call `ready` when it has surfaced the findings menu.

### Live one-liner

New allowlisted helper: **`cgremlin --agent-note <session> "<text>"`** — writes a short line to `<session>/.cg_note` (truncated to a sane width by the renderer). Briefs call it at milestones: investigate ("tracing X", "root cause found"), develop ("plan ready", "implementing 3/5 — TDD", "tests green, waiting on you"). Optional — shown only if present.

### Jira summary

Store `jira.summary` in `session.json` at session creation (alongside `jira.ticket`), fetched from the same Jira lookup the session already does. The status renderer reads it for the WORK item title. If absent, fall back to the session's focus/branch.

### WORK sessions as one tab each

`create_work_agent_pane` changes from *"go to the single `🔨 WORK` tab and add a tiled pane"* to *"create a named tab per session"* — tab name from `work_agent_tab_name` (`🔍 <JIRA>` investigate / `🔨 <JIRA>` develop), created with the tab-bar plugin and `close_on_exit`, exactly mirroring the PR-review tab creation. `open_pr_row` (the click→jump handler) is extended to accept WORK sessions and `go-to-tab-name` their tab. This reverses the earlier "single tiled WORK tab, all visible at once" decision (navigation precision now outweighs at-a-glance tiling).

### Status pane layout

`review_list_grouped` gains a **`── 🔨 Your work ──`** section after the PR groups, listing each investigate/develop session:

```
🔨 HB-1071 — Create v3 registration workflow shell    ⏸️ Needs your input
   plan ready — waiting on your go-ahead
🔍 HB-1099 — Investigate duplicate-charge report      🔄 Working
   tracing the checkout total path
```

Each row is clickable (jumps to its tab). The attention icon is also rendered on PR-review rows, so the whole panel scans in one pass: ⏸️/✅/🛑 want you; 🔄/💤 don't.

---

## Error handling

- **Missing `.cg_attention`/`.cg_note`:** treated as none → 💤 idle / no one-liner. Never an error.
- **Invalid `--agent-state` value:** the helper rejects it (prints usage, non-zero) and writes nothing, so a typo can't produce a bogus icon.
- **Stale semantic state after a crash:** bounded by the `UserPromptSubmit` clear on the next turn; a dead agent stuck at `waiting`+`ready` simply keeps showing ✅ until closed, which is acceptable.
- **Jira summary unavailable at creation:** fall back to focus/branch; never block session creation.

---

## Components (files changed — `bin/cgremlin` only)

- **Hooks:** extend `UserPromptSubmit` to `echo working > .cg_agent_state; rm -f .cg_attention` — in BOTH the bash hook definition and the Python `PYSERVER` copy (kept in sync; re-run `bash -n` + `ast.parse`).
- **New helpers + dispatch:** `--agent-state <session> <state>` and `--agent-note <session> <text>`; add both to the dashboard-skip guard and to the investigate/develop/review agent allowlists.
- **`review_list_grouped`:** the attention resolver, the `🔨 Your work` section, and the attention icon on PR rows.
- **`create_work_agent_pane`:** one named tab per WORK session (tab-bar + `close_on_exit`), instead of a tiled pane in the shared tab.
- **`open_pr_row`:** accept WORK sessions and jump to their tab.
- **Session creation:** persist `jira.summary`.
- **Briefs:** one `--agent-state`/`--agent-note` line at each existing gate/milestone in the investigate and develop `CLAUDE.md` templates.

---

## Verification

`bash -n bin/cgremlin` + `ast.parse` on the extracted `PYSERVER`. Functional: (1) simulate the resolver — write each `.cg_agent_state`/`.cg_attention` combo into a temp session and confirm the rendered icon; (2) confirm `--agent-state`/`--agent-note` write the expected files and reject bad input; (3) confirm a new WORK session opens its own named tab and appears in the `🔨 Your work` section with its Jira summary; (4) confirm clicking a WORK row jumps to its tab. A live check: start one investigate session, watch it move 🔄 → ⏸️ (at a question) → ✅ (FINDINGS.md done) in the panel.
