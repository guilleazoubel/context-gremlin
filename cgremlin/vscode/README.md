# cgremlin — VS Code extension

Mission control for the [cgremlin engine](../core): four attention lists, needs-you notifications,
one managed worktree folder, and a chat hand-off into the agent's own transcript.

The extension is a **client**. It never scans GitHub, never spawns an agent and never derives state
the engine already owns — it reads the engine's Unix socket (`GET /config`, `/prs`, `/sessions`,
`/attention`, `GET /events`) and posts the actions the user asks for.

## Layout

| Path | Purity | What |
|---|---|---|
| `src/core-client.ts` | pure | the socket API: typed methods, `EngineNotRunningError`, `CoreHttpError` |
| `src/sse.ts` | pure | `GET /events`: frame parser plus a reconnecting consumer (`Last-Event-ID`, epoch, resync) |
| `src/model/*` | pure | wire types and the panel's policies |
| `src/ui/host.ts` | pure | the editor surface **as an interface** — every `ui/*` module takes one |
| `src/ui/*` | pure | tree, status bar, notifications, open-item, chat, refresh, commands |
| `src/settings.ts`, `src/extension.ts` | editor API | the only two modules that import `vscode` |

Pure modules must not import the editor API — that is what keeps the policy layer unit-testable
without an Electron harness, and it is enforced by the `MG-B1` guard in `test/purity.test.ts`.
`ui/*` is pure in the same sense: it is written against `Host`, and `extension.ts` is the single
adapter from the real `vscode` namespace to it. That is why the whole command set, the workspace
swap and the chat heartbeat have unit tests and no Electron test harness is anywhere near this
package.

## The panel

One activity-bar container with a single view (`cgremlin.items`) whose four roots are
`LIST_ORDER`: the parking lot, the PRs we are reviewing, investigations and dev work. One view (not
four) keeps a single `onDidChangeTreeData`, so an applied refresh is exactly one fire however many
lists changed. Row actions are bound by `contextValue` (`<list>:<source>:<mode>`), so a fifth
source needs a `LIST_ORDER` entry and a `when` clause — not a restructuring.

## Install / build / run

```sh
pnpm install
pnpm test              # vitest, no editor harness
pnpm test:integration  # builds ../core, then drives a real engine on a temp socket
pnpm build             # tsc -p tsconfig.json -> out/
pnpm lint
```

`test/integration/real-engine.test.ts` boots `cgremlin-core serve` as a child process and drives
`CoreClient`, `SseClient` and the whole host wiring against it — that is what proves the structural
`*View` types here match what the engine really returns. It skips itself with a clear message when
`../core` has not been built.

Then either:

- **F5** in VS Code (with **this folder** open) launches an Extension Development Host with the built
  extension loaded (`.vscode/launch.json`), or
- package it and install it into a real VS Code: `npx vsce package` (from this directory), then
  `code --install-extension cgremlin-vscode-<version>.vsix`.

There are **no runtime dependencies** (`package.json` has no `dependencies` key) and there is no
bundler: `out/*.js` loads directly in the extension host, unmodified.

**No `@vscode/test-electron`.** This package has no Electron-hosted test suite — the purity split
above plus the integration suite cover the policy and client layers, but the actual VS Code surface
(tree rendering, the workspace swap, the terminal) and the paths that need a real `gh` or a real
agent still need a human pass: run the manual smoke checklist in [`docs/SMOKE.md`](docs/SMOKE.md)
before calling a change to this package verified.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cgremlin.configPath` | `~/.cgremlin-core/core.json` | the engine's `core.json`; every other path (socket, log, sessions, worktrees) is derived from it by the engine's own config loader |
| `cgremlin.notificationLevel` | `all` | `all` \| `needs-you-only` \| `off` |

## Commands

All under the `cgremlin` category (command palette + the tree's row/title actions); most are bound
to a tree row via `contextValue` rather than exposed in the command palette (`when: "false"` there).

| Command | What |
|---|---|
| Open item | opens the item's primary artifact as a markdown preview, and swaps the managed workspace to its worktree |
| Chat with the agent | opens a terminal in the item's worktree running `claude --resume <id>` (or `codex resume <id>`), claiming the conversation and re-claiming it every `humanTurnTtlMs / 3` while the terminal stays open |
| Start review | starts (or opens) a review for a parking-lot/reviewing row |
| Approve plan | approves a ready investigation plan |
| Stop run | stops the active run on a session |
| Retry stage | re-runs the last stage |
| Acknowledge | posts `{ ref }` to `/attention/ack` for any row |
| Refresh inventory | triggers `POST /prs/scan` |
| New investigation… / New development session… / New review from PR URL… | the three session-creation flows (quick-picks / an input box; repo choices come from `GET /config`'s `repos`) |
| Refresh preview | re-runs the built-in `markdown.preview.refresh` |
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
