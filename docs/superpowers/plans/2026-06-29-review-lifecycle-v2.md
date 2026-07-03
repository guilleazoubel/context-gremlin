# Review Lifecycle v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the Mission Control review lifecycle into three "who-acts" sections, auto-re-review on new commits, click-always-opens into a dedicated focusable PR Reviews tab, and delete merged sessions — driven by a ~60s background watch daemon.

**Architecture:** Extend `bin/cgremlin`. Two new `session.json` fields (`reviewed_sha`, `rereview_pending`) drive a three-section `--review-list-grouped`. The picker routes every selection to `--open-pr`, which opens a dedicated `PR Reviews` Zellij tab with stacked `[glow review | agent]` rows. A `--watch-daemon` polls GitHub every ~60s (the only `gh` caller) to auto-re-review on new commits and delete merged sessions.

**Tech Stack:** bash, Python 3 (embedded PYSERVER heredoc), Zellij 0.43.1 (`new-tab`, stacked panes, `go-to-tab-name`, `action`), fzf 0.67 (`reload-sync`), glow, `gh` (`--json state`/`headRefOid`), `jq`, Claude Code CLI (`claude -p`).

## Global Constraints

- **macOS only.** The bash script and embedded Python (PYSERVER) heredoc must stay in sync.
- After edits: `bash -n bin/cgremlin` passes; PYSERVER parses:
  `awk '/^create_dashboard_server_script\(\)/,/^PYSERVER$/' bin/cgremlin | sed -n "/<< 'PYSERVER'/,/^PYSERVER$/p" | sed '1d;$d' > /tmp/pyserver_check.py && python3 -c "import ast; ast.parse(open('/tmp/pyserver_check.py').read()); print('PYSERVER OK')"`
- **State value contracts:** `lifecycle ∈ {none,commented,changes-requested,approved}`; `review_state ∈ {queued,reviewing,ready,failed,interrupted}`; picker `group ∈ {review,rereview,response}`; `rereview_pending` is the literal `true` or absent; `reviewed_sha` is a git SHA string.
- **Never use `--mouse`** (invalid fzf flag — mouse is on by default; only `--no-mouse` exists). This bug already cost hours.
- **mktemp:** `mktemp /tmp/foo-XXXXXX` — never a suffix after the `X`s (macOS).
- **Only `--watch-daemon` may call `gh`.** The picker and list generator stay local-only (no network), refreshing at 2s. GitHub checks are ~60s.
- **Every `gh` call in the daemon has a timeout** (`timeout 15 gh …`) so one hang can't stall the loop.
- **`rm -rf` deletes are guarded** to paths matching `$SESSIONS_DIR/pr-*` only; idempotent.
- **Mission Control tab is never disturbed** — PR reviews open in a separate `PR Reviews` tab.
- **Commit policy (project rule):** Do NOT `git commit` or branch. Leave changes in the working tree; the user reviews/tests then commits. "Stage" steps are `git add` only.
- Inside the cockpit, `cgremlin` is on PATH (launcher exports it); functions that self-invoke should still resolve their own absolute path (`_cg`) the way `status_pane_loop`/`launch_mission_control` already do.

---

## Test Approach

"Tests" = (1) syntax gates (`bash -n`, PYSERVER `ast.parse`); (2) functional smoke tests with exact commands + expected output. fzf/zellij/interactive bits are verified by running the **exact** command (catching `--mouse`-class errors) and then explicitly marked **user-verified in a live cockpit** for the visual/interactive part. The watch daemon's real `gh` behavior is tested against the live `pr-grace-frontend-*` sessions.

Helper sessions for tests: list with `ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -3`. Restore any field/state you mutate.

---

## Task 1: New state helpers (`reviewed_sha`, `rereview_pending`)

**Files:**
- Modify: `bin/cgremlin` — add beside `update_lifecycle`/`read_lifecycle` (~line 208).

**Interfaces:**
- Produces:
  - `update_reviewed_sha <session_dir> <sha>` / `read_reviewed_sha <session_dir>` (default empty)
  - `set_rereview_pending <session_dir>` (writes `true`) / `clear_rereview_pending <session_dir>` (writes `false`) / `read_rereview_pending <session_dir>` (default `false`)
- Consumed by Tasks 2, 5, 6.

- [ ] **Step 1: Add helpers**

```bash
# PR head SHA recorded when the human last posted a review
update_reviewed_sha() { update_session_field "$1" "reviewed_sha" "$2"; }
read_reviewed_sha()   { read_session_field "$1" "reviewed_sha" 2>/dev/null; }
# Author pushed new commits since reviewed_sha (set by the watch daemon)
set_rereview_pending()   { update_session_field "$1" "rereview_pending" "true"; }
clear_rereview_pending() { update_session_field "$1" "rereview_pending" "false"; }
read_rereview_pending()  { local v=$(read_session_field "$1" "rereview_pending" 2>/dev/null); echo "${v:-false}"; }
```

- [ ] **Step 2: Syntax gates** — `bash -n bin/cgremlin`; PYSERVER parse helper → `PYSERVER OK`.

- [ ] **Step 3: Functional smoke test**

```bash
source bin/cgremlin --lib-only
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -1)
update_reviewed_sha "$d" abc123; read_reviewed_sha "$d"      # → abc123
read_rereview_pending "$d"                                   # → false (default)
set_rereview_pending "$d"; read_rereview_pending "$d"        # → true
clear_rereview_pending "$d"; read_rereview_pending "$d"      # → false
# cleanup: remove test fields
jq 'del(.reviewed_sha)' "$d/session.json" > "$d/session.json.t" && mv "$d/session.json.t" "$d/session.json"
```
Expected: values as annotated.

- [ ] **Step 4: Stage and request review.**

---

## Task 2: `--review-list-grouped` → three sections

**Files:**
- Modify: `bin/cgremlin` — rewrite `review_list_grouped()` (~line 265).

**Interfaces:**
- Consumes: `read_lifecycle`, `read_review_state`, `read_triage_state`, `read_rereview_pending`, `read_session_field`.
- Produces: stdout lines `<display>\t<session>\t<group>`, `group ∈ {review,rereview,response}`; three section-header rows (empty session). REAL tabs. CLI `cgremlin --review-list-grouped`.

- [ ] **Step 1: Rewrite `review_list_grouped`**

```bash
review_list_grouped() {
  local review="" rereview="" response=""
  local d sname num author rs lc rp icon line
  for d in "$SESSIONS_DIR"/pr-*; do
    [ -d "$d/repo" ] || continue                       # repo gone (deleted/merged) → skip
    [ "$(read_triage_state "$d")" = "done" ] && continue
    sname=$(basename "$d")
    num=$(read_session_field "$d" "pr.number")
    author=$(read_session_field "$d" "pr.author")
    rs=$(read_review_state "$d")
    lc=$(read_lifecycle "$d")
    rp=$(read_rereview_pending "$d")
    case "$rs" in
      ready) icon="✅ ready";; reviewing) icon="🤔 reviewing";; queued) icon="… queued";;
      failed) icon="⚠ failed";; interrupted) icon="⏸ interrupted";; *) icon="${rs:-none}";;
    esac
    line="$(printf 'PR #%s  @%-14s %s\t%s' "$num" "${author:-?}" "$icon" "$sname")"
    if [ "$lc" = "none" ]; then
      review="${review}${line}\treview"$'\n'
    elif [ "$rp" = "true" ]; then
      rereview="${rereview}${line}\trereview"$'\n'
    else
      response="${response}PR #${num}  @${author:-?} 💬 awaiting author\t${sname}\tresponse"$'\n'
    fi
  done
  printf '── Waiting for review ──\t\t\n';        [ -n "$review" ]   && printf '%b' "$review"
  printf '── Waiting for re-review ──\t\t\n';     [ -n "$rereview" ] && printf '%b' "$rereview"
  printf '── Waiting for response ──\t\t\n';      [ -n "$response" ] && printf '%b' "$response"
}
```

- [ ] **Step 2: Syntax gates.**

- [ ] **Step 3: Functional smoke test (sections + real tabs)**

```bash
source bin/cgremlin --lib-only
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -1)
update_lifecycle "$d" none;        bin/cgremlin --review-list-grouped | grep -A1 "Waiting for review"
update_lifecycle "$d" commented; clear_rereview_pending "$d"; bin/cgremlin --review-list-grouped | grep "$(basename "$d")" | cut -f3   # → response
set_rereview_pending "$d";        bin/cgremlin --review-list-grouped | grep "$(basename "$d")" | cut -f3   # → rereview
bin/cgremlin --review-list-grouped | cat -t | grep "$(basename "$d")"   # tabs show as ^I
update_lifecycle "$d" none; clear_rereview_pending "$d"   # restore
```
Expected: card lands in the right section; `cut -f3` returns `response` then `rereview`; tabs are real (`^I`).

- [ ] **Step 4: Stage and request review.**

---

## Task 3: Picker routing — every selection opens

**Files:**
- Modify: `bin/cgremlin` — `status_pane_loop()` selection block (~line 410-419).

**Interfaces:**
- Consumes: `cgremlin --open-pr` (Task 4). 
- Produces: picker where Enter/double-click on ANY data row runs `"$_cg" --open-pr <session>`; header rows no-op.

- [ ] **Step 1: Replace the routing block**

Replace the `if [ "$group" = "waiting" ] … elif … fi` block with:
```bash
        sname=$(printf '%s' "$sel" | cut -f2)
        [ -z "$sname" ] && continue          # section-header row → no-op
        "$_cg" --open-pr "$sname"
```
(Group is no longer needed for routing — all rows open. Keep `cut -f2` for the session.)

- [ ] **Step 2: Syntax gates.**

- [ ] **Step 3: Functional smoke test**

```bash
# Confirm the picker no longer references rereview routing on select, and open-pr is the sole action:
sed -n '/status_pane_loop()/,/^}/p' bin/cgremlin | grep -n "open-pr\|rereview-pr"
```
Expected: `--open-pr` present in the selection path; no `--rereview-pr` in the selection path (re-review is now the daemon's job).

- [ ] **Step 4: USER verification note:** in a live cockpit, selecting a card in any section opens it (covered by Task 4 verification).

- [ ] **Step 5: Stage and request review.**

---

## Task 4: `--open-pr` → dedicated PR Reviews tab, stacked focusable rows

**Files:**
- Modify: `bin/cgremlin` — `open_pr_row()` (~line 350); remove the layout placeholder pane in `launch_mission_control`'s generated KDL (the `tab name="PR Reviews"`-to-be should start empty or the placeholder must be closable).

**Interfaces:**
- Consumes: `read_session_field`, glow, `claude`, the posting-perms jq-merge (already present).
- Produces: opening a PR creates/uses a Zellij tab named `PR Reviews`, adds a stacked row `[glow REVIEW.md | agent]`, focuses it; dedupe via `$SESSIONS_DIR/.tab2_open`.

- [ ] **Step 1: Probe the Zellij primitives FIRST (do not skip — these were never confirmed)**

In a live `mission-control` Zellij session, from a shell pane, confirm:
```bash
zellij action new-tab --name "PR Reviews"            # creates/*switches to* a named tab?
zellij action go-to-tab-name "PR Reviews"            # focuses it without error?
zellij action new-pane --name x -- bash -c 'echo hi; sleep 30'        # adds a pane to focused tab
zellij action new-pane -d right --name y -- bash -c 'echo hi; sleep 30'
# stacking: does Zellij 0.43.1 support a stacked group via `new-pane --stacked`? test:
zellij action new-pane --stacked --name z -- bash -c 'sleep 30' ; echo "rc=$?"
```
Record which work. If `--stacked` is unsupported/unreliable, the row layout falls back to plain splits + Zellij's native fullscreen-zoom (`Ctrl-p` then `f`, or the bound zoom key) for focusing. Write findings into the report; implement Step 2 to match what actually works.

- [ ] **Step 2: Rewrite `open_pr_row`**

```bash
open_pr_row() {
    local session_name="$1"
    local SDIR="$SESSIONS_DIR/$session_name"
    local tab2_open="$SESSIONS_DIR/.tab2_open"
    [ -d "$SDIR/repo" ] || { echo "ERROR: repo missing for $session_name" >&2; return 1; }
    [ -f "$SDIR/REVIEW.md" ] || { echo "ERROR: no REVIEW.md in $session_name" >&2; return 1; }

    local num author
    num=$(read_session_field "$SDIR" "pr.number")
    author=$(read_session_field "$SDIR" "pr.author")

    # Ensure the dedicated PR Reviews tab exists and is focused (creates if absent).
    if zellij action query-tab-names 2>/dev/null | grep -qx "PR Reviews"; then
        zellij action go-to-tab-name "PR Reviews" 2>/dev/null
    else
        zellij action new-tab --name "PR Reviews" 2>/dev/null
    fi

    # Merge posting-command perms so the agent can post (idempotent — unchanged from v1).
    local sf="$SDIR/repo/.claude/settings.local.json"; mkdir -p "$SDIR/repo/.claude"
    local add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
    if [ -f "$sf" ]; then
      jq --argjson add "$add" '.permissions.allow = ((.permissions.allow // []) + $add | unique)' "$sf" > "$sf.tmp" && mv "$sf.tmp" "$sf"
    else
      printf '{"permissions":{"allow":%s}}\n' "$add" > "$sf"
    fi

    if grep -qxF "$session_name" "$tab2_open" 2>/dev/null; then
        return 0     # already open → focusing the PR Reviews tab above is enough
    fi

    # New row: glow review (left) + cold agent (right). Use --stacked if the probe (Step 1)
    # confirmed it; otherwise plain `new-pane` + `new-pane -d right`.
    zellij action new-pane ${MC_STACK:+--stacked} --name "PR #${num} · @${author} · review" \
        -- bash -c "glow -p '$SDIR/REVIEW.md'" 2>/dev/null || true
    zellij action new-pane -d right --name "PR #${num} · @${author} · agent" \
        --cwd "$SDIR/repo" -- claude --add-dir "$SDIR" 2>/dev/null || true
    echo "$session_name" >> "$tab2_open"
}
```
(Set `MC_STACK=1` only if Step 1 confirmed `--stacked`; otherwise leave it unset so the `${MC_STACK:+--stacked}` expands to nothing. Bake the decision in per the probe — don't ship an untested `--stacked`.)

- [ ] **Step 3: Remove the placeholder pane from the generated layout**

In `launch_mission_control`'s heredoc, the layout no longer needs a `PRs`/placeholder tab (open_pr_row creates `PR Reviews` on demand). Remove the `tab name="PRs"` block so Mission Control launches with just the MISSION CONTROL tab; the PR Reviews tab appears when the first PR is opened.

- [ ] **Step 4: Syntax gates.**

- [ ] **Step 5: Functional smoke test (arg handling) + USER verification (visual)**

```bash
# arg validation:
bin/cgremlin --open-pr 2>&1 | head -1            # Usage error
# dedupe file logic, real session (dry — go-to-tab will no-op outside cockpit):
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -1)
bin/cgremlin --open-pr "$(basename "$d")"; grep -c "$(basename "$d")" "$HOME/.cgremlin/sessions/.tab2_open"   # 1
bin/cgremlin --open-pr "$(basename "$d")"; grep -c "$(basename "$d")" "$HOME/.cgremlin/sessions/.tab2_open"   # still 1 (dedupe)
# cleanup the test entry:
grep -vxF "$(basename "$d")" "$HOME/.cgremlin/sessions/.tab2_open" > /tmp/t2 && mv /tmp/t2 "$HOME/.cgremlin/sessions/.tab2_open"
```
USER-verified in cockpit: clicking a card opens a `PR Reviews` tab (Mission Control untouched) with a `[review | agent]` row; a second PR adds a second row; the focused row expands (or zooms). Record in report.

- [ ] **Step 6: Stage and request review.**

---

## Task 5: Posting helpers — record `reviewed_sha`, approve deletes the session

**Files:**
- Modify: `bin/cgremlin` — `approve_pr`, `comment_pr`, `request_changes_pr`, `_post_review` (~line 216).

**Interfaces:**
- Consumes: `update_reviewed_sha`, `clear_rereview_pending`, `_pr_repo`, `gh`.
- Produces: comment/request-changes record `reviewed_sha`=current PR head + clear `rereview_pending`; approve `rm -rf`s the session.

- [ ] **Step 1: Update the helpers**

```bash
approve_pr() {
    _post_review "$1" "--approve" "approved" || return 1
    local d="$SESSIONS_DIR/$1"
    case "$d" in "$SESSIONS_DIR"/pr-*) rm -rf "$d"; echo "approved+deleted $1";; *) echo "refusing to delete $d" >&2; return 1;; esac
}
comment_pr()         { _post_review "$1" "--comment" "commented"          && _record_reviewed "$1"; }
request_changes_pr() { _post_review "$1" "--request-changes" "changes-requested" && _record_reviewed "$1"; }

# After a successful comment/request-changes, snapshot the PR head so the watch daemon
# can detect NEW commits, and clear any stale rereview flag.
_record_reviewed() {
    local d="$SESSIONS_DIR/$1"; local num repo sha
    num=$(read_session_field "$d" "pr.number"); repo=$(_pr_repo "$d")
    sha=$(timeout 15 gh pr view "$num" --repo "$repo" --json headRefOid -q .headRefOid 2>/dev/null)
    [ -n "$sha" ] && update_reviewed_sha "$d" "$sha"
    clear_rereview_pending "$d"
}
```
(`_post_review` itself is unchanged from v1: posts via `gh pr review … --body-file $SESSION_DIR/.review_body.md`, sets `lifecycle`, leaves state unchanged on failure.)

- [ ] **Step 2: Syntax gates.**

- [ ] **Step 3: Functional smoke test (NO real posting; verify delete-guard + sha capture path)**

```bash
source bin/cgremlin --lib-only
# delete guard: refuses non-session paths
( SESSIONS_DIR=/tmp/fake; approve_pr "../../etc" ) 2>&1 | grep -i "refusing" && echo "guard OK"
# _record_reviewed captures a real head sha (no posting involved):
d=$(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -1)
_record_reviewed "$(basename "$d")"; read_reviewed_sha "$d"   # → a 40-char sha (PR still open) or empty if merged
jq 'del(.reviewed_sha)' "$d/session.json" > "$d/session.json.t" && mv "$d/session.json.t" "$d/session.json"   # restore
```
Expected: guard prints "refusing"; `_record_reviewed` writes a SHA. **Do NOT run a real `gh pr review`** — approve/delete is user-verified on a throwaway PR.

- [ ] **Step 4: Stage and request review.**

---

## Task 6: `--watch-daemon` — 60s merged-delete + new-commit auto-re-review

**Files:**
- Modify: `bin/cgremlin` — add `watch_daemon_loop()` + `--watch-daemon` dispatch + guard exclusion; launch it from `launch_mission_control` (backgrounded) with self-termination.

**Interfaces:**
- Consumes: `read_lifecycle`, `read_reviewed_sha`, `set_rereview_pending`, `_pr_repo`, `rereview_pr` (via `cgremlin --rereview-pr`), `gh`.
- Produces: CLI `cgremlin --watch-daemon`; background lifecycle automation.

- [ ] **Step 1: Implement the loop**

```bash
watch_daemon_loop() {
    local _src="${BASH_SOURCE[0]:-$0}" _d
    while [ -L "$_src" ]; do _d="$(cd -P "$(dirname "$_src")" && pwd)"; _src="$(readlink "$_src")"; [[ "$_src" != /* ]] && _src="$_d/$_src"; done
    local _cg; _cg="$(cd -P "$(dirname "$_src")" && pwd)/$(basename "$_src")"
    local LOG="$SESSIONS_DIR/.watch-daemon.log"
    while true; do
        # Self-terminate if the cockpit session is gone (no orphans).
        zellij list-sessions 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -qE '^mission-control[[:space:]]' || { echo "cockpit gone, exiting $(date)" >> "$LOG"; exit 0; }
        for d in "$SESSIONS_DIR"/pr-*; do
            [ -d "$d/repo" ] || continue
            local num repo state lc head
            num=$(read_session_field "$d" "pr.number"); repo=$(_pr_repo "$d")
            [ -z "$num" ] || [ -z "$repo" ] && continue
            state=$(timeout 15 gh pr view "$num" --repo "$repo" --json state -q .state 2>/dev/null)
            if [ "$state" = "MERGED" ] || [ "$state" = "CLOSED" ]; then
                case "$d" in "$SESSIONS_DIR"/pr-*) echo "delete merged $d $(date)" >> "$LOG"; rm -rf "$d";; esac
                continue
            fi
            lc=$(read_lifecycle "$d")
            if [ "$lc" = "commented" ] || [ "$lc" = "changes-requested" ]; then
                if [ "$(read_rereview_pending "$d")" != "true" ]; then
                    head=$(timeout 15 gh pr view "$num" --repo "$repo" --json headRefOid -q .headRefOid 2>/dev/null)
                    if [ -n "$head" ] && [ "$head" != "$(read_reviewed_sha "$d")" ]; then
                        echo "new commits on $num → auto re-review $(date)" >> "$LOG"
                        set_rereview_pending "$d"
                        "$_cg" --rereview-pr "$(basename "$d")" >> "$LOG" 2>&1
                    fi
                fi
            fi
        done
        sleep 60
    done
}
```

- [ ] **Step 2: Dispatch + guard exclusion**

```bash
if [ "$1" = "--watch-daemon" ]; then
    watch_daemon_loop
    exit 0
fi
```
Add `--watch-daemon` to the dashboard-skip guard.

- [ ] **Step 3: Launch it with the cockpit**

In `launch_mission_control`, after building the launcher but before/within the `exec zellij` path, start the daemon backgrounded so it lives alongside the session. Add to the launcher script (which already runs in the cockpit's shell):
```bash
# in the generated launcher, before `exec $ZJ`:
( "$_cgdir/cgremlin" --watch-daemon >/dev/null 2>&1 & )
```
(The daemon self-terminates when the `mission-control` session disappears — Step 1.)

- [ ] **Step 4: Syntax gates.**

- [ ] **Step 5: Functional smoke test (REAL gh, bounded — one pass, not the loop)**

Run ONE iteration's logic against real sessions without the infinite loop:
```bash
source bin/cgremlin --lib-only
for d in $(ls -d "$HOME/.cgremlin/sessions"/pr-grace-frontend-* | tail -3); do
  num=$(read_session_field "$d" pr.number); repo=$(_pr_repo "$d")
  state=$(timeout 15 gh pr view "$num" --repo "$repo" --json state -q .state 2>/dev/null)
  echo "$(basename "$d"): state=$state lifecycle=$(read_lifecycle "$d")"
done
```
Expected: prints each session's real GitHub state (MERGED/OPEN/CLOSED) within seconds — confirms the daemon's gh path + repo parsing work and are bounded. **Do NOT delete real sessions in the test** (the daemon will do that live; here just observe states). The auto-re-review trigger is user-verified live (push a commit to an open PR you've commented on, watch it move to Waiting-for-re-review within ~60s).

- [ ] **Step 6: Stage and request review.**

---

## Self-Review (completed)

- **Spec coverage:** 3 sections (T2); auto-re-review on new commits (T6); click-always-opens (T3); dedicated focusable PR Reviews tab + no placeholder (T4); merged→delete + comment records reviewed_sha + approve deletes (T5, T6); 60s cadence / only-daemon-calls-gh (T6 + Global Constraints); new state fields (T1). All spec sections map to a task.
- **Placeholder scan:** none — concrete bash/jq throughout; the one genuinely-unconfirmed primitive (Zellij `--stacked`) is gated behind an explicit probe (T4 Step 1) with a defined fallback, not assumed.
- **Type/name consistency:** `reviewed_sha`/`rereview_pending` helpers (T1) used in T2/T5/T6; `group` strings `review|rereview|response` (T2) ↔ picker reads `cut -f2` only (T3, group not needed); `_record_reviewed`/`_pr_repo`/`_post_review` consistent (T5); `--open-pr`/`--rereview-pr`/`--watch-daemon` dispatch+guard consistent.
- **Residual risks (flagged inline):** Zellij `--stacked` and `new-tab --name` focus behavior (T4 probe + fallback); real `gh pr review` posting + approve-delete + live auto-re-review are user-verified (T4/T5/T6 notes); daemon self-termination relies on `zellij list-sessions` naming (matches the launcher's session name `mission-control`).
