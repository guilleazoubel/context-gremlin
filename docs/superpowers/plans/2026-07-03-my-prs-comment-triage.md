# My-PRs Flow + Reviewer-Comment Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat the reviewer's own PRs distinctly — never code-reviewed, tracked in their own status groups, with an automatic reviewer-comment triage workflow (classify each comment valid/false-positive, then guided reply/fix).

**Architecture:** All changes live in the single bash script `bin/cgremlin`. A PR is "mine" when `pr.author == GITHUB_ME`. Mine PRs get a lightweight tracked session (shallow clone, no review). The watch daemon routes mine PRs to `track_my_pr` instead of `--review-pr`, detects approval and new reviewer comments, and launches a headless `--triage-comments` worker that writes `COMMENTS.md`. An interactive floating pane walks the reviewer through `COMMENTS.md`; all GitHub/git mutations go through allowlisted `cgremlin` helpers so the review guard stays intact.

**Tech Stack:** bash, `gh` CLI (incl. `gh api graphql`), `jq`, Zellij floating panes, `claude -p` headless.

## Global Constraints

- All code in `bin/cgremlin`; after every change run `bash -n bin/cgremlin` (must pass). No unit-test framework exists — verify with functional checks (build a throwaway session dir, source `bin/cgremlin --lib-only`, call the function, assert output).
- A PR is "mine" iff `pr.author` equals `GITHUB_ME` (config, case-insensitive). `GITHUB_ME` is already loaded by `load_config` and set to `guilleazoubel` in `~/.cgremlin/config`.
- Mine PRs are NEVER code-reviewed and NEVER appear in "🔔 Needs your attention".
- Mine PR sub-state lives in `session.json` field `mine_stage` ∈ `tracking` | `triaging` | `ready`. Approval reuses `lifecycle=approved`.
- Triaged review-thread ids are stored in `session.json` field `triaged_threads` (JSON array of strings).
- The headless worker posts NOTHING. All mutations (reply, commit, push) go only through `cgremlin` helpers: `--reply-comment`, `--commit-fix`, `--push-fix`. Raw `gh pr review/comment/merge`, `gh api --method`, `git push`, `git commit` stay denied by `write_review_guard`.
- Do not commit or push git changes unless the user asks; work stays on branch `mission-control-pr-orchestrator`. (These plan "commit" steps are cgremlin commits to the working tree, allowed per session norms.)
- Existing helpers to reuse verbatim: `read_session_field`, `update_session_field`, `read_lifecycle`, `update_lifecycle`, `read_review_state`, `read_rereview_pending`, `write_review_guard`, `create_pr_session_noninteractive`.

---

### Task 1: "mine" classification + mine_stage helpers + `track_my_pr` + pickup routing

**Files:**
- Modify: `bin/cgremlin` — add helpers near the other `read_*`/`update_*` helpers (~line 238); add `track_my_pr()` near `review_pr_noninteractive` (~line 12837); add `--track-my-pr` dispatch near `--review-pr` (~line 12961); modify the watch-daemon pickup loop (~line 12300) to route mine PRs.

**Interfaces:**
- Produces:
  - `pr_is_mine SDIR` → exit 0 if the session's `pr.author` equals `$GITHUB_ME` (case-insensitive), else exit 1. Empty `GITHUB_ME` → always exit 1.
  - `read_mine_stage SDIR` → prints `tracking`|`triaging`|`ready` (default `tracking` when field absent but session is mine).
  - `update_mine_stage SDIR STAGE`.
  - `track_my_pr PR_URL` → creates a tracked mine session (reuses `create_pr_session_noninteractive`), sets `mine_stage=tracking`, prints the session name.
  - `--track-my-pr <url>` dispatch → calls `track_my_pr`.
- Consumes: `create_pr_session_noninteractive` (prints session name on last line), `update_session_field`, `read_session_field`, `$GITHUB_ME`.

- [ ] **Step 1: Add the mine helpers**

Insert after `read_rereview_pending()` (~line 238):

```bash
# A PR session is "mine" when its author matches GITHUB_ME (case-insensitive).
# Usage: pr_is_mine SESSION_DIR   (exit 0 = mine)
pr_is_mine() {
    [ -n "$GITHUB_ME" ] || return 1
    local a; a=$(read_session_field "$1" "pr.author" 2>/dev/null)
    [ "$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$GITHUB_ME" | tr '[:upper:]' '[:lower:]')" ]
}
# mine_stage: tracking (idle) | triaging (worker running) | ready (COMMENTS.md waiting)
update_mine_stage() { update_session_field "$1" "mine_stage" "$2"; }
read_mine_stage()   { local v=$(read_session_field "$1" "mine_stage" 2>/dev/null); echo "${v:-tracking}"; }
```

- [ ] **Step 2: Verify helpers load and classify correctly**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
tmp=$(mktemp -d); mkdir -p "$tmp/repo"
printf '{"pr":{"author":"guilleazoubel"}}' > "$tmp/session.json"
GITHUB_ME=guilleazoubel bash -c 'source bin/cgremlin --lib-only; pr_is_mine "'"$tmp"'" && echo MINE || echo NOTMINE'
printf '{"pr":{"author":"someoneelse"}}' > "$tmp/session.json"
GITHUB_ME=guilleazoubel bash -c 'source bin/cgremlin --lib-only; pr_is_mine "'"$tmp"'" && echo MINE || echo NOTMINE'
rm -rf "$tmp"
```
Expected: `SYNTAX OK`, then `MINE`, then `NOTMINE`.

- [ ] **Step 3: Add `track_my_pr` and the `--track-my-pr` dispatch**

Add `track_my_pr` immediately after `review_pr_noninteractive()` (~line 12837):

```bash
track_my_pr() {
    # My own PR: create a tracked session (shallow clone so we can fix later),
    # but do NOT run a code review. Just mark it mine_stage=tracking.
    local pr_input="$1"
    local session_name
    session_name=$(create_pr_session_noninteractive "$pr_input" "" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: session creation failed" >&2; return 1; }
    local session_dir="$SESSIONS_DIR/$session_name"
    update_mine_stage "$session_dir" "tracking"
    # create_pr_session_noninteractive wrote a REVIEW-mode CLAUDE.md (auto-start
    # review). This is MY PR — replace it so no review agent ever auto-starts;
    # the triage pane drives everything via AGENT_CONTEXT.md / COMMENTS.md.
    cat > "$session_dir/CLAUDE.md" <<'MYPR'
# My Pull Request (tracked, not auto-reviewed)

This is your own PR. It is not code-reviewed by the tool. When reviewers leave
comments they are triaged into COMMENTS.md, and AGENT_CONTEXT.md drives the
guided reply/fix flow. Do not start a code review here.
MYPR
    echo "$session_name"
}
```

Add the dispatch next to the `--review-pr` handler (~line 12961):

```bash
if [ "$1" = "--track-my-pr" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --track-my-pr <pr-url>" >&2; exit 1; }
    track_my_pr "$2"; exit $?
fi
```

- [ ] **Step 4: Route mine PRs in the watch-daemon pickup loop**

In `watch_daemon_loop`, find the auto-pickup launch line:

```bash
                    echo "auto-pickup PR #${pr_num} @${pr_author} in ${wrepo} $(date)" >> "$LOG"
                    "$_cg" --review-pr "$pr_url" >> "$LOG" 2>&1 &
```

Replace with:

```bash
                    if [ -n "$GITHUB_ME" ] && [ "$(printf '%s' "$pr_author" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$GITHUB_ME" | tr '[:upper:]' '[:lower:]')" ]; then
                        echo "track my PR #${pr_num} @${pr_author} in ${wrepo} $(date)" >> "$LOG"
                        "$_cg" --track-my-pr "$pr_url" >> "$LOG" 2>&1 &
                    else
                        echo "auto-pickup PR #${pr_num} @${pr_author} in ${wrepo} $(date)" >> "$LOG"
                        "$_cg" --review-pr "$pr_url" >> "$LOG" 2>&1 &
                    fi
```

- [ ] **Step 5: Verify syntax and dispatch wiring**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
grep -q 'track my PR #' bin/cgremlin && echo "ROUTING OK"
grep -q '"\$1" = "--track-my-pr"' bin/cgremlin && echo "DISPATCH OK"
```
Expected: `SYNTAX OK`, `ROUTING OK`, `DISPATCH OK`.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: track my own PRs distinctly (no code review)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Status-pane grouping for mine PRs

**Files:**
- Modify: `bin/cgremlin` — `review_list_grouped()` (~line 336-397).

**Interfaces:**
- Consumes: `pr_is_mine`, `read_mine_stage`, `read_lifecycle`, `read_session_field`, `$GITHUB_ME`.
- Produces: `review_list_grouped` emits, in order: 🚀 MERGE YOURS (mine+approved), 💬 My PRs — comments to address (mine+ready), 🔔 Needs your attention (NOT mine), 👀 Agent reviewing (incl. mine+triaging), 💬 Waiting for response (NOT mine), ✅ Approved author-will-merge (NOT mine), 📋 My pull requests (mine+tracking). Mine rows in the top/bottom mine groups are display-only (empty session column); the "comments to address" rows ARE clickable (session in column 2).

- [ ] **Step 1: Add mine classification at the top of the per-session loop**

In `review_list_grouped`, the loop currently starts each iteration by reading `sname/num/author/rs/lc/rp`. Immediately after those reads and before the existing `if [ "$lc" = "approved" ]` block, insert the mine branch. Add `mymerge` / `mycomments` / `mytracking` to the accumulator declaration line.

Change the declaration line:
```bash
  local mergemine="" ready="" inflight="" rereview="" response="" approved=""
```
to:
```bash
  local mergemine="" ready="" inflight="" rereview="" response="" approved="" mycomments="" mytracking=""
```

Insert this block right after `rp=$(read_rereview_pending "$d")` and before the current `if [ "$lc" = "approved" ]; then` block:

```bash
    # --- My own PRs: never code-reviewed; their own lifecycle. ---
    if pr_is_mine "$d"; then
      local ms; ms=$(read_mine_stage "$d")
      if [ "$lc" = "approved" ]; then
        mergemine="${mergemine}$(printf 'PR #%s  @%-14s 🚀 APPROVED — merge it!' "$num" "${author:-?}")\t\tmergemine"$'\n'
      elif [ "$ms" = "ready" ]; then
        local nc; nc=$(grep -c '^### ' "$d/COMMENTS.md" 2>/dev/null || echo 0)
        mycomments="${mycomments}$(printf 'PR #%s  @%-14s 💬 %s comment(s) to address' "$num" "${author:-?}" "$nc")\t${sname}\tmycomments"$'\n'
      elif [ "$ms" = "triaging" ]; then
        inflight="${inflight}$(printf 'PR #%s  @%-14s 👀 triaging reviewer comments' "$num" "${author:-?}")\t\tinflight"$'\n'
      else
        mytracking="${mytracking}$(printf 'PR #%s  @%-14s 📋 open · awaiting review' "$num" "${author:-?}")\t\tmyprs"$'\n'
      fi
      continue
    fi
```

Note: this branch runs BEFORE the existing non-mine `lifecycle=approved` block, so mine-approved PRs go to `mergemine` here and the existing approved block only handles others. The existing `mergemine` line inside the old approved block (that compared author to `me_lc`) is now dead for mine PRs but harmless; leave the non-mine `else` (approved author-will-merge) intact.

- [ ] **Step 2: Emit the two new groups in the print section**

The print section currently ends with the approved group. Replace the whole trailing print block:

```bash
  # One unified "needs your attention" block — quick re-reviews listed first,
  # then full fresh reviews. Then passive/informational groups.
  [ -n "$mergemine" ] && { printf '── 🚀 Approved — MERGE YOURS ──\t\t\n'; printf '%b' "$mergemine"; }
  printf '── 🔔 Needs your attention ──\t\t\n'
  [ -n "$rereview" ] && printf '%b' "$rereview"
  [ -n "$ready" ]    && printf '%b' "$ready"
  [ -n "$inflight" ] && { printf '── 👀 Agent reviewing ──\t\t\n';        printf '%b' "$inflight"; }
  printf '── 💬 Waiting for response ──\t\t\n';         [ -n "$response" ] && printf '%b' "$response"
  [ -n "$approved" ] && { printf '── ✅ Approved (author will merge) ──\t\t\n'; printf '%b' "$approved"; }
}
```

with:

```bash
  # Action zone (needs YOU) first, then passive/informational, then my open PRs.
  [ -n "$mergemine" ]  && { printf '── 🚀 Approved — MERGE YOURS ──\t\t\n';        printf '%b' "$mergemine"; }
  [ -n "$mycomments" ] && { printf '── 💬 My PRs — comments to address ──\t\t\n'; printf '%b' "$mycomments"; }
  printf '── 🔔 Needs your attention ──\t\t\n'
  [ -n "$rereview" ] && printf '%b' "$rereview"
  [ -n "$ready" ]    && printf '%b' "$ready"
  [ -n "$inflight" ] && { printf '── 👀 Agent reviewing ──\t\t\n';        printf '%b' "$inflight"; }
  printf '── 💬 Waiting for response ──\t\t\n';         [ -n "$response" ] && printf '%b' "$response"
  [ -n "$approved" ]   && { printf '── ✅ Approved (author will merge) ──\t\t\n'; printf '%b' "$approved"; }
  [ -n "$mytracking" ] && { printf '── 📋 My pull requests ──\t\t\n';            printf '%b' "$mytracking"; }
}
```

- [ ] **Step 2b: Remove the now-dead mine test in the non-mine approved block**

The existing non-mine approved block still contains an `if [ -n "$me_lc" ] && author==me_lc → mergemine ... else approved` test. Since mine PRs now `continue` above, that branch is dead. Simplify the non-mine approved block to only produce the `approved` (author-will-merge) group:

Find:
```bash
    if [ "$lc" = "approved" ]; then
      if [ -n "$me_lc" ] && [ "$(printf '%s' "$author" | tr '[:upper:]' '[:lower:]')" = "$me_lc" ]; then
        mergemine="${mergemine}$(printf 'PR #%s  @%-14s 🚀 APPROVED — merge it!' "$num" "${author:-?}")\t\tmergemine"$'\n'
      else
        approved="${approved}$(printf 'PR #%s  @%-14s ✅ approved · author will merge' "$num" "${author:-?}")\t\tapproved"$'\n'
      fi
      continue
    fi
```
Replace with:
```bash
    if [ "$lc" = "approved" ]; then
      approved="${approved}$(printf 'PR #%s  @%-14s ✅ approved · author will merge' "$num" "${author:-?}")\t\tapproved"$'\n'
      continue
    fi
```
(The `me_lc` local can remain declared; it's now unused but harmless.)

- [ ] **Step 3: Verify rendering with throwaway sessions**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
root=$(mktemp -d)
mk(){ d="$root/pr-x-$1-t"; mkdir -p "$d/repo"; printf '%s' "$2" > "$d/session.json"; [ -n "$3" ] && printf '%s' "$3" > "$d/COMMENTS.md"; }
mk 1 '{"pr":{"number":"1","author":"guilleazoubel"},"lifecycle":"approved"}'
mk 2 '{"pr":{"number":"2","author":"guilleazoubel"},"mine_stage":"ready"}' '### a
### b'
mk 3 '{"pr":{"number":"3","author":"guilleazoubel"},"mine_stage":"tracking"}'
mk 4 '{"pr":{"number":"4","author":"someoneelse"},"review_state":"ready","lifecycle":"none"}'
CGREMLIN_SESSIONS_DIR="$root" GITHUB_ME=guilleazoubel bash -c 'source bin/cgremlin --lib-only; review_list_grouped' | sed 's/\t/ | /g'
rm -rf "$root"
```
Expected (order and content):
```
── 🚀 Approved — MERGE YOURS ── |  |
PR #1  @guilleazoubel   🚀 APPROVED — merge it! |  | mergemine
── 💬 My PRs — comments to address ── |  |
PR #2  @guilleazoubel   💬 2 comment(s) to address | pr-x-2-t | mycomments
── 🔔 Needs your attention ── |  |
PR #4  @someoneelse   🆕 new · full review | pr-x-4-t | ready
── 👀 Agent reviewing ── |  |
── 💬 Waiting for response ── |  |
── 📋 My pull requests ── |  |
PR #3  @guilleazoubel   📋 open · awaiting review |  | myprs
```
(The `✅ Approved (author will merge)` header only prints when non-empty; it is absent here — that is correct.)

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: status-pane groups for my PRs (merge/comments/tracking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `--triage-comments` headless worker

**Files:**
- Modify: `bin/cgremlin` — add `triage_comments()` near `rereview_pr` (~line 12850) and a `--triage-comments` dispatch near `--rereview-pr` (~line 12967).

**Interfaces:**
- Consumes: `write_review_guard`, `update_mine_stage`, `read_session_field`, `_pr_repo` (existing helper that returns `owner/repo` for a session), `$MODEL`, `$GITHUB_ME`.
- Produces:
  - `triage_comments SESSION_NAME` → launches a background worker that writes `COMMENTS.md` (one `### ` heading per comment), records `triaged_threads` in session.json, sets `mine_stage=ready` on success (`tracking` on failure).
  - `--triage-comments <session>` dispatch.
- `COMMENTS.md` format (data contract for Task 6), one entry per comment:
  ```
  ### <n>. <short title>
  - **Thread:** <threadId>
  - **From:** @<author>   **Where:** `path:line`
  - **Comment:** <quoted reviewer text>
  - **Verdict:** ✅ valid  (or) 🟡 false-positive
  - **Reasoning:** <one or two plain sentences>
  - **Proposed reply:** <text>        (false-positive only)
  - **Proposed fix:** <text/snippet>  (valid only)
  - **Status:** open
  ```

- [ ] **Step 1: Add `triage_comments`**

```bash
triage_comments() {
    local session_name="$1"
    local SESSION_DIR="$SESSIONS_DIR/$session_name"
    local REPO_DIR="$SESSION_DIR/repo"
    [ -d "$REPO_DIR" ] || { echo "ERROR: repo missing for $session_name" >&2; return 1; }

    local pr_num repo
    pr_num=$(read_session_field "$SESSION_DIR" "pr.number")
    repo=$(_pr_repo "$SESSION_DIR")
    [ -z "$pr_num" ] || [ -z "$repo" ] && { echo "ERROR: missing pr.number/repo" >&2; return 1; }
    local owner="${repo%%/*}" name="${repo##*/}"

    update_mine_stage "$SESSION_DIR" "triaging"
    mkdir -p "$SESSION_DIR/logs"
    write_review_guard "$REPO_DIR"

    # Snapshot the unresolved review threads from OTHERS (path, line, author,
    # body, thread id) into a context file the agent classifies. Also stamp
    # triaged_threads so the daemon won't relaunch for the same threads.
    local threads_json
    threads_json=$(timeout 30 gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login} path line body}}}}}}}' \
        -F o="$owner" -F r="$name" -F n="$pr_num" 2>/dev/null \
        | jq --arg me "$GITHUB_ME" '[.data.repository.pullRequest.reviewThreads.nodes[]
             | select(.isResolved==false)
             | {id, author:.comments.nodes[0].author.login, path:.comments.nodes[0].path, line:.comments.nodes[0].line, body:.comments.nodes[0].body}
             | select((.author|ascii_downcase) != ($me|ascii_downcase))]' 2>/dev/null)
    [ -z "$threads_json" ] && threads_json="[]"
    printf '%s\n' "$threads_json" > "$SESSION_DIR/.threads.json"
    # NOTE: triaged_threads is recorded only on SUCCESS (in the wrapper below),
    # so a failed triage leaves the threads un-triaged and the daemon retries.

    local _src="${BASH_SOURCE[0]:-$0}" _d
    while [ -L "$_src" ]; do _d="$(cd -P "$(dirname "$_src")" && pwd)"; _src="$(readlink "$_src")"; [[ "$_src" != /* ]] && _src="$_d/$_src"; done
    local _cg="$(cd -P "$(dirname "$_src")" && pwd)/$(basename "$_src")"

    local wrapper; wrapper=$(mktemp /tmp/cgremlin-triage-XXXXXX)
    cat > "$wrapper" <<WRAPPER_EOF
#!/bin/bash
source "$_cg" --lib-only
write_review_guard "$REPO_DIR"
cd "$REPO_DIR" && claude -p "You are helping the PR AUTHOR triage reviewer comments on their own PR. The unresolved reviewer comments (from others) are in ${SESSION_DIR}/.threads.json as a JSON array (fields: id, author, path, line, body). The PR branch is checked out here. For EACH comment, read the referenced code and decide whether it is ✅ valid (a real issue the author should fix) or 🟡 false-positive (does not apply / already handled / mistaken), with a one- or two-sentence plain-language reason. Write ${SESSION_DIR}/COMMENTS.md with one entry per comment in EXACTLY this format:

### <n>. <short title>
- **Thread:** <id from .threads.json>
- **From:** @<author>   **Where:** \\\`<path>:<line>\\\`
- **Comment:** <quote the reviewer's text>
- **Verdict:** ✅ valid   (or)   🟡 false-positive
- **Reasoning:** <plain sentences>
- **Proposed reply:** <what to reply, for false-positive only>
- **Proposed fix:** <how to fix, for valid only>
- **Status:** open

Do NOT reply on GitHub, do NOT edit code, do NOT commit — only write COMMENTS.md. Proceed autonomously; no confirmation." \
  --permission-mode bypassPermissions --add-dir "$SESSION_DIR" < /dev/null
rc=\$?
if [ \$rc -eq 0 ] && [ -s "$SESSION_DIR/COMMENTS.md" ]; then
    # Success: mark these threads triaged so the daemon won't relaunch for them.
    update_session_field "$SESSION_DIR" "triaged_threads" "\$(jq '[.[].id]' "$SESSION_DIR/.threads.json")"
    update_mine_stage "$SESSION_DIR" ready
else
    update_mine_stage "$SESSION_DIR" tracking
fi
rm -f "$SESSION_DIR/.cg_agent_state" "$wrapper"
WRAPPER_EOF
    chmod +x "$wrapper"
    nohup bash "$wrapper" >> "$SESSION_DIR/logs/worker.log" 2>&1 &
    update_session_field "$SESSION_DIR" "review_worker_pid" "$!"
    echo "triaging comments for $session_name"
}
```

- [ ] **Step 2: Add the `--triage-comments` dispatch**

Next to the `--rereview-pr` handler (~line 12967):

```bash
if [ "$1" = "--triage-comments" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --triage-comments <session>" >&2; exit 1; }
    triage_comments "$2"; exit $?
fi
```

- [ ] **Step 3: Verify syntax, dispatch, and the thread-fetch jq shape (offline)**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
grep -q '"\$1" = "--triage-comments"' bin/cgremlin && echo "DISPATCH OK"
# jq filter shape check against a sample graphql payload:
echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"comments":{"nodes":[{"author":{"login":"reviewerA"},"path":"a.ts","line":10,"body":"nit"}]}},
  {"id":"T2","isResolved":true,"comments":{"nodes":[{"author":{"login":"reviewerA"},"path":"b.ts","line":2,"body":"resolved"}]}},
  {"id":"T3","isResolved":false,"comments":{"nodes":[{"author":{"login":"guilleazoubel"},"path":"c.ts","line":3,"body":"mine"}]}}
]}}}}}' | jq --arg me guilleazoubel '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | {id, author:.comments.nodes[0].author.login, path:.comments.nodes[0].path, line:.comments.nodes[0].line, body:.comments.nodes[0].body} | select((.author|ascii_downcase) != ($me|ascii_downcase))]'
```
Expected: `SYNTAX OK`, `DISPATCH OK`, and the jq prints an array with exactly one element (`T1` from reviewerA) — `T2` excluded (resolved), `T3` excluded (mine).

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: --triage-comments headless worker (classify reviewer comments)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Watch-daemon monitoring for mine PRs (approval + new-comment detection)

**Files:**
- Modify: `bin/cgremlin` — the "Manage existing PR sessions" loop in `watch_daemon_loop` (~line 12328-12356).

**Interfaces:**
- Consumes: `pr_is_mine`, `read_mine_stage`, `read_lifecycle`, `_pr_repo`, `read_session_field`, the `--triage-comments` dispatch (Task 3), `$GITHUB_ME`.
- Produces: for a mine session that is open and not approved, if there are unresolved reviewer threads (from others) whose ids are not already in `triaged_threads`, and it is not already triaging, launch `--triage-comments`. Mine sessions never enter the rereview path.

- [ ] **Step 1: Branch the monitoring loop for mine sessions**

In the monitoring loop, the current structure is: fetch `meta` (state+reviewDecision) → MERGED/CLOSED delete → APPROVED mark → else rereview check. Insert a mine branch immediately AFTER the APPROVED-mark block and BEFORE the `lc=commented/changes-requested` rereview block. Add `continue` so mine PRs skip the rereview logic.

Find the rereview block start:
```bash
            lc=$(read_lifecycle "$d")
            if [ "$lc" = "commented" ] || [ "$lc" = "changes-requested" ]; then
```
Insert BEFORE that line:
```bash
            # My own PRs: no rereview. Detect NEW reviewer comments → triage.
            if pr_is_mine "$d"; then
                [ "$(read_lifecycle "$d")" = "approved" ] && continue
                [ "$(read_mine_stage "$d")" = "triaging" ] && continue
                local m_owner="${repo%%/*}" m_name="${repo##*/}" seen new_ids
                seen=$(read_session_field "$d" "triaged_threads" 2>/dev/null); [ -z "$seen" ] && seen="[]"
                new_ids=$(timeout 30 gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login}}}}}}}}' \
                    -F o="$m_owner" -F r="$m_name" -F n="$num" 2>/dev/null \
                    | jq -c --arg me "$GITHUB_ME" --argjson seen "$seen" '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | select((.comments.nodes[0].author.login|ascii_downcase) != ($me|ascii_downcase)) | .id] - $seen' 2>/dev/null)
                if [ -n "$new_ids" ] && [ "$new_ids" != "[]" ]; then
                    echo "new reviewer comments on my PR $num → triage $(date)" >> "$LOG"
                    "$_cg" --triage-comments "$(basename "$d")" >> "$LOG" 2>&1 &
                fi
                continue
            fi
```

Note: `num` and `repo` are already set earlier in the loop iteration; reuse them (do not re-fetch).

- [ ] **Step 2: Verify syntax and the set-difference jq (offline)**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
# set difference: unresolved-from-others minus already-seen
echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"comments":{"nodes":[{"author":{"login":"revA"}}]}},
  {"id":"T2","isResolved":false,"comments":{"nodes":[{"author":{"login":"revB"}}]}}
]}}}}}' | jq -c --arg me guilleazoubel --argjson seen '["T1"]' '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | select((.comments.nodes[0].author.login|ascii_downcase) != ($me|ascii_downcase)) | .id] - $seen'
```
Expected: `SYNTAX OK` and `["T2"]` (T1 already seen → excluded; T2 is new).

- [ ] **Step 3: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: watch daemon detects new reviewer comments on my PRs → triage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Mutation helpers — `--reply-comment`, `--commit-fix`, `--push-fix`

**Files:**
- Modify: `bin/cgremlin` — add three functions near `approve_pr` (~line 252) and their dispatch near `--approve-pr` (~line 12568).

**Interfaces:**
- Consumes: `read_session_field`, `_pr_repo`.
- Produces:
  - `reply_comment SESSION_NAME THREAD_ID` — posts `SESSION_DIR/.reply_body.md` as a reply to review thread `THREAD_ID` via `gh api graphql addPullRequestReviewThreadReply`.
  - `commit_fix SESSION_NAME MSG` — `git add -A && git commit -m MSG` in the session repo.
  - `push_fix SESSION_NAME` — `git push` the current branch from the session repo.
  - Dispatches `--reply-comment`, `--commit-fix`, `--push-fix`.

- [ ] **Step 1: Add the helper functions**

Add after `approve_pr()` (~line 256):

```bash
# Reply to a review thread with the text in SESSION_DIR/.reply_body.md.
reply_comment() {
    local d="$SESSIONS_DIR/$1" tid="$2"
    local body="$d/.reply_body.md"
    [ -f "$body" ] || { echo "ERROR: $body not found" >&2; return 1; }
    [ -n "$tid" ] || { echo "ERROR: thread id required" >&2; return 1; }
    local text; text=$(cat "$body")
    gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){comment{id}}}' \
        -F t="$tid" -F b="$text" >/dev/null && echo "replied to $tid" || { echo "ERROR: reply failed" >&2; return 1; }
}
# Commit staged+unstaged changes in the session repo.
commit_fix() {
    local d="$SESSIONS_DIR/$1"; shift
    local msg="$*"; [ -n "$msg" ] || msg="fix: address review comment"
    ( cd "$d/repo" && git add -A && git commit -m "$msg" ) && echo "committed" || { echo "ERROR: commit failed" >&2; return 1; }
}
# Push the PR branch from the session repo.
push_fix() {
    local d="$SESSIONS_DIR/$1"
    ( cd "$d/repo" && git push ) && echo "pushed" || { echo "ERROR: push failed" >&2; return 1; }
}
```

- [ ] **Step 2: Add the dispatches**

Next to the `--approve-pr`/`--comment-pr` dispatch lines (~line 12568):

```bash
if [ "$1" = "--reply-comment" ]; then [ -z "$3" ] && { echo "Usage: cgremlin --reply-comment <session> <thread-id>" >&2; exit 1; }; reply_comment "$2" "$3"; exit $?; fi
if [ "$1" = "--commit-fix" ];   then [ -z "$2" ] && { echo "Usage: cgremlin --commit-fix <session> [msg]" >&2; exit 1; }; s="$2"; shift 2; commit_fix "$s" "$@"; exit $?; fi
if [ "$1" = "--push-fix" ];     then [ -z "$2" ] && { echo "Usage: cgremlin --push-fix <session>" >&2; exit 1; }; push_fix "$2"; exit $?; fi
```

- [ ] **Step 3: Verify syntax, dispatch, and commit_fix functionally**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
for f in reply-comment commit-fix push-fix; do grep -q "\"\$1\" = \"--$f\"" bin/cgremlin && echo "DISPATCH $f OK"; done
# functional: commit_fix in a throwaway git repo
root=$(mktemp -d); mkdir -p "$root/pr-x/repo"; ( cd "$root/pr-x/repo" && git init -q && git config user.email t@t && git config user.name t && echo hi > f.txt )
CGREMLIN_SESSIONS_DIR="$root" bash -c 'source bin/cgremlin --lib-only; commit_fix pr-x "test commit"'
( cd "$root/pr-x/repo" && git log --oneline )
rm -rf "$root"
```
Expected: `SYNTAX OK`, three `DISPATCH ... OK`, `committed`, and one commit line `test commit`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: allowlisted mutation helpers (reply-comment/commit-fix/push-fix)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Interactive comment-triage pane (mine variant of AGENT_CONTEXT.md)

**Files:**
- Modify: `bin/cgremlin` — `create_review_agent_pane()` (~line 391-480): branch the settings allowlist and the `AGENT_CONTEXT.md` body on whether the session is a mine comment-triage (`pr_is_mine` && `mine_stage=ready`).

**Interfaces:**
- Consumes: `pr_is_mine`, `read_mine_stage`, existing pane-creation machinery (wrapper + `zellij action new-pane --floating`), the Task 5 helpers.
- Produces: when the opened session is a mine PR with `mine_stage=ready`, the floating pane's `AGENT_CONTEXT.md` is the comment-triage protocol and `settings.local.json` allows `Bash(cgremlin --reply-comment *)`, `Bash(cgremlin --commit-fix *)`, `Bash(cgremlin --push-fix *)`. Otherwise the existing review-triage context/permissions are used unchanged.

- [ ] **Step 1: Branch the permissions allowlist**

In `create_review_agent_pane`, the block that merges posting-command permissions currently uses:
```bash
    local add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
```
Replace with a branch:
```bash
    local add
    if pr_is_mine "$SDIR" && [ "$(read_mine_stage "$SDIR")" = "ready" ]; then
        add='["Bash(cgremlin --reply-comment *)","Bash(cgremlin --commit-fix *)","Bash(cgremlin --push-fix *)"]'
    else
        add='["Bash(cgremlin --approve-pr *)","Bash(cgremlin --comment-pr *)","Bash(cgremlin --request-changes-pr *)"]'
    fi
```

- [ ] **Step 2: Branch the AGENT_CONTEXT.md body**

The function currently writes one `AGENT_CONTEXT.md` (the review-triage protocol). Wrap it so mine-ready sessions get the comment-triage protocol instead. Immediately before the existing `cat > "$SDIR/AGENT_CONTEXT.md" <<CTX` line, add:

```bash
    if pr_is_mine "$SDIR" && [ "$(read_mine_stage "$SDIR")" = "ready" ]; then
      cat > "$SDIR/AGENT_CONTEXT.md" <<MYCTX
# My PR — reviewer comment triage — PR #${num}: ${pr_title}

Your PR got reviewer comments. \`COMMENTS.md\` in this directory has each comment
already classified ✅ valid or 🟡 false-positive, with reasoning and a proposed
reply/fix. Walk me through them so I can decide each one.

## First message — open with the roll-up
Read \`COMMENTS.md\`, then print one line and a numbered list. Nothing else:

    3 comments — 2 valid, 1 false-positive. Go through them? (number, or "all")
    1. ✅ valid          api/save.ts:12   missing await
    2. 🟡 false-positive ui/list.tsx:40   "unused" var is used
    3. ✅ valid          cart.ts:88       off-by-one

## Per comment
Show the reviewer's comment, where it is, your verdict + reasoning, and the
proposed reply or fix. Then wait for my decision:
- **"reply"** (usually for false-positive): write the explanation to \`${SDIR}/.reply_body.md\`, then run \`cgremlin --reply-comment $(basename "$SDIR") <thread-id>\` (thread id is in the entry). Set that entry's Status to \`replied\`.
- **"fix"** (for valid): make the code change, then \`cgremlin --commit-fix $(basename "$SDIR") "<message>"\`. Do NOT push yet.
- **"push"**: when I ask, \`cgremlin --push-fix $(basename "$SDIR")\` to push all committed fixes.
- **"skip"**: set Status to \`skipped\`.

Update the entry's **Status** in COMMENTS.md after each action, then return to the list.

## Constraints
- Never reply, commit, or push without my explicit say-so for that item.
- Only use the \`cgremlin\` helpers above — do not call \`gh\` or \`git push\` directly.
- Write \`.reply_body.md\` to the session root path shown above.
MYCTX
    else
```
and add a matching `fi` immediately AFTER the existing `CTX` heredoc terminator line. (The existing review-triage `cat > ... <<CTX ... CTX` becomes the `else` body.)

- [ ] **Step 3: Verify syntax and that both contexts render**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "SYNTAX OK"
# mine+ready → comment-triage context; others → review context. Exercise the
# selector logic directly (ZELLIJ guard makes the real fn a no-op off-Zellij).
root=$(mktemp -d); mkdir -p "$root/pr-mine/repo" "$root/pr-other/repo"
printf '{"pr":{"number":"2","author":"guilleazoubel","title":"t"},"mine_stage":"ready"}' > "$root/pr-mine/session.json"
printf '{"pr":{"number":"4","author":"someoneelse","title":"t"}}' > "$root/pr-other/session.json"
CGREMLIN_SESSIONS_DIR="$root" GITHUB_ME=guilleazoubel bash -c 'source bin/cgremlin --lib-only;
  pr_is_mine "'"$root"'/pr-mine" && [ "$(read_mine_stage "'"$root"'/pr-mine")" = ready ] && echo "MINE→triage" || echo "MINE→wrong";
  pr_is_mine "'"$root"'/pr-other" && echo "OTHER→wrong" || echo "OTHER→review"'
rm -rf "$root"
```
Expected: `SYNTAX OK`, `MINE→triage`, `OTHER→review`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: interactive comment-triage pane for my PRs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- After all tasks: restart the watch daemon so the new routing/monitoring is live — `pkill -f "cgremlin --watch-daemon"; (cgremlin --watch-daemon &)` — and confirm in `~/.cgremlin/sessions/.watch-daemon.log` that your own open PRs log `track my PR #…` (not `auto-pickup`).
- `_pr_repo SESSION_DIR` is an existing helper returning `owner/repo`; if a task can't find it, derive from `pr.url` instead.
- No Python-server (`PYSERVER`) changes are required; if any task touches it, re-run the `ast.parse` check from `CLAUDE.md`.
