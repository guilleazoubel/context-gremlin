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
| `src/settings.ts`, `src/ui/*`, `src/extension.ts` | editor API | the only modules allowed to import the editor API |

Pure modules must not import the editor API — that is what keeps the policy layer unit-testable
without an Electron harness, and it is enforced by the `MG-B1` guard in `test/purity.test.ts`.

## Development

```sh
pnpm install
pnpm test        # vitest, no editor harness
pnpm build       # tsc -p tsconfig.json -> out/
pnpm lint
```

There are **no runtime dependencies** and there is no bundler: `out/*.js` loads directly in the
extension host.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `cgremlin.socketPath` | `~/.cgremlin/engine.sock` | the engine's socket |
| `cgremlin.configPath` | `~/.cgremlin/core.json` | used only when starting the engine from the extension |
| `cgremlin.notificationLevel` | `all` | `all` \| `needs-you-only` \| `off` |
