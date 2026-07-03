# Review Agent Floating Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "PR Reviews" tab+glow approach with per-PR floating Zellij panes that contain pre-warmed claude agents, auto-created when a review is ready and persisted across hide/show cycles.

**Architecture:** The `ensure_agent_panes()` function runs every ~2s (via `review_list_grouped` which fzf polls) and creates hidden floating panes for any `review_state=ready` session without a live agent process. `open_pr_row()` becomes a one-liner that shows the floating layer. Posting helpers leave the pane open; the watch daemon kills it on session delete.

**Tech Stack:** bash, Zellij 0.43.1, Claude Code CLI (`claude`), `jq`, `kill -0` for PID liveness

## Global Constraints

- All changes are in `bin/cgremlin` only — one file, ~12700 lines
- Always run `bash -n bin/cgremlin` after every edit to verify syntax
- Session fields accessed via `read_session_field DIR FIELD` / `update_session_field DIR FIELD VALUE`
- PR session fields: `pr.number`, `pr.author`, `pr.title`, `pr.url`, `pr.head`, `pr.base`
- State helpers: `read_review_state DIR`, `read_lifecycle DIR`, `read_rereview_pending DIR`, `read_triage_state DIR`
- `SESSIONS_DIR` is the cgremlin sessions directory (e.g. `~/.cgremlin/sessions`)
- `MODEL` is the configured claude model (e.g. `sonnet`)
- Floating panes are created with `zellij action new-pane --floating` — only works when `ZELLIJ` env var is set (inside a Zellij session)
- `ensure_agent_panes` only creates a pane when: `review_state=ready` AND (`lifecycle=none` OR `rereview_pending=true`)
- Pane liveness: `kill -0 $(cat SDIR/agent_pid) 2>/dev/null`
- Remove `SESSIONS_DIR/.tab2_open` references — dedup is no longer needed

---

### Task 1: `create_review_agent_pane()` — spawn hidden floating agent pane

**Files:**
- Modify: `bin/cgremlin` — add two new functions before `open_pr_row` (currently line 363)

**Interfaces:**
- Produces: `create_review_agent_pane SESSION_DIR` — creates floating pane, writes PID to `SESSION_DIR/agent_pid`
- Produces: `ensure_agent_panes` — idempotent check-and-create for all sessions that need a pane

- [ ] **Step 1: Write a failing syntax-check test for the new functions**

```bash
# Verify the functions don't exist yet
grep -n "^create_review_agent_pane\|^ensure_agent_panes" bin/cgremlin
# Expected: no output (functions not yet defined)
```

- [ ] **Step 2: Add `create_review_agent_pane()` and `ensure_agent_panes()` before `open_pr_row` (line 363)**

Find the comment line just before `open_pr_row`:
```
# Open a PR review into the PRs tab (creates glow + agent pane row).
# Usage: open_pr_row <session-name>
open_pr_row() {
```

Replace that comment block with:
```bash
# Create a hidden floating Zellij pane running a claude agent for this PR session.
# Writes the agent PID to SESSION_DIR/agent_pid (exec preserves PID across bash→claude).
# No-op if called outside a Zellij session.
# Usage: create_review_agent_pane SESSION_DIR
create_review_agent_pane() {
    local SDIR="$1"
    [ -d "$SDIR/repo" ] || return 1
    [ -n "$ZELLIJ" ] || return 0

    local num author
    num=$(read_session_field "$SDIR" "pr.number")
    author=$(read_session_field "$SDIR" "pr.author")
    local pane_name="PR #${num} · @${author}"

    # Merge posting-command permissions into settings.local.json (idempotent).
    local sf="$SDIR/repo/.claude/settings.local.json"; mkdir -p "$SDIR/repo/.claude"
    local add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
    if [ -f "$sf" ]; then
        jq --argjson add "$add" '.permissions.allow = ((.permissions.allow // []) + $add | unique)' "$sf" > "$sf.tmp" && mv "$sf.tmp" "$sf"
    else
        printf '{"permissions":{"allow":%s}}\n' "$add" > "$sf"
    fi

    # Write opening context so the agent starts oriented without the user explaining.
    local pr_title pr_url pr_head
    pr_title=$(read_session_field "$SDIR" "pr.title")
    pr_url=$(read_session_field "$SDIR" "pr.url")
    pr_head=$(read_session_field "$SDIR" "pr.head")
    cat > "$SDIR/AGENT_CONTEXT.md" <<CTX
# PR Review Agent — PR #${num}: ${pr_title}

Author: @${author}
Branch: ${pr_head}
URL: ${pr_url}

REVIEW.md in this directory contains the full automated pre-review findings.
Read REVIEW.md first, then help the user understand the analysis, explore the code, and answer questions.

When the user is ready to post:
1. Confirm the type explicitly (Approve / Comment / Request-changes).
2. Write the review body to .review_body.md in this directory.
3. Run: cgremlin --comment-pr $(basename "$SDIR")
   or:  cgremlin --approve-pr $(basename "$SDIR")
   or:  cgremlin --request-changes-pr $(basename "$SDIR")
CTX

    # Wrapper: write own PID then exec-replace with claude.
    # exec preserves the PID, so agent_pid stays valid after the switch.
    local wrapper; wrapper=$(mktemp /tmp/cgremlin-agent-XXXXXX)
    cat > "$wrapper" <<WRAPPER
#!/bin/bash
echo \$\$ > "$SDIR/agent_pid"
exec claude --model "$MODEL" --add-dir "$SDIR" --cwd "$SDIR/repo"
WRAPPER
    chmod +x "$wrapper"

    zellij action new-pane --floating --name "$pane_name" -- bash "$wrapper" 2>/dev/null || true
}

# For each session that should have a floating agent pane but doesn't, create one.
# Should-have conditions: review_state=ready AND (lifecycle=none OR rereview_pending=true).
# Usage: ensure_agent_panes  (no args; uses SESSIONS_DIR)
ensure_agent_panes() {
    [ -n "$ZELLIJ" ] || return 0
    local d pid pid_file lc rp
    for d in "$SESSIONS_DIR"/pr-*; do
        [ -d "$d/repo" ] || continue
        [ "$(read_triage_state "$d")" = "done" ] && continue
        [ "$(read_review_state "$d")" = "ready" ] || continue
        lc=$(read_lifecycle "$d")
        rp=$(read_rereview_pending "$d")
        # Skip sessions in "waiting for response" state (no pane needed).
        if [ "$lc" != "none" ] && [ "$rp" != "true" ]; then
            continue
        fi
        pid_file="$d/agent_pid"
        pid=$(cat "$pid_file" 2>/dev/null)
        if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
            rm -f "$pid_file"
            create_review_agent_pane "$d"
        fi
    done
}

# Show the floating agent pane for a session. If the pane is not alive, recreate it first.
# Usage: open_pr_row <session-name>
open_pr_row() {
    local session_name="$1"
    local SDIR="$SESSIONS_DIR/$session_name"
    [ -d "$SDIR/repo" ] || { echo "ERROR: repo missing for $session_name" >&2; return 1; }

    local pid pid_file="$SDIR/agent_pid"
    pid=$(cat "$pid_file" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$pid_file"
        create_review_agent_pane "$SDIR"
        sleep 0.5
    fi

    zellij action toggle-floating-panes 2>/dev/null || true
}
```

- [ ] **Step 3: Remove the old `open_pr_row` body**

Delete everything from the old `open_pr_row() {` opening brace through its closing `}` — it is fully replaced by the new version above. The new `open_pr_row` definition is included in Step 2.

- [ ] **Step 4: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
# Expected: OK
```

- [ ] **Step 5: Verify functions exist**

```bash
grep -n "^create_review_agent_pane\|^ensure_agent_panes\|^open_pr_row" bin/cgremlin
# Expected: three lines, in order, before line 470 or so
```

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: add create_review_agent_pane, ensure_agent_panes, rewrite open_pr_row for floating pane UX"
```

---

### Task 2: Hook `ensure_agent_panes` into the 2s status pane refresh cycle

**Files:**
- Modify: `bin/cgremlin` — `review_list_grouped()` (currently line 313)
- Modify: `bin/cgremlin` — `mc_startup_sweep()` (currently line 289)

**Interfaces:**
- Consumes: `ensure_agent_panes` from Task 1
- Produces: floating panes are created within 2s of a session becoming ready, without any manual trigger

- [ ] **Step 1: Add `ensure_agent_panes` call at the top of `review_list_grouped`**

Find the start of `review_list_grouped()`:
```bash
review_list_grouped() {
  local review="" rereview="" response=""
```

Change to:
```bash
review_list_grouped() {
  ensure_agent_panes
  local review="" rereview="" response=""
```

- [ ] **Step 2: Add `ensure_agent_panes` call in `mc_startup_sweep`**

Find `mc_startup_sweep()`:
```bash
mc_startup_sweep() {
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d" ] || continue
    [ "$(read_triage_state "$d")" = "done" ] && continue
    detect_interrupted "$d"
    auto_drop_merged "$d"
  done
}
```

Change to:
```bash
mc_startup_sweep() {
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d" ] || continue
    [ "$(read_triage_state "$d")" = "done" ] && continue
    detect_interrupted "$d"
    auto_drop_merged "$d"
  done
  ensure_agent_panes
}
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 4: Manual test — verify `ensure_agent_panes` is called**

```bash
# Temporarily add a trace to ensure_agent_panes to confirm it runs:
# (do NOT commit this — just verify, then remove the trace)
# In a Zellij session, run:
ZELLIJ=1 bash -c 'source bin/cgremlin --lib-only 2>/dev/null; ensure_agent_panes; echo "ensure ran"'
# Expected: "ensure ran" (no crash)
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: call ensure_agent_panes on startup and every 2s via review_list_grouped"
```

---

### Task 3: `--rereview-pr` writes `rereview_summary` on completion

**Files:**
- Modify: `bin/cgremlin` — `rereview_pr()` (currently line 12533)

**Interfaces:**
- Produces: `SESSION_DIR/rereview_summary` — one-line string, e.g. `✅ 3/3 resolved` or `⚠️ 1/3 resolved, 2 new`
- Consumed by: Task 4 (`review_list_grouped` display)

- [ ] **Step 1: Locate the rereview claude prompt inside `rereview_pr()`**

```bash
grep -n "Re-review this PR INCREMENTALLY" bin/cgremlin
# Note the line number — the prompt is in a heredoc inside rereview_pr()
```

- [ ] **Step 2: Add summary-writing instruction to the rereview prompt**

Find the end of the claude prompt string (the line before `--permission-mode acceptEdits`). The prompt currently ends with `...do NOT post anything to GitHub."`. Add a final instruction:

```
Do NOT post anything to GitHub. As the very last action, write a single line to the file rereview_summary in the session directory ($(basename "$SESSION_DIR") inside $SESSIONS_DIR). Format: '✅ N/N resolved' if all prior findings are resolved, or '⚠️ K/N resolved, M new' otherwise. Write only that line — no other content."
```

The full prompt argument becomes (find the `-p "..."` block in the wrapper heredoc and append):

```bash
  claude -p "Re-review this PR INCREMENTALLY. REVIEW.md already contains the prior Findings Tracker; findings marked 'posted' were sent to the author as comments. For EACH prior finding decide Resolved or Still-open and update its Status in the tracker. Then review only the commits added since the last review for NEW issues and add them. Update REVIEW.md IN PLACE — keep the existing Findings Tracker and append a new Review History row (version, date, commit, action='re-review'). Do NOT rewrite from scratch and do NOT lose prior findings. Proceed autonomously; do NOT ask for confirmation; do NOT post anything to GitHub. As the very last action, write a single line to the file $SESSION_DIR/rereview_summary. Format: '✅ N/N resolved' if all prior findings are resolved, or '⚠️ K/N resolved, M new' otherwise. Write only that line — no other content." \
```

- [ ] **Step 3: Clear `rereview_summary` at the start of each rereview run**

At the top of `rereview_pr()`, after the `[ -d "$REPO_DIR" ]` guard, add:

```bash
rm -f "$SESSION_DIR/rereview_summary"
```

So stale summaries don't linger if the new rereview fails to write one.

- [ ] **Step 4: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: rereview-pr writes rereview_summary on completion"
```

---

### Task 4: Show `rereview_summary` in the status pane for re-review entries

**Files:**
- Modify: `bin/cgremlin` — `review_list_grouped()` (currently line 313)

**Interfaces:**
- Consumes: `SESSION_DIR/rereview_summary` from Task 3
- Produces: re-review entries show inline summary, e.g. `PR #1626  @granttuttle  ✅ ready  ·  ✅ 3/3 resolved`

- [ ] **Step 1: Locate the rereview line-building code in `review_list_grouped`**

Find:
```bash
    elif [ "$rp" = "true" ]; then
      rereview="${rereview}${line}\trereview"$'\n'
```

- [ ] **Step 2: Append `rereview_summary` to the rereview display line**

Replace that block with:

```bash
    elif [ "$rp" = "true" ]; then
      local summary; summary=$(cat "$d/rereview_summary" 2>/dev/null)
      local reline="$line"
      [ -n "$summary" ] && reline="${line}  ·  ${summary}"
      rereview="${rereview}${reline}\trereview"$'\n'
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 4: Manual test**

```bash
# Write a fake summary and confirm it appears in the grouped output:
echo "✅ 2/2 resolved" > ~/.cgremlin/sessions/pr-grace-frontend-1626-20260624-163628/rereview_summary
# Also fake rereview_pending=true and lifecycle=commented for the test session
# Then run:
bash bin/cgremlin --review-list-grouped | cat
# Expected: the 1626 PR appears in "Waiting for re-review" with "· ✅ 2/2 resolved" appended
# Clean up:
rm ~/.cgremlin/sessions/pr-grace-frontend-1626-20260624-163628/rereview_summary
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: show rereview_summary inline in re-review status entries"
```

---

### Task 5: Watch daemon kills agent PID before deleting a session

**Files:**
- Modify: `bin/cgremlin` — `watch_daemon_loop()` (currently line 12085)

**Interfaces:**
- Consumes: `SESSION_DIR/agent_pid`
- Produces: agent process is killed before `rm -rf` removes the session directory

- [ ] **Step 1: Locate the delete-on-merge block in `watch_daemon_loop`**

Find:
```bash
            if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
                case "$d" in "$SESSIONS_DIR"/pr-*) echo "delete merged $d $(date)" >> "$LOG"; rm -rf "$d";; esac
                continue
            fi
```

- [ ] **Step 2: Kill agent PID before deleting**

Replace with:

```bash
            if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
                case "$d" in "$SESSIONS_DIR"/pr-*)
                    echo "delete merged $d $(date)" >> "$LOG"
                    local _apid; _apid=$(cat "$d/agent_pid" 2>/dev/null)
                    [ -n "$_apid" ] && kill "$_apid" 2>/dev/null || true
                    rm -rf "$d"
                    ;;
                esac
                continue
            fi
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: watch daemon kills agent PID before deleting merged session"
```

---

### Task 6: Clean up stale references to the old tab approach

**Files:**
- Modify: `bin/cgremlin` — orchestrator `CLAUDE.md` in `launch_orchestrator()` (line ~12624)
- Modify: `bin/cgremlin` — review session `CLAUDE.md` template in `generate_claude_md()` (line ~630)

**Interfaces:**
- Produces: orchestrator and agent instructions reference floating pane, not "PRs tab"

- [ ] **Step 1: Update orchestrator CLAUDE.md inside `launch_orchestrator()`**

Find in `launch_orchestrator()`:
```
- Finished reviews appear in the status PICKER; the user clicks one to open it in the PRs tab. If the user asks YOU to open PR N: find its session with `ls "$HOME/.cgremlin/sessions"/pr-*-N-* | tail -1` (newest), then run `cgremlin --open-pr <session-name>`.
```

Replace with:
```
- Finished reviews appear in the status PICKER; the user clicks one to open a floating agent pane. If the user asks YOU to open PR N: find its session with `ls "$HOME/.cgremlin/sessions"/pr-*-N-* | tail -1` (newest), then run `cgremlin --open-pr <session-name>`.
```

- [ ] **Step 2: Update review session CLAUDE.md template in `generate_claude_md()`**

Find in the `review)` case of `generate_claude_md`:
```
- If this session is later opened for discussion, REVIEW.md holds the findings — help the developer analyze and refine them; do not start a new review.
```

Replace with:
```
- This session may be opened as a floating panel for discussion. REVIEW.md holds the findings — help the user understand, refine, and act on them; do not start a new review.
```

- [ ] **Step 3: Remove `.tab2_open` reference cleanup**

Search for any remaining `.tab2_open` references:
```bash
grep -n "tab2_open" bin/cgremlin
```

If any remain outside of the already-replaced `launch_mission_control` block (where it's cleared on fresh start), remove them.

- [ ] **Step 4: Verify syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: update CLAUDE.md templates and remove stale tab2_open references"
```

---

### Task 7: End-to-end manual verification

This task has no code changes — it confirms the full flow works correctly.

- [ ] **Step 1: Start Mission Control fresh**

```bash
cgremlin --mission-control
# Expected: Zellij opens with tab bar showing "MISSION CONTROL"
# Status pane shows the fzf picker with current PR sections
```

- [ ] **Step 2: Verify floating pane is created for a ready PR**

In any pane inside Mission Control:
```bash
ls ~/.cgremlin/sessions/pr-*/agent_pid 2>/dev/null
# Expected: one file per ready PR session
cat ~/.cgremlin/sessions/pr-*/agent_pid
# Expected: a valid PID
kill -0 $(cat ~/.cgremlin/sessions/pr-*/agent_pid) && echo "alive"
# Expected: "alive"
```

Also verify the floating pane exists (invisible):
```bash
zellij action query-tab-names
# Expected: "MISSION CONTROL" (PR Reviews tab is gone; agents are floating panes, not tabs)
```

- [ ] **Step 3: Click a PR and verify the floating pane appears**

Select a ready PR in the status pane fzf picker. Press Enter.
Expected:
- Floating pane appears over Mission Control showing a Claude Code agent
- Pane is named "PR #N · @author"
- Agent has REVIEW.md context (it can answer "what are the findings?")

- [ ] **Step 4: Hide and show**

Press `Alt-f` to hide the floating pane. Expected: Mission Control is visible again.
In status pane, click the same PR again. Expected: floating pane reappears (same conversation).

- [ ] **Step 5: Verify re-review summary display**

Manually write a fake summary for the test session:
```bash
echo "✅ 2/2 resolved" > ~/.cgremlin/sessions/pr-grace-frontend-1626-20260624-163628/rereview_summary
```

In the status pane's fzf view, the 1626 entry in "Waiting for re-review" should show `· ✅ 2/2 resolved`. Clean up:
```bash
rm ~/.cgremlin/sessions/pr-grace-frontend-1626-20260624-163628/rereview_summary
```

- [ ] **Step 6: Verify crash recovery**

Kill the agent process manually:
```bash
kill $(cat ~/.cgremlin/sessions/pr-*/agent_pid)
```

Wait 3-4 seconds (one fzf reload cycle). Check that `agent_pid` is updated with a new PID:
```bash
cat ~/.cgremlin/sessions/pr-*/agent_pid
# Expected: a new (different) PID
kill -0 $(cat ~/.cgremlin/sessions/pr-*/agent_pid) && echo "recreated"
# Expected: "recreated"
```
