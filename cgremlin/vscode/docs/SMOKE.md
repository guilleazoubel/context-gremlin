# Manual smoke checklist — cgremlin VS Code extension

Phase 10. This is the runbook for the **redesigned panel** — taller rows carrying the decision
signals, one click that selects, expands and swaps, three lifecycle slots, forward-only actions,
an overflow menu, the size tier, "changes so far" — plus the engine behaviour the restart-storm
fix changed: the build-id handshake, the once-per-identity auto restart and the offline hysteresis.

It is **manual on purpose**. There is no Electron harness in this package, so the webview itself,
the modal, the folder swap and the terminal can only be seen by a person. Everything below that
column says "automated" is already executed by
`test/integration/panel-flows.test.ts`, `test/integration/real-engine.test.ts`,
`test/integration/engine-manager.test.ts` or `test/integration/config-chmod-storm.test.ts` against
a **real** engine on a temp socket — what is left here is the surface those tests cannot see, and
the paths that need a real `gh`, a real Jira and a real agent.

**Every step below states what you should see.** A step whose expected result does not happen is a
finding: record it in the table at the bottom, and commit this file on the phase branch.

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

`cgremlin.notificationLevel` (default `all`) is the only other setting there is. **There is no
socket setting** — the socket, the log, the pid file, `sessions/` and `worktrees/` are all derived
from `core.json`'s `stateDir` by the engine's own loader.

Throughout, `$S` means `~/.cgremlin-core-smoke` and `<id>` a session id from
`cgremlin-core sessions --json --config $S/core.json`. (`cgremlin-core` on `PATH` is only needed
for these cross-checks, never by the extension: `export PATH="$PWD/../core/bin:$PATH"`.)

| # | Do this | Expect |
|---|---|---|
| 0.1 | Open the window | Within a few seconds the engine is running and the panel populates: `$S/engine.sock`, `$S/engine.json` and `$S/engine.log` all exist |
| 0.2 | `cat $S/engine.json` | `{pid, version, buildId, socketPath, startedAt}` — **`buildId` is present**, and it is the content address of the bundle this extension ships |
| 0.3 | `ls -la ~/.cgremlin` | Unchanged by all of the above, or still absent. Nothing in this phase reads or writes the legacy state dir |
| 0.4 | `stat -f '%Lp' $S/core.json` | `600`. It holds a token, so a world-readable file is **refused at load**, not merely warned about |
| 0.5 | `cgremlin-core config check-jira --config $S/core.json` | Prints your account. Runs against the config, not the socket, so it works with the engine stopped |
| 0.6 | `grep -c apiToken $S/jira.json $S/engine.log` | `0` in both (the files may not exist yet) |

The Jira block `$S/core.json` already carries:

```jsonc
{
  "jira": {
    "siteUrl": "https://aplaceformom.atlassian.net",
    "email": "guilherme.azoubel@aplaceformom.com",
    "apiToken": "…",
    "projectKeys": ["HB", "WEB"]
  }
}
```

`botLogins` is now **optional**: the engine ships a default list, so a config that names none still
keeps a bot-only PR out of "someone is on it". Set it only to add a bot the default misses.

| # | Do this | Expect |
|---|---|---|
| 0.7 | Remove `botLogins` from `core.json`, save, and look at a PR only `apfm-sonar` has touched | It is still **Untouched**. The default bot list is what keeps it there |
| 0.8 | Put `botLogins` back | Same result — an explicit list adds to the defaults rather than replacing the reasoning |

---

## 1. Row anatomy

This is the step the redesign exists for: a row must answer "should I pick this up?" without being
clicked. Pick the **Parking lot** and read one row without touching anything.

| # | Do this | Expect |
|---|---|---|
| 1.1 | Read a parking-lot row's **first line** | The PR's title, prefixed by `owner/repo#n`. A row whose work has an agent carries that agent's badge |
| 1.2 | Read its **second line** | Cells, not a clipped sentence: `@author · <age> · <tier> · <size> · <CI dot> · <review decision> · <activity>` |
| 1.3 | Read the **tier** cell | One of `S` `M` `L` `XL`, or `—`. Hovering it shows the raw `N files +A/−D` |
| 1.4 | Check the tier against the PR | It is the **worse** of the two dimensions: a 1-file, 900-line change is **not** an `S`, and a 30-file, 40-line rename sweep is **not** an `S` either |
| 1.5 | Find a PR the scan has no counts for | Age, size and tier all read `—`. **No row anywhere says `0 files`** or implies a date it does not have |
| 1.6 | Read the **CI** cell | A coloured **dot** with a `CI: <status>` tooltip — never an emoji (emoji size inconsistently in a 300 px sidebar) |
| 1.7 | Read the **activity** cell on a row somebody reviewed | `👤 @dana reviewed` (or `commented`, or `requested`) |
| 1.8 | Narrow the sidebar to ~250 px | Nothing is clipped mid-word and no row scrolls horizontally; cells wrap or drop, the title never does |
| 1.9 | Look at a **My dev work** row | It carries a **third** line — the state line — that the other three lists do not |
| 1.10 | Look at a row under **Someone is on it** | It is visibly **dimmed** (`demoted`), and the group is **collapsed** by default |

## 2. The four lists and the parking lot's groups

```sh
curl -s --unix-socket $S/engine.sock http://x/items | jq '.lists'
cgremlin-core prs --config $S/core.json
```

| # | Do this | Expect |
|---|---|---|
| 2.1 | Count the lists | Exactly **four** — Parking lot, My dev work, Investigations, PRs waiting for review — and each count matches the matching array in `.lists` |
| 2.2 | Read the parking lot's groups | Three, in this order: **Reviewing**, **Untouched**, **Someone is on it**; only the last is collapsible and it starts collapsed |
| 2.3 | Find a PR only a bot has touched | **Untouched.** A bot review or a bot comment never demotes a row |
| 2.4 | Find a PR whose review GitHub has **requested** from a human, with no review or comment yet | **Untouched** — this is R47.1 **reversed** in Phase 10. Its row still *says* `👤 @<who> requested`; a request is information, not work already done |
| 2.5 | Find a PR a human has actually reviewed or commented on | **Someone is on it** — the only thing that demotes a row is real human activity |
| 2.6 | Look for draft PRs | **None** appears in any list, yours included (`cgremlin-core prs` lists them; the panel does not) |
| 2.7 | Find a teammate's PR our review agent is on | Top of the parking lot, in **Reviewing** — and **not** in My dev work |
| 2.8 | **U4, the question this step exists for**: write down the **untouched** count, not the total | If it is still unmanageably long, that is a `watchAuthors` / `showAllRepoPrs` finding to record below, not a code change |
| 2.9 | Change the parking lot's sort to **smallest change** and back | The order changes **within each group and never across them**, membership does not change, and the choice survives a window reload |
| 2.10 | With **smallest change** on, read the tier column top to bottom | It is non-decreasing. The tier leads the sort; the raw file count only breaks ties inside one tier |
| 2.11 | **My dev work** | Each ticket assigned to you, each of your open PRs and each of your sessions appears **exactly once**, merged into one row per piece of work. A ticket-linked PR and its ticket are **one** row |
| 2.12 | **Investigations** | Only the investigations with no PR and no ticket. A ticket-linked investigation is in My dev work instead |
| 2.13 | **PRs waiting for review** | Your own open, non-draft PRs |

**Timing (R53):**

```sh
time curl -s --unix-socket $S/engine.sock -XPOST http://x/prs/scan > /dev/null
```

| # | Do this | Expect |
|---|---|---|
| 2.14 | Record the wall time for a full scan and the PR count | Recorded below. A bad number here is a `pollIntervalMs` change, not a redesign |

## 3. One click: select, expand, swap

The redesign's central claim: **a click on a row is one decision with three consequences.**

| # | Do this | Expect |
|---|---|---|
| 3.1 | Click a row that has a session behind it | Three things at once: the row gets a **persistent highlight**, it **expands in place**, and the managed workspace **swaps to that item's worktree** |
| 3.2 | Watch the order | The highlight and the expansion are on screen **before** any modal — the panel repaints from its own state first |
| 3.3 | Click a **second** row | The first row **closes**. At most one row is open — it is an accordion, not a set of toggles |
| 3.4 | Click the row that is already open | It **closes**, and the highlight **stays on it**. Selection and expansion are different facts |
| 3.5 | Reload the window (`Developer: Reload Window`) | The same row is still selected and still open |
| 3.6 | Click a row whose item has **no** session (a bare parking-lot PR) | It selects and expands. The workspace is **not** swapped — there is nothing to open, and it guesses nothing |
| 3.7 | Click a row whose item has two sessions, one running | The workspace swaps to the **running** one's worktree — that is the one actually writing files |
| 3.8 | Edit a file in the current worktree **without saving**, then click a different row | A **modal** appears first (`Switching to '<id>' closes the editors of the current worktree…`) |
| 3.9 | Dismiss that modal | The folder and the unsaved buffer are untouched — **and the row is still selected and still expanded** |
| 3.10 | Accept it (`Switch anyway`) | The folder swaps; exactly one folder in the explorer |
| 3.11 | Keep clicking rows and watch the explorer | **Never two repo folders.** One swap per click, in one `updateWorkspaceFolders` call, and the window never reloads |
| 3.12 | From a plain single-folder window, click a row | The extension **offers** to open `$S/cgremlin.code-workspace`; declining leaves the window untouched and still expands the row; accepting reloads once and never again |

## 4. The lifecycle slots

| # | Do this | Expect |
|---|---|---|
| 4.1 | Expand any row | **Three** slots, always, in this order: 🔍 **Investigation** → 🔨 **Development** → 🔎 **Review** |
| 4.2 | Expand a row with no agents at all | Still three slots, each reading **`not started`**. An absent stage is information; a list whose shape changes per row cannot be read at a glance |
| 4.3 | Expand a row whose development session is mid-run | That slot reads **`running · <phase>`** |
| 4.4 | Expand a row whose agent is waiting on you | That slot reads **`needs you · <phase>`**, and the row carries the needs-you marker |
| 4.5 | Expand a row whose stage finished and wrote an artifact | That slot reads **`done · 2h`** — the age of the newest artifact that session wrote |
| 4.6 | Expand a row whose stage finished but wrote nothing | **`done`**, with no date. Never a fabricated one |
| 4.7 | Read the row's **parts** below the slots | The ticket and each PR — and **not** the agents, which are the slots and are not listed twice |
| 4.8 | Append a line to the open row's artifact from a shell | Within a couple of seconds the slot's `done · …` age updates with no click |

## 5. Forward-only actions, and the overflow

The rule: the lifecycle is investigation → development → review, and **only the stage after the
furthest one reached is ever offered**. A PR *is* the development stage's output, so an item with a
PR is already past it.

| # | Do this | Expect |
|---|---|---|
| 5.1 | Count the visible buttons on any row | **One** primary. Everything else is either an inline button in the expanded area or behind the `⋯` menu |
| 5.2 | Look at a row with nothing started | Both entry points are legitimate: **Start development** (primary) and **Start investigation** |
| 5.3 | Look at a row with an **investigation** and no PR | **Start development.** **Start investigation is gone** — you are past it |
| 5.4 | Look at a row with a **PR** | **Start review.** Neither **Start development** nor **Start investigation** is offered — the PR settles both questions |
| 5.5 | Look at one of **your own** PRs in My dev work | The button reads **Start self-review**, not "Start review" — the wording says what it is rather than pretending the change is somebody else's |
| 5.6 | Look at a **parking-lot** row (a teammate's PR) | **Start review** only. Never Start development or Start investigation: those can only ever produce a nonsensical session on somebody else's branch |
| 5.7 | Look at a **waiting-for-review** row | **Address review comments** only (and Chat once a respond agent has something to say) |
| 5.8 | Compare a slot's Start button with the row's own button | They **agree**, always. The slot takes the row's action rather than deriving its own — a slot offering a verb the row refuses is exactly the "button that returns an engine error" this rule exists to stop |
| 5.9 | Open the `⋯` menu | Open the PR(s), Open the ticket, and **Ack** when something needs you — links and acknowledgements, never decisions |
| 5.10 | Open `⋯` on a second row | The first menu **closes**. At most one is open |
| 5.11 | With `⋯` open, press `Escape`, click elsewhere, and scroll the list | Each of the three dismisses it |
| 5.12 | With `⋯` open, watch the rows behind it | The menu **overlays**; it never pushes rows down or changes the list's height |
| 5.13 | Click a row with no verb of its own at all | The one click still does something useful — the conversation, else the PR, else the ticket. **Never a verb that would 409** |

## 6. Changes so far

| # | Do this | Expect |
|---|---|---|
| 6.1 | Expand a row whose session has a worktree | It shows **two** numbers: what the session has **committed**, and what is still only in its **working tree** |
| 6.2 | Read the wording | `8 files +240/−31` — the same wording as a PR row's size cell |
| 6.3 | Cross-check against git | `git -C $S/worktrees/<id> diff --stat $(git -C $S/worktrees/<id> merge-base <base> HEAD) HEAD` for the committed half and `git -C $S/worktrees/<id> diff --stat HEAD` for the working tree. **Both agree** |
| 6.4 | Edit a tracked file in that worktree without saving to git, wait for a refresh | The **working tree** number moves; the committed one does not |
| 6.5 | Commit it | The numbers swap over |
| 6.6 | Expand a row whose item has no session at all | Both read `—`. **Never `0 files`** |
| 6.7 | Rebase the branch so its base moves | The committed count is against the **merge base**, so a stale base never inflates it |
| 6.8 | Leave one row open and keep working elsewhere for a minute | The open row's numbers keep up. **Watch `$S/engine.log`**: a burst of changes about *other* PRs must cost this row **zero** extra reads |

## 7. Notification and the engine's trouble states

| # | Do this | Expect |
|---|---|---|
| 7.1 | `printf needs-input > $S/sessions/<id>/AGENT_STATE` | A popup within ~2 s, titled `<title> — needs_input`, with `Open` and `Ack` |
| 7.2 | Press `Open` | That row is revealed, selected and expanded, and its slot says `needs you` |
| 7.3 | Watch a row that is **not** needs-you appear (a parking-lot PR, say) | **No** popup |
| 7.4 | **`cgremlin: Restart the engine`**, and watch the panel closely | The lists **stay on screen** throughout. The stream drops and reconnects, and nothing says "offline" — the hysteresis window (8 s, past the third reconnect backoff) swallows it |
| 7.5 | `kill -9` the engine | Within ~15 s the status bar reads `engine failed — see log` or `offline`, **one** warning and no dialog storm. The lists are still the last ones known, never four empty ones |
| 7.6 | **`cgremlin: Start the engine`** | The client resyncs on a fresh epoch, the lists are correct and there are **no duplicate rows** |
| 7.7 | Start something else on the socket (`nc -lU $S/engine.sock` with the engine stopped), reload | The lists are replaced by **one explanatory row** naming the socket and telling you to run `cgremlin: Start the engine` — never four silent empty lists |
| 7.8 | Fix it and press the row's action | The panel goes back to being a panel, having refetched |

## 8. The build-id upgrade restart

This is the restart-storm fix, seen from the user's side. `ENGINE_VERSION` is the **package's**
version and it does not move between phases — so the handshake also compares a **build id**, a
content address of the bundle.

| # | Do this | Expect |
|---|---|---|
| 8.1 | With the panel up, `cat $S/engine.json` and note `buildId` and `startedAt` | Both present |
| 8.2 | Install a **rebuilt** extension (`pnpm package` again after any source change) and reload the window | The version word is the *same*; the build id is not. The output channel names the two **build ids**, not two identical version strings |
| 8.3 | With **nothing running**, watch what happens | It restarts **silently** — no modal. `engine.json`'s `pid` and `startedAt` both change |
| 8.4 | Count the restarts | **Exactly one.** `engine.json`'s `startedAt` moves once, and `pgrep -f $S/core.json` finds one process. The manager's own log is the **cgremlin output channel**, not `$S/engine.log`: a second automatic restart of the same engine boot is refused there with `engine.auto_restart_refused` |
| 8.5 | Repeat with a **run in flight** | A **modal** naming both builds and the number of items a restart would stop. `Not now` leaves it alone **and does not ask again in that window** |
| 8.6 | Open a second window on the same `configPath` while the first has already restarted | It **adopts** — one pid, no second engine, no `Another process is already listening` in the log |
| 8.7 | Save `core.json` (a real edit) with two windows open | Each window restarts **once** — not twice, and not once per filesystem event. The watcher is content-addressed, so a `chmod` or a touch that changes no bytes restarts **nothing** |
| 8.8 | `chmod 600 $S/core.json` twenty times in a row | **Zero** restarts, zero SIGTERMs, and the mode is still `600` |

## 9. Chat — the one thing only a live run can prove

Pick a session whose `agent.resumeId` is non-null.

| # | Do this | Expect |
|---|---|---|
| 9.1 | Click **Chat** on that row | A terminal whose cwd is the session's **worktree** and whose first command is `claude --resume '<resumeId>'` |
| 9.2 | Read the transcript | The prior turn's context is present. **If it does not resume, stop** — R4 has to be re-opened, not shipped. *(blocking)* |
| 9.3 | With the terminal open, `curl --unix-socket $S/engine.sock -XPOST http://x/sessions/<id>/run -d '{"stage":"develop"}' -H 'content-type: application/json'` | **409** `a human holds the agent conversation` |
| 9.4 | Close the terminal, repeat | No longer 409s; `cgremlin-core sessions` shows `claimed` empty |
| 9.5 | Leave the terminal open past one `humanTurnTtlMs` | The claim is **still** held — the heartbeat (TTL/3) renewed it |
| 9.6 | `kill -9` the extension host with a claim held | The claim lapses within one TTL |
| 9.7 | Restart the engine with a claim in place | Its log carries `conversation.claims_cleared` |
| 9.8 | Click through rows and slots without pressing Chat | **Nothing is ever claimed** and no terminal opens. Only Chat claims |

## 10. Self-review, and the respond flow

| # | Do this | Expect |
|---|---|---|
| 10.1 | On one of **your own** PRs in My dev work, press **Start self-review** | A review session is created **on your own PR** and its run starts — no 409 |
| 10.2 | `cgremlin-core sessions --json --config $S/core.json` for that session | `lineage.selfReview` is `true`. The flag is recorded on the **review** session, never inherited from the source |
| 10.3 | Read that session's `BRIEF.md` | It says this is a **self-review** — the PR under review is your own. An agent that did not know would write a review addressed to somebody else |
| 10.4 | Try the same PR through **New review from PR URL…** | The engine's own-PR refusal, shown verbatim, and **no** new worktree. `selfReview` is a deliberate act from the row's own button, not the default |
| 10.5 | Press the button again on the same PR | **No second session** — the existing one is revealed |
| 10.6 | On one of your PRs with real review comments, press **Address review comments** | **One** respond session created **and started**, the workspace swaps to its worktree, **no terminal and no claim** |
| 10.7 | `git -C $S/worktrees/<id> branch --show-current` and `log -1 --format=%H` | The PR's own head branch, at the **fetched** head sha |
| 10.8 | Read that session's `BRIEF.md` | **Every** comment of every live review thread, the per-reviewer states, the failing CI checks, the diff summary, and a `## Ticket` section if the branch names an `HB`/`WEB` key |
| 10.9 | Watch the row while the phase moves | Chat is **absent** until the phase reaches `addressing`. Chatting into a session whose brief is still being written is exactly what the ordering prevents |
| 10.10 | When it finishes, open `COMMENTS.md` in the Item tab | One entry per thread — verdict, reasoning, a drafted reply — rendered |
| 10.11 | Reload the PR page on GitHub | **Nothing was posted**: no comment, no resolved thread, no push, still a draft if it was one. `grep -c 'gh pr \(comment\|review\)' $S/engine.log` → `0`. *(blocking)* |

**The GraphQL cost (U5).** Watch two idle ticks with nothing changing on GitHub:

| # | Do this | Expect |
|---|---|---|
| 10.12 | `tail -f $S/engine.log \| grep -i graphql` across two ticks | The first tick after a change fetches threads only for your own non-draft PRs and for parking-lot candidates with no human activity yet. The second, with no `updatedAt` moving, makes **zero** calls. Record both counts |

## 11. The Item tab

| # | Do this | Expect |
|---|---|---|
| 11.1 | Open a row's **Open** action (or a slot's session) | **One** editor tab for that piece of work — not a markdown preview |
| 11.2 | Read the tab | Its three focuses render: the **agent** (artifacts newest first, as rendered markdown), the **PR** (state, decision, CI, diff size, reviewers) and the **ticket** (summary, description and newest comments, as **text** — no HTML, no raw `<p>`) |
| 11.3 | Open a **child** of an expanded row (the ticket, or one PR) | The **same** tab, focused on that part. A second item replaces the tab rather than opening a second one |
| 11.4 | Compare the tab's buttons with the row's | They **agree** — the tab asks the same rule over the union of the item's lists |
| 11.5 | Open an artifact containing `<script>alert(1)</script>` | It renders as those **characters** |
| 11.6 | Open a `REVIEW.md` with a footnote `[1](#f1)` | The link jumps to its `<a id="f1">` anchor |
| 11.7 | Append a line to the open artifact from a shell | The tab updates with no click |
| 11.8 | Reload the window | The tab is **gone**. By design; reopen it from the panel |
| 11.9 | Switch between two agents in the tab | Artifacts and worktree follow the selection, and **nothing is claimed** |

## 12. Create

| # | Do this | Expect |
|---|---|---|
| 12.1 | **New development session…** → pick a repo, type a ticket | A `feature/<ticket>` worktree under `$S/worktrees/`; `.claude/settings.local.json` carries the **development** deny list; one `mode: 'development'`, `stageStatus: 'active'` session with `lineage.parentSessionId: null` |
| 12.2 | Count the runs | **Exactly one** develop run. Creating is not running — the extension issues one explicit run |
| 12.3 | Wait for it | It stops with `AGENT_STATE=needs-input` and a `DEVELOPMENT.md`, and **Chat** continues it |
| 12.4 | Look at the new row's slots | Development is the furthest stage, so the only Start on offer is **Review** |
| 12.5 | **New investigation…** | Same, with an `investigate/<ticket>` branch, the investigation deny list, and a findings run |
| 12.6 | Type a ticket with a `/` or a space | Rejected by the input box **before** any request |
| 12.7 | **New review from PR URL…** with a PR in a repo **not** in `config.repos` | 202; the row appears in the parking lot's **Reviewing** group; a worktree exists; the review runs |
| 12.8 | Check My dev work | That PR is **not** there — a review agent never moves a teammate's PR into your work |
| 12.9 | Re-issue the **same** URL | **200** and an informational message, the existing item revealed — not an error |
| 12.10 | Paste a non-PR URL | The validation message appears **before** any request is sent |

## 13. Commands and acknowledgement

| # | Do this | Expect |
|---|---|---|
| 13.1 | **Start review** from an **Untouched** parking-lot row | The row moves to **Reviewing** at the top of the same list, and `cgremlin-core prs` agrees |
| 13.2 | **Approve plan** on a `plan_ready` investigation | Accepted |
| 13.3 | **Stop run** on a live run, then **Retry stage** on a failed one | Both take effect |
| 13.4 | **Ack** (from `⋯`) an item with **two** parts | The whole row clears in one click and leaves the needs-you count |
| 13.5 | Write a fresh `AGENT_STATE` on it | It **re-raises**. The ack stored one signature, not "forever quiet" |
| 13.6 | Push to a PR that is approved and already acked | **Nothing** is raised — the reason's timestamp is pinned to something only a human moves |

## 14. Jira, against the real instance

The one step that talks to Atlassian. No automated test anywhere makes a live Jira call.

| # | Do this | Expect |
|---|---|---|
| 14.1 | Read My dev work | The tickets your JQL returns (`assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` by default) |
| 14.2 | Change that string to `assignee = currentUser() AND sprint in openSprints()`, save | The list changes accordingly |
| 14.3 | Open a ticket in the Item tab | Summary, status, description and the **newest** comments first, all as text |
| 14.4 | Find a PR whose branch or title names an `HB`/`WEB` key | It is merged with that ticket into **one** row |
| 14.5 | Remove `projectKeys`, restart | The merge stops, and `engine.log` carries `ticket linking disabled: set jira.projectKeys in core.json` **exactly once**. Put it back |
| 14.6 | Break the token (change one character), restart | A **banner** above the lists and a status-bar warning; the PR rows are all still there; `config check-jira` prints **Jira's own** message. Fix it |
| 14.7 | Go offline for a tick | The banner says the tickets are the last ones scanned, and they are **still shown**. Back online, the next tick clears it |

## 15. Secrets

| # | Do this | Expect |
|---|---|---|
| 15.1 | With `environments.<repo>.vercel.bypassSecret` set, run a review | The raw secret appears in **no** `/events` frame, **no** notification and **no** panel row |
| 15.2 | `grep -rl "$(jq -r .jira.apiToken $S/core.json)" $S --exclude core.json` | Prints **nothing**. `jira.json`, `review-threads.json`, `inventory.json`, `engine.log` and every session directory are clean; `core.json` is the only place the token lives |

## 16. First run

Use a scratch path so nothing real is touched: set `cgremlin.configPath` to
`~/.cgremlin-core-firstrun/core.json`, and `rm -rf` that dir afterwards.

| # | Do this | Expect |
|---|---|---|
| 16.1 | Open a window with no `core.json` there | The extension asks `gh` who you are, has the **engine** write the template, and opens the new file. Mode `600`, `repos: []` |
| 16.2 | Repeat with `gh` unavailable | An input box asks for the login instead; **cancelling writes nothing** and warns, naming the setting |
| 16.3 | Add a repo to `repos`, save | The engine restarts by itself (silently, nothing running) and the parking lot fills |
| 16.4 | Introduce a typo (a trailing comma), save | **One** warning carrying the engine's own wording verbatim with an `Open core.json` action; the engine is left **running and untouched** |
| 16.5 | Fix it and save again | It restarts — the watcher is still armed |
| 16.6 | Edit `$S/engine.json`'s `pid` to your own shell's pid, then `cgremlin: Stop the engine` | It **refuses**, says so, and your shell is still alive. Put the file back |

---

## Result

| Run by | Date | VS Code | Extension build id | Engine SHA | Steps passed | Notes |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

Per section, so a partial pass is still useful:

| Section | Pass / fail | Notes |
|---|---|---|
| 0 Setup | | |
| 1 Row anatomy | | |
| 2 Lists and groups | | |
| 3 One click: select, expand, swap | | |
| 4 Lifecycle slots | | |
| 5 Forward-only actions and overflow | | |
| 6 Changes so far | | |
| 7 Notification and trouble states | | |
| 8 Build-id upgrade restart | | |
| 9 Chat *(blocking)* | | |
| 10 Self-review and respond *(10.11 blocking)* | | |
| 11 Item tab | | |
| 12 Create | | |
| 13 Commands and ack | | |
| 14 Jira | | |
| 15 Secrets | | |
| 16 First run | | |

And the numbers this pass exists to produce, whatever the result:

| Measurement | Value |
|---|---|
| 2.8 — **untouched** parking-lot count (U4) | |
| 2.14 — full-scan wall time × PR count (R53, U6) | |
| 8.4 — restarts counted for one build-id upgrade (expected: 1) | |
| 10.12 — `gh api graphql` calls on the first tick, and on the second idle one (U5) | |

**Blocking failures.** Step 9.2 (the transcript does not resume) means re-opening the chat
mechanism rather than shipping it. Step 10.11 (something was posted to GitHub) is blocking in the
same way. Everything else is a finding to record here.
