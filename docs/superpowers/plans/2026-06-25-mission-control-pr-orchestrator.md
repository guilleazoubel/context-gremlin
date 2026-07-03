# Mission Control + PR Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zellij-based "Mission Control" to cgremlin where an orchestrator Claude fires off many headless PR reviews concurrently, and finished reviews surface as glow-rendered, state-labeled rows you read and refine.

**Architecture:** Extend `bin/cgremlin` (single bash script + embedded Python heredoc). A new `--review-pr` subcommand does Jira-lookup + create-session + launches a backgrounded headless `claude -p` worker that writes REVIEW.md. A status-watcher script owns a two-tab Zellij layout: Tab 1 (orchestrator + live status pane), Tab 2 (stacked per-PR rows = glow REVIEW.md + a bare-pre-spawned discussion Claude). Session state and triage state persist in `session.json` so Tab 2 rehydrates on relaunch.

**Tech Stack:** bash, Python 3 stdlib (embedded HTTP server), Zellij 0.43.1 (`run`, stacked panes, layout KDL), glow 2.1.1, Claude Code CLI (`claude -p`, hooks, `settings.local.json`), `gh`, `jq`.

## Global Constraints

- **macOS only** — uses osascript/iTerm2 AppleScript; Zellij is the new primary path but iTerm2/Terminal.app fallbacks must remain intact.
- **The bash script and embedded Python server must stay in sync** — they share `bin/cgremlin`.
- **After any edit, verify bash with:** `bash -n bin/cgremlin`
- **Python syntax check:** extract the `PYSERVER` heredoc to a temp file and run `python3 -c "import ast; ast.parse(open('FILE').read())"`.
- **Config** lives in `~/.cgremlin/`; sessions in `$SESSIONS_DIR` (default `~/.cgremlin/sessions`).
- **No worktrees** — keep the existing clone-based session mechanism.
- **Pre-approved permissions are mandatory for headless** — headless `claude -p` cannot answer "allow this tool?". Task 3 must land before any headless task (4+).
- **Commit policy (project rule overrides skill default):** Do NOT `git commit` until the user has reviewed and tested locally. Treat each "Commit" step as **"stage with `git add` and request user review"**; the user runs the commit. Branch off `main` before any commit work.

---

## Test Approach (this repo has no unit-test harness)

"Tests" in this plan mean:
1. **Syntax gates** — `bash -n bin/cgremlin`; `ast.parse` on the extracted Python heredoc.
2. **Functional smoke tests** — run the new command/script and assert on observable output (files created, panes opened, JSON fields written). Each is given as an exact command + expected result.

A reusable helper for the Python syntax gate (used in several tasks):

```bash
# scripts/check_pyserver.sh — extract the PYSERVER heredoc and ast.parse it
awk '/^create_dashboard_server_script\(\)/,/^PYSERVER$/' bin/cgremlin \
  | sed -n "/<< 'PYSERVER'/,/^PYSERVER$/p" | sed '1d;$d' > /tmp/pyserver_check.py
python3 -c "import ast,sys; ast.parse(open('/tmp/pyserver_check.py').read()); print('PYSERVER OK')"
```

---

## Task 1: Spike — confirm Zellij launch end-to-end (GATING)

**Goal:** Prove cgremlin can reliably open a new Zellij pane running a command, from both the bash path and the regenerated Python server. No new feature code — this de-risks every later task and fixes the known stale-server bug.

**Files:**
- Modify: `bin/cgremlin` — `start_dashboard_server()` (~line 4331) already recreates `.dashboard_server.py` on every launch; verify and, if needed, force-regenerate.

**Interfaces:**
- Produces: a confirmed-working invocation pattern `zellij run --name "<label>" -- bash <script>` used by Tasks 4, 8.

- [ ] **Step 1: Confirm we are inside Zellij**

Run: `echo "ZELLIJ=$ZELLIJ session=$ZELLIJ_SESSION_NAME"`
Expected: `ZELLIJ=0 session=<name>` (non-empty). If empty, start `zellij` first.

- [ ] **Step 2: Smoke-test the raw launch pattern**

```bash
tmp=$(mktemp /tmp/cgremlin-XXXXXX.sh)
echo 'echo "launch ok: $(date)"; sleep 4' > "$tmp"; chmod +x "$tmp"
zellij run --name "🧪 launch-test" -- bash "$tmp"
```
Expected: a new pane titled "🧪 launch-test" appears and prints "launch ok: …".

- [ ] **Step 3: Force-regenerate the Python dashboard server and confirm it carries the Zellij code**

Run:
```bash
grep -n "get_use_zellij\|zellij', 'run'" bin/cgremlin
# then regenerate by launching cgremlin's dashboard (or call create_dashboard_server_script)
grep -n "zellij" ~/.cgremlin/sessions/.dashboard_server.py
```
Expected: after regeneration, `~/.cgremlin/sessions/.dashboard_server.py` contains the `zellij`/`get_use_zellij` code. (Earlier failure was a stale file generated before the Zellij edits.)

- [ ] **Step 4: Record findings**

Append a short note to the spec's "Step 0" section documenting: pattern confirmed, any flags needed (`--cwd`, `--close-on-exit`), and whether `start_dashboard_server` reliably regenerates. No commit (investigation only) unless a code fix was required — if so, stage and request review.

---

## Task 2: Spike — verify apfm-review runs headless via `claude -p` (GATING)

**Goal:** Confirm `/APFM:apfm-review` produces a REVIEW.md non-interactively with pre-approved permissions. **If this fails, halt and revisit the headless model before proceeding.**

**Files:**
- None (throwaway test against a real session dir).

**Interfaces:**
- Produces: a confirmed headless command template for Task 4:
  `claude -p "<review prompt>" --permission-mode acceptEdits --add-dir <session_dir>` (exact flags finalized here).

- [ ] **Step 1: Create one real PR review session the existing way**

Run (interactive cgremlin → Review, pick any small open PR), or non-interactively:
```bash
CGREMLIN_MODE=review CGREMLIN_URL="<pr-url>" cgremlin --create-session
```
Expected: a session dir under `$SESSIONS_DIR` with `repo/` checked out to the PR branch and a generated `CLAUDE.md`.

- [ ] **Step 2: Pre-approve permissions in that session's repo**

Manually write `repo/.claude/settings.local.json` with `Read(*)`, `Write($SESSION_DIR/**)`, `Bash(gh pr view *)`, `Bash(grep *)`, `Bash(rg *)` (mirrors Task 3's set).

- [ ] **Step 3: Run apfm-review headless**

```bash
cd "<session_dir>/repo"
claude -p "Run /APFM:apfm-review and write findings to REVIEW.md per CLAUDE.md. Do not ask for confirmation." \
  --permission-mode acceptEdits --add-dir "<session_dir>" 2>&1 | tee /tmp/apfm-headless.log
```
Expected: command runs to completion **without** any interactive "allow tool?" stall; `REVIEW.md` is written with findings.

- [ ] **Step 4: Decide gate**

If REVIEW.md is produced cleanly → record the exact working flags in the spec and proceed. If it stalls or the skill is unavailable headless → STOP, report to user, and revise the design (e.g., interactive-pane workers, or a different review driver). Do not start Task 4 until this passes.

---

## Task 3: Pre-approved permissions + hook scaffolding per session

**Goal:** Make every session's `settings.local.json` headless-safe and emit agent state. Update **both** the bash generator and the Python generator (they must stay in sync).

**Files:**
- Modify: `bin/cgremlin` — `setup_output_files()` (~line 1103, bash) where `settings.local.json` is written (~lines 1112–1138).
- Modify: `bin/cgremlin` — Python `setup_output_files`/session-start path (~lines 4937–4965) that writes the same file.
- Create: `bin/cgremlin` embeds a hook script path `$SESSION_DIR/.cg_state` writer (inline, see Step 3).

**Interfaces:**
- Produces: each session repo has `.claude/settings.local.json` with a permission set keyed by session type, plus `Stop`/`UserPromptSubmit` hooks that write `$SESSION_DIR/.cg_agent_state` (values: `working` | `waiting`). Consumed by Task 6 (watcher) and Task 11.

- [ ] **Step 1: Define the permission set (smoke test first)**

Write the intended JSON to a temp file and validate it parses:
```bash
cat > /tmp/perm.json <<'JSON'
{
  "permissions": { "allow": [
    "Read(*)", "Write(SESSION_DIR/**)", "Edit(SESSION_DIR/**)",
    "Bash(gh pr view *)", "Bash(gh pr diff *)", "Bash(grep *)", "Bash(rg *)",
    "Bash(cat *)", "Bash(ls *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
    "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)"
  ]},
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "echo waiting > SESSION_DIR/.cg_agent_state"}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo working > SESSION_DIR/.cg_agent_state"}]}]
  }
}
JSON
python3 -c "import json; json.load(open('/tmp/perm.json')); print('perm json OK')"
```
Expected: `perm json OK`.

- [ ] **Step 2: Update the bash generator**

In `setup_output_files()`, replace the existing `settings.local.json` heredoc so it substitutes the real `$SESSION_DIR` for the `SESSION_DIR` placeholders above. Review sessions keep `Write`/`Edit` scoped to `$SESSION_DIR/**`; fix/dev session types additionally allow `$REPO_DIR/**` (preserve the prompt-optimization Phase 2 distinctions).

- [ ] **Step 3: Update the Python generator to match exactly**

In the Python session-start path, write the identical JSON (same allow list + hooks). Keep the two byte-compatible in intent.

- [ ] **Step 4: Syntax gates**

Run: `bash -n bin/cgremlin` → expect no output. Run the `check_pyserver.sh` helper → expect `PYSERVER OK`.

- [ ] **Step 5: Functional smoke test**

Create a fresh session, then:
```bash
jq '.permissions.allow, (.hooks|keys)' "<session_dir>/repo/.claude/settings.local.json"
```
Expected: the allow list includes `Read(*)` and the hooks object has `Stop` and `UserPromptSubmit`.

- [ ] **Step 6: Stage and request review** (no commit per project rule).

---

## Task 4: `cgremlin --review-pr <n>` subcommand

**Goal:** One non-interactive command the orchestrator calls per PR: Jira-lookup + create review session + launch a backgrounded headless worker, returning immediately.

**Files:**
- Modify: `bin/cgremlin` — add `review_pr_noninteractive()` near the other `*_noninteractive` funcs (~line 11831); add a `--review-pr` case to the top-level arg dispatch (where `--create-session` is handled, ~line 11940+).
- Reuse: `create_pr_session_noninteractive()` (line 11831), `extract_jira_from_branch()` (837), `fetch_jira_ticket()` (627).

**Interfaces:**
- Consumes: confirmed headless command template from Task 2; permission set from Task 3.
- Produces: CLI `cgremlin --review-pr <pr-url-or-number> [repo-url]`. Side effects: a new session dir; a backgrounded worker; session.json gains `review_state` (Task 5). Prints the session name to stdout.

- [ ] **Step 1: Write the worker-launch helper**

Add a function that, given a session dir, writes a wrapper script and launches it backgrounded with logging + state writes:
```bash
launch_headless_review() {
    local SESSION_DIR="$1"; local REPO_DIR="$SESSION_DIR/repo"
    local log_file="$SESSION_DIR/logs/terminal-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$SESSION_DIR/logs"
    local wrapper=$(mktemp /tmp/cgremlin-review-XXXXXX.sh)
    cat > "$wrapper" <<EOF
set_review_state() { update_review_state "$SESSION_DIR" "\$1"; }
update_review_state "$SESSION_DIR" "reviewing"
# Worker prompt + flags confirmed by Task 2 spike. The "proceed autonomously / do not ask"
# clauses defend against apfm-review.md's interactive Step 2 (Jira-fail → stop) and Step 9
# (ask verdict), which MUST be skipped in headless mode. < /dev/null suppresses the stdin warning.
cd '$REPO_DIR' && script -q '$log_file' \
  claude -p "Run /APFM:apfm-review and write the findings to REVIEW.md following CLAUDE.md. Proceed autonomously; do NOT ask for confirmation or a verdict. If Jira/Atlassian MCP is unavailable, skip Jira context and proceed with the diff alone. Do NOT post to GitHub. Write the output to $SESSION_DIR/REVIEW.md." \
  --permission-mode acceptEdits --add-dir '$SESSION_DIR' < /dev/null
rc=\$?
if [ \$rc -eq 0 ] && [ -s '$SESSION_DIR/REVIEW.md' ]; then
  update_review_state "$SESSION_DIR" "ready"
else
  update_review_state "$SESSION_DIR" "failed"
fi
rm -f "$wrapper"
EOF
    chmod +x "$wrapper"
    # source cgremlin so update_review_state is available inside the wrapper subshell
    nohup bash -c "source '$CGREMLIN_SCRIPT_PATH' --lib-only; bash '$wrapper'" \
      >> "$SESSION_DIR/logs/worker.log" 2>&1 &
    update_session_field "$SESSION_DIR" "review_worker_pid" "$!"
}
```
(Note: `--lib-only` is a new no-op early-exit flag added in this step so sourcing cgremlin defines functions without running the menu. Add `[ "$1" = "--lib-only" ] && return 0 2>/dev/null` guard near the top, after function definitions.)

- [ ] **Step 2: Write `review_pr_noninteractive()`**

```bash
review_pr_noninteractive() {
    local pr_input="$1"; local repo_url="${2:-$DEFAULT_PROJECT}"
    CGREMLIN_MODE=review CGREMLIN_URL="$pr_input" \
      local session_name=$(create_pr_session_noninteractive "$pr_input" "")
    [ -z "$session_name" ] && { echo "ERROR: session creation failed" >&2; return 1; }
    local session_dir="$SESSIONS_DIR/$session_name"
    update_review_state "$session_dir" "queued"
    launch_headless_review "$session_dir"
    echo "$session_name"
}
```

- [ ] **Step 3: Wire the arg dispatch**

Add to the top-level case:
```bash
--review-pr) review_pr_noninteractive "$2" "$3"; exit $? ;;
```

- [ ] **Step 4: Syntax gate**

Run: `bash -n bin/cgremlin` → no output.

- [ ] **Step 5: Functional smoke test** (requires Task 2 to have passed)

```bash
name=$(cgremlin --review-pr "<small-pr-url>")
sleep 2 && jq '.review_state, .review_worker_pid' "$SESSIONS_DIR/$name/session.json"
```
Expected: `review_state` is `queued`→`reviewing`; a worker PID is set; after the worker finishes, `REVIEW.md` exists and state is `ready`.

- [ ] **Step 6: Stage and request review.**

---

## Task 5: Session state model — review_state + triage_state

**Goal:** Add the two state fields the whole system reads, plus helper functions, with safe defaults for old sessions.

**Files:**
- Modify: `bin/cgremlin` — near `update_session_field()` (174) / `read_session_field()` (162). Add `update_review_state()`, `read_review_state()`, `update_triage_state()`, `read_triage_state()`.

**Interfaces:**
- Produces:
  - `update_review_state <session_dir> <queued|reviewing|ready|failed|interrupted>`
  - `read_review_state <session_dir>` → string (default `none`)
  - `update_triage_state <session_dir> <open|done>`
  - `read_triage_state <session_dir>` → string (default `open`)
- Consumed by Tasks 4, 6, 8, 12.

- [ ] **Step 1: Implement helpers**

```bash
update_review_state()  { update_session_field "$1" "review_state" "$2"; }
read_review_state()    { read_session_field "$1" "review_state" 2>/dev/null || echo "none"; }
update_triage_state()  { update_session_field "$1" "triage_state" "$2"; }
read_triage_state()    { local v=$(read_session_field "$1" "triage_state" 2>/dev/null); echo "${v:-open}"; }
```

- [ ] **Step 2: Default triage_state at session creation**

In each `create_*_session*` path, set `triage_state=open` when writing `session.json` (or lazily default in `read_triage_state`, already done above).

- [ ] **Step 3: Syntax gate** — `bash -n bin/cgremlin` → no output.

- [ ] **Step 4: Functional smoke test**

```bash
d="$SESSIONS_DIR/<any-session>"
update_review_state "$d" reviewing; read_review_state "$d"   # → reviewing
read_triage_state "$d"                                       # → open (default)
```

- [ ] **Step 5: Stage and request review.**

---

## Task 6: Status-watcher script (Mission Control status pane)

**Goal:** A standalone script that renders a live table of all `open` sessions with PR#, author, and state, refreshing on an interval.

**Files:**
- Create: `bin/cg-watch` (new small bash script; installed alongside cgremlin) — or embed as `cgremlin --status-pane`. Use `cgremlin --status-pane` to keep one file.
- Modify: `bin/cgremlin` — add `--status-pane` dispatch + `render_status_table()`.

**Interfaces:**
- Consumes: `read_review_state`, `read_triage_state`, `session.json` (`pr.number`, `pr.author`), `.cg_agent_state`.
- Produces: CLI `cgremlin --status-pane` (long-running render loop). Consumed by Task 7 layout (runs in the status pane).

- [ ] **Step 1: Implement `render_status_table()`**

```bash
render_status_table() {
  printf '\033[2J\033[H'   # clear
  printf 'MISSION CONTROL — reviews\n\n'
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d" ] || continue
    [ "$(read_triage_state "$d")" = "done" ] && continue
    local num author rstate astate icon
    num=$(read_session_field "$d" "pr.number"); author=$(read_session_field "$d" "pr.author")
    rstate=$(read_review_state "$d"); astate=$(cat "$d/.cg_agent_state" 2>/dev/null)
    case "$rstate" in
      ready) icon="✅ ready";; reviewing) icon="🤔 reviewing";;
      failed) icon="⚠ failed";; interrupted) icon="⏸ interrupted";;
      queued) icon="… queued";; *) icon="$rstate";;
    esac
    [ "$astate" = "waiting" ] && icon="💬 waiting for your input"
    printf '  PR #%s  @%-12s  %s\n' "$num" "${author:-?}" "$icon"
  done
}
```

- [ ] **Step 2: Implement the loop + dispatch**

```bash
status_pane_loop() { while true; do render_status_table; sleep 2; done; }
# dispatch:
--status-pane) status_pane_loop ;;
```

- [ ] **Step 3: Syntax gate** — `bash -n bin/cgremlin`.

- [ ] **Step 4: Functional smoke test**

Run `cgremlin --status-pane` in a pane with at least one `pr-*` session present.
Expected: a table listing each open PR with number, author, and a state icon, refreshing every 2s; `done` sessions absent.

- [ ] **Step 5: Stage and request review.**

---

## Task 7: Zellij Mission Control layout (KDL) + launch entry

**Goal:** A two-tab layout AND a console-UI launch path. Tab 1 = orchestrator pane + status-watcher pane, structured so future daemon panes (scanner, cleanup) drop in as one stanza each. Tab 2 = stacked container for PR rows. A new main-menu entry "🎛️ Mission Control" opens a **new iTerm2 tab** running a **named, re-attachable** Zellij session with this layout. Mission Control is inherently Zellij and ignores the per-session `USE_ZELLIJ` flag.

**Files:**
- Create: `layouts/mission-control.kdl` in the repo; cgremlin copies it to `~/.config/zellij/layouts/` at launch.
- Modify: `bin/cgremlin` — add `launch_mission_control()` + a "🎛️ Mission Control" entry in `main_menu()` (~line 11682).

**Interfaces:**
- Consumes: `cgremlin --status-pane` (Task 6), `cgremlin --orchestrator` (Task 9).
- Produces: `launch_mission_control()`; layout `mission-control`. Session is named `mission-control` (re-attachable via `zellij attach mission-control`), which Task 12 rehydration relies on.

- [ ] **Step 1: Write the layout**

```kdl
layout {
    tab name="MISSION CONTROL" focus=true {
        pane split_direction="vertical" {
            pane name="orchestrator" {
                command "cgremlin"
                args "--orchestrator"
            }
            pane name="status" size="45%" {
                command "cgremlin"
                args "--status-pane"
            }
        }
        // FUTURE daemon panes drop in here as one stanza each (kept commented until built):
        // pane name="scanner"  size="20%" { command "cgremlin"; args "--scan-daemon" }   // sub-project 2
        // pane name="cleanup"  size="15%" { command "cgremlin"; args "--cleanup-daemon" } // future
    }
    tab name="PRs" {
        pane name="placeholder" { command "bash"; args "-c" "echo 'PR rows appear here as reviews finish'; exec bash" }
    }
}
```

- [ ] **Step 2: Implement `launch_mission_control()` + copy-on-launch + menu entry**

```bash
launch_mission_control() {
    # Mission Control is always Zellij, regardless of USE_ZELLIJ.
    command -v zellij >/dev/null || { error "Zellij not installed"; sleep 2; return 1; }
    mkdir -p ~/.config/zellij/layouts
    cp "$(dirname "$CGREMLIN_SCRIPT_PATH")/../layouts/mission-control.kdl" ~/.config/zellij/layouts/ 2>/dev/null \
      || cp "$(cd "$(dirname "$0")" && pwd)/../layouts/mission-control.kdl" ~/.config/zellij/layouts/
    # Open a new iTerm2 tab running a NAMED, re-attachable session with the layout.
    local zj="zellij attach -c mission-control options --default-layout mission-control"
    if [ -d /Applications/iTerm.app ]; then
        osascript -e 'tell application "iTerm" to tell current window to create tab with default profile' \
                  -e "tell application \"iTerm\" to tell current session of current tab of current window to write text \"$zj\""
    else
        eval "$zj"
    fi
}
```
Add a "🎛️ Mission Control" item to `main_menu()` that calls `launch_mission_control`. (Exact `zellij attach` invocation: validate `attach -c <name> options --default-layout` vs `--new-session-with-layout` against the installed Zellij 0.43.1 — use whichever the installed version accepts; `attach -c` creates the session if absent and re-attaches if present.)

- [ ] **Step 3: Functional smoke test**

From the main menu choose "Mission Control" (or run `launch_mission_control`).
Expected: a new iTerm2 tab opens a `mission-control` Zellij session with a MISSION CONTROL tab (orchestrator + status panes) and a PRs tab. Closing the tab and running `zellij attach mission-control` restores it.

- [ ] **Step 4: Stage and request review.**

---

## Task 8: Tab 2 ownership — append rows, glow, bare-pre-spawn, rehydrate

**Goal:** The watcher appends a PR row to Tab 2 when a review turns `ready` (no focus steal), renders REVIEW.md with glow, bare-pre-spawns a cold discussion Claude, and rebuilds rows on launch from `open` sessions.

**Files:**
- Modify: `bin/cgremlin` — extend the status loop (Task 6) with row management; add `open_pr_row()` and `rehydrate_tab2()`.

**Interfaces:**
- Consumes: Task 1 launch pattern; `read_review_state`, `read_triage_state`; glow.
- Produces: per-PR Zellij panes in the "PRs" tab; a tracking file `$SESSIONS_DIR/.tab2_open` listing session names already shown (so rows aren't duplicated).

- [ ] **Step 1: Implement `open_pr_row()`**

```bash
open_pr_row() {
  local d="$1"; local num=$(read_session_field "$d" "pr.number")
  local author=$(read_session_field "$d" "pr.author")
  # left: glow REVIEW.md ; right: cold claude at empty prompt with the session CLAUDE.md
  zellij action new-tab --layout pr-row --name "PR #$num" 2>/dev/null || true
  zellij run --name "PR #$num · @$author · review" -- bash -c "glow -p '$d/REVIEW.md'"
  zellij run --name "PR #$num · @$author · agent" --cwd "$d/repo" -- claude --add-dir "$d"
  echo "$(basename "$d")" >> "$SESSIONS_DIR/.tab2_open"
}
```
**Validate first (untested by spikes):** Task 1 confirmed `zellij run` opens panes but did NOT verify (a) opening a pane into a *specific, non-focused* tab, or (b) `--stacked` behavior. Begin this task with a 5-minute probe of both. If targeting the PRs tab from the background watcher proves unreliable, fall back to: open each PR as its own pane in the focused PRs tab and use fullscreen-zoom toggle instead of stacking. Record which approach works before writing `open_pr_row()`.

- [ ] **Step 2: Hook row creation into the loop**

In `render_status_table`'s iteration, when a session is `ready` and not in `.tab2_open`, call `open_pr_row "$d"`. Guard against focus-steal by not switching tabs after creating panes (do not call `go-to-tab`).

- [ ] **Step 3: Implement `rehydrate_tab2()`**

```bash
rehydrate_tab2() {
  : > "$SESSIONS_DIR/.tab2_open"
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d" ] || continue
    [ "$(read_triage_state "$d")" = "done" ] && continue
    [ "$(read_review_state "$d")" = "ready" ] && open_pr_row "$d"
  done
}
```
Call `rehydrate_tab2` once at status-pane startup before the loop.

- [ ] **Step 4: Syntax gate** — `bash -n bin/cgremlin`.

- [ ] **Step 5: Functional smoke test**

With one `ready` session present, start `cgremlin --status-pane`.
Expected: on launch, a PR row (glow viewer + a cold claude pane) appears in the PRs tab; no tab focus is stolen; restarting does not duplicate the row.

- [ ] **Step 6: Stage and request review.**

---

## Task 9: Orchestrator mode

**Goal:** A `--orchestrator` flag that runs the interactive orchestrator Claude IN ITS PANE (it is the command the layout's `orchestrator` pane runs — NOT a separate menu entry; the menu entry is "Mission Control" from Task 7). It can expand bare PR numbers to URLs and call `cgremlin --review-pr` per PR.

**Files:**
- Modify: `bin/cgremlin` — add `--orchestrator` dispatch + dashboard-skip exclusion; add `launch_orchestrator()`.
- Create (generated at runtime): `$SESSIONS_DIR/.orchestrator/CLAUDE.md`.

**Interfaces:**
- Consumes: Task 4 (`--review-pr`), Task 10 (shared fragment), `DEFAULT_PROJECT` (for number→URL expansion).
- Produces: `cgremlin --orchestrator` (interactive Claude in cwd `$SESSIONS_DIR/.orchestrator` with `--add-dir $SESSIONS_DIR`), run as the layout's orchestrator pane command.

- [ ] **Step 1: Generate the orchestrator CLAUDE.md**

```bash
launch_orchestrator() {
  local odir="$SESSIONS_DIR/.orchestrator"; mkdir -p "$odir/.claude"
  # DEFAULT_PROJECT (e.g. https://github.com/aplaceformom/grace-frontend) lets the orchestrator
  # expand a bare PR number to a full URL, since --review-pr requires a full PR URL.
  cat > "$odir/CLAUDE.md" <<MD
# PR Review Orchestrator
You coordinate PR reviews. Default repo for bare PR numbers: ${DEFAULT_PROJECT:-(unset — require full URLs)}.
When the user gives PR numbers or links:
- Expand a bare number N to "\${DEFAULT_PROJECT}/pull/N" (strip any trailing .git). If DEFAULT_PROJECT is unset, ask for a full URL.
- For each PR, run: \`cgremlin --review-pr <full-pr-url>\` (creates the session + launches a headless review). Report "#<n> queued".
- Do NOT run reviews yourself. Do NOT post GitHub comments.
- Finished reviews appear in the status PICKER; the user clicks one to open it in the PRs tab. If the user asks YOU to open PR N: find its session with \`ls "\$HOME/.cgremlin/sessions"/pr-*-N-* | tail -1\` (newest), then run \`cgremlin --open-pr <session-name>\`.
- When asked about a specific PR, summarize from its REVIEW.md. To dismiss one: \`cgremlin --dismiss-pr <session-name>\`.
- Follow PRINCIPLES.md.
MD
  # pre-approve only the commands it needs
  cat > "$odir/.claude/settings.local.json" <<JSON
{ "permissions": { "allow": ["Bash(cgremlin --review-pr *)", "Bash(cgremlin --open-pr *)", "Bash(cgremlin --dismiss-pr *)", "Bash(ls *)", "Read(*)"] } }
JSON
  cd "$odir" && claude --model "$MODEL" --add-dir "$SESSIONS_DIR"
}
```

- [ ] **Step 2: Wire dispatch (no menu entry — Task 7's Mission Control entry is the launcher)**

Add `--orchestrator) launch_orchestrator; exit $? ;;` to arg dispatch, and add `--orchestrator` to the dashboard-lifecycle skip guard (like `--review-pr`/`--lib-only`). Do NOT add a separate menu item.

- [ ] **Step 3: Syntax gate** — `bash -n bin/cgremlin`.

- [ ] **Step 4: Functional smoke test**

Run `cgremlin --orchestrator`; tell it "review <pr-url>".
Expected: it runs `cgremlin --review-pr <pr-url>`, reports queued; the status pane shows the new PR transitioning states.

- [ ] **Step 5: Stage and request review.**

---

## Task 10: Shared engineering-principles fragment + discussion CLAUDE.md

**Goal:** One reusable principles fragment injected into reviewer and discussion prompts; a discussion-tailored CLAUDE.md for the per-row agent.

**Files:**
- Create (generated): `$SESSION_DIR/PRINCIPLES.md` written at session creation; reviewer and discussion CLAUDE.md reference it.
- Modify: `bin/cgremlin` — `setup_output_files()` writes `PRINCIPLES.md`; reviewer CLAUDE.md generation references it; add discussion CLAUDE.md variant used by Task 8's agent pane.

**Interfaces:**
- Consumes: nothing new.
- Produces: `PRINCIPLES.md` (shared), discussion `CLAUDE.md` content.

- [ ] **Step 1: Write PRINCIPLES.md content**

```bash
write_principles() {
  cat > "$1/PRINCIPLES.md" <<'MD'
# Engineering Principles (shared)
- No hacks or workarounds; prefer correct, maintainable solutions.
- Optimize for readability and long-term maintainability.
- Consider scalability and performance implications.
- Follow existing patterns and conventions in the codebase.
- YAGNI — do not over-engineer; solve the actual problem.
MD
}
```
Call `write_principles "$SESSION_DIR"` in `setup_output_files()`.

- [ ] **Step 2: Reference it from reviewer + discussion prompts**

Reviewer CLAUDE.md: add line "Follow PRINCIPLES.md." Discussion CLAUDE.md (written for the row agent): 
```bash
# discussion CLAUDE.md = PR/Jira context + this:
# "REVIEW.md holds the findings. Help the developer analyze them, answer
#  questions, weigh tradeoffs, and refine REVIEW.md in place. Follow PRINCIPLES.md."
```
The row agent in Task 8 uses the session's existing CLAUDE.md; add a `DISCUSSION.md` the agent is told to read, or append the discussion role to CLAUDE.md guarded by review_state. Simplest: append the discussion role block to CLAUDE.md when state becomes `ready`.

- [ ] **Step 3: Syntax gate** — `bash -n bin/cgremlin`.

- [ ] **Step 4: Functional smoke test**

Create a session; confirm `PRINCIPLES.md` exists and reviewer `CLAUDE.md` references it.
```bash
ls "<session_dir>/PRINCIPLES.md" && grep -c "PRINCIPLES.md" "<session_dir>/CLAUDE.md"
```
Expected: file present; grep count ≥ 1.

- [ ] **Step 5: Stage and request review.**

---

## Task 11: Title-bar state via hooks

**Goal:** Reflect `working`/`waiting` agent state on the row's agent pane title and in the status table, driven by the hooks from Task 3.

**Files:**
- Modify: `bin/cgremlin` — status loop reads `.cg_agent_state` (already wired in Task 6 Step 1); add a rename of the agent pane title when state changes (best-effort).

**Interfaces:**
- Consumes: `.cg_agent_state` (Task 3 hooks).
- Produces: visible `💬 waiting for your input` on the status table and (best-effort) the agent pane title.

- [ ] **Step 1: Confirm hook writes occur**

In a session repo with the Task 3 settings, run an interactive `claude`, send one message, let it finish.
```bash
cat "<session_dir>/.cg_agent_state"
```
Expected: `working` while responding, `waiting` after it stops.

- [ ] **Step 2: Verify status table reflects it**

With that session open and `--status-pane` running, after the agent goes idle the row shows `💬 waiting for your input` (logic already in Task 6 Step 1).
Expected: icon switches to waiting.

- [ ] **Step 3: Best-effort pane title update**

If feasible from the watcher, `zellij action rename-pane` is not reliably targetable cross-pane; document that the **status table** is the source of truth for state and the pane title is set once at creation. (No code if not reliably targetable — record the limitation.)

- [ ] **Step 4: Stage and request review** (if any code changed).

---

## Task 12: Persistence finishing — interrupted detection + auto-drop on merge

**Goal:** On rehydrate, mark dead `reviewing` workers as `interrupted`, and auto-set `triage_state=done` for PRs merged/closed on GitHub. Add explicit dismiss.

**Files:**
- Modify: `bin/cgremlin` — `rehydrate_tab2()` (Task 8) preamble; add `--dismiss-pr <session>` dispatch; add interrupted + merge checks.

**Interfaces:**
- Consumes: `review_worker_pid` (Task 4), `pr.number`, `gh`.
- Produces: `cgremlin --dismiss-pr <session-name>` (sets triage_state=done); rehydrate side effects.

- [ ] **Step 1: Interrupted detection**

```bash
detect_interrupted() {
  local d="$1"; local pid=$(read_session_field "$d" "review_worker_pid")
  if [ "$(read_review_state "$d")" = "reviewing" ] && ! kill -0 "$pid" 2>/dev/null; then
    update_review_state "$d" "interrupted"
  fi
}
```
Call for each session at the top of `rehydrate_tab2()`.

- [ ] **Step 2: Auto-drop on merge/close**

```bash
auto_drop_merged() {
  local d="$1"; local num=$(read_session_field "$d" "pr.number")
  local proj=$(read_session_field "$d" "project")
  local state=$(gh pr view "$num" --repo "$(echo "$proj" | sed -E 's#.*github.com/([^/]+/[^/.]+).*#\1#')" --json state -q .state 2>/dev/null)
  [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ] && update_triage_state "$d" "done"
}
```
Call for each `open` session at rehydrate (bounded: only at startup, not in the 2s loop).

- [ ] **Step 3: Explicit dismiss**

```bash
--dismiss-pr) update_triage_state "$SESSIONS_DIR/$2" "done"; echo "dismissed $2"; exit 0 ;;
```
The orchestrator can call this on "done with <n>"; add it to the orchestrator's allowed Bash commands in Task 9.

- [ ] **Step 4: Syntax gate** — `bash -n bin/cgremlin`.

- [ ] **Step 5: Functional smoke test**

```bash
# interrupted:
d="$SESSIONS_DIR/<session>"; update_review_state "$d" reviewing; update_session_field "$d" review_worker_pid 999999
# (run rehydrate) → state becomes interrupted
# merged: pick a merged PR's session → after auto_drop_merged, triage_state=done
# dismiss:
cgremlin --dismiss-pr "<session-name>" && read_triage_state "$SESSIONS_DIR/<session-name>"  # → done
```
Expected: each transition as described; dismissed/merged PRs absent from Tab 2 on next rehydrate.

- [ ] **Step 6: Stage and request review.**

---

## Self-Review (completed)

- **Spec coverage:** orchestrator mode (T9), headless workers (T4), pre-approved perms (T3), status pane (T6), Tab 2 rows + glow + bare-pre-spawn (T8), Zellij layout (T7), shared principles + discussion prompt (T10), hooks/state (T3,T11), persistence/triage/interrupted/auto-drop (T5,T12), gating spikes (T1,T2). All spec sections map to a task.
- **Placeholders:** none — every code step shows concrete bash/JSON/KDL.
- **Type/name consistency:** state helpers (`update_review_state`/`read_review_state`/`update_triage_state`/`read_triage_state`) used consistently across T4/T6/T8/T12; `.cg_agent_state` values (`working`/`waiting`) consistent T3↔T6↔T11; `.tab2_open` tracking file consistent T8.
- **Known residual risks (flagged inline, resolved during execution):** Zellij stacked-pane/tab-targeting ergonomics (finalize in T1 findings, used in T8); `--lib-only` sourcing pattern for the worker subshell (T4); cross-pane title rename may be infeasible (T11 documents the status table as source of truth).
