# cgremlin/core Phase 4: PR Inventory, Host and CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "review every watched PR automatically" with a scanned **PR inventory** the user chooses from (explicit start; automatic re-review only for PRs we already reviewed), and make the engine runnable: a `cgremlin-core serve` host with typed config and a thin CLI.

**Architecture:** Two independent streams. **Stream A (inventory):** extend the `gh pr list` schema with `reviews[]`/`comments[]`; a pure `buildInventory(items, sessions, config)` producing entries + groupings; an `InventoryScanner` that fetches per repo, builds, reconciles existing review sessions via the unchanged `planReconciliation`, persists `inventory.json` atomically and emits `inventory.updated`; `/prs*` routes replacing `/discovery/*`; `DefaultPRDiscoveryStrategy` and the tick's discovery half retired. **Stream B (host+CLI):** typed `core.json` config with a legacy importer; `serve` wiring all real adapters with clean shutdown; the runner-mismatch guard in `StageRunner`; a CLI that is a thin socket client. Stream B's CLI `prs`/`review` commands land last, after Stream A merges.

**Tech Stack:** TypeScript, zod, vitest, `node:http` over Unix socket, `node:child_process`. New dev-only: none. `package.json` gains a `bin` entry and a `build` output used by the CLI/host (`tsc -p tsconfig.json` already exists).

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-04-cgremlin-core-phase4-pr-inventory-host-cli-design.md` (§2–§8; §9 posting is deferred and must not be implemented).

## Verified Ground Truth (gh 2.72.0, 2026-09-04, captures in supervisor scratchpad `gh-grounding/round3`)

- One call per repo returns everything: `gh pr list --repo R --state open --limit 50 --json number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt,latestReviews,reviews,comments` (all accepted; ~4 s, ~90 KB for ~30 PRs).
- `comments[]` element keys: `author{login}, authorAssociation, body, createdAt, id, includesCreatedEdit, isMinimized, minimizedReason, reactionGroups, url, viewerDidAuthor`. Conversation-level only.
- `reviews[]` element keys: `author{login}, authorAssociation, body, commit{oid}, id, includesCreatedEdit, reactionGroups, state (APPROVED|CHANGES_REQUESTED|COMMENTED), submittedAt`. `latestReviews[]` same keys with `id`/`commit.oid` as empty strings.
- Comment/review `author` is `{ login }` only — no `is_bot`. Top-level PR `author` has `{ id, is_bot, login, name }`. Bots observed as comment/review authors: `vercel`, `gitstream-cm`, `github-actions`, `aplaceformom-bot`, `apfm-sonar`, `apfm-yunid` — excluded by the watched-authors allowlist, never by heuristics.
- Max array sizes seen: comments 6, reviews 14, latestReviews 4.
- Fixture `test/fixtures/gh/pr-list-full.json` (6 real entries, bodies blanked) is pre-staged by the supervisor in Stream A's worktree.

## Global Constraints

- Node 24, pnpm 10.10.0, commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint` green at every commit.
- The engine issues **no GitHub write** (spec §9 deferred). `FakeGhRunner`'s guard covers every engine path in tests.
- **No automatic review start anywhere.** The only code path that starts a review for a PR without an existing session is the explicit `POST /prs/:owner/:repo/:number/review`. A test proves a scan with unreviewed PRs creates zero sessions and starts zero runs.
- Re-review of PRs we already reviewed and dismissal on merge/close stay automatic (Phase 3b `planReconciliation`, unchanged).
- `mode` is the only source of truth for session type. Team activity uses the watched-authors allowlist minus `me`; drafts and own PRs are listed with flags, not dropped.
- Stream A branch `phase4a-inventory`, Stream B branch `phase4b-host-cli`, both off `mission-control-pr-orchestrator`; supervisor merges A first, then B rebases/merges before its last task.

## File Structure

Stream A: `src/gh/pr-view.ts` (modify: `reviews`, `comments`, `PR_INVENTORY_FIELDS`), `src/inventory/inventory.ts` (model + `buildInventory` + groupings), `src/inventory/inventory-store.ts` (atomic persist/load), `src/inventory/inventory-scanner.ts`, `src/api/server.ts` + `src/api/validation.ts` + `src/api/http-errors.ts` (modify: `/prs*`), `src/engine/events.ts` (modify: `inventory.updated`), remove `src/discovery/pr-discovery-strategy.ts` and its test, trim `src/discovery/reconciliation.ts` to reconciliation only.
Stream B: `src/config/core-config.ts` (schema, load, import-legacy), `src/host/serve.ts` (wiring + lifecycle), `src/cli/main.ts` + `src/cli/client.ts` + `src/cli/commands/*.ts`, `src/pipeline/stage-runner.ts` (modify: runner-mismatch guard), `package.json` (`bin`), `bin/cgremlin-core` shim.

---

## Stream A

### Task A1: Extend the `gh pr list` schema with `reviews[]` and `comments[]`

**Files:** modify `src/gh/pr-view.ts`; test `test/gh/pr-view.test.ts`; fixture `test/fixtures/gh/pr-list-full.json` (pre-staged; commit it).

**Interfaces (produce):**
```ts
export const PR_INVENTORY_FIELDS = `${PR_LIST_FIELDS},latestReviews,reviews,comments`;
export const ActivityAuthorSchema = z.object({ login: z.string() });
export const PrReviewSchema = z.object({ author: ActivityAuthorSchema, state: z.string(), submittedAt: z.string() }).passthrough();
export const PrCommentSchema = z.object({ author: ActivityAuthorSchema, createdAt: z.string() }).passthrough();
export const PrInventoryItemSchema = PrListItemSchema.extend({
  latestReviews: z.array(PrReviewSchema).nullable().default([]),
  reviews: z.array(PrReviewSchema).nullable().default([]),
  comments: z.array(PrCommentSchema).nullable().default([]),
});
export type PrInventoryItem = z.infer<typeof PrInventoryItemSchema>;
export function parsePrInventoryList(stdout: string): PrInventoryItem[];   // '' → []; normalizes null arrays to []
```
- [ ] Tests: fixture parses (6 items) with the observed key sets; a review with `state 'COMMENTED'` parses; `comments: null` → `[]`; an item missing `reviews` entirely → `[]`; `parsePrInventoryList('')` → `[]`; an author object without `login` is rejected.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): gh pr list inventory schema with reviews and comments`.

### Task A2: Inventory model, groupings, atomic store

**Files:** create `src/inventory/inventory.ts`, `src/inventory/inventory-store.ts`; tests `test/inventory/inventory.test.ts`, `test/inventory/inventory-store.test.ts`.

**Interfaces (produce):**
```ts
export interface TeamActivity { login: string; kind: 'review' | 'comment'; state?: string; at: string }
export type OursStatus = { status: 'none' } | { status: 'reviewing' | 'reviewed'; sessionId: string; reviewedSha: string | null; newCommits: boolean; phase: ReviewPhase };
export interface InventoryEntry { repo: string; number: number; url: string; title: string; author: string; isDraft: boolean; headSha: string; baseRef: string; updatedAt: string; reviewDecision: ReviewDecision; isMine: boolean; teamActivity: TeamActivity[]; ours: OursStatus; seenAt: string }
export interface Inventory { scannedAt: string; repos: string[]; entries: InventoryEntry[]; errors: { repo: string; error: string }[] }
export interface InventoryGroups { unreviewed: InventoryEntry[]; teamOnIt: InventoryEntry[]; ours: InventoryEntry[]; mine: InventoryEntry[] }
export interface InventoryConfig { me: string; watchAuthors: readonly string[] }
export function buildEntries(repo: string, items: readonly PrInventoryItem[], sessions: readonly Session[], cfg: InventoryConfig, now: string): InventoryEntry[]
export function groupInventory(inv: Inventory): InventoryGroups
export const InventorySchema: z.ZodType<Inventory>   // for load validation
// inventory-store.ts
export class InventoryStore { constructor(fs: SessionFileSystem, path: string); save(inv: Inventory): Promise<void> /* tmp+rename */; load(): Promise<Inventory | null> /* null if absent; throws InventoryCorruptError on bad JSON/schema */ }
```
Rules: `isMine = author.login.toLowerCase() === me.toLowerCase()`. `teamActivity` = for each `reviews[]` entry and each `comments[]` entry whose `author.login` (case-insensitive) is in `watchAuthors` and is not `me`: `{ login, kind, state (reviews only), at }`, sorted by `at` ascending. `ours`: find a non-terminal `review` session with `pr.repo === repo && pr.number === number` (terminal per `TERMINAL_PHASES_BY_MODE.review`); none → `{status:'none'}`; phase ∈ {queued, reviewing} → `reviewing`; else `reviewed`; `reviewedSha = session.pr.reviewedSha`; `newCommits = reviewedSha !== null && reviewedSha !== headSha`. Groups: `mine` = isMine; `ours` = ours.status ≠ none; `teamOnIt` = !isMine && ours none && teamActivity.length>0; `unreviewed` = !isMine && ours none && teamActivity empty. Drafts are included everywhere (flag only).
- [ ] Tests (fixture-driven + hand-built): isMine case-insensitive; a `vercel` comment does not count (not in allowlist) while a teammate's `COMMENTED` review does; `me`'s own review does not count; sorting by `at`; `ours` reviewing vs reviewed vs none, `newCommits` true/false/null-reviewedSha; a dismissed session does not count as ours; groups are a partition of non-mine entries plus `mine` (each entry in exactly one of unreviewed/teamOnIt/ours unless mine); store: save writes tmp then renames (assert via InMemoryFileSystem: final path exists, no `.tmp` left), load null when absent, corrupt JSON → `InventoryCorruptError`, round-trip equality.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): PR inventory model, groupings and atomic store`.

### Task A3: `InventoryScanner` replaces the discovery half of the tick

**Files:** create `src/inventory/inventory-scanner.ts`; modify `src/discovery/reconciliation.ts` (remove step 2 discovery, remove `factory`/`strategy` deps, keep `reconcileSession` logic — export a `reconcileReviewSessions(deps, sessions, viewsBySession)` or keep `ReconciliationTick` with only step 1; your call, keep tests), delete `src/discovery/pr-discovery-strategy.ts` + `test/discovery/pr-discovery-strategy.test.ts`, modify `src/engine/events.ts` (`'inventory.updated': { inventory: Inventory }`); tests `test/inventory/inventory-scanner.test.ts`, adjust `test/discovery/reconciliation.test.ts`.

**Interfaces (produce):**
```ts
export interface InventoryScannerDeps { gh: GhRunner; store: SessionStore; inventoryStore: InventoryStore; reconciler: { reconcile(): Promise<TickReport> } /* the trimmed ReconciliationTick */; events: EngineEvents; config: { repos: string[]; me: string; watchAuthors: string[]; prListLimit: number }; now?: () => Date }
export interface ScanReport { inventory: Inventory; groups: InventoryGroups; reconciliation: TickReport }
export class InventoryScanner implements Tickable { constructor(deps); run(): Promise<ScanReport> /* never throws */; readonly lastReport: ScanReport | null }
```
Tick order: (1) reconcile existing review sessions (rereview on new sha; dismiss on merge/close; approve) — this is the trimmed tick, unchanged rules; (2) `gh pr list … --json PR_INVENTORY_FIELDS` per repo (sequential; per-repo errors → `inventory.errors`); (3) `buildEntries` per repo with a fresh `store.list()` (after step 1's transitions); (4) `inventoryStore.save`; (5) emit `inventory.updated`; return. `DiscoveryScheduler` drives it (it already accepts any `Tickable`).
- [ ] Tests: argv per repo pinned with `PR_INVENTORY_FIELDS`; **mutation guard**: a scan over a fixture with 6 unreviewed PRs creates ZERO sessions and starts ZERO runs (assert `store.list()` unchanged and `runner.lastHandle()` throws); a review session at `ready` with a new head sha → rereview started (existing behavior preserved); one repo's gh failure isolated; `inventory.json` written; `inventory.updated` emitted once with the same object saved; `errors[]` never throws (store.list rejection).
- [ ] Remove the strategy module and its tests; update `reconciliation.test.ts` for the trimmed deps (drop created/ignoredOwn/started from `TickReport`, keep actions/skipped/errors). Grep: no remaining import of `pr-discovery-strategy`.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): InventoryScanner (scan + reconcile existing sessions), retire auto-discovery of review sessions`.

### Task A4: `/prs*` routes replace `/discovery/*`; explicit review start

**Files:** modify `src/api/server.ts`, `src/api/validation.ts`, `src/api/http-errors.ts`; tests `test/api/server.test.ts`, `test/api/http-errors.test.ts`.

**Interfaces:** `ApiServerDeps.discovery` becomes `inventory?: { scanner: InventoryScanner; scheduler: DiscoveryScheduler; factory: ReviewSessionFactory; config: { me: string } }`. Routes:
- `GET /prs` → 200 `{ inventory, groups }` from `scanner.lastReport ?? inventoryStore.load()` (404 `{error:'no scan yet'}` if neither).
- `GET /prs/:owner/:repo/:number` → 200 entry | 404.
- `POST /prs/scan` → `scheduler.runNow()` → 200 `ScanReport` | 409 `TickInProgressError`.
- `GET /prs/status` → `{ running, lastScanAt, lastError, skippedBeats }`.
- `POST /prs/:owner/:repo/:number/review` (optional `?refresh=1` → scan first): entry must exist (404); `isMine` → 409 `OwnPrError`; existing non-terminal review session for that PR → 200 `{ session, created: false }`; else `factory.createFromCandidate({ repo, number, url, author, isDraft, reviewDecision, headSha, title, kind: 'review' })` then `pipeline.runReview(id)` detached via `awaitRunStart` → 202 `{ session, created: true }`. Under `lock.withLock(<repo>#<number>)` to make concurrent starts idempotent.
- Delete the `/discovery/*` routes and their tests. `OwnPrError`, `NoScanYetError` → 409/404 mappings.
- [ ] Tests: each route; idempotent double start (two concurrent POSTs → one session); own PR 409; not in inventory 404; `refresh=1` triggers exactly one scan; the detached start responds after `run.started`; **mutation guard**: `GET /prs` and `POST /prs/scan` create no sessions.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): PR inventory API and explicit review start; remove discovery routes`.

---

## Stream B

### Task B1: Typed core config and legacy importer

**Files:** create `src/config/core-config.ts`; test `test/config/core-config.test.ts`.

**Interfaces:**
```ts
export const CoreConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).min(1),
  watchAuthors: z.array(z.string().min(1)).default([]),
  me: z.string().min(1),
  runner: z.enum(['claude-code', 'codex']).default('claude-code'),
  runnerOptions: z.object({ model: z.string().optional(), permissionMode: z.string().optional(), sandbox: z.enum(['read-only','workspace-write','danger-full-access']).optional() }).default({}),
  pollIntervalMs: z.number().int().positive().default(60_000),
  prListLimit: z.number().int().positive().max(100).default(50),
  stateDir: z.string().min(1).default('~/.cgremlin'),          // '~' expanded at load
  sessionsDir/worktreesDir/mirrorsDir/socketPath/inventoryPath: optional strings, defaulting under stateDir: sessions, worktrees, mirrors, engine.sock, inventory.json
  reviewSkillCommand: z.string().default('/APFM:apfm-review'), includeLiveUiCheck: z.boolean().default(true), defaultBaseRef: z.string().default('origin/main'),
});
export type CoreConfig = z.infer<typeof CoreConfigSchema>;
export function resolveCoreConfig(raw: unknown, home: string): CoreConfig   // applies defaults + '~' expansion + derived paths
export async function loadCoreConfig(fs: SessionFileSystem, path: string, home: string): Promise<CoreConfig>   // ConfigError if missing/invalid
export function importLegacyConfig(legacyText: string): Pick<CoreConfig,'repos'|'watchAuthors'|'me'> & { runnerOptions: { model?: string } }  // uses parseLegacyWatchConfig + REVIEW_MODEL
export async function writeCoreConfig(fs, path, cfg, opts: { force: boolean }): Promise<void>   // refuses to overwrite without force (ConfigError)
```
- [ ] Tests: defaults and derived paths; `~` expansion with the given home; invalid repo slug rejected; legacy import from the exact legacy text (incl. `REVIEW_MODEL="opus"` → runnerOptions.model); write refuses overwrite without force, overwrites with force; load of missing file → ConfigError with the path in the message.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): typed core config with defaults and legacy importer`.

### Task B2: `StageRunner` runner-mismatch guard

**Files:** modify `src/pipeline/stage-runner.ts`; test `test/pipeline/stage-runner.test.ts`.
- Rule: if `session.agent` exists and `session.agent.runner !== deps.runnerKind`, do NOT seed `resumeId`; start fresh; set `lastRun.error` on completion to `'runner changed from <old> to <new>; started a fresh conversation'` only if the run otherwise succeeded (outcome stays `succeeded`); overwrite `agent` with the new runner and new resumeId.
- [ ] Tests: session with `agent {runner:'claude-code', resumeId:'x'}` run under `runnerKind 'codex'` → `ctx.resumeId` undefined, agent becomes codex with the fake's new id, `lastRun.error` carries the note; same runner → seeded as before (existing test).
- [ ] RED → implement → GREEN → commit `fix(cgremlin-core): StageRunner never seeds a resume id from a different runner`.

### Task B3: Host — `serve` wiring and lifecycle

**Files:** create `src/host/serve.ts`, `src/host/build-engine.ts`; tests `test/host/build-engine.test.ts`, `test/host/serve.test.ts`.

**Interfaces:**
```ts
export interface EngineAdapters { fs: SessionFileSystem; git: GitRunner; gh: GhRunner; runner: AgentRunner; runnerKind: 'claude-code'|'codex'; clock?: Clock; now?: () => Date }
export interface Engine { server: http.Server; scheduler: DiscoveryScheduler; scanner: InventoryScanner /* Stream A; until merged, type as Tickable & { lastReport: unknown } behind an injected factory */; pipeline: PipelineService; events: EngineEvents; store: SessionStore; lock: KeyedLock; config: CoreConfig }
export function buildEngine(config: CoreConfig, adapters: EngineAdapters): Engine     // pure wiring, no listening, no timers started
export interface ServeHandle { socketPath: string; close(): Promise<void> }
export async function serve(config: CoreConfig, adapters: EngineAdapters, opts: { log: (line: string) => void; signals?: NodeJS.Signals[] }): Promise<ServeHandle>
   // listenOnSocket, scheduler.start(), subscribe to every EngineEvents type and log one JSON line each; close(): scheduler.stop(), pipeline.stop(<every session with lastRun.outcome 'running'>), server.close, unlink socket
export function realAdapters(config: CoreConfig): EngineAdapters   // NodeFileSystem, NodeGitRunner, NodeGhRunner, ClaudeCodeRunner|CodexRunner from config.runner/runnerOptions
```
Until Stream A merges, `buildEngine` wires the EXISTING `ReconciliationTick`-based `DiscoveryScheduler` (current base) behind a `makeTickable(engineParts) => Tickable` injection point so the switch to `InventoryScanner` is a one-line change in B4.
- [ ] Tests (fakes only): `buildEngine` returns all parts sharing one lock/events; `serve` on a temp socket answers `GET /sessions`; `close()` stops the scheduler, calls `pipeline.stop` for a running session (drive one with FakeAgentRunner), closes the server, removes the socket file; a second `serve` on the same socket path while the first runs → `SocketInUseError`; log lines emitted for `session.created`/`run.started`. Signal handling: `serve` registers handlers for the given signals and `close()`s on them — test by emitting the signal on `process` with a dedicated signal name not used by vitest? Not safe; instead expose `handle.onSignal()` and call it directly in the test.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): engine host — buildEngine wiring and serve with clean shutdown`.

### Task B4: CLI (after Stream A merges into base; supervisor merges base into `phase4b-host-cli` first)

**Files:** create `src/cli/main.ts`, `src/cli/client.ts`, `src/cli/commands/{serve,prs,review,sessions,scan,config}.ts`, `bin/cgremlin-core` (node shim requiring `dist/cli/main.js`), modify `package.json` (`"bin": { "cgremlin-core": "bin/cgremlin-core" }`, ensure `build` emits `dist/`); tests `test/cli/client.test.ts`, `test/cli/commands.test.ts`.
- `client.ts`: `request(socketPath, method, path, body?) → { status, body }` (the same helper the tests already use, productionized). Commands are pure functions `(args, io: { stdout, stderr, socketPath, home }) → Promise<exitCode>`; `main.ts` parses argv minimally (no dependency) and dispatches.
- Commands: `serve [--config path] [--verbose]` → loads config, `serve(config, realAdapters(config), …)`, waits for close; `config import-legacy [--force]`; `prs [--json]` → `GET /prs`, human table grouped `UNREVIEWED / TEAM ON IT / OURS / MINE` with columns `#  title  author  flags(draft,newCommits,phase)`; `review <pr-url>` → parse owner/repo/number via `parsePrUrl`, `POST /prs/:owner/:repo/:number/review`, print session id; `sessions [--json]`; `scan`. Non-2xx → print `error` body to stderr, exit 1. Also switch B3's tickable factory to `InventoryScanner` and wire `ApiServerDeps.inventory`.
- [ ] Tests against a real API server on a temp socket built from fakes: each command's exit code and output (snapshot the `prs` table against a fixed inventory); `review` on own PR → exit 1 with the 409 message; `main` unknown command → usage + exit 2.
- [ ] RED → implement → GREEN → commit `feat(cgremlin-core): cgremlin-core CLI (serve, prs, review, sessions, scan, config import-legacy)`.

---

## Definition of Done

- Both branches merged; `pnpm test && pnpm typecheck && pnpm lint && pnpm build` green; `node bin/cgremlin-core --help` prints usage.
- Mutation guards present and shown to fail under mutation: (1) a scan creates no sessions/starts no runs; (2) `GET /prs`/`POST /prs/scan` create no sessions; (3) own-PR start refused; (4) runner mismatch never seeds a foreign resume id.
- No `gh` write anywhere; `grep -rn "pr-discovery-strategy" src test` is empty; `/discovery/*` routes gone.
- Manual live smoke (supervisor): `cgremlin-core config import-legacy`, `cgremlin-core serve` for one scan against the two watched repos with `NodeGhRunner`, `cgremlin-core prs` shows the three groups; NO review started. Then stop with Ctrl-C and confirm the socket file is gone.
- Not in scope: posting to GitHub (spec §9), any UI, own-PR triage, live Codex-through-pipeline verification.
