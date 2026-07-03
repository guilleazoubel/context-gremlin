# Review Agent Floating Pane Design
**Date:** 2026-06-30
**Status:** Draft
**Replaces:** PR Reviews tab approach from `2026-06-29-review-lifecycle-v2-design.md` (§4 open_pr_row)
**Builds on:** Review Lifecycle v2 state model (sections, watch daemon, rereview worker, posting helpers)

---

## Problem

Review Lifecycle v2 opened each PR as a `[glow REVIEW.md | claude agent]` row in a dedicated "PR Reviews" Zellij tab. This required navigating away from Mission Control and made it hard to return quickly. The web UI already shows REVIEW.md, so the glow pane is redundant. The agent conversation — not the rendered file — is the real work surface.

The desired UX: click a PR in the status pane → an agent appears as an overlay (floating pane) ready to discuss the review → hide it with a keypress → Mission Control is visible again → come back later and continue the same conversation. Pane lifetime is **per conversation round**, not per PR lifetime.

---

## Lifecycle

### Round 1 — initial review

```
review_state: ready (orchestrator ran --review-pr)
  → orchestrator creates hidden floating pane: claude --add-dir SDIR --cwd REPO
  → saves agent PID to SDIR/agent_pid
  → status pane: "Waiting for review"

User clicks PR → floating layer visible, agent ready
User converses → decides to post
  → agent runs: cgremlin --comment-pr / --request-changes-pr / --approve-pr
  → posting helper: sets lifecycle, records reviewed_sha, updates REVIEW.md
  → floating pane closes (agent exits after posting)
  → SDIR/agent_pid removed
  → status pane: "Waiting for response" (or session deleted on approve)
```

### Author pushes new commits

```
Watch daemon (~60s): detects head != reviewed_sha
  → sets rereview_pending=true
  → launches --rereview-pr (incremental, updates REVIEW.md in place)
    • marks each prior finding: ✅ resolved / ⚠️ still present / 🆕 new issue
    • writes resolution summary to SDIR/rereview_summary
      e.g. "3/3 resolved" or "1 unresolved, 2 new issues"
  → when complete: review_state=ready, orchestrator creates NEW hidden floating pane
  → status pane: "Waiting for re-review · ✅ 3/3 resolved"
                 or "Waiting for re-review · ⚠️ 1 unresolved"
```

### User sees summary and decides

```
All resolved → approve directly from status pane (no agent needed)
  → cgremlin --approve-pr → session deleted
Needs discussion → click → floating pane visible → converse → post → pane closes → repeat
```

### PR merges

```
Watch daemon: rm -rf session, kill $(cat SDIR/agent_pid) if alive
```

---

## Stateless startup / crash recovery

**Never trust in-memory state.** On every orchestrator startup and every ~60s tick, for each session directory:

| Session state | Expected pane | Action |
|---|---|---|
| `review_state=ready`, `lifecycle=none` | Floating pane running | Create if PID missing or dead |
| `review_state=ready`, `rereview_pending=true` (rereview done) | Floating pane running | Create if PID missing or dead |
| `lifecycle=commented/changes-requested`, `rereview_pending` absent | No pane | Kill any stale PID |
| `review_state=reviewing/queued` | No pane | Kill any stale PID |

PID liveness check: `kill -0 $(cat SDIR/agent_pid) 2>/dev/null`

This means if Mission Control restarts, crashes, or the floating pane dies, the orchestrator recreates whatever should exist within one tick (~60s) without any manual intervention.

---

## Components

### 1. `create_review_agent_pane(session_dir)`

New bash function. Called by the orchestrator when a session becomes ready.

- Merges posting-command permissions into `SDIR/repo/.claude/settings.local.json`
- Writes a short prompt file `SDIR/agent_prompt.md` with opening context: PR number, author, branch, and a pointer to REVIEW.md — so the agent starts oriented without the user having to explain anything
- Runs: `zellij action new-pane --floating --name "PR #N · @author" --cwd REPO -- claude --add-dir SDIR`
- Captures the claude process PID, writes to `SDIR/agent_pid`
- Floating layer remains hidden (default Zellij state)

### 2. `open_pr_row()` — show the floating pane

Replaces the current tab-creation logic entirely.

- Reads `SDIR/agent_pid`; if PID is dead or missing → call `create_review_agent_pane()` to recreate
- Shows the floating layer: `zellij action toggle-floating-panes` (only if currently hidden)
- Focus lands on the last-active floating pane (Zellij default); user navigates between panes with `Alt-Tab` if multiple PRs are open simultaneously

### 3. Orchestrator loop enhancement

After each tick, run the stateless startup check (table above) for every session. This is the same loop that already handles watch-daemon duties — add the pane-existence check alongside the GitHub polling.

Two triggers for pane creation:
- `review_state` transitions to `ready` (worker completes)
- Orchestrator tick finds a `ready` session with a dead/missing PID

### 4. `--rereview-pr` worker enhancement

On completion (in addition to existing REVIEW.md update):
- Writes `SDIR/rereview_summary`: one-line human-readable resolution status
  - Format: `✅ N/N resolved` or `⚠️ K unresolved, M new`
- Sets `review_state=ready` (already done)
- Does NOT create the floating pane directly — that's the orchestrator's job on the next tick

### 5. `--review-list-grouped` — status pane display

For sessions in "Waiting for re-review" section: append `rereview_summary` to the display line so the user sees the resolution status at a glance without opening the agent.

### 6. Posting helpers — close pane on post

After `--comment-pr` / `--request-changes-pr` / `--approve-pr` succeeds:
- Remove `SDIR/agent_pid` (pane is expected to close since the claude process exits)
- Floating layer naturally hides when no floating panes remain

### 7. Watch daemon — cleanup on delete

Before `rm -rf SDIR`:
- `kill $(cat SDIR/agent_pid) 2>/dev/null || true`

---

## Keybindings / Navigation

| Action | How |
|---|---|
| Show/hide floating agent | `Alt-f` (Zellij default `toggle-floating-panes`) |
| Switch between agents (multiple PRs) | `Alt-Tab` or directional focus within floating layer |
| Approve directly (all resolved) | New keybind or Enter on the resolved entry in status pane |

---

## Data Flow

```
Orchestrator tick
  → for each session with review_state=ready:
      if agent_pid missing or dead → create_review_agent_pane()

User picks PR (status pane) → open_pr_row()
  → PID alive? if not → create_review_agent_pane()
  → toggle-floating-panes (show)

Agent conversation → user says post
  → agent: cgremlin --comment-pr / --approve-pr
  → posting helper: update state, remove agent_pid
  → agent process exits → floating pane closes

Watch daemon tick
  → head != reviewed_sha → rereview_pending + --rereview-pr
  → rereview done → rereview_summary written, review_state=ready
  → orchestrator tick: creates new floating pane

Watch daemon tick
  → PR merged → kill agent_pid + rm -rf SDIR
```

---

## What Changes vs Review Lifecycle v2

| v2 | This design |
|---|---|
| `open_pr_row` creates "PR Reviews" tab + glow pane + claude pane | `open_pr_row` shows existing floating pane (or creates if dead) |
| Floating pane concept absent | Orchestrator manages per-session floating panes |
| glow pane for REVIEW.md | Web UI only; no glow pane |
| Pane lifetime = PR lifetime | Pane lifetime = conversation round (post = pane closes) |
| No rereview summary in status | `rereview_summary` shown inline in status pane |
| No PID tracking | `SDIR/agent_pid` tracks running agent |

Review Lifecycle v2's state model, three-section picker, watch daemon, `--rereview-pr` worker, and posting helpers all carry over unchanged except the additions noted above.

---

## Error Handling

- **Zellij session gone**: `create_review_agent_pane` fails → orchestrator logs, retries next tick
- **PID file stale** (agent died unexpectedly): orchestrator detects dead PID, recreates pane
- **`--rereview-pr` fails**: `rereview_summary` not written → status pane omits summary line; user can still open agent to read REVIEW.md directly
- **Post fails** (GitHub error): posting helper leaves state unchanged, agent stays open for retry
- **Multiple simultaneous posts** (two PRs): each is an independent session/pane/PID; no shared state

---

## Files Changed

- `bin/cgremlin` only:
  - New: `create_review_agent_pane()`
  - Modified: `open_pr_row()` — show floating pane instead of tab
  - Modified: orchestrator loop — pane-existence check per tick
  - Modified: `--rereview-pr` — write `rereview_summary` on completion
  - Modified: `--review-list-grouped` — append summary to re-review entries
  - Modified: posting helpers — remove `agent_pid` on success
  - Modified: watch daemon delete path — kill agent PID before rm -rf

---

## Build Order

1. `create_review_agent_pane()` + `SDIR/agent_pid` tracking
2. `open_pr_row()` rewrite — show floating pane
3. Orchestrator loop — pane-existence check + creation on ready
4. `--rereview-pr` — write `rereview_summary`
5. `--review-list-grouped` — inline summary display
6. Posting helpers — remove `agent_pid`, pane closes naturally
7. Watch daemon — kill PID before delete
