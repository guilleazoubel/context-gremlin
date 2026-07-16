# Investigation → Plan Review → Development Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Investigation sessions draft a plan (`PLAN.md`) at the top quality tier (Opus/xhigh), have it reviewed by PM + Principal Engineer subagents before development starts, and gate promotion on the user's explicit approval (with an opt-in bypass for hands-off runs).

**Architecture:** All changes live in `/Users/guilherme.azoubel/context-gremlin/bin/cgremlin` (bash + embedded PYSERVER Python heredoc). Reuses existing patterns throughout: `REVIEW_MODEL`'s config precedent, `ui_check_protocol()`'s Task-tool subagent dispatch, `--approve-pr`'s safety-gate convention, and the FINDINGS tab's file-serving/markdown-rendering mechanism (no new API surface for the plan content itself — PM/Principal Engineer verdicts are written as a section inside `PLAN.md`, rendered by the exact same pipeline).

**Tech Stack:** bash, Python 3 (stdlib `http.server`, no framework), vanilla JS + `marked.js` (dashboard frontend), `jq` (JSON manipulation in bash), `claude` CLI (`--model`, `--effort`, Task tool).

## Global Constraints

- Every `bin/cgremlin` edit MUST be verified with `bash -n bin/cgremlin` (bash syntax) AND by extracting the PYSERVER heredoc and running Python's `ast.parse()` on it (see Task 1's verification snippet — reuse it verbatim in every task).
- Never hardcode secrets in `bin/cgremlin` (it's committed to git). Model/effort names are not secrets and may be literal defaults.
- Never delete or hide any session — this feature only adds gating and a new document; existing "never hide/delete on progression" rules from `docs/session-lineage.md` are unaffected.
- Old sessions created before this feature ships have no `plan_review` field — every read of `plan_review.*` must treat absence as "not gated" (today's existing unblocked promotion behavior), never as an implicit failure.
- Re-verify every line number in this plan against the current file before editing — `bin/cgremlin` has been edited many times; if a line number is off by a few lines, locate the function by name (grep) rather than assume the plan is wrong.
- Do not commit any task's changes until its own verification steps pass. Follow the "no commit without review" project convention: after all tasks are implemented and the final live-verification task (Task 11) passes, stop and let the user review before any `git commit`.

---

### Task 1: Config — `INVESTIGATION_MODEL` / `INVESTIGATION_EFFORT`

**Files:**
- Modify: `bin/cgremlin:32-73` (`load_config()`)
- Modify: `bin/cgremlin:76-116` (`save_config()`)
- Test: throwaway shell script under the session scratchpad (not committed to the repo)

**Interfaces:**
- Produces: bash variables `$INVESTIGATION_MODEL` (default `"opus"`) and `$INVESTIGATION_EFFORT` (default `"xhigh"`), available anywhere after `load_config` runs — consumed by Task 2.

- [ ] **Step 1: Re-locate the exact current lines**

Run: `grep -n "MODEL) MODEL=\|REVIEW_MODEL) REVIEW_MODEL=" bin/cgremlin`
Expected: two lines inside `load_config()`'s case statement, a few lines apart. Use these as your insertion anchor instead of trusting the line numbers below verbatim.

- [ ] **Step 2: Add the config keys to `load_config()`**

Find this existing block (the case-statement arm for `REVIEW_MODEL`, added earlier for the review-model feature):
```bash
                REVIEW_MODEL) REVIEW_MODEL="$value" ;;
```
Add immediately after it:
```bash
                INVESTIGATION_MODEL) INVESTIGATION_MODEL="$value" ;;
                INVESTIGATION_EFFORT) INVESTIGATION_EFFORT="$value" ;;
```
Then find the defaulting block near the end of `load_config()` (look for `: "${VERCEL_SCOPE:=grace-0118bc61}"`-style lines) and add:
```bash
    : "${INVESTIGATION_MODEL:=opus}"
    : "${INVESTIGATION_EFFORT:=xhigh}"
```

- [ ] **Step 3: Add the keys to `save_config()`**

Find where `REVIEW_MODEL="$REVIEW_MODEL"` is written in the heredoc inside `save_config()`, and add immediately after it:
```bash
INVESTIGATION_MODEL="$INVESTIGATION_MODEL"
INVESTIGATION_EFFORT="$INVESTIGATION_EFFORT"
```

- [ ] **Step 4: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output, exit code 0.

- [ ] **Step 5: Write and run a throwaway test**

Create `/tmp/cg-test-config.sh`:
```bash
#!/bin/bash
set -e
TMPCONF=$(mktemp -d)
export HOME="$TMPCONF"
mkdir -p "$HOME/.cgremlin"
cat > "$HOME/.cgremlin/config" <<'EOF'
MODEL="sonnet"
EOF
source <(sed -n '/^load_config()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)
CONFIG_DIR="$HOME/.cgremlin"
CONFIG_FILE="$HOME/.cgremlin/config"
load_config
[ "$INVESTIGATION_MODEL" = "opus" ] || { echo "FAIL: default INVESTIGATION_MODEL, got '$INVESTIGATION_MODEL'"; exit 1; }
[ "$INVESTIGATION_EFFORT" = "xhigh" ] || { echo "FAIL: default INVESTIGATION_EFFORT, got '$INVESTIGATION_EFFORT'"; exit 1; }
echo "PASS: defaults ok"

cat >> "$HOME/.cgremlin/config" <<'EOF'
INVESTIGATION_MODEL="haiku"
INVESTIGATION_EFFORT="low"
EOF
unset INVESTIGATION_MODEL INVESTIGATION_EFFORT
load_config
[ "$INVESTIGATION_MODEL" = "haiku" ] || { echo "FAIL: explicit INVESTIGATION_MODEL"; exit 1; }
[ "$INVESTIGATION_EFFORT" = "low" ] || { echo "FAIL: explicit INVESTIGATION_EFFORT"; exit 1; }
echo "PASS: explicit override ok"
rm -rf "$TMPCONF"
```
Run: `bash /tmp/cg-test-config.sh`
Expected: `PASS: defaults ok` then `PASS: explicit override ok`, exit code 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(config): add INVESTIGATION_MODEL/INVESTIGATION_EFFORT (default opus/xhigh)"
```

---

### Task 2: Mode-aware model/effort in `create_work_agent_pane()`

**Files:**
- Modify: `bin/cgremlin:934-973` (`create_work_agent_pane()`)

**Interfaces:**
- Consumes: `$INVESTIGATION_MODEL`, `$INVESTIGATION_EFFORT` (Task 1), `$MODEL` (existing), `read_session_field` (existing helper, signature `read_session_field SESSION_DIR field_path`).
- Produces: no new interface — same function signature (`create_work_agent_pane SESSION_DIR`), now launches investigation-mode sessions on Opus+xhigh and every other mode unchanged on `$MODEL`.

- [ ] **Step 1: Re-locate the function**

Run: `grep -n "^create_work_agent_pane()" bin/cgremlin`

- [ ] **Step 2: Add mode-aware model/effort selection**

Inside `create_work_agent_pane()`, before the `wrapper=$(mktemp ...)` line, add:
```bash
    local _mode; _mode=$(read_session_field "$SDIR" "mode")
    local _launch_model="$MODEL" _effort_flag=""
    if [ "$_mode" = "investigation" ]; then
        _launch_model="$INVESTIGATION_MODEL"
        _effort_flag="--effort $INVESTIGATION_EFFORT"
    fi
```
Then change the `exec claude` line inside the heredoc from:
```bash
exec claude --model "$MODEL" "Your very first action: read CLAUDE.md in this directory and follow it exactly — it is your autonomous working brief. Begin now; do not wait for my input; do not read any other CLAUDE.md."
```
to:
```bash
exec claude --model "$_launch_model" $_effort_flag "Your very first action: read CLAUDE.md in this directory and follow it exactly — it is your autonomous working brief. Begin now; do not wait for my input; do not read any other CLAUDE.md."
```
(`$_effort_flag` is deliberately unquoted so an empty value disappears as a no-op argument rather than passing a literal empty string to `claude`; this matches how other optional-flag variables are handled elsewhere in this file.)

- [ ] **Step 3: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.

- [ ] **Step 4: Write and run a throwaway test (heredoc content check, not a live claude launch)**

Create `/tmp/cg-test-launch-model.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
SESSIONS_DIR="$TMPD"
mkdir -p "$SESSIONS_DIR/inv-test/repo"
cat > "$SESSIONS_DIR/inv-test/session.json" <<'EOF'
{"mode": "investigation"}
EOF
mkdir -p "$SESSIONS_DIR/dev-test/repo"
cat > "$SESSIONS_DIR/dev-test/session.json" <<'EOF'
{"mode": "development"}
EOF

# Stub zellij so create_work_agent_pane's mission-control check fails fast and
# we can inspect the wrapper it WOULD have written. We do this by extracting
# just the model-selection logic, not the full function, to keep this test
# fast and focused.
MODEL="sonnet"
INVESTIGATION_MODEL="opus"
INVESTIGATION_EFFORT="xhigh"

read_session_field() {
  local dir="$1" field="$2"
  jq -r ".$field // empty" "$dir/session.json"
}

check() {
  local sdir="$1" expect_model="$2" expect_effort="$3"
  local _mode; _mode=$(read_session_field "$sdir" "mode")
  local _launch_model="$MODEL" _effort_flag=""
  if [ "$_mode" = "investigation" ]; then
    _launch_model="$INVESTIGATION_MODEL"
    _effort_flag="--effort $INVESTIGATION_EFFORT"
  fi
  [ "$_launch_model" = "$expect_model" ] || { echo "FAIL ($sdir): model = $_launch_model, want $expect_model"; exit 1; }
  [ "$_effort_flag" = "$expect_effort" ] || { echo "FAIL ($sdir): effort flag = '$_effort_flag', want '$expect_effort'"; exit 1; }
  echo "PASS ($sdir)"
}

check "$SESSIONS_DIR/inv-test" "opus" "--effort xhigh"
check "$SESSIONS_DIR/dev-test" "sonnet" ""
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-launch-model.sh`
Expected: `PASS (.../inv-test)` then `PASS (.../dev-test)`.

- [ ] **Step 5: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(investigation): launch investigation sessions on INVESTIGATION_MODEL/EFFORT"
```

---

### Task 3: Development-intent flag on investigation creation

**Files:**
- Modify: `bin/cgremlin:14049-14080` (`create_investigation_session_noninteractive()`)
- Modify: `bin/cgremlin:14130-14141` (`investigate_start()`)
- Modify: `bin/cgremlin:14611-14613` (CLI dispatch for `--investigate`)

**Interfaces:**
- Produces: `session.json` field `intent` set to `"development"` or `"investigate_only"` (default `"investigate_only"` when the flag is absent, so old call sites and manual `--investigate` usage keep today's behavior of stopping at findings unless the human later asks to continue).
- Produces: `session.json` field `plan_review.drive_to_completion` (boolean), set when `--drive-to-completion` is passed.

- [ ] **Step 1: Re-locate the three call sites**

Run: `grep -n "^create_investigation_session_noninteractive()\|^investigate_start()\|\"--investigate\"" bin/cgremlin`

- [ ] **Step 2: Extend `create_investigation_session_noninteractive()` to accept and store intent**

Current signature reads `local REPO_URL="$1" FOCUS="$2" JIRA_TICKET="$3"`. Change to add a fourth positional parameter and thread it into `extra_json`:
```bash
create_investigation_session_noninteractive() {
    local REPO_URL="$1"
    local FOCUS="$2"
    local JIRA_TICKET="$3"
    local INTENT="${4:-investigate_only}"
    local DRIVE_TO_COMPLETION="${5:-false}"

    # Parse repo URL
    local REPO_NAME=$(basename "$REPO_URL" .git)
    local SESSION_NAME="inv-${REPO_NAME}-$(date +%Y%m%d-%H%M%S)"
    local SESSION_DIR="$SESSIONS_DIR/$SESSION_NAME"

    mkdir -p "$SESSION_DIR"
    cd "$SESSION_DIR"

    # Clone repo
    git clone --depth=1 --single-branch "$REPO_URL" repo 2>/dev/null

    # Create session.json
    local extra_json=$(cat <<EOF
{
    "focus": "$FOCUS",
    "intent": "$INTENT",
    "plan_review": {"drive_to_completion": $DRIVE_TO_COMPLETION}
}
EOF
)
    [ -n "$JIRA_TICKET" ] && extra_json=$(echo "$extra_json" | jq ". + {jira: {ticket: \"$JIRA_TICKET\"}}")

    create_session_json "$SESSION_DIR" "investigation" "$REPO_URL" "$extra_json"

    # Create CLAUDE.md for investigation mode
    generate_claude_md "$SESSION_DIR" "investigation" "$FOCUS"

    echo "$SESSION_NAME"
}
```
(`$DRIVE_TO_COMPLETION` is interpolated as a bare `true`/`false` token, not a quoted string, so it lands in the JSON as a real boolean — match the exact literal `true`/`false` when calling this function.)

- [ ] **Step 3: Extend `investigate_start()` to pass these through**

Current body:
```bash
investigate_start() {
    local repo_url="$1" jira="$2"
    local session_name
    session_name=$(create_investigation_session_noninteractive "$repo_url" "" "$jira" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: investigation session creation failed" >&2; return 1; }
    local SDIR="$SESSIONS_DIR/$session_name"
    [ -n "$jira" ] && update_session_field "$SDIR" "jira.ticket" "$jira"
    write_investigate_brief "$SDIR"
    create_work_agent_pane "$SDIR"
    echo "$session_name"
}
```
Change to:
```bash
investigate_start() {
    local repo_url="$1" jira="$2" intent="${3:-investigate_only}" drive="${4:-false}"
    local session_name
    session_name=$(create_investigation_session_noninteractive "$repo_url" "" "$jira" "$intent" "$drive" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: investigation session creation failed" >&2; return 1; }
    local SDIR="$SESSIONS_DIR/$session_name"
    [ -n "$jira" ] && update_session_field "$SDIR" "jira.ticket" "$jira"
    write_investigate_brief "$SDIR"
    create_work_agent_pane "$SDIR"
    echo "$session_name"
}
```

- [ ] **Step 4: Extend the CLI dispatch to parse `--for-development` / `--drive-to-completion` flags**

Current:
```bash
if [ "$1" = "--investigate" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --investigate <repo-url> <jira-key>" >&2; exit 1; }
    investigate_start "$2" "$3"; exit $?
```
Change to:
```bash
if [ "$1" = "--investigate" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --investigate <repo-url> <jira-key> [--for-development] [--drive-to-completion]" >&2; exit 1; }
    _repo="$2"; _jira="$3"; _intent="investigate_only"; _drive="false"
    shift 3 2>/dev/null || shift $#
    for _arg in "$@"; do
        case "$_arg" in
            --for-development) _intent="development" ;;
            --drive-to-completion) _drive="true" ;;
        esac
    done
    investigate_start "$_repo" "$_jira" "$_intent" "$_drive"; exit $?
```

- [ ] **Step 5: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.

- [ ] **Step 6: Write and run a throwaway test**

Create `/tmp/cg-test-intent.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
SESSIONS_DIR="$TMPD/sessions"
mkdir -p "$SESSIONS_DIR"

source <(sed -n '/^create_session_json()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)
source <(sed -n '/^create_investigation_session_noninteractive()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)

generate_claude_md() { :; }  # stub — not under test here

name=$(create_investigation_session_noninteractive "file:///tmp/nonexistent" "" "HB-1" "development" "true" | tail -1)
intent=$(jq -r '.intent' "$SESSIONS_DIR/$name/session.json")
drive=$(jq -r '.plan_review.drive_to_completion' "$SESSIONS_DIR/$name/session.json")
[ "$intent" = "development" ] || { echo "FAIL: intent = $intent"; exit 1; }
[ "$drive" = "true" ] || { echo "FAIL: drive_to_completion = $drive"; exit 1; }
echo "PASS: development intent + drive_to_completion stored"

name2=$(create_investigation_session_noninteractive "file:///tmp/nonexistent" "" "" | tail -1)
intent2=$(jq -r '.intent' "$SESSIONS_DIR/$name2/session.json")
[ "$intent2" = "investigate_only" ] || { echo "FAIL: default intent = $intent2"; exit 1; }
echo "PASS: default intent is investigate_only"
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-intent.sh`
Expected: both `PASS` lines. (`git clone` will print a harmless error to stderr for the fake URL — ignore it, the test only checks `session.json`.)

- [ ] **Step 7: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(investigation): add --for-development / --drive-to-completion intent flags"
```

---

### Task 4: Orchestrator distinguishes ticket work from pure investigation

**Files:**
- Modify: `bin/cgremlin:14691-14710` (`launch_orchestrator()`'s CLAUDE.md heredoc)

**Interfaces:**
- Consumes: the `--for-development` flag from Task 3.
- No code interface — this is prompt-text only.

- [ ] **Step 1: Re-locate the heredoc**

Run: `grep -n "Starting work on a ticket" bin/cgremlin`

- [ ] **Step 2: Replace the "Starting work on a ticket" section**

Current text:
```
## Starting work on a ticket
When I tell you I'm picking up a ticket (e.g. "I'm on HB-1051", or paste a Jira key/URL),
run:  cgremlin --investigate <REPO_URL> <JIRA-KEY>
where <REPO_URL> is the DEFAULT_PROJECT repo (expand a bare key against it, same as you
do for PR numbers). That opens an investigation agent in the 🔨 WORK tab. Tell me it started.
Do not investigate yourself — the WORK-tab agent does the work.
```
Replace with:
```
## Starting work on a ticket
When I tell you I'm picking up or working on a ticket (e.g. "I'm on HB-1051", "let's build
HB-1051", or paste a Jira key/URL with clear intent to implement it), run:
  cgremlin --investigate <REPO_URL> <JIRA-KEY> --for-development
where <REPO_URL> is the DEFAULT_PROJECT repo (expand a bare key against it, same as you
do for PR numbers). This investigates first, then automatically drafts and reviews an
implementation plan, then pauses for my approval before any code is written.

If instead I ask you to investigate, look into, or figure out why something is happening —
with no stated intent to build/fix it — run the same command WITHOUT --for-development:
  cgremlin --investigate <REPO_URL> <JIRA-KEY>
This stops once FINDINGS.md is written; it will not draft a plan unless I later ask for one.

If I explicitly say not to stop and prompt me (e.g. "don't ask me anything, drive this to
completion" / "just get it all the way to a PR"), add --drive-to-completion to whichever
of the two commands above applies. This skips my final approval pause too — development
proceeds automatically once the plan is reviewed.

Either way, this opens an investigation agent in the 🔨 WORK tab. Tell me it started.
Do not investigate yourself — the WORK-tab agent does the work.
```

- [ ] **Step 3: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output (this is a heredoc text change only, but the heredoc is unquoted elsewhere in this file per today's earlier backtick bug — check this specific heredoc's delimiter).
Run: `grep -n "cat > \"\$odir/CLAUDE.md\" <<" bin/cgremlin`
Confirm the delimiter (e.g. `<<MD` vs `<<'MD'`). If unquoted, re-check the new text for stray backticks or `$(...)` — the text above contains none, but confirm with:
Run: `grep -n '`' bin/cgremlin | grep -A0 -B0 "Starting work on a ticket"` (expect no match — there are no backticks in the new section).

- [ ] **Step 4: Manual verification (no automated test — this is prompt text for a human-facing conversational agent)**

Read the full regenerated heredoc back:
Run: `sed -n '/# PR Review Orchestrator/,/^MD$/p' bin/cgremlin`
Expected: the new "Starting work on a ticket" section reads correctly with both branches (`--for-development` / plain) and the `--drive-to-completion` addendum, no broken bash interpolation (no literal `$SESSIONS_DIR` etc. left unexpanded where expansion was intended, and no accidentally-expanded variables where literal text was intended — compare against the original heredoc's use of `\$SESSIONS_DIR` for literal vs `${DEFAULT_PROJECT:-...}` for real interpolation).

- [ ] **Step 5: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(orchestrator): distinguish ticket work from pure investigation requests"
```

---

### Task 5: `write_investigate_brief()` — PLAN.md drafting, PM/Principal Engineer review, trigger logic

**Files:**
- Modify: `bin/cgremlin:14084-14126` (`write_investigate_brief()`)

**Interfaces:**
- Consumes: `session.json` fields `intent` and `plan_review.drive_to_completion` (Task 3).
- Produces: the investigation agent's own behavior (prompt text) — no new bash-callable interface, but establishes the `plan_review.phase` values (`findings`, `planning`, `plan_ready`) that Task 6/7/8 read.

- [ ] **Step 1: Re-locate the function**

Run: `grep -n "^write_investigate_brief()" bin/cgremlin`

- [ ] **Step 2: Replace the function body**

Current body (full, for reference — do not keep any of this except the `key=$(read_session_field ...)` line and the two trailing lines writing `.claude/settings.local.json`):
```bash
write_investigate_brief() {
    local SDIR="$1" key
    key=$(read_session_field "$SDIR" "jira.ticket")
    cat > "$SDIR/CLAUDE.md" <<INV
# INVESTIGATION — ${key:-(no ticket)}
...
INV
    mkdir -p "$SDIR/.claude"
    printf '{"permissions":{"allow":["Bash(cgremlin --develop *)","Bash(cgremlin --run-local *)","Bash(cgremlin --stop-local *)","Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"]}}\n' > "$SDIR/.claude/settings.local.json"
}
```
Replace with:
```bash
write_investigate_brief() {
    local SDIR="$1" key intent drive
    key=$(read_session_field "$SDIR" "jira.ticket")
    intent=$(read_session_field "$SDIR" "intent")
    drive=$(read_session_field "$SDIR" "plan_review.drive_to_completion")
    local sname; sname=$(basename "$SDIR")
    cat > "$SDIR/CLAUDE.md" <<INV
# INVESTIGATION — ${key:-(no ticket)}

You are running in the session directory. The PR/repo code is in \`./repo/\`.
Work autonomously. Your first deliverable is a complete, self-contained \`FINDINGS.md\`
in this directory — no code changes.

## Source of truth: the Jira ticket
${key:+The ticket is ${key}. Fetch it now via the Atlassian MCP (getJiraIssue) to read the summary, description, and acceptance criteria.} If the ticket is unavailable or absent, use whatever task description you were given. The ticket defines scope — investigate ONLY what it asks about.

## What to do (autonomously — do not ask me for routine steps)
1. Understand the request from the ticket.
   As your first action also record a one-line status: \`cgremlin --agent-note ${sname} "&lt;ticket key&gt;: &lt;one-line goal&gt;"\`. Update it at milestones (e.g. "tracing checkout path", "root cause found").
2. Explore \`./repo/\`: trace the relevant code paths, reproduce/understand the issue, find the ROOT CAUSE.
   For live web evals, run \`cgremlin --run-local ${sname}\` and wait for the URL, then drive the browser (chrome-devtools MCP) against https://local.findcare.dev.aplaceformom.com/ . Watch logs/dev-server.log and tell me if it fails. When done, \`cgremlin --stop-local ${sname}\`.
3. Write \`FINDINGS.md\` as a COMPLETE HANDOFF a fresh developer could execute from alone:
   - **What's happening** (the observed problem/behavior)
   - **Root cause** (the specific code and why)
   - **Affected files/paths**
   - **Risks / splash zone** (what a fix could plausibly affect)
   - **Direction / plan** to fix the ticket (concrete steps, scoped to the ticket)
4. Do NOT change code in this step. Investigation produces understanding only.

## Scope discipline
Cover ONLY what the ticket asks. If you find necessary out-of-scope work, note it under a "Tech debt (proposed)" section in FINDINGS.md and TELL ME — do not act on it. I decide whether to open a tech-debt Jira.

## After FINDINGS.md is complete
$([ "$intent" = "development" ] && cat <<AUTO
This investigation is development-bound. Do NOT stop and wait for me here — immediately
continue into planning (below). Run \`cgremlin --agent-note ${sname} "findings complete — drafting plan"\`
so I see the transition, then proceed. Do not ask my permission to start planning.
AUTO
|| cat <<MANUAL
Run \`cgremlin --agent-state ${sname} ready\` and \`cgremlin --agent-note ${sname} "FINDINGS.md ready — review it"\`,
then present a short summary and STOP. This investigation was NOT started as development-bound —
do not draft a plan unless I explicitly ask you to (e.g. "turn this into development" / "let's plan
this out"). If I do ask, follow the "Drafting the plan" section below from that point on.
MANUAL
)

## Drafting the plan (PLAN.md)
Once planning starts (per the branch above), first run \`cgremlin --plan-start ${sname}\` to record
that planning has begun, then write \`PLAN.md\` in this directory, derived from
FINDINGS.md's root cause and direction. It must be bulletproof enough that a fresh developer
could implement it without asking you anything. Include:
- **What will be modified** — exact files/functions, not vague areas.
- **How it will work** — the actual mechanism/approach, not just the goal.
- **How it will be tested** — concrete test cases, not "add tests."
- **Scope boundary** — what this plan explicitly does NOT do, to prevent scope creep later.

## Reviewing the plan (PM + Principal Engineer)
Once a PLAN.md draft exists, run \`cgremlin --agent-note ${sname} "plan drafted — under review"\`, then
dispatch TWO subagents in PARALLEL (Task tool) — do NOT do their work inline:

**PM subagent:** reads PLAN.md and FINDINGS.md, checks ONLY: does this plan solve exactly the
ticket's stated problem, and nothing more? Flag any scope creep beyond the ticket. Return a
verdict: APPROVED, or CHANGES_REQUESTED with specific, actionable reasons.

**Principal Engineer subagent:** reads PLAN.md, FINDINGS.md, and the actual code in \`./repo/\`,
checks: are all the pieces internally consistent — is every modified file/function named
correctly, does the described mechanism actually work given the real code, is the test plan
concrete and sufficient? Return a verdict: APPROVED, or CHANGES_REQUESTED with specific,
actionable reasons.

If either returns CHANGES_REQUESTED: revise PLAN.md based on their reasoning, then re-dispatch
BOTH subagents again (a partial re-review is not enough — a revision can affect either lens).
Repeat up to 3 total rounds. If both have not approved after 3 rounds, STOP: write a
"## Unresolved Review Disagreement" section at the top of PLAN.md quoting each unresolved
objection verbatim, run \`cgremlin --agent-state ${sname} needs-input\` and
\`cgremlin --agent-note ${sname} "plan review stuck — needs your input"\`, and wait for me —
do not keep iterating on your own past the cap.

Once both approve, write a "## Review Status" section at the TOP of PLAN.md (the dashboard
renders this file directly, so this section must be self-explanatory on its own):
\`\`\`
## Review Status
- PM: ✅ Approved — <one-line reasoning>
- Principal Engineer: ✅ Approved — <one-line reasoning>
\`\`\`
Then run: \`cgremlin --plan-ready ${sname}\`

$([ "$drive" = "true" ] && cat <<DRIVE
## Proceeding automatically (drive-to-completion was requested)
I asked upfront not to be stopped for approval. The moment \`cgremlin --plan-ready ${sname}\`
succeeds (both reviewers approved), immediately run \`cgremlin --develop ${sname}\` yourself —
do not wait for me to approve. Tell me you're proceeding into development, but do not ask.
DRIVE
|| cat <<PAUSE
## Waiting for my approval
After \`cgremlin --plan-ready ${sname}\`, present the plan to me in plain language — explain
what it does and how it works, not just "plan is ready." Wait for my explicit approval
("approved" / "go ahead" / similar). When I approve, run:
  cgremlin --approve-plan ${sname}
  cgremlin --develop ${sname}
Do not run either of these before I've explicitly approved.
PAUSE
)

BEGIN NOW: fetch the ticket, investigate, and write FINDINGS.md.
INV
    mkdir -p "$SDIR/.claude"
    printf '{"permissions":{"allow":["Bash(cgremlin --develop *)","Bash(cgremlin --approve-plan *)","Bash(cgremlin --plan-start *)","Bash(cgremlin --plan-ready *)","Bash(cgremlin --run-local *)","Bash(cgremlin --stop-local *)","Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"]}}\n' > "$SDIR/.claude/settings.local.json"
}
```

**Important note on heredoc nesting:** the outer heredoc uses `<<INV` (unquoted, per the original). The nested nested heredocs (`<<AUTO`, `<<MANUAL`, `<<DRIVE`, `<<PAUSE`) inside `$(...)` command substitutions are themselves bash, evaluated when the outer heredoc body is constructed — this is valid bash (command substitution inside an unquoted heredoc runs immediately), but it means any backtick or `$(...)` you want to appear LITERALLY in the final CLAUDE.md text (e.g. the `` `cgremlin --agent-note ...` `` code-span markers) MUST be escaped consistently with how the rest of this function already escapes them (backslash-escaped backticks, matching the fix applied earlier today to the sibling re-review heredoc). Double-check every backtick in the block above is preceded by `\` before saving.

- [ ] **Step 3: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output. If this fails, the most likely cause is an unescaped backtick or `$(...)` inside the nested heredocs — grep for bare (non-backslash-preceded) backticks within the function body and fix them, following today's established fix pattern.

- [ ] **Step 4: Verify the generated CLAUDE.md content directly (not just bash syntax)**

Create `/tmp/cg-test-brief.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
SESSIONS_DIR="$TMPD"
mkdir -p "$SESSIONS_DIR/inv-a"
echo '{"intent":"development","plan_review":{"drive_to_completion":false}}' > "$SESSIONS_DIR/inv-a/session.json"
mkdir -p "$SESSIONS_DIR/inv-b"
echo '{"intent":"investigate_only"}' > "$SESSIONS_DIR/inv-b/session.json"
mkdir -p "$SESSIONS_DIR/inv-c"
echo '{"intent":"development","plan_review":{"drive_to_completion":true}}' > "$SESSIONS_DIR/inv-c/session.json"

read_session_field() { jq -r ".$2 // empty" "$1/session.json"; }
source <(sed -n '/^write_investigate_brief()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)

write_investigate_brief "$SESSIONS_DIR/inv-a"
grep -q "development-bound" "$SESSIONS_DIR/inv-a/CLAUDE.md" || { echo "FAIL: inv-a should auto-continue"; exit 1; }
grep -q "NOT started as development-bound" "$SESSIONS_DIR/inv-a/CLAUDE.md" && { echo "FAIL: inv-a should not show manual-stop text"; exit 1; }
echo "PASS: inv-a (development, no drive) shows auto-continue branch"

write_investigate_brief "$SESSIONS_DIR/inv-b"
grep -q "NOT started as development-bound" "$SESSIONS_DIR/inv-b/CLAUDE.md" || { echo "FAIL: inv-b should show manual-stop text"; exit 1; }
echo "PASS: inv-b (investigate_only) shows manual-stop branch"

write_investigate_brief "$SESSIONS_DIR/inv-c"
grep -q "drive-to-completion was requested" "$SESSIONS_DIR/inv-c/CLAUDE.md" || { echo "FAIL: inv-c should show drive-to-completion branch"; exit 1; }
grep -q "Waiting for my approval" "$SESSIONS_DIR/inv-c/CLAUDE.md" && { echo "FAIL: inv-c should not show the pause branch"; exit 1; }
echo "PASS: inv-c (drive_to_completion=true) shows auto-develop branch"
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-brief.sh`
Expected: three `PASS` lines.

- [ ] **Step 5: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(investigation): draft+review PLAN.md via PM/Principal Engineer subagents before development"
```

---

### Task 6: `--plan-start`, `--plan-ready`, and `--approve-plan` CLI commands

**Files:**
- Modify: `bin/cgremlin` — add three new functions plus CLI dispatch near the existing `--approve-pr`/`--dismiss-pr` dispatch block.

**Interfaces:**
- Produces: `plan_review.phase` values `"planning"` (set by `--plan-start`, called by the agent per Task 5's prompt when it begins drafting `PLAN.md`) → `"plan_ready"` (set by `--plan-ready`) → `"approved"` (set by `--approve-plan`). Before `--plan-start` is ever called, `plan_review.phase` is simply absent — this is the "still investigating, no plan drafted yet" state, and is what `develop_start()`'s gate (Task 7) treats as "not gated" for sessions that never enter planning at all.
- Consumes: `update_session_field`/`read_session_field` (existing generic helpers).

- [ ] **Step 1: Locate the `--approve-pr` dispatch block to match its convention**

Run: `grep -n '"--approve-pr"' bin/cgremlin`
Read the surrounding ~15 lines to copy its exact refuse/force/message convention.

- [ ] **Step 2: Add `plan_start()`, `plan_ready()`, and `approve_plan()` functions**

Add near `develop_start()` (before it — these three are independent of `develop_start()`, only setting state; Task 7 only reads what they write):
```bash
# Called by the investigation agent the moment it begins drafting PLAN.md.
plan_start() {
    local sess="$1"
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    update_session_field "$SDIR" "plan_review.phase" "planning"
    echo "$sess: plan_review.phase = planning"
}

# Called by the investigation agent once both PM and Principal Engineer approve PLAN.md.
plan_ready() {
    local sess="$1"
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    update_session_field "$SDIR" "plan_review.phase" "plan_ready"
    echo "$sess: plan_review.phase = plan_ready"
}

# Called on the user's explicit approval (chat instruction or dashboard button).
approve_plan() {
    local sess="$1"
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    local phase; phase=$(read_session_field "$SDIR" "plan_review.phase")
    if [ "$phase" != "plan_ready" ]; then
        echo "ERROR: $sess plan_review.phase is '$phase', expected 'plan_ready' — the plan has not been reviewed yet" >&2
        return 1
    fi
    update_session_field "$SDIR" "plan_review.phase" "approved"
    echo "$sess: plan_review.phase = approved"
}
```

- [ ] **Step 3: Add CLI dispatch**

Near the existing `--approve-pr` dispatch, add:
```bash
if [ "$1" = "--plan-start" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --plan-start <session>" >&2; exit 1; }
    plan_start "$2"; exit $?
fi

if [ "$1" = "--plan-ready" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --plan-ready <session>" >&2; exit 1; }
    plan_ready "$2"; exit $?
fi

if [ "$1" = "--approve-plan" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --approve-plan <session>" >&2; exit 1; }
    approve_plan "$2"; exit $?
fi
```

- [ ] **Step 4: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.

- [ ] **Step 5: Write and run a throwaway test**

Create `/tmp/cg-test-approve.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
SESSIONS_DIR="$TMPD"
mkdir -p "$SESSIONS_DIR/inv-x"
echo '{"plan_review":{"phase":"planning"}}' > "$SESSIONS_DIR/inv-x/session.json"

read_session_field() { jq -r ".$2 // empty" "$1/session.json"; }
update_session_field() {
    local dir="$1" field="$2" value="$3" tmp
    tmp=$(mktemp)
    jq ".$field = \"$value\"" "$dir/session.json" > "$tmp" && mv "$tmp" "$dir/session.json"
}
source <(sed -n '/^plan_start()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)
source <(sed -n '/^plan_ready()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)
source <(sed -n '/^approve_plan()/,/^}/p' /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)

# approve_plan before plan_ready must fail
if approve_plan "inv-x" 2>/tmp/err.txt; then
    echo "FAIL: approve_plan should have refused before plan_ready"; exit 1
fi
grep -q "expected 'plan_ready'" /tmp/err.txt || { echo "FAIL: wrong error message"; exit 1; }
echo "PASS: approve_plan refuses before plan_ready"

plan_start "inv-x"
phase0=$(jq -r '.plan_review.phase' "$SESSIONS_DIR/inv-x/session.json")
[ "$phase0" = "planning" ] || { echo "FAIL: phase after plan_start = $phase0"; exit 1; }
echo "PASS: plan_start sets phase to planning"

plan_ready "inv-x"
phase=$(jq -r '.plan_review.phase' "$SESSIONS_DIR/inv-x/session.json")
[ "$phase" = "plan_ready" ] || { echo "FAIL: phase after plan_ready = $phase"; exit 1; }
echo "PASS: plan_ready sets phase"

approve_plan "inv-x"
phase2=$(jq -r '.plan_review.phase' "$SESSIONS_DIR/inv-x/session.json")
[ "$phase2" = "approved" ] || { echo "FAIL: phase after approve_plan = $phase2"; exit 1; }
echo "PASS: approve_plan sets phase to approved"
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-approve.sh`
Expected: four `PASS` lines.

- [ ] **Step 6: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(plan-review): add --plan-start, --plan-ready, and --approve-plan CLI commands"
```

---

### Task 7: `develop_start()` semi-hard gate

**Files:**
- Modify: `bin/cgremlin:14234-14273` (`develop_start()`)

**Interfaces:**
- Consumes: `plan_review.phase`, `plan_review.drive_to_completion`, `plan_review.pm_verdict`/`principal_verdict` (only used if you choose to record structured verdicts — see note in Step 2) from `session.json`.

- [ ] **Step 1: Re-locate the function**

Run: `grep -n "^develop_start()" bin/cgremlin`

- [ ] **Step 2: Add the gate check at the top of the function, after the existing directory check**

Current opening:
```bash
develop_start() {
    local sess="$1"                       # investigation session to promote IN PLACE
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR/repo" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    local jira; jira=$(read_session_field "$SDIR" "jira.ticket")
```
Change to:
```bash
develop_start() {
    local sess="$1" force="$2"            # investigation session to promote IN PLACE
    local SDIR="$SESSIONS_DIR/$sess"
    [ -d "$SDIR/repo" ] || { echo "ERROR: session $sess not found" >&2; return 1; }
    local plan_phase; plan_phase=$(read_session_field "$SDIR" "plan_review.phase")
    local drive; drive=$(read_session_field "$SDIR" "plan_review.drive_to_completion")
    if [ -n "$plan_phase" ] && [ "$plan_phase" != "approved" ] && [ "$force" != "--force" ]; then
        if [ "$drive" != "true" ]; then
            echo "ERROR: $sess plan_review.phase is '$plan_phase', not 'approved' — run 'cgremlin --approve-plan $sess' first, or pass --force to override." >&2
            return 1
        fi
        # drive_to_completion: allow promotion once the plan is at least plan_ready
        # (both reviewers already approved it per Task 5's --plan-ready call).
        if [ "$plan_phase" != "plan_ready" ]; then
            echo "ERROR: $sess plan_review.phase is '$plan_phase' — plan has not been reviewed yet even though drive_to_completion is set." >&2
            return 1
        fi
    fi
    local jira; jira=$(read_session_field "$SDIR" "jira.ticket")
```
Note: a session with no `plan_review` field at all (old sessions, or sessions that never went through planning — e.g. an investigation promoted directly without ever drafting a plan) has `plan_phase` empty, so the `[ -n "$plan_phase" ]` guard skips the whole check — preserving today's unblocked promotion behavior exactly, per the Global Constraints section.

- [ ] **Step 3: Find and update every existing caller of `develop_start` to pass through a `--force` argument where a human explicitly overrides**

Run: `grep -n 'develop_start "' bin/cgremlin`
For the `--develop` CLI dispatch specifically (near where `investigate_start` is dispatched), extend it to accept an optional `--force`:
```bash
if [ "$1" = "--develop" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --develop <session> [--force]" >&2; exit 1; }
    develop_start "$2" "$3"; exit $?
fi
```
(If the existing dispatch already looks different from this guess, adapt minimally — only add the `[--force]` passthrough, do not restructure anything else in that dispatch block.)

- [ ] **Step 4: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.

- [ ] **Step 5: Write and run a throwaway test**

Create `/tmp/cg-test-gate.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
SESSIONS_DIR="$TMPD"

mk() { # mk <name> <plan_review_json>
    mkdir -p "$SESSIONS_DIR/$1/repo"
    echo "{\"plan_review\": $2}" > "$SESSIONS_DIR/$1/session.json"
}
mk "inv-blocked" '{"phase":"planning"}'
mk "inv-approved" '{"phase":"approved"}'
mk "inv-drive-ready" '{"phase":"plan_ready","drive_to_completion":true}'
mk "inv-drive-not-ready" '{"phase":"planning","drive_to_completion":true}'
mk "inv-old" 'null'   # simulates a session.json with no plan_review key at all

read_session_field() { jq -r ".$2 // empty" "$1/session.json" 2>/dev/null; }

gate_check() {
    local sess="$1" force="$2"
    local SDIR="$SESSIONS_DIR/$sess"
    local plan_phase; plan_phase=$(read_session_field "$SDIR" "plan_review.phase")
    local drive; drive=$(read_session_field "$SDIR" "plan_review.drive_to_completion")
    if [ -n "$plan_phase" ] && [ "$plan_phase" != "approved" ] && [ "$force" != "--force" ]; then
        if [ "$drive" != "true" ]; then
            echo "BLOCKED"; return 1
        fi
        if [ "$plan_phase" != "plan_ready" ]; then
            echo "BLOCKED"; return 1
        fi
    fi
    echo "ALLOWED"; return 0
}

[ "$(gate_check inv-blocked)" = "BLOCKED" ] || { echo "FAIL: inv-blocked should be BLOCKED"; exit 1; }
echo "PASS: unapproved plan blocks promotion"

[ "$(gate_check inv-approved)" = "ALLOWED" ] || { echo "FAIL: inv-approved should be ALLOWED"; exit 1; }
echo "PASS: approved plan allows promotion"

[ "$(gate_check inv-drive-ready)" = "ALLOWED" ] || { echo "FAIL: inv-drive-ready should be ALLOWED"; exit 1; }
echo "PASS: drive_to_completion + plan_ready allows promotion without explicit approve-plan"

[ "$(gate_check inv-drive-not-ready)" = "BLOCKED" ] || { echo "FAIL: inv-drive-not-ready should still be BLOCKED"; exit 1; }
echo "PASS: drive_to_completion does not bypass the reviewers themselves"

[ "$(gate_check inv-blocked --force)" = "ALLOWED" ] || { echo "FAIL: --force should override"; exit 1; }
echo "PASS: --force overrides the gate"

[ "$(gate_check inv-old)" = "ALLOWED" ] || { echo "FAIL: inv-old (no plan_review) should be ALLOWED"; exit 1; }
echo "PASS: sessions with no plan_review field are never gated"
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-gate.sh`
Expected: six `PASS` lines.

- [ ] **Step 6: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(develop_start): semi-hard gate on plan_review.phase, with --force override"
```

---

### Task 8: Bash TUI badge for plan review phase

**Files:**
- Modify: `bin/cgremlin` around `review_list_grouped()`'s work-session badge rendering (currently ~line 838-865; re-locate).

**Interfaces:**
- Consumes: `read_session_field SDIR "plan_review.phase"` (existing generic helper).

- [ ] **Step 1: Re-locate the badge rendering**

Run: `grep -n 'case "\$wstage" in' bin/cgremlin`

- [ ] **Step 2: Add a plan_review phase badge alongside the existing stage_status badge**

Find:
```bash
local wbadge=""
case "$wstage" in pr_opened) wbadge=" [PR open]";; superseded) wbadge=" [in review]";; merged) wbadge=" [✅ merged]";; abandoned) wbadge=" [✗ abandoned]";; esac
```
Change to:
```bash
local wbadge=""
case "$wstage" in pr_opened) wbadge=" [PR open]";; superseded) wbadge=" [in review]";; merged) wbadge=" [✅ merged]";; abandoned) wbadge=" [✗ abandoned]";; esac
local wplan_phase; wplan_phase=$(read_session_field "${wd%/}" "plan_review.phase")
case "$wplan_phase" in
    planning) wbadge="$wbadge [📝 planning]" ;;
    plan_ready) wbadge="$wbadge [📋 plan ready for approval]" ;;
esac
```
(`approved` intentionally gets no badge here — once approved, the session is either already promoted to development, or about to be, and the existing development-mode badges take over. `findings` also gets no badge — that's the ordinary in-progress investigation state, already conveyed by the investigation emoji.)

- [ ] **Step 3: Verify bash syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.

- [ ] **Step 4: Write and run a throwaway test**

Create `/tmp/cg-test-tui-badge.sh`:
```bash
#!/bin/bash
set -e
TMPD=$(mktemp -d)
mkdir -p "$TMPD/inv-a"
echo '{"plan_review":{"phase":"planning"}}' > "$TMPD/inv-a/session.json"
mkdir -p "$TMPD/inv-b"
echo '{"plan_review":{"phase":"plan_ready"}}' > "$TMPD/inv-b/session.json"
mkdir -p "$TMPD/inv-c"
echo '{"plan_review":{"phase":"approved"}}' > "$TMPD/inv-c/session.json"

read_session_field() { jq -r ".$2 // empty" "$1/session.json"; }

badge_for() {
    local wd="$1/"
    local wbadge=""
    local wplan_phase; wplan_phase=$(read_session_field "${wd%/}" "plan_review.phase")
    case "$wplan_phase" in
        planning) wbadge="$wbadge [📝 planning]" ;;
        plan_ready) wbadge="$wbadge [📋 plan ready for approval]" ;;
    esac
    echo "$wbadge"
}

[ "$(badge_for "$TMPD/inv-a")" = " [📝 planning]" ] || { echo "FAIL: inv-a badge"; exit 1; }
echo "PASS: planning badge"
[ "$(badge_for "$TMPD/inv-b")" = " [📋 plan ready for approval]" ] || { echo "FAIL: inv-b badge"; exit 1; }
echo "PASS: plan_ready badge"
[ "$(badge_for "$TMPD/inv-c")" = "" ] || { echo "FAIL: inv-c should have no plan badge"; exit 1; }
echo "PASS: approved shows no plan badge"
rm -rf "$TMPD"
```
Run: `bash /tmp/cg-test-tui-badge.sh`
Expected: three `PASS` lines.

- [ ] **Step 5: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(tui): show plan-review phase badge in mission control"
```

---

### Task 9: Dashboard backend — PLAN tab content, `has_plan` flag, `/api/approve-plan`

**Files:**
- Modify: `bin/cgremlin` (PYSERVER heredoc) — `send_file_content()` (~8378-8409), `send_sessions_list()` (~7796-7980), `parse_session_json()` (~8106-8200), `do_POST` route table (~6039-6040), new handler function near `archive_session()` (~6089-6100).

**Interfaces:**
- Produces: `GET /api/content?session=<n>&type=plan` returns `PLAN.md` content (mirrors `type=findings`).
- Produces: session list entries gain `has_plan` (bool) and `plan_review` (object, passthrough of the session.json field).
- Produces: `POST /api/approve-plan` (body: `{"session": "<name>"}`) → shells to `cgremlin --approve-plan <name>`.

- [ ] **Step 1: Re-locate all four insertion points**

Run: `grep -n "def send_file_content\|def send_sessions_list\|def parse_session_json\|def archive_session\|'/api/archive'" bin/cgremlin`

- [ ] **Step 2: Add the `plan` file type to `send_file_content()`**

Find:
```python
    elif file_type == 'findings':
        filename = 'FINDINGS.md'
    elif file_type == 'devlog':
        filename = 'DEVLOG.md'
```
Add a new branch:
```python
    elif file_type == 'findings':
        filename = 'FINDINGS.md'
    elif file_type == 'plan':
        filename = 'PLAN.md'
    elif file_type == 'devlog':
        filename = 'DEVLOG.md'
```

- [ ] **Step 3: Expose `plan_review` in `parse_session_json()` and `has_plan` in `send_sessions_list()`**

In `parse_session_json()`, find where `stage_status`/`pipeline_id` are extracted into the `info` dict (look for a line like `info['stage_status'] = data.get('stage_status', ...)`), and add immediately after it:
```python
    info['plan_review'] = data.get('plan_review') or {}
```
In `send_sessions_list()`, find where `has_findings`/`has_devlog` booleans are computed (look for `info['has_findings'] = (entry / 'FINDINGS.md').exists()` or equivalent), and add:
```python
    info['has_plan'] = (entry / 'PLAN.md').exists()
```

- [ ] **Step 4: Add the `/api/approve-plan` route and handler**

In `do_POST`, find:
```python
        if parsed.path == '/api/archive':
            self.archive_session(session_path)
```
Add immediately after:
```python
        if parsed.path == '/api/approve-plan':
            self.approve_plan_session(session_path)
```
Add a new handler near `archive_session()`:
```python
    def approve_plan_session(self, session_path):
        import subprocess
        session_name = session_path.name
        try:
            result = subprocess.run(
                ['cgremlin', '--approve-plan', session_name],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                self.send_response(400)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': result.stderr.strip() or result.stdout.strip()}).encode())
                return
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'approved'}).encode())
        except Exception as e:
            self.send_error(500, str(e))
```

- [ ] **Step 5: Verify bash syntax and PYSERVER heredoc syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.
Run:
```bash
cd /Users/guilherme.azoubel/context-gremlin
python3 - <<'EOF'
import re, ast
with open('bin/cgremlin') as f:
    content = f.read()
m = re.search(r"<< 'PYSERVER'\n(.*?)\nPYSERVER\n", content, re.S)
try:
    ast.parse(m.group(1))
    print("PYSERVER_AST_OK")
except SyntaxError as e:
    print("PYSERVER_AST_FAIL:", e)
EOF
```
Expected: `PYSERVER_AST_OK`.

- [ ] **Step 6: Regenerate the dashboard server file and test the new endpoints against a real (throwaway) session**

```bash
pkill -9 -f dashboard_server.py 2>/dev/null; sleep 1
cd /Users/guilherme.azoubel/context-gremlin
python3 - <<'EOF'
import re
with open('bin/cgremlin', 'rb') as f:
    content = f.read()
m = re.search(rb"<< 'PYSERVER'\n(.*?)\nPYSERVER\n", content, re.S)
with open('/tmp/test_dashboard_server.py', 'wb') as out:
    out.write(m.group(1) + b"\n")
EOF
```
Create a throwaway session under a TEST sessions dir (do not touch the real `~/.cgremlin/sessions`):
```bash
mkdir -p /tmp/cg-test-sessions/inv-plan-test
echo '{"mode":"investigation","plan_review":{"phase":"plan_ready"}}' > /tmp/cg-test-sessions/inv-plan-test/session.json
cat > /tmp/cg-test-sessions/inv-plan-test/PLAN.md <<'EOF'
## Review Status
- PM: Approved — test
- Principal Engineer: Approved — test

# Test Plan
Nothing real here, just a fixture.
EOF
SESSIONS_DIR=/tmp/cg-test-sessions python3 /tmp/test_dashboard_server.py &
sleep 2
curl -s "http://127.0.0.1:8765/api/content?session=inv-plan-test&type=plan"
echo
curl -s "http://127.0.0.1:8765/api/sessions" | python3 -c "import json,sys; d=json.load(sys.stdin); print([s['has_plan'] for s in d if s['name']=='inv-plan-test'])"
pkill -f test_dashboard_server.py
```
Expected: the `curl .../content` call prints the PLAN.md content verbatim (including the "Review Status" heading); the `has_plan` check prints `[True]`.

- [ ] **Step 7: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(dashboard): serve PLAN.md, expose has_plan/plan_review, add /api/approve-plan"
```

---

### Task 10: Dashboard frontend — PLAN tab, badges, Approve button

**Files:**
- Modify: `bin/cgremlin` (PYSERVER heredoc) — `renderToolbar()`'s tabs array (~10065-10080), action-button HTML (~9965 area), `stageBadges()` (~9674-9697), new `approvePlan()` JS function (mirroring `archiveSession()` ~10337-10350), the `API` constants object.

**Interfaces:**
- Consumes: `session.has_plan`, `session.plan_review.phase` (Task 9).
- Produces: a `PLAN` tab visible whenever `has_plan` is true; an "Approve for Development" button visible whenever `plan_review.phase === 'plan_ready'`.

- [ ] **Step 1: Re-locate all insertion points**

Run: `grep -n "const API = {\|function stageBadges\|function renderToolbar\|function archiveSession\|btn-action warn" bin/cgremlin`

- [ ] **Step 2: Add the `APPROVE_PLAN` API constant**

Find the `API` object definition (contains entries like `ARCHIVE: '/api/archive'`) and add:
```javascript
    APPROVE_PLAN: '/api/approve-plan',
```

- [ ] **Step 3: Add the PLAN tab**

Find:
```javascript
const tabs = [
    { id: 'review', label: 'Review', available: session.has_review },
    { id: 'findings', label: 'Findings', available: session.has_findings },
    { id: 'devlog', label: 'Devlog', available: session.has_devlog },
    { id: 'terminal', label: 'Terminal', available: session.has_terminal, live: true }
];
```
Change to:
```javascript
const tabs = [
    { id: 'review', label: 'Review', available: session.has_review },
    { id: 'findings', label: 'Findings', available: session.has_findings },
    { id: 'plan', label: 'Plan', available: session.has_plan },
    { id: 'devlog', label: 'Devlog', available: session.has_devlog },
    { id: 'terminal', label: 'Terminal', available: session.has_terminal, live: true }
];
```
(No other change needed here — `switchTab('plan')`/`loadContent()` already work generically for any tab id, per Task 9's `type=plan` backend support.)

- [ ] **Step 4: Add the "Approve for Development" button**

Find the archive button line:
```javascript
actions += '<button class="btn-action warn" onclick="archiveSession()">📦 Archive</button>';
```
Add immediately before it:
```javascript
if (session.plan_review && session.plan_review.phase === 'plan_ready') {
    actions += '<button class="btn-action primary" onclick="approvePlanForDevelopment()">✅ Approve for Development</button>';
}
```

- [ ] **Step 5: Add the `approvePlanForDevelopment()` JS function**

Add near `archiveSession()`:
```javascript
async function approvePlanForDevelopment() {
    if (!state.currentSession) return;
    const session = getCurrentSession();
    if (!session || !session.plan_review || session.plan_review.phase !== 'plan_ready') return;
    if (!confirm('Approve this plan and start development for "' + (session.display_title || state.currentSession) + '"?')) return;
    try {
        await apiPost(API.APPROVE_PLAN);
        showToast('Plan approved — development starting');
        await loadSessions();
        renderSessionHeader();
        renderActionBar();
    } catch (e) { showToast('Approve failed: ' + e.message, 'error'); }
}
```
(This mirrors `archiveSession()`'s exact structure — `apiPost` already sends `{session: state.currentSession}` as the body per the existing convention used by `archiveSession()`/other action functions; verify this by reading `apiPost`'s definition before assuming — if it takes an explicit session argument instead, adapt the call to match.)

- [ ] **Step 6: Add a plan-review badge segment to `stageBadges()`**

Find the `mode === 'investigation'` branch:
```javascript
    if (mode === 'investigation') {
        out.push({ emoji: '🔍', label: 'Investigation' + (stage ? ' (' + stage + ')' : ''), name: s.name, cls: 'inv' });
    }
```
Change to:
```javascript
    if (mode === 'investigation') {
        out.push({ emoji: '🔍', label: 'Investigation' + (stage ? ' (' + stage + ')' : ''), name: s.name, cls: 'inv' });
        const planPhase = s.plan_review && s.plan_review.phase;
        if (planPhase === 'planning') {
            out.push({ emoji: '📝', label: 'Plan (drafting)', name: s.name, cls: 'planning' });
        } else if (planPhase === 'plan_ready') {
            out.push({ emoji: '📋', label: 'Plan (ready for approval)', name: s.name, cls: 'plan-ready' });
        }
    }
```

- [ ] **Step 7: Add CSS for the new badge classes**

Find the existing `.stage-badge.stage-done` rule (added earlier today) and add alongside it:
```css
.stage-badge.planning { background: var(--amber-bg); color: var(--amber); }
.stage-badge.plan-ready { background: var(--blue-bg); color: var(--blue); }
```
(Reuse whatever CSS custom properties `--amber-bg`/`--amber`/`--blue-bg`/`--blue` already exist in this stylesheet — grep for `--amber-bg` first to confirm the exact variable names before writing this rule.)

- [ ] **Step 8: Verify bash syntax and PYSERVER heredoc syntax**

Run: `bash -n bin/cgremlin`
Expected: no output.
Run the same `ast.parse()` snippet from Task 9 Step 5.
Expected: `PYSERVER_AST_OK`.

- [ ] **Step 9: Live verification in a real browser against the throwaway test session**

Regenerate and restart the dashboard (same pattern as Task 9 Step 6, but keep it running this time):
```bash
pkill -9 -f dashboard_server.py 2>/dev/null; sleep 1
cd /Users/guilherme.azoubel/context-gremlin
python3 - <<'EOF'
import re
with open('bin/cgremlin', 'rb') as f:
    content = f.read()
m = re.search(rb"<< 'PYSERVER'\n(.*?)\nPYSERVER\n", content, re.S)
with open('/tmp/test_dashboard_server.py', 'wb') as out:
    out.write(m.group(1) + b"\n")
EOF
SESSIONS_DIR=/tmp/cg-test-sessions nohup python3 /tmp/test_dashboard_server.py > /tmp/test_dashboard.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:8765/api/sessions | python3 -m json.tool | head -20
```
Then, using the chrome-devtools MCP tool available in this Claude Code session: navigate to `http://127.0.0.1:8765`, take a snapshot, and confirm:
- a `PLAN` tab is visible for `inv-plan-test`,
- clicking it renders the `PLAN.md` fixture content (including the "Review Status" section) as markdown,
- an "✅ Approve for Development" button is visible (since the fixture's `plan_review.phase` is `plan_ready`),
- clicking it (after confirming the browser `confirm()` dialog) results in a success toast and the button disappearing on reload (since `--approve-plan` will flip `phase` to `approved` — verify via `cat /tmp/cg-test-sessions/inv-plan-test/session.json` after clicking).

When done, clean up:
```bash
pkill -f test_dashboard_server.py
rm -rf /tmp/cg-test-sessions /tmp/test_dashboard_server.py /tmp/test_dashboard.log
```

- [ ] **Step 10: Commit**

```bash
cd /Users/guilherme.azoubel/context-gremlin
git add bin/cgremlin
git commit -m "feat(dashboard): PLAN tab, plan-review badges, Approve for Development button"
```

---

### Task 11: Full live end-to-end verification (real investigation, real dashboard, no stubs)

This task has no code changes — it exists to earn the ">95% confidence" bar the user asked for, by running the actual feature against a real (or realistic) scenario rather than only isolated stub harnesses. Do not report this plan as complete until every check below passes.

**Files:** none modified — verification only.

- [ ] **Step 1: Verify the full file one more time**

```bash
bash -n /Users/guilherme.azoubel/context-gremlin/bin/cgremlin && echo BASH_OK
cd /Users/guilherme.azoubel/context-gremlin
python3 - <<'EOF'
import re, ast
with open('bin/cgremlin') as f:
    content = f.read()
m = re.search(r"<< 'PYSERVER'\n(.*?)\nPYSERVER\n", content, re.S)
ast.parse(m.group(1))
print("PYSERVER_AST_OK")
EOF
```
Expected: `BASH_OK` then `PYSERVER_AST_OK`.

- [ ] **Step 2: Kill and restart the REAL watch-daemon and dashboard so they run today's code**

```bash
/Users/guilherme.azoubel/context-gremlin/bin/cgremlin --stop-watch-daemon
pkill -9 -f dashboard_server.py 2>/dev/null
sleep 1
nohup /Users/guilherme.azoubel/context-gremlin/bin/cgremlin --watch-daemon > ~/.cgremlin/sessions/.watch-daemon-stdout.log 2>&1 &
disown
```
Do this against the REAL `~/.cgremlin/sessions`, since this is the final live check, not an isolated harness.

- [ ] **Step 3: Create a real investigation session with `--for-development`, using a real (or realistic test) repo/ticket**

Pick a small, low-risk, real target — e.g. a real minor bug or a deliberately trivial synthetic ticket in a real watched repo (confirm with the user which repo/ticket to use if none is obvious; do not guess a ticket that doesn't exist). Run:
```bash
cgremlin --investigate <REPO_URL> <TICKET-OR-DESCRIPTION> --for-development
```
Confirm a session directory appears under `~/.cgremlin/sessions/inv-*` with `session.json` containing `"intent": "development"`.

- [ ] **Step 4: Observe the real agent through the full lifecycle**

Watch (via the mission-control WORK tab, or by tailing the session's agent output) for, in order:
1. `FINDINGS.md` gets written.
2. The agent auto-continues into planning (no stop) — confirm via `cgremlin --agent-note` history or the session's activity log showing "findings complete — drafting plan" (or similar, per Task 5's exact text).
3. `PLAN.md` appears.
4. Two Task-tool subagents get dispatched (PM + Principal Engineer) — confirm from the agent's own transcript/tool-use log that both were invoked.
5. `plan_review.phase` in `session.json` progresses `planning` → `plan_ready` (check with `jq .plan_review.phase ~/.cgremlin/sessions/inv-*/session.json`).
6. `PLAN.md` contains a "## Review Status" section with both verdicts.
7. The agent pauses and does NOT proceed into development without your approval (confirm no `dev-*`-mode flip happened and no code was written in `repo/`).

If any of 1–7 doesn't happen as described, STOP — this is a real bug in the implementation, not a plan/test-harness issue. Go back to the relevant task, fix it, re-verify that task's isolated tests, and re-run this task from Step 3.

- [ ] **Step 5: Verify the real dashboard renders it correctly**

Open `http://127.0.0.1:8765` in a real browser (use the chrome-devtools MCP tool). Find the session from Step 3. Confirm:
- A `PLAN` tab is present and shows the real `PLAN.md` content with the Review Status section rendered.
- A `plan ready for approval` badge is visible on the session (sidebar and/or pipeline view).
- An "Approve for Development" button is visible.

- [ ] **Step 6: Approve via the dashboard button (not the CLI) and confirm real promotion**

Click "Approve for Development" in the browser. Confirm:
- `session.json`'s `plan_review.phase` becomes `approved` (check via `jq`).
- If you also tell the agent (in its actual pane) "approved, go ahead" per its own instructions, confirm it runs `cgremlin --develop <session>` and this SUCCEEDS (no gate refusal) and the session's `mode` flips to `development` in `session.json`.

- [ ] **Step 7: Verify the gate actually blocks when it should, on a second real session**

Create one more real investigation session (repeat Step 3, a different trivial target), let it reach `plan_ready`, but do NOT approve it. Attempt:
```bash
cgremlin --develop <that-session-name>
```
Expected: refuses with the exact error message from Task 7 ("plan_review.phase is 'plan_ready', not 'approved'..."), exit code 1, and `session.json`'s `mode` remains `investigation` (not flipped to `development`). This is the single most important check in this task — it proves the gate is real, not just theoretically wired.

- [ ] **Step 8: Clean up test sessions**

Once both real sessions from Steps 3 and 7 have served their verification purpose, decide with the user whether to keep, archive, or delete them (do not silently delete real session data — this is a "confirm before destructive action" case per project conventions).

- [ ] **Step 9: Final report**

Summarize, for the user: what was tested, what passed, and explicit confidence level with justification (e.g. "12/12 isolated assertions across Tasks 1–10 passed, plus a full live run through investigate → auto-plan → PM/PE review → dashboard approve → gated promotion, with the negative case (unapproved promotion attempt) confirmed refused — I'm >95% confident this works as designed"). If anything was inconclusive or skipped (e.g. a live MCP/Jira dependency was unavailable), say so explicitly rather than rounding up confidence.

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** Task 1–2 cover spec Section 2 (config); Task 3–4 cover Section "Trigger logic"; Task 5 covers Sections "Review mechanism" and the plan-drafting half of Section 1; Task 6–7 cover the "Promotion gate" section; Task 8 covers the bash-TUI half of Section "Dashboard UI"; Tasks 9–10 cover the dashboard half. Task 11 covers the user's explicit ">95% confidence, real live testing" requirement, which is not itself a spec section but was an explicit instruction alongside spec approval.
- **No placeholders:** every step above has real, complete code or an exact command — flagged during self-review and fixed inline (e.g. Task 10 Step 5 explicitly tells the implementer to verify `apiPost`'s real signature rather than assuming, since that wasn't independently confirmed during planning research).
- **Type/name consistency:** `plan_review.phase` values (`planning`, `plan_ready`, `approved`) are used identically across Tasks 5, 6, 7, 8, 10 — double-checked for drift during this write-up. Self-review caught a real gap on first pass: Tasks 8/10 checked for a `"planning"` phase value that nothing actually produced (only `plan_ready`/`approved` were ever set). Fixed by adding a `plan_start()`/`--plan-start` command (Task 6) that the agent calls at the start of drafting `PLAN.md` (Task 5), before either PM/Principal Engineer subagent is dispatched.
