# cgremlin/core

`cgremlin/core` is the headless engine behind a local, isolated-workspace, agent-driven
workflow: **investigate → plan → develop**, plus independent **PR review / re-review**. It
runs as one local process (`cgremlin-core serve`), owns session state, git-worktree
isolation, agent invocation, and (optionally) a local dev server + Vercel preview per repo.
There is no hosted backend and nothing in this package renders HTML — the engine's own output is
JSON over a Unix socket and Server-Sent Events (`GET /events`), never markup. Frontends talk to it
over that API: a CLI (below), and `cgremlin/vscode`, the VS Code extension that is Phase 7's UI
(mission control — four attention lists, needs-you notifications, and a chat hand-off into the
agent's own transcript; see `../vscode/README.md`).

It is a ground-up, tested rebuild of the ideas in `bin/cgremlin` (the legacy ~15,000-line
bash script). It does not share code or state with `bin/cgremlin`.

## Quick start

```bash
cd cgremlin/core
pnpm install
pnpm build

# First run: write a loadable core.json (repos: [], to be filled in by hand or by the editor)
cgremlin-core config init --me <your-github-login>

# Optional, one-time: import repos/authors/model from the legacy ~/.cgremlin/config.
# That legacy path is the ONLY thing this command reads, and nothing else in the engine
# ever touches ~/.cgremlin.
cgremlin-core config import-legacy

# Start the engine (foreground; Ctrl-C / SIGTERM stops it cleanly)
cgremlin-core serve [--config path] [--verbose]
```

With the engine running, in another shell:

```bash
cgremlin-core prs [--json]                # current PR inventory, grouped
cgremlin-core review <pr-url>              # start (or report) a review for one PR
cgremlin-core sessions [--json]            # list every session
cgremlin-core scan [--json]                # run one inventory scan right now
cgremlin-core local start <session-id> [--fresh]      # start needs a session
cgremlin-core local stop|status [session-id] [--json]  # id optional: engine-wide
cgremlin-core release <session-id>         # drop a human-turn claim (see "Human turn" below)
```

`cgremlin-core --help` prints the same summary. Every command other than `serve` and
`config` is a thin client: it loads `core.json`, makes one request over the Unix socket,
and prints the result.

## Config file: `~/.cgremlin-core/core.json`

Written by `config init`, by `config import-legacy`, or by hand. Validated with zod
(`src/config/core-config.ts`); an invalid file fails `serve`/every CLI command with a
one-line error. Paths may start with `~`.

| Field | Default | Notes |
|---|---|---|
| `repos` | `[]` | `["owner/name", …]` — repos the inventory scan watches. **May be empty**: the scan then has nothing to list, the parking lot is empty, and nothing is discovered — the engine is still fully usable for sessions you create explicitly. A PR in a repo that is **not** in this list is invisible to the panel **even if it requests your review** — the scan is per-repo, so there is nowhere for it to turn up. Add the repo, or use `POST /reviews {prUrl}` / `cgremlin-core review <url>` for a one-off |
| `watchAuthors` | `[]` | logins whose reviews/comments count as "team activity" |
| `me` | *(required)* | your GitHub login; own PRs are never auto-reviewed |
| `runner` | `'claude-code'` | or `'codex'` |
| `runnerOptions.model` | — | passed to the runner |
| `runnerOptions.permissionMode` | — | Claude Code only |
| `runnerOptions.sandbox` | — | Codex only: `read-only` \| `workspace-write` \| `danger-full-access` |
| `pollIntervalMs` | `60000` | inventory-scan cadence |
| `prListLimit` | `50` (max `100`) | `gh pr list --limit` per repo |
| `stateDir` | `~/.cgremlin-core` | base dir; every path below derives from it unless overridden |
| `sessionsDir` | `<stateDir>/sessions` | |
| `worktreesDir` | `<stateDir>/worktrees` | |
| `mirrorsDir` | `<stateDir>/mirrors` | |
| `socketPath` | `<stateDir>/engine.sock` | |
| `inventoryPath` | `<stateDir>/inventory.json` | |
| `localAppStatePath` | `<stateDir>/local-app.json` | |
| `attentionAcksPath` | `<stateDir>/attention-acks.json` | per-`ItemRef` acknowledgement store |
| `enginePidPath` | `<stateDir>/engine.json` | the running engine's identity file — and the lock that admits one engine per state dir |
| `engineLogPath` | `<stateDir>/engine.log` | where a detached engine's output goes (rotated to `engine.log.1` past 8 MB by whoever spawns it) |
| `reviewSkillCommand` | `'/APFM:apfm-review'` | slash command the review/rereview prompt invokes first |
| `humanTurnTtlMs` | `600000` (10 min) | how long a human-turn claim (`POST /sessions/:id/conversation/claim`) stays live before it expires and is reaped |
| `includeLiveUiCheck` | `true` | AND'd with "did the brief actually render a LIVE UI CHECK section" |
| `defaultBaseRef` | `'origin/main'` | base ref for a new investigation's worktree |
| `botLogins` | the built-in list | logins **added to** (never replacing) `github-actions`, `dependabot`, `renovate`, `codecov`, `vercel`, `sonarcloud`, `coderabbitai`, `copilot-pull-request-reviewer`. A bot review or comment must not make a PR look like somebody is already on it |
| `showAllRepoPrs` | `false` | drop the `watchAuthors` filter from the parking lot. The "not mine" exclusion is never dropped |
| `jira` | *(absent)* | the read-only ticket source — see below. Absent means `ticketSource.kind` is `notConfigured`, which is not an error and makes no request |
| `jiraCachePath` | `<stateDir>/jira.json` | last completed Jira scan |
| `reviewThreads.scanBudgetMs` | `20000` | the whole review-thread leg's budget for one tick |
| `reviewThreadsCachePath` | `<stateDir>/review-threads.json` | review threads, keyed `"<repo>#<n>"` by the PR's `updatedAt` |
| `environments` | `{}` | per-repo environment config, keyed by `owner/name` — see below |

A field left unset in the file falls back to its default at load time; `config
import-legacy` and any code that re-persists `core.json` omit a value that is exactly the
derived default, so changing `stateDir` later still moves everything under it.

### The `jira` block

Read-only, always. The engine never writes to Jira.

```jsonc
{
  "jira": {
    "siteUrl": "https://aplaceformom.atlassian.net",
    "email": "guilherme.azoubel@aplaceformom.com",
    "apiToken": "<the one thing you must supply>",
    "projectKeys": ["HB", "WEB"]
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `siteUrl` | *(required)* | your Atlassian site. **Every browse URL is built from this**, never from `baseUrl` |
| `email` | *(required)* | the account the token belongs to; the credential is `email:apiToken`, basic auth |
| `apiToken` | *(none)* | **the one thing you must supply.** Create it at id.atlassian.com → Security → API tokens. Without it the whole Jira leg is `notConfigured` and makes no request |
| `projectKeys` | `[]` | **required for linking.** Empty means PR↔ticket linking is *disabled*, not unfiltered: the bare key regex happily links `SHA-256`, `UTF-8` and `PR-123`, and a wrong merge puts two unrelated PRs on one row. The engine logs `ticket linking disabled: set jira.projectKeys in core.json` once per process |
| `jql` | `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC` | which tickets are "mine". **To follow the current sprint instead**, change this one string to `assignee = currentUser() AND sprint in openSprints()` |
| `extraFields` | `[]` | instance-specific issue fields to request. They go **here and nowhere else**: an unknown field name makes Jira 400 the whole request, which is why `acceptance_criteria` and `customfield_10016` are not in the default set |
| `maxResults` | `50` (max `100`) | page size for the JQL search |
| `timeoutMs` | `15000` | per HTTP request |
| `scanBudgetMs` | `20000` | one budget for the **whole** Jira leg of a tick (whoami plus every page). The leg runs after the PR half is published and is never awaited, so a slow Jira cannot hold up `POST /prs/scan` |
| `baseUrl` | `siteUrl` | override the API host (a test stub, a proxy). Browse URLs still come from `siteUrl` |

Check the credentials without starting the engine:

```bash
cgremlin-core config check-jira
```

It calls `GET /rest/api/3/myself` and, on failure, prints **Jira's own wording** — the only
thing that distinguishes a wrong token from a revoked one from a captcha challenge. The token
itself is never printed. A `401`/`403` shows up in the panel as a banner and a status-bar
warning (`ticketSource.kind: 'auth'`); anything else degrades to `unavailable`, which keeps the
last tickets that were scanned rather than emptying the lists.

### The `environments` block

Keyed by repo slug (`owner/name`). Each entry (`RepoEnvironment`) is entirely optional —
a watched repo with no entry gets no local app, no preview URL, and no LIVE UI CHECK
section in its briefs (there is no config flag for this; it is purely "was anything
resolved").

```jsonc
"environments": {
  "owner/repo": {
    "localApp": {
      "url": "https://local.example.dev",
      "port": 8080,                       // default 8080
      "devCommand": "pnpm dev",           // default
      "installCommand": "pnpm install",   // default
      "nodeVersion": "24",                // optional; run via `nvm use` in a login shell
      "healthTimeoutMs": 90000,           // default
      "healthIntervalMs": 2000,           // default
      "insecureTls": true,                // default
      "postInstallNonEmptyDirs": [],      // dirs that must be non-empty after install (e.g. generated API types)
      "stages": ["develop"],              // default — which stages get this local app
      "prereqs": {
        "hostsEntries": [],               // /etc/hosts lines that must be present
        "requiredFiles": [],              // files that must exist (e.g. an nvm/LaunchDaemon path)
        "requiredEnv": []                 // env vars that must be set
      }
    },
    "vercel": {
      "scope": "…", "project": "…", "previewProject": "…",
      "envFile": ".env.local",            // default
      "bypassSecret": "…"                 // optional — deployment-protection bypass secret
    },
    "clerk": {                            // optional; both fields default if omitted
      "testEmailTemplate": "uicheck-{key}+clerk_test@example.com",
      "verificationCode": "424242"
    },
    "previewStages": ["review", "rereview"]  // default — which stages get a Vercel preview URL
  }
}
```

`localApp.stages` and `previewStages` are independent and can overlap; `findings` can opt
into a local app too, it just isn't on by default.

### Secret handling

`environments[*].vercel.bypassSecret` and `jira.apiToken` are the only secrets `core.json` can
hold, and they are treated identically.

- `writeCoreConfig` writes it at file mode **0600**, set on the temp file *before* the
  rename — never a world-readable window.
- `loadCoreConfig` refuses to load a config that holds a secret if the file is group- or
  other-readable (`mode & 0o077 !== 0`): `chmod 600 ~/.cgremlin-core/core.json` and retry.
- Both are `[redacted]` in `GET /config` (`redactCoreConfig`), and either one on its own is
  enough to make `hasAnySecret` true — so a `core.json` holding **only** a Jira token is
  refused when it is world-readable.
- `jira.apiToken` is read in exactly one place, the REST adapter's `Authorization` header. It
  never reaches a URL, a log line, a brief, an event frame, an HTTP response or `jira.json`.
- The Vercel secret is never written into `BRIEF.md`, never logged, and never returned by the
  API. For a stage that needs it, the engine writes the raw value to
  `<sessionDir>/.bypass-secret` (mode 0600) and the brief points the agent at that file;
  it is deleted when the stage's environment is torn down. `.bypass-secret` is not a
  readable artifact (`GET /sessions/:id/artifacts/.bypass-secret` is a 400).
- Every other text path that could carry a bypass URL (the verbose `run.output` log,
  every `LocalAppStatus.logTail` the API returns) has occurrences of
  `x-vercel-protection-bypass=<value>` rewritten to `<redacted>`.
- **Residual risk, accepted deliberately**: the agent itself puts the secret in a URL or
  header to reach a protected preview, so it appears in that session's own agent
  transcript and in its browser-tool call arguments. Nothing in this package protects
  against that.

## API surface (Phase 7 additions)

Beyond session/workspace/PR-inventory routes, the socket API also answers:

| Route | What |
|---|---|
| `GET /events` | Server-Sent Events — every engine event, with `Last-Event-ID` replay |
| `GET /attention`, `POST /attention/ack` (+ `POST /sessions/:id/ack`, `POST /prs/:o/:r/:n/ack`) | which items need attention/you, and acknowledging one |
| `GET /version` | `{version, pid, startedAt, socketPath, activeRuns}` — dependency-free, so it answers **200 on any engine**, which is what makes it a liveness/identity probe (`GET /config` 404s on an engine built without a config dep). `activeRuns` counts active stage runs **plus** environment preparations still in flight, and is computed per request: it is the only input to "is it safe to restart?" |
| `GET /config` | the resolved, redacted `CoreConfig` |
| `GET /sessions/:id/artifacts` | artifact listing with mtimes and the core-chosen `primary` file |
| `GET /sessions/:id/conversation`, `POST .../conversation/claim`, `POST .../conversation/release` | the human-turn claim/release/resume contract |
| `POST /sessions/developments` | create a development session directly (no investigation, starts nothing) |
| `GET /items`, `GET /items/<path>` | the four **work-item** lists (parking lot / my dev work / investigations / PRs waiting for review) and one item's detail, including its Jira ticket as text. Pure reads — they start nothing |
| `POST /items/<path>/ack`, `POST /items/<path>/agents` | acknowledge a work item (the fan-out over every contributing ref is server-side), or put an agent on it — `{mode: 'respond'}` creates **and starts** a session that addresses the reviews on your own PR |
| `POST /reviews` `{prUrl}` | review **any** PR URL, including a repo outside `config.repos` — this is the only way to review an off-config repo; an already-tracked PR answers **200** `{created:false}` (matching `POST /prs/:o/:r/:n/review`'s own behavior), a genuinely new one **202**, and a PR authored by `config.me` **409** |

Full request/response shapes, status codes and the event/attention/human-turn models are in
`docs/ARCHITECTURE.md`.

## What runs automatically vs. only on request

**Automatic**, once `serve` is running:
- An **inventory scan** every `pollIntervalMs` (default 60s): lists open PRs on every
  watched repo, groups them (unreviewed / team-on-it / ours / mine), and persists
  `inventory.json`.
- As part of that same scan, **reconciliation of PRs the engine is already tracking**: a
  review session whose PR merged or closed is dismissed (and its source development
  session marked merged/abandoned); one whose PR was approved on GitHub is marked
  approved; one whose PR has new commits since the last review is **automatically
  re-reviewed**.
- As part of that same scan, but **after** it publishes and never awaited by it, two
  background legs: a **Jira scan** (the configured JQL, `jira.json`) and a **review-thread
  scan** (`gh api graphql`, `review-threads.json`, only for the PRs the fetch policy names and
  only when the PR's `updatedAt` has changed — a steady-state tick makes zero GraphQL calls).
  A slow or broken Jira therefore cannot hold up `POST /prs/scan`, and a failed leg keeps the
  previous cache rather than emptying it.
- An **attention state change or an artifact write becomes an event**: `AttentionService`
  recomputes on every relevant engine event and on a filesystem watch of `sessions/` (so an agent
  writing `AGENT_STATE`/`FINDINGS.md` mid-turn is seen without waiting for the turn to exit), and
  emits `attention.changed`/`artifact.changed` on `GET /events` for any connected client.

**Only on explicit request** — nothing else ever starts an agent:
- Starting a review for a PR not already tracked (`cgremlin-core review <url>`, or
  `POST /prs/:owner/:repo/:number/review`).
- Every stage of the investigate → plan → develop pipeline (`POST /sessions/:id/run`,
  `/promote`, `/approve-plan`).
- Starting/stopping the local dev app (`cgremlin-core local start|stop`).

The reconciliation tick **never creates a session** and **never starts a first review**
for a PR the engine doesn't already have a session for — that discovery-and-autostart
behavior was deliberately retired (see `docs/DECISIONS.md`).

## Where state lives

Everything is under `stateDir` (default `~/.cgremlin-core` — the legacy `~/.cgremlin` is
never read except by `config import-legacy`, and never written at all):

```
~/.cgremlin-core/
  core.json                    # config (0600 if it holds a secret)
  engine.sock                  # the API socket serve listens on (mode 0600)
  engine.json                  # {pid, version, socketPath, startedAt} — written with O_EXCL
                               # BEFORE the socket is opened, so it is both the ownership proof
                               # and the lock that admits one engine per state dir; removed on stop
  engine.log                   # a detached engine's stdout+stderr (engine.log.1 after a rotation)
  inventory.json               # last completed scan
  jira.json                    # last completed Jira scan (never holds the API token)
  review-threads.json          # review threads per PR, keyed by the PR's updatedAt
  local-app.json               # the one local dev app's state, if any is running
  attention-acks.json          # per-ItemRef acknowledgement ('session:<id>' / 'pr:<owner>/<repo>#<n>')
  sessions/
    <session-id>/
      session.json             # the session record (schemaVersion 2)
      BRIEF.md                 # what the engine told this stage's agent to do
      FINDINGS.md               PLAN.md               DEVELOPMENT.md
      REVIEW.md                 REVIEW-v2.md, REVIEW-v3.md, …   RE-REVIEW.md
      COMMENTS.md               # respond mode: one verdict per review thread, replies drafted
      AGENT_NOTE                AGENT_STATE            PR_URL
      rereview_summary
      .bypass-secret            # present only mid-stage, for a repo with a Vercel secret
      logs/
        dev-server.log          # this session's local-app dev-server output, if it ran one
  worktrees/
    <session-id>/               # git worktree the agent runs in
  mirrors/
    <mirror-dir>/                # one bare/mirror clone per repo, shared by all its worktrees
```

`GET /sessions/:id/artifacts/:name` exposes a fixed allow-list of the files above
(the `.md` files including `COMMENTS.md`, `AGENT_NOTE`/`AGENT_STATE`, `PR_URL`,
`rereview_summary`) — nothing else,
and `.bypass-secret` is explicitly excluded.

## Troubleshooting

- **`engine is not running (no socket at <path>); start it with cgremlin-core serve`** —
  every CLI command that talks to the engine prints exactly this when it can't connect;
  it means no `serve` process is listening on that socket path.
- **`Another process is already listening on '<socketPath>'`** — `serve` refuses to start
  a second time against the same socket; stop the other instance or use a different
  `socketPath`.
- **A local-app port is held by something else** — `cgremlin-core local start` reports
  one of two distinct messages: *"held by a local app this engine started … run
  `cgremlin-core local stop`"* (safe to stop) vs. *"held by pid `<pid>`, which the engine
  did not start — it will not be killed; stop it yourself or change `localApp.port`"*.
  The engine never kills a process it did not start itself.
- **A prerequisite failed** — `local start` reports the specific missing prerequisite
  (a missing `/etc/hosts` entry, a missing required file, an unset required env var, or
  `vercel whoami` failing) with the legacy wording, or — if the dev command itself exited
  before its health check passed — the first 40 lines of its log, so you can read the
  repo's own refusal message. The engine never edits `/etc/hosts`, configures a
  port-forward, or installs `nvm` versions on your behalf.
- **Legacy sessions under `~/.cgremlin/sessions`** (the legacy tool's own state dir, which this engine neither reads nor writes) — a `migrateLegacySession` function
  exists (`src/migrate/legacy-session-migrator.ts`) but nothing in this package calls it
  yet. A directory shaped like a legacy session (no `schemaVersion`) is not picked up by
  `SessionStore.list()` — it fails schema validation and is silently skipped rather than
  migrated. Real migration is Phase 6 work; see `docs/DECISIONS.md`.

## What is NOT there yet

- **Posting anything to GitHub.** The engine only ever calls read-only `gh`/git. Turning
  a `REVIEW.md` into posted PR comments (or approving/merging/closing a PR) is deferred
  to a future, separate component that would take structured input (a verdict and
  per-finding `{path, line, body}`) — it would not itself read or know `REVIEW.md`'s
  format.
- **A UI in this package.** The originally-planned local web dashboard was dropped in favor of a
  CLI plus `cgremlin/vscode`, both consuming the same API — nothing in *this* package renders HTML
  (Server-Sent Events are not markup either).
- **Own-PR comment triage.** Reading/replying to comments on your own PRs is a distinct,
  unbuilt feature.
- **Legacy session migration.** See Troubleshooting above.
