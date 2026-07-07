# Autonomous Investigate / Develop Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start investigations conversationally from the Mission Control orchestrator, run them as autonomous agents in a shared `🔨 WORK` tab, and promote a reviewed investigation into a fresh develop agent that plans → (gate) → TDD-implements → opens a tested draft PR gated to "ready" by the user.

**Architecture:** All code in the single bash script `bin/cgremlin` (plus its embedded Python dashboard server). Reuses the review-agent machinery: a per-session `CLAUDE.md` auto-loaded by an agent whose `cwd` is the session dir; Zellij tabs/panes for the UI. New: a `create_work_agent_pane` that tiles agent panes into one `🔨 WORK` tab; `--investigate` / `--develop` commands with autonomous mode `CLAUDE.md` templates; helpers `--pr-ready` and `--resolve-comment`; orchestrator allowlist wiring; a web-UI launch fix.

**Tech Stack:** bash, `gh` CLI (incl. `gh api graphql`), `jq`, Zellij (tabs/panes), `claude` interactive, Atlassian MCP (agent-side, for Jira), Playwright (agent-side, for preview tests).

## Global Constraints

- All code in `bin/cgremlin`; after every change run `bash -n bin/cgremlin` (must pass). If the embedded Python server (`PYSERVER` heredoc) is touched, also extract it and run `python3 -c "import ast; ast.parse(open(f).read())"`.
- No unit-test framework exists. Verification = the functional/`bash -n`/live-`zellij` checks written in each task. Run them and confirm the stated expected output.
- `GITHUB_ME` (config) = `guilleazoubel`; `WATCH_REPOS`/`WATCH_AUTHORS` already configured. Do not change config semantics.
- The interactive agent ALWAYS runs with `cwd` = the session dir and its instructions in `$SDIR/CLAUDE.md` (auto-loaded). Do NOT pass `--add-dir "$SDIR/repo"` (it pulls in `repo/CLAUDE.md` and derails the agent — established this session). `repo/` is reachable as a subdir of `cwd`.
- Jira is the source of truth; the agent covers ONLY what the ticket asks. Out-of-scope work → propose a tech-debt Jira via Atlassian MCP `createJiraIssue`, created ONLY with the user's explicit OK.
- Autonomy: proceed without prompting for routine work; pause only at defined gates (plan review; unsure bot comments; tech-debt Jira; the develop "ready" gate). Never mark a PR ready or create a Jira without explicit user approval.
- The WORK tab is named exactly `🔨 WORK`. Investigate panes are titled `🔍 <JIRA>`, develop panes `🔨 <JIRA>` (where `<JIRA>` is the ticket key, or the session basename if no key).
- Do not commit/push git changes unless asked; these "commit" steps are cgremlin working-tree commits on branch `mission-control-pr-orchestrator` (session norm).
- Reuse existing helpers verbatim: `read_session_field`, `update_session_field`, `_pr_repo`, `reply_comment`, `write_review_guard`, `create_session_json`, `generate_claude_md`, `create_investigation_session_noninteractive` (~line 12984), `create_development_session_noninteractive` (~line 13017), `launch_orchestrator` (~line 13413). The interactive-agent tab pattern lives in `create_review_agent_pane` (~line 579) — model the new pane launcher on it.

---

### Task 1: `create_work_agent_pane` — launch an agent pane into the `🔨 WORK` tab

**Files:**
- Modify: `bin/cgremlin` — add `work_agent_tab_name()` and `create_work_agent_pane()` near `create_review_agent_pane` (~line 579).

**Interfaces:**
- Consumes: `read_session_field`, `$MODEL`, `$ZELLIJ`.
- Produces:
  - `work_agent_tab_name SESSION_DIR` → prints the pane title: `🔍 <key>` if mode=investigation, `🔨 <key>` if mode=development, where `<key>` = the session's `jira.ticket` or, if absent, the session basename.
  - `create_work_agent_pane SESSION_DIR` → writes a wrapper that runs `claude` with `cwd=SESSION_DIR` (auto-loads `SESSION_DIR/CLAUDE.md`), then ensures the `🔨 WORK` tab exists and adds a titled tiled pane running the wrapper. No-op if not inside Zellij. Writes the pane's pid to `SESSION_DIR/agent_pid`.

- [ ] **Step 1: Write the failing check (tab-name helper)**

Create a throwaway check script `/tmp/t1.sh`:

```bash
#!/bin/bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"
mkdir -p "$root/inv-x/repo"
printf '{"mode":"investigation","jira":{"ticket":"HB-1051"}}' > "$root/inv-x/session.json"
echo "INV: [$(work_agent_tab_name "$root/inv-x")]"     # expect 🔍 HB-1051
mkdir -p "$root/dev-y/repo"
printf '{"mode":"development","jira":{"ticket":"HB-1051"}}' > "$root/dev-y/session.json"
echo "DEV: [$(work_agent_tab_name "$root/dev-y")]"     # expect 🔨 HB-1051
mkdir -p "$root/inv-z/repo"
printf '{"mode":"investigation"}' > "$root/inv-z/session.json"
echo "NOKEY: [$(work_agent_tab_name "$root/inv-z")]"   # expect 🔍 inv-z
rm -rf "$root"
```

Run: `bash /tmp/t1.sh`
Expected before implementing: `work_agent_tab_name: command not found` (or empty output).

- [ ] **Step 2: Implement `work_agent_tab_name`**

Add before `create_review_agent_pane` (~line 579):

```bash
# Title for a WORK-tab agent pane: 🔍 <key> (investigate) or 🔨 <key> (develop).
# <key> = session's jira.ticket, else the session dir basename.
# Usage: work_agent_tab_name SESSION_DIR
work_agent_tab_name() {
    local SDIR="$1" mode key emoji
    mode=$(read_session_field "$SDIR" "mode")
    key=$(read_session_field "$SDIR" "jira.ticket"); [ -z "$key" ] && key=$(basename "$SDIR")
    case "$mode" in development) emoji="🔨";; *) emoji="🔍";; esac
    printf '%s %s' "$emoji" "$key"
}
```

- [ ] **Step 3: Run the check to verify the helper passes**

Run: `bash /tmp/t1.sh`
Expected: `INV: [🔍 HB-1051]`, `DEV: [🔨 HB-1051]`, `NOKEY: [🔍 inv-z]`.

- [ ] **Step 4: Implement `create_work_agent_pane`**

Add immediately after `work_agent_tab_name`:

```bash
# Launch the session's agent as a tiled pane in the single "🔨 WORK" tab, so all
# active investigate/dev work is visible at once. Agent runs with cwd=SESSION_DIR
# (auto-loads SESSION_DIR/CLAUDE.md — the mode's autonomous instructions). No
# --add-dir (repo/ is a subdir of cwd; adding it would load repo/CLAUDE.md).
# Usage: create_work_agent_pane SESSION_DIR
create_work_agent_pane() {
    local SDIR="$1"
    [ -d "$SDIR/repo" ] || return 1
    [ -n "$ZELLIJ" ] || return 0
    local title; title=$(work_agent_tab_name "$SDIR")

    local wrapper; wrapper=$(mktemp /tmp/cgremlin-work-XXXXXX)
    cat > "$wrapper" <<WRAPPER
#!/bin/bash
echo \$\$ > "$SDIR/agent_pid"
cd "$SDIR" || exit 1
exec claude --model "$MODEL" "Your very first action: read CLAUDE.md in this directory and follow it exactly — it is your autonomous working brief. Begin now; do not wait for my input; do not read any other CLAUDE.md."
WRAPPER
    chmod +x "$wrapper"

    # Ensure the WORK tab exists (create with tab-bar + this pane), else add a
    # tiled pane to it. Detect existence via dump-layout (tab names appear there).
    if zellij action dump-layout 2>/dev/null | grep -qF 'tab name="🔨 WORK"'; then
        zellij action go-to-tab-name "🔨 WORK" 2>/dev/null || true
        zellij action new-pane --name "$title" -- bash "$wrapper" 2>/dev/null || true
    else
        local lay; lay=$(mktemp /tmp/cgremlin-worklayout-XXXXXX)
        cat > "$lay" <<KDL
layout {
    pane size=1 borderless=true {
        plugin location="zellij:tab-bar"
    }
    pane name="$title" command="bash" {
        args "$wrapper"
    }
}
KDL
        zellij action new-tab --name "🔨 WORK" --layout "$lay" 2>/dev/null || true
        rm -f "$lay"
    fi
}
```

- [ ] **Step 5: Verify syntax + live tab/pane behavior**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
# Live: simulate two work panes landing in one WORK tab (trivial commands, tab-bar present, auto-detect-existing).
lay=$(mktemp /tmp/cgremlin-worklayout-XXXXXX)
cat > "$lay" <<'KDL'
layout {
    pane size=1 borderless=true { plugin location="zellij:tab-bar" }
    pane name="🔍 HB-1" command="bash" { args "-c" "echo one; sleep 8" }
}
KDL
zellij --session mission-control action new-tab --name "🔨 WORK" --layout "$lay" 2>/dev/null; rm -f "$lay"
sleep 1
zellij --session mission-control action go-to-tab-name "🔨 WORK" 2>/dev/null
zellij --session mission-control action new-pane --name "🔨 HB-2" -- bash -c "echo two; sleep 8" 2>/dev/null
sleep 1
echo "WORK tab present: $(zellij --session mission-control action dump-layout 2>/dev/null | grep -cF 'tab name="🔨 WORK"')"
echo "panes in WORK tab (expect tab-bar + 2 agent panes):"
zellij --session mission-control action dump-layout 2>/dev/null | awk '/tab name="🔨 WORK"/{f=1} f{print} f&&/^        \}/{exit}' | grep -cE 'command=|plugin' | xargs echo "  pane-ish lines:"
sleep 8
# cleanup the test WORK tab
zellij --session mission-control action go-to-tab-name "🔨 WORK" 2>/dev/null && zellij --session mission-control action close-tab 2>/dev/null || true
```
Expected: `BASH OK`; `WORK tab present: 1`; the WORK tab contains the tab-bar plugin plus 2 agent panes.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: create_work_agent_pane — tile agent panes into a shared WORK tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `--investigate` — start an autonomous investigation

**Files:**
- Modify: `bin/cgremlin` — add `investigate_start()` near `create_investigation_session_noninteractive` (~line 12984); add the investigate `CLAUDE.md` writer; add the `--investigate` dispatch near `--review-pr` (~line 13349) and to the dashboard-skip guard (~line 12856).

**Interfaces:**
- Consumes: `create_work_agent_pane` (Task 1), `create_session_json`, `read_session_field`, `update_session_field`.
- Produces:
  - `--investigate <repo-url-or-git> <jira-key>` → creates an investigation session (clone, `session.json` with mode=investigation + `jira.ticket`), writes `$SDIR/CLAUDE.md` = the investigate autonomous brief, launches it in the WORK tab, prints the session name.
  - Session field `jira.ticket` holds the key. The agent fetches ticket details itself via Atlassian MCP.

- [ ] **Step 1: Write the failing check (investigate CLAUDE.md content)**

`/tmp/t2.sh`:
```bash
#!/bin/bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"
mkdir -p "$root/inv-x/repo"; printf '{"mode":"investigation","jira":{"ticket":"HB-1051"}}' > "$root/inv-x/session.json"
write_investigate_brief "$root/inv-x"
grep -q "INVESTIGATION" "$root/inv-x/CLAUDE.md" && echo "HAS-BRIEF" || echo "NO-BRIEF"
grep -q "FINDINGS.md" "$root/inv-x/CLAUDE.md" && echo "HAS-FINDINGS" || echo "NO"
grep -q "do NOT change code\|no code changes\|Do NOT modify code" "$root/inv-x/CLAUDE.md" && echo "NO-CODE-RULE" || echo "MISSING-NO-CODE"
rm -rf "$root"
```
Run: `bash /tmp/t2.sh` → Expected: `write_investigate_brief: command not found`.

- [ ] **Step 2: Implement `write_investigate_brief`**

Add near `create_investigation_session_noninteractive` (~line 12984):

```bash
# Write the investigate-mode autonomous brief as the agent's cwd CLAUDE.md.
# Usage: write_investigate_brief SESSION_DIR
write_investigate_brief() {
    local SDIR="$1" key
    key=$(read_session_field "$SDIR" "jira.ticket")
    cat > "$SDIR/CLAUDE.md" <<INV
# INVESTIGATION — ${key:-(no ticket)}

You are running in the session directory. The PR/repo code is in \`./repo/\`.
Work autonomously. Your deliverable is a complete, self-contained \`FINDINGS.md\`
in this directory — no code changes.

## Source of truth: the Jira ticket
${key:+The ticket is ${key}. Fetch it now via the Atlassian MCP (getJiraIssue) to read the summary, description, and acceptance criteria.} If the ticket is unavailable or absent, use whatever task description you were given. The ticket defines scope — investigate ONLY what it asks about.

## What to do (autonomously — do not ask me for routine steps)
1. Understand the request from the ticket.
2. Explore \`./repo/\`: trace the relevant code paths, reproduce/understand the issue, find the ROOT CAUSE.
3. Write \`FINDINGS.md\` as a COMPLETE HANDOFF a fresh developer could execute from alone:
   - **What's happening** (the observed problem/behavior)
   - **Root cause** (the specific code and why)
   - **Affected files/paths**
   - **Risks / splash zone** (what a fix could plausibly affect)
   - **Direction / plan** to fix the ticket (concrete steps, scoped to the ticket)
4. Do NOT change code. Investigation produces understanding + plan only.

## Scope discipline
Cover ONLY what the ticket asks. If you find necessary out-of-scope work, note it under a "Tech debt (proposed)" section in FINDINGS.md and TELL ME — do not act on it. I decide whether to open a tech-debt Jira.

## When to pause
Proceed on your own for all routine investigation. Pause and ask ME only when there's a genuine approach/design decision with real trade-offs to discuss.

## Handing off to development
When FINDINGS.md is ready, present a short summary and offer to build it. If I say to build it (e.g. "build it" / "let's develop this"), run:
  cgremlin --develop $(basename "$SDIR")
That opens a fresh develop session seeded with FINDINGS.md + the ticket, and closes this pane.

BEGIN NOW: fetch the ticket, investigate, and write FINDINGS.md.
INV
}
```

Note: `write_investigate_brief` requires `--commit-fix`-style command permissions only for `cgremlin --develop`. Add that to a settings file: also write `$SDIR/.claude/settings.local.json` allowing `Bash(cgremlin --develop *)`:

```bash
# (append inside write_investigate_brief, after the heredoc)
    mkdir -p "$SDIR/.claude"
    printf '{"permissions":{"allow":["Bash(cgremlin --develop *)"]}}\n' > "$SDIR/.claude/settings.local.json"
```

- [ ] **Step 3: Run the check to verify the brief writes correctly**

Run: `bash /tmp/t2.sh`
Expected: `HAS-BRIEF`, `HAS-FINDINGS`, `NO-CODE-RULE`.

- [ ] **Step 4: Implement `investigate_start` + dispatch**

Add `investigate_start` after `write_investigate_brief`:

```bash
# Create an investigation session and launch its agent in the WORK tab.
# Usage: investigate_start <repo-git-url> <jira-key>
investigate_start() {
    local repo_url="$1" jira="$2"
    local session_name
    session_name=$(create_investigation_session_noninteractive "$repo_url" "" "$jira" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: investigation session creation failed" >&2; return 1; }
    local SDIR="$SESSIONS_DIR/$session_name"
    # Ensure the ticket is recorded even if the creator didn't set it.
    [ -n "$jira" ] && update_session_field "$SDIR" "jira.ticket" "$jira"
    write_investigate_brief "$SDIR"     # overwrite the generic investigation CLAUDE.md with the autonomous brief
    create_work_agent_pane "$SDIR"
    echo "$session_name"
}
```

Add the dispatch next to `--review-pr` (~line 13349):

```bash
if [ "$1" = "--investigate" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --investigate <repo-url> <jira-key>" >&2; exit 1; }
    investigate_start "$2" "$3"; exit $?
fi
```

Add `--investigate` to the dashboard-skip guard `if` (~line 12856), same style as `--review-pr`:
`... && [ "$1" != "--investigate" ] ...`

- [ ] **Step 5: Verify syntax + dispatch presence**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
command grep -q '"\$1" = "--investigate"' bin/cgremlin && echo "DISPATCH OK"
command grep -q '\[ "\$1" != "--investigate" \]' bin/cgremlin && echo "GUARD OK"
```
Expected: `BASH OK`, `DISPATCH OK`, `GUARD OK`. (Use `command grep`; the wrapped grep false-negatives on the big file.)

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: --investigate starts an autonomous investigation in the WORK tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: develop-lifecycle helpers — `--pr-ready` and `--resolve-comment`

**Files:**
- Modify: `bin/cgremlin` — add `pr_ready()` and `resolve_comment()` near `reply_comment` (~line 332); add their dispatches near `--reply-comment` and add both to the dashboard-skip guard.

**Interfaces:**
- Consumes: `read_session_field`, `_pr_repo`.
- Produces:
  - `pr_ready SESSION_NAME` → `gh pr ready <num>` (undraft) for the session's PR.
  - `resolve_comment SESSION_NAME THREAD_ID` → GraphQL `resolveReviewThread` on that thread.
  - Dispatches `--pr-ready <session>` and `--resolve-comment <session> <thread-id>`.

- [ ] **Step 1: Write the failing check**

```bash
cd /Users/guilherme.azoubel/context-gremlin
command grep -q 'resolveReviewThread' bin/cgremlin && echo present || echo absent
```
Expected: `absent`.

- [ ] **Step 2: Implement the helpers**

Add after `reply_comment` (~line 332):

```bash
# Mark the session's PR ready for review (undraft). Only invoked on explicit user go-ahead.
pr_ready() {
    local d="$SESSIONS_DIR/$1" num repo
    num=$(read_session_field "$d" "pr.number"); repo=$(_pr_repo "$d")
    [ -z "$num" ] || [ -z "$repo" ] && { echo "ERROR: missing pr.number/repo" >&2; return 1; }
    gh pr ready "$num" --repo "$repo" && echo "marked PR #$num ready" || { echo "ERROR: gh pr ready failed" >&2; return 1; }
}
# Resolve a review thread (after replying, e.g. a confirmed false positive).
resolve_comment() {
    local tid="$2"
    [ -n "$tid" ] || { echo "ERROR: thread id required" >&2; return 1; }
    gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
        -F t="$tid" >/dev/null && echo "resolved $tid" || { echo "ERROR: resolve failed" >&2; return 1; }
}
```

Add dispatches next to `--reply-comment`:

```bash
if [ "$1" = "--pr-ready" ];        then [ -z "$2" ] && { echo "Usage: cgremlin --pr-ready <session>" >&2; exit 1; }; pr_ready "$2"; exit $?; fi
if [ "$1" = "--resolve-comment" ]; then [ -z "$3" ] && { echo "Usage: cgremlin --resolve-comment <session> <thread-id>" >&2; exit 1; }; resolve_comment "$2" "$3"; exit $?; fi
```

Add both flags to the dashboard-skip guard `if` (~line 12856): `... && [ "$1" != "--pr-ready" ] && [ "$1" != "--resolve-comment" ] ...`

- [ ] **Step 3: Verify syntax + dispatch + resolve mutation shape**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
for f in pr-ready resolve-comment; do command grep -q "\"\$1\" = \"--$f\"" bin/cgremlin && echo "DISPATCH $f OK"; done
# Confirm the GraphQL mutation string is well-formed (jq parses the query text — offline sanity only)
command grep -q 'resolveReviewThread(input:{threadId:\$t})' bin/cgremlin && echo "MUTATION OK"
```
Expected: `BASH OK`, two `DISPATCH ... OK`, `MUTATION OK`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: --pr-ready (undraft) + --resolve-comment (resolve thread) helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `--develop` — promote an investigation into an autonomous develop session

**Files:**
- Modify: `bin/cgremlin` — add `write_develop_brief()` and `develop_start()` near `create_development_session_noninteractive` (~line 13017); add the `--develop` dispatch and guard entry.

**Interfaces:**
- Consumes: `create_work_agent_pane` (Task 1), `create_session_json`, `read_session_field`, `update_session_field`, `pr_ready`/`resolve_comment`/`reply_comment` (Task 3, invoked by the agent), `write_review_guard`.
- Produces:
  - `--develop <investigation-session-name>` → reads the investigation's `jira.ticket` + `FINDINGS.md`, creates a fresh development session (clone same repo, `session.json` mode=development + `jira.ticket`), copies `FINDINGS.md` into it, writes the develop autonomous brief as `$SDIR/CLAUDE.md`, launches it in the WORK tab, then closes the investigation pane (kills its `agent_pid`). Prints the develop session name.

- [ ] **Step 1: Write the failing check (develop brief content)**

```bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"
mkdir -p "$root/dev-y/repo"; printf '{"mode":"development","jira":{"ticket":"HB-1051"}}' > "$root/dev-y/session.json"
printf '# findings\nroot cause X\n' > "$root/dev-y/FINDINGS.md"
write_develop_brief "$root/dev-y" 2>/dev/null || echo "MISSING FUNC"
rm -rf "$root"
```
Expected: `MISSING FUNC`.

- [ ] **Step 2: Implement `write_develop_brief`**

Add near `create_development_session_noninteractive` (~line 13017):

```bash
# Write the develop-mode autonomous brief as the agent's cwd CLAUDE.md.
# Usage: write_develop_brief SESSION_DIR
write_develop_brief() {
    local SDIR="$1" key sn; key=$(read_session_field "$SDIR" "jira.ticket"); sn=$(basename "$SDIR")
    cat > "$SDIR/CLAUDE.md" <<DEV
# DEVELOP — ${key:-(no ticket)}

You are running in the session directory. The code is in \`./repo/\`. \`FINDINGS.md\`
here is your seeded investigation (root cause + direction). The Jira ticket
${key:+(${key}) — fetch via Atlassian MCP getJiraIssue} is the source of truth.
Cover ONLY what the ticket asks.

## Flow (autonomous except at the gates below)
1. **Read FINDINGS.md + the ticket.** Refine into a concrete implementation plan (root cause is already known).
2. **PLAN GATE — pause.** Present the plan to me, explain it, and adjust it with me. Do NOT implement until I explicitly say to proceed.
3. **Implement with TDD.** For each unit: write the failing test, run it (confirm it fails), write minimal code, run to green, commit. Stay strictly in ticket scope.
4. **Open a draft PR** on the pushed branch: \`gh pr create --draft\`, body summarizing the change and linking ${key:-the ticket}.
5. **Verify on preview.** Find the draft PR's Vercel preview URL (from \`gh pr view <n> --json statusCheckRollup\` — the grace-frontend-dev deployment). Run a FOCUSED live web test set against it with Playwright: prove the ticket's issue is fixed, plus a smoke pass of the feature and its likely splash-zone regressions. NOT the full e2e suite. Iterate to green.
6. **Assess bot comments.** For each gitStream/bot (and any) unresolved comment on the PR:
   - false positive → reply "false positive: <reason>" then resolve it:
       cgremlin --reply-comment $sn <thread-id>   (write the reply to ${SDIR}/.reply_body.md first)
       cgremlin --resolve-comment $sn <thread-id>
   - clearly valid → fix it (TDD for code changes).
   - unsure → STOP and show it to me to discuss.
7. **Notify me** it's tested and comment-clean so I can watch it run against preview and ask questions.
8. **READY GATE.** Only when I say I'm satisfied, mark the PR ready:
       cgremlin --pr-ready $sn

## Scope + tech debt
Out-of-scope-but-needed work → propose a tech-debt Jira (Atlassian createJiraIssue) and create it ONLY with my explicit OK. Never expand scope silently.

## Hard rules
- Never mark the PR ready (\`--pr-ready\`) or create a Jira without my explicit go-ahead.
- Never skip the PLAN GATE.
- Post to GitHub only via the cgremlin helpers above (never raw gh for review/comment mutations); \`gh pr create --draft\`, \`gh pr view\`, git push are fine.

BEGIN NOW: read FINDINGS.md + the ticket and prepare the plan for the PLAN GATE.
DEV
    mkdir -p "$SDIR/.claude"
    printf '{"permissions":{"allow":["Bash(cgremlin --reply-comment *)","Bash(cgremlin --resolve-comment *)","Bash(cgremlin --pr-ready *)","Bash(cgremlin --commit-fix *)","Bash(cgremlin --push-fix *)"]}}\n' > "$SDIR/.claude/settings.local.json"
}
```

- [ ] **Step 3: Implement `develop_start` + dispatch**

Add after `write_develop_brief`:

```bash
# Promote an investigation into a fresh develop session (seeded with FINDINGS.md),
# launch it in the WORK tab, and close the investigation pane.
# Usage: develop_start <investigation-session-name>
develop_start() {
    local inv="$1" INV_DIR="$SESSIONS_DIR/$inv"
    [ -d "$INV_DIR/repo" ] || { echo "ERROR: investigation session $inv not found" >&2; return 1; }
    local jira repo_url
    jira=$(read_session_field "$INV_DIR" "jira.ticket")
    repo_url=$(read_session_field "$INV_DIR" "project"); [ -z "$repo_url" ] && repo_url="https://github.com/$(_pr_repo "$INV_DIR")"
    local session_name
    session_name=$(create_development_session_noninteractive "$repo_url" "$jira" | tail -1)
    [ -z "$session_name" ] && { echo "ERROR: develop session creation failed" >&2; return 1; }
    local SDIR="$SESSIONS_DIR/$session_name"
    [ -n "$jira" ] && update_session_field "$SDIR" "jira.ticket" "$jira"
    # Seed the findings (self-contained handoff).
    [ -f "$INV_DIR/FINDINGS.md" ] && cp "$INV_DIR/FINDINGS.md" "$SDIR/FINDINGS.md"
    write_develop_brief "$SDIR"
    create_work_agent_pane "$SDIR"
    # The investigation agent's job is done — close its pane.
    local ipid; ipid=$(cat "$INV_DIR/agent_pid" 2>/dev/null)
    [ -n "$ipid" ] && kill "$ipid" 2>/dev/null; rm -f "$INV_DIR/agent_pid"
    echo "$session_name"
}
```

Add the dispatch near `--investigate`:

```bash
if [ "$1" = "--develop" ]; then
    [ -z "$2" ] && { echo "Usage: cgremlin --develop <investigation-session>" >&2; exit 1; }
    develop_start "$2"; exit $?
fi
```
Add `--develop` to the dashboard-skip guard `if`.

- [ ] **Step 4: Verify syntax + brief + FINDINGS seeding**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"
mkdir -p "$root/dev-y/repo"; printf '{"mode":"development","jira":{"ticket":"HB-1051"}}' > "$root/dev-y/session.json"
write_develop_brief "$root/dev-y"
grep -q "PLAN GATE" "$root/dev-y/CLAUDE.md" && echo "HAS-PLAN-GATE"
grep -q "READY GATE" "$root/dev-y/CLAUDE.md" && echo "HAS-READY-GATE"
grep -q "cgremlin --pr-ready" "$root/dev-y/CLAUDE.md" && echo "HAS-READY-CMD"
grep -q '"Bash(cgremlin --pr-ready \*)"' "$root/dev-y/.claude/settings.local.json" && echo "PERMS-OK"
command grep -q '"\$1" = "--develop"' bin/cgremlin && echo "DISPATCH OK"
rm -rf "$root"
```
Expected: `BASH OK`, `HAS-PLAN-GATE`, `HAS-READY-GATE`, `HAS-READY-CMD`, `PERMS-OK`, `DISPATCH OK`.

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: --develop promotes an investigation into an autonomous TDD develop session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Orchestrator wiring — start investigations conversationally

**Files:**
- Modify: `bin/cgremlin` — `launch_orchestrator()` (~line 13413): extend its generated `CLAUDE.md` and allowlist so the orchestrator can run `--investigate` and knows the conversational flow.

**Interfaces:**
- Consumes: the `--investigate` command (Task 2), `DEFAULT_PROJECT` (existing, for the repo URL).
- Produces: the orchestrator agent, told: when the user says they're picking up a ticket (e.g. "I'm on HB-1051"), run `cgremlin --investigate <DEFAULT_PROJECT repo url> HB-1051`.

- [ ] **Step 1: Inspect the current orchestrator brief + allowlist**

```bash
cd /Users/guilherme.azoubel/context-gremlin
sed -n '/^launch_orchestrator() {/,/^}/p' bin/cgremlin | grep -nE 'review-pr|open-pr|dismiss-pr|allow|permissions|Bash\(' | head
```
Expected: shows the current allowlist (review-pr/open-pr/dismiss-pr) and CLAUDE.md content — note the exact strings to extend.

- [ ] **Step 2: Add `--investigate` to the orchestrator allowlist + instructions**

In `launch_orchestrator`'s generated CLAUDE.md/settings (match the existing pattern exactly), add:
- allowlist entry: `Bash(cgremlin --investigate *)` alongside the existing `Bash(cgremlin --review-pr *)`.
- an instruction block:

```
## Starting work on a ticket
When I tell you I'm picking up a ticket (e.g. "I'm on HB-1051", or paste a Jira key/URL),
run:  cgremlin --investigate <REPO_URL> <JIRA-KEY>
where <REPO_URL> is the DEFAULT_PROJECT repo (expand a bare key against it, same as you
do for PR numbers). That opens an investigation agent in the 🔨 WORK tab. Tell me it started.
Do not investigate yourself — the WORK-tab agent does the work.
```

(Use the same heredoc-escaping and DEFAULT_PROJECT expansion the function already uses for PR numbers.)

- [ ] **Step 3: Verify syntax + allowlist presence**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
command grep -q 'Bash(cgremlin --investigate \*)' bin/cgremlin && echo "ALLOW OK"
command grep -q 'Starting work on a ticket' bin/cgremlin && echo "BRIEF OK"
```
Expected: `BASH OK`, `ALLOW OK`, `BRIEF OK`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: orchestrator can start investigations (cgremlin --investigate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web-UI secondary entry — fix the broken investigate/develop launch

**Files:**
- Modify: `bin/cgremlin` — the embedded Python server (`PYSERVER` heredoc): the handler that creates investigation/development sessions from the dashboard (`CGREMLIN_MODE` path, ~line 7107 / `--create-session` at ~line 13377).

**Interfaces:**
- Consumes: the `--investigate` command (Task 2). For the web path, mode=investigation launches via the same WORK-tab flow.
- Produces: clicking "Start Investigation" in the web UI creates the session and launches the WORK-tab agent (no "broken session", no manual "Start Claude"). Develop is promoted from the investigation agent (Task 4), not the web UI, so the web UI only needs the investigation entry fixed.

- [ ] **Step 1: Reproduce + locate the broken flow**

```bash
cd /Users/guilherme.azoubel/context-gremlin
# Find where the dashboard creates an investigation session and launches a terminal.
command grep -n "CGREMLIN_MODE\|create_investigation\|investigation\|launch_in_terminal_tab\|Start Claude\|broken" bin/cgremlin | awk -F: '$1>4890 && $1<10120' | head -20
```
Expected: identifies the create-session + terminal-launch lines in PYSERVER; note whether session.json/CLAUDE.md are written before the launch (the bug: launched before/without full state, or via a terminal path that shows "broken session").

- [ ] **Step 2: Route the web investigation launch through `--investigate`**

In the PYSERVER create-session handler for `mode == 'investigation'`, replace the broken terminal launch with a call that shells out to the CLI investigate path so it lands in the WORK tab. Concretely, after resolving the repo URL and Jira key from the request, run (Python `subprocess`):

```python
# Launch the investigation agent into Mission Control's WORK tab (same path as
# the orchestrator's "I'm on HB-XXXX"). Requires mission-control to be running.
subprocess.Popen(
    [cgremlin_path(), '--investigate', repo_url, jira_key or ''],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
```

where `cgremlin_path()` resolves the running script path (reuse the existing helper the server uses to call back into `cgremlin --create-session`). Remove the old "create empty session then require Start Claude" branch for investigation. Return a JSON success telling the user the investigation started in Mission Control's WORK tab.

- [ ] **Step 3: Verify Python syntax + bash syntax**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
python3 - <<'PY'
import ast
lines=open('bin/cgremlin',encoding='utf-8').read().split('\n')
s=e=None
for i,l in enumerate(lines):
    if s is None and l.strip().endswith("<< 'PYSERVER'"): s=i+1
    elif s is not None and l.strip()=='PYSERVER': e=i; break
ast.parse('\n'.join(lines[s:e])); print("PYTHON OK")
PY
command grep -q "'--investigate'" bin/cgremlin && echo "WEB-ROUTE OK"
```
Expected: `BASH OK`, `PYTHON OK`, `WEB-ROUTE OK`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "fix: web-UI 'Start Investigation' launches into the WORK tab (no broken session)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- After all tasks: relaunch Mission Control fresh (`cgremlin --mission-control --fresh`) so the orchestrator picks up the new allowlist/brief, then live-test: tell the orchestrator "I'm on <a real ticket>" → confirm a `🔍 <KEY>` pane appears in a `🔨 WORK` tab and the agent starts investigating; then "build it" → confirm a `🔨 <KEY>` develop pane opens and the investigation pane closes.
- Atlassian MCP (`getJiraIssue`/`createJiraIssue`), Vercel preview URL discovery, and Playwright are **agent-side** — they must be available/authenticated in the environment for the agent to use them. If Jira MCP is unavailable, the briefs already instruct falling back to the provided task text; note that in the final review.
- `DEFAULT_PROJECT` must point at the grace-frontend repo for the orchestrator's key→URL expansion; verify in `~/.cgremlin/config`.
- The develop preview-test + bot-triage steps are agent behavior driven by the brief (Task 4), not new bash code beyond the helpers in Task 3 — the final review should confirm the brief is unambiguous, not look for extra code.
