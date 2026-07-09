# Status-Panel Attention States + WORK Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-item attention state (🔄 working / ⏸️ needs input / ✅ ready / 🛑 blocked / 💤 idle) on every Mission-Control status row, and list investigate/develop WORK sessions there — each as its own named, clickable tab.

**Architecture:** Reuse the existing `.cg_agent_state` hook signal (working/waiting) and add an agent-declared `.cg_attention` file (needs-input/ready/blocked) written by two new helpers the briefs call at their gates. A resolver maps the pair to an icon, used by `review_list_grouped` for both PR rows and a new "🔨 Your work" section. `create_work_agent_pane` switches from one tiled `🔨 WORK` tab to one named tab per session, and `open_pr_row` learns to jump to WORK tabs.

**Tech Stack:** Bash (single script `bin/cgremlin`) + its embedded Python `PYSERVER` heredoc; Zellij tab actions; fzf status picker.

## Global Constraints

- **`bin/cgremlin` is the ONLY file changed.** After every edit: `bash -n bin/cgremlin` must pass. When the Python `PYSERVER` heredoc is touched (Task 1), also run the `ast.parse` check (Task 1 shows the exact command).
- **Bash/Python sync:** the `Stop`/`UserPromptSubmit` hooks exist in TWO places that must stay identical in effect — the bash heredoc (`setup_output_files`, ~line 2270) and the Python `PYSERVER` copy (`DashboardHandler.setup_output_files`, ~line 6206).
- **Attention icons (exact glyphs):** 🔄 Working · ⏸️ Needs your input · ✅ Ready to review · 🛑 Blocked · 💤 idle.
- **Semantic states (exact tokens written to `.cg_attention`):** `needs-input` · `ready` · `blocked`. No other values are valid.
- **Resolver precedence:** `working` (activity) always wins → 🔄, regardless of `.cg_attention`. Only when the agent has stopped (`waiting`/empty) does `.cg_attention` decide.
- **Idle default:** a stopped agent with no `.cg_attention` shows 💤, EXCEPT a PR discussion/triage agent, which shows ⏸️ (its waiting = your turn). A PR session whose `review_state` is `failed` shows 🛑.
- **Description source:** `.cg_note` (agent one-liner, seeded from the ticket) is the primary description; `jira.summary` (present only for interactively-created sessions) is a fallback identity line; the Jira key / branch is the final fallback. Do NOT add Jira-fetch plumbing to the automated creation paths.
- **fzf row convention:** every row is `<display>\t<session>\t<group>` (a section header uses empty session+group: `<header>\t\t`). WORK rows carry the real session name in field 2 and `work` in field 3.
- No new long-running processes. DRY: one resolver, one note helper, one state helper.

## File Structure

`bin/cgremlin` only. Touch-points (current line numbers from the mapping; edit by matching quoted anchors, not line numbers):
- Hooks: bash ~2270–2273, Python ~6206–6209.
- New helpers near the other small helpers (~353–401): `set_agent_state`, `set_agent_note`, `attention_icon`.
- Dispatch guard ~13209; new dispatch blocks near ~13194.
- `review_list_grouped` 605–707 (add resolver calls + WORK section).
- `create_work_agent_pane` 775–812 and `work_agent_tab_name` 762–768.
- `open_pr_row` 1042–1069.
- Briefs: `write_investigate_brief` 13372–13412, `write_develop_brief` 13468–13512; allowlists 13411 & 13511.

---

### Task 1: Hooks clear `.cg_attention` on a new turn

**Files:** Modify `bin/cgremlin` — bash hook (~line 2272) and Python `PYSERVER` hook (~line 6208).

**Interfaces:**
- Produces: the invariant that `.cg_attention` is wiped whenever the user submits a prompt (a new turn begins), so a stale semantic state never lingers. Consumed by Task 3's resolver.

- [ ] **Step 1: Extend the bash `UserPromptSubmit` hook**

Find this line (~2272):
```
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo working > $SESSION_DIR/.cg_agent_state"}]}]
```
Replace the command string so it also clears `.cg_attention`:
```
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "echo working > $SESSION_DIR/.cg_agent_state; rm -f $SESSION_DIR/.cg_attention"}]}]
```
(Leave the `Stop` line unchanged.)

- [ ] **Step 2: Extend the Python `PYSERVER` `UserPromptSubmit` hook**

Find this line (~6208):
```
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": f"echo working > {session_abs}/.cg_agent_state"}]}]
```
Replace with:
```
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": f"echo working > {session_abs}/.cg_agent_state; rm -f {session_abs}/.cg_attention"}]}]
```

- [ ] **Step 3: Syntax checks (bash + Python)**

```bash
bash -n bin/cgremlin && echo "bash OK"
python3 - <<'PY'
import re,ast
s=open('bin/cgremlin').read()
# PYSERVER heredoc body: from the line after `cat ... <<'PYSERVER'` (or <<PYSERVER) to the closing PYSERVER
m=re.search(r"<<'?PYSERVER'?\n(.*?)\nPYSERVER\n", s, re.S)
assert m, "PYSERVER heredoc not found"
ast.parse(m.group(1)); print("python OK")
PY
```
Expected: `bash OK` then `python OK`.

- [ ] **Step 4: Confirm both copies now clear `.cg_attention`**

```bash
command grep -c 'rm -f $SESSION_DIR/.cg_attention' bin/cgremlin   # expect 1
command grep -c 'rm -f {session_abs}/.cg_attention' bin/cgremlin  # expect 1
```
Expected: `1` and `1`.

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: UserPromptSubmit hook clears .cg_attention on a new turn"
```

---

### Task 2: `set_agent_state` / `set_agent_note` helpers + dispatch

**Files:** Modify `bin/cgremlin` — new helpers near the small-helper cluster (after `pr_threads`, ~line 401); dispatch blocks near ~13195; the guard ~13209.

**Interfaces:**
- Produces:
  - `set_agent_state SESSION STATE` — validates STATE ∈ {needs-input, ready, blocked}; writes it to `$SESSIONS_DIR/SESSION/.cg_attention`. Dispatched as `cgremlin --agent-state <session> <state>`.
  - `set_agent_note SESSION TEXT` — writes TEXT (single line, trimmed to 100 chars) to `$SESSIONS_DIR/SESSION/.cg_note`. Dispatched as `cgremlin --agent-note <session> <text...>`.
- Consumed by: Task 3 (resolver reads the files), Task 5 (briefs call the verbs).

- [ ] **Step 1: Add the two helpers**

Insert after the `pr_threads() { ... }` function (~line 401):
```bash
# Agent-declared attention state for the status pane. STATE ∈ needs-input|ready|blocked.
# Usage: set_agent_state SESSION STATE
set_agent_state() {
    local d="$SESSIONS_DIR/$1" state="$2"
    [ -d "$d" ] || { echo "ERROR: unknown session '$1'" >&2; return 1; }
    case "$state" in
        needs-input|ready|blocked) printf '%s' "$state" > "$d/.cg_attention"; echo "agent-state: $1 -> $state";;
        *) echo "ERROR: state must be needs-input|ready|blocked (got '$state')" >&2; return 1;;
    esac
}

# Agent's live one-line description for the status pane.
# Usage: set_agent_note SESSION TEXT...
set_agent_note() {
    local d="$SESSIONS_DIR/$1"; shift
    [ -d "$d" ] || { echo "ERROR: unknown session" >&2; return 1; }
    local text="$*"
    text="${text//$'\n'/ }"
    printf '%.100s' "$text" > "$d/.cg_note"
    echo "agent-note set"
}
```

- [ ] **Step 2: Add dispatch blocks**

Next to the `--pr-threads` dispatch (~line 13195), add:
```bash
if [ "$1" = "--agent-state" ]; then [ -z "$3" ] && { echo "Usage: cgremlin --agent-state <session> <needs-input|ready|blocked>" >&2; exit 1; }; set_agent_state "$2" "$3"; exit $?; fi
if [ "$1" = "--agent-note" ];  then [ -z "$3" ] && { echo "Usage: cgremlin --agent-note <session> <text>" >&2; exit 1; }; sess="$2"; shift 2; set_agent_note "$sess" "$@"; exit $?; fi
```

- [ ] **Step 3: Add both verbs to the dashboard-skip guard**

In the big `if [ "$1" != ... ]` guard (~line 13209), append two more clauses before the closing `; then`:
```
 && [ "$1" != "--agent-state" ] && [ "$1" != "--agent-note" ]
```

- [ ] **Step 4: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 5: Behavioral test**

```bash
export SESSIONS_DIR=$(mktemp -d); mkdir -p "$SESSIONS_DIR/s1"
./bin/cgremlin --agent-state s1 ready   && cat "$SESSIONS_DIR/s1/.cg_attention"; echo
./bin/cgremlin --agent-state s1 bogus;   echo "rc=$?"            # expect ERROR + rc=1
./bin/cgremlin --agent-note s1 hello there world;  cat "$SESSIONS_DIR/s1/.cg_note"; echo
```
Expected: `.cg_attention` = `ready`; the bogus call prints an ERROR and `rc=1` and does NOT overwrite (`.cg_attention` still `ready`); `.cg_note` = `hello there world`.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: --agent-state / --agent-note helpers for status-pane attention"
```

---

### Task 3: Attention resolver + status-pane rendering (icons + WORK section)

**Files:** Modify `bin/cgremlin` — new `attention_icon` helper (near Task 2's helpers); `review_list_grouped` (605–707).

**Interfaces:**
- Consumes: `.cg_agent_state`, `.cg_attention`, `.cg_note` (Tasks 1–2); `jira.summary`/`jira.ticket` from `session.json`.
- Produces: `attention_icon SESSION_DIR DISCUSSION_FLAG` → echoes one glyph (or empty). Used on PR rows and WORK rows.

- [ ] **Step 1: Add the resolver**

Insert near the Task 2 helpers:
```bash
# Map an agent's activity + declared attention into a status glyph.
# $1 = SESSION_DIR   $2 = "1" if this is a PR discussion/triage agent (waiting = your turn), else ""
# Echoes the glyph, or empty string if no agent has ever run for this session.
attention_icon() {
    local d="$1" disc="$2" act att
    act=$(cat "$d/.cg_agent_state" 2>/dev/null)
    att=$(cat "$d/.cg_attention" 2>/dev/null)
    if [ "$act" = "working" ]; then echo "🔄 working"; return; fi
    case "$att" in
        blocked)     echo "🛑 blocked"; return;;
        ready)       echo "✅ ready for review"; return;;
        needs-input) echo "⏸️ needs your input"; return;;
    esac
    # stopped with nothing declared
    if [ -n "$act" ]; then
        [ "$disc" = "1" ] && echo "⏸️ needs your input" || echo "💤 idle"
    fi
    # no .cg_agent_state at all → echo nothing
}
```

- [ ] **Step 2: Append the attention glyph to PR rows**

In `review_list_grouped`, the `ready` group builds rows like (line ~691):
```
      ready="${ready}$(printf 'PR #%s  @%-14s %s' "$num" "${author:-?}" "$icon")\t${sname}\tready"$'\n'
```
For each PR row that has a session dir `$d` and a discussion agent, append the attention glyph after the existing `$icon`. Add, just before building each clickable PR row (`ready`, `rereview`, `mycomments`, `response`), this line:
```bash
      local aicon; aicon=$(attention_icon "$d" 1); [ -n "$aicon" ] && aicon="  $aicon"
```
and change the row `printf`s to append `%s` fed `"$aicon"`, e.g. the `ready` row becomes:
```
      ready="${ready}$(printf 'PR #%s  @%-14s %s%s' "$num" "${author:-?}" "$icon" "$aicon")\t${sname}\tready"$'\n'
```
Apply the same `%s`+`"$aicon"` append to the `rereview` (line ~682), `mycomments` (~644), and `response` (~694) row builders. (Use `$d` — the session dir already in scope in that loop; if the loop variable is named differently, use it.)

- [ ] **Step 3: Add the "🔨 Your work" section**

At the end of `review_list_grouped`, immediately BEFORE the final closing `}` (line 707), add a pass over investigate/develop sessions:
```bash
  # ── WORK sessions (investigate/develop): one row each, clickable to their tab ──
  local work=""
  for wd in "$SESSIONS_DIR"/*/; do
      [ -f "$wd/session.json" ] || continue
      local wmode wsn wkey wemoji wsummary wnote wicon wtitle
      wmode=$(read_session_field "${wd%/}" "mode")
      case "$wmode" in investigation|development) : ;; *) continue;; esac
      wsn=$(basename "${wd%/}")
      wkey=$(read_session_field "${wd%/}" "jira.ticket"); [ -z "$wkey" ] && wkey="$wsn"
      case "$wmode" in development) wemoji="🔨";; *) wemoji="🔍";; esac
      wsummary=$(read_session_field "${wd%/}" "jira.summary")
      wnote=$(cat "${wd%/}/.cg_note" 2>/dev/null)
      wicon=$(attention_icon "${wd%/}" ""); [ -z "$wicon" ] && wicon="💤 idle"
      wtitle="${wsummary:-$(read_session_field "${wd%/}" "focus")}"
      work="${work}$(printf '%s %s  %s' "$wemoji" "$wkey" "$wicon")\t${wsn}\twork"$'\n'
      [ -n "$wnote" ] && work="${work}$(printf '   %s' "$wnote")\t${wsn}\twork"$'\n'
  done
  [ -n "$work" ] && { printf '── 🔨 Your work ──\t\t\n'; printf '%b' "$work"; }
```
(If `read_session_field`'s exact call form differs from `read_session_field "$dir" "field"`, match the form already used elsewhere in this function.)

- [ ] **Step 4: Route WORK rows to the jump handler**

Find the fzf Enter binding in the status picker:
```bash
command grep -n 'open-pr\|--bind\|accept\|enter' bin/cgremlin | command grep -i 'status\|open-pr\|fzf'
```
Confirm that pressing Enter on a row runs `cgremlin --open-pr <field2-session>` regardless of the group (field 3). If the Enter handler special-cases groups and would ignore `work`, add `work` to the set that routes to `--open-pr`. (Task 4 makes `open_pr_row` handle WORK sessions.)

- [ ] **Step 5: Syntax check + resolver simulation**

```bash
bash -n bin/cgremlin && echo "bash OK"
# extract + unit-test attention_icon
awk '/^attention_icon\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/ai.sh
D=$(mktemp -d)
run(){ bash -c '. /tmp/ai.sh; attention_icon "'"$1"'" "'"$2"'"'; }
echo working > "$D/.cg_agent_state";                run "$D" ""    # 🔄 working
echo waiting > "$D/.cg_agent_state"; echo ready > "$D/.cg_attention";       run "$D" ""    # ✅ ready for review
echo blocked > "$D/.cg_attention";                  run "$D" ""    # 🛑 blocked
echo needs-input > "$D/.cg_attention";              run "$D" ""    # ⏸️ needs your input
rm -f "$D/.cg_attention";                           run "$D" ""    # 💤 idle
rm -f "$D/.cg_attention";                           run "$D" "1"   # ⏸️ needs your input (discussion)
rm -f "$D/.cg_agent_state" "$D/.cg_attention";      echo "[$(run "$D" "")]"  # [] empty
```
Expected, in order: `🔄 working`, `✅ ready for review`, `🛑 blocked`, `⏸️ needs your input`, `💤 idle`, `⏸️ needs your input`, `[]`.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: status pane shows attention glyph on PR rows + a Your Work section"
```

---

### Task 4: WORK sessions = one named tab each (+ jump)

**Files:** Modify `bin/cgremlin` — `create_work_agent_pane` (775–812), `open_pr_row` (1042–1069), and the promotion close-logic.

**Interfaces:**
- Consumes: `work_agent_tab_name` (unchanged, 762–768) → `🔍 <key>` / `🔨 <key>`.
- Produces: each investigate/develop session runs in its OWN named tab; `open_pr_row` jumps to a WORK session's tab by its stable key.

- [ ] **Step 1: Rewrite `create_work_agent_pane` to one named tab per session**

Replace the tab-creation block (current lines 792–811, the `if dump-layout … 🔨 WORK … else … new-tab --name "🔨 WORK"` block) with a single named-tab creation that jumps if the tab already exists:
```bash
    # One named tab per WORK session (like PR-review tabs), so it's individually
    # targetable. Jump to it if it already exists; else create it with a tab-bar.
    local stable; stable="$title"   # e.g. "🔍 HB-1071" — the key is the stable identity
    if zellij --session mission-control action dump-layout 2>/dev/null | grep -qF "tab name=\"$stable\""; then
        zellij --session mission-control action go-to-tab-name "$stable" 2>/dev/null || true
    else
        local lay; lay=$(mktemp /tmp/cgremlin-worklayout-XXXXXX)
        cat > "$lay" <<KDL
layout {
    pane size=1 borderless=true {
        plugin location="zellij:tab-bar"
    }
    pane close_on_exit=true name="$title" command="bash" {
        args "$wrapper"
    }
}
KDL
        zellij --session mission-control action new-tab --name "$stable" --layout "$lay" 2>/dev/null || true
        rm -f "$lay"
    fi
```
(Keep everything above line 792 — the MC-running guard, `$title` from `work_agent_tab_name`, and the wrapper heredoc — unchanged. Update the function's leading comment from "tiled pane in the single 🔨 WORK tab" to "its own named tab".)

- [ ] **Step 2: Teach `open_pr_row` to jump to WORK tabs**

At the top of `open_pr_row` (after the `[ -n "$ZELLIJ" ] || return 0` guard, ~line 1046), add a WORK-session branch BEFORE the PR logic:
```bash
    local _mode; _mode=$(read_session_field "$SDIR" "mode")
    if [ "$_mode" = "investigation" ] || [ "$_mode" = "development" ]; then
        local wtab; wtab=$(work_agent_tab_name "$SDIR")
        local wlayout wcur
        wlayout=$(zellij action dump-layout 2>/dev/null)
        wcur=$(printf '%s' "$wlayout" | grep 'tab name=' | grep -F "$wtab" | head -1 | sed -E 's/.*tab name="([^"]*)".*/\1/')
        if [ -n "$wcur" ]; then
            zellij action go-to-tab-name "$wcur" 2>/dev/null || true
        else
            create_work_agent_pane "$SDIR"
        fi
        return 0
    fi
```
(The PR logic below it is unchanged.)

- [ ] **Step 3: Close the investigate TAB (not pane) on promotion**

Find where promotion to develop closes the investigation pane:
```bash
command grep -n 'close-pane\|close-tab\|closes this pane\|develop_start' bin/cgremlin | head
```
Read that logic (in/near `develop_start`, ~13517). If it closes a pane, change it to close the investigation session's TAB by name:
```bash
    local _itab; _itab=$(work_agent_tab_name "$INV_SDIR")   # INV_SDIR = the investigation session dir
    zellij --session mission-control action go-to-tab-name "$_itab" 2>/dev/null && \
      zellij --session mission-control action close-tab 2>/dev/null || true
```
(Use the actual variable name the promotion code uses for the investigation session dir.)

- [ ] **Step 4: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 5: Static confirmation of the edits**

```bash
command grep -c 'new-tab --name "$stable"' bin/cgremlin        # expect 1 (per-session tab)
command grep -c 'new-tab --name "🔨 WORK"' bin/cgremlin         # expect 0 (old shared tab gone)
command grep -c '_mode" = "investigation"' bin/cgremlin         # expect >=1 (open_pr_row WORK branch)
```
Expected: `1`, `0`, `≥1`.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: each WORK session gets its own named tab; open_pr_row jumps to it"
```

---

### Task 5: Wire the briefs to declare state, note progress, and allowlist the verbs

**Files:** Modify `bin/cgremlin` — `write_investigate_brief` (13372–13412), `write_develop_brief` (13468–13512), and the allowlists at 13411, 13511, plus the review allowlists (2266 / 6196 / 830 / 832).

**Interfaces:**
- Consumes: `cgremlin --agent-state` / `--agent-note` (Task 2). Both briefs use unquoted heredocs (`<<INV`, `<<DEV`) so `$(basename "$SDIR")` / `$sn` expand at write time.

- [ ] **Step 1: Investigate brief — seed a note, declare states**

In `write_investigate_brief`'s `<<INV` heredoc: after step 1 ("Understand the request…", ~13387) add a seed-note instruction, and in the "When to pause" (13400–13401) and "Handing off" (13403) areas add state calls. Concretely:
- After the line `1. Understand the request from the ticket.` add:
```
   As your first action also record a one-line status: \`cgremlin --agent-note $(basename "$SDIR") "<ticket key>: <one-line goal>"\`. Update it at milestones (e.g. "tracing checkout path", "root cause found").
```
- Replace the "When to pause" paragraph (13401) end with an added sentence:
```
 When you pause for such a decision, first run \`cgremlin --agent-state $(basename "$SDIR") needs-input\` so the dashboard shows I'm needed.
```
- After the handoff line `When FINDINGS.md is ready, present a short summary and offer to build it.` add:
```
 The moment FINDINGS.md is complete, run \`cgremlin --agent-state $(basename "$SDIR") ready\` and \`cgremlin --agent-note $(basename "$SDIR") "FINDINGS.md ready — review it"\`.
```

- [ ] **Step 2: Investigate allowlist — add the verbs**

Change line 13411 to include the two verbs:
```bash
    printf '{"permissions":{"allow":["Bash(cgremlin --develop *)","Bash(cgremlin --run-local *)","Bash(cgremlin --stop-local *)","Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"]}}\n' > "$SDIR/.claude/settings.local.json"
```

- [ ] **Step 3: Develop brief — declare states at the gates**

In `write_develop_brief`'s `<<DEV` heredoc (uses `$sn`):
- After step 1 add the seed-note line:
```
   As your first action also record status: \`cgremlin --agent-note $sn "<ticket key>: <one-line goal>"\`; update it at each milestone (e.g. "implementing 3/5 — TDD", "tests green").
```
- Append to the PLAN GATE (step 2, 13480):
```
 Before pausing, run \`cgremlin --agent-state $sn needs-input\`.
```
- Append to "Notify me" (step 7, 13496):
```
 When it's tested and comment-clean, run \`cgremlin --agent-state $sn ready\` and \`cgremlin --agent-note $sn "tested & comment-clean — take a look"\`.
```
- Append to the READY GATE (step 8, 13497):
```
 Before waiting for my go-ahead here, run \`cgremlin --agent-state $sn needs-input\`.
```
- In the bot-comment "unsure → STOP" bullet (13495) append:
```
 (run \`cgremlin --agent-state $sn needs-input\` first)
```
- Add a blocker line in the "Hard rules" area:
```
- If you hit something you cannot pass (preview never deploys, environment broken), run \`cgremlin --agent-state $sn blocked\` and tell me.
```

- [ ] **Step 4: Develop allowlist — add the verbs**

Change line 13511 to include the two verbs (append before the closing `]`):
```
,"Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"
```

- [ ] **Step 5: Review-agent allowlists — add the verbs**

So a PR discussion/triage agent can also declare `ready`, add both verbs to:
- bash `setup_output_files` allowlist (after `"Bash(cgremlin --request-changes-pr *)"`, ~2266): add `,"Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"` (mind the existing `$EXTRA_REPO_PERMS` concatenation — add before it).
- Python `PYSERVER` allow_list (~6196): add `"Bash(cgremlin --agent-state *)",` and `"Bash(cgremlin --agent-note *)",`.
- `create_review_agent_pane` both `add=` arrays (830 and 832): append `,"Bash(cgremlin --agent-state *)","Bash(cgremlin --agent-note *)"` inside each JSON array.

- [ ] **Step 6: Syntax checks (bash + Python)**

```bash
bash -n bin/cgremlin && echo "bash OK"
python3 - <<'PY'
import re,ast
s=open('bin/cgremlin').read()
m=re.search(r"<<'?PYSERVER'?\n(.*?)\nPYSERVER\n", s, re.S)
ast.parse(m.group(1)); print("python OK")
PY
```
Expected: `bash OK`, `python OK`.

- [ ] **Step 7: Generate briefs and confirm wiring**

```bash
awk '/^work_agent_tab_name\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/fns.sh
awk '/^write_investigate_brief\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin >> /tmp/fns.sh
awk '/^write_develop_brief\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin >> /tmp/fns.sh
D=$(mktemp -d)
bash -c '. /tmp/fns.sh; read_session_field(){ echo HB-1; }; write_investigate_brief "'"$D"'"'
command grep -c 'agent-state' "$D/CLAUDE.md"       # expect >=2
command grep -c 'agent-note'  "$D/CLAUDE.md"       # expect >=1
command grep -c 'ready'       "$D/.claude/settings.local.json"  # expect >=0 (allowlist has agent-state)
command grep -c 'agent-state' "$D/.claude/settings.local.json"  # expect 1
D2=$(mktemp -d)
bash -c '. /tmp/fns.sh; read_session_field(){ echo HB-2; }; write_develop_brief "'"$D2"'"'
command grep -c 'agent-state' "$D2/CLAUDE.md"      # expect >=3
command grep -c 'blocked'     "$D2/CLAUDE.md"      # expect >=1
command grep -c 'agent-state' "$D2/.claude/settings.local.json"  # expect 1
```
Expected: the counts in the comments (all satisfied).

- [ ] **Step 8: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: investigate/develop briefs declare attention state + note at gates; allowlist verbs"
```

---

### Task 6: Live smoke

**Non-destructive** to PR reviews; starts one investigate session in Mission Control.

**Files:** none (verification only).

- [ ] **Step 1: Restart Mission Control so the new code is live**

```bash
pkill -f 'cgremlin --watch-daemon'; pkill -f '.dashboard_server.py'
cgremlin --mission-control --fresh
# then ensure services (see prior runbook): start watch-daemon + dashboard if not up
```

- [ ] **Step 2: Start an investigation and watch the panel**

Via the orchestrator, pick up a ticket (e.g. "I'm investigating HB-XXXX"). Confirm:
- A new **`🔍 HB-XXXX` tab** appears (its own tab, not a tiled WORK pane).
- The status pane shows a **`── 🔨 Your work ──`** section with `🔍 HB-XXXX  🔄 working` and, once the agent notes it, a second line with the one-liner.
- When the agent hits a question it shows **⏸️ needs your input**; when it finishes FINDINGS.md, **✅ ready for review**.
- Clicking the row **jumps to the `🔍 HB-XXXX` tab**.

- [ ] **Step 3: Report** what worked and any gaps. No commit.

---

## Execution notes

- The status picker's Enter binding (Task 3 Step 4) and the promotion close-logic (Task 4 Step 3) are the two "locate then edit" points — both have exact grep commands; read the found code before editing.
- `jira.summary` is intentionally not fetched in automated paths — the agent-note (seeded from the ticket) is the reliable description; `jira.summary` is used only when already present (interactive sessions).
