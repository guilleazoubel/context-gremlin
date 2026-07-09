# Run a Session Locally (for live web evals) Design

**Date:** 2026-07-09
**Status:** Draft
**Builds on:** the cgremlin session model (`~/.cgremlin/sessions/<id>/repo`), the review/investigate/develop agents, and their per-session `CLAUDE.md` briefs.

---

## Problem

To validate a change in a real browser, an agent (or the user) must run the actual grace-frontend app from a session's checkout. Doing it by hand is a ~5-minute, error-prone dance: pull dev env, install in the right order, select Node 24, free port 8080, launch on a fixed local URL (not localhost:port), and confirm the *right* server is answering. The app can only run **one at a time** (fixed hostname `local.findcare.dev.aplaceformom.com` + fixed port `8080`, required by Clerk production-mode keys — not localhost:port). We want a single command that brings any session's app up reliably and verifiably, so an agent can then do live web evals on the changes.

A proven manual runbook exists (`LOCAL_RUN_GUIDE.md` in an earlier session); this design distills its reusable core (its Parts 1–4) into a command. The feature-specific browser choreography (its Part 5) and the chrome-devtools eval flow are out of scope — those are the agent's job once the app is up.

---

## Goals

1. **One idempotent command** — `cgremlin --run-local <session>` — brings that session's app up on `https://local.findcare.dev.aplaceformom.com/` and verifies it, or fails with an actionable message.
2. **Agent-invokable** — allow-listed so the review/investigate/develop agents run it before live web evals; the user can run it too.
3. **Single-instance** — only one session's app runs at a time; starting one cleanly stops whatever else owns port 8080 (with a clear notice), and the owner is tracked.
4. **Background + logfile** — the dev server runs in the background, logs to the session's `logs/dev-server.log`; the agent watches it and reports issues. (A future `--pane` that tails the log in a Mission Control pane must be easy to add — the logfile makes it so.)
5. **Verify the RIGHT server** — a stale server on 8080 serves the same URL and looks healthy; success requires the 8080 listener's cwd to be this session's repo AND a 200 on the URL.
6. **Fail fast on missing machine prereqs** with guidance — never silently proceed or script around sudo/interactive setup.

---

## Non-goals (later)

- The chrome-devtools eval choreography and feature-specific dev-console tricks (runbook Part 5).
- A log-tailing Mission Control pane (`--pane`) — designed-for, not built now.
- Headless checks against the **preview** environment (a separate idea).
- localhost:port multi-instance (the app uses a fixed dev domain; revisit only if the app gains a localhost mode).

---

## Command: `cgremlin --run-local <session> [--fresh]`

Runs in this order; each step fails fast with a clear message.

### 1. Resolve + validate
- `SDIR = $SESSIONS_DIR/<session>`, `REPO = $SDIR/repo`. Must exist and be a grace-frontend checkout (its `package.json` has the configured dev script). Else error.

### 2. Verify machine prerequisites (actionable; do NOT auto-run sudo/interactive steps)
- **Dev domain + port-forward:** `/etc/hosts` has `local.findcare.dev.aplaceformom.com` AND `/Library/LaunchDaemons/com.grace.portforward.plist` exists. If either is missing → STOP: "run `pnpm setup:local` in the repo, with you present (needs sudo)."
- **GitHub Packages auth:** `$NODE_AUTH_TOKEN` non-empty (for `@aplaceformom/*`). If missing → STOP: "export a GitHub PAT with `read:packages` as NODE_AUTH_TOKEN (the gh oauth token lacks that scope)."
- **Vercel auth:** `vercel whoami` succeeds. Else → STOP: "run `vercel login`."
- **Node 24 via nvm:** load nvm directly — `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"` (NOT `source ~/.zprofile`, gotcha G1) — then `nvm ls 24 || nvm install 24` and `nvm use 24`. If `nvm install` runs, warn that it changes nvm's default alias. Never use the ambient node.

### 3. Per-checkout setup (env BEFORE install)
Fast path: if `$REPO/.env.local` exists AND `$REPO/node_modules` is populated AND generated API types exist (`packages/grace-api/src/generated/` non-empty), SKIP this step (fast re-run). `--fresh` forces it to run.

Otherwise:
- `cd $REPO && vercel link --yes --scope <VERCEL_SCOPE> --project <VERCEL_PROJECT>`
- `vercel env pull .env.local`; sanity-check it has a plausible var count (>0; warn if suspiciously low).
- `pnpm install`. The postinstall generates API types from `NEXT_PUBLIC_BACKEND_BASE_URL` in `.env.local` (that's why env must exist first). If the output shows "Could not generate API types" / the dev backend is unreachable → STOP and report (gotcha G5); the app won't typecheck/run correctly.

### 4. Single-instance: free port 8080
- Inspect the listener on 8080. If one exists, resolve its owning cwd via `lsof`.
  - If it's already **this** session's repo AND healthy (curl 200) → the app is already up; skip to reporting success (idempotent).
  - Else (another checkout — possibly the user's own `~/Projects/grace-frontend` dev server, gotcha G2) → stop it (kill the PID) and **report exactly which checkout was stopped**, plus: "if that was your own dev server, restart it when you're done here."
- Record the new owner in `$SESSIONS_DIR/.local_run` (JSON: `{ "session": "<name>", "pid": <pid>, "started": "<iso>" }`).

### 5. Launch (background) + mandatory verify
- `cd $REPO`, ensure `nvm use 24` is in effect, `nohup pnpm dev > $SDIR/logs/dev-server.log 2>&1 &`; record the launched PID into `.local_run`.
- Poll up to ~90s: success = a 200 from `curl -sk https://local.findcare.dev.aplaceformom.com/` **AND** the 8080 listener's cwd == `$REPO` (defeats the stale-server trap). 
- On timeout/failure → STOP and report with the last ~20 lines of `dev-server.log`.
- On success → print: the URL, "running for `<session>`", and the logfile path.

Always use `https://local.findcare.dev.aplaceformom.com` (no `:8080` — that bypasses the 443 forward and breaks Clerk cookies).

---

## Companion: `cgremlin --stop-local [<session>]`

- With no arg (or matching the recorded owner): kill the tracked dev-server PID from `.local_run` and clear the file. With a session arg: stop that session's server if it's the current owner.
- Reports what was stopped. Does NOT auto-restart the user's `~/Projects` server (the user restarts it themselves; `--run-local` already reminded them when it stopped theirs).

---

## Configuration (defaults = current grace-frontend values; overridable in `~/.cgremlin/config`)

- `LOCAL_URL="https://local.findcare.dev.aplaceformom.com"`
- `LOCAL_PORT="8080"`
- `LOCAL_DEV_CMD="pnpm dev"`
- `VERCEL_SCOPE="grace-0118bc61"`
- `VERCEL_PROJECT="grace-frontend-dev"`
- `LOCAL_NODE_VERSION="24"`

These keep the command from being hardcoded to one repo layout while defaulting to what works today.

---

## Agent integration

- Allow-list `Bash(cgremlin --run-local *)` and `Bash(cgremlin --stop-local *)` in the review, investigate, and develop agent settings.
- Add one line to those briefs: "For live web evals, first run `cgremlin --run-local <session>` and wait for the URL; then drive the browser (chrome-devtools MCP) against `https://local.findcare.dev.aplaceformom.com/`. Watch `logs/dev-server.log` and tell me if it fails. When done, `cgremlin --stop-local <session>`."
- The develop brief's preview-verification step can additionally (or alternatively) use local run for pre-PR checks; keep the existing preview-URL path too.

---

## State + status

- `$SESSIONS_DIR/.local_run` tracks the single current owner (session, pid, started).
- The status pane MAY show a small `▶ local` marker on whichever session currently owns the local run (cheap, helps single-instance awareness). Minimal; not required for v1.

---

## Error handling (summary of the actionable STOPs)

| Condition | Action |
|---|---|
| hosts/port-forward missing | STOP → run `pnpm setup:local` with the user (sudo) |
| `NODE_AUTH_TOKEN` missing | STOP → export a `read:packages` PAT |
| not logged into Vercel | STOP → `vercel login` |
| Node 24 unavailable | `nvm install 24` (warn about default-alias change) |
| dev backend unreachable (type-gen fails) | STOP → report; do not run a miscompiled app |
| port 8080 owned by another checkout | stop it, report which, remind user to restart theirs |
| ready/verify times out | STOP → report with tail of `dev-server.log` |

---

## Files changed

`bin/cgremlin` only:
- New: `run_local()` + `--run-local` dispatch; `stop_local()` + `--stop-local` dispatch; both added to the dashboard-skip guard.
- New: the six `LOCAL_*`/`VERCEL_*` config vars in `load_config`/`save_config` with defaults.
- Modified: review/investigate/develop agent settings allow-lists + brief lines.
- Verify: `bash -n bin/cgremlin`; live smoke of `--run-local` against a real session (machine prereqs are already satisfied here per the design check).
