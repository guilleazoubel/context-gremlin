# Manual smoke checklist — cgremlin VS Code extension v1

This is spec §8 (`cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase7-vscode-ui-v1-design.md`)
turned into a runbook. It is **manual on purpose**: there is no Electron harness in this package,
and step 4 — a real `claude --resume` against an engine-produced transcript — is the one assumption
in the phase that only a live run can prove.

Everything automatable is already automated in `test/integration/real-engine.test.ts`, which drives
the same client layer against a real engine on a temp socket. What is left here is the editor
surface (tree, modal, folder swap, terminal) and the two paths that need a real `gh` and a real
agent (`POST /reviews`, and the agent runs in steps 4, 7 and 8).

Record the result in the table at the bottom and commit it on the phase branch.

---

## 0. Setup (once)

The smoke state dir is **`~/.cgremlin-core-smoke`** — never `~/.cgremlin`, which is the legacy
tool's state and must not be touched, and never the real default `~/.cgremlin-core` either.

The extension carries the engine. There is nothing to put on `PATH`, nothing to start by hand, and
no socket setting: **install the `.vsix`, or press F5.**

```sh
cd cgremlin/vscode && pnpm install
pnpm package     # builds ../core's engine bundles, compiles the extension, writes the .vsix
code --install-extension cgremlin-vscode-0.0.1.vsix
```

or, to smoke a working tree instead of an installed build: open **`cgremlin/vscode`** (that folder,
not the repo root) in VS Code and press **F5** — `.vscode/launch.json` builds first (engine bundles
included) and launches an Extension Development Host with `--extensionDevelopmentPath` on this
package.

In the window under test, set **one** setting, and only because this is a smoke run against a
throwaway state dir rather than your real one:

```jsonc
{
  "cgremlin.configPath": "~/.cgremlin-core-smoke/core.json"
}
```

`cgremlin.notificationLevel` (default `all`) is the only other setting there is. **The socket
setting is gone** — the socket, the log, the pid file, `sessions/` and `worktrees/` are all derived
from `core.json`'s `stateDir` by the engine's own loader.

- [ ] `~/.cgremlin-core-smoke/core.json` exists and its `stateDir` is `~/.cgremlin-core-smoke`. If
      it does **not** exist, do not create it by hand — that is step 12's first-run test.
- [ ] Within a few seconds of the window opening, the engine is running and the panel populates:
      `~/.cgremlin-core-smoke/engine.sock`, `engine.json` and `engine.log` all exist.

```sh
ls -la ~/.cgremlin-core-smoke      # engine.sock, engine.json, engine.log
cat ~/.cgremlin-core-smoke/engine.json   # {pid, version, socketPath, startedAt}
tail -f ~/.cgremlin-core-smoke/engine.log
```

- [ ] `ls -la ~/.cgremlin` is unchanged by all of the above (or still absent) — nothing in this
      phase reads or writes the legacy state dir.

Throughout, `$S` means `~/.cgremlin-core-smoke` and `<id>` a session id from
`cgremlin-core sessions --json --config $S/core.json`. (`cgremlin-core` on `PATH` is only needed
for these cross-checks, never by the extension: `export PATH="$PWD/../core/bin:$PATH"`.)

---

## 1. The engine commands

- [ ] **`cgremlin: Stop the engine`** asks first, in a confirmation that names the shared-daemon
      fact and the **number of running items** — then the status bar reads `cgremlin: offline` and
      `$S/engine.sock` and `$S/engine.json` are both gone.
- [ ] Dismissing that confirmation stops nothing.
- [ ] **`cgremlin: Start the engine`** brings it back; within ~2 s the panel populates and the
      status bar shows `N need you`. No terminal is opened at any point.
- [ ] **`cgremlin: Restart the engine`** — the status bar passes through `starting…`, and
      `engine.json`'s `pid`/`startedAt` both change.
- [ ] **`cgremlin: Show the engine log`** reveals the cgremlin output channel and offers to open
      `$S/engine.log`.
- [ ] Open a **second** window on the same `configPath`: it adopts the running engine — no second
      pid, `engine.json` unchanged, one boot's worth of output in the log. **Close** that window:
      the engine keeps running (it is shared; closing a window never stops it).
- [ ] With the engine stopped, `rm -f $S/engine.sock` is **not** needed and a leftover stale socket
      recovers on its own — the extension never unlinks a socket.

## 2. Four lists

Compare each list against the engine's own answers:

```sh
cgremlin-core prs --config $S/core.json
cgremlin-core sessions --json --config $S/core.json
```

- [ ] **Parking lot** = `groups.unreviewed`.
- [ ] **PRs we are reviewing** = every non-terminal `review` session (not `groups.ours` — an
      off-config PR has no inventory row at all; see step 8).
- [ ] **Investigations** and **My dev work**: every non-terminal investigation/development session
      appears exactly **once**, plus my own open PRs under dev work.

## 3. Notification

- [ ] With an investigation mid-turn: `printf needs-input > $S/sessions/<id>/AGENT_STATE`.
- [ ] A popup appears within ~2 s, titled `<title> — needs_input`, with `Open` and `Ack`.
- [ ] `Open` reveals and selects that row; the row shows `⏸️`.
- [ ] A row that is **not** needs-you (a parking-lot PR appearing, say) raises **no** popup.

## 4. Chat — the one thing only a live run can prove

Pick a session whose `agent.resumeId` is non-null
(`cgremlin-core sessions --json --config $S/core.json | grep resumeId`).

- [ ] Click **Chat** on that row → a terminal opens whose cwd is the session's **worktree** and
      whose first command is `claude --resume '<resumeId>'`.
- [ ] The prior turn's context is present — this is the assumption under test. If the transcript
      does **not** resume, stop: R4 (the chat mechanism) has to be re-opened, not shipped.
- [ ] While the terminal is open, `curl --unix-socket $S/engine.sock -XPOST http://x/sessions/<id>/run -H 'content-type: application/json' -d '{"stage":"develop"}'`
      answers **409** `a human holds the agent conversation`.
- [ ] Closing the terminal releases the claim: the same POST then no longer 409s
      (`cgremlin-core sessions --config $S/core.json` shows the `claimed` column empty).

R20's four recovery paths, by hand:

- [ ] Leave the terminal open past one `humanTurnTtlMs` (default 600 000 ms; lower it in `core.json`
      and restart the engine to make this quick) → the claim is **still** held: the heartbeat
      (TTL/3) renewed it.
- [ ] `kill -9` the extension host (or close the window) with a claim held → the claim lapses
      within one TTL, and the POST above then succeeds.
- [ ] Restart the engine with a claim in place → its stderr logs `conversation.claims_cleared`.
- [ ] `cgremlin-core sessions --config $S/core.json` shows a `claimed` column, and
      `cgremlin-core release --config $S/core.json <id>` clears it.

## 5. Preview + worktree

- [ ] Click a session row → its **primary artifact** opens as a rendered markdown preview, and the
      worktree becomes **the** workspace folder **without** the window reloading (given the managed
      workspace is already open — see step 6).
- [ ] Append a line to that artifact from a shell → the preview updates with no click.
- [ ] Click a **different** session → the folder swaps: exactly one folder in the explorer, the
      previous folder's editors close, and the status bar names the new session id and phase.
- [ ] Dirty-editor case: edit a file in the current worktree **without saving**, then click a
      different session → a **modal** appears first
      (`Switching to '<id>' closes the editors of the current worktree…`).
  - [ ] Dismissing it leaves the folder and the unsaved buffer untouched — **and still opens the
        preview**.
  - [ ] Accepting (`Switch anyway`) swaps as above.

## 6. Managed workspace bootstrap

- [ ] From a plain single-folder window, click a row → the extension **offers** to open
      `$S/cgremlin.code-workspace`.
- [ ] Declining leaves the window untouched and still opens the preview.
- [ ] Accepting reloads once, and never again on subsequent clicks.

## 7. Create

- [ ] **New development session…** → pick a repo, type a ticket. Then:
  - [ ] a `feature/<ticket>` worktree appears under `$S/worktrees/`;
  - [ ] `.claude/settings.local.json` in it carries the **development** deny list;
  - [ ] `sessions --json` shows one `mode: 'development'`, `stageStatus: 'active'` session with
        `lineage.parentSessionId: null`;
  - [ ] exactly **one** develop run started (the create call itself starts nothing — the extension
        issues one explicit run);
  - [ ] it stops with `AGENT_STATE=needs-input` and a `DEVELOPMENT.md`, and **Chat** continues it.
- [ ] **New investigation…** → same, with an `investigate/<ticket>` branch, the investigation deny
      list, and a findings run.
- [ ] A ticket with a `/` or a space is rejected by the input box **before** any request.

## 8. Any PR URL

- [ ] **New review from PR URL…** with a PR in a repo **not** in `config.repos` → 202; the row
      appears under **PRs we are reviewing** (proving the list is session-sourced, not
      `groups.ours`); a worktree exists under `$S/worktrees/`; the review runs.
- [ ] Re-issue the **same** URL → **200**, an informational message saying it already has a review
      session, and the existing item is revealed — not an error (R23).
- [ ] Paste a non-PR URL → the validation message appears **before** any request is sent.
- [ ] Paste one of your own PRs → the engine's own-PR refusal is shown verbatim, and
      `ls $S/worktrees/` shows no new directory.
- [ ] Let one `pollIntervalMs` tick pass → `sessions --json` still reflects the live PR state for
      that off-config session (the tick's per-session `gh pr view` path).

## 9. Commands

- [ ] **Start review** from a parking-lot row → the row moves to "PRs we are reviewing", and
      `cgremlin-core prs --config $S/core.json` agrees.
- [ ] **Approve plan** on a `plan_ready` investigation.
- [ ] **Stop run** on a live run, then **Retry stage** on a failed one.
- [ ] **Acknowledge** an item → its indicator clears and it leaves the needs-you count; a **new**
      reason (e.g. a fresh `AGENT_STATE` write) re-raises it.

## 10. Resilience

- [ ] `kill -9` the engine mid-session → the status bar flips to `engine failed — see log` (the
      manager sees its child exit) or `offline` within ~15 s (the SSE heartbeat), with **no**
      error-dialog storm (one warning per outage). A `kill -9` leaves `engine.json` behind; the
      next start takes that provably dead lock over rather than refusing.
- [ ] **`cgremlin: Start the engine`** → the client resyncs on a fresh epoch and the lists are
      correct, with **no** duplicate rows.

## 11. Secrets

- [ ] With `environments.<repo>.vercel.bypassSecret` set in `core.json`, run a review and confirm
      the raw secret appears in **no** `/events` frame, **no** notification and **no** tree label.
      (`GET /config`'s redaction is already pinned by the automated integration test.)

## 12. The bundled engine, end to end

**First run, on a machine with no `core.json`** (use a scratch path so nothing real is touched:
set `cgremlin.configPath` to `~/.cgremlin-core-firstrun/core.json`, and `rm -rf` that dir
afterwards):

- [ ] The extension asks `gh` who you are, has the **engine** write the template, and opens the new
      `core.json` in an editor. The file is mode `0600` (`stat -f '%Lp' <path>` → `600`) and its
      `repos` is `[]`.
- [ ] With `gh` unavailable (`PATH= code ...`, or `gh auth logout`), an input box asks for the
      login instead — and **cancelling it writes nothing** and warns, naming the setting.
- [ ] Add a repo to `repos`, save. The engine restarts by itself (silently, if nothing is running)
      and the parking lot fills.
- [ ] Introduce a typo (a trailing comma), save. One warning carries the **engine's own wording**
      verbatim with an `Open core.json` action, the engine is **left running and untouched**, and
      fixing the file and saving again restarts it — the watcher is still armed.

**The version handshake:**

- [ ] Stop the engine, start an *older or newer* one by hand
      (`cgremlin-core serve --config $S/core.json` from a different checkout), reload the window.
      With nothing running, the extension restarts it silently and says so in the output channel.
      With a run in flight, it shows a **modal** naming both versions and the number of items a
      restart would stop; `Not now` leaves it alone and does not ask again in that window.

**Ownership:**

- [ ] Edit `$S/engine.json` and change `pid` to your own shell's pid. `cgremlin: Stop the engine`
      **refuses**, says so, and your shell is still alive. Put the file back.

---

## Result

| Run by | Date | VS Code | Engine SHA | Steps passed | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

Any failing step: record it here, and treat step 4 as blocking — its failure means re-opening the
chat mechanism (R4) rather than shipping it.
