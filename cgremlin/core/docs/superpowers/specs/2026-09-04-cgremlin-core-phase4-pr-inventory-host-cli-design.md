# cgremlin/core Phase 4 — PR Inventory, Host and CLI: Design

Date: 2026-09-04
Status: approved by the user in conversation (sections 1–8; posting deferred per §9)
Parent specs: `2026-08-28-cgremlin-core-rebuild-design.md` (§6, §9, §11), `2026-09-04-cgremlin-core-phase3-pipelines-design.md` (§5 discovery, §8 supervising agent)
Grounding: `gh` 2.72.0 against `aplaceformom/grace-frontend` and `aplaceformom/grace` (supervisor scratchpad `gh-grounding/round2`, `round3`).

## 0. Why this phase replaces the dashboard

The user dropped the phase-1 web dashboard: the UI will be a VS Code plugin or an app later, reading the engine's API. Two things the engine still lacks are needed now regardless of UI: a runnable **host** (the Phase 3b scheduler has no process to live in) and a **PR inventory** that lets a human decide what to review. The user also reversed the "review every watched PR automatically" behavior: it burns tokens on PRs nobody needs reviewed. Discovery becomes a scan that produces data; starting a review is an explicit action; re-review of PRs we already reviewed stays automatic.

This reverses Phase 3b ruling W2 (the tick auto-starting reviews for discovered candidates) and retires `ReconciliationTick`'s discovery step 2 in favor of the inventory scan described here.

## 1. Deliverables

1. **PR inventory** — scanner + data model + persistence + API.
2. **Host** — `cgremlin-core serve`: engine + socket API + scanner in one process, typed config, legacy config importer.
3. **CLI** — `cgremlin-core prs | review <pr-url> | sessions | scan`: thin socket clients.

Out: any UI; posting to GitHub (§9); own-PR comment triage; live exercise of the Codex runner through the pipeline (config switch exists, verification is Phase 6).

## 2. Inventory data model

Per PR (`InventoryEntry`):

```ts
{
  repo: 'owner/name'; number; url; title; author: login; isDraft: boolean;
  headSha; baseRef; updatedAt;
  reviewDecision: '' | 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED';   // GitHub's own
  isMine: boolean;                                                            // author === me
  teamActivity: { login; kind: 'review' | 'comment'; state?: string; at: string }[]; // see §3
  ours: { status: 'none' } | { status: 'reviewing' | 'reviewed'; sessionId; reviewedSha: string | null; newCommits: boolean; phase: ReviewPhase };
  seenAt: string;                                                             // this scan
}
```

`Inventory = { scannedAt; repos: string[]; entries: InventoryEntry[]; errors: { repo; error }[] }`. Groupings are computed server side and returned alongside: `unreviewed` (not mine, no teamActivity, ours none), `teamOnIt` (teamActivity non-empty, ours none), `ours` (ours ≠ none), `mine` (isMine). A PR can be in `teamOnIt` and still be started by the user — the flag is a signal, not a block.

Persistence: in memory plus `<stateDir>/inventory.json` rewritten atomically after every scan so a client can read the last inventory without the host running. Sessions remain the source of truth for `ours`; the inventory is derived and rebuilt every scan.

## 3. Team activity (the "someone is already on it" flag) — user rulings

- Counts: any **review** (state APPROVED, CHANGES_REQUESTED or COMMENTED) **and any conversation comment** whose author login is in the watched-authors list and is not `me`.
- Excludes bots by construction: the watched-authors list is an allowlist; comment/review authors carry no `is_bot` field in `gh` output (verified), so no login heuristics are used.
- One `gh pr list … --json …,latestReviews,reviews,comments,reviewRequests` per repo provides everything (verified: ~4 s, ~90 KB per repo for ~30 PRs). `comments[]` is conversation-level only; review-line comments are not included and are not needed.

## 4. Scanner (`InventoryScanner`)

Runs on the existing `DiscoveryScheduler` cadence (default 60 s). Each tick:
1. For each configured repo: `gh pr list --repo R --state open --limit N --json number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt,latestReviews,reviews,comments` → parse (zod, extending Phase 3b schemas with `reviews[]`, `comments[]` whose `author` is `{ login }`) → build entries. Per-repo failures land in `inventory.errors`; other repos still update.
2. Join with sessions: for each non-terminal review session with `pr`, set `ours` (`reviewing` if phase ∈ {queued, reviewing}, else `reviewed`), `reviewedSha`, `newCommits = headSha !== reviewedSha`.
3. **Reconcile existing review sessions only** (Phase 3b `planReconciliation`, unchanged): MERGED/CLOSED → dismissed (+ source merged/abandoned), APPROVED → approved, new sha on a reviewed PR → `runRereview`. No session creation, no auto `runReview`.
4. Persist `inventory.json`; emit `inventory.updated` (new `EngineEvents` type) with the inventory.

`ReconciliationTick` keeps its reconciliation half and loses its discovery half; `DefaultPRDiscoveryStrategy` is retired (its filters move into the grouping logic: `isMine`, drafts are listed with the flag rather than dropped).

## 5. Explicit start

`POST /prs/{owner}/{repo}/{number}/review` → if a non-terminal review session for that PR exists, return it (200); else `ReviewSessionFactory.createFromCandidate` from the inventory entry (404 if the PR is not in the inventory; `?refresh=1` forces a scan first), then `PipelineService.runReview` detached (202 with the session after `run.started`, same pattern as `/sessions/:id/run`). Own PRs are refused (409) — the engine never reviews the user's own PRs.

Other routes: `GET /prs` → `{ inventory, groups }`; `GET /prs/{owner}/{repo}/{number}`; `POST /prs/scan` → run a scan now (409 if one is running). The Phase 3b `/discovery/*` routes are replaced by these (`/discovery/status` survives as `GET /prs/status`: running, lastScanAt, lastError, skippedBeats).

## 6. Host — `cgremlin-core serve`

- Typed config `~/.cgremlin/core.json` (zod): `{ repos: string[]; watchAuthors: string[]; me: string; runner: 'claude-code' | 'codex'; runnerOptions?; pollIntervalMs?; sessionsDir?; worktreesDir?; mirrorsDir?; socketPath?; reviewSkillCommand?; includeLiveUiCheck? }` with defaults under `~/.cgremlin/`. `cgremlin-core config import-legacy` reads the legacy `~/.cgremlin/config` (`WATCH_REPOS`, `WATCH_AUTHORS`, `GITHUB_ME`, `REVIEW_MODEL`) via the existing `parseLegacyWatchConfig` and writes `core.json` (refuses to overwrite without `--force`).
- Wiring: `NodeFileSystem`, `NodeGitRunner`, `NodeGhRunner`, the configured `AgentRunner`, `SessionStore`, `WorkspaceManager`, `StageRunner`, `PipelineService`, `ReviewSessionFactory`, `InventoryScanner`, `DiscoveryScheduler`, `createApiServer`, `listenOnSocket`. One shared `KeyedLock`.
- Lifecycle: SIGINT/SIGTERM → stop scheduler, `PipelineService.stop` every running session, close the server, remove the socket file, exit 0. Structured one-line logs to stderr for every engine event (`session.*`, `run.*`, `inventory.updated`); `--verbose` adds `run.output`.
- Runner mismatch guard (from the 2b review): `StageRunner` refuses to seed a `resumeId` when `session.agent.runner !== runnerKind` (starts a fresh conversation and records a `lastRun.error` note).

## 7. CLI

`cgremlin-core prs [--json]` (grouped, human table by default), `cgremlin-core review <pr-url>` (POST, prints the session id), `cgremlin-core sessions [--json]`, `cgremlin-core scan`, `cgremlin-core config import-legacy`. Thin: parse args → one HTTP call over the socket → print. No engine imports beyond the request/response types. Exit code 1 on any non-2xx with the error body printed.

## 8. Testing

- Scanner: unit tests over `FakeGhRunner` with fixtures extended from the round-3 captures (`reviews`, `comments` with blanked bodies): grouping rules, allowlist exclusion of bots, `isMine`, `newCommits`, per-repo failure isolation, no session creation/auto-review (mutation guard), persistence atomicity (tmp+rename).
- Routes: real API server on the fakes; explicit start creates+starts exactly one session and is idempotent; own PR → 409; not in inventory → 404.
- Host: `serve` wiring test with fakes injected (no real CLIs), signal handling test (stop called for running sessions, socket removed). One real smoke with `NodeGhRunner` against a watched repo is manual (supervisor).
- CLI: tests drive the CLI's request function against the real API server on a temp socket; output snapshot for `prs`.

## 9. Deferred: posting to GitHub — user ruling

Deferred. When added, posting is a **separate component** that receives structured input — verdict, and per-finding `{ path, line, body }` items — and performs the `gh` write with the legacy safety check. It must not read `REVIEW.md` or know its format; the caller (a human via CLI, or the future plugin) supplies the content. Until then the engine performs no GitHub write.

## 10. Roadmap effect

Phase 4 (dashboard) is replaced by this phase. Phase 5 (environment tooling) and Phase 6 (parity + cutover, including live Codex-through-pipeline verification and the posting component if wanted then) follow. The supervising-agent idea (Phase 3 spec §8) remains after this phase.
