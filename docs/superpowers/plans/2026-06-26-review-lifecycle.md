# Review Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the full PR review lifecycle to Mission Control — live two-section picker, confirmed GitHub posting from the discussion agent (approve/comment/request-changes), and incremental re-review that updates REVIEW.md in place.

**Architecture:** Extend `bin/cgremlin`. A new `lifecycle` field on `session.json` (alongside `review_state`/`triage_state`) drives a two-section, auto-refreshing fzf picker. New non-interactive subcommands (`--review-list-grouped`, `--rereview-pr`, `--approve-pr`, `--comment-pr`, `--request-changes-pr`) are the lifecycle actions; the discussion agent calls the posting ones after confirming with the user. The headless worker still never posts.

**Tech Stack:** bash, Python 3 (embedded PYSERVER heredoc), Zellij 0.43.1, fzf (live `reload` binding), glow, `gh`, `jq`, Claude Code CLI (`claude -p`).

## Global Constraints

- **macOS only**; keep iTerm2/Terminal fallbacks intact.
- **bash script and embedded Python (PYSERVER) must stay in sync** — any `settings.local.json` change goes in BOTH generators.
- After edits: `bash -n bin/cgremlin` must pass; the PYSERVER heredoc must `ast.parse`. Helper:
  ```
  awk '/^create_dashboard_server_script\(\)/,/^PYSERVER$/' bin/cgremlin | sed -n "/<< 'PYSERVER'/,/^PYSERVER$/p" | sed '1d;$d' > /tmp/pyserver_check.py && python3 -c "import ast; ast.parse(open('/tmp/pyserver_check.py').read()); print('PYSERVER OK')"
  ```
- **State field values are a contract** — `lifecycle ∈ {none, commented, changes-requested, approved}`; `review_state ∈ {queued, reviewing, ready, failed, interrupted}`; `triage_state ∈ {open, done}`. Do not invent new strings.
- **Every new `--*` subcommand** must be added to the dashboard-lifecycle skip guard (`if [ "$1" != "--create-session" ] && …`) and dispatched before `main_menu`, never falling through.
- **The headless (re-)review worker NEVER posts to GitHub.** Only the discussion agent posts, only via the `cgremlin --*-pr` helpers, only after confirming the type with the user.
- **Commit policy (project rule):** Do NOT `git commit` or branch. Leave changes in the working tree; the user reviews/tests, then commits. Treat "Stage" steps as `git add` only.
- **mktemp on macOS:** never use a suffix after the `X`s (`mktemp /tmp/foo-XXXXXX`, not `…-XXXXXX.sh`).

---

## Test Approach

"Tests" = (1) syntax gates (`bash -n`, PYSERVER `ast.parse`); (2) functional smoke tests with exact commands + expected output. Where behavior needs a live Zellij/interactive session or real `gh` posting, the step says so and leaves that part for explicit user verification — but each task verifies everything it *can* headlessly (state transitions, list output, generated files), and the re-review task actually runs a real incremental review.

A reusable session for smoke tests: `pr-grace-frontend-1633-*` exists with a real REVIEW.md (state `ready`). Find it with `ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-1633-* | tail -1`. Restore any field you mutate.

---

## Task 1: `lifecycle` state helpers + grouped list generator

**Files:**
- Modify: `bin/cgremlin` — add helpers near the other state helpers (~line 191, after `read_triage_state`); add `review_list_grouped()` near `render_status_table`; add `--review-list-grouped` dispatch + guard exclusion.

**Interfaces:**
- Produces:
  - `update_lifecycle <session_dir> <none|commented|changes-requested|approved>`
  - `read_lifecycle <session_dir>` → string (default `none`)
  - `review_list_grouped()` → stdout lines, tab-delimited `<display>\t<session-or-empty>\t<group>` where group ∈ `reviews|waiting|""`; section-header lines have empty session.
  - CLI `cgremlin --review-list-grouped`.
- Consumed by Task 2 (picker), Task 3/4 (state updates).

- [ ] **Step 1: Add the lifecycle helpers**

```bash
# Update/read lifecycle in session.json (human's posted decision)
# Usage: update_lifecycle SESSION_DIR <none|commented|changes-requested|approved>
update_lifecycle() { update_session_field "$1" "lifecycle" "$2"; }
# Usage: read_lifecycle SESSION_DIR  (default: none)
read_lifecycle()   { local v=$(read_session_field "$1" "lifecycle" 2>/dev/null); echo "${v:-none}"; }
```

- [ ] **Step 2: Add the grouped list generator**

```bash
# Emit one line per open review: "<display>\t<session>\t<group>".
# Section headers are emitted as display-only rows with empty session+group.
review_list_grouped() {
  local reviews="" waiting=""
  local d sname num author rs lc icon line
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d" ] || continue
    [ "$(read_triage_state "$d")" = "done" ] && continue
    sname=$(basename "$d")
    num=$(read_session_field "$d" "pr.number")
    author=$(read_session_field "$d" "pr.author")
    rs=$(read_review_state "$d")
    lc=$(read_lifecycle "$d")
    case "$lc" in
      commented)          icon="💬 commented (Enter to re-review)";;
      changes-requested)  icon="✏️  changes-requested (Enter to re-review)";;
      *) case "$rs" in
           ready) icon="✅ ready";; reviewing) icon="🤔 reviewing";; queued) icon="… queued";;
           failed) icon="⚠ failed";; interrupted) icon="⏸ interrupted";; *) icon="${rs:-none}";;
         esac;;
    esac
    line="$(printf 'PR #%s  @%-14s %s\t%s' "$num" "${author:-?}" "$icon" "$sname")"
    if [ "$lc" = "commented" ] || [ "$lc" = "changes-requested" ]; then
      waiting="${waiting}${line}\twaiting"$'\n'
    else
      reviews="${reviews}${line}\treviews"$'\n'
    fi
  done
  printf '── Reviews ──\t\t\n'
  [ -n "$reviews" ] && printf '%b' "$reviews"
  printf '── Waiting for re-review ──\t\t\n'
  [ -n "$waiting" ] && printf '%b' "$waiting"
}
```
(Note: each data line is built with a real tab via `printf '…\t…'`; the group is appended with a literal `\t` that `printf '%b'` converts to a tab when emitting. Verify tabs are real in Step 5.)

- [ ] **Step 3: Add dispatch + guard exclusion**

Add `--review-list-grouped` to the dashboard-skip guard condition, and add the dispatch block before `main_menu`:
```bash
if [ "$1" = "--review-list-grouped" ]; then
    review_list_grouped
    exit 0
fi
```

- [ ] **Step 4: Syntax gates**

`bash -n bin/cgremlin` (no output). Run the PYSERVER parse helper → `PYSERVER OK`.

- [ ] **Step 5: Functional smoke test (real tabs + grouping)**

```bash
source bin/cgremlin --lib-only
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-1633-* | tail -1)
read_lifecycle "$d"                         # expect: none
update_lifecycle "$d" commented; read_lifecycle "$d"   # expect: commented
bin/cgremlin --review-list-grouped | cat -t  # 1633 row appears under Waiting; tabs show as ^I (real tabs)
# extract session from the 1633 line:
bin/cgremlin --review-list-grouped | grep 1633 | cut -f2   # expect the pr-grace-frontend-1633-* session name
update_lifecycle "$d" none                  # restore
```
Expected: `cut -f2` yields the real session name (proves real tabs); 1633 appears under "Waiting" when `commented`, under "Reviews" when `none`.

- [ ] **Step 6: Stage and request review.**

---

## Task 2: Two-section live-refreshing picker

**Files:**
- Modify: `bin/cgremlin` — replace the body of `status_pane_loop()` (currently builds its own list + single fzf). Keep `mc_startup_sweep` as the first call.

**Interfaces:**
- Consumes: `cgremlin --review-list-grouped` (Task 1), `cgremlin --open-pr` (existing), `cgremlin --rereview-pr` (Task 3), `read_review_state`.
- Produces: the interactive Mission Control status pane (auto-refresh ~2s; Enter routes by group).

- [ ] **Step 1: Rewrite `status_pane_loop`**

```bash
status_pane_loop() {
    mc_startup_sweep
    # cgremlin is on PATH inside the cockpit (launcher exports it). Use it for self-calls.
    while true; do
        local sel sname group rs
        # Live refresh: fzf reloads the grouped list every ~2s via the load->reload loop,
        # so reviewing→ready and lifecycle moves appear without a keypress.
        sel=$(: | fzf --ansi --delimiter='\t' --with-nth=1 \
            --header='Mission Control — Enter: open a ready review / re-review a waiting one' \
            --bind='start:reload:cgremlin --review-list-grouped' \
            --bind='load:reload:sleep 2; cgremlin --review-list-grouped' \
            --bind='double-click:accept' --mouse 2>/dev/null)
        [ $? -ne 0 ] && { sleep 1; continue; }   # Esc/Ctrl-C → loop
        [ -z "$sel" ] && continue
        sname=$(printf '%s' "$sel" | cut -f2)
        group=$(printf '%s' "$sel" | cut -f3)
        [ -z "$sname" ] && continue               # section-header row → no-op
        if [ "$group" = "waiting" ]; then
            cgremlin --rereview-pr "$sname"
        elif [ "$group" = "reviews" ]; then
            rs=$(read_review_state "$SESSIONS_DIR/$sname")
            if [ "$rs" = "ready" ]; then
                cgremlin --open-pr "$sname"
            else
                printf '\033[2J\033[H%s is %s — not ready to open yet.\n' "$sname" "$rs"; sleep 1.5
            fi
        fi
    done
}
```

- [ ] **Step 2: Syntax gate** — `bash -n bin/cgremlin` (no output).

- [ ] **Step 3: Functional smoke test (list feeds fzf; selection mapping)**

Non-interactively confirm the generator + field extraction the picker relies on:
```bash
source bin/cgremlin --lib-only
# header rows have empty field 2 (no-op):
bin/cgremlin --review-list-grouped | sed -n '1p' | cut -f2 | wc -c   # expect 1 (empty + newline)
# a data row maps to a session + group:
bin/cgremlin --review-list-grouped | grep -m1 'PR #' | cut -f2,3
```
Expected: header row's field 2 empty; a data row yields `<session>\t<group>`.

- [ ] **Step 4: USER verification note**

The live auto-refresh and Enter/click routing require the running Mission Control session. In the cockpit: start a review and confirm the status pane shows `reviewing` then `ready` **without pressing a key**; Enter on a ready row opens it; Enter on a Waiting row triggers re-review. Record in the report that this is user-verified. If the `load:reload:sleep 2` loop does not refresh reliably on the installed fzf, fall back to wrapping fzf in a `--bind 'enter:accept'` + outer `timeout 2 fzf || true; regenerate` redraw loop and note the change.

- [ ] **Step 5: Stage and request review.**

---

## Task 3: `--rereview-pr` — incremental re-review

**Files:**
- Modify: `bin/cgremlin` — add `rereview_pr()` near `launch_headless_review`; add `--rereview-pr` dispatch + guard exclusion. Reuses `launch_headless_review`'s wrapper pattern but with a re-review prompt and a git fetch.

**Interfaces:**
- Consumes: `update_review_state`, `update_lifecycle`, existing session clone + REVIEW.md, the confirmed headless flags (`--permission-mode acceptEdits --add-dir … < /dev/null`).
- Produces: CLI `cgremlin --rereview-pr <session-name>`; sets `review_state=reviewing` then `ready`, `lifecycle=none`; updates REVIEW.md in place.

- [ ] **Step 1: Implement `rereview_pr` (git fetch + incremental worker)**

```bash
rereview_pr() {
    local session_name="$1"
    local SESSION_DIR="$SESSIONS_DIR/$session_name"
    local REPO_DIR="$SESSION_DIR/repo"
    [ -d "$REPO_DIR" ] || { echo "ERROR: repo missing for $session_name (archived?)" >&2; return 1; }

    local pr_num; pr_num=$(read_session_field "$SESSION_DIR" "pr.number")
    update_lifecycle "$SESSION_DIR" "none"
    update_review_state "$SESSION_DIR" "reviewing"

    local log_file="$SESSION_DIR/logs/terminal-$(date +%Y%m%d-%H%M%S).log"; mkdir -p "$SESSION_DIR/logs"
    local _src="${BASH_SOURCE[0]:-$0}" _d
    while [ -L "$_src" ]; do _d="$(cd -P "$(dirname "$_src")" && pwd)"; _src="$(readlink "$_src")"; [[ "$_src" != /* ]] && _src="$_d/$_src"; done
    local _cg="$(cd -P "$(dirname "$_src")" && pwd)/$(basename "$_src")"

    local wrapper; wrapper=$(mktemp /tmp/cgremlin-rereview-XXXXXX)
    cat > "$wrapper" <<WRAPPER_EOF
#!/bin/bash
source "$_cg" --lib-only
cd "$REPO_DIR" && git fetch origin "pull/${pr_num}/head" 2>/dev/null && git checkout FETCH_HEAD 2>/dev/null
cd "$REPO_DIR" && script -q "$log_file" \
  claude -p "Re-review this PR INCREMENTALLY. REVIEW.md already contains the prior Findings Tracker; findings marked 'posted' were sent to the author as comments. For EACH prior finding decide Resolved or Still-open and update its Status in the tracker. Then review only the commits added since the last review for NEW issues and add them. Update REVIEW.md IN PLACE — keep the existing Findings Tracker and append a new Review History row (version, date, commit, action='re-review'). Do NOT rewrite from scratch and do NOT lose prior findings. Proceed autonomously; do NOT ask for confirmation; do NOT post anything to GitHub." \
  --permission-mode acceptEdits --add-dir "$SESSION_DIR" < /dev/null
rc=\$?
if [ \$rc -eq 0 ] && [ -s "$SESSION_DIR/REVIEW.md" ]; then update_review_state "$SESSION_DIR" ready; else update_review_state "$SESSION_DIR" failed; fi
rm -f "$SESSION_DIR/.cg_agent_state"
rm -f "$wrapper"
WRAPPER_EOF
    chmod +x "$wrapper"
    nohup bash "$wrapper" >> "$SESSION_DIR/logs/worker.log" 2>&1 &
    update_session_field "$SESSION_DIR" "review_worker_pid" "$!"
    echo "re-reviewing $session_name"
}
```

- [ ] **Step 2: Add dispatch + guard exclusion**

```bash
if [ "$1" = "--rereview-pr" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --rereview-pr <session-name>" >&2; exit 1; }
    rereview_pr "$2"; exit $?
fi
```
Add `--rereview-pr` to the dashboard-skip guard.

- [ ] **Step 3: Syntax gates** — `bash -n` + PYSERVER parse.

- [ ] **Step 4: Functional smoke test (REAL incremental re-review)**

Use a throwaway copy so the real 1633 REVIEW.md is preserved:
```bash
src=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-1633-* | tail -1)
cp "$src/REVIEW.md" /tmp/rr-before.md
wc -l "$src/REVIEW.md"
bin/cgremlin --rereview-pr "$(basename "$src")"          # prints "re-reviewing …"
# poll until terminal state (worker runs ~1-3 min):
for i in $(seq 1 40); do s=$(jq -r .review_state "$src/session.json"); [ "$s" = ready ] || [ "$s" = failed ] && break; sleep 5; done
echo "final review_state=$s"; echo "lifecycle=$(jq -r .lifecycle "$src/session.json")"
grep -c "Review History" "$src/REVIEW.md"   # expect >=1 (history preserved/appended)
```
Expected: `review_state` ends `ready`; `lifecycle=none`; REVIEW.md still present and updated in place (prior findings retained, Review History row added). If acceptable, leave the updated REVIEW.md; otherwise restore `/tmp/rr-before.md`. Note result in report.

- [ ] **Step 5: Stage and request review.**

---

## Task 4: Discussion-agent posting helpers (approve / comment / request-changes)

**Files:**
- Modify: `bin/cgremlin` — add `_pr_repo()`, `approve_pr()`, `comment_pr()`, `request_changes_pr()` near the other session functions; add three dispatch blocks + guard exclusions; update `open_pr_row()` to ensure the discussion agent's `settings.local.json` allows the posting subcommands; update the discussion-agent instructions (the review CLAUDE.md's discussion section).
- Keep BOTH the bash and Python `settings.local.json` generators in sync for the new allow entries.

**Interfaces:**
- Consumes: `update_lifecycle`, `update_triage_state`, `read_session_field`, `gh`.
- Produces: `cgremlin --approve-pr <s>`, `cgremlin --comment-pr <s>`, `cgremlin --request-changes-pr <s>`. Each reads the review body from `$SESSION_DIR/.review_body.md`. Approve also archives (`rm -rf repo`, keep metadata + REVIEW.md) and sets `triage_state=done`.

- [ ] **Step 1: Implement the helpers**

```bash
# owner/repo from session.json .project (https://github.com/OWNER/REPO)
_pr_repo() { read_session_field "$1" "project" | sed -E 's#.*github\.com/([^/]+/[^/.]+).*#\1#'; }

_post_review() {   # $1=session_name  $2=gh-event-flag (--approve|--comment|--request-changes)  $3=success-lifecycle
    local d="$SESSIONS_DIR/$1"; local num repo body
    num=$(read_session_field "$d" "pr.number"); repo=$(_pr_repo "$d")
    body="$d/.review_body.md"; [ -f "$body" ] || { echo "ERROR: $body not found (agent must write the review body first)" >&2; return 1; }
    if gh pr review "$num" --repo "$repo" "$2" --body-file "$body"; then
        update_lifecycle "$d" "$3"; echo "posted $2 for $1"
    else
        echo "ERROR: gh pr review failed for $1 (lifecycle unchanged)" >&2; return 1
    fi
}
approve_pr()          { _post_review "$1" "--approve" "approved" || return 1; local d="$SESSIONS_DIR/$1"; update_triage_state "$d" "done"; rm -rf "$d/repo"; echo "approved+archived $1"; }
comment_pr()          { _post_review "$1" "--comment" "commented"; }
request_changes_pr()  { _post_review "$1" "--request-changes" "changes-requested"; }
```

- [ ] **Step 2: Dispatch + guard exclusions**

```bash
if [ "$1" = "--approve-pr" ];          then [ -z "$2" ] && { echo "Usage: cgremlin --approve-pr <session>" >&2; exit 1; }; approve_pr "$2"; exit $?; fi
if [ "$1" = "--comment-pr" ];          then [ -z "$2" ] && { echo "Usage: cgremlin --comment-pr <session>" >&2; exit 1; }; comment_pr "$2"; exit $?; fi
if [ "$1" = "--request-changes-pr" ];  then [ -z "$2" ] && { echo "Usage: cgremlin --request-changes-pr <session>" >&2; exit 1; }; request_changes_pr "$2"; exit $?; fi
```
Add all three to the dashboard-skip guard.

- [ ] **Step 3: Allow the posting subcommands for the discussion agent**

In `open_pr_row()`, before launching the agent pane, ensure the session's `repo/.claude/settings.local.json` allow-list includes (merge, don't duplicate): `Bash(cgremlin --approve-pr *)`, `Bash(cgremlin --comment-pr *)`, `Bash(cgremlin --request-changes-pr *)`, `Bash(gh pr view *)`, `Bash(gh pr diff *)`. (These let the agent post via the helpers without a permission stall; `Write($SESSION_DIR/**)` already permits writing `.review_body.md`.) Implement as a `jq` merge so existing/older sessions gain the perms when opened:
```bash
# inside open_pr_row, after validating SDIR and before the agent `zellij run`:
local sf="$SDIR/repo/.claude/settings.local.json"; mkdir -p "$SDIR/repo/.claude"
local add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
if [ -f "$sf" ]; then
  jq --argjson add "$add" '.permissions.allow = ((.permissions.allow // []) + $add | unique)' "$sf" > "$sf.tmp" && mv "$sf.tmp" "$sf"
else
  printf '{"permissions":{"allow":%s}}\n' "$add" > "$sf"
fi
```

- [ ] **Step 4: Update the discussion-agent instructions**

In `generate_claude_md`'s review template discussion section (the lines added for "opened for discussion"), append the posting protocol verbatim:
```
When the user decides to act on this PR:
1. Confirm the review TYPE with the user explicitly (Approve / Comment / Request-changes). Never post without confirmation.
2. Write the review body (summary + the specific findings) to .review_body.md in the session root.
3. Post by running ONE of: `cgremlin --approve-pr <SESSION_NAME>` | `cgremlin --comment-pr <SESSION_NAME>` | `cgremlin --request-changes-pr <SESSION_NAME>` (SESSION_NAME is the session directory's basename).
4. Mark the Findings-Tracker IDs you posted as `posted` in REVIEW.md so re-review can verify them.
Approve archives and removes the PR from the panel; comment/request-changes move it to Waiting for re-review.
```
(The session name is available to the agent as the basename of its `--add-dir` session path; the prompt may also state it explicitly — include `$SESSION_NAME` substitution when generating if available, else instruct the agent to derive it.)

- [ ] **Step 5: Syntax gates** — `bash -n` + PYSERVER parse. Validate the merged JSON parses: run Step 6's jq path on a temp copy.

- [ ] **Step 6: Functional smoke test (state + JSON; do NOT post to a real PR)**

```bash
source bin/cgremlin --lib-only
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-1633-* | tail -1)
# _pr_repo parses owner/repo:
_pr_repo "$d"                      # expect: aplaceformom/grace-frontend
# settings merge is idempotent + valid JSON (simulate the open_pr_row block on a temp copy):
cp -r "$d/repo/.claude" /tmp/cl-test && sf=/tmp/cl-test/settings.local.json
add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
jq --argjson add "$add" '.permissions.allow = ((.permissions.allow // []) + $add | unique)' "$sf" > "$sf.tmp" && mv "$sf.tmp" "$sf"
jq '.permissions.allow | map(select(test("approve-pr")))' "$sf"   # expect the approve-pr entry once
rm -rf /tmp/cl-test
```
Expected: `_pr_repo` → `aplaceformom/grace-frontend`; merged allow-list valid JSON containing each posting command exactly once. **Do NOT run a real `gh pr review`** in the test — actual posting is user-verified in the cockpit on a throwaway PR.

- [ ] **Step 7: USER verification note**

In the cockpit: open a ready review, tell the agent to "comment", confirm it asks for type confirmation, then confirm a GitHub Comment review is posted and the card moves to Waiting. Approve on a throwaway PR confirms archive+remove. Record as user-verified.

- [ ] **Step 8: Stage and request review.**

---

## Task 5: REVIEW.md format contract (Findings Tracker + Review History + `posted`)

**Files:**
- Modify: `bin/cgremlin` — `generate_claude_md` review template: guarantee the output format names a **Findings Tracker** table with columns `ID | Finding | Severity | Status | Since`, where `Status ∈ {open, posted, resolved}`, and a **Review History** table `Version | Date | Commit | Action`. This is what `--rereview-pr` (Task 3) and the agent's `posted` marking (Task 4) depend on.

**Interfaces:**
- Consumes: nothing new.
- Produces: a stable REVIEW.md contract used by Tasks 3 and 4.

- [ ] **Step 1: Inspect the current review template**

Read `generate_claude_md` (line ~477) review branch. If it already specifies a Findings Tracker + Review History (per the prompt-optimization spec), only ensure `Status` includes the `posted` value and the re-review action is documented. If absent, add a concise format spec block (no filled-in examples):
```
## REVIEW.md format (required sections)
- At a Glance: Type, Risk, Scope, Verdict
- Findings Tracker table: | ID | Finding | Severity | Status (open/posted/resolved) | Since |
- Open Findings by severity: each with Location, What it does, The issue, Why it matters, Suggested fix
- Resolved Findings
- Verdict (rationale)
- Review History table: | Version | Date | Commit | Action |
On re-review: update Status in place (resolved/still-open), add new findings, append a Review History row. Never drop prior findings.
```
Keep it short; do not expand other prompt content (quality tuning is out of scope).

- [ ] **Step 2: Syntax gates** — `bash -n` + PYSERVER parse.

- [ ] **Step 3: Functional smoke test**

```bash
# Create a fresh review session (or reuse) and confirm the prompt names the tracker + history:
grep -c "Findings Tracker" bin/cgremlin     # expect >=1 in the review template
grep -c "Review History" bin/cgremlin        # expect >=1
```
(Optional, if cheap: run one real `--review-pr` and confirm the produced REVIEW.md contains both tables — otherwise rely on the prompt grep + the Task 3 re-review test which checks `Review History`.)

- [ ] **Step 4: Stage and request review.**

---

## Self-Review (completed)

- **Spec coverage:** lifecycle field + helpers (T1); two-section live picker (T2); incremental re-review with in-place REVIEW.md + history (T3); confirmed agent posting approve/comment/request-changes + archive-on-approve + discussion perms + CLAUDE.md protocol (T4); REVIEW.md tracker/history contract (T5). Live-refresh requirement (T2). State-model contract (Global Constraints + T1). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows concrete bash/jq.
- **Type/name consistency:** `update_lifecycle`/`read_lifecycle` (T1) used in T3/T4; `lifecycle` values `none|commented|changes-requested|approved` consistent across T1/T3/T4; group strings `reviews|waiting` consistent T1↔T2; `_pr_repo`/`_post_review` consistent within T4; `--rereview-pr`/`--open-pr` routing consistent T2↔T3; `.review_body.md` path consistent T4↔spec.
- **Residual risks (flagged inline):** fzf `load:reload:sleep 2` live-refresh reliability (T2 Step 4 fallback documented); real GitHub posting + interactive routing are user-verified (T2/T4 notes); `--rereview-pr` git fetch assumes `origin pull/N/head` ref (matches how `--review-pr` checks out PRs — verify against an existing session in T3 Step 4).
