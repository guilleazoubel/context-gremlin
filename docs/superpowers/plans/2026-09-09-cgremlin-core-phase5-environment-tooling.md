# cgremlin/core Phase 5: Environment Tooling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine typed per-repo environment config, ownership of the local app lifecycle (start with env pulled → healthcheck → stop), Vercel preview-URL derivation, and restore the legacy `## LIVE UI CHECK` protocol **and the legacy REVIEW.md output contract** into `BRIEF.md` — without the engine ever driving a browser and without agents ever calling back into the engine.

**Architecture:** Two independent streams, then a sequential convergence. **Stream A (pure):** `core.json` gains an `environments` map, a 0600 write path, a redactor and a `remove()` on the filesystem port; a pure decoder for the `vercel` bot's `[vc]:` PR comment; the brief renderers (environment block + verbatim LIVE UI CHECK protocol + verbatim REVIEW.md contract + new review/rereview briefs). **Stream B (process):** a `LocalAppRunner` port with a Node adapter and a fake. **Convergence (sequential, after both merge):** `EnvironmentService` (the `run_local` decision tree, serialized on a `local-app:<port>` lock key), pipeline integration (**environment prepared and app started BEFORE the per-session lock is entered**, brief rendered from that context, teardown in an outer `finally` outside the existing `preRunCommitted` try/catch and taking no session lock), then API routes + CLI + host wiring (boot-time orphan reap, close ordering, log redaction).

**Tech Stack:** TypeScript, zod, vitest, `node:child_process` (`spawn` detached, `execFile`), `node:http`/`node:https`. No new dependencies.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-09-cgremlin-core-phase5-environment-tooling-design.md` (rulings R1–R16 are binding and confirmed; R3/R4/R6/R11 carry AMENDED text — read those, not the superseded draft wording).

## Verified Ground Truth (2026-09-09, planner + supervisor grounding pass)

**Legacy source of truth**
- Legacy `run_local`/`stop_local` are `bin/cgremlin:541–633`; config parsing/defaults `:40–74`; the LIVE UI CHECK protocol `:1430–1484`; **the REVIEW.md output contract `:1497–1660`**; the protocol's three call sites `:1667` (review, observe), `:14350` and `:14395` (develop, fix); the review brief's preview instruction `:1149`; the investigation brief's local-run line `:14182`.
- Legacy calls the `vercel` CLI in exactly three places: `vercel whoami` (`:534`), `vercel link --yes --scope "$VERCEL_SCOPE" --project "$VERCEL_PROJECT"` (`:579`), `vercel env pull .env.local` (`:581`). It **never** calls it to derive a preview URL. The dashboard's `vercel_preview_url_template` (`:9681`) defaults to `""` and is unused.

**Vercel / GitHub**
- The bot's GitHub login is exactly **`vercel`** — **not** `vercel[bot]` (23 comments across 20 open `grace-frontend` PRs).
- Decode rule: `/^\[vc\]: #[^:]+:(\S+)/m` → base64, **padding-tolerant** (real bodies need `'=' * (-len % 4)` re-added) → JSON `{ isMonorepo, type, projects: [{ name, projectId, rootDirectory, inspectorUrl, previewUrl, nextCommitStatus, liveFeedback }] }`. Decoded cleanly for all 20 PRs, 4 projects each (`grace-frontend-dev`, `grace-frontend-storybook`, `grace-ops`, `grace-portal`).
- **`previewUrl` is nullable** — `null` observed on `grace-frontend-storybook` for `IGNORED` projects (PRs #2030, #2018, #1955, #1908, #1907, #1906, #1905). `null` and `''` both mean "no URL".
- `nextCommitStatus` observed live: `DEPLOYED`, `IGNORED`, `SKIPPED`, **`PENDING`** (PR #2037, `grace-frontend-dev`, with `previewUrl` still populated) — so a non-`DEPLOYED` status still yields a usable URL.
- A **"Deployment failed for project …"** `vercel` comment variant exists (PR #1904) that carries **no** `[vc]:` marker — it must be skipped, never throw.
- `aplaceformom/grace` (backend) has **zero** `vercel` comments on any open PR (authors: `apfm-sonar`, `gitstream-cm`) — it gets no `environments` entry, no LIVE UI CHECK, and no prompt sentence (R14).
- `gh pr view <n> --json statusCheckRollup` returns Vercel entries as `StatusContext` with `targetUrl = https://vercel.com/<scope>/<project>/<id>` — an **inspector** URL, not navigable to the app.
- The preview host returns `302 → https://vercel.com/sso-api?...` unauthenticated; `200` with header `x-vercel-protection-bypass: <secret>`; `307` back to the bare URL with `?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true`.

**Cold setup (measured in a fresh clone)**
- `vercel link --yes --scope grace-0118bc61 --project grace-frontend-dev` → exit 0, **~1 s, no prompts**, CLI **48.1.0**.
- `vercel env pull .env.local` → exit 0, **~1 s, no prompts**; `grep -c '=' .env.local` → **71**.
- `pnpm install` → exit 0, **~15 s**. Its `postinstall` (`pnpm generate:types`) fails when the backend is down but swallows the error (pnpm still exits 0), and `packages/grace-api/src/generated` **does not exist at all** → a *missing* directory must count as "empty" in the `postInstallNonEmptyDirs` check.
- `.env.local` and `.vercel` **are already gitignored** in `grace-frontend` (`.gitignore:79 .env*.local`, `.gitignore:49 .vercel`). The exclude guard is implemented anyway, for repos that lack those rules.
- The repo's `CLAUDE.md` is a **symlink to `AGENTS.md`** (so core writing `BRIEF.md` instead keeps a clean separation from the repo's own instructions).

**Local app / machine**
- `bash -lc '… nvm use 24 …; exec pnpm dev'` in a fresh checkout **exits 1 immediately** via `scripts/ensure-portal-stack.sh`: it requires a `portal.local.findcare.dev.aplaceformom.com` `/etc/hosts` entry **and** a Caddy port-forward on 8443, both sudo-only (`Run 'pnpm setup:local' once …` / `[ELIFECYCLE] Command failed with exit code 1.`). Both exist on the supervisor's machine but not in a fresh environment. The engine never fixes this — it fast-fails and reports the log (R11).
- `.nvmrc` is `v24`; system node is `v24.18.0`, pnpm `10.10.0`, nvm `0.39.7`.
- `curl -sk … https://local.findcare.dev.aplaceformom.com/` before start → **http_code 000, curl exit 7**. `dig +short` → empty: the host resolves **only** via `/etc/hosts`.
- `lsof -t -nP -iTCP:8080 -sTCP:LISTEN` exits 1 with no output when free; `ps -o pgid= -p <pid>` prints the pgid.
- Prereqs present: bare `local.findcare.dev.aplaceformom.com` hosts entry, `/Library/LaunchDaemons/com.grace.portforward.plist`, `~/.nvm/nvm.sh`, `NODE_AUTH_TOKEN`. **Absent:** the `portal.local.*` hosts entry, the Caddy 8443 forward.
- `~/.cgremlin/config` has `VERCEL_AUTOMATION_BYPASS_SECRET` but none of the `LOCAL_*`/`VERCEL_SCOPE`/`VERCEL_PROJECT` keys — the importer must supply the legacy defaults (`bin/cgremlin:69–74`).
- **UNVERIFIED against the real app, closed by test instead:** whether `pnpm dev`'s eventual HTTP listener sits in the spawned process group could not be exercised (the dev command never starts on a machine without the sudo prereqs). B1 therefore includes a **real-process test with a tiny node fixture server spawned through the identical wrapper**, asserting the listener's pgid equals the spawned child's pgid and that killing the group frees the port.

**Engine facts the plan builds on**
- `renderReviewPrompt` points at a CLAUDE.md that core never writes (`src/pipeline/prompts.ts:132`); review/rereview run with `brief: null` (`src/pipeline/pipeline-service.ts:367`, `:472`).
- `runStageLocked` (`src/pipeline/pipeline-service.ts:122–136`) takes `brief: string | null` and runs `preRun` **inside** `this.lock.withLock(id, …)`; the locking-invariant comment at `:1–14` says pre-run work under that lock must not re-acquire it. **Phase 5 does not change either** — environment work happens before the lock (R4 AMENDED).
- `runReview`/`runRereview` each wrap `runStageLocked` in a `try/catch` guarded by `preRunCommitted` (`:364–386`, `:469–498`); the new teardown `finally` goes **outside** that.
- `SessionFileSystem` (`src/fs/session-file-system.ts`) has 6 methods and no chmod/stat/remove; `ARTIFACT_NAME_PATTERN` (`src/api/validation.ts:86`) is a strict allowlist that excludes `.bypass-secret`.
- `GitRunner.run(args, { cwd })` rejects on non-zero exit — that is how the gitignore guard detects "not ignored". `FakeGitRunner.queueResponse(new Error(...))` reproduces it.
- `repoSlugFromUrl` currently lives at the bottom of `pipeline-service.ts` (`:557`, re-exported as `repoSlug`) — it moves to a leaf module so `EnvironmentService` can use it without an import cycle.
- `serve.ts` logs verbose `run.output` chunks at `:90` and closes in `doClose()` at `:119–148`.

## Global Constraints

- Node 24, pnpm 10.10.0, commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint` green at every commit.
- **The engine never drives a browser.** No Playwright, no chrome-devtools, no page object anywhere in `src/`.
- **Agents never call back into the engine.** No brief may contain `cgremlin --run-local`, `cgremlin --stop-local`, `engine.sock`, `POST /sessions/`, or `curl ` (MG-7). The bare string `/sessions/` is *allowed* — briefs legitimately name `<sessionDir>` paths.
- **The engine never kills a process it did not start** (R6/R13). No `kill` of a pid discovered via `lsof` except the lingering-listener backstop *after* our own process group is already down; the boot reap acts only on a pgid the engine itself recorded.
- **The engine never runs sudo**, never runs `pnpm setup:local` / `nvm install`, and never edits `/etc/hosts`, Caddy config or nvm aliases.
- No GitHub write (Phase 4 §9 still deferred). The only new `gh` call is `gh pr view <n> --repo <slug> --json comments`.
- The bypass secret must not reach `BRIEF.md`, any log line, any HTTP response, or `inventory.json` (MG-1/2/3), and every bypass URL in captured output/log tails is redacted.
- `environments` is additive: an existing `core.json` with no `environments` key must load unchanged and every stage must behave exactly as it does today.
- Stream A branch `phase5a-config-briefs`, Stream B branch `phase5b-local-app`, both off `mission-control-pr-orchestrator`. Supervisor merges A, then B, then Tasks C1–C3 run sequentially on the merged base.

## File Structure

**Stream A:** `src/fs/session-file-system.ts` (modify: `writeFile` mode option, `statMode`, `remove`), `src/fs/node-file-system.ts` + `test/support/in-memory-file-system.ts` + `test/support/file-system-contract.ts` (modify), `src/config/core-config.ts` (modify: environment schemas, 0600 write, load-mode assertion, `redactCoreConfig`, `redactBypassUrls`, importer keys), `src/env/vercel-preview.ts` (create), `src/gh/repo-slug.ts` (create), `src/gh/pr-view.ts` (modify), `test/fixtures/gh/pr-comments-vercel.json` (create), `src/pipeline/prompts.ts` (modify: environment section, UI-check protocol, REVIEW.md contract, review/rereview briefs, optional `env` params), `src/pipeline/pipeline-service.ts` (A2: re-export only).
**Stream B:** `src/env/local-app-runner.ts` (create), `src/env/node-local-app-runner.ts` (create), `test/support/fake-local-app-runner.ts` (create), `test/fixtures/local-app/fixture-server.js` (create).
**Convergence:** `src/env/environment-service.ts` (create), `src/pipeline/pipeline-service.ts` (modify), `src/api/server.ts` + `src/api/http-errors.ts` (modify), `src/cli/commands/local.ts` (create), `src/cli/main.ts` (modify), `src/host/build-engine.ts` + `src/host/serve.ts` (modify), `src/cli/commands/config.ts` (modify).

---

## Stream A — pure (config, parsing, briefs). Tasks A1, A2, A3 have no dependency on each other and may be done in any order.

### Task A1: `environments` config, 0600 secret storage, redaction, `fs.remove` — tier `executor-heavy`

**Files:** modify `src/fs/session-file-system.ts`, `src/fs/node-file-system.ts`, `test/support/in-memory-file-system.ts`, `test/support/file-system-contract.ts`, `src/config/core-config.ts`, `src/cli/commands/config.ts`; tests `test/config/core-config.test.ts`, `test/fs/*` (contract additions), `test/cli/config.test.ts`.

**Interfaces (produce):**
```ts
// src/fs/session-file-system.ts
export interface SessionFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>;
  statMode(path: string): Promise<number | null>;   // null when the path does not exist; permission bits only (mode & 0o777)
  remove(path: string): Promise<void>;              // deletes a file; no-op when absent (ENOENT swallowed)
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}
// src/config/core-config.ts — schemas exactly as spec §3
export const LocalPrereqsSchema; export const LocalAppConfigSchema;
export const VercelConfigSchema;  export const ClerkConfigSchema;
export const RepoEnvironmentSchema; export type RepoEnvironment = z.infer<typeof RepoEnvironmentSchema>;
// CoreConfigSchema gains: environments (default {}), localAppStatePath (optional, derived `${stateDir}/local-app.json`)
export function redactCoreConfig(cfg: CoreConfig): CoreConfig;
export function redactBypassUrls(text: string): string;   // /x-vercel-protection-bypass=[^&\s]+/g → 'x-vercel-protection-bypass=<redacted>'
export function hasAnySecret(cfg: CoreConfig): boolean;
export const CONFIG_FILE_MODE = 0o600;
```
`remove` is used by `clearBypassSecret` (C1) and by the stale-`local-app.json` clear (C1/C3); it is added here because it changes the port every adapter and fake implements.

Behaviour: `writeCoreConfig` writes the tmp file with `{ mode: CONFIG_FILE_MODE }` before renaming. `loadCoreConfig` calls `statMode(path)` and, when the resolved config `hasAnySecret` and `(mode & 0o077) !== 0`, throws `ConfigError("Config file '<path>' holds a secret but is mode 0<oct>; run chmod 600 '<path>'")`. `localAppStatePath` joins `DERIVED_PATH_SUFFIXES` with suffix `local-app.json`. `importLegacyConfig` additionally returns `environments` built from `LOCAL_URL`/`LOCAL_PORT`/`LOCAL_DEV_CMD`/`LOCAL_NODE_VERSION`/`VERCEL_SCOPE`/`VERCEL_PROJECT`/`VERCEL_AUTOMATION_BYPASS_SECRET` (legacy defaults `https://local.findcare.dev.aplaceformom.com`, `8080`, `pnpm dev`, `24`, `grace-0118bc61`, `grace-frontend-dev`) keyed by the **first** slug in `WATCH_REPOS`, with `previewProject = project`, `postInstallNonEmptyDirs: []`, `stages: ['develop']`, and the four legacy prereqs; when `WATCH_REPOS` is empty it returns `environments: {}`.

- [ ] **RED** — extend the filesystem contract test (`test/support/file-system-contract.ts`, already run against both `NodeFileSystem` and `InMemoryFileSystem`) with: `writeFile(p, 'x', { mode: 0o600 })` then `statMode(p) === 0o600`; `writeFile` with no options leaves the default mode; `statMode` of a missing path is `null`; `statMode` of a directory returns its bits; `remove` deletes a file so `exists` is false; `remove` of a missing path resolves without throwing; `remove` then `readFile` rejects. Then config tests:
  - a `core.json` with no `environments` key loads with `environments === {}` and every other field identical to today (regression pin);
  - `RepoEnvironmentSchema` defaults: `previewStages === ['review','rereview']`, `localApp.stages === ['develop']`, `localApp.port === 8080`, `localApp.devCommand === 'pnpm dev'`, `clerk.testEmailTemplate === 'uicheck-{key}+clerk_test@example.com'`, `clerk.verificationCode === '424242'`, `localApp.healthTimeoutMs === 90_000`, `localApp.insecureTls === true`;
  - an `environments` key whose slug does not match `owner/name` is rejected;
  - `localApp.url` must be a URL; `localApp.port` 0 and 70000 rejected;
  - `localAppStatePath` derives to `<stateDir>/local-app.json` and is omitted by `writeCoreConfig` when it equals the derived default;
  - **MG-8 `config-file-is-0600`**: `writeCoreConfig` with a `bypassSecret` yields `statMode === 0o600`; `loadCoreConfig` on a 0o644 file *with* a secret throws `ConfigError` naming the path; the same file *without* any secret loads fine;
  - `redactCoreConfig` replaces every `bypassSecret` with `'[redacted]'`, deep-clones (mutating the result does not touch the input), and leaves configs without secrets structurally equal;
  - `redactBypassUrls`: replaces the value in `https://h/?x-vercel-protection-bypass=abc123&x-vercel-set-bypass-cookie=true` leaving the trailing param intact; replaces **every** occurrence in a multi-line chunk; stops at whitespace (`… bypass=abc def` keeps ` def`); leaves text with no match byte-identical;
  - `importLegacyConfig` on the exact legacy text `WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"` + `VERCEL_AUTOMATION_BYPASS_SECRET="abc"` produces `environments['aplaceformom/grace-frontend'].vercel.bypassSecret === 'abc'` with all six legacy defaults applied, and nothing under `aplaceformom/grace`;
  - `importLegacyConfig` with no `WATCH_REPOS` → `environments === {}`.
- [ ] **GREEN** — implement. `NodeFileSystem.writeFile` forwards `mode` to `fs.writeFile`; `statMode` is `fs.stat(...).mode & 0o777`, `null` on ENOENT; `remove` is `fs.rm(path, { force: true })`. `InMemoryFileSystem` stores a mode alongside each entry (default `0o644` for files, `0o755` for dirs) and drops the entry on `remove`.
- [ ] Commit `feat(cgremlin-core): per-repo environment config with 0600 secret storage and redaction`.

### Task A2: Vercel preview-URL decoder + `repoSlugFromUrl` extraction — tier `executor`

**Files:** create `src/env/vercel-preview.ts`, `src/gh/repo-slug.ts`, `test/fixtures/gh/pr-comments-vercel.json`; tests `test/env/vercel-preview.test.ts`, `test/gh/repo-slug.test.ts`. Modify `src/gh/pr-view.ts` to export `PR_COMMENTS_FIELDS = 'comments'` and `parsePrComments(stdout): { author: { login: string }; body: string }[]` (zod, `''` → `[]`, unknown extra fields ignored) so `EnvironmentService` does not hand-roll JSON parsing. Modify `src/pipeline/pipeline-service.ts` **only** to delete the local `repoSlugFromUrl` definition and re-export it (`export { repoSlugFromUrl, repoSlugFromUrl as repoSlug } from '../gh/repo-slug';`) so every existing importer is unaffected — this breaks the `environment-service → pipeline-service → environment-service` cycle C1 would otherwise create. Move its existing tests to `test/gh/repo-slug.test.ts` and keep one pin that the re-export is still reachable from `pipeline-service`.

**Interfaces (produce):**
```ts
// src/gh/repo-slug.ts
export function repoSlugFromUrl(repoUrl: string): string;   // body moved verbatim from pipeline-service.ts:557
// src/env/vercel-preview.ts
export interface VercelPreviewProject {
  name: string; projectId: string; rootDirectory: string | null;
  inspectorUrl: string; previewUrl: string | null; nextCommitStatus: string;
}
export function parseVercelPreviewComment(bodies: readonly string[]): VercelPreviewProject[];
export function pickPreviewProject(projects: readonly VercelPreviewProject[], name: string): VercelPreviewProject | null;
export function previewUrlWithBypass(host: string, secret: string): string;
```

**Fixture — `test/fixtures/gh/pr-comments-vercel.json`.** Build it by capturing live data and redacting, exactly as the existing `test/fixtures/gh/pr-list-*.json` fixtures do (human bodies replaced with `"[BLANKED]"`). The redacted capture from the grounding pass lived in a scratchpad that has since been cleaned up, so **re-capture it**:

```
gh pr view 2036 --repo aplaceformom/grace-frontend --json comments > /tmp/raw.json
```
Then produce a file with **exactly this shape** — the `gh pr view --json comments` envelope, trimmed to the fields the parser and its tests need:

```jsonc
{
  "comments": [
    {
      "id": "IC_kwDO…",
      "author": { "login": "vercel" },
      "authorAssociation": "NONE",
      "body": "[vc]: #<hash>:<base64>\n\n**The latest updates on your projects.** …",  // VERBATIM from the capture
      "createdAt": "2026-08-27T15:29:29Z",
      "url": "https://github.com/aplaceformom/grace-frontend/pull/2036#issuecomment-…"
    },
    { "id": "IC_kwDO…", "author": { "login": "apfm-sonar" }, "body": "[BLANKED]", "createdAt": "…", "url": "…" },
    { "id": "IC_kwDO…", "author": { "login": "guilleazoubel" }, "body": "[BLANKED]", "createdAt": "…", "url": "…" }
  ]
}
```
Rules for the fixture: the **`vercel`-authored body is kept byte-for-byte** (its `[vc]:` payload is public deployment metadata — projects, ids, preview hostnames — and contains no secret); **every non-`vercel` body is replaced with `"[BLANKED]"`**; at least one non-`vercel` comment is kept so the tests exercise filtering. If PR #2036's decoded project names or hostnames differ from the assertions below at capture time, update the assertions to whatever the fixture actually contains and keep the *shape* of each test — the point is the decoder, not those exact strings.

Full test file (adjust only the literal names/hosts to match the captured fixture):
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVercelPreviewComment, pickPreviewProject, previewUrlWithBypass } from '../../src/env/vercel-preview';

const capture = JSON.parse(readFileSync(new URL('../fixtures/gh/pr-comments-vercel.json', import.meta.url), 'utf8')) as {
  comments: { author: { login: string }; body: string }[];
};
const bodies = capture.comments.map((c) => c.body);
const vercelBodies = capture.comments.filter((c) => c.author.login === 'vercel').map((c) => c.body);

function encode(payload: unknown): string {
  return `[vc]: #hash:${Buffer.from(JSON.stringify(payload)).toString('base64')}\nsome trailing text`;
}
const oneProject = { isMonorepo: false, type: 'github', projects: [
  { name: 'p', projectId: 'prj_1', rootDirectory: null, inspectorUrl: 'https://vercel.com/s/p/1', previewUrl: 'p-git-b.example.com', nextCommitStatus: 'DEPLOYED', liveFeedback: { resolved: 0, unresolved: 0, total: 0, link: '' } },
] };

describe('parseVercelPreviewComment', () => {
  it('decodes the real grace-frontend comment into its four projects', () => {
    const projects = parseVercelPreviewComment(bodies);
    expect(projects.map((p) => p.name).sort()).toEqual(
      ['grace-frontend-dev', 'grace-frontend-storybook', 'grace-ops', 'grace-portal'],
    );
    const dev = projects.find((p) => p.name === 'grace-frontend-dev')!;
    expect(dev.previewUrl).toMatch(/^grace-frontend-dev-git-.+\.preview\.findcare\.dev\.aplaceformom\.com$/);
    expect(dev.inspectorUrl).toMatch(/^https:\/\/vercel\.com\/grace-0118bc61\/grace-frontend-dev\//);
    expect(dev.nextCommitStatus).toBe('DEPLOYED');
  });
  it('ignores the blanked non-vercel bodies', () => {
    expect(parseVercelPreviewComment(vercelBodies)).toEqual(parseVercelPreviewComment(bodies));
  });
  it('accepts a null previewUrl', () => {
    const nulled = { ...oneProject, projects: [{ ...oneProject.projects[0], previewUrl: null, nextCommitStatus: 'IGNORED' }] };
    expect(parseVercelPreviewComment([encode(nulled)])[0].previewUrl).toBeNull();
  });
  it('skips the "Deployment failed for project …" comment variant', () => {
    expect(parseVercelPreviewComment(['Deployment failed for project [grace-frontend-storybook](https://vercel.com/x) …'])).toEqual([]);
  });
  it('returns [] when no body carries the marker', () => {
    expect(parseVercelPreviewComment(['just a comment', ''])).toEqual([]);
  });
  it('returns [] for no bodies at all', () => {
    expect(parseVercelPreviewComment([])).toEqual([]);
  });
  it('skips a body whose base64 is not decodable JSON and keeps a later valid one', () => {
    expect(parseVercelPreviewComment(['[vc]: #h:!!!!not-base64-json!!!!', encode(oneProject)]).map((p) => p.name)).toEqual(['p']);
  });
  it('skips a payload that decodes but fails the schema', () => {
    expect(parseVercelPreviewComment([encode({ isMonorepo: true, type: 'github', projects: [{ name: 'x' }] })])).toEqual([]);
  });
  it('only reads the marker at the start of a line', () => {
    expect(parseVercelPreviewComment([`prefix [vc]: #h:${Buffer.from('{}').toString('base64')}`])).toEqual([]);
  });
  it('tolerates missing base64 padding', () => {
    const raw = Buffer.from(JSON.stringify(oneProject)).toString('base64').replace(/=+$/, '');
    expect(parseVercelPreviewComment([`[vc]: #h:${raw}`]).map((p) => p.name)).toEqual(['p']);
  });
  it('takes the first marker-bearing body when several exist', () => {
    const second = { ...oneProject, projects: [{ ...oneProject.projects[0], name: 'q' }] };
    expect(parseVercelPreviewComment([encode(oneProject), encode(second)]).map((p) => p.name)).toEqual(['p']);
  });
});

describe('pickPreviewProject', () => {
  it('finds by exact name', () => {
    expect(pickPreviewProject(parseVercelPreviewComment(bodies), 'grace-portal')?.name).toBe('grace-portal');
  });
  it('is case sensitive and returns null for an unknown name', () => {
    const projects = parseVercelPreviewComment(bodies);
    expect(pickPreviewProject(projects, 'Grace-Portal')).toBeNull();
    expect(pickPreviewProject(projects, 'nope')).toBeNull();
  });
  it('returns null for an empty project list', () => {
    expect(pickPreviewProject([], 'p')).toBeNull();
  });
});

describe('previewUrlWithBypass', () => {
  it('builds the legacy query-param form and encodes the secret', () => {
    expect(previewUrlWithBypass('host.example.com', 'a b&c')).toBe(
      'https://host.example.com/?x-vercel-protection-bypass=a%20b%26c&x-vercel-set-bypass-cookie=true',
    );
  });
});
```
- [ ] **RED** with the file above (commit the fixture first).
- [ ] **GREEN** — implement per spec §4.3; add `parsePrComments`/`PR_COMMENTS_FIELDS` in `src/gh/pr-view.ts` with two tests (`''` → `[]`; a comment lacking `author.login` is rejected); move `repoSlugFromUrl` and re-export it.
- [ ] Commit `feat(cgremlin-core): decode Vercel preview URLs from the vercel bot PR comment`.

### Task A3: Brief environment block, LIVE UI CHECK protocol, REVIEW.md contract, review/rereview briefs — tier `executor`

**Files:** modify `src/pipeline/prompts.ts`; test `test/pipeline/prompts.test.ts`.

**Interfaces (produce):**
```ts
export interface EnvironmentBriefContext {
  localUrl: string | null; localLogPath: string | null; localUnavailableReason: string | null;
  previewUrl: string | null; previewUnavailableReason: string | null;
  bypassSecretPath: string | null;
  clerk: { emailTemplate: string; verificationCode: string } | null;
}
export const EMPTY_ENVIRONMENT: EnvironmentBriefContext;   // every field null
export function renderEnvironmentSection(ctx: EnvironmentBriefContext): string;                 // '' when ctx has no non-null field
export function renderUiCheckProtocol(mode: 'observe' | 'fix', target: string, ctx: EnvironmentBriefContext): string;  // '' when both URLs are null
export function renderReviewContract(): string;            // the verbatim legacy REVIEW.md contract (below)
export function renderReviewBrief(p: { sessionDir: string; prNumber: number; env?: EnvironmentBriefContext }): string;
export function renderRereviewBrief(p: { sessionDir: string; prNumber: number; commitCount: number; env?: EnvironmentBriefContext }): string;
// FindingsBriefParams and DevelopBriefParams each gain `env?: EnvironmentBriefContext`
```
**Every `env` parameter is OPTIONAL and defaults to `EMPTY_ENVIRONMENT`**, so existing call sites and tests compile untouched and keep byte-identical output.

Text is spec §4.4, with the LIVE UI CHECK body byte-identical to `bin/cgremlin:1436–1483` except the "Reaching the target" bullets.

**`renderReviewPrompt` gating (R14):** the sentence `` Then ALWAYS run the '## LIVE UI CHECK' section in `${sessionDir}/BRIEF.md` … `` is emitted only when the brief actually rendered that section. Implement by giving `ReviewPromptParams` the existing `includeLiveUiCheck?: boolean` **plus** a required-in-practice `uiCheckRendered: boolean` (default `false` at the type level is not enough — pass it explicitly from `runReview`, computed as `renderUiCheckProtocol(...) !== ''`), and emit the sentence only when `(includeLiveUiCheck ?? true) && uiCheckRendered`. `renderRereviewPrompt`'s two `in CLAUDE.md` references become `` in `${sessionDir}/BRIEF.md` `` unconditionally (the evidence bar is always rendered into the rereview brief). No other prompt text moves.

**`renderReviewContract()` — reproduce `bin/cgremlin:1596–1660` VERBATIM.** This is the contract the legacy review agent got from `CLAUDE.md` and is the whole reason `REVIEW.md` has a stable shape; `evaluateReview` and every downstream consumer depend on it. The exact text to emit (inner fences included — they are part of the emitted markdown):

````text
## Output — write `REVIEW.md` in this directory, EXACTLY this structure

```
# PR Review: #<number> — <title>

**Does it do what the ticket asked?** ✅ Yes / ⚠️ Mostly / ❌ No — <one plain sentence, name the ticket>
**How deep did I look?** Quick pass / Deep pass (<one-line why>)

## Summary
<2-3 plain sentences: what this PR changes, and your overall take. A teammate should understand the gist from this alone.>

## What I found
| # | Severity | Where | Issue | Status |
|---|----------|-------|-------|--------|
| [1](#f1) | 🔴 Critical | `file.ts:88` | one plain-English line | open |
| [2](#f2) | 🔧 Maintainability | `ui/list.tsx:40` | one plain-English line | open |
| [3](#f3) | 📋 PM/AC | `/search` behavior | acceptance criterion not met — <one line> | open |
| [4](#f4) | 🎨 Design | `PrimaryButton` on `/search` | colour/size differ from Figma — <one line> | open |

📋 PM/AC findings come from the acceptance-criteria check; 🎨 Design findings come from the Figma-fidelity check. Design findings additionally carry Expected vs Actual and an Evidence link (see the detail shape below).

The `#` links jump to the full detail below. Keep the `Status` column current — it's how the reviewer sees at a glance what's still open.

(If nothing: write "Nothing worth flagging — looks good to me." and set the verdict to Approve.)

## Details

<a id="f1"></a>
### 1. <plain-English title of the problem>
**Severity:** 🔴 Critical   **Where:** `path/to/file.ext:LN-LN`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/path/to/file.ext#L<start>-L<end>

**What's wrong:** <2-4 plain sentences. Describe when it happens, what the code does, and what it should do instead — in normal language, no jargon.>

**Why it matters:** <1-2 sentences on the real-world impact: who is affected and how.>

**Suggested fix:** <plain description; add a short code snippet only if it makes it clearer.>

<a id="f2"></a>
### 2. <plain-English title>
**Severity:** 🔧 Maintainability   **Where:** `path/to/file.ext:LN-LN`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/ui/list.tsx#L40

**What's wrong:** <same shape — for a maintainability issue, explain in plain words what's mixed together that shouldn't be.>

**Why it matters:** <the concrete cost: what becomes hard to test, change, or reuse.>

**Suggested fix:** <how to separate the concerns.>

<a id="f4"></a>
### 4. Button colour and size don't match the Figma design
**Severity:** 🎨 Design   **Where:** `/search` — `PrimaryButton`   **Status:** open
**Expected (design):** background `#1A73E8`, font-size `16px`
**Actual (rendered):** background `#1B74E9`, font-size `14px`
**Evidence:** ui-findings/finding-4.html (composed image: ui-findings/finding-4.png)

**What's wrong:** <plain sentence: which property differs, on which element/route.>

**Why it matters:** <impact on brand consistency / usability.>

**Suggested fix:** <the design token or style to apply.>

## Verdict
✅ Approve / 🔄 Request Changes / 💬 Comment — <one plain sentence explaining the call>

## Review History
| Version | Date | Commit | Action |
|---------|------|--------|--------|
| v1 | <date> | <sha> | Initial review |
```

Rules for the file:
- Follow this structure EXACTLY, every time. Same headings, same order, same finding shape.
- Every finding has a stable anchor `<a id="fN"></a>` right before its heading, and the table's `#` cell links to it as `[N](#fN)`. Anchor ids never change across re-reviews (finding 1 is always `f1`).
- `Status` appears in TWO places per finding — the table row and the detail heading — and they must always match. Values: `open` (new), `held` (queued to post), `posted` (sent), `resolved` (fixed, confirmed on re-review), `🔇 dismissed` (skip in re-reviews). Set everything to `open`; the triage and re-review agents change it later.
- Keep it tight. The reviewer reads this to get the picture in under a minute, then talks through anything unclear with the agent.
````

`renderReviewBrief` = `# REVIEW — PR #<n>` header + the Tier-0 intent-gate instruction (`bin/cgremlin:1513–1518`, verbatim: find the Jira key, fetch it, judge, write the `Intent alignment:` line ✅/⚠️/❌, raise a 🔴 when ⚠️/❌) + the evidence bar (`:1527–1541`) + the severity list (`:1567–1571`) + the **Link:** permalink rule (`:1578`, verbatim: build it once from `git config --get remote.origin.url` and `git rev-parse HEAD`, full 40-char SHA, `#L<start>-L<end>` for a range) + `renderEnvironmentSection` + `renderUiCheckProtocol('observe', …)` + `renderReviewContract()`.
`renderRereviewBrief` = `# RE-REVIEW — PR #<n>` header + `<commitCount> new commit(s)` + the evidence bar + the **Link:** rule + `renderEnvironmentSection` + `renderUiCheckProtocol('observe', …)` + `renderReviewContract()`.

- [ ] **RED** — tests:
  - `renderEnvironmentSection(EMPTY_ENVIRONMENT) === ''`.
  - with only `localUrl`+`localLogPath`: contains the URL and the log path, contains no `Vercel preview`, no `Clerk`.
  - with `localUnavailableReason: 'port 8080 is held by pid 4242'`: contains `Local app: UNAVAILABLE — port 8080 is held by pid 4242` and `Do not attempt to start it yourself`.
  - with `previewUrl` + `bypassSecretPath`: contains the preview URL and the sentence pointing at `<sessionDir>/.bypass-secret`.
  - with `clerk`: contains the template and the code.
  - **MG-1 `secret-never-in-brief` (type pin)**: render all five briefs with `bypassSecretPath: '/s/.bypass-secret'` and assert no output contains `S3CRET-VALUE`; add a comment naming C2 as the behavioural guard (the renderers cannot receive the value — that is the pin).
  - **MG-7 `no-agent-callback`**: none of the five briefs contains `cgremlin --run-local`, `cgremlin --stop-local`, `engine.sock`, `POST /sessions/`, or `curl `. Add a positive control asserting a brief *does* contain `/s/BRIEF.md` (proving the guard did not just outlaw session paths).
  - `renderUiCheckProtocol('observe', t, ctx)` contains `**Mode — OBSERVE:**` and not `**Mode — FIX:**`, and vice versa; both contain `## LIVE UI CHECK — PM + Designer lenses (dedicated subagents)`, `**PM subagent (product manager verifying the ticket):**`, `**Designer subagent (designer checking pixel fidelity):**`, `finding-N-figma.png`, `**Degradation:**`, and `+clerk_test@example.com`.
  - `renderUiCheckProtocol(mode, t, EMPTY_ENVIRONMENT) === ''` (no target ⇒ no protocol; pins R14).
  - `renderUiCheckProtocol('fix', ...)` uses the custom `clerk.verificationCode` when given, and `424242` when `clerk` is null but a URL exists.
  - **REVIEW.md contract** — `renderReviewContract()` and, through it, both `renderReviewBrief` and `renderRereviewBrief`, contain each of: `## Output — write \`REVIEW.md\` in this directory, EXACTLY this structure`, `# PR Review: #<number> — <title>`, `**Does it do what the ticket asked?**`, `**How deep did I look?**`, `## Summary`, `## What I found`, `| # | Severity | Where | Issue | Status |`, all six legend glyphs `🔴`/`🟠`/`🟡`/`🔧`/`📋`/`🎨`, `## Details`, `## Verdict`, `## Review History`, `| Version | Date | Commit | Action |`.
  - **anchor rule** — the contract contains `<a id="f1"></a>`, `<a id="f2"></a>`, `<a id="f4"></a>`, the table cells `[1](#f1)` and `[4](#f4)`, and the sentence `Anchor ids never change across re-reviews (finding 1 is always \`f1\`)`; and for every `<a id="fN"></a>` present there is a matching `[N](#fN)` (assert programmatically by extracting both sets with a regex and comparing).
  - **Link rule** — the brief contains `https://github.com/<owner>/<repo>/blob/<full-sha>/` and the words `FULL 40-char SHA`.
  - **Tier-0 intent line** — the brief contains `Intent alignment:` and `✅ satisfies / ⚠️ partial / ❌ diverges`.
  - `renderReviewBrief` contains `# REVIEW — PR #123`, the environment section, and the OBSERVE protocol; with `env` omitted it contains neither a `## Environment` heading nor a `## LIVE UI CHECK` heading but still contains the full REVIEW.md contract.
  - `renderRereviewBrief` contains `# RE-REVIEW — PR #123` and `2 new commit(s)`.
  - `renderDevelopBrief` step 5 contains `The local app is already running at https://local.example.com` and `Watch /s/logs/dev-server.log` when the context has them, and omits step 5's local half entirely when `localUrl` is null.
  - `renderFindingsBrief` and `renderDevelopBrief` with `env` **omitted** are byte-identical to today's output (regression pin — snapshot the current strings first).
  - `renderReviewPrompt({ …, uiCheckRendered: true })` contains ``'## LIVE UI CHECK' section in /s/BRIEF.md`` and does not contain `CLAUDE.md`; with `uiCheckRendered: false` it contains **no** `LIVE UI CHECK` sentence at all; `renderRereviewPrompt(...)` does not contain `CLAUDE.md`.
- [ ] **GREEN** — implement.
- [ ] Commit `feat(cgremlin-core): environment brief section, LIVE UI CHECK protocol and the REVIEW.md contract in BRIEF.md`.

---

## Stream B — process (runs in parallel with all of Stream A)

### Task B1: `LocalAppRunner` port, Node adapter, fake — tier `executor`

**Files:** create `src/env/local-app-runner.ts`, `src/env/node-local-app-runner.ts`, `test/support/fake-local-app-runner.ts`, `test/fixtures/local-app/fixture-server.js`; tests `test/env/node-local-app-runner.test.ts`, `test/support/fake-local-app-runner.test.ts`.

**Interfaces (produce):** exactly spec §4.1 (`LocalAppSpec`, `LocalAppProcess`, `HealthResult` **including `exited: boolean`**, `ExecResult`, `LocalAppRunner` **including `headLog`**, `LocalAppPortBusyError` (`(port, pid, ours)`), `LocalAppPrereqError`, `LocalAppUnhealthyError`).

`NodeLocalAppRunner` details fixed here so the executor makes no judgment call:
```ts
function wrap(command: string, nodeVersion?: string): string {
  return nodeVersion === undefined
    ? `exec ${command}`
    : `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use ${nodeVersion} >/dev/null 2>&1 || exit 78; exec ${command}`;
}
```
(exit 78 = `EX_CONFIG`; C1 maps it to `LocalAppPrereqError`.) `exec` → `execFile('bash', ['-lc', wrap(...)], { cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64*1024*1024 })`, resolving (never rejecting) with `{ code, stdout, stderr }`. `start` → `openSync(logPath, 'w')` + `spawn('bash', ['-lc', wrap(...)], { cwd, detached: true, stdio: ['ignore', fd, fd] })` + `unref()` + `closeSync(fd)`; returns `{ pid: child.pid, pgid: child.pid, startedAt }`. `healthcheck` polls `GET ${url}/` (`https` when the URL is https, with `rejectUnauthorized: !insecureTls`), per-attempt socket timeout = `intervalMs`, healthy = `status >= 200 && status < 300`; when `opts.proc` is supplied each attempt also checks `isAlive` and a dead process ends the poll at once with `{ ok: false, status: null, exited: true, reason: 'dev command exited before the port answered' }`. `stop` → `SIGTERM` to `-pgid`, poll `isAlive` every 200 ms up to 5 s, `SIGKILL` to `-pgid`, then if `portListenerPid(port)` is non-null `SIGTERM` that pid; every kill swallows `ESRCH`. `isAlive` → `process.kill(-pgid, 0)` true / `ESRCH` false. `tailLog`/`headLog` → last/first N lines or `''` when absent.

**Fixture server — `test/fixtures/local-app/fixture-server.js`** (committed, ~15 lines): reads `process.env.FIXTURE_PORT`, `http.createServer((_, r) => { r.writeHead(200); r.end('ok'); }).listen(port)`, logs one line to stdout on `listening`, and — when `process.env.FIXTURE_SPAWN_CHILD` is set — `spawn('sleep', ['300'], { stdio: 'ignore' })` and writes that child's pid to `process.env.FIXTURE_CHILD_PID_FILE`. It is started **through the same wrapper the real dev command uses**: `spec.command = \`node ${fixturePath}\`` so the spawned shell is `bash -lc 'exec node …/fixture-server.js'`. This is what closes the process-group question the live grounding pass could not answer against `pnpm dev`.

- [ ] **RED (fake)** — `FakeLocalAppRunner` contract tests: `queueExec` responses are returned in order and recorded in `execCalls`; `queueHealth` likewise; `setPortListener(1234)` makes `portListenerPid` return `1234` for any port; `start` records the spec, returns the scripted process and sets the port listener to it; `stop` records and clears it; `isAlive` reflects start/stop and `setAlive`; unqueued `exec` defaults to `{ code: 0, stdout: '', stderr: '' }`; when constructed with a shared `callLog: string[]` it appends `'local.start'` / `'local.stop'` in order (used by C2's MG-9).
- [ ] **RED (adapter, real subprocess, one file, POSIX-only via `describe.skipIf(process.platform === 'win32')`)** — against the committed fixture server on a free port (obtained by binding `0` and closing):
  1. `start` returns a pid, the log file exists, and the server's stdout lands in it;
  2. `healthcheck` on `http://127.0.0.1:<port>` resolves `{ ok: true, status: 200, exited: false }` well inside the timeout;
  3. `healthcheck` against a closed port resolves `{ ok: false, status: null, exited: false, reason }` after ~`timeoutMs` (use `timeoutMs: 600, intervalMs: 100`);
  4. `healthcheck` with `proc` for a command that exits immediately (`spec.command = "sh -c 'exit 1'"`, `timeoutMs: 10_000`) resolves `{ ok: false, exited: true }` in well under a second — the R11 fast-fail;
  5. `portListenerPid(<port>)` is non-null while up and `null` after `stop`;
  6. **process group** — `pgidOf(portListenerPid(port))` equals the returned `pgid` (the listener spawned through `bash -lc 'exec node …'` leads the same group as the spawned child);
  7. `stop` kills the whole group and frees the port — with `FIXTURE_SPAWN_CHILD=1`, `process.kill(childPid, 0)` throws `ESRCH` after `stop`, and `portListenerPid(port)` is `null`;
  8. `stop` on an already-dead process resolves without throwing;
  9. `exec('echo hi', { cwd })` → `{ code: 0, stdout: 'hi\n' }`; `exec("sh -c 'exit 3'", …)` → `{ code: 3 }` and does not reject. **Never `exec` a bare shell builtin** (`exec exit 3` replaces the shell and is not a portable way to get exit 3) — use `sh -c 'exit 3'` or `node -e 'process.exit(3)'`;
  10. `exec` with `logPath` appends both streams to the log;
  11. `exec('true', { cwd, nodeVersion: 'definitely-not-a-version' })` → `{ code: 78 }` (the wrapper's `EX_CONFIG` path), skipped when `~/.nvm/nvm.sh` is absent;
  12. `tailLog(missing, 5) === ''`; `tailLog(file, 2)` returns the last two lines; `headLog(file, 2)` returns the first two.
  Every test cleans up in `afterEach` by `stop`ping any process it started and asserting the port is free.
- [ ] **GREEN** — implement both.
- [ ] Commit `feat(cgremlin-core): LocalAppRunner port with detached Node adapter and fake`.

---

## Convergence — sequential, on the merged base (supervisor merges Stream A, then Stream B)

### Task C1: `EnvironmentService` — the `run_local` decision tree — tier `executor-heavy`

**Depends on:** A1, A2, B1.

**Files:** create `src/env/environment-service.ts`; test `test/env/environment-service.test.ts`.

**Interfaces (produce):** exactly spec §4.2 (`LocalAppState`, `LocalAppStatus`, `EnvironmentServiceDeps` — note it takes `git: GitRunner` and the shared `lock: KeyedLock` — and `EnvironmentService`, including `reconcileOrphans()`).

Key behaviours fixed by the rulings: every read-modify-write of `local-app.json` runs inside `lock.withLock('local-app:' + port, …)` (R15); a missing **or** empty `postInstallNonEmptyDirs` entry both count as empty; the gitignore guard runs after `vercel env pull`; a dev command that exits before the healthcheck passes raises `LocalAppPrereqError` carrying `headLog(logPath, 40)` passed through `redactBypassUrls` (R11); wrapper exit 78 maps to `LocalAppPrereqError`; a pid corrected from the port listener also re-derives `pgid` via `pgidOf` (R16); `logTail` in every returned `LocalAppStatus` is redacted (R3).

- [ ] **RED** — over `FakeLocalAppRunner` + `FakeGhRunner` + `FakeGitRunner` + `InMemoryFileSystem`, a real `KeyedLock`, a fixed clock, and a `CoreConfig` with one configured repo:
  - `environmentFor` resolves via `repoSlugFromUrl` (`https://github.com/o/r.git` → `o/r`), returns `undefined` for an unconfigured repo;
  - `wantsLocalApp`/`wantsPreview` respect `localApp.stages` / `previewStages`, and are `false` when the repo has no environment;
  - `checkPrereqs`: a missing `/etc/hosts` entry, a missing required file, and an unset required env var each yield the legacy message verbatim; all present → `[]`; `vercel whoami` exit ≠ 0 → `PREREQ: not logged into Vercel. Run 'vercel login'.`;
  - `start` with a failing prereq → `state 'unavailable'`, reason contains every failing message, and `FakeLocalAppRunner.startCalls` is empty;
  - `ensureSetup` **fast path**: `.env.local` present, `node_modules` present, `postInstallNonEmptyDirs` non-empty → zero `vercel`/install `exec` calls and zero `git` calls;
  - `ensureSetup` **cold path**: exact argv order `vercel link --yes --scope <scope> --project <project>`, `vercel env pull .env.local`, `git check-ignore -q .env.local .vercel`, `pnpm install`; `fresh: true` forces it even when the fast-path conditions hold;
  - a `postInstallNonEmptyDirs` entry that **does not exist at all** triggers the cold path exactly like an empty one (grounded: `packages/grace-api/src/generated` is absent, not empty);
  - **gitignore guard, both branches with `FakeGitRunner`**: (a) `check-ignore` resolves → nothing appended, exactly one `git` call; (b) `check-ignore` rejects (`queueResponse(new Error('exit 1'))`) → the service resolves the exclude path (a second `git rev-parse --git-path info/exclude` call) and appends exactly the two lines `.env.local` and `.vercel`, preserving any existing content and not duplicating on a second run;
  - `vercel link` non-zero → unavailable with `ERROR: vercel link failed (scope <s> / project <p>)`;
  - `vercel env pull` non-zero → `ERROR: vercel env pull failed`; a pulled file with zero `=` lines → `ERROR: .env.local came back empty`;
  - install non-zero → `ERROR: pnpm install failed — see <logPath>.install`;
  - an empty `postInstallNonEmptyDirs` entry after install → the legacy "dev backend unreachable — API types not generated" message;
  - **MG-6 `no-port-steal`**: `setPortListener(9999)` with no state file → `unavailable` with the "which the engine did not start — it will not be killed" wording, `startCalls` empty, `stopCalls` empty;
  - port busy by **our own** recorded pid/pgid (state file present, session mismatch) → the other R6-(b) message naming `cgremlin-core local stop`, still no kill;
  - reuse: state file names this session, `isAlive` true, healthcheck 200 → `state 'running'`, `startCalls` empty (legacy idempotency);
  - stale state: state file names this session but `isAlive` false → the state file is cleared via `fs.remove` and a fresh start proceeds;
  - **dev command exits before the healthcheck** (`queueHealth({ ok: false, exited: true })`) → `LocalAppPrereqError` path: `state 'unavailable'`, reason contains the first 40 log lines, and the failure is reported in well under `healthTimeoutMs` (assert the fake's clock was not advanced to the timeout);
  - wrapper exit 78 from `exec` → `LocalAppPrereqError`;
  - healthcheck plain timeout → `stop` called exactly once, `state 'unavailable'`, reason contains `did not come up` and the 20-line log tail;
  - pid + pgid correction: `start` returns pid 100 but `portListenerPid` returns 200 and `pgidOf(200)` is 250 → the persisted state records `pid: 200, pgid: 250`;
  - `logTail` in a returned status is redacted: a log containing `?x-vercel-protection-bypass=S3CRET-VALUE` comes back as `x-vercel-protection-bypass=<redacted>`;
  - **MG-10 `state-file-mutex`**: two `start()` calls for different sessions launched concurrently (`Promise.all`) produce exactly one `startCalls` entry and one persisted state file; removing the `local-app:<port>` lock makes it two;
  - state file is written tmp-then-rename (assert no `.tmp` remains) and re-read across a new `EnvironmentService` instance;
  - `stop()` with no owner → `state 'stopped'`, no kill; `stop('other-session')` when the owner is `s1` → no kill, `state 'running'` for `s1`;
  - **MG-11 `reap-only-our-own`** (`reconcileOrphans`): live recorded pgid → `stop` called once, state file gone, returns the reaped state; dead recorded pgid → no kill, state file gone, `alreadyDead: true`; no state file but a foreign listener on the port → no kill, no write, `reaped: null`;
  - `previewUrlFor`: argv is `['pr','view','<n>','--repo','<slug>','--json','comments']`; the fixture comment → the right project's `https://<host>`; a `PENDING` project still yields the URL with `reason: null`; a `previewUrl: null` project → `project '<name>' has no preview URL yet (nextCommitStatus=IGNORED)`; unknown project name → reason; no vercel comment → reason; `gh` failure → reason (never throws);
  - `writeBypassSecret` writes `<sessionDir>/.bypass-secret` with `statMode === 0o600` containing exactly the secret + `\n`, returns the path; returns `null` and writes nothing when no secret is configured; `clearBypassSecret` removes it via `fs.remove` and is a no-op when absent;
  - `briefContext` for a review stage on a configured repo → `previewUrl` set, `localUrl` null, `clerk` defaulted; for a develop stage → `localUrl` set, `previewUrl` null; for an unconfigured repo → `EMPTY_ENVIRONMENT` (R14).
- [ ] **GREEN** — implement per spec §4.2.
- [ ] Commit `feat(cgremlin-core): EnvironmentService — prereqs, setup, single-owner local app, preview URL`.

### Task C2: Pipeline integration — prepare the environment BEFORE the lock, tear down in an outer `finally` — tier `executor-heavy`

**Depends on:** A3, C1.

**Files:** modify `src/pipeline/pipeline-service.ts`; tests `test/pipeline/pipeline-service.environment.test.ts` (new), plus adjustments in `test/pipeline/pipeline-service.review.test.ts` and `test/support/pipeline-harness.ts`.

**Interfaces (produce/modify):**
```ts
export interface PipelineServiceDeps { /* … existing … */ environment?: EnvironmentService }
// private, in PipelineService — runStageLocked's signature is UNCHANGED:
private async runStageLocked(id: string, stage: StageName, brief: string | null, prompt: string, preRun?: () => Promise<void>): Promise<StageRunResult>
private async prepareEnvironment(id: string, stage: StageName, session: Session): Promise<{
  ctx: EnvironmentBriefContext; startedHere: boolean; teardown: () => Promise<void>;
}>
```
`prepareEnvironment` runs **before** `runStageLocked`, acquires **no session lock** and writes **no session state**: it calls `environment.start(session)` when `wantsLocalApp` (including the up-to-90 s healthcheck), `previewUrlFor` when `wantsPreview`, and `writeBypassSecret` when a preview URL resolved and a `bypassSecret` is configured. The brief is rendered from `ctx` and handed to `runStageLocked` as a plain string. `teardown()` calls `clearBypassSecret` always and `environment.stop(id)` only when `startedHere`, takes no session lock, and never throws out of the `finally` (log-and-swallow, keeping any in-flight error). Shape for every environment-bearing stage (`runFindings`, `runDevelop`, `runReview`, `runRereview`; `runPlan` does not participate):

```ts
const prep = await this.prepareEnvironment(id, stage, session);
const brief = renderXBrief({ …, env: prep.ctx });
try {
  // ... the EXISTING body, byte-for-byte: the preRunCommitted try/catch,
  //     runStageLocked, evaluate*, and the final lock.withLock transition ...
} finally {
  await prep.teardown();
}
```
The `finally` sits **outside** the existing `preRunCommitted` try/catch, so a locked-`preRun` throw still tears the environment down without touching the lost-race classification. When `deps.environment` is undefined, `prepareEnvironment` returns `{ ctx: EMPTY_ENVIRONMENT, startedHere: false, teardown: async () => {} }` and nothing else changes.

- [ ] **RED** — with `FakeLocalAppRunner` + a real `EnvironmentService` + a real `KeyedLock`:
  - **MG-9 `env-prep-outside-the-lock`**: build a shared `callLog: string[]`; wrap the harness's `KeyedLock` so each `withLock(key)` appends `lock.enter:<key>` before the body and `lock.exit:<key>` after; pass the same array to `FakeLocalAppRunner` so it appends `local.start`. Run a develop stage and assert `callLog.indexOf('local.start') < callLog.indexOf('lock.enter:' + id)` — the start strictly precedes the session lock being entered. Also assert no `lock.enter:<id>` appears anywhere between `local.start` and the following `local.stop` except the one the stage itself takes;
  - develop stage on a configured repo: `startCalls.length === 1`, the start happens before `run.started` fires, the written `BRIEF.md` contains the local URL, and `stopCalls.length === 1` after the run;
  - **MG-4 `no-local-app-for-review`**: review stage with `localApp.stages: ['develop']` → `startCalls` empty, and `BRIEF.md` contains the preview URL;
  - **MG-1 behavioural guard**: run a review stage through a live `EnvironmentService` whose config has `vercel.bypassSecret: 'S3CRET-VALUE'`; assert the written `BRIEF.md` does not contain `S3CRET-VALUE`, does contain the `.bypass-secret` path, and that `<sessionDir>/.bypass-secret` contained the secret while the run was live;
  - **MG-5 `local-app-always-stopped`**, three cases — agent exits 0, agent exits 1, and the **locked** `preRun` throws `UnsupportedStageError` after `prepareEnvironment` succeeded — each asserts `stopCalls.length === 1` and `.bypass-secret` absent afterwards; the third also asserts the thrown error still propagates unchanged and the session was **not** marked `failed` (the lost-race path);
  - a `teardown` that throws does not mask the stage's own error and does not fail an otherwise successful run;
  - the brief is rendered from the *post-start* context: a start that fails produces a `BRIEF.md` containing `Local app: UNAVAILABLE`, and the stage still runs to completion (R5);
  - `environment: undefined` (every existing wiring) → behaviour byte-identical to today: `runFindings`/`runDevelop` briefs unchanged, `runReview`/`runRereview` write a `BRIEF.md` whose environment and LIVE UI CHECK sections are both empty, and `renderReviewPrompt` emits no LIVE UI CHECK sentence (R14);
  - review and rereview now write `BRIEF.md` (they previously passed `null`) and `AGENT_STATE` is still written first;
  - `.bypass-secret` is written before `run.started` and gone after `run.finished`;
  - `runStageLocked`'s signature is still `brief: string | null` (a compile-time pin: a test calls it with a string through an existing stage and the file's locking-invariant comment is unchanged — assert with a source read that the comment block at the top of the file is byte-identical to the pre-Phase-5 text).
- [ ] **GREEN** — implement.
- [ ] Commit `feat(cgremlin-core): engine owns the local-app lifecycle around every environment-bearing stage`.

### Task C3: API routes, CLI `local`, host wiring, boot reap, importer — tier `executor-heavy`

**Depends on:** C2.

**Files:** modify `src/api/server.ts`, `src/api/http-errors.ts`, `src/host/build-engine.ts`, `src/host/serve.ts`, `src/cli/main.ts`, `src/cli/commands/config.ts`; create `src/cli/commands/local.ts`; tests `test/api/server.test.ts`, `test/api/http-errors.test.ts`, `test/host/build-engine.test.ts`, `test/host/serve.test.ts`, `test/cli/commands.test.ts`, `test/cli/config.test.ts`.

**Interfaces (produce):**
```ts
// src/api/server.ts
export interface ApiServerDeps { /* … existing … */ environment?: EnvironmentService }
// routes: POST /sessions/:id/local/start[?fresh=1] · POST /sessions/:id/local/stop · GET /sessions/:id/local  → { status: LocalAppStatus }
// src/cli/commands/local.ts
export function localCommand(args: readonly string[], io: CommandIO): Promise<number>;
// src/host/build-engine.ts
export interface EngineAdapters { /* … existing … */ localApp?: LocalAppRunner }
export interface Engine { /* … existing … */ environment: EnvironmentService | null }
```
`buildEngine` constructs `EnvironmentService` when `adapters.localApp` is present (using `config.localAppStatePath!`, the shared `KeyedLock`, `adapters.git`) and passes it to both `PipelineService` and `createApiServer`; `realAdapters` supplies `new NodeLocalAppRunner()`. `mapErrorToHttp` maps `LocalAppPortBusyError` / `LocalAppPrereqError` / `LocalAppUnhealthyError` → 409.

`serve` changes, all three from the rulings:
1. **boot reap (R13)** — `await environment?.reconcileOrphans()` once, before `scheduler.start()`; when it returns a reaped state, `logLine(opts.log, 'local.reaped', { sessionId, pid, pgid, port, alreadyDead })`. A foreign listener is never touched.
2. **log redaction (R3)** — the verbose `run.output` subscriber wraps the chunk: `chunk: redactBypassUrls(e.chunk)`.
3. **close ordering (R16)** — in `doClose()`, inside the existing `try`: `scheduler.stop()` → the `pipeline.stop(id)` loop → **then** `await environment?.stop()`. Sessions first, local app second.

- [ ] **RED** — against a real API server on a temp socket with fakes:
  - `GET /sessions/:id/local` with no environment configured → 404 `{ error: 'environment not configured' }`;
  - `POST …/local/start` → 200 `{ status: { state: 'running', url, pid } }`; a second concurrent POST for the same session yields one `startCalls` entry (route holds `lock.withLock(id)`, and `EnvironmentService` holds `local-app:<port>`);
  - `POST …/local/start` when the port is busy → 409 with the reason;
  - `POST …/local/stop` → 200 `state 'stopped'`; stopping a session that is not the owner → 200, no kill;
  - `GET …/local` returns `logTail` with at most 40 lines, **redacted** (a log line containing a bypass URL comes back as `x-vercel-protection-bypass=<redacted>`);
  - `?fresh=1` forwards `{ fresh: true }` to `EnvironmentService.start`;
  - unknown session id → 404 (route loads the session first);
  - **MG-2 `secret-not-an-artifact`**: `parseArtifactName('.bypass-secret')` throws, and `GET /sessions/:id/artifacts/.bypass-secret` → 400;
  - **MG-3 `secret-never-leaves-the-process`**: run a full start → status → stop cycle with `bypassSecret: 'S3CRET-VALUE'` and `verbose: true`, with a fake agent that prints `https://h/?x-vercel-protection-bypass=S3CRET-VALUE&x-vercel-set-bypass-cookie=true` to stdout; capture every `serve` log line and every response body; assert none contains `S3CRET-VALUE` and that at least one captured line contains `x-vercel-protection-bypass=<redacted>` (proving the path was exercised, not merely absent); `redactCoreConfig(cfg)` contains `[redacted]`;
  - **boot reap (R13/MG-11 at the host level)**: `serve()` with a state file naming a live recorded pgid calls `environment.reconcileOrphans()` before `scheduler.start()` and logs one `local.reaped` line; with no state file it logs nothing and kills nothing;
  - **close ordering (R16)**: `serve.close()` calls `environment.stop()` exactly once and **after** every `pipeline.stop` (assert with a shared ordered call log); a throwing `environment.stop()` still lets the socket/server teardown `finally` run and surfaces as the rejected `close()`;
  - `buildEngine` with no `localApp` adapter → `engine.environment === null` and every existing wiring test still passes;
  - CLI: `local status` prints `stopped` / `running <session> <url> pid <pid>` / `unavailable — <reason>`; `local status --json` emits the raw status; `local start <session>` exit 0 and exit 1 on 409 with the message on stderr; `local stop` with no argument stops the current owner; `main([])` usage lists `local`;
  - `config import-legacy` on the real legacy text writes `environments` with the secret and, when the file already exists, still refuses without `--force`; the written file is mode 0o600.
- [ ] **GREEN** — implement.
- [ ] Commit `feat(cgremlin-core): local-app API routes, cgremlin-core local CLI, boot reap and host wiring`.

---

## Parallelism

| Task | Tier | Stream / branch | Runs with |
|---|---|---|---|
| A1 config + 0600 + redaction + `fs.remove` | `executor-heavy` | A (`phase5a-config-briefs`) | parallel with A2, A3, B1 |
| A2 Vercel decoder + `repoSlugFromUrl` move | `executor` | A (`phase5a-config-briefs`) | parallel with A1, A3, B1 |
| A3 briefs + LIVE UI CHECK + REVIEW.md contract | `executor` | A (`phase5a-config-briefs`) | parallel with A1, A2, B1 |
| B1 LocalAppRunner + adapter + fake | `executor` | B (`phase5b-local-app`) | parallel with all of A |
| C1 EnvironmentService | `executor-heavy` | merged base | sequential — needs A1, A2, B1 |
| C2 pipeline integration | `executor-heavy` | merged base | sequential — needs A3, C1 |
| C3 API + CLI + host + boot reap + importer | `executor-heavy` | merged base | sequential — needs C2 |

Streams may mix tiers; each task above names its own. A1/A2/A3 touch disjoint files except `src/pipeline/pipeline-service.ts` (A2's one-line re-export vs A3's none), so they can run as three parallel agents on the same branch or as one agent in sequence — a stream is a branch, not a worker. Suggested allocation: one `executor-heavy` takes A1, one `executor` takes A2→A3, one `executor` takes B1. Supervisor merges A then B before C1 starts. C1→C2→C3 are one `executor-heavy`, in order.

Rationale for the tiers: A1 changes the `SessionFileSystem` port that every adapter and fake implements; C1 owns the whole `run_local` decision tree plus a new lock key; C2 restructures the control flow around `runStageLocked` and the documented locking invariant; C3 changes engine boot and shutdown ordering. A2, A3 and B1 are additive, well-specified, and land behind explicit test lists.

## Definition of Done

- Both branches merged; C1–C3 landed; `pnpm test && pnpm typecheck && pnpm lint && pnpm build` green.
- `node bin/cgremlin-core --help` lists `local`; `cgremlin-core local status` on a stopped engine prints the friendly not-running message (existing `runSocketCommand` behaviour).
- All eleven mutation guards present, and each demonstrated failing under its stated mutation: **MG-1** `secret-never-in-brief` (type pin in A3 + behavioural guard in C2), **MG-2** `secret-not-an-artifact`, **MG-3** `secret-never-leaves-the-process`, **MG-4** `no-local-app-for-review`, **MG-5** `local-app-always-stopped`, **MG-6** `no-port-steal`, **MG-7** `no-agent-callback`, **MG-8** `config-file-is-0600`, **MG-9** `env-prep-outside-the-lock`, **MG-10** `state-file-mutex`, **MG-11** `reap-only-our-own`.
- Regression pins green: a `core.json` with no `environments` key loads and behaves exactly as before; `renderFindingsBrief`/`renderDevelopBrief` with `env` omitted are byte-identical to the pre-Phase-5 snapshots; `runStageLocked`'s signature and `pipeline-service.ts`'s locking-invariant comment are unchanged.
- `grep -rn "CLAUDE.md" src/` is empty. `grep -rniE "playwright|chrome-devtools|puppeteer" src/` is empty.
- Manual live smoke (supervisor): `cgremlin-core config import-legacy --force`, hand-add `portal.local.findcare.dev.aplaceformom.com` to `environments[…].localApp.prereqs.hostsEntries`, `chmod` check shows `core.json` at 600, `cgremlin-core serve`, create a development session on `grace-frontend`. On a machine with the sudo prereqs in place: confirm the dev server comes up at `https://local.findcare.dev.aplaceformom.com/`, `BRIEF.md` names it, `logs/dev-server.log` fills, and Ctrl-C leaves no listener on 8080. On a machine without them: confirm the stage degrades within seconds (not 90 s) with `ensure-portal-stack.sh`'s own message quoted in `BRIEF.md`. Then start a review session and confirm `BRIEF.md` carries the preview URL, the `## LIVE UI CHECK` section and the REVIEW.md contract, and that `.bypass-secret` is gone after the run. Finally `kill -9` the engine mid-run and restart it: the next `serve` logs `local.reaped` and leaves nothing on 8080.
- Not in scope: browser driving, `pnpm setup:local`/sudo, `nvm install`, Storybook preview support, posting to GitHub.

> Erratum (2026-09-10, supervisor): the DoD greps for `chrome-devtools` and `CLAUDE.md` legitimately match agent-facing prose and one code comment in `src/pipeline/prompts.ts`; the rule is "no engine code path drives a browser or reads CLAUDE.md", which holds. All other findings from the final review were fixed in commits 0f7fffe..d842abb on the phase branch.
