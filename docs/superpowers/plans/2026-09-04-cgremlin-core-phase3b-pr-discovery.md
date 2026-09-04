# cgremlin/core Phase 3b: PR Discovery, Review-Session Creation, Lineage, Reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the legacy watch daemon's PR-discovery policy and PR↔session bookkeeping as isolated, configurable, fully unit-tested engine components: a read-only `gh` port, review-session creation from a PR URL, the `PRDiscoveryStrategy` interface with the legacy default policy, PR→source-session lineage linking, and a reconciliation tick that turns GitHub state (merged/closed/approved/new commits) into session transitions or re-review runs.

**Architecture:** One impure port (`GhRunner`, exactly like `GitRunner`) with a Node adapter and a fake that refuses any mutating subcommand, so a test proves the engine never writes to GitHub (spec ruling 2). Everything above it is pure over JSON the fake returns: `parsePrUrl`, `mapPrView` (gh JSON → `PrInfo` + status), `ciStatus` (polymorphic `statusCheckRollup`), `DefaultPRDiscoveryStrategy.poll`, `linkPrToSource`, `planReconciliation` (pure decision list) and `ReconciliationTick` (applies decisions through `SessionStore`/`PipelineService`). Scheduling uses an injected timer. Nothing here knows about HTTP until the last task adds two routes.

**Tech Stack:** TypeScript, zod, vitest, `node:child_process` (adapter only). No new dependency.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-04-cgremlin-core-phase3-pipelines-design.md` §5 (components 3b), §2 rulings 2 and 3, §6. Legacy: `bin/cgremlin` `watch_daemon_loop` (:13468–14614), `link_pr_to_source` (:13897), `create_pr_session_noninteractive` (:14003), `is_watched_author` (:13506), `~/.cgremlin/config` keys `WATCH_REPOS`, `WATCH_AUTHORS`, `GITHUB_ME`.

## Verified Ground Truth (captured live 2026-09-04 with `gh` 2.72.0 against the two repos the legacy daemon watches; raw captures in the supervisor's scratchpad `gh-grounding/round2/`; re-verify before deviating)

- `gh pr list --repo <owner/name> --state open --limit 50 --json number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt` prints a JSON array. Empty result is the literal `[]`, exit 0, no stderr.
- List element shape: `{ number: int, url: string, author: { id, is_bot: boolean, login, name }, isDraft: boolean, reviewDecision: "" | "REVIEW_REQUIRED" | "APPROVED" | "CHANGES_REQUESTED", headRefOid: 40-hex, headRefName, baseRefName, title, updatedAt: ISO }`. `reviewDecision` is the **empty string**, never `null`, when no decision exists. Bot-authored PRs were not observed; `author.is_bot` is the documented flag and is treated as authoritative.
- `gh pr view <n> --repo <slug> --json number,title,author,headRefName,headRefOid,baseRefName,url,state,isDraft,reviewDecision,mergedAt,closedAt,latestReviews,statusCheckRollup`: `state` ∈ `OPEN | MERGED | CLOSED` (OPEN and MERGED observed; CLOSED is the documented third value); `mergedAt`/`closedAt` are ISO strings or `null`; for a merged PR both are set and may differ by a second (do not assert equality).
- `latestReviews[]`: `{ id, author: { login }, authorAssociation, body, submittedAt, includesCreatedEdit, reactionGroups, state: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED", commit: { oid } }`. `author` here is `{ login }` only.
- `statusCheckRollup[]` is **polymorphic on `__typename`**: `CheckRun` → `{ __typename, name, status ("COMPLETED"…), conclusion ("SUCCESS" | "SKIPPED" | "NEUTRAL" | "FAILURE" | …), completedAt, startedAt, detailsUrl, workflowName }` (no `state` key); `StatusContext` → `{ __typename, context, state ("SUCCESS" | "PENDING" | "FAILURE" | "ERROR"), startedAt, targetUrl }` (no `conclusion` key). Any CI judgment must branch on `__typename`.
- Legacy jq pipeline `select(.reviewDecision != "APPROVED") | [(.number|tostring), .url, .author.login, (.isDraft|tostring)] | @tsv` emits one TSV line per PR and nothing (0 bytes) for an empty list. The engine parses the JSON directly instead and reproduces the same filter in TypeScript.
- `gh api user --jq .login` prints the bare login. The engine does not call it; `me` comes from config (legacy `GITHUB_ME`).
- Legacy config lines: `WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"` (space-separated slugs), `WATCH_AUTHORS="a b c"` (space-separated logins, matched case-insensitively), `GITHUB_ME="login"`.

## Global Constraints

- Node 24, pnpm 10.10.0, all commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint` green at every commit.
- **The engine never issues a GitHub-mutating command.** `FakeGhRunner` throws on any argv containing `review`, `comment`, `merge`, `close`, `edit`, `create`, `ready`, `--method`, `-X`, `-F`, `-f`; every engine test routes through it. (Spec ruling 2.)
- Own-PR comment triage is out of scope (ruling 3). Own PRs are detected and reported by the strategy with `kind: 'own'` and ignored by the tick.
- No real subprocess in tests except `NodeGhRunner`'s single smoke test, which runs `gh --version` only (allowed to skip when `gh` is not on PATH, like the `NodeGitRunner` test does for `git`).
- `mode` is the only source of truth for session type. Never infer it from an id prefix. Dedup of "already has a review session" uses `session.mode === 'review' && session.pr.repo === slug && session.pr.number === n`.
- Every transition goes through `SessionStore.transition`.
- Work happens on branch `phase3b-discovery`, based on `phase3a-pipeline-engine`; the supervisor merges. Tasks 1–5 touch only new files plus `src/workspace/repo-mirror.ts`; Tasks 6–7 depend on Phase 3a Tasks 8–11 having landed on the base branch and are dispatched only after the supervisor confirms.

## File Structure

- `src/gh/gh-runner.ts` — `GhRunner` port
- `src/gh/node-gh-runner.ts` — adapter (`spawn('gh', args)`)
- `test/support/fake-gh-runner.ts` — fake with canned responses + mutation guard
- `src/gh/pr-url.ts` — `parsePrUrl`
- `src/gh/pr-view.ts` — zod schemas for `gh pr view/list` JSON, `mapPrView`, `ciStatus`
- `src/discovery/discovery-config.ts` — `DiscoveryConfig` schema, `parseLegacyWatchConfig`
- `src/discovery/pr-discovery-strategy.ts` — interface, `CandidatePR`, `DefaultPRDiscoveryStrategy`
- `src/discovery/link-pr-to-source.ts` — pure linker
- `src/pipeline/review-session-factory.ts` — `createReviewSessionFromPr` (+ `repo-mirror.ts` pull refspec)
- `src/discovery/reconciliation.ts` — `planReconciliation` (pure) + `ReconciliationTick`
- `src/discovery/scheduler.ts` — `DiscoveryScheduler`
- `src/api/server.ts` (Task 7 only) — `POST /discovery/tick`, `GET /discovery/config`

---

### Task 1: `GhRunner` port, Node adapter, mutation-guarded fake, `parsePrUrl`

**Files:**
- Create: `src/gh/gh-runner.ts`, `src/gh/node-gh-runner.ts`, `src/gh/pr-url.ts`, `test/support/fake-gh-runner.ts`
- Test: `test/gh/node-gh-runner.test.ts`, `test/support/fake-gh-runner.test.ts`, `test/gh/pr-url.test.ts`

**Interfaces:**
```ts
// gh-runner.ts
export interface GhRunner { run(args: string[]): Promise<{ stdout: string; stderr: string }> }
export class GhCommandError extends Error { name = 'GhCommandError'; constructor(args: string[], exitCode: number | null, stderr: string) }
// node-gh-runner.ts
export class NodeGhRunner implements GhRunner { constructor(binary = 'gh') }   // rejects with GhCommandError on non-zero exit
// fake-gh-runner.ts
export class GhMutationAttemptedError extends Error { name = 'GhMutationAttemptedError' }
export class FakeGhRunner implements GhRunner {
  readonly calls: string[][];
  queueResponse(r: { stdout: string; stderr?: string } | Error): void;   // FIFO like FakeGitRunner
  run(args): Promise<...>  // throws GhMutationAttemptedError BEFORE consuming the queue if args match the guard
}
export const GH_MUTATING_TOKENS = ['review','comment','merge','close','edit','create','ready','--method','-X','-F','-f'] as const
// pr-url.ts
export interface PrRef { owner: string; repo: string; number: number; slug: string /* owner/repo */; url: string /* canonical https://github.com/owner/repo/pull/N */ }
export class InvalidPrUrlError extends Error { name = 'InvalidPrUrlError' }
export function parsePrUrl(input: string): PrRef
```

- [ ] **Step 1: Write the failing tests**

`test/support/fake-gh-runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeGhRunner, GhMutationAttemptedError } from './fake-gh-runner';

describe('FakeGhRunner', () => {
  it('serves queued responses FIFO and records calls', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: '[]' });
    gh.queueResponse({ stdout: '{"number":1}' });
    expect((await gh.run(['pr', 'list', '--repo', 'a/b', '--json', 'number'])).stdout).toBe('[]');
    expect((await gh.run(['pr', 'view', '1'])).stdout).toBe('{"number":1}');
    expect(gh.calls).toEqual([['pr', 'list', '--repo', 'a/b', '--json', 'number'], ['pr', 'view', '1']]);
  });
  it('returns empty stdout when the queue is empty', async () => {
    expect((await new FakeGhRunner().run(['pr', 'list'])).stdout).toBe('');
  });
  it('rethrows a queued Error', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse(new Error('HTTP 404'));
    await expect(gh.run(['pr', 'view', '9'])).rejects.toThrow('HTTP 404');
  });
  it.each([
    ['pr', 'review', '1', '--approve'],
    ['pr', 'comment', '1', '--body', 'x'],
    ['pr', 'merge', '1'],
    ['pr', 'close', '1'],
    ['pr', 'edit', '1'],
    ['pr', 'create', '--draft'],
    ['pr', 'ready', '1'],
    ['api', 'repos/a/b/pulls/1/reviews', '--method', 'POST'],
    ['api', '-X', 'POST', 'x'],
    ['api', 'x', '-F', 'a=b'],
    ['api', 'x', '-f', 'a=b'],
  ])('refuses mutating argv %j before touching the queue', async (...args) => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: 'should not be consumed' });
    await expect(gh.run(args)).rejects.toThrow(GhMutationAttemptedError);
    expect((await gh.run(['pr', 'list'])).stdout).toBe('should not be consumed');
  });
  it('does not confuse a read-only value containing a guarded word', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: 'ok' });
    // "reviewDecision" is a field name, not the `review` subcommand
    expect((await gh.run(['pr', 'list', '--json', 'number,reviewDecision'])).stdout).toBe('ok');
  });
});
```
Guard rule: a token is mutating only if it equals one of `GH_MUTATING_TOKENS` exactly (whole-argv-element match), so `reviewDecision` in a `--json` list is fine but `review` as a subcommand is refused.

`test/gh/pr-url.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InvalidPrUrlError, parsePrUrl } from '../../src/gh/pr-url';

describe('parsePrUrl', () => {
  it('parses canonical, trailing-slash, and /files suffixed URLs', () => {
    for (const u of [
      'https://github.com/aplaceformom/grace-frontend/pull/2019',
      'https://github.com/aplaceformom/grace-frontend/pull/2019/',
      'https://github.com/aplaceformom/grace-frontend/pull/2019/files',
      'http://github.com/aplaceformom/grace-frontend/pull/2019#issuecomment-1',
    ]) {
      expect(parsePrUrl(u)).toEqual({
        owner: 'aplaceformom', repo: 'grace-frontend', number: 2019, slug: 'aplaceformom/grace-frontend',
        url: 'https://github.com/aplaceformom/grace-frontend/pull/2019',
      });
    }
  });
  it('rejects non-PR URLs and non-numeric ids', () => {
    for (const u of ['https://github.com/a/b', 'https://github.com/a/b/issues/3', 'https://gitlab.com/a/b/pull/3', 'https://github.com/a/b/pull/x', ''])
      expect(() => parsePrUrl(u)).toThrow(InvalidPrUrlError);
  });
});
```

`test/gh/node-gh-runner.test.ts` (mirrors `test/git/node-git-runner.test.ts`'s skip-if-missing pattern):
```ts
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { GhCommandError, NodeGhRunner } from '../../src/gh/node-gh-runner';

function hasGh(): boolean { try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch { return false; } }

describe.skipIf(!hasGh())('NodeGhRunner (real binary, read-only)', () => {
  it('runs `gh --version` and returns stdout', async () => {
    const { stdout } = await new NodeGhRunner().run(['--version']);
    expect(stdout).toMatch(/gh version \d+\.\d+\.\d+/);
  });
  it('rejects with GhCommandError carrying exit code and stderr on an unknown subcommand', async () => {
    await expect(new NodeGhRunner().run(['definitely-not-a-subcommand'])).rejects.toBeInstanceOf(GhCommandError);
  });
});
it('NodeGhRunner rejects with GhCommandError when the binary is missing', async () => {
  await expect(new NodeGhRunner('/nonexistent/gh-binary').run(['--version'])).rejects.toBeInstanceOf(GhCommandError);
});
```

- [ ] **Step 2: RED** — modules not found.
- [ ] **Step 3: Implement.** `NodeGhRunner.run` uses `spawn(binary, args, { stdio: ['ignore','pipe','pipe'] })`, collects stdout/stderr, resolves on `close` with code 0, otherwise rejects `GhCommandError(args, code, stderr)`; on `error` (ENOENT) rejects `GhCommandError(args, null, err.message)`. `parsePrUrl`: `new URL(input)` inside try (throw `InvalidPrUrlError` on failure), host must be `github.com`, pathname must match `/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/`.
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): GhRunner port, NodeGhRunner, mutation-guarded FakeGhRunner, parsePrUrl"`

---

### Task 2: `gh pr view/list` JSON schemas, `mapPrView`, `ciStatus`

**Files:**
- Create: `src/gh/pr-view.ts`
- Test: `test/gh/pr-view.test.ts`

**Interfaces:**
```ts
export const PR_LIST_FIELDS = 'number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt'
export const PR_VIEW_FIELDS = 'number,title,author,headRefName,headRefOid,baseRefName,url,state,isDraft,reviewDecision,mergedAt,closedAt,latestReviews,statusCheckRollup'
export const ReviewDecisionSchema = z.enum(['', 'REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'])
export const PrListItemSchema = z.object({ number: z.number().int().positive(), url: z.string().url(), author: z.object({ login: z.string(), is_bot: z.boolean().optional(), id: z.string().optional(), name: z.string().optional() }), isDraft: z.boolean(), reviewDecision: ReviewDecisionSchema, headRefOid: z.string().regex(/^[0-9a-f]{40}$/), headRefName: z.string(), baseRefName: z.string(), title: z.string(), updatedAt: z.string() })
export const PrListSchema = z.array(PrListItemSchema)
export const CheckRunSchema = z.object({ __typename: z.literal('CheckRun'), name: z.string(), status: z.string(), conclusion: z.string().nullable(), completedAt: z.string().nullable().optional(), detailsUrl: z.string().optional(), workflowName: z.string().optional() })
export const StatusContextSchema = z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string(), targetUrl: z.string().nullable().optional() })
export const StatusCheckSchema = z.discriminatedUnion('__typename', [CheckRunSchema, StatusContextSchema])
export const PrViewSchema = z.object({ number, title, author: { login, is_bot? }, headRefName, headRefOid, baseRefName, url, state: z.enum(['OPEN','MERGED','CLOSED']), isDraft, reviewDecision: ReviewDecisionSchema, mergedAt: z.string().nullable(), closedAt: z.string().nullable(), latestReviews: z.array(z.object({ author: z.object({ login: z.string() }), state: z.string(), submittedAt: z.string() }).passthrough()), statusCheckRollup: z.array(StatusCheckSchema).nullable().default([]) })
export type PrView = z.infer<typeof PrViewSchema>
export type CiStatus = 'success' | 'pending' | 'failure' | 'none'
export function ciStatus(checks: readonly z.infer<typeof StatusCheckSchema>[]): CiStatus
   // none if empty; failure if any CheckRun.conclusion ∈ {FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE} or StatusContext.state ∈ {FAILURE, ERROR}; pending if any CheckRun.status !== 'COMPLETED' or StatusContext.state === 'PENDING' or 'EXPECTED'; else success (SKIPPED/NEUTRAL count as success)
export function mapPrView(slug: string, view: PrView): { pr: PrInfo; state: PrView['state']; isDraft: boolean; reviewDecision: ReviewDecision; ci: CiStatus }
   // PrInfo = { repo: slug, number, url, headSha: headRefOid, reviewedSha: null, title, author: author.login }
export function parsePrList(stdout: string): PrListItem[]      // JSON.parse + PrListSchema.parse; '' → []
export function parsePrView(stdout: string): PrView
```

- [ ] **Step 1: Write the failing tests.** Use fixtures copied from the grounding captures (the supervisor will provide two real, body-blanked `pr view` JSON documents and one `pr list` document under `test/fixtures/gh/`: `pr-list-open.json` (≥3 items incl. one draft), `pr-view-open-approved.json`, `pr-view-merged.json`). Tests:
  1. `parsePrList` of the fixture returns items typed with `reviewDecision` `''`/`'REVIEW_REQUIRED'`/`'APPROVED'` and boolean `isDraft`; `parsePrList('[]')` and `parsePrList('')` return `[]`.
  2. `parsePrList` rejects an item whose `headRefOid` is not 40 hex or whose `reviewDecision` is an unknown string.
  3. `parsePrView` of the merged fixture → `state 'MERGED'`, `mergedAt` non-null; of the open fixture → `state 'OPEN'`, `mergedAt null`.
  4. `ciStatus`: `[]` → `'none'`; all CheckRun SUCCESS/SKIPPED/NEUTRAL + StatusContext SUCCESS → `'success'`; one CheckRun `conclusion: 'FAILURE'` → `'failure'`; one CheckRun `status: 'IN_PROGRESS', conclusion: null` → `'pending'`; one StatusContext `state: 'PENDING'` → `'pending'`; StatusContext `state: 'ERROR'` → `'failure'`; failure beats pending when both present.
  5. `mapPrView` maps `headRefOid → headSha`, `author.login → author`, `reviewedSha: null`, `repo: slug`.
  6. `statusCheckRollup: null` parses as `[]` (gh emits null when the PR has no checks — treat as none).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): gh pr list/view JSON schemas, PrInfo mapping, polymorphic CI status"`

---

### Task 3: `DiscoveryConfig`, legacy config parser, `DefaultPRDiscoveryStrategy`

**Files:**
- Create: `src/discovery/discovery-config.ts`, `src/discovery/pr-discovery-strategy.ts`
- Test: `test/discovery/discovery-config.test.ts`, `test/discovery/pr-discovery-strategy.test.ts`

**Interfaces:**
```ts
// discovery-config.ts
export const DiscoveryConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).min(1),
  watchAuthors: z.array(z.string().min(1)),
  me: z.string().min(1),
  pollIntervalMs: z.number().int().positive().default(60_000),
  prListLimit: z.number().int().positive().max(100).default(50),
})
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>
export function parseLegacyWatchConfig(text: string): Pick<DiscoveryConfig, 'repos' | 'watchAuthors' | 'me'>
   // parses KEY="v1 v2" / KEY=v lines for WATCH_REPOS, WATCH_AUTHORS, GITHUB_ME; ignores comments/blank/other keys; throws ValidationError-like ConfigError if a required key is missing
// pr-discovery-strategy.ts
export interface CandidatePR { kind: 'review' | 'own'; repo: string; number: number; url: string; author: string; isDraft: boolean; reviewDecision: ReviewDecision; headSha: string; title: string }
export interface DiscoveryContext { existingSessions: readonly Session[] }
export interface PRDiscoveryStrategy { poll(config: DiscoveryConfig, ctx: DiscoveryContext): Promise<CandidatePR[]> }
export class DefaultPRDiscoveryStrategy implements PRDiscoveryStrategy {
  constructor(gh: GhRunner)
  poll(config, ctx): Promise<CandidatePR[]>
}
```
  `poll` runs, per repo: `['pr','list','--repo',repo,'--state','open','--limit',String(prListLimit),'--json',PR_LIST_FIELDS]`, `parsePrList`, then filters exactly as legacy: drop `reviewDecision === 'APPROVED'`; keep only authors in `watchAuthors` (case-insensitive); `kind = 'own'` when `author.login` equals `me` case-insensitively; drop drafts unless `kind === 'own'`; drop `author.is_bot === true`; drop any PR that already has a session `s.mode === 'review' && s.pr?.repo === repo && s.pr.number === number`. A `gh` failure for one repo is captured and the other repos still return — `poll` returns candidates and attaches errors via a second return? No: keep the interface simple — errors propagate per call, BUT the strategy processes repos sequentially and wraps each in try/catch, collecting `{ repo, error }` into `this.lastErrors` (public readonly array reset per poll) so a tick can log them; candidates from healthy repos are still returned.

- [ ] **Step 1: Write the failing tests.**
  Config: parse the exact legacy text `WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"\nWATCH_AUTHORS="a b guilleazoubel"\nGITHUB_ME="guilleazoubel"\n# comment\nREVIEW_MODEL="opus"` → repos/watchAuthors/me; unquoted values work; missing `GITHUB_ME` throws; `DiscoveryConfigSchema` applies defaults 60000/50 and rejects `repos: []`.
  Strategy (with `FakeGhRunner` queuing one `pr list` JSON per repo, built from small inline items — write a `item(overrides)` helper producing a valid `PrListItem`):
  1. argv per repo is exactly the pinned list command (assert `gh.calls`).
  2. drops APPROVED; keeps `''`, `REVIEW_REQUIRED`, `CHANGES_REQUESTED`.
  3. author allowlist is case-insensitive (`'GuilleAzoubel'` matches `guilleazoubel`); unknown author dropped.
  4. own PR → `kind: 'own'` even if draft; someone else's draft dropped; someone else's non-draft → `kind: 'review'`.
  5. `is_bot: true` dropped even if login is allowlisted.
  6. dedup: a review session with `pr.repo`/`pr.number` matching is dropped; a session for the same number in a different repo is NOT a match; a development session with the same `pr` does not block (only `mode === 'review'` counts).
  7. **mutation guard:** a session whose id starts with `pr-<repo>-<n>-` but has `mode: 'development'` must NOT dedup the candidate (proves we do not infer from id prefix).
  8. one repo's `gh` call rejecting (queue an Error) leaves the other repo's candidates intact and records `{ repo, error }` in `lastErrors`.
  9. empty list → `[]`, no error.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): DiscoveryConfig with legacy parser, PRDiscoveryStrategy interface and legacy-policy default"`

---

### Task 4: `linkPrToSource` (pure lineage linking)

**Files:**
- Create: `src/discovery/link-pr-to-source.ts`
- Test: `test/discovery/link-pr-to-source.test.ts`

**Interfaces:**
```ts
export interface LinkResult { source: Session | null; linked: ReviewSession; supersede: boolean /* true when source is development at pr_opened */ }
export function linkPrToSource(review: ReviewSession, sessions: readonly Session[]): LinkResult
```
  Legacy two-pass rule (bin/cgremlin:13904–13935): pass 1 — a non-terminal `development` or `investigation` session whose `pr.repo === review.pr.repo && pr.number === review.pr.number`; pass 2 — if none, a non-terminal development/investigation session whose `lineage.ticket` equals `review.lineage.ticket` (when non-null). On match: `linked = { ...review, lineage: { pipelineId: source.lineage.pipelineId, parentSessionId: source.id, ticket: source.lineage.ticket ?? review.lineage.ticket } }`; `supersede = source.mode === 'development' && source.stageStatus === 'pr_opened'`. The function does not persist or transition; the caller does (`store.save(linked)`; `store.transition(source.id,'superseded')` when `supersede`). If several candidates match, pick the most recent `createdAt`.

- [ ] **Step 1: Write the failing tests** covering: pass-1 match by repo+number; same number different repo not matched; pass-2 fallback by ticket; ticket `null` never matches; terminal sources (`merged`, `abandoned`, `promoted_to_development`) skipped; most-recent wins on ties; `supersede` true only for development@pr_opened (false for development@active and for investigation sources); no match → `source null`, `linked` equals input, `supersede false`.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): pure PR-to-source-session lineage linker (legacy two-pass rule)"`

---

### Task 5: PR-head refspec on the mirror and `createReviewSessionFromPr`

**Files:**
- Modify: `src/workspace/repo-mirror.ts`
- Create: `src/pipeline/review-session-factory.ts`
- Test: `test/workspace/repo-mirror.test.ts` (extend), `test/pipeline/review-session-factory.test.ts`

**Interfaces:**
```ts
// repo-mirror.ts: ensureMirror additionally sets `remote.origin.fetch` twice (git config --add) so both refspecs exist:
//   +refs/heads/*:refs/remotes/origin/*  and  +refs/pull/*/head:refs/remotes/origin/pr/*
// On an existing mirror, run `git config --get-all remote.origin.fetch` and add the pull refspec only if absent (idempotent).
// review-session-factory.ts
export interface ReviewSessionFactoryDeps { gh: GhRunner; store: SessionStore; workspace: WorkspaceManager; events: EngineEvents; sessionsDir: string; worktreesDir: string; now?: () => Date; newId?: (slug: string, number: number) => string }
export class ReviewSessionFactory {
  constructor(deps)
  createFromPrUrl(prUrl: string): Promise<ReviewSession>
  createFromCandidate(c: CandidatePR): Promise<ReviewSession>
}
```
  Behavior (legacy order, bin/cgremlin:14003–14080): (1) `parsePrUrl`; (2) `gh pr view <n> --repo <slug> --json PR_VIEW_FIELDS` FIRST (metadata before any clone, for instant visibility) → `mapPrView`; (3) id = `newId(slug, n)` default `pr-<repo name>-<n>-<stamp>`; (4) `workspace.createWorkspace({ repoUrl: 'https://github.com/<slug>.git', worktreePath: `${worktreesDir}/${id}`, branchName: `pr-${n}`, baseRef: `origin/pr/${n}`, mode: 'review' })`; (5) build the review session at `queued` with `pr` from `mapPrView`, `reviewVersion 0`, `lineage: { pipelineId: id, parentSessionId: null, ticket: null }`; (6) `linkPrToSource(session, await store.list())` → save `linked`; if `supersede`, `store.transition(source.id, 'superseded')`; (7) emit `session.created`; return. If `createWorkspace` throws, nothing is saved. `createFromCandidate` skips `parsePrUrl` and uses `c.repo`/`c.number`.

- [ ] **Step 1: Write the failing tests.** Mirror: `FakeGitRunner` call assertions — fresh clone adds both refspecs via `config --add`; existing mirror with only the heads refspec gets the pull refspec added once; existing mirror with both gets no `--add`. Factory (FakeGhRunner + FakeGitRunner + InMemoryFileSystem + real `WorkspaceManager` + real `SessionStore`): `gh pr view` is called before any git call; pinned view argv; worktree path/branch/baseRef; session fields; linking to a development session at `pr_opened` with matching repo+number → that session becomes `superseded` and the review inherits `pipelineId`/`ticket`; no-source case leaves lineage self-rooted; `createWorkspace` failure ⇒ no session saved and no transition; invalid URL ⇒ `InvalidPrUrlError` and no `gh` call.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): PR-head fetch refspec on mirrors; ReviewSessionFactory from PR URL/candidate with lineage linking"`

---

### Task 6: Reconciliation — pure decisions and the tick (dispatched after Phase 3a Tasks 8–9 land on the base)

**Files:**
- Create: `src/discovery/reconciliation.ts`
- Test: `test/discovery/reconciliation.test.ts`

**Interfaces:**
```ts
export type ReconcileAction =
  | { type: 'transition'; sessionId: string; to: string; reason: string }
  | { type: 'rereview'; sessionId: string; reason: string }
  | { type: 'create-review'; candidate: CandidatePR }
  | { type: 'ignore-own'; candidate: CandidatePR }
export function planReconciliation(input: { review: ReviewSession; view: ReturnType<typeof mapPrView>; source: Session | null }): ReconcileAction[]
   // MERGED: review→dismissed; source (if non-terminal) development→merged (from pr_opened|superseded) — investigation sources are left alone
   // CLOSED (not merged): review→dismissed; source development→abandoned
   // OPEN & reviewDecision APPROVED & review phase ∈ {ready, changes_requested, failed, queued}: review→approved   (legacy: lifecycle approved, keep visible)
   // OPEN & view.pr.headSha !== review.pr.reviewedSha && review phase ∈ {ready, changes_requested}: rereview
   // otherwise: []
   // Never emits an action whose transition the table forbids for the current phase (guard with canTransition; drop silently with reason logged in a second return? → return { actions, skipped: {sessionId,to,why}[] })
export interface ReconciliationTickDeps { gh: GhRunner; store: SessionStore; strategy: PRDiscoveryStrategy; factory: ReviewSessionFactory; pipeline: PipelineService; events: EngineEvents; config: DiscoveryConfig }
export interface TickReport { reconciled: number; actions: ReconcileAction[]; skipped: ...[]; created: string[]; ignoredOwn: number; errors: { where: string; error: string }[] }
export class ReconciliationTick { constructor(deps); run(): Promise<TickReport> }
   // 1) for each non-terminal review session with pr: gh pr view → mapPrView → planReconciliation → apply (transition via store; rereview via pipeline.runRereview without awaiting the run's completion — await only its pre-run transition, i.e. fire and record; errors captured per session)
   // 2) strategy.poll(config, { existingSessions: store.list() }) → for each candidate: kind 'review' → factory.createFromCandidate; kind 'own' → ignoredOwn++
   // 3) never throws; every failure lands in report.errors
```

- [ ] **Step 1: Write the failing tests** for `planReconciliation` (one per rule above, plus "approved review not re-reviewed", "queued review with new commits not re-reviewed", "forbidden transition is skipped not emitted") and for `ReconciliationTick` (FakeGhRunner queued views; FakeAgentRunner-backed PipelineService; assert transitions, that `runRereview` was invoked exactly for the new-commit case, that a `gh pr view` rejection for one session does not stop others, and that own candidates are counted and not created). **Mutation guard:** a test that queues a `pr view` for a review session whose `headSha` differs but whose phase is `queued` and asserts no rereview started.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): PR reconciliation planner and tick (merged/closed/approved/new-commit handling, discovery-driven review creation)"`

---

### Task 7: `DiscoveryScheduler` and API routes (dispatched after Phase 3a Task 11 lands on the base)

**Files:**
- Create: `src/discovery/scheduler.ts`
- Modify: `src/api/server.ts`, `src/api/http-errors.ts`
- Test: `test/discovery/scheduler.test.ts`, `test/api/server.test.ts` (extend)

**Interfaces:**
```ts
export interface Clock { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void }
export class DiscoveryScheduler {
  constructor(tick: { run(): Promise<TickReport> }, intervalMs: number, clock: Clock = globalThis)
  start(): void; stop(): void; isRunning(): boolean; readonly lastReport: TickReport | null
  // never overlaps: if a tick is still running when the interval fires, skip that beat and count `skippedBeats`
}
```
  Routes: `POST /discovery/tick` → runs one tick now (409 `TickInProgressError` if one is running) → 200 `TickReport`; `GET /discovery/config` → 200 `DiscoveryConfig` (no secrets involved); `GET /discovery/status` → `{ running, lastReport, skippedBeats }`.

- [ ] **Step 1: Write the failing tests** with a fake clock (capture the interval callback and fire it manually): start registers exactly one interval with `intervalMs`; firing runs the tick; firing while a tick promise is unresolved does not start a second (`skippedBeats` 1); stop clears the interval; `lastReport` updates. API: the three routes with a `ReconciliationTick` built on fakes.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): non-overlapping discovery scheduler and discovery API routes"`

---

## Definition of Done

- `pnpm test && pnpm typecheck && pnpm lint` green from `cgremlin/core/` on `phase3b-discovery`.
- `grep -rn "'review'\|'comment'\|'merge'\|'close'\|'create'" src/gh src/discovery src/pipeline/review-session-factory.ts` shows these words only inside `GH_MUTATING_TOKENS`/error messages — no engine argv builds a mutating `gh` command, and `FakeGhRunner` proves every engine path in tests.
- All interfaces above exist with the stated signatures; the four mutation guards (FakeGhRunner refuses writes; id-prefix must not dedup; queued review with new commits is not re-reviewed; forbidden transitions are skipped not emitted) are present as tests and were each shown to fail under the corresponding code mutation (executor reports the mutation and failing test; supervisor reproduces at least two).
- Fixtures under `test/fixtures/gh/` are real captures with `latestReviews[].body` blanked and no PR bodies/comments.
- Explicitly not in this plan: posting anything to GitHub; own-PR comment triage; a long-running daemon process/entrypoint (the scheduler is started by whoever hosts the engine — Phase 4/6); typed per-repo config file (Phase 5; `parseLegacyWatchConfig` is the bridge).
