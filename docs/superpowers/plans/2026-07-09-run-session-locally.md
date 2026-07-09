# Run a Session Locally (`cgremlin --run-local`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent command that brings a session's grace-frontend checkout up on the fixed local URL, single-instance, verifies the right server answers, and returns the URL — so an agent (or the user) can run live web evals on the change.

**Architecture:** All code in `bin/cgremlin`. New `run_local()`/`stop_local()` functions + `--run-local`/`--stop-local` dispatches; a `.local_run` state file tracks the single current owner; six `LOCAL_*`/`VERCEL_*` config vars (defaults = current grace-frontend values); the review/investigate/develop agent settings + briefs get the commands allow-listed. The dev server runs in the background, logging to the session's `logs/dev-server.log`.

**Tech Stack:** bash, `gh`/`vercel`/`pnpm`/`nvm`, `lsof`, `curl`, `jq`.

## Global Constraints

- All code in `bin/cgremlin`; after every change run `bash -n bin/cgremlin` (must pass). No unit-test framework — verification = `bash -n` + functional checks (build a throwaway session/state, call the function, assert output) + the gated live smoke. `grep -q` false-negatives on the 500KB+ script — use `command grep`.
- Only ONE session's app runs at a time (fixed hostname `local.findcare.dev.aplaceformom.com` + fixed port `8080`). Starting one stops whatever else owns the port, with a clear notice.
- Always use the URL with NO port (`https://local.findcare.dev.aplaceformom.com`) — `:8080` bypasses the 443 forward and breaks Clerk cookies.
- Env must exist BEFORE `pnpm install` (postinstall generates API types from `NEXT_PUBLIC_BACKEND_BASE_URL` in `.env.local`).
- Load nvm directly — `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` — NEVER `source ~/.zprofile` (gotcha G1). Never use the ambient node (system is v22; repo needs 24).
- Prereq failures STOP with an actionable message; NEVER auto-run the sudo/interactive `pnpm setup:local`.
- Config vars (defaults, overridable in `~/.cgremlin/config`): `LOCAL_URL=https://local.findcare.dev.aplaceformom.com`, `LOCAL_PORT=8080`, `LOCAL_DEV_CMD="pnpm dev"`, `VERCEL_SCOPE=grace-0118bc61`, `VERCEL_PROJECT=grace-frontend-dev`, `LOCAL_NODE_VERSION=24`.
- State file: `$SESSIONS_DIR/.local_run` = `{ "session": "<name>", "pid": <pid>, "started": "<iso>" }` — the single current local-run owner.
- **Execution gating:** Task 5 (live smoke) takes over port 8080 and may stop the user's own `~/Projects` dev server — do NOT run it without the user's explicit go-ahead, UNLESS the user has said this session is the autonomous main implementer.
- Do not commit/push git unless asked; these "commit" steps are cgremlin working-tree commits on branch `mission-control-pr-orchestrator`. Reuse existing helpers: `read_session_field`, `update_session_field`, `load_config`, `save_config`.

---

### Task 1: Config vars (`LOCAL_*` / `VERCEL_*`)

**Files:**
- Modify: `bin/cgremlin` — `load_config()` case arms (~line 45-52) + a defaults block right after the case loop; `save_config()` heredoc (~line 76).

**Interfaces:**
- Produces: shell vars `LOCAL_URL`, `LOCAL_PORT`, `LOCAL_DEV_CMD`, `VERCEL_SCOPE`, `VERCEL_PROJECT`, `LOCAL_NODE_VERSION` — set from `~/.cgremlin/config` when present, else defaults. Consumed by Tasks 2-3.

- [ ] **Step 1: Failing check**

```bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null
echo "URL=[$LOCAL_URL] PORT=[$LOCAL_PORT] DEV=[$LOCAL_DEV_CMD] SCOPE=[$VERCEL_SCOPE] PROJ=[$VERCEL_PROJECT] NODE=[$LOCAL_NODE_VERSION]"
```
Expected before: all empty.

- [ ] **Step 2: Add case arms in `load_config`**

After the existing `GITHUB_ME) GITHUB_ME="$value" ;;` arm, add:
```bash
                LOCAL_URL) LOCAL_URL="$value" ;;
                LOCAL_PORT) LOCAL_PORT="$value" ;;
                LOCAL_DEV_CMD) LOCAL_DEV_CMD="$value" ;;
                VERCEL_SCOPE) VERCEL_SCOPE="$value" ;;
                VERCEL_PROJECT) VERCEL_PROJECT="$value" ;;
                LOCAL_NODE_VERSION) LOCAL_NODE_VERSION="$value" ;;
```

- [ ] **Step 3: Add defaults right AFTER the `done < "$CONFIG_FILE"` of the read loop (inside `load_config`, so file values win and defaults fill gaps)**

```bash
    : "${LOCAL_URL:=https://local.findcare.dev.aplaceformom.com}"
    : "${LOCAL_PORT:=8080}"
    : "${LOCAL_DEV_CMD:=pnpm dev}"
    : "${VERCEL_SCOPE:=grace-0118bc61}"
    : "${VERCEL_PROJECT:=grace-frontend-dev}"
    : "${LOCAL_NODE_VERSION:=24}"
```

- [ ] **Step 4: Add to `save_config` heredoc (after the `USE_ZELLIJ="$USE_ZELLIJ"` line)**

```bash

# Local-run: app URL, port, dev command, Vercel scope/project, Node version
LOCAL_URL="$LOCAL_URL"
LOCAL_PORT="$LOCAL_PORT"
LOCAL_DEV_CMD="$LOCAL_DEV_CMD"
VERCEL_SCOPE="$VERCEL_SCOPE"
VERCEL_PROJECT="$VERCEL_PROJECT"
LOCAL_NODE_VERSION="$LOCAL_NODE_VERSION"
```

- [ ] **Step 5: Verify**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
source bin/cgremlin --lib-only 2>/dev/null
echo "URL=[$LOCAL_URL] PORT=[$LOCAL_PORT] DEV=[$LOCAL_DEV_CMD] SCOPE=[$VERCEL_SCOPE] PROJ=[$VERCEL_PROJECT] NODE=[$LOCAL_NODE_VERSION]"
```
Expected: `BASH OK`, then `URL=[https://local.findcare.dev.aplaceformom.com] PORT=[8080] DEV=[pnpm dev] SCOPE=[grace-0118bc61] PROJ=[grace-frontend-dev] NODE=[24]`.

- [ ] **Step 6: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: LOCAL_*/VERCEL_* config vars for run-local

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: State helpers, prereq check, and `stop_local`

**Files:**
- Modify: `bin/cgremlin` — add functions near `pr_threads` (~line 367); add `--stop-local` dispatch near `--pr-threads` (~line 12971) + to the dashboard-skip guard (~line 12983).

**Interfaces:**
- Consumes: config vars from Task 1; `read_session_field`, `$SESSIONS_DIR`.
- Produces:
  - `_local_run_file` → prints the state file path (`$SESSIONS_DIR/.local_run`).
  - `_local_run_owner` → prints the currently-recorded owner session name (empty if none).
  - `_local_prereqs` → returns 0 if all machine prereqs pass, else prints an actionable message to stderr and returns 1. Does NOT modify anything.
  - `stop_local [SESSION]` → kills the tracked dev-server pid (if any / if it matches SESSION) and clears the state file; prints what it stopped.
  - `--stop-local [session]` dispatch.

- [ ] **Step 1: Failing check**

```bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null
type _local_prereqs stop_local _local_run_owner 2>&1 | head -3
```
Expected: "not found" for each.

- [ ] **Step 2: Implement the helpers (add after `pr_threads`, ~line 367)**

```bash
# Path to the single-owner local-run state file.
_local_run_file() { echo "$SESSIONS_DIR/.local_run"; }
# The session currently running locally (empty if none).
_local_run_owner() { jq -r '.session // empty' "$(_local_run_file)" 2>/dev/null; }

# Verify machine prerequisites for local run. Actionable message + return 1 on
# any failure; never modifies the machine (esp. never runs sudo/setup:local).
# Usage: _local_prereqs
_local_prereqs() {
    grep -q 'local.findcare.dev.aplaceformom.com' /etc/hosts 2>/dev/null \
        || { echo "PREREQ: /etc/hosts is missing the dev domain. Run 'pnpm setup:local' in the repo, with you present (needs sudo)." >&2; return 1; }
    [ -f /Library/LaunchDaemons/com.grace.portforward.plist ] \
        || { echo "PREREQ: the 443→8080 port-forward daemon is missing. Run 'pnpm setup:local' in the repo, with you present (needs sudo)." >&2; return 1; }
    [ -n "$NODE_AUTH_TOKEN" ] \
        || { echo "PREREQ: NODE_AUTH_TOKEN is not set (needed for @aplaceformom/* packages). Export a GitHub PAT with read:packages (the gh oauth token lacks that scope)." >&2; return 1; }
    [ -s "$HOME/.nvm/nvm.sh" ] \
        || { echo "PREREQ: nvm not found at ~/.nvm/nvm.sh (needed for Node $LOCAL_NODE_VERSION)." >&2; return 1; }
    ( export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm which "$LOCAL_NODE_VERSION" >/dev/null 2>&1 ) \
        || echo "NOTE: Node $LOCAL_NODE_VERSION not installed under nvm; run_local will 'nvm install $LOCAL_NODE_VERSION' (this changes nvm's default alias)." >&2
    ( vercel whoami >/dev/null 2>&1 ) \
        || { echo "PREREQ: not logged into Vercel. Run 'vercel login'." >&2; return 1; }
    return 0
}

# Stop the tracked local dev server and clear state.
# Usage: stop_local [SESSION]   (SESSION optional; if given, only stops when it is the current owner)
stop_local() {
    local want="$1" f owner pid
    f=$(_local_run_file); owner=$(_local_run_owner)
    [ -z "$owner" ] && { echo "no session is running locally"; return 0; }
    if [ -n "$want" ] && [ "$want" != "$owner" ]; then
        echo "local run is owned by '$owner', not '$want' — nothing stopped"; return 0
    fi
    pid=$(jq -r '.pid // empty' "$f" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
    # pnpm dev spawns children (next). Also free the port if anything lingers.
    local lport; lport=$(lsof -t -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null)
    [ -n "$lport" ] && kill "$lport" 2>/dev/null || true
    rm -f "$f"
    echo "stopped local run for '$owner' (pid ${pid:-?})"
}
```

- [ ] **Step 3: Add the `--stop-local` dispatch (after the `--pr-threads` dispatch, ~line 12971)**

```bash
if [ "$1" = "--stop-local" ]; then stop_local "$2"; exit $?; fi
```
And add `[ "$1" != "--stop-local" ]` to the dashboard-skip guard `if` (~line 12983).

- [ ] **Step 4: Verify (functional; no machine mutation)**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"; SESSIONS_DIR="$root"
echo "owner (none): [$(_local_run_owner)]"
printf '{"session":"dev-x","pid":999999,"started":"t"}' > "$root/.local_run"
echo "owner: [$(_local_run_owner)]"
stop_local dev-y     # wrong owner → nothing stopped
stop_local dev-x     # matches → stops + clears (pid 999999 not real; kill is a no-op)
echo "after stop, owner: [$(_local_run_owner)]"
_local_prereqs && echo "PREREQS PASS" || echo "PREREQS FAIL (expected only if a real prereq is missing)"
command grep -q '"\$1" = "--stop-local"' bin/cgremlin && echo "DISPATCH OK"
command grep -q '!= "--stop-local"' bin/cgremlin && echo "GUARD OK"
rm -rf "$root"
```
Expected: `BASH OK`; `owner (none): []`; `owner: [dev-x]`; wrong-owner message; stop message; `after stop, owner: []`; `PREREQS PASS` (this machine satisfies them per the design check — hosts, portforward, NODE_AUTH_TOKEN, nvm, vercel all present); `DISPATCH OK`; `GUARD OK`.

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: local-run state helpers, prereq check, stop_local

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `run_local` — setup, single-instance, launch, verify

**Files:**
- Modify: `bin/cgremlin` — add `run_local()` after `stop_local` (~line 367 area); add `--run-local` dispatch near `--stop-local` + to the dashboard-skip guard.

**Interfaces:**
- Consumes: Task 1 config vars; Task 2 `_local_prereqs`, `_local_run_file`, `_local_run_owner`, `stop_local`; `read_session_field`.
- Produces: `run_local SESSION [--fresh]` → brings the session's app up (idempotently), single-instance, verifies, records the owner, prints the URL. `--run-local <session> [--fresh]` dispatch.

- [ ] **Step 1: Failing check**

```bash
cd /Users/guilherme.azoubel/context-gremlin
source bin/cgremlin --lib-only 2>/dev/null; type run_local 2>&1 | head -1
```
Expected: "not found".

- [ ] **Step 2: Implement `run_local`**

Add after `stop_local`:
```bash
# Bring a session's grace-frontend app up on the fixed local URL, single-instance,
# and verify the RIGHT server answers. Idempotent. Prints the URL on success.
# Usage: run_local SESSION [--fresh]
run_local() {
    local sn="$1" fresh="$2"
    local SDIR="$SESSIONS_DIR/$sn" REPO="$SESSIONS_DIR/$sn/repo"
    [ -d "$REPO" ] || { echo "ERROR: repo missing for session '$sn'" >&2; return 1; }
    grep -q '"'"$LOCAL_DEV_CMD"'"\|"dev"' "$REPO/package.json" 2>/dev/null \
        || { echo "ERROR: $REPO is not a runnable checkout (no dev script)" >&2; return 1; }
    mkdir -p "$SDIR/logs"
    local log="$SDIR/logs/dev-server.log"

    # 1) Machine prereqs (actionable STOP if missing).
    _local_prereqs || return 1

    # 2) Load nvm + Node (never the ambient node).
    export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null
    nvm which "$LOCAL_NODE_VERSION" >/dev/null 2>&1 || nvm install "$LOCAL_NODE_VERSION" >/dev/null 2>&1
    nvm use "$LOCAL_NODE_VERSION" >/dev/null 2>&1 || { echo "ERROR: could not select Node $LOCAL_NODE_VERSION via nvm" >&2; return 1; }

    # 3) Per-checkout setup (env BEFORE install). Fast path if already set up.
    if [ "$fresh" = "--fresh" ] || [ ! -f "$REPO/.env.local" ] || [ ! -d "$REPO/node_modules" ] || ! ls "$REPO"/packages/grace-api/src/generated/* >/dev/null 2>&1; then
        ( cd "$REPO" && vercel link --yes --scope "$VERCEL_SCOPE" --project "$VERCEL_PROJECT" >/dev/null 2>&1 ) \
            || { echo "ERROR: vercel link failed (scope $VERCEL_SCOPE / project $VERCEL_PROJECT)" >&2; return 1; }
        ( cd "$REPO" && vercel env pull .env.local >/dev/null 2>&1 ) \
            || { echo "ERROR: vercel env pull failed" >&2; return 1; }
        local nvars; nvars=$(grep -c '=' "$REPO/.env.local" 2>/dev/null || echo 0)
        [ "$nvars" -gt 0 ] || { echo "ERROR: .env.local came back empty" >&2; return 1; }
        echo "pulled .env.local ($nvars vars); installing…"
        ( cd "$REPO" && pnpm install > "$log.install" 2>&1 ) || { echo "ERROR: pnpm install failed — see $log.install" >&2; return 1; }
        if grep -qi 'Could not generate API types\|Warning: Could not generate' "$log.install" 2>/dev/null; then
            echo "ERROR: dev backend unreachable — API types not generated; the app won't run correctly. See $log.install" >&2; return 1
        fi
    fi

    # 4) Single-instance: free the port.
    local listener owner_cwd
    listener=$(lsof -t -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
    if [ -n "$listener" ]; then
        owner_cwd=$(lsof -p "$listener" 2>/dev/null | awk '$4=="cwd"{print $NF}' | head -1)
        if [ "$owner_cwd" = "$REPO" ] && curl -sk -o /dev/null -w '%{http_code}' "$LOCAL_URL/" 2>/dev/null | grep -q '^2'; then
            echo "already running for '$sn' at $LOCAL_URL"; return 0
        fi
        echo "port $LOCAL_PORT was held by: ${owner_cwd:-unknown} — stopping it."
        case "$owner_cwd" in "$HOME/Projects/"*) echo "  (that looks like YOUR own dev server — restart it when you're done here.)";; esac
        kill "$listener" 2>/dev/null; sleep 2
    fi

    # 5) Launch in the background.
    ( cd "$REPO" && export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use "$LOCAL_NODE_VERSION" >/dev/null 2>&1; nohup $LOCAL_DEV_CMD > "$log" 2>&1 & echo $! > "$SDIR/.dev_pid" )
    local pid; pid=$(cat "$SDIR/.dev_pid" 2>/dev/null); rm -f "$SDIR/.dev_pid"
    printf '{"session":"%s","pid":%s,"started":"%s"}\n' "$sn" "${pid:-0}" "$(date -Iseconds)" > "$(_local_run_file)"

    # 6) Wait + verify the RIGHT server answers (cwd == this repo AND 200).
    local i code vcwd vpid
    for i in $(seq 1 45); do
        code=$(curl -sk -o /dev/null -w '%{http_code}' "$LOCAL_URL/" 2>/dev/null)
        if [ "$code" = "200" ]; then
            vpid=$(lsof -t -nP -iTCP:"$LOCAL_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
            vcwd=$(lsof -p "$vpid" 2>/dev/null | awk '$4=="cwd"{print $NF}' | head -1)
            [ "$vcwd" = "$REPO" ] && { echo "✅ running for '$sn' at $LOCAL_URL (log: $log)"; return 0; }
        fi
        sleep 2
    done
    echo "ERROR: $LOCAL_URL did not come up as '$sn' within ~90s. Last log lines:" >&2
    tail -20 "$log" >&2
    return 1
}
```

- [ ] **Step 3: Add the `--run-local` dispatch (after `--stop-local`) + guard**

```bash
if [ "$1" = "--run-local" ]; then [ -z "$2" ] && { echo "Usage: cgremlin --run-local <session> [--fresh]" >&2; exit 1; }; run_local "$2" "$3"; exit $?; fi
```
Add `[ "$1" != "--run-local" ]` to the dashboard-skip guard `if`.

- [ ] **Step 4: Verify syntax + dispatch (NOT a live launch — that's Task 5, gated)**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
command grep -q '"\$1" = "--run-local"' bin/cgremlin && echo "DISPATCH OK"
command grep -q '!= "--run-local"' bin/cgremlin && echo "GUARD OK"
# Guard behavior: a bogus session errors cleanly (no launch, no prereq side effects)
source bin/cgremlin --lib-only 2>/dev/null
run_local "no-such-session" 2>&1 | head -1   # expect: ERROR: repo missing for session 'no-such-session'
```
Expected: `BASH OK`, `DISPATCH OK`, `GUARD OK`, and the repo-missing error.

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: run_local — setup, single-instance, launch, verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Agent integration (allow-list + brief lines)

**Files:**
- Modify: `bin/cgremlin` — the three agent settings allow-lists and their briefs: the review-triage + mine-triage allow-lists in `create_review_agent_pane` (~line 690-692), the investigate brief settings (`write_investigate_brief`, ~line 13184), the develop brief settings (`write_develop_brief`). Add brief lines in the review CTX, investigate, and develop briefs.

**Interfaces:**
- Consumes: `--run-local`/`--stop-local` from Tasks 2-3.
- Produces: those agents can run `cgremlin --run-local <session>` / `--stop-local <session>` and are told how to use it for live web evals.

- [ ] **Step 1: Add `--run-local`/`--stop-local` to the three allow-lists**

In `create_review_agent_pane`, both `add='[...]'` branches (mine at ~690, review at ~692): append `,"Bash(cgremlin --run-local *)","Bash(cgremlin --stop-local *)"` inside the JSON array.
In `write_investigate_brief`'s settings line (~13184): change the allow array to include `"Bash(cgremlin --run-local *)","Bash(cgremlin --stop-local *)"` alongside `"Bash(cgremlin --develop *)"`.
In `write_develop_brief`'s settings line: append the same two entries to its allow array.

- [ ] **Step 2: Add a brief line to review CTX, investigate, and develop briefs**

Add this line (adjust `$(basename "$SDIR")` / `$sn` to match each brief's existing variable) to each brief, in a sensible spot (review CTX near its constraints; investigate near its "explore" step; develop's step 5 preview-verification):

```
For live web evals, run \`cgremlin --run-local $(basename "$SDIR")\` and wait for the URL, then drive the browser (chrome-devtools MCP) against https://local.findcare.dev.aplaceformom.com/ . Watch logs/dev-server.log and tell me if it fails. When done, \`cgremlin --stop-local $(basename "$SDIR")\`.
```
(In `write_develop_brief` the session var is `$sn`, so use `cgremlin --run-local $sn` there.)

- [ ] **Step 3: Verify**

```bash
cd /Users/guilherme.azoubel/context-gremlin
bash -n bin/cgremlin && echo "BASH OK"
command grep -c 'Bash(cgremlin --run-local \*)' bin/cgremlin | xargs echo "run-local allowlist entries (expect >=4: mine, review, investigate, develop):"
command grep -c 'cgremlin --run-local' bin/cgremlin | xargs echo "total run-local references (allowlists + brief lines):"
# Render a develop brief and confirm the line is present
source bin/cgremlin --lib-only 2>/dev/null
root=$(mktemp -d); export CGREMLIN_SESSIONS_DIR="$root"; SESSIONS_DIR="$root"
mkdir -p "$root/dev-y/repo"; printf '{"mode":"development","jira":{"ticket":"HB-1"}}' > "$root/dev-y/session.json"
write_develop_brief "$root/dev-y"
grep -q 'cgremlin --run-local' "$root/dev-y/CLAUDE.md" && echo "DEV BRIEF has run-local"
grep -q '"Bash(cgremlin --run-local \*)"' "$root/dev-y/.claude/settings.local.json" && echo "DEV PERMS have run-local"
rm -rf "$root"
```
Expected: `BASH OK`; ≥4 allowlist entries; `DEV BRIEF has run-local`; `DEV PERMS have run-local`.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: allow-list + brief run-local/stop-local for review/investigate/develop agents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: GATED live smoke (requires user go-ahead)

**Do NOT run this task without the user's explicit go-ahead**, unless the user has stated this session is the autonomous main implementer. It takes over port 8080 and may stop the user's own `~/Projects/grace-frontend` dev server.

**Files:** none (verification only).

- [ ] **Step 1: Confirm go-ahead**

If not pre-authorized, ask the controller to confirm before running. If the user's own dev server is on 8080, note it will be stopped (and they'll need to restart it).

- [ ] **Step 2: Live run against a real ready session**

```bash
cd /Users/guilherme.azoubel/context-gremlin
sn=$(ls -d ~/.cgremlin/sessions/pr-grace-frontend-* 2>/dev/null | head -1 | xargs basename)
echo "smoke session: $sn"
time bin/cgremlin --run-local "$sn"
echo "--- verify ---"
cat ~/.cgremlin/sessions/.local_run
lsof -nP -iTCP:8080 -sTCP:LISTEN 2>/dev/null | head -2
curl -sk -o /dev/null -w 'HTTP %{http_code}\n' https://local.findcare.dev.aplaceformom.com/
echo "--- stop ---"
bin/cgremlin --stop-local "$sn"
cat ~/.cgremlin/sessions/.local_run 2>/dev/null || echo "(state cleared)"
```
Expected: `run_local` prints `✅ running for '<sn>' at https://local.findcare.dev.aplaceformom.com`; `.local_run` shows that session; the 8080 listener's cwd is that session's repo; `curl` returns `HTTP 200`; `--stop-local` stops it and clears state.

- [ ] **Step 3: Report** the timing and any prereq/backend issues to the user. No commit (verification only).

---

## Notes for the executor

- Tasks 1-4 are safe (no live launch). Task 5 is the only one that runs the app; keep it gated.
- The machine already satisfies the prereqs (hosts, port-forward, NODE_AUTH_TOKEN, nvm, vercel) per the spec's design check — so `_local_prereqs` should pass; if it doesn't on the executor's machine, that's a real environment gap to report, not a code bug.
- `vercel env pull` + `pnpm install` in Task 5 can take a few minutes on a cold checkout (that's the point of the fast-path skip on re-runs).
