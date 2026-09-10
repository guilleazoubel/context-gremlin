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

## Development

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
`../core` has not been built. Everything it cannot reach (the editor surface, and the paths that
need a real `gh` or a real agent) is in [`docs/SMOKE.md`](docs/SMOKE.md), the manual checklist from
spec §8.

Open **this folder** in VS Code and press F5 for an Extension Development Host
(`.vscode/launch.json`).

There are **no runtime dependencies** and there is no bundler: `out/*.js` loads directly in the
extension host.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cgremlin.socketPath` | `~/.cgremlin/engine.sock` | the engine's socket |
| `cgremlin.configPath` | `~/.cgremlin/core.json` | used only when starting the engine from the extension |
| `cgremlin.notificationLevel` | `all` | `all` \| `needs-you-only` \| `off` |
