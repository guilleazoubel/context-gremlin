# Manual smoke checklist — cgremlin VS Code extension v1

This is spec §8 turned into a runbook, updated for Phase 9's four **work-item** lists, the Item
tab and the respond flow. It is **manual on purpose**: there is no Electron harness in this
package, and step 4 — a real `claude --resume` against an engine-produced transcript — is the one
assumption in the phase that only a live run can prove.

Everything automatable is already automated in `test/integration/real-engine.test.ts`, which drives
the same client layer against a real engine on a temp socket — including the four lists, the Item
tab and one respond run, against a stubbed Jira and recorded review threads. What is left here is
the editor surface (the webview, the modal, the folder swap, the terminal) and the paths that need
a real `gh`, a real Jira and a real agent: the live `gh api graphql` cost (step 6a), the real
Atlassian instance (step 10), and the agent runs in steps 4, 6a, 7 and 8.

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
      it does **not** exist, do not create it by hand — that is step 13's first-run test.
- [ ] Within a few seconds of the window opening, the engine is running and the panel populates:
      `~/.cgremlin-core-smoke/engine.sock`, `engine.json` and `engine.log` all exist.

```sh
ls -la ~/.cgremlin-core-smoke      # engine.sock, engine.json, engine.log
cat ~/.cgremlin-core-smoke/engine.json   # {pid, version, socketPath, startedAt}
tail -f ~/.cgremlin-core-smoke/engine.log
```

- [ ] `ls -la ~/.cgremlin` is unchanged by all of the above (or still absent) — nothing in this
      phase reads or writes the legacy state dir.

### The Jira block (Phase 9)

`$S/core.json` already carries yours:

```jsonc
{
  "jira": {
    "siteUrl": "https://aplaceformom.atlassian.net",
    "email": "guilherme.azoubel@aplaceformom.com",
    "apiToken": "…",
    "projectKeys": ["HB", "WEB"]
  },
  "botLogins": ["apfm-sonar", "gitstream-cm"]
}
```

- [ ] `stat -f '%Lp' $S/core.json` → `600`. It holds a token now, so a world-readable file is
      **refused at load**, not merely warned about.
- [ ] `cgremlin-core config check-jira --config $S/core.json` prints your account. This runs
      against the config, not the socket, so it works with the engine stopped.
- [ ] `grep -c apiToken $S/jira.json $S/engine.log` → `0` in both (the file may not exist yet).

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

## 2. The four lists

Compare each list against the engine's own answers. `/items` is what the panel reads; `prs` and
`sessions` are the raw material it is grouped from.

```sh
curl -s --unix-socket $S/engine.sock http://x/items | jq '.lists'
cgremlin-core prs --config $S/core.json
cgremlin-core sessions --json --config $S/core.json
```

- [ ] The panel shows exactly **four** lists — Parking lot, My dev work, Investigations, PRs
      waiting for review — and each count matches the corresponding array in `.lists`.
- [ ] **Parking lot** has three groups in this order: **Reviewing**, **Untouched**, **Someone is
      on it** — and the last one starts **collapsed**. Every row shows an age and a change size.
- [ ] No **draft** PR appears in any list — not a teammate's, and not one of your own.
      (`cgremlin-core prs` lists them; the panel does not.)
- [ ] A teammate's PR that our review agent is on is in **Reviewing**, at the top of the parking
      lot — and is **not** in My dev work.
- [ ] A PR somebody has reviewed or commented on, or whose review GitHub has requested from
      somebody else, is under **Someone is on it**. A PR only a bot has touched
      (`apfm-sonar`, `gitstream-cm`) is **Untouched** — this is the `botLogins` check.
- [ ] **U4, the real question this step exists for:** write down the **untouched** count, not the
      total. If it is still unmanageably long, that is a `watchAuthors` / `showAllRepoPrs` finding
      to record here, not a code change.
- [ ] Change the parking lot's sort to **smallest change** and back — the order changes, the
      membership does not, and the choice survives a window reload.
- [ ] **My dev work**: each ticket assigned to you, each of your open PRs and each of your
      investigation/development/respond sessions appears **exactly once**, merged into one row per
      piece of work. A ticket-linked PR and its ticket are **one** row.
- [ ] Expand that merged row: its children are each agent, then the ticket, then each PR, and every
      one is clickable on its own.
- [ ] **Investigations** holds only the investigations with no PR and no ticket. A ticket-linked
      investigation is in My dev work instead.
- [ ] **PRs waiting for review** = your own open PRs.

**Timing (R53):** widening `gh pr list` by eight fields is the one performance risk.

```sh
time curl -s --unix-socket $S/engine.sock -XPOST http://x/prs/scan > /dev/null
```

- [ ] Record the wall time for a full scan across all your repos, and the PR count. A bad number
      here is a `pollIntervalMs` change, not a redesign.

## 3. Notification

- [ ] With an investigation mid-turn: `printf needs-input > $S/sessions/<id>/AGENT_STATE`.
- [ ] A popup appears within ~2 s, titled `<title> — needs_input`, with `Open` and `Ack`.
- [ ] `Open` reveals and selects that row; the row carries the agent's badge.
- [ ] A row that is **not** needs-you (a parking-lot PR appearing, say) raises **no** popup.

## 3a. The Item tab

- [ ] Click a **My dev work** row → **one** editor tab opens for that piece of work (not a
      markdown preview), and the managed workspace swaps to the selected agent's worktree.
- [ ] Its three focuses all render: the **agent** (its artifacts, newest first, as rendered
      markdown), the **PR** (state, review decision, CI, diff size, reviewers) and the **ticket**
      (summary, description and the latest comments, as **text** — no HTML, no raw `<p>`).
- [ ] Click a **child** of an expanded row (the ticket, or one PR) → the **same** tab, focused on
      that part. A second item replaces the tab rather than opening a second one.
- [ ] An artifact containing `<script>alert(1)</script>` renders as those **characters**. A
      `REVIEW.md` footnote `[1](#f1)` still jumps to its `<a id="f1">` anchor.
- [ ] Append a line to the open artifact from a shell → the tab updates with no click.
- [ ] Reload the window (`Developer: Reload Window`) → the tab is **gone**. That is by design;
      reopen it from the panel.

## 3b. The agent switcher

- [ ] On a row with two agents (an investigation and a development session, say), switch between
      them in the tab → the artifacts and the worktree follow the selection.
- [ ] Switching claims **nothing**: `cgremlin-core sessions --config $S/core.json` shows the
      `claimed` column empty throughout, and no terminal opens. Only **Chat** claims.

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

## 5. The worktree swap

- [ ] Click a session row → the worktree becomes **the** workspace folder **without** the window
      reloading (given the managed workspace is already open — see step 6).
- [ ] Click a **different** session → the folder swaps: exactly one folder in the explorer, the
      previous folder's editors close, and the status bar names the new session id and phase.
- [ ] Dirty-editor case: edit a file in the current worktree **without saving**, then click a
      different session → a **modal** appears first
      (`Switching to '<id>' closes the editors of the current worktree…`).
  - [ ] Dismissing it leaves the folder and the unsaved buffer untouched — **and still opens the
        Item tab**.
  - [ ] Accepting (`Switch anyway`) swaps as above.

## 6. Managed workspace bootstrap

- [ ] From a plain single-folder window, click a row → the extension **offers** to open
      `$S/cgremlin.code-workspace`.
- [ ] Declining leaves the window untouched and still opens the preview.
- [ ] Accepting reloads once, and never again on subsequent clicks.

## 6a. The respond flow, and what the threads cost

Pick one of **your own** open PRs that has real review comments on it.

- [ ] It is in **PRs waiting for review**, and it lights up (needs-you) once a review arrives.
- [ ] Click it (or **Address review comments**) → **one** respond session is created **and its run
      starts**, the workspace swaps to that PR's worktree, and **no terminal opens and no claim is
      taken**: `cgremlin-core sessions --config $S/core.json` shows `claimed` empty.
- [ ] The worktree is checked out on the **PR's own head branch**
      (`git -C $S/worktrees/<id> branch --show-current`), at the **fetched** head — not an older
      snapshot (`git -C $S/worktrees/<id> log -1 --format=%H` matches the PR's head sha).
- [ ] `$S/sessions/<id>/BRIEF.md` contains **every** comment of every live review thread, the
      per-reviewer states, the failing CI checks, the diff summary and — if the branch names a
      `HB`/`WEB` ticket — a `## Ticket` section.
- [ ] The phase reaches `addressing`, and **only then** does the row offer **Chat**. Before that,
      Chat is absent (or disabled with a reason): chatting into a session whose brief is still
      being written is exactly what the ordering prevents.
- [ ] When the run finishes, `$S/sessions/<id>/COMMENTS.md` has one entry per thread — verdict,
      reasoning and a drafted reply — and it **renders in the Item tab**.
- [ ] **Nothing was posted to GitHub.** Reload the PR page: no new comment, no resolved thread, no
      push, and the PR is still a draft if it was one. `grep -c 'gh pr \(comment\|review\)' $S/engine.log` → `0`.
- [ ] Clicking the same row again does **not** create a second session.

**The GraphQL cost (U5).** Watch two idle ticks with nothing changing on GitHub:

```sh
tail -f $S/engine.log | grep -i graphql   # or watch the tick timings
```

- [ ] The first tick after a change fetches threads only for your own non-draft PRs and for
      parking-lot candidates with **no** human activity yet. The second, with no `updatedAt`
      moving, makes **zero** GraphQL calls — that is the cache doing its job. Record both counts.

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
      appears in the parking lot's **Reviewing** group (the group is session-sourced, so an
      off-config PR with no inventory row at all is still listed); a worktree exists under
      `$S/worktrees/`; the review runs.
- [ ] That same PR does **not** appear in My dev work — a review agent never moves a teammate's
      PR there.
- [ ] Re-issue the **same** URL → **200**, an informational message saying it already has a review
      session, and the existing item is revealed — not an error (R23).
- [ ] Paste a non-PR URL → the validation message appears **before** any request is sent.
- [ ] Paste one of your own PRs → the engine's own-PR refusal is shown verbatim, and
      `ls $S/worktrees/` shows no new directory.
- [ ] Let one `pollIntervalMs` tick pass → `sessions --json` still reflects the live PR state for
      that off-config session (the tick's per-session `gh pr view` path).

## 9. Commands

- [ ] **Start review** from an **Untouched** parking-lot row → the row moves to the **Reviewing**
      group at the top of the same list, and `cgremlin-core prs --config $S/core.json` agrees.
      It does **not** appear in My dev work.
- [ ] **Start review** is not offered on your own PR, and **Address review comments** is not
      offered on a teammate's — a button whose only outcome is a 409 is what made the old panel
      untrustworthy.
- [ ] **Approve plan** on a `plan_ready` investigation.
- [ ] **Stop run** on a live run, then **Retry stage** on a failed one.
- [ ] **Acknowledge** an item with **two** parts (a PR and a session, say) → the whole row clears
      in one click and leaves the needs-you count; a **new** reason (a fresh `AGENT_STATE` write)
      re-raises it.
- [ ] A **push** to a PR that is approved and already acked raises **nothing** — the reason's
      timestamp is pinned to something only a human moves.

## 10. Jira, against the real instance

This is the one step that talks to Atlassian. No automated test anywhere makes a live Jira call.

- [ ] The tickets in **My dev work** are the ones your JQL returns:
      `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` by default.
      To follow the sprint instead, change that one string in `core.json` to
      `assignee = currentUser() AND sprint in openSprints()`, save, and confirm the list changes.
- [ ] Open a ticket in the Item tab → summary, status, description and the **newest** comments
      first, all as text.
- [ ] A PR whose branch or title names an `HB`/`WEB` key is merged with that ticket into one row.
      Remove `projectKeys` from `core.json`, restart, and confirm the merge stops happening and
      `engine.log` carries `ticket linking disabled: set jira.projectKeys in core.json`
      **exactly once**. Put it back.
- [ ] Break the token (change one character), restart → a **banner** above the lists and a
      **status-bar warning**, the PR rows are all still there, and
      `cgremlin-core config check-jira --config $S/core.json` prints **Jira's own** message. Fix it.
- [ ] Take the machine offline for a tick → the banner says the tickets are the last ones scanned,
      and they are **still shown**. Back online, the next tick clears it.

## 11. Resilience

- [ ] `kill -9` the engine mid-session → the status bar flips to `engine failed — see log` (the
      manager sees its child exit) or `offline` within ~15 s (the SSE heartbeat), with **no**
      error-dialog storm (one warning per outage). A `kill -9` leaves `engine.json` behind; the
      next start takes that provably dead lock over rather than refusing.
- [ ] **`cgremlin: Start the engine`** → the client resyncs on a fresh epoch and the lists are
      correct, with **no** duplicate rows.

## 12. Secrets

- [ ] With `environments.<repo>.vercel.bypassSecret` set in `core.json`, run a review and confirm
      the raw secret appears in **no** `/events` frame, **no** notification and **no** panel row.
      (`GET /config`'s redaction is already pinned by the automated integration test.)
- [ ] The Jira token, the same way — and on disk too:

```sh
grep -rl "$(jq -r .jira.apiToken $S/core.json)" $S --exclude core.json
```

- [ ] That prints **nothing**. `jira.json`, `review-threads.json`, `inventory.json`, `engine.log`
      and every session directory are all clean; `core.json` is the only place the token lives.

## 13. The bundled engine, end to end

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

Also record the three numbers this pass exists to produce, whatever the result:

| Measurement | Value |
|---|---|
| Step 2 — **untouched** parking-lot count (U4) | |
| Step 2 — full-scan wall time × PR count, after the eight-field widening (R53, U6) | |
| Step 6a — `gh api graphql` calls on the first tick, and on the second idle one (U5) | |

Any failing step: record it here, and treat step 4 as blocking — its failure means re-opening the
chat mechanism (R4) rather than shipping it. Step 6a's "nothing was posted to GitHub" is blocking
in the same way (R55).
