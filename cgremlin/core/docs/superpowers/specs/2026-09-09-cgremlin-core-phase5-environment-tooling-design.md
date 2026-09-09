# cgremlin/core Phase 5 — Environment Tooling: Design

Date: 2026-09-09
Status: **rulings confirmed by the supervisor 2026-09-09.** R3, R4, R6 and R11 are AMENDED by that
ruling (see the AMENDED tags); R13–R16 are new and carry the rest of it. No open questions remain.
Parent specs: `2026-08-28-cgremlin-core-rebuild-design.md` (§8, §11 Phase 5), `2026-09-04-cgremlin-core-phase4-pr-inventory-host-cli-design.md` (§6 CoreConfig — this phase EXTENDS that schema; no second config file)
Legacy grounding: `bin/cgremlin` lines 40–74, 515–633, 1149, 1430–1484, **1497–1660 (the REVIEW.md
output contract)**, 14182, 14348, 14393, 14557. Live grounding 2026-09-09 against
`aplaceformom/grace-frontend` (see §7).

## 0. Why

Phase 3 stripped the run-local / preview-verification steps out of the briefs and Phase 4 shipped a
typed `core.json` with no environment keys in it. The result: `renderReviewPrompt`
(`src/pipeline/prompts.ts:132`) tells the agent to run "the `## LIVE UI CHECK` section in CLAUDE.md",
and **cgremlin/core never writes a CLAUDE.md** — review sessions run with `brief: null`
(`src/pipeline/pipeline-service.ts:367`). The single most valuable behaviour of the legacy tool (a PM
+ Designer live UI pass on every review, and a running local app during development) is currently a
dangling pointer. Phase 5 restores it, with the engine owning environment **config** and the local
app **lifecycle**, and the agent still owning the browser.

## 1. Scope

**In**

1. Per-repo environment config inside `~/.cgremlin/core.json` (local URL/port/dev command/Node
   version, machine prereqs, Vercel scope/project/preview project/bypass secret, Clerk test-user
   pattern, which stages get a local app and which get a preview).
2. A `LocalAppRunner` port + `NodeLocalAppRunner` adapter + `FakeLocalAppRunner`, reproducing legacy
   `run_local`/`stop_local` (`bin/cgremlin:541`, `:560`).
3. An `EnvironmentService` owning: prereq checks, per-checkout setup (`vercel link` → `vercel env pull`
   → gitignore guard → `pnpm install`), single-owner start/stop/status, boot-time orphan reconcile,
   Vercel preview-URL derivation, and the bypass-secret handoff.
4. Brief changes: a `## Environment` block, the verbatim legacy `## LIVE UI CHECK` protocol, and (for
   review/rereview) the verbatim legacy **REVIEW.md output contract**, rendered into `BRIEF.md` for
   the findings, develop, review and rereview stages.
5. API: `POST /sessions/:id/local/start`, `POST /sessions/:id/local/stop`, `GET /sessions/:id/local`.
6. CLI: `cgremlin-core local start|stop|status [<session>]`.
7. Secret redaction on every text path that can carry a bypass URL: the verbose `run.output` log and
   every `logTail` returned by the API.

**Out**

- Browser driving. chrome-devtools / Playwright MCP stays in the agent; the engine never opens a page.
- Running the test suite for the user (`pnpm test` etc.) — the briefs already tell the agent to.
- `pnpm setup:local` (sudo: `/etc/hosts`, the 443→8080 LaunchDaemon, the portal hosts entry, the Caddy
  8443 forward). The engine **checks what it can** and otherwise reports the dev command's own refusal
  verbatim; it never runs sudo and never configures hosts, Caddy or nvm (R11).
- Storybook preview URLs (legacy mentions them only as an agent-side fallback; the fallback text is
  preserved in the brief, no engine support).
- Posting to GitHub (Phase 4 §9, still deferred).

## 2. Rulings

**R1 — `environments` is a map parallel to `repos`, not a restructuring of it.**
`CoreConfigSchema.repos` is `string[]` and is consumed as a plain slug list by `InventoryScanner`
(`src/host/build-engine.ts:126`) and produced by `importLegacyConfig`
(`src/config/core-config.ts:103`); turning it into an object would break the scanner config, the
importer and every existing `core.json`, whereas an optional
`environments: Record<repoSlug, RepoEnvironment>` is purely additive and lets a watched repo have no
environment at all.

**R2 — the Vercel bypass secret lives in `core.json`, which is written and enforced at 0600.**
Rationale: one config file is the Phase 4 contract and the legacy tool already kept this exact secret
in `~/.cgremlin/config` at `chmod 600` (`bin/cgremlin:123`; the real file on this machine has
`VERCEL_AUTOMATION_BYPASS_SECRET` and nothing else secret). This requires three additions to
`SessionFileSystem`: `writeFile(path, content, opts?: { mode?: number })`,
`statMode(path): Promise<number | null>` and `remove(path): Promise<void>` (R3 needs the last one).
`writeCoreConfig` writes the temp file with `mode: 0o600` *before* the rename, so there is no
world-readable window. `loadCoreConfig` throws `ConfigError` when the file is group- or
other-readable **and** any `bypassSecret` is set.

**R3 AMENDED — the secret is never written into `BRIEF.md`, never logged, never returned by the API.**
Instead, for a stage whose target needs it, the engine writes the raw secret to
`<sessionDir>/.bypass-secret` with mode 0600 and the brief says *"read the one-line secret from
`<sessionDir>/.bypass-secret`"*. The file is deleted (`fs.remove`) in the environment teardown
`finally` (R4). `.bypass-secret` is not in `ARTIFACT_NAME_PATTERN` (`src/api/validation.ts:86`), so
`GET /sessions/:id/artifacts/.bypass-secret` is a 400 by construction — a test pins this.
A `redactCoreConfig()` helper is used on every path that could serialize config.
**Amendment:** because the agent *will* echo bypass URLs into its own stdout, two more text paths are
redacted with `redactBypassUrls(text)`, which rewrites `/x-vercel-protection-bypass=[^&\s]+/g` to
`x-vercel-protection-bypass=<redacted>`:
(a) `serve`'s verbose `run.output` logger (`src/host/serve.ts:90`) — every chunk passes through it
before `logLine`; (b) every `logTail` the API returns (`LocalAppStatus.logTail`, `GET
/sessions/:id/local`). Both are tested. This makes §5's "`serve` stderr log" and "HTTP responses" rows
true rather than aspirational.
*Rejected alternative A:* inlining `?x-vercel-protection-bypass=<secret>` into the brief (legacy did
the moral equivalent by telling the agent to grep `~/.cgremlin/config`). Rejected because `BRIEF.md`
is a persistent artifact served over the API and copied into re-reads forever.
*Rejected alternative B:* injecting the secret as an env var into the agent process. Rejected because
`SessionContext` (`src/agent/agent-runner.ts`) has no env channel, adding one changes the Phase 2
contract for both adapters, and `Bash(echo $VAR)` puts it in the transcript anyway.
**Accepted residual risk, stated plainly:** the agent must put the secret in a URL or a request header
to navigate, so it *will* appear in that session's agent transcript and in chrome-devtools tool-call
arguments. That is inherent to "browser driving stays in the agent". What R3 buys is: not in
`BRIEF.md`, not in `inventory.json`, not in the engine's stderr log, not in any HTTP response, and
removed from disk when the run ends.

**R4 AMENDED — environment preparation happens BEFORE the per-session lock; the engine still starts
the app before the stage run and stops it after; agents never request it.**
The original R4 put `EnvironmentService.start` inside `runStageLocked`'s `preRun` callback. That is
**reversed**: preview-URL fetch, secret-file write and local-app start (including the up-to-90 s
healthcheck) all run **before** `this.lock.withLock` is entered in `runStageLocked`. Concretely:

1. `prepareEnvironment(id, stage, session)` runs unlocked. It performs I/O only outside the session's
   own state: `gh pr view`, `vercel link/env pull/install`, the spawn, the healthcheck, the
   `.bypass-secret` write and the `local-app.json` write. **It writes no session state** — no
   `store.save`, no `transition`, no session artifact — so it needs no session lock and cannot clobber
   a concurrent action's write.
2. The brief is rendered from the returned `EnvironmentBriefContext` **before** `runStageLocked` is
   called. Therefore `runStageLocked`'s `brief` parameter **stays `string | null`** — the
   brief-thunk change from the first draft is dropped entirely, and the file's locking-invariant
   comment (`src/pipeline/pipeline-service.ts:1–14`) needs no amendment: pre-run work under the lock
   is still only the eligibility re-check and the transition.
3. If the *locked* `preRun` throws (a lost eligibility race, `WorkspaceMissingError`), teardown still
   runs: stop the app if this call started it, and delete `.bypass-secret`.
4. Teardown lives in an **outer `finally` that sits OUTSIDE `runReview`/`runRereview`'s existing
   `try/catch` around `preRunCommitted`** (`pipeline-service.ts:366–386`, `:471–498`) and **takes no
   session lock**, so it can never deadlock against the final `lock.withLock` transition block and
   never masks the lost-race classification that `preRunCommitted` exists to protect.

*Rejected alternative A:* the agent calls `POST /sessions/:id/local/start`. Violates the standing
"agents never call back into the engine" ruling.
*Rejected alternative B:* a file-based request channel (agent writes `<sessionDir>/LOCAL_APP_REQUEST`,
engine polls). Rejected: a second control channel with its own poller, its own race with run
teardown, and no way to block the agent until the app is healthy.
*Rejected alternative C (the first draft):* start inside `preRun`. Rejected because it holds the
per-session lock for up to `healthTimeoutMs` (90 s) plus a cold `vercel link`/`env pull`/`pnpm
install` (~17 s measured, §7), blocking `POST /sessions/:id/stop` and every other action on that
session for the whole window — an engine you cannot stop for 107 s is worse than a slightly wider
start-to-`run.started` gap.
**Consequence to accept:** between `prepareEnvironment` returning and the lock being taken, a
concurrent action can move the session out of eligibility; the locked `preRun` then throws and
teardown stops the app we just started. That wasted work is the price of not holding the lock, and
point 3 makes it safe.

**R5 — a failed local-app start degrades the stage, it does not fail it.**
The brief gets `Local app: UNAVAILABLE — <reason>. Do not attempt to start it yourself; verify what
you can statically and say so in your output.` Rationale: legacy `run_local` returning 1 left the
agent to decide (`bin/cgremlin:630`); killing a 40-minute investigation because a dev backend was
briefly unreachable is strictly worse.

**R6 AMENDED — single instance, the engine never steals the port, and it reaps only its own orphans.**
One local app across all sessions, tracked in `<stateDir>/local-app.json` (legacy's
`$SESSIONS_DIR/.local_run`, `bin/cgremlin:516`). If the owner is this session and it answers 2xx →
reuse (legacy `:601`). If the port is held by anything else → `LocalAppPortBusyError`, degrade per R5.
This deliberately **diverges** from legacy, which killed the squatter (`bin/cgremlin:606`) while
warning that it might be the user's own dev server (`:605`). An engine running unattended must not
kill a process it did not start.
**Amendment (a) — boot-time orphan reconcile.** See R13.
**Amendment (b) — the port-busy error names which case it is.** Two distinct messages:
- the pid listening on the port is the pid **or** pgid recorded in `local-app.json` (i.e. a leftover
  the engine itself started, e.g. after a `kill -9` of the engine):
  `port <p> is held by a local app this engine started (pid <pid>, session <sid>) — run 'cgremlin-core local stop' to release it`;
- anything else:
  `port <p> is held by pid <pid>, which the engine did not start — it will not be killed; stop it yourself or change localApp.port`.
The second case never kills anything, ever.

**R7 — the Vercel preview URL is derived from the `vercel` bot's PR comment, not from the `vercel` CLI.**
Verified: legacy never calls the `vercel` CLI for this — its only three uses are `vercel whoami`
(`:534`), `vercel link` (`:579`) and `vercel env pull` (`:581`); the dashboard's
`vercel_preview_url_template` (`:9681`) defaults to `""` and is unused. Verified live (§7): the bot's
GitHub login is exactly **`vercel`** (not `vercel[bot]`); its comment body begins with
`[vc]: #<hash>:<base64>` and the base64 decodes to `{ isMonorepo, type, projects: [{ name, projectId,
rootDirectory, inspectorUrl, previewUrl, nextCommitStatus, liveFeedback }] }`, where `previewUrl` is
a bare hostname (`grace-frontend-dev-git-<branch-slug>.preview.findcare.dev.aplaceformom.com`) **and
may be `null`**. Also verified: the Vercel entry in `statusCheckRollup` carries only the **inspector**
URL (`https://vercel.com/<scope>/<project>/<id>`), NOT the deployment URL — so the legacy brief's
"find it via `gh pr view <n> --json statusCheckRollup`" instruction cannot in fact yield a navigable
URL, and the comment is the only reliable source.
Derivation is a fresh `gh pr view <n> --repo <slug> --json comments` at stage time (not a value
snapshotted on the session): the bot edits that comment in place as `nextCommitStatus` moves
`PENDING → DEPLOYED`, so freshness matters, and this keeps the session schema unchanged.

**R8 — preview stages and local-app stages are disjoint and configurable, defaulting to legacy behaviour.**
`localApp.stages` defaults to `['develop']`; `previewStages` defaults to `['review', 'rereview']`.
Grounded: legacy review says *"use the PR's PREVIEW — do NOT run the app locally"* (`:1149`); legacy
develop says *"During development, run `cgremlin --run-local` … Once the draft PR is open, ALSO
verify against its Vercel preview URL"* (`:14348`); legacy investigation offers local only *"for live
web evals"* (`:14182`) — so `findings` is opt-in via config, not on by default.

**R9 — review and rereview stages gain a `BRIEF.md`, and it carries the legacy REVIEW.md contract.**
Today `runReview`/`runRereview` pass `brief: null`. Phase 5 adds `renderReviewBrief` /
`renderRereviewBrief`. Each contains, reproduced **verbatim from `bin/cgremlin:1497–1660`**:
the Tier-0 `Intent alignment:` instruction, the evidence bar, the severity list, the **Link:**
permalink construction rule, and the complete `## Output — write REVIEW.md … EXACTLY this structure`
block (title line, `**Does it do what the ticket asked?**`, `**How deep did I look?**`, `## Summary`,
`## What I found` table with the `🔴 Critical / 🟠 High / 🟡 Perf / 🔧 Maintainability / 📋 PM/AC /
🎨 Design` legend, `## Details` with `<a id="fN"></a>` anchors and `[N](#fN)` table links,
`## Verdict`, `## Review History`) plus the "Rules for the file" bullets (structure exactly, stable
anchors, `Status` in two places).
`renderReviewPrompt`'s dangling `'## LIVE UI CHECK' section in CLAUDE.md` becomes
`'## LIVE UI CHECK' section in ${sessionDir}/BRIEF.md` — **and is omitted entirely when no protocol
was rendered** (R14). `renderRereviewPrompt`'s two references to "the evidence bar in CLAUDE.md"
become "the evidence bar in `${sessionDir}/BRIEF.md`", and that bar is rendered into the rereview
brief. No other prompt text changes.

**R10 — the LIVE UI CHECK protocol text is preserved verbatim from `bin/cgremlin:1436–1483`,**
with exactly two edits: (a) the "Vercel preview behind a login wall" bullet points at the
engine-provided URL and `<sessionDir>/.bypass-secret` instead of telling the agent to grep
`~/.cgremlin/config`; (b) the "Target" sentence is engine-generated from the resolved URLs. The PM
subagent steps, Designer subagent steps, side-by-side evidence rules, findings schema and the
Degradation clause are byte-identical.

**R11 AMENDED — machine prereqs are config-driven, checked, never fixed; a dev command that refuses
to start is reported, not worked around.**
`prereqs: { hostsEntries, requiredFiles, requiredEnv }` generalizes legacy's four hardcoded checks
(`/etc/hosts` contains the dev domain `:524`; `/Library/LaunchDaemons/com.grace.portforward.plist`
exists `:526`; `NODE_AUTH_TOKEN` non-empty `:528`; `~/.nvm/nvm.sh` non-empty `:530`), plus
`vercel whoami` when a `vercel` block is configured (`:534`). Each failure produces the legacy
message verbatim and degrades per R5.
**Amendment.** The engine does **not** try to configure `/etc/hosts`, Caddy, nvm or anything else, and
it does not attempt to detect every prereq a repo's own dev script enforces. Instead:
- `LocalAppRunner.start` is followed by a poll that watches `isAlive` **alongside** `healthcheck`. If
  the dev command **exits before the healthcheck passes**, the wait ends immediately (no 90 s stall)
  and `EnvironmentService` raises `LocalAppPrereqError` carrying `tailLog(dev-server.log, 40)` — the
  first 40 lines are enough to contain the repo's own refusal message — passed through
  `redactBypassUrls`. `start` catches it and degrades per R5 with that text as the reason, so the
  human reads the repo's own instructions and fixes their machine.
- Wrapper exit **78** (`EX_CONFIG`, emitted by the nvm wrapper when `nvm use <version>` fails, §4.1)
  maps to `LocalAppPrereqError` too.
- **Documented reality, 2026-09-09:** `grace-frontend`'s `pnpm dev` runs
  `scripts/ensure-portal-stack.sh` first, which refuses unless `/etc/hosts` also contains
  `portal.local.findcare.dev.aplaceformom.com` **and** a Caddy port-forward on 8443 is configured
  (`Run 'pnpm setup:local' once before starting local HTTPS development.` / `[ELIFECYCLE] Command
  failed with exit code 1.`). Both exist on the supervisor's machine but **not** in a fresh
  environment, and both are sudo-only to create. So on a fresh machine the develop stage degrades with
  that exact log excerpt in `BRIEF.md`; adding `portal.local.findcare.dev.aplaceformom.com` to
  `prereqs.hostsEntries` turns the hosts half into a clean prereq failure, and the Caddy half is
  deliberately left to the dev script's own message.

**R12 — `nvm` is honoured by wrapping the dev command in a login shell, exactly as legacy does.**
The spawned command is
`bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use <version> >/dev/null 2>&1 || exit 78; exec <devCommand>'`
(legacy `:610`, minus `nohup`/`&` which `detached: true` replaces). When `nodeVersion` is absent the
wrapper is `bash -lc 'exec <devCommand>'`. Legacy's `nvm install` on a missing version (`:574`) is
**not** reproduced — it mutates the user's default nvm alias, which legacy itself flags as a side
effect (`:533`); a missing version is a prereq failure instead (exit 78 → `LocalAppPrereqError`).

**R13 — the engine reaps its own orphaned local app at boot, and only its own.**
`EnvironmentService.reconcileOrphans()` runs once from `serve()`'s startup wiring, before the
scheduler starts:
- read `<stateDir>/local-app.json`; if absent → no-op;
- if it names a **pgid the engine itself recorded** and that group is alive → `SIGTERM` the group,
  wait up to 5 s, `SIGKILL` the group, clear the state file, and return the reaped state so `serve`
  logs one line `{"type":"local.reaped","sessionId":…,"pid":…,"pgid":…,"port":…}`;
- if the recorded group is already dead → just clear the state file (log `local.reaped` with
  `alreadyDead: true`);
- a **foreign** pid listening on the port is NEVER touched — no kill, no signal, not even when the
  state file is stale. R6 stands.
Rationale: a `kill -9`'d engine (or a machine crash) otherwise leaves a dev server owning the port
forever, and every later start degrades with `LocalAppPortBusyError`. Reaping our own recorded group
is provably safe; reaping anything else is not.

**R14 — a repo with no `environments` entry renders nothing about environments, prompt sentence
included.**
No `environments[<slug>]` (or one with neither a `localApp` nor a `vercel` block for this stage) ⇒
`briefContext` is `EMPTY_ENVIRONMENT` ⇒ `renderEnvironmentSection` is `''` ⇒
`renderUiCheckProtocol` is `''` ⇒ **and `renderReviewPrompt` omits the
"Then ALWAYS run the `'## LIVE UI CHECK'` section …" sentence altogether.** The gate is *"was the
section actually rendered"*, not a separate config flag: `ReviewPromptParams.includeLiveUiCheck`
becomes the AND of its existing value and "the brief contains a `## LIVE UI CHECK` section".
Grounded: `aplaceformom/grace` (the backend) has no Vercel deployment at all — §7 confirms zero
`vercel` comments on any open PR — so a review session there must not be told to run a UI check
against a URL that does not exist.

**R15 — `local-app.json` is serialized by a dedicated, non-session lock key.**
Every read-modify-write of the state file (`start`, `stop`, `reconcileOrphans`, the stale-state clear)
runs inside `lock.withLock('local-app:' + port, …)` on the **shared** `KeyedLock`. The key namespace
cannot collide with a session id (`assertSafeSessionId` forbids `:`), and because R4 moved
environment prep outside the session lock there is no nesting of the two. This is what actually makes
"single instance" true: without it, two sessions starting concurrently both see an empty state file
and both spawn. The API route keeps its `lock.withLock(id)` too (it guards concurrent same-session
requests) — a different key, so no deadlock.

**R16 — `serve.close()` stops sessions first, then local apps.**
Order in `doClose()`: `scheduler.stop()` → `pipeline.stop(id)` for every `activeSessionIds()` →
`environment?.stop()` → socket/server teardown. Stopping the app first would pull the dev server out
from under an agent that is still driving a browser against it, producing a flood of navigation
errors in the last seconds of a run. `environment.stop()` goes in the same `try` as the session stops
so a failure there is captured by `firstError` and the `finally` still tears the socket down. Also:
when `start` recorded a pid from the port listener that differs from the spawned pid (the pnpm wrapper
forks, legacy `:622–624`), the **pgid is re-derived from that listener pid** via `pgidOf`, because
killing the spawned child's group would miss a listener that re-parented.

## 3. Config schema additions (exact zod)

Added to `src/config/core-config.ts`. `StageNameSchema` is the existing export from
`src/schema/stage.ts`.

```ts
export const LocalPrereqsSchema = z.object({
  hostsEntries: z.array(z.string().min(1)).default([]),
  requiredFiles: z.array(z.string().min(1)).default([]),
  requiredEnv: z.array(z.string().min(1)).default([]),
}).default({});

export const LocalAppConfigSchema = z.object({
  url: z.string().url(),
  port: z.number().int().positive().max(65535).default(8080),
  devCommand: z.string().min(1).default('pnpm dev'),
  installCommand: z.string().min(1).default('pnpm install'),
  nodeVersion: z.string().min(1).optional(),
  healthTimeoutMs: z.number().int().positive().default(90_000),
  healthIntervalMs: z.number().int().positive().default(2_000),
  insecureTls: z.boolean().default(true),
  postInstallNonEmptyDirs: z.array(z.string().min(1)).default([]),
  stages: z.array(StageNameSchema).default(['develop']),
  prereqs: LocalPrereqsSchema,
});

export const VercelConfigSchema = z.object({
  scope: z.string().min(1),
  project: z.string().min(1),
  previewProject: z.string().min(1),
  envFile: z.string().min(1).default('.env.local'),
  bypassSecret: z.string().min(1).optional(),
});

export const ClerkConfigSchema = z.object({
  testEmailTemplate: z.string().min(1).default('uicheck-{key}+clerk_test@example.com'),
  verificationCode: z.string().min(1).default('424242'),
});

export const RepoEnvironmentSchema = z.object({
  localApp: LocalAppConfigSchema.optional(),
  vercel: VercelConfigSchema.optional(),
  clerk: ClerkConfigSchema.optional(),
  previewStages: z.array(StageNameSchema).default(['review', 'rereview']),
});
export type RepoEnvironment = z.infer<typeof RepoEnvironmentSchema>;

// CoreConfigSchema gains:
  environments: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/), RepoEnvironmentSchema).default({}),
  localAppStatePath: z.string().optional(),   // derived: `${stateDir}/local-app.json`
```

`localAppStatePath` joins `DERIVED_PATH_SUFFIXES` (`src/config/core-config.ts:116`) with suffix
`local-app.json`, so `resolveCoreConfig` expands and `writeCoreConfig` omits it when it is just the
default.

Values that reproduce today's machine, for the supervisor's `core.json` (legacy defaults
`bin/cgremlin:69–74`, prereqs `:524–535`, plus the portal hosts entry found live in §7):

```jsonc
"environments": {
  "aplaceformom/grace-frontend": {
    "localApp": {
      "url": "https://local.findcare.dev.aplaceformom.com",
      "port": 8080, "devCommand": "pnpm dev", "nodeVersion": "24",
      "postInstallNonEmptyDirs": ["packages/grace-api/src/generated"],
      "stages": ["develop"],
      "prereqs": {
        "hostsEntries": [
          "local.findcare.dev.aplaceformom.com",
          "portal.local.findcare.dev.aplaceformom.com"
        ],
        "requiredFiles": ["/Library/LaunchDaemons/com.grace.portforward.plist", "~/.nvm/nvm.sh"],
        "requiredEnv": ["NODE_AUTH_TOKEN"]
      }
    },
    "vercel": {
      "scope": "grace-0118bc61", "project": "grace-frontend-dev",
      "previewProject": "grace-frontend-dev", "bypassSecret": "<from legacy config>"
    },
    "clerk": {},
    "previewStages": ["review", "rereview"]
  }
}
```

The importer keeps the legacy four-entry prereq set (it must not invent the portal entry); the second
`hostsEntries` line above is a hand edit the supervisor makes, documented here so the value is not
lost. `aplaceformom/grace` deliberately gets **no** entry (R14).

`config import-legacy` additionally lifts `LOCAL_URL`, `LOCAL_PORT`, `LOCAL_DEV_CMD`,
`LOCAL_NODE_VERSION`, `VERCEL_SCOPE`, `VERCEL_PROJECT`, `VERCEL_AUTOMATION_BYPASS_SECRET` out of
`~/.cgremlin/config` (applying the same legacy defaults when a key is absent — verified: the real
file only has `VERCEL_AUTOMATION_BYPASS_SECRET`) into `environments[<first repo in WATCH_REPOS>]`,
and prints which repo it attached them to.

## 4. Components

### 4.1 `LocalAppRunner` port — `src/env/local-app-runner.ts`

```ts
export interface LocalAppSpec {
  cwd: string;
  command: string;
  nodeVersion?: string;
  logPath: string;
  appendLog?: boolean;
}
export interface LocalAppProcess { pid: number; pgid: number; startedAt: string }
export interface HealthResult { ok: boolean; status: number | null; reason: string | null; exited: boolean }
export interface ExecResult { code: number | null; stdout: string; stderr: string }

export interface LocalAppRunner {
  exec(command: string, opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string }): Promise<ExecResult>;
  portListenerPid(port: number): Promise<number | null>;
  pgidOf(pid: number): Promise<number | null>;
  start(spec: LocalAppSpec): Promise<LocalAppProcess>;
  /** Polls the URL until 2xx, the timeout, or `proc` exits — whichever comes first;
   *  `exited: true` means the dev command died before the port ever answered (R11). */
  healthcheck(url: string, opts: { timeoutMs: number; intervalMs: number; insecureTls: boolean; proc?: LocalAppProcess }): Promise<HealthResult>;
  isAlive(proc: LocalAppProcess): Promise<boolean>;
  stop(proc: LocalAppProcess, opts: { port: number }): Promise<void>;
  tailLog(logPath: string, lines: number): Promise<string>;
  headLog(logPath: string, lines: number): Promise<string>;
}

export class LocalAppPortBusyError extends Error { constructor(port: number, pid: number, ours: boolean) { … } }  // name 'LocalAppPortBusyError'
export class LocalAppPrereqError extends Error { … }                                               // name 'LocalAppPrereqError'
export class LocalAppUnhealthyError extends Error { … }                                            // name 'LocalAppUnhealthyError'
```

`NodeLocalAppRunner` (`src/env/node-local-app-runner.ts`), following `NodeGitRunner`'s shape:

- `exec` → `execFile('bash', ['-lc', wrap(command, nodeVersion)], { cwd, timeout, maxBuffer: 64MB })`;
  when `logPath` is given, stdout+stderr are appended to it. Resolves, never rejects.
- `portListenerPid` → `lsof -t -nP -iTCP:<port> -sTCP:LISTEN`, first line, `null` on exit 1
  (legacy `:552`, `:598`; verified exit 1 with no output when the port is free).
- `pgidOf` → `ps -o pgid= -p <pid>` trimmed (verified).
- `start` → `openSync(logPath, 'w')`, `spawn('bash', ['-lc', wrap(...)], { cwd, detached: true,
  stdio: ['ignore', fd, fd] })`, `child.unref()`, `closeSync(fd)`; `pgid = child.pid`
  (a detached child leads its own group).
- `healthcheck` → poll `GET <url>/` every `intervalMs` until `timeoutMs`; healthy = status 200–299
  (legacy accepts any 2xx in its idempotency branch `:601`). `https` requests use
  `rejectUnauthorized: !insecureTls` (legacy `curl -sk`, `:617`). Per-attempt socket timeout
  `intervalMs`. When `opts.proc` is given, each attempt also checks `isAlive(proc)`; a dead process
  ends the poll immediately with `{ ok: false, exited: true }` (R11 fast-fail). A connection-refused
  attempt (verified live: curl exit 7 / http_code 000 before the server is up) is just "not yet".
- `stop` → `process.kill(-proc.pgid, 'SIGTERM')`; poll `isAlive` for 5 s; `process.kill(-pgid,
  'SIGKILL')`; then if `portListenerPid(port)` still returns a pid, `process.kill(pid, 'SIGTERM')`
  (legacy's lingering-listener cleanup, `:552–553`). Every `kill` swallows `ESRCH`.
- `tailLog` / `headLog` → last / first N lines, `''` when the file is absent (legacy `tail -20`,
  `:631`; `headLog` is what R11 hands to `LocalAppPrereqError`).

`FakeLocalAppRunner` (`test/support/fake-local-app-runner.ts`), following `FakeGitRunner`: records
`execCalls`, `startCalls`, `stopCalls`; `queueExec`, `queueHealth`, `setPortListener(pid | null)`,
`setAlive(bool)`; `start` returns a scripted `LocalAppProcess` and flips the port listener to it. It
also appends to an optional shared ordered call log (`'local.start'`, `'local.stop'`) used by C2's
ordering assertion.

### 4.2 `EnvironmentService` — `src/env/environment-service.ts`

```ts
export interface LocalAppState {
  sessionId: string; repoSlug: string; url: string; port: number;
  pid: number; pgid: number; logPath: string; startedAt: string;
}
export interface LocalAppStatus {
  state: 'running' | 'stopped' | 'unavailable';
  sessionId: string | null; url: string | null; pid: number | null;
  logPath: string | null; startedAt: string | null;
  reason: string | null; logTail: string | null;   // logTail is redacted (R3)
}
export interface EnvironmentBriefContext {
  localUrl: string | null; localLogPath: string | null; localUnavailableReason: string | null;
  previewUrl: string | null; previewUnavailableReason: string | null;
  bypassSecretPath: string | null;
  clerk: { emailTemplate: string; verificationCode: string } | null;
}
export interface EnvironmentServiceDeps {
  fs: SessionFileSystem; gh: GhRunner; git: GitRunner; local: LocalAppRunner;
  config: CoreConfig; sessionsDir: string; statePath: string; lock: KeyedLock;
  env?: NodeJS.ProcessEnv; now?: () => Date;
}
export class EnvironmentService {
  environmentFor(repoUrl: string): RepoEnvironment | undefined;      // via repoSlugFromUrl
  wantsLocalApp(repoUrl: string, stage: StageName): boolean;
  wantsPreview(repoUrl: string, stage: StageName): boolean;
  checkPrereqs(env: RepoEnvironment): Promise<string[]>;             // [] = ok; each string is a legacy PREREQ line
  ensureSetup(session: Session, env: RepoEnvironment, logPath: string, fresh: boolean): Promise<void>;
  start(session: Session, opts?: { fresh?: boolean }): Promise<LocalAppStatus>;
  stop(sessionId?: string): Promise<LocalAppStatus>;
  status(): Promise<LocalAppStatus>;
  reconcileOrphans(): Promise<{ reaped: LocalAppState | null; alreadyDead: boolean }>;   // R13
  previewUrlFor(session: Session): Promise<{ url: string | null; reason: string | null }>;
  briefContext(session: Session, stage: StageName): Promise<EnvironmentBriefContext>;
  writeBypassSecret(sessionDir: string, repoUrl: string): Promise<string | null>;
  clearBypassSecret(sessionDir: string): Promise<void>;              // fs.remove, no-op when absent
}
```

`start` reproduces `run_local` step for step (`bin/cgremlin:560–633`), with steps 4–6 inside
`lock.withLock('local-app:' + port, …)` (R15):
1. worktree exists and its `package.json` mentions the dev script → else `unavailable`.
2. `checkPrereqs` → any failure ⇒ `unavailable` with the joined legacy messages; plus
   `vercel whoami` via `local.exec` when a `vercel` block exists.
3. Setup, skipped on the fast path exactly as legacy (`:578`): run when `fresh`, or `<cwd>/<envFile>`
   is absent, or `<cwd>/node_modules` is absent, or any `postInstallNonEmptyDirs` entry is **absent or
   empty** (verified live: `packages/grace-api/src/generated` does not exist at all when the backend
   is down, so "missing" and "empty" must both count):
   `vercel link --yes --scope <scope> --project <project>` → `vercel env pull <envFile>` →
   assert the pulled file has ≥1 `=` line (`:583`) → **gitignore guard** → `<installCommand>` (log
   `<logPath>.install`) → assert every `postInstallNonEmptyDirs` entry is non-empty, else the legacy
   "dev backend unreachable — API types not generated" message (`:592`).
   *Gitignore guard:* after `vercel env pull`, run `git check-ignore -q <envFile> .vercel` in the
   worktree via `deps.git`. `git check-ignore` exits non-zero (and `NodeGitRunner` therefore throws)
   when **any** listed path is not ignored; in that case append `<envFile>` and `.vercel` as two lines
   to the repo's `info/exclude`, whose path is resolved with `git rev-parse --git-path info/exclude`
   (in a linked worktree `<worktree>/.git` is a *file*, so the literal `<worktree>/.git/info/exclude`
   would not exist). Verified live: both paths **are** already gitignored in `grace-frontend`
   (`.gitignore:79 .env*.local`, `.gitignore:49 .vercel`), so the guard is normally a single no-op
   `git` call — it exists so a repo without those rules never gets a pulled secret file committed.
4. Single instance (R6): read the state file; if it names this session, the process is alive and the
   URL answers 2xx → return `running` unchanged (legacy `:601`). If it names this session but the
   process is dead → clear the state file (`fs.remove`) and continue. Else if
   `portListenerPid(port)` is non-null → `unavailable` with the matching R6-(b) message.
5. `local.start` with `logPath = <sessionDir>/logs/dev-server.log` (legacy `:567`), then
   `healthcheck(url, { …, proc })`. On `exited: true` → `LocalAppPrereqError` carrying
   `headLog(logPath, 40)` (redacted) — R11. On plain timeout → `stop` the process, `unavailable` with
   reason `"<url> did not come up within <n>s"` plus `tailLog(20)` (legacy `:630–631`).
6. Persist the state file atomically (tmp + rename), recording the pid **from the healthcheck's
   `portListenerPid`** when it differs from the spawned pid — the pnpm wrapper forks (legacy
   `:622–624`) — and in that case re-deriving `pgid` from that pid with `pgidOf` (R16).

`previewUrlFor` runs `gh pr view <number> --repo <slug> --json comments`, feeds the bodies to the pure
`parseVercelPreviewComment`, and returns `https://<previewUrl>` for the project named
`vercel.previewProject`. A `nextCommitStatus` other than `DEPLOYED` still yields the URL (verified
live: `PENDING` projects carry a populated `previewUrl`), with the status appended to the brief line.
Reasons returned instead of a URL: `no vercel comment on the PR`,
`no project '<name>' in the vercel comment`, `project '<name>' has no preview URL yet (nextCommitStatus=<v>)`
(the `previewUrl: null` case, verified live on `IGNORED` projects), `gh pr view failed: <stderr>`.

### 4.3 Vercel comment parsing — `src/env/vercel-preview.ts` (pure)

```ts
export interface VercelPreviewProject {
  name: string; projectId: string; rootDirectory: string | null;
  inspectorUrl: string; previewUrl: string | null; nextCommitStatus: string;
}
export const VercelCommentPayloadSchema: z.ZodType<{ isMonorepo: boolean; type: string; projects: VercelPreviewProject[] }>;
export function parseVercelPreviewComment(bodies: readonly string[]): VercelPreviewProject[];
export function pickPreviewProject(projects: readonly VercelPreviewProject[], name: string): VercelPreviewProject | null;
export function previewUrlWithBypass(host: string, secret: string): string;
  // `https://${host}/?x-vercel-protection-bypass=${encodeURIComponent(secret)}&x-vercel-set-bypass-cookie=true`
  // NOT used by the engine to build brief text (R3) — exists for tests and for a future non-agent caller.
```

`parseVercelPreviewComment` matches `/^\[vc\]: #[^:]+:(\S+)/m` on each body, base64-decodes group 1
(padding-tolerant — real bodies needed `'=' * (-len % 4)` re-added), `JSON.parse`s, validates with
zod, returns the first payload's `projects`; a body that does not match, does not decode, or fails
validation is skipped (never throws). `previewUrl` is `string | null` in the schema and a `null` or
`''` value is treated identically as "no URL" by callers. The **"Deployment failed for project …"**
comment variant the `vercel` bot also posts carries no `[vc]:` marker and is skipped by exactly this
rule (verified live on PR #1904).

Bot identification: comments are filtered on `author.login === 'vercel'` — the login is exactly
`vercel`, **not** `vercel[bot]` (verified live across 23 comments on 20 PRs). Bodies from other
authors are additionally harmless because the marker match would fail anyway.

### 4.4 Brief changes — `src/pipeline/prompts.ts`

New exports:

```ts
export interface EnvironmentBriefContext { /* §4.2 */ }
export const EMPTY_ENVIRONMENT: EnvironmentBriefContext;                             // every field null
export function renderEnvironmentSection(ctx: EnvironmentBriefContext): string;      // '' when everything is null
export function renderUiCheckProtocol(mode: 'observe' | 'fix', target: string, ctx: EnvironmentBriefContext): string;
export function renderReviewContract(): string;                                      // the verbatim REVIEW.md contract, R9
export function renderReviewBrief(p: { sessionDir: string; prNumber: number; env?: EnvironmentBriefContext }): string;
export function renderRereviewBrief(p: { sessionDir: string; prNumber: number; commitCount: number; env?: EnvironmentBriefContext }): string;
```
`FindingsBriefParams`, `DevelopBriefParams`, `renderReviewBrief` and `renderRereviewBrief` all take
`env?: EnvironmentBriefContext`, **optional, defaulting to `EMPTY_ENVIRONMENT`** — so every existing
call site and test keeps compiling and keeps producing byte-identical output.

`renderEnvironmentSection` output (all lines conditional):

```
## Environment (started for you by the engine — do NOT start or stop anything yourself)
- Local app: <url>  (dev-server log: <logPath> — read it when something fails)
- Local app: UNAVAILABLE — <reason>. Do not attempt to start it yourself; verify what you can statically and say so in your output.
- Vercel preview: https://<host>
- Vercel preview: UNAVAILABLE — <reason>. Fall back to a Storybook preview link in the PR checks/comments if one exists; otherwise note it and continue.
- Deployment-protection bypass secret: read the single line in `<sessionDir>/.bypass-secret`.
- Clerk test user: sign in with `<emailTemplate>` and the email verification code `<code>`.
```

`renderUiCheckProtocol` reproduces `bin/cgremlin:1436–1483` verbatim (heading, the two-parallel-subagents
sentence, `**Target:** <target>`, the PM subagent's 4 steps, the Designer subagent's 5 steps, the
side-by-side evidence rules, the findings schema, the Degradation clause, and the mode-specific FIX
or OBSERVE paragraph), except the "Reaching the target" block, which becomes:

```
**Reaching the target (both subagents):**
- **Vercel preview behind a login wall:** do NOT attempt an interactive Vercel login. The preview URL is in the `## Environment` section above. Bypass deployment protection with the automation secret — read the single line from `<sessionDir>/.bypass-secret` and append `?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true` to the preview URL on first navigation (or send it as the `x-vercel-protection-bypass` request header).
- **Page behind Clerk auth (dev):** sign in with a Clerk test user — use an email of the form `<test-specific-name>+clerk_test@example.com` (the `+clerk_test` suffix is what makes it a test account; pick a name specific to this check, e.g. `uicheck-<ticket>`) and the email verification code `424242`.
- chrome-devtools runs with an isolated (fresh) profile, so there is no saved session — do the bypass/login on every run.
```
(The second and third bullets are byte-identical to `bin/cgremlin:1446–1447`; the code is taken from
`clerk.verificationCode` and interpolated, defaulting to `424242`.)

`renderUiCheckProtocol` returns `''` when both `localUrl` and `previewUrl` are null (R14).

`renderReviewContract()` is the verbatim `bin/cgremlin:1497–1660` REVIEW.md contract described in R9;
`renderReviewBrief` and `renderRereviewBrief` both embed it, so the review agent has the exact
structure it used to get from the legacy `CLAUDE.md`.

Targets, from legacy:
- review/rereview → `the PR's Vercel preview URL shown in the ## Environment section above` (legacy
  `:1667` minus the now-unnecessary `gh pr view` hunt, which R7 showed cannot yield a navigable URL).
- develop → `the LOCAL url <localUrl> during development, and the draft PR's Vercel preview URL once the PR is open` (legacy `:14350`, verbatim with the URL interpolated).
- findings → `the LOCAL url <localUrl>` (only when `localApp.stages` includes `findings`).

Develop brief step 5 regains the legacy sentence with the engine-managed wording:
`5. **Verify (local during dev; preview after the PR).** The local app is already running at <url> — drive chrome-devtools against it. Once the draft PR (step 4) is open, ALSO verify against its Vercel preview URL. Run a FOCUSED functional smoke (prove the ticket's issue is fixed, plus a smoke pass of the feature and its likely splash-zone regressions — NOT the full e2e suite) AND the PM + Designer UI check below. Watch <logPath>; iterate to green.`
(legacy `:14348`, with `cgremlin --run-local`/`--stop-local` removed per the no-callback ruling.)

### 4.5 Pipeline integration — `src/pipeline/pipeline-service.ts`

- `PipelineConfig` unchanged; `PipelineServiceDeps` gains `environment?: EnvironmentService`
  (optional so every existing test wiring keeps compiling).
- **`runStageLocked`'s signature is UNCHANGED** (`brief: string | null`) and so is the locking-invariant
  comment at the top of the file. R4-AMENDED removed the need for a brief thunk: the brief is rendered
  before the lock because the environment is prepared before the lock.
- A private `prepareEnvironment(id, stage, session)` runs **before** `runStageLocked`, takes no
  session lock, and writes no session state. It calls `environment.start(session)` when
  `wantsLocalApp`, `previewUrlFor` when `wantsPreview`, and `writeBypassSecret` when a preview URL
  resolved and a `bypassSecret` is configured. It returns
  `{ ctx: EnvironmentBriefContext; startedHere: boolean; teardown(): Promise<void> }`, where
  `teardown` calls `clearBypassSecret` always and `environment.stop(id)` only when `startedHere`, and
  itself takes no session lock (it does take the `local-app:<port>` key, R15).
- Every environment-bearing stage (`runFindings`, `runDevelop`, `runReview`, `runRereview`) becomes:
  `prepareEnvironment` → render the brief from `ctx` → `try { …the existing body, unchanged… } finally { await prep.teardown(); }`, with that `finally` **outside** the existing
  `try/catch (preRunCommitted)` block. `runPlan` does not participate (no environment stage).
- `runReview` / `runRereview` change `brief: null` → `renderReviewBrief` / `renderRereviewBrief`.
- `repoSlugFromUrl` moves to a leaf module `src/gh/repo-slug.ts` and is re-exported from
  `pipeline-service.ts` (both `repoSlugFromUrl` and the `repoSlug` alias) so `EnvironmentService` can
  import it without an `environment-service → pipeline-service → environment-service` import cycle.

### 4.6 API — `src/api/server.ts`

- `ApiServerDeps` gains `environment?: EnvironmentService`.
- `POST /sessions/:id/local/start` (`parts.length === 4`, `parts[2] === 'local'`,
  `parts[3] === 'start'`; optional `?fresh=1`) → `lock.withLock(id, …)` → 200 `{ status }`; 409 when
  `status.state === 'unavailable'` with `{ error: reason }`.
- `POST /sessions/:id/local/stop` → 200 `{ status }`.
- `GET /sessions/:id/local` → 200 `{ status }`; `status.state === 'stopped'` when the tracked owner is
  a different session. `logTail` = last 40 lines, passed through `redactBypassUrls` (R3).
- 404 `{ error: 'environment not configured' }` when `deps.environment` is absent, mirroring the
  `/prs` guard (`src/api/server.ts:357`).
- `mapErrorToHttp` gains `LocalAppPortBusyError`/`LocalAppPrereqError`/`LocalAppUnhealthyError` → 409.

### 4.7 CLI and host wiring — `src/cli/commands/local.ts`, `src/host/*`

`cgremlin-core local start <session> [--fresh]`, `local stop [<session>]`, `local status [--json]`.
Thin socket client via `runSocketCommand`, matching `src/cli/commands/prs.ts`. Human output for
`status`: `running  <session>  <url>  pid <pid>  since <startedAt>` / `stopped` /
`unavailable — <reason>`. `USAGE` in `src/cli/main.ts` gains the line.

`buildEngine` (`src/host/build-engine.ts`) constructs `EnvironmentService` when
`adapters.localApp` is present (with `config.localAppStatePath!`, the shared `KeyedLock` and
`adapters.git`) and passes it to both `PipelineService` and `createApiServer`; `realAdapters` supplies
`new NodeLocalAppRunner()`; `Engine` gains `environment: EnvironmentService | null`.

`serve` (`src/host/serve.ts`) additionally:
- calls `environment.reconcileOrphans()` once at startup, before `scheduler.start()`, and logs
  `{"type":"local.reaped", …}` when something was reaped (R13);
- wraps the verbose `run.output` chunk in `redactBypassUrls` (R3);
- in `doClose()`, calls `environment?.stop()` **after** the `pipeline.stop(id)` loop and before the
  socket teardown `finally` (R16).

## 5. Secret handling — summary of the enforced invariants

| Where | Rule | Enforced by |
|---|---|---|
| `core.json` on disk | mode 0600, set on the tmp file before rename | `writeCoreConfig` + `statMode` assertion in `loadCoreConfig` |
| `BRIEF.md` | never contains the secret value | MG-1 (type pin) + the C2 live-render guard |
| API artifacts | `.bypass-secret` unreadable | `ARTIFACT_NAME_PATTERN` (unchanged) + MG-2 |
| `serve` stderr log | never contains the secret | `redactCoreConfig` + `redactBypassUrls` on `run.output` + MG-3 |
| HTTP responses | `LocalAppStatus.logTail` and `/prs` payloads carry no secret | `redactBypassUrls` + MG-3 |
| `<sessionDir>/.bypass-secret` | 0600, written only for stages that resolved a protected URL, deleted in the teardown `finally` | MG-5 |
| agent transcript | **not protected** — accepted residual risk, R3 | — |

`redactCoreConfig(cfg): CoreConfig` deep-clones and replaces every
`environments[*].vercel.bypassSecret` with `'[redacted]'`.
`redactBypassUrls(text): string` replaces `/x-vercel-protection-bypass=[^&\s]+/g` with
`x-vercel-protection-bypass=<redacted>`. Both live in `src/config/core-config.ts`.

## 6. Testing strategy

Pure, no I/O: `parseVercelPreviewComment` / `pickPreviewProject` (fixture
`test/fixtures/gh/pr-comments-vercel.json` — real `[vc]:` bodies from `grace-frontend`, non-bot bodies
blanked; the payload is public deployment metadata and holds no secret), the config schema,
`redactCoreConfig`, `redactBypassUrls`, and every brief renderer (snapshot the review, rereview,
develop and findings briefs).

Fakes, no subprocess: `EnvironmentService` over `FakeLocalAppRunner` + `FakeGhRunner` +
`FakeGitRunner` + `InMemoryFileSystem` — the full `run_local` decision tree (prereq failure,
fast-path skip, empty `.env.local`, missing/empty generated dir, gitignore guard both branches, port
busy in both R6-(b) shapes, healthcheck timeout with log tail, dev-command-exited fast fail with the
40-line head, reuse of a healthy owned app, pid+pgid correction from the port listener, concurrent
start serialized by the `local-app:<port>` key, `reconcileOrphans`); `PipelineService` integration
(start strictly before the lock is entered, stop after, brief carries the URL); API routes; CLI
commands; `serve` boot/close ordering.

Real subprocess, one file, tagged and fast: `NodeLocalAppRunner` against a tiny Node HTTP-server
fixture spawned **through the same `bash -lc '… exec node fixture.js'` wrapper** the real dev command
uses — proves detached spawn, that the listener's pgid equals the spawned child's pgid, that killing
the group frees the port, log capture, healthcheck 2xx, and `portListenerPid` before/after. This test
is what closes §7's process-group gap, which could not be closed against `pnpm dev` itself. Skipped
on non-POSIX.

Named mutation guards (each must be demonstrated failing under the stated mutation):

- **MG-1 `secret-never-in-brief`** — a **type pin**: every brief renderer's parameter type makes the
  secret value unrepresentable (only `bypassSecretPath` exists), and rendering every brief with
  `bypassSecretPath: '/s/.bypass-secret'` produces no secret-shaped text. The **real** guard is in C2:
  render through a live `EnvironmentService` whose config has `bypassSecret: 'S3CRET-VALUE'` and
  assert the written `BRIEF.md` never contains it. Mutation: inline the secret into the
  Reaching-the-target bullet.
- **MG-2 `secret-not-an-artifact`** — `parseArtifactName('.bypass-secret')` throws; a real API request
  to `GET /sessions/:id/artifacts/.bypass-secret` returns 400. Mutation: widen `ARTIFACT_NAME_PATTERN`.
- **MG-3 `secret-never-leaves-the-process`** — capture every `serve` log line (verbose on) and every
  `/sessions/:id/local` + `/prs` response body across a full start/stop cycle, with an agent that
  prints a bypass URL to stdout; assert nothing contains the secret and that the captured line shows
  `x-vercel-protection-bypass=<redacted>`; `redactCoreConfig` output contains `[redacted]`. Mutation:
  log the raw chunk / the raw config on boot.
- **MG-4 `no-local-app-for-review`** — run a review stage with `localApp.stages: ['develop']`; assert
  `FakeLocalAppRunner.startCalls` is empty. Mutation: drop the `wantsLocalApp` stage filter.
- **MG-5 `local-app-always-stopped`** — three cases (agent exits 0; agent exits 1; the locked `preRun`
  throws after the start): `stopCalls.length === 1` and `.bypass-secret` no longer exists. Mutation:
  move `teardown` out of the outer `finally`.
- **MG-6 `no-port-steal`** — `setPortListener(9999)` (a foreign pid), call `start`; assert
  `startCalls` empty, `stopCalls` empty, no kill recorded, status `unavailable` with the
  "engine did not start" wording. Mutation: reinstate legacy's kill-the-squatter branch.
- **MG-7 `no-agent-callback`** — every rendered brief contains none of `cgremlin --run-local`,
  `cgremlin --stop-local`, `engine.sock`, `POST /sessions/`, or `curl `. (**Not** the bare string
  `/sessions/` — the briefs legitimately reference `<sessionDir>` paths.) Mutation: reinstate the
  legacy `--run-local` sentence.
- **MG-8 `config-file-is-0600`** — `writeCoreConfig` with a secret produces `statMode === 0o600`, and
  `loadCoreConfig` on a 0644 file with a secret throws `ConfigError`. Mutation: drop the `mode` option.
- **MG-9 `env-prep-outside-the-lock`** — an ordered call log (a shared array; the `KeyedLock` is
  wrapped so entering/leaving a key appends `lock.enter:<key>` / `lock.exit:<key>`, and
  `FakeLocalAppRunner` appends `local.start`) shows `local.start` **before** `lock.enter:<sessionId>`
  for a develop stage. Mutation: move the start back into `preRun` (R4's rejected alternative C).
- **MG-10 `state-file-mutex`** — two `start()` calls launched concurrently for different sessions
  produce exactly one `startCalls` entry and one persisted state file. Mutation: drop the
  `lock.withLock('local-app:' + port)` wrapper.
- **MG-11 `reap-only-our-own`** — `reconcileOrphans` with a state file naming a live recorded pgid
  reaps it and logs `local.reaped`; with a state file naming a dead pgid it only clears the file; with
  **no** state file but a foreign listener on the port it does nothing at all. Mutation: reap by port
  instead of by recorded pgid.

## 7. Live grounding — results (2026-09-09)

Everything in this section was executed by the planner and the supervisor's grounding pass. The
"UNVERIFIED" list from the draft is resolved: items 1, 4 and 5 are verified below; items 2 and 3
(process group and exact health status of the *real* `pnpm dev`) are **unreachable on a machine
without the sudo-only portal/Caddy prereqs**, and are replaced by the fixture-server test in §6, which
proves the same process-group property against the identical wrapper.

**Tooling / auth:** `gh` authenticated as `guilleazoubel` (scopes include `repo`);
`vercel --version` → `Vercel CLI 48.1.0`; `vercel whoami` exit 0; `node v24.18.0`; `pnpm 10.10.0`;
`nvm 0.39.7` (a shell function, sourced from `~/.nvm/nvm.sh`).

**Cold setup (draft item 1) — verified, ~17 s total:**
- `vercel link --yes --scope grace-0118bc61 --project grace-frontend-dev` → exit 0, **~1 s, no
  prompts** ("Linked to grace-0118bc61/grace-frontend-dev (created .vercel)").
- `vercel env pull .env.local` → exit 0, **~1 s, no prompts** on 48.1.0 (so legacy's blind
  `/dev/null` redirect would not have hung); `grep -c '=' .env.local` → **71**.
- `pnpm install` → exit 0, **~15 s**. Its `postinstall` (`pnpm generate:types`) *fails* when the
  backend is down (`Type generation failed: fetch failed`) but swallows the failure, so pnpm still
  exits 0 — and `packages/grace-api/src/generated` **does not exist at all**. Hence §4.2 step 3 treats
  a missing directory as empty.
- `.env.local` and `.vercel` are **already gitignored** in `grace-frontend`
  (`.gitignore:79 .env*.local`, `.gitignore:49 .vercel`) — the guard in §4.2 stays anyway.
- `.vercel/project.json` → `{"projectId":"prj_qD0Y06gx9RwOawdpy0r4ob1RdtLl","orgId":"team_uEBR8cbi0ADXROkLMgLmhtI1","projectName":"grace-frontend-dev"}` (ids only, no tokens).
- The repo's `CLAUDE.md` is a **symlink to `AGENTS.md`** — worth knowing because it means the legacy
  tool's `$session_dir/CLAUDE.md` never collided with the repo's own instructions file, and core's
  decision to write `BRIEF.md` instead keeps that separation.

**Dev-server start — the R11 finding:** `bash -lc '… nvm use 24 …; exec pnpm dev'` in a fresh
checkout **exits 1 immediately**:
```
$ bash scripts/ensure-portal-stack.sh
⚠ Missing /etc/hosts entry for portal.local.findcare.dev.aplaceformom.com.
⚠ Grace's local port-forward is not configured for Caddy on 8443.
Run 'pnpm setup:local' once before starting local HTTPS development.
[ELIFECYCLE] Command failed with exit code 1.
```
`.nvmrc` is `v24` (so `nvm use 24` is a no-op on this machine). This is exactly why R11 was amended:
without the `isAlive` fast-fail the engine would sit for the full 90 s and then report a
healthcheck timeout instead of the repo's own actionable message.

**Health URL before start:** `curl -sk -o /dev/null -w '%{http_code}' https://local.findcare.dev.aplaceformom.com/`
→ `000`, curl exit 7 (connection refused). `dig +short` → empty: the host resolves **only** via
`/etc/hosts` (`127.0.0.1 local.findcare.dev.aplaceformom.com`).

**Preview URL / bot comment (draft items 4 and 5) — verified across 20 open PRs:**
- The bot login is exactly **`vercel`** (23 comments), not `vercel[bot]`.
- `/^\[vc\]: #[^:]+:(\S+)/m` → base64 (padding had to be re-added) → the §4.3 payload; decoded
  successfully for all 20 PRs, 4 projects each (`grace-frontend-dev`, `grace-frontend-storybook`,
  `grace-ops`, `grace-portal`).
- `nextCommitStatus` observed live: `DEPLOYED`, `IGNORED`, `SKIPPED`, and **`PENDING`** for
  `grace-frontend-dev` on PR #2037 — with `previewUrl` still populated. So the design's "hand the URL
  over anyway, note the status" is the only viable behaviour.
- `previewUrl` can be **`null`** (observed on `grace-frontend-storybook` for `IGNORED` projects on
  PRs #2030, #2018, #1955, #1908, #1907, #1906, #1905) — `null` and `''` both mean "no URL".
- A **"Deployment failed for project …"** comment variant exists (PR #1904, 4 such comments) with no
  `[vc]:` marker; the skip-and-continue rule handles it.
- `gh pr view 2036 … --json statusCheckRollup` → Vercel entries are `StatusContext` with
  `targetUrl = https://vercel.com/grace-0118bc61/<project>/<id>` — an inspector URL.
- The preview host returns `302 → https://vercel.com/sso-api?...` unauthenticated; `200` with header
  `x-vercel-protection-bypass: <secret>`; `307` back to the bare URL with
  `?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true`.
- `aplaceformom/grace` (backend): **zero** `vercel` comments on any of its 5 open PRs (authors seen:
  `apfm-sonar`, `gitstream-cm`) — confirming R14's "no `environments` entry ⇒ no LIVE UI CHECK and no
  prompt sentence".

**Process/port primitives:** `lsof -t -nP -iTCP:8080 -sTCP:LISTEN` → exit 1, no output, when free;
`ps -o pgid= -p <pid>` prints the pgid. Prereqs present on the supervisor's machine: the bare
`local.findcare.dev.aplaceformom.com` hosts entry, `/Library/LaunchDaemons/com.grace.portforward.plist`,
`~/.nvm/nvm.sh`, `NODE_AUTH_TOKEN`. **Absent:** the `portal.local.…` hosts entry and the Caddy 8443
forward. `~/.cgremlin/config` contains `VERCEL_AUTOMATION_BYPASS_SECRET` and none of `LOCAL_URL`,
`LOCAL_PORT`, `LOCAL_DEV_CMD`, `LOCAL_NODE_VERSION`, `VERCEL_SCOPE`, `VERCEL_PROJECT` — the importer
must apply the legacy defaults for those.
