# cgremlin — VS Code extension

Mission control for the [cgremlin engine](../core): four **work-item** lists, needs-you
notifications, one managed worktree folder, an Item tab that renders a piece of work end to end,
and a chat hand-off into the agent's own transcript.

The extension is a **client**. It never scans GitHub, never spawns an agent and never derives state
the engine already owns — a refresh is **one** request, `GET /items`, plus the `GET /events` stream
it reacts to, and it posts the actions the user asks for. Which list a row is in, whether somebody
is already on a PR and which parking-lot group it belongs to are all the **engine's** answer; the
panel re-sorts and renders them.

## Layout

| Path | Purity | What |
|---|---|---|
| `src/core-client.ts` | pure | the socket API: typed methods, `EngineNotRunningError`, `CoreHttpError` |
| `src/sse.ts` | pure | `GET /events`: frame parser plus a reconnecting consumer (`Last-Event-ID`, epoch, resync) |
| `src/model/*` | pure | wire types and the panel's policies |
| `src/ui/host.ts` | pure | the editor surface **as an interface** — every `ui/*` module takes one |
| `src/webview/*` | browser | the two bundled webview scripts (panel, Item tab) — no editor API, bundled by esbuild into `media/*.js` |
| `src/ui/*` | pure | the panel view, the Item tab, status bar, notifications, worktree swap, chat, refresh, commands |
| `src/settings.ts`, `src/extension.ts` | editor API | the only two modules that import `vscode` |

Pure modules must not import the editor API — that is what keeps the policy layer unit-testable
without an Electron harness, and it is enforced by the `MG-B1` guard in `test/purity.test.ts`.
`ui/*` is pure in the same sense: it is written against `Host`, and `extension.ts` is the single
adapter from the real `vscode` namespace to it. That is why the whole command set, the workspace
swap and the chat heartbeat have unit tests and no Electron test harness is anywhere near this
package.

## The panel

One activity-bar container with a single **webview** view (`cgremlin.items`, `"type": "webview"`)
holding four lists. It is a webview rather than a `TreeView` because a tree cannot render two-line
card rows, badges, a collapsible group or an inline sort control. Under `font-src 'none'` there are
no codicons, so every glyph is a unicode character.

| List | What is in it |
|---|---|
| **Parking lot** | My teammates' open, non-draft PRs, in three ordered groups: **Reviewing** (we already have a review agent on it) pinned on top, then **Untouched** — the ones the eye should land on — then a collapsed **Someone is on it**. Only real human activity demotes a row into that last group: a bot's review does not, and neither does a pending **review request** (the row still says who was asked) |
| **My dev work** | Jira tickets assigned to me ∪ my open PRs ∪ my investigation / development / respond sessions, merged into one row per piece of work |
| **Investigations** | The work whose only agent is an investigation, with no PR and no ticket. A ticket-linked investigation is a commitment to deliver, so it lives in My dev work instead |
| **PRs waiting for review** | My own open PRs, lighting up when a review arrives |

A **review agent never moves a teammate's PR into My dev work** — it is still their PR, and it
belongs at the top of the parking lot. A **draft is in no list at all**, mine included. Each list
remembers its own sort (persisted in `globalState`); the parking lot's default is untouched-first
then oldest.

### What a row says before you click it

A row is two lines (three in My dev work) of **cells**, not a sentence that clips:

- the title, prefixed by `owner/repo#n` on a parking-lot row, plus a badge per agent;
- `@author · age · **tier** · size · CI · review decision · who is on it`.

The **tier** is the engine's own `S`/`M`/`L`/`XL` verdict, and it is the worse of two independent
readings — by file count and by lines changed — so a one-file 1800-line generated diff is not an
`S`. Hovering it shows the raw `N files +A/−D`. A field the scan does not have renders `—`; no row
anywhere claims `0 files` or a date it does not know. CI is a coloured **dot** with a tooltip
rather than an emoji, because emoji size inconsistently in a 300 px sidebar.

### One click, three consequences

Clicking a row **selects** it (a persistent highlight, distinct from the keyboard's focus ring),
**expands** it in place — an accordion: at most one row is open, and the choice survives a reload —
and **swaps the managed workspace** to that item's current worktree. They are one message on the
wire because they are one act; a row with no session swaps nothing rather than guessing.

The expanded row shows three things:

- the **lifecycle**, always as three slots — 🔍 Investigation → 🔨 Development → 🔎 Review — each
  reading `not started`, `running · <phase>`, `needs you · <phase>` or `done · 2h`. A missing stage
  is information; a list of the agents that happen to exist changes shape per row and cannot be read
  at a glance;
- **changes so far**, from `GET /sessions/:id/changes`: what the session has **committed** (against
  the merge base, so a moved base does not inflate it) and what is still only in its **working
  tree**;
- the **parts** — the ticket and each PR, each clickable on its own. The agents are the slots, so
  they are not listed twice.

### Forward only

The lifecycle is investigation → development → review, and a row offers **only the stage after the
furthest one it has reached**. A PR *is* the development stage's output, so a row with a PR offers
*Start review* — spelled **Start self-review**, and sent with `selfReview: true`, when the PR is
your own — and never *Start development* or *Start investigation*. A parking-lot row offers
*Start review* alone: on somebody else's branch the other two verbs could only ever produce a
nonsensical session, and a button whose only outcome is a 409 is what made the old panel
untrustworthy. The rule lives in one module, and each lifecycle slot takes its button **from the
row's own actions**, so the two cannot disagree.

There is exactly **one** visible primary button per row. Everything else — opening the PR, opening
the ticket, acknowledging — is behind `⋯`, which overlays rather than pushing rows down, closes
when another opens, and dismisses on `Escape`, on an outside click and on a scroll.

Row content crosses the message channel as **data**, never as markup: the script sets every string
with `textContent`, the one `innerHTML` assignment is markdown-it's output, and the CSP carries no
`unsafe-inline`. Rows are reconciled by key across renders, so a refresh never moves the node under
the pointer, drops focus or closes the open `⋯`.

## The Item tab

Opening a row (or one of its parts) opens **one** editor tab for that piece of work, moves the
managed workspace to the selected agent's worktree, and lets you switch between the agents attached
to the item. It has three focuses:

- **an agent** — its artifacts, newest first, rendered as markdown, with the bodies arriving over
  `postMessage` (never as a file URI);
- **a PR** — state, review decision, CI, diff size, per-reviewer summaries;
- **the ticket** — the Jira summary, description and latest comments, **as text**: no HTML ever
  reaches the extension.

Opening an item and switching agents is *browsing*: neither claims the agent conversation. Only
the chat terminal does. A **window reload closes the tab** — by design; reopen it from the panel.

## The respond flow

Clicking a **PRs waiting for review** row (or "Address review comments") creates a `respond`
session, **starts its run**, and swaps the workspace to that PR's worktree — no claim, no terminal
yet. Once the run has written a brief carrying every review thread, the CI, the diff summary and
the ticket, the phase moves to `addressing` and the row offers **Chat**, which opens Claude on that
session.

**Where v1 stops:** nothing posts to GitHub. The agent does not reply to a comment, resolve a
thread, push, or mark the PR ready. It works the threads into `COMMENTS.md` — one verdict and one
drafted reply per thread — and commits any fix locally, for a human to review and paste.

## When a source is degraded

The ticket source and the review threads are background legs of the engine's scan, and the panel
says so rather than quietly showing stale rows:

- **Jira rejected the token** (`401`/`403`) — a banner above the lists **and** a status-bar
  warning, because it is the one state a restart will not fix. Run
  `cgremlin-core config check-jira` for Jira's own wording.
- **Jira (or the thread scan) is unavailable** — a banner saying the rows are the last ones that
  were scanned. The PR half of the panel is unaffected.
- **Jira is not configured** — nothing at all is said. A permanent red banner for somebody
  mid-setup would be worse than the missing tickets.
- **The engine cannot answer `GET /items`** (an engine older than this extension) — the lists are
  replaced by one row that says so, with **Restart the engine** on it. Four empty lists that
  silently mean "the engine cannot answer" is the failure this exists to end.

## Install / build / run

```sh
pnpm install
pnpm test              # vitest, no editor harness — unit only, test/integration/** excluded
pnpm test:integration  # builds ../core and its bundles, then drives real engines on temp sockets
pnpm test:all          # both, in that order
pnpm build             # ../core's engine bundles, then tsc -p tsconfig.json -> out/
pnpm package           # build, then `vsce package --no-dependencies` -> cgremlin-vscode-<version>.vsix
pnpm lint
```

`pnpm build` builds **the engine first** (`pnpm --dir ../core build:engine`, two esbuild bundles
into `engine/`) and only then compiles the extension, so `out/` without `engine/` is not a state
a build can leave behind. `engine/` and the `.vsix` are gitignored artifacts.

**Unit vs. integration.** `test/integration/**` is split into its own `vitest.integration.config.ts`
and its own `pnpm test:integration` script — `pnpm test` (`vitest.config.ts`) never touches it, so a
plain unit run stays fast and has nothing real to leak, whether or not `../core` happens to be built.
The integration config runs with `pool: 'forks'` and `fileParallelism: false`: each file gets its own
process and files run one at a time, because two real engines racing for CPU and file descriptors is
exactly what made a couple of the real-process cases flaky before this split (see the `STOP_TIMEOUT` /
`RESTART_TIMEOUT` comments in `test/integration/engine-manager.test.ts` and `real-engine.test.ts`,
sized past the manager's real 45 s `STOP_BUDGET_MS`, with one retry as a last-resort net). A
`globalSetup` (`test/integration/global-teardown.ts`) backstops all of it: after every integration
file has finished, it `pgrep`s for any `engine.js serve --config <cgvsc-* temp stateDir>` process still
alive and fails the whole run loudly if it finds one — that means some test's cleanup didn't run.

`test/integration/real-engine.test.ts` drives `CoreClient`, `SseClient` and the whole host wiring
against a real engine — that is what proves the structural `*View` types here match what the engine
really returns, and it holds the committed `/items` fixture to the live response's key shape.
`test/integration/panel-flows.test.ts` does the same for the Phase 10 panel against a **real git
worktree**: one click producing exactly one workspace swap and one `GET /sessions/:id/changes`, the
committed and working-tree counts of a real commit and a real dirty file, twenty irrelevant frames
costing the open row nothing, and `Start self-review` really creating a review session on the user's
own PR. `test/integration/engine-manager.test.ts` boots the engine the way the editor does, through
the real `EngineManager` and the bundled `engine/engine.js` — including the build-id handshake and
the single restart it earns — and `test/integration/config-chmod-storm.test.ts` reproduces the
restart storm across two windows. All of them skip themselves with a clear message when the bundles
have not been built.

Then either:

- **F5** in VS Code (with **this folder** open) launches an Extension Development Host with the built
  extension loaded (`.vscode/launch.json`), or
- package it and install it into a real VS Code: `pnpm package` (from this directory), then
  `code --install-extension cgremlin-vscode-<version>.vsix`. The `.vsix` carries the engine; there
  is nothing else to install and no `cgremlin-core` on `PATH` to arrange.

There are **no runtime dependencies** (`package.json` has no `dependencies` key), and the `.vsix`
carries no `node_modules/`. `out/*.js` loads directly in the extension host, unmodified; the two
**webview** entry points are bundled separately by esbuild into `media/item-tab.js` and
`media/panel.js` (with `markdown-it` inside them), which `build` and `vscode:prepublish` both run.
`esbuild` and `markdown-it` are devDependencies and never ship as packages.

**No `@vscode/test-electron`.** This package has no Electron-hosted test suite — the purity split
above plus the integration suite cover the policy and client layers, but the actual VS Code surface
(the webview's own rendering, the modal, the workspace swap as the user sees it, the terminal) and
the paths that need a real `gh` or a real agent still need a human pass: run the manual smoke
checklist in [`docs/SMOKE.md`](docs/SMOKE.md) before calling a change to this package verified.
Three things in particular have **no** automated coverage anywhere and only that pass can answer: a
live `claude --resume` (step 9.2), a live Atlassian instance (section 14), and what a real
`gh api graphql` costs over two idle ticks (step 10.12).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cgremlin.configPath` | `~/.cgremlin-core/core.json` | the engine's `core.json`; every other path (socket, log, sessions, worktrees) is derived from it by the engine's own config loader |
| `cgremlin.notificationLevel` | `needs-you-only` | `needs-you-only` \| `off` — `needs-you-only` is the panel's needs-you strip, the view badge and the status-bar count. `off` is silent. Neither raises a popup: a stored `all` from an older version is read as `needs-you-only` and said once in the output channel |

## Commands

All under the `cgremlin` category. The row actions are decided by the **host** and sent to the
webview as data — which ones apply is a rule about the work, not about a `contextValue` string —
so most are hidden from the command palette (`when: "false"`) and appear only where they make
sense. A button whose only outcome is a 409 is never offered.

| Command | What |
|---|---|
| Open item | opens the Item tab for that row, and swaps the managed workspace to the selected agent's worktree |
| Open part of an item | the same tab, focused on one child — an agent, the ticket, or one PR |
| Address review comments | on my own non-draft PR: creates a `respond` session **and starts its run** |
| Chat with the agent | opens a terminal in the item's worktree running `claude --resume <id>` (or `codex resume <id>`), claiming the conversation and re-claiming it every `humanTurnTtlMs / 3` while the terminal stays open |
| Start review | starts (or opens) a review for a parking-lot row that is not mine and has no review agent yet |
| Approve plan | approves a ready investigation plan |
| Stop run | stops the active run on a session |
| Retry stage | re-runs the last stage |
| Acknowledge | one `POST /items/<path>/ack`; the engine fans it out over every ref the row contributes |
| Refresh inventory | triggers `POST /prs/scan` |
| New investigation… / New development session… / New review from PR URL… | the three session-creation flows (quick-picks / an input box; repo choices come from `GET /config`'s `repos`) |
| Start the engine | starts the bundled engine, detached, if nothing answers on its socket — offered by the not-running UX below |
| Stop the engine | asks first (the engine is shared by every window, and stopping it stops whatever is running), then sends one `SIGTERM` to a pid it has just proved is the engine's |
| Restart the engine | stop, then start; it never spawns while the socket still answers |
| Show the engine log | reveals the output channel and offers to open `engine.log` |

## One worktree folder at a time

The extension manages a multi-root `cgremlin.code-workspace` file that holds **exactly one** repo
folder — the worktree of the most recently opened session. Opening a different session **swaps** it
(`updateWorkspaceFolders(0, 1, {uri})` in one call: the old folder is removed, closing its editors,
and the new one added) rather than accumulating folders. There is no pinning or LRU in v1, which is
why the status bar always names the session whose repo the window currently holds — that is
load-bearing, not decoration. A dirty editor inside the folder being removed triggers a confirmation
modal before the swap; the preview still opens either way.

## Engine not running

Every request that can't reach the socket (`ENOENT`/`ECONNREFUSED`) becomes an `EngineNotRunningError`
rather than a stack trace: the status bar shows `$(circle-slash) cgremlin: offline`, and its command
offers **Start the engine** instead of opening the panel — which starts the engine this extension
ships, detached, rather than asking the user to have `cgremlin-core` on their `PATH`.

The extension starts that engine itself on activation, and the engine is a machine-wide singleton
keyed by its socket: a window that finds one already answering **adopts** it, and closing a window
never stops it. The status bar carries the engine's own state while it is not simply healthy —
`starting…`, `stopping… Ns`, `engine failed — see log`, `version mismatch`, `another server on this
socket` — and a click goes to the engine log or to **Start the engine**.

## The bundled engine

The `.vsix` carries the engine: two esbuild bundles of `cgremlin/core`, `engine/engine.js` (spawned)
and `engine/bridge.js` (`require`d in-process to resolve paths and read the bundled version). There
is no separate install step, no `cgremlin-core` on `PATH`, and no second copy of the engine's
config logic — the extension derives no state path of its own.

- **One setting.** `cgremlin.configPath` names `core.json`; `stateDir`, the socket, the log, the pid
  file, `sessions/` and `worktrees/` all come from one call into the bridge. Changing the setting
  takes effect without a window reload.
- **Detached, and shared.** The engine is started with the same posture the engine itself uses for
  its own children (`detached`, output to a file, `unref`), so it outlives the window that started
  it. It is a machine-wide singleton keyed by its socket: a window that finds one answering
  **adopts** it, `engine.json` admits exactly one engine per state dir, and **closing a window never
  stops the engine**. `Stop the engine` therefore asks first, and says how many items are running.
- **The log.** Everything the engine writes goes to `<stateDir>/engine.log`, tailed into the
  cgremlin output channel from the point activation began (never a replay of old content). Past
  8 MB it is rotated to `engine.log.1`, before the next start recreates it. `Show the engine log`
  reveals the channel and offers to open the file.
- **The version handshake, and the build id.** Every probe reads `GET /version` and compares two
  things: the version **and** the `buildId`, a content address of the bundle. The version alone was
  not enough — `ENGINE_VERSION` is the package's and stayed `0.0.1` across two phases of engine
  changes, so a stale engine looked identical and was adopted, and then had no `/items` on it for as
  long as it kept running. When only the build differs the message names the two **build ids**,
  because two identical version strings say nothing. Given a mismatch the extension does **not**
  race it or kill it: with nothing running it restarts it silently and says so in the output
  channel; with work in flight it asks, in a modal naming both builds and the number of items a
  restart would stop, and remembers `Not now` for the rest of the window.
- **An upgrade costs exactly one restart.** The `core.json` watcher is **content-addressed** — it
  restarts on a change of bytes, never on a bare filesystem event, because on macOS a `chmod` of a
  watched file is an event for it and a window that re-asserted the mode after each event fed itself
  at the period of one engine restart. On top of that, an **automatic** restart is spent once per
  engine identity (`pid@startedAt`): the same decision arriving twice about the same running engine
  is refused, with the reason logged. A person is never refused.
- **A dropped stream is not immediately "offline".** The event stream drops on every restart and
  every hiccup, and the consumer reconnects on a 1/2/5/10 s backoff — so the drop has to last **8 s**
  (past the third reconnect) before anything is said, and anything that gets through clears it. The
  last snapshot stays on screen throughout: four empty lists would claim something the extension does
  not know.
- **What it will never do.** It never unlinks a socket (stale-socket recovery is the engine's own
  job), never sends `SIGKILL` or a second signal, and never signals a process it cannot prove is
  this engine: `engine.json` and `GET /version` must agree on both the pid and the boot time,
  re-checked immediately before the signal. If they disagree, nothing is signalled and the reason
  is reported.
- **The child's environment.** `PATH` is resolved from your login shell (`$SHELL -lic 'echo $PATH'`,
  5 s cap), because a GUI-launched editor's `PATH` need not contain `claude` or `gh`; `NODE_OPTIONS`
  and every `VSCODE_*` key are stripped, and the engine scrubs the same keys from its own
  environment at startup so nothing it spawns can inherit them.
