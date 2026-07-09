# Session Reuse + Investigate→Develop In One Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the status panel from duplicating work — one session per PR review (re-review in place, never a new dir), and investigate→develop as one continuous session (promote in place, no second `dev-*` session).

**Architecture:** `review_pr_noninteractive` gains a dedupe/route step (existing PR session → re-review-if-changed / else open). `develop_start` is rewritten to promote the investigation's OWN session in place — flip `mode` to development, keep `FINDINGS.md`, add `DEVELOPMENT.md`, swap the brief, close the `🔍` tab and open a `🔨` tab on the same session dir. Type detection already reads the `mode` field, so no detection changes are needed.

**Tech Stack:** Bash single script `bin/cgremlin`; Zellij tab actions; `gh`; `jq`.

## Global Constraints

- **`bin/cgremlin` is the ONLY file changed.** After every edit: `bash -n bin/cgremlin` passes. The Python `PYSERVER` heredoc is NOT touched by this plan (type detection there already has a `mode`-field fallback) → no `ast.parse` step needed.
- **One session per PR** from every entry point. A review triggered for a PR that already has a session must NOT create a second session dir.
- **Review dedupe routing:** existing session + PR head SHA ≠ `reviewed_sha` (or head unreadable) → `rereview_pr`; head == `reviewed_sha` → `open_pr_row`; no session → create + headless review (unchanged).
- **Promotion is in place:** `develop_start` operates on the investigation's own `$SDIR`. It MUST NOT call `create_development_session_noninteractive` / create a new dir / clone / copy `FINDINGS.md`. It flips `session.json` `mode` to `development`, keeps `FINDINGS.md`, creates `DEVELOPMENT.md`, and echoes the SAME session name.
- **`mode` is the source of truth** for session type; the dir-name prefix (`inv-`/`dev-`/`pr-`) is NOT changed and NOT relied on. (Existing detection already reads `mode` — do not add prefix-based branches.)
- **Doc names:** keep `FINDINGS.md` (rename to `INVESTIGATION.md` is a deferred follow-up spec). Introduce `DEVELOPMENT.md` (new file). Develop reads `FINDINGS.md` (primary) + `REVIEW.md` (if present).
- **Tab transition** = close the old `🔍 <key>` tab + open a fresh `🔨 <key>` tab (Zellij is driven by close-tab/new-tab, not rename), both pointing at the same session dir. `work_agent_tab_name` already returns the right emoji from `mode`.
- DRY / YAGNI: reuse `read_reviewed_sha`, `rereview_pr`, `open_pr_row`, `write_develop_brief`, `create_work_agent_pane`, `work_agent_tab_name`, `update_session_field`. No unit-test framework — verify via `bash -n` + awk-extract-and-run with stubs.

## File Structure

`bin/cgremlin` only:
- `review_pr_noninteractive` (~13692–13701): add dedupe/route (Task 1).
- `develop_start` (~13607–13630): rewrite to promote in place (Task 2).
- `write_develop_brief` (~13556–13602): read `FINDINGS.md` + `REVIEW.md`, maintain `DEVELOPMENT.md` (Task 2).
- `create_development_session_noninteractive` (~13517): left in place but no longer called by promotion (note only; do not delete — avoids breaking any unseen caller).
- One-time operational cleanup of the orphan `inv-…152350` (Task 3).

---

### Task 1: Review-session dedupe in `review_pr_noninteractive`

**Files:** Modify `bin/cgremlin` — `review_pr_noninteractive` (~13692).

**Interfaces:**
- Consumes: `read_reviewed_sha SDIR`, `rereview_pr SESSION`, `open_pr_row SESSION`, `create_pr_session_noninteractive`, `launch_headless_review`, `update_review_state` (all existing).
- Produces: `review_pr_noninteractive <pr-url>` never creates a duplicate session for a PR that already has one.

- [ ] **Step 1: Replace the function body**

Replace `review_pr_noninteractive` (currently lines ~13692–13701) with:
```bash
review_pr_noninteractive() {
    local pr_input="$1"
    # Dedupe by PR number: reuse an existing session rather than create a duplicate.
    if [[ "$pr_input" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
        local o="${BASH_REMATCH[1]}" r="${BASH_REMATCH[2]}" n="${BASH_REMATCH[3]}"
        local existing; existing=$(ls -dt "$SESSIONS_DIR"/pr-*-"${n}"-* 2>/dev/null | head -1)
        if [ -n "$existing" ] && [ -d "$existing/repo" ]; then
            local esn; esn=$(basename "$existing")
            local head; head=$(timeout 15 gh pr view "$n" --repo "$o/$r" --json headRefOid -q .headRefOid 2>/dev/null)
            if [ -z "$head" ] || [ "$head" != "$(read_reviewed_sha "$existing")" ]; then
                echo "PR #$n already tracked ($esn) — re-reviewing in place" >&2
                rereview_pr "$esn"; echo "$esn"; return 0
            fi
            echo "PR #$n already tracked ($esn), no new commits — opening it" >&2
            open_pr_row "$esn" 2>/dev/null || true; echo "$esn"; return 0
        fi
    fi
    # No existing session (or unparseable URL) → create + review (original behavior).
    local session_name
    session_name=$(create_pr_session_noninteractive "$pr_input" "" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: session creation failed" >&2; return 1; }
    local session_dir="$SESSIONS_DIR/$session_name"
    update_review_state "$session_dir" queued
    launch_headless_review "$session_dir"
    echo "$session_name"
}
```

- [ ] **Step 2: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 3: Behavioral test with stubs**

The glob `pr-*-<n>-*` matches only the exact number segment (e.g. `-1711-`, never `-171-`). Verify routing:
```bash
awk '/^review_pr_noninteractive\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/rpn.sh
export SESSIONS_DIR=$(mktemp -d)
mkdir -p "$SESSIONS_DIR/pr-grace-frontend-1711-20260101-000000/repo"
run(){ bash -c '
. /tmp/rpn.sh
gh(){ echo "NEWHEAD"; }
read_reviewed_sha(){ echo "'"$1"'"; }   # arg is a fn placeholder; overridden below per-case
rereview_pr(){ echo "REREVIEW $1"; }
open_pr_row(){ echo "OPEN $1"; }
create_pr_session_noninteractive(){ echo "created-new"; }
update_review_state(){ :; }
launch_headless_review(){ echo "HEADLESS $1"; }
'"$1"'
review_pr_noninteractive "https://github.com/aplaceformom/grace-frontend/pull/1711"
'; }
echo "--- changed (head != reviewed_sha) ---"
run 'read_reviewed_sha(){ echo OLD; }'                       # expect: REREVIEW pr-grace-frontend-1711-...
echo "--- unchanged (head == reviewed_sha) ---"
run 'read_reviewed_sha(){ echo NEWHEAD; } gh(){ echo NEWHEAD; }'  # expect: OPEN pr-grace-frontend-1711-...
echo "--- no existing session (different PR) ---"
bash -c '. /tmp/rpn.sh
gh(){ echo H; }; read_reviewed_sha(){ echo X; }; rereview_pr(){ echo RR; }; open_pr_row(){ echo OP; }
create_pr_session_noninteractive(){ echo created-new; }; update_review_state(){ :; }; launch_headless_review(){ echo "HEADLESS $1"; }
review_pr_noninteractive "https://github.com/aplaceformom/grace-frontend/pull/2222"'   # expect: created-new + HEADLESS
```
Expected: case 1 prints `REREVIEW pr-grace-frontend-1711-20260101-000000`; case 2 prints `OPEN pr-grace-frontend-1711-20260101-000000`; case 3 prints `HEADLESS …/created-new` and `created-new` (no dedupe, creates fresh). (If the stub-shadowing of `gh`/`read_reviewed_sha` is awkward in your shell, assert the three routes however is cleanest — the point is: existing+changed→rereview, existing+unchanged→open, none→create.)

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "fix: --review-pr reuses an existing PR session (re-review if changed, else open)"
```

---

### Task 2: Promote investigate→develop in the same session

**Files:** Modify `bin/cgremlin` — `develop_start` (~13607) and `write_develop_brief` (~13556).

**Interfaces:**
- Consumes: `read_session_field`, `update_session_field`, `work_agent_tab_name`, `write_develop_brief`, `create_work_agent_pane` (all existing).
- Produces: `develop_start <session>` transitions THAT session to development in place and echoes the same session name; no `dev-*` dir is created.

- [ ] **Step 1: Rewrite `develop_start`**

Replace `develop_start` (currently ~13607–13630) with:
```bash
develop_start() {
    local sess="$1"                       # investigation session to promote IN PLACE
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR/repo" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    local jira; jira=$(read_session_field "$SDIR" "jira.ticket")
    # Compute the OLD tab name (🔍 …) BEFORE flipping mode, so we can close it.
    local old_tab; old_tab=$(work_agent_tab_name "$SDIR")
    # Retire the investigation agent and close its 🔍 tab.
    local ipid; ipid=$(cat "$SDIR/agent_pid" 2>/dev/null)
    [ -n "$ipid" ] && kill "$ipid" 2>/dev/null; rm -f "$SDIR/agent_pid"
    zellij --session mission-control action go-to-tab-name "$old_tab" 2>/dev/null && \
      zellij --session mission-control action close-tab 2>/dev/null || true
    # Transition the SAME session to development. mode is the source of truth;
    # the dir keeps its inv-* name (all live type-detection reads the mode field).
    update_session_field "$SDIR" "mode" "development"
    local branch="feature/${jira:-work}"
    ( cd "$SDIR/repo" && { git checkout -b "$branch" 2>/dev/null || git checkout "$branch" 2>/dev/null || true; } )
    update_session_field "$SDIR" "branch" "$branch"
    # Docs: FINDINGS.md stays (the investigation handoff); start DEVELOPMENT.md.
    [ -f "$SDIR/DEVELOPMENT.md" ] || printf '# Development log — %s\n\nPlan and progress, maintained by the develop agent.\n' "${jira:-work}" > "$SDIR/DEVELOPMENT.md"
    # Swap the brief and open the develop agent in the SAME session (creates the 🔨 tab).
    write_develop_brief "$SDIR"
    create_work_agent_pane "$SDIR"
    echo "$sess"
}
```

- [ ] **Step 2: Point the develop brief at FINDINGS + REVIEW + DEVELOPMENT.md**

In `write_develop_brief` (`<<DEV`, unquoted), update the intro + step 1. Replace the intro lines (currently ~13561–13564):
```
You are running in the session directory. The code is in \`./repo/\`. \`FINDINGS.md\`
here is your seeded investigation (root cause + direction). The Jira ticket
${key:+(${key}) — fetch via Atlassian MCP getJiraIssue} is the source of truth.
Cover ONLY what the ticket asks.
```
with:
```
You are running in the session directory. The code is in \`./repo/\`. \`FINDINGS.md\`
here is your investigation (root cause + direction) — your PRIMARY seed. If a
\`REVIEW.md\` is present, read it too. Keep a running plan/progress log in
\`DEVELOPMENT.md\`. The Jira ticket
${key:+(${key}) — fetch via Atlassian MCP getJiraIssue} is the source of truth.
Cover ONLY what the ticket asks.
```
And replace step 1 (currently ~13567):
```
1. **Read FINDINGS.md + the ticket.** Refine into a concrete implementation plan (root cause is already known).
```
with:
```
1. **Read FINDINGS.md (and REVIEW.md if present) + the ticket.** Refine into a concrete implementation plan (root cause is already known); capture it in DEVELOPMENT.md.
```
And update the final line (currently ~13597):
```
BEGIN NOW: read FINDINGS.md + the ticket and prepare the plan for the PLAN GATE.
```
to:
```
BEGIN NOW: read FINDINGS.md (and REVIEW.md if present) + the ticket, write your plan into DEVELOPMENT.md, and prepare it for the PLAN GATE.
```

- [ ] **Step 3: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 4: Behavioral test — promote in place, no new dir**

```bash
awk '/^work_agent_tab_name\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/fns.sh
awk '/^write_develop_brief\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin >> /tmp/fns.sh
awk '/^develop_start\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin >> /tmp/fns.sh
export SESSIONS_DIR=$(mktemp -d)
S="$SESSIONS_DIR/inv-grace-frontend-20260101-000000"; mkdir -p "$S/repo"
( cd "$S/repo" && git init -q 2>/dev/null && git commit -q --allow-empty -m init 2>/dev/null )
printf '{"mode":"investigation","jira":{"ticket":"HB-1"}}\n' > "$S/session.json"
printf 'root cause: X\n' > "$S/FINDINGS.md"
before=$(ls -d "$SESSIONS_DIR"/*/ | wc -l | tr -d ' ')
bash -c '. /tmp/fns.sh
read_session_field(){ jq -r ".$2 // empty" "$1/session.json" 2>/dev/null; }
update_session_field(){ tmp=$(jq --arg v "$3" ".$2=\$v" "$1/session.json"); echo "$tmp" > "$1/session.json"; }
zellij(){ :; }
create_work_agent_pane(){ echo "PANE $1"; }
develop_start "inv-grace-frontend-20260101-000000"'
after=$(ls -d "$SESSIONS_DIR"/*/ | wc -l | tr -d ' ')
echo "--- checks ---"
echo "dirs before/after: $before/$after   (expect equal — NO new session dir)"
jq -r '.mode' "$S/session.json"                 # expect development
ls "$S/FINDINGS.md" >/dev/null && echo "FINDINGS kept"     # expect present
ls "$S/DEVELOPMENT.md" >/dev/null && echo "DEVELOPMENT created"  # expect present
command grep -c 'DEVELOP —' "$S/CLAUDE.md"      # expect 1 (develop brief written)
command grep -c 'REVIEW.md if present' "$S/CLAUDE.md"  # expect >=1 (brief reads review too)
ls -d "$SESSIONS_DIR"/dev-* 2>/dev/null && echo "BUG: dev-* created" || echo "no dev-* dir (correct)"
```
Expected: before==after; mode `development`; FINDINGS kept; DEVELOPMENT created; develop brief present with the FINDINGS+REVIEW wording; no `dev-*` dir.

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: promote investigate→develop in the same session (no new dev-* session)"
```

---

### Task 3: Reconcile the existing orphan + live smoke

**Non-code** (cleanup + verification).

- [ ] **Step 1: Remove the orphan investigation left by the OLD flow**

The old flow already made `HB-1094` as two sessions. The develop session is active and carries the findings, so remove the orphan investigation:
```bash
SD="$HOME/.cgremlin/sessions"
# Confirm the dev session exists and has the findings before removing the inv orphan.
ls "$SD"/dev-grace-frontend-HB-1094-*/FINDINGS.md 2>/dev/null && {
  d="$SD/inv-grace-frontend-20260709-152350"
  apid=$(cat "$d/agent_pid" 2>/dev/null); [ -n "$apid" ] && kill "$apid" 2>/dev/null
  rm -rf "$d" && echo "removed orphan inv-…152350"
}
./bin/cgremlin --review-list-grouped 2>&1 | sed 's/\t/ | /g' | grep -A5 'Your work'
```
Expected: the `🔨 Your work` section shows `HB-1094` ONCE (the dev session) and `HB-1080` once.

- [ ] **Step 2: Restart Mission Control on the new code (user-gated)**

Ask the user before this — it kills any in-flight WORK agents:
```bash
pkill -f 'cgremlin --watch-daemon'; pkill -f '.dashboard_server.py'; cgremlin --mission-control --fresh
# then restart watch-daemon + dashboard as in the runbook
```

- [ ] **Step 3: Live smoke — promote in place**

Start a fresh investigation (orchestrator: "I'm investigating HB-XXXX"), let it produce FINDINGS.md, then promote ("build it" / `cgremlin --develop <inv-session>`). Confirm:
- NO new `dev-*` dir appears; the original `inv-…` dir now has `mode=development`, `DEVELOPMENT.md`, and the develop `CLAUDE.md`, with `FINDINGS.md` intact.
- The tab flips `🔍 HB-XXXX` → `🔨 HB-XXXX`; the develop agent runs in it.
- `🔨 Your work` shows exactly ONE row for HB-XXXX.

- [ ] **Step 4: Review dedupe smoke**

With an existing PR session, trigger a review for the same PR via the orchestrator/`--review-pr` and confirm NO new session dir is created (it re-reviews or opens).

- [ ] **Step 5: Report** results. No commit.

---

## Execution notes

- Type detection needs NO changes: `setup_output_files` (bash + Python), `get_session_mode`, `work_agent_tab_name`, and `open_pr_row`'s WORK branch already read the `mode` field; the only prefix-based branches are V1 no-`session.json` fallbacks that never fire for a valid session. Confirm this holds; do not add prefix churn.
- `create_development_session_noninteractive` is intentionally left in place (unused by promotion now) to avoid breaking any unseen caller; a later cleanup can remove it if confirmed dead.
- The `FINDINGS.md`→`INVESTIGATION.md` rename is a separate follow-up spec (kept out of scope here to isolate its regression risk).
