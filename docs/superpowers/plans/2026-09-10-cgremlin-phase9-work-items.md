# cgremlin Phase 9: work items — the panel shows my work, not agent sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The panel stops being a list of agent sessions and 58 unfiltered PRs. It becomes **four**
lists of **work items** (spec R47–R50, from the user's re-scope in spec §0.1):
**Parking lot** — my teammates' open **non-draft** PRs in three ordered groups: the ones we
already have a **review agent** on pinned on top, then the untouched ones (age and change-size on
every row, sortable by both), then a collapsed group for the ones somebody else is already on, so
the untouched ones are what the eye lands on. **My dev work** — Jira tickets assigned to me ∪ my open
PRs ∪ my investigation/development/respond sessions (**a review agent never puts a teammate's PR
here**), merged into one row per piece of work that **expands** into its parts
(investigation, dev, ticket, PR), each part individually clickable. **Investigations** — the items
whose only agent is an investigation. **PRs waiting for review** — my open PRs, lighting up when a
review arrives; clicking one creates a **`respond`** session, **starts its run** and swaps to that worktree —
no claim, no terminal yet — and once the run has written a brief carrying every review thread,
the CI, the diff summary and the ticket, Chat opens Claude on it.
Clicking a row (or a child) opens an **Item tab** in the editor that renders that work's files, its
PR info and its Jira ticket, moves the workspace to that agent's worktree, and lets you switch
between the agents attached to the item. The side panel itself becomes a **webview** so it can look
like the Codex chat panel.

**Architecture:** Two parallel streams, then one convergence, against the spec contract.
**Stream A (core, branch `phase9-core`):** a new `src/work/` layer that *groups* existing
`AttentionItem`s into `WorkItem`s (no second attention derivation, no session lock),
`humanActivity` + `ticketKeys` + the age/size/CI/labels fields on the inventory row (R53), a
`JiraSource` port with a REST adapter and a cached scanner folded into the existing discovery tick,
`jira.apiToken` under the full bypass-secret regime, six new routes plus an `item.changed` event, a
gated `## Ticket` brief section, the engine's **first GraphQL call** for review threads (R52), and
a **fourth `SessionMode`, `respond`**, with its phases, factory, attention reasons and brief (R51).
**Stream B (extension, branch `phase9-ext`):** four lists from `GET /items` rendered by a
**`WebviewViewProvider`** side panel (the `TreeView` is deleted — R54), an Item tab
(`WebviewPanel`) rendering artifacts, PR info and the ticket with a bundled `markdown-it`, two pure
message protocols, per-list sorts persisted in extension state, row expansion into children, an
agent switcher that swaps the single managed worktree, and removal of the repo-wide lists and the
markdown-preview path.
**Convergence (branch `phase9-conv`):** integration against the real engine with a stubbed Jira and
a faked `gh api graphql`, the mutation guards that span both packages, and docs.

**Tech Stack:** core — TypeScript, zod, vitest, `node:http`, `globalThis.fetch` (Node ≥ 20). **No
new runtime dependency in either package.** Extension — `tsc` for the extension host plus
**esbuild + `markdown-it` as devDependencies** for the webview bundle (R40; a narrowing of Phase 7
R13, recorded in `DECISIONS.md`), zero **runtime** dependencies, no `@vscode/test-electron`.
`media/item-tab.js` is a **generated, gitignored** esbuild output that ships in the `.vsix`.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-10-cgremlin-phase9-work-items-design.md`.
D1–D8 there are binding supervisor decisions. **R1–R24 are `CONFIRMED 2026-09-10`, R25–R46 are
binding rulings from review rounds #1–#22, and R47–R55 are binding supervisor rulings from the
user's re-scope (spec §0.1)** — all of them fold into the spec text; nothing in this
phase is awaiting a sign-off. **Coordinator sign-off, 2026-09-10:** one override is folded in —
*a teammate's PR carrying a review agent of ours stays in the parking lot, in a "Reviewing" group
on top, and never routes the item into `myWork`* (R47/R48, spec §4.1 step 4, §4.3, §5, MG-2,
MG-17; tasks A6, A7, B1, B4, B5, C1, C2, C3). Every other judgment call is **CONFIRMED** as
written: R47.1 (a pending review request to somebody else counts as "someone is on it"); R50 (a
reviewed PR stays in `waitingForReview` and lights up); R51's respond phases; R52's thread fetch
policy; R47's core-default / extension-selected sort split; R54's unicode glyphs; and R48's PR
info as a third *focus* on the single Item tab. **Re-check, 2026-09-10:** twelve further
rulings, **R56–R67**, are folded into spec §3 — two were **BLOCKERS**: **R56** (`respond` must be
a `STAGE_NAME`, and the click that creates the session starts the run) and **R57**
(`open(pr) = pr.isDraft !== true`, plus the invariant that an item with a live agent of ours is
always listed). Rulings that change something a D or an earlier R
said are called out here so they cannot be missed:

| Ruling | What it changes | Why |
|---|---|---|
| **R2 / spec §2** | D1's "sessions gain optional `ticketKey`" is **dropped** | `lineage.ticket` already exists on every session and is already set on all three creation paths (`schema/session.ts:15-19`, `validation.ts:54`/`:72`, `review-session-factory.ts:90`). A second field would be a second truth. |
| **R14 + R25** | D4's `GET /items/:id` becomes **segmented** paths, over **three** kinds (`ticket`, `pr`, `session`) | `handleRequest` splits `url.pathname` and never decodes (`api/server.ts:501-502`); `pr:owner/repo#12` in a path needs `%2F`/`%23` handling no other route does. The body still carries the opaque `id`. |
| **R6** (shape superseded by R47) | the "has a human touched this" signal deliberately **reverses** `docs/DECISIONS.md:79-82` | That line says the watch list is an allow-list and bot-ness is never a heuristic. Answering "has *any* human reviewed this" requires the heuristic. Recorded, not silent. R47 renames the field to `humanActivity` and makes it exclusionary; the reversal itself stands. |
| **R40 supersedes R20** | the renderer is **bundled `markdown-it`** built by esbuild; there is **no spike and no hand-written renderer** | 200 lines of security-critical parser we would own forever, versus a dev-only build step the core already runs for `build:engine`. Runtime deps stay zero. |
| **R46 amends R7** | `jira.projectKeys` empty no longer means "no filtering", it means **linking is disabled** | The bare regex links `SHA-256`, `UTF-8` and `PR-123`; a wrong merge puts two unrelated PRs on one row, which is worse than no merge. |
| **R47 supersedes the three-list model** | **four** lists — `parkingLot`, `myWork`, `investigations`, `waitingForReview`; `reviewing` is gone **as a list** and comes back as the first of the parking lot's **three ordered groups** (`reviewing` / untouched / collapsed `someoneOnIt`, carried on the wire as `lists.parkingLot: { reviewing[], untouched[], someoneOnIt[] }` and on each item as `parkingLotGroup`); **drafts are in no list** (R30's marker is dead); per-list user-selectable sorts persisted in extension state | The user's words: the parking lot is "open prs, not drafts", and its job is to help him *choose* — "if anyone else is already looking … I should go to another one", then "how long it's been there, and how many file changes". |
| **R48 extends `myWork`** | a row is the merge of ticket + my PRs + my **investigation/development/respond** sessions, and it **expands** into clickable children — investigation, dev, ticket, PR. **A review agent never routes an item into `myWork`** (coordinator override, 2026-09-10) | A teammate's PR we are reviewing is still a teammate's PR: it belongs on top of the parking lot, not in the list of things I am building. The user asked to "click it" and see "what we have for it". |
| **R49** | `investigations` = **no PR, no ticket, investigation agents only**; a ticket-linked investigation goes to `myWork` | The user: "investigations are the sessions I only have investigation for". A ticket is a commitment to deliver, which is `myWork`. |
| **R50 + R51** | a fourth `SessionMode`, **`respond`**, with its own phases, terminal phases, attention reason, factory and brief; `ReviewSessionFactory`'s `OwnPrError` **stays** | The own-PR guard, the brief, the artifact (`COMMENTS.md`, not `REVIEW.md`) and the terminal phases all differ from `development`. `TERMINAL_PHASES_BY_MODE` is a `Record<Session['mode'],…>`, so the fourth mode is a compile error until it is wired everywhere. |
| **R52** | the engine's **first GraphQL call** (`gh api graphql`, `reviewThreads`), cached per PR and fetched only for my PRs and for untouched parking-lot candidates | There is no GraphQL anywhere in `src/` today, and the respond brief needs whole threads — the legacy `comments(first:1)` truncation is why the old brief had to reconcile replies by hand. |
| **R54 supersedes the `TreeView`** | the side panel becomes a `WebviewViewProvider` under the Item tab's CSP; `src/ui/tree.ts` is deleted; a second esbuild entry point produces `media/panel.js` | A `TreeView` cannot render two-line card rows, badges, inline sort controls, a collapsible group or "the Codex chat panel" look. |
| **R55** | **no posting to GitHub anywhere in v1**, stated as its own ruling | The respond flow is the first thing here that would obviously want to. The legacy `--reply-comment`/`--resolve-comment`/`--push-fix` verbs are **not** ported; v1 ends at "the fix is committed locally". |
| **R56 (BLOCKER)** | `STAGE_NAMES` gains `'respond'`; `pipeline.runRespond(id)` + `RESPOND_RUNNABLE_FROM`; `POST /items/<pr>/agents {mode:'respond'}` **creates and starts** in one request | `STAGE_NAMES` (`schema/stage.ts:3`) is simultaneously the `POST /sessions/:id/run` validator, the persisted `lastRun.stage` type and the `run.started`/`run.finished` payload type — a respond session with no stage name cannot be started, recorded or reported. The user's click **is** the explicit start; MG-8 is amended to count it as one. |
| **R57 (BLOCKER)** | `open(pr) = pr.isDraft !== true`, and an item with a live agent of ours is **always** listed | R45 defaults `isDraft` to `null` on a pre-Phase-9 or agent-only row, so `=== false` would silently unlist real work. A merged teammate PR with our review agent goes to `parkingLot.reviewing`; a merged own PR with a respond/dev agent to `myWork`. MG-17 asserts the invariant. |
| **R61** | ticket-merging applies **only** to items that are mine (my ticket, my PR, or my session) | Merging two teammates' PRs that name one ticket hides one behind the other and makes "how many file changes" meaningless — in the parking lot the user is choosing between *PRs to read*. |
| **R67 amends R53** | a `gh pr list` that trips GitHub's GraphQL **node limit** falls back to **two** calls per repo, fields partitioned | It is a hard error, not a degradation: the repo returns nothing. Detected on `GhCommandError.stderr` containing `MAX_NODE_LIMIT_EXCEEDED`. |

## Verified Ground Truth (2026-09-10, planner grounding pass)

The spec's §2 carries the full list with citations. The facts every task below is built on:

**The join key already exists.** `lineage: { pipelineId, parentSessionId, ticket }` on every session
(`core/src/schema/session.ts:15-19`); review sessions derive it from the branch with
`extractTicketKey`, which is already `/\b([A-Z][A-Z0-9]+-\d+)\b/` (`core/src/gh/ticket-key.ts:1-6`,
used at `core/src/pipeline/review-session-factory.ts:90`); `linkPrToSource` already joins by PR then
by ticket (`core/src/discovery/link-pr-to-source.ts:31-38`); `ItemLinks.ticket` is already on the
wire (`core/src/attention/attention-service.ts:208`, `vscode/src/model/items.ts:53`).

**`teamActivity` cannot answer "has a human reviewed this".** `buildTeamActivity` filters both
arrays through the `watchAuthors` allow-list (`core/src/inventory/inventory.ts:60-80`), which
`core/docs/DECISIONS.md:79-82` states as a deliberate design choice.

**Review/comment authors are parsed without `is_bot`.** `ActivityAuthorSchema = z.object({ login })`
(`core/src/gh/pr-view.ts:35`) while the *PR* author schema has `is_bot?` (`:19-23`); the
review/comment schemas are `.passthrough()` (`:37-52`), so the field may be arriving and being
discarded. `PR_INVENTORY_FIELDS` has `headRefName` but **no `body`** and **no `reviewRequests`**
(`:5-6`), and `PrListItemSchema` is **not** passthrough (`:14-29`) — an unnamed `body` would be
stripped before `buildEntries` sees it, which is why R29 names it on the schema explicitly.

**Adding a required field to `InventoryEntrySchema` breaks `/prs` after an upgrade.**
`InventoryStore.load` re-parses and throws `InventoryCorruptError` (`core/src/inventory/inventory-store.ts:46-52`);
`loadCurrentInventory` has no catch (`core/src/api/server.ts:113-115`, `:771-777`).

**One function owns each config concern.** `hasAnySecret` (`core/src/config/core-config.ts:122-124`)
gates the 0600 refusal (`:171-178`); `redactCoreConfig` (`:127-135`); a derived path must be
registered in **both** `resolveCoreConfig`'s `expandOrDerive` (`:104-118`) and
`DERIVED_PATH_SUFFIXES` (`:264-274`) — registering one is the documented failure mode
(`core/docs/ARCHITECTURE.md:528-534`).

**The tick and its report.** `InventoryScanner.run()` reconciles → loops `config.repos` → saves →
emits `inventory.updated`, with a per-repo fallback to the last scan
(`core/src/inventory/inventory-scanner.ts:40-99`). `POST /prs/scan` returns the whole `ScanReport`
(`core/src/api/server.ts:779-783`); `Engine.scheduler` is `DiscoveryScheduler<ScanReport>`
(`core/src/host/build-engine.ts:50`, `:207`); `serve()` starts the scheduler then attention
(`core/src/host/serve.ts:323-326`).

**Attention already answers, per agent, without locks.** `AttentionService.list({all:true})` returns
`mode`/`stageStatus`/`running`/`claimed`/`needsYou`/`links.primaryArtifact`
(`core/src/attention/attention-service.ts:399-412`, `:65-76`, `:174-212`) and already dedupes a PR
row against its session (`:596-620`) — **dropping the PR item** and keeping only its
`prRepo`/`prNumber`/`prUrl`, which is why `WorkItemService` needs the pre-dedupe list (R27).
`pickPrimaryArtifact` is pure
(`core/src/api/artifacts.ts:34-56`); the readable allow-list is one regex
(`core/src/api/validation.ts:101-102`).

**A new event needs three registrations.** `EngineEventMap`, `ENGINE_EVENT_TYPES` (whose own comment
says a missing entry means `/events` silently never carries it) — `core/src/engine/events.ts:7-41` —
and `serve()`'s log subscriptions (`core/src/host/serve.ts:229-251`). **Frames are buffered**:
`EVENT_RING_CAPACITY = 256` and `MAX_PENDING_FRAMES = 256` (`core/src/api/event-stream.ts:5-7`),
which is why `item.changed` carries `{ id, kind, changedFields? }` and not a whole `WorkItem`
(R41). The extension's consumer, `sse.on('frame', () => coordinator.schedule())`
(`vscode/src/extension.ts:112-114`), currently ignores payloads on purpose; R41 changes that line
deliberately, to read the `id` as an **address** only.

**Two extension seams Phase 9 re-points.** The status bar finds its row by
`item.links.sessionId === currentSessionId` over the `/attention` snapshot
(`vscode/src/ui/refresh.ts:136`) — R43 names the replacement now that `/attention` leaves the
refresh path. **Claims are taken and released by the chat terminal alone** (`vscode/src/ui/terminal.ts`:
`client.claim` on open, TTL/3 heartbeat, release on close) — R42 keeps it that way.

**The conditional-brief-section precedent.** `renderEnvironmentSection` returns `''` when empty and
every caller writes `const block = section ? '\n\n' + section : ''`
(`core/src/pipeline/prompts.ts:52-79`, `:255-256`, `:341-342`, `:372`); the three composition sites
already pass `session.lineage.ticket` (`core/src/pipeline/pipeline-service.ts:421`, `:599`, `:637`).

**Jira, supplied by the supervisor and cross-checked against the legacy tool.** Site
`https://aplaceformom.atlassian.net` (cloudId `326247b9-ab3e-4a1e-b7c8-80655ee39cf5`), email
`guilherme.azoubel@aplaceformom.com`, accountId `712020:f0acd024-8d3a-4b87-9d4b-768ee3eb3f74`; the
**API token is the only input the user must supply**. The legacy bash tool used the identical
scheme: `chmod 600 ~/.config/cgremlin/jira.conf` holding `JIRA_DOMAIN`/`JIRA_EMAIL`/`JIRA_API_TOKEN`
(`bin/cgremlin:1819-1836`), `curl -u "$EMAIL:$TOKEN" https://$DOMAIN/rest/api/3/myself` as the
credential check (`:1894-1901`), and
`/rest/api/3/issue/<key>?fields=summary,description,issuetype,status,priority,labels,assignee,reporter,acceptance_criteria,customfield_10016,attachment,comment`
for content (`:1930-1932`). **`~/.config/cgremlin` does not exist on this machine** (checked) — there
is nothing to import, so Phase 9 adds no legacy-Jira import, matching Phase 8's U3.

**Extension facts.** `LIST_ORDER` is the four-descriptor array (`vscode/src/model/view-model.ts:117-160`);
`refreshNow` fetches `/prs` + `/sessions` + `/attention?all=1` every time
(`vscode/src/ui/refresh.ts:84-113`); open-item is `markdown.showPreview` + the swap
(`vscode/src/ui/preview.ts:63-80`, `:82-134`) and `cgremlin.refreshPreview` runs
`markdown.preview.refresh` (`vscode/src/ui/commands.ts:148-150`); `planWorkspaceAction` is pure
(`vscode/src/model/workspace-file.ts:28-48`). **MG-B1 is a plain `includes('vscode')` over
`pureSourceFiles()`, prose included** (`vscode/test/purity.test.ts:15-33`) and an **exact** `src/ui/*`
basename list (`:93-107`). The `.vsix` may carry no `node_modules/`, no `src/`, no `.ts`
(`vscode/test/packaging/vsix-contents.test.ts:47-60`). The core already has `esbuild` as a
devDependency for `build:engine`; the extension does not.

**The core renders no HTML** — `cgremlin/core/README.md:7` and `:267-268`. The markdown renderer
therefore cannot live in the core, however convenient that would be.

**`STAGE_NAMES` is three contracts in one file (R56).**
`['findings','plan','develop','review','rereview']` (`core/src/schema/stage.ts:3`) backs
`StageNameSchema`, which validates `POST /sessions/:id/run` (`core/src/api/validation.ts:85-91`),
types the persisted `LastRunSchema.stage` (`stage.ts:12`) and types the
`run.started`/`run.finished` payloads (`core/src/engine/events.ts:10`, `:12`). Every `run*`
funnels through `runStageLocked(id, <stage>, brief, prompt, cb)`
(`core/src/pipeline/pipeline-service.ts:201`, used at `:424`, `:473`, `:606`, `:655`, `:776`)
with the phase re-checked on a **fresh** load inside the lock; `runDevelop` (`:587-618`) is the
template and `REVIEW_RUNNABLE_FROM` (`:647`) the precedent for a runnable-phase list.

**The re-scope's new ground (spec §2, "The re-scope's new ground").** `SessionModeSchema` is a
three-value `z.enum` (`core/src/schema/session-mode.ts:3`) and both session unions are
**discriminated on `mode`** (`core/src/schema/session.ts:29-33`, `:57-76`), so a fourth variant is
additive. Phases live in `core/src/schema/pipeline.ts:3`/`:13`/`:22` with a per-mode transition
table from `:38`; terminal phases live in exactly one `Record<Session['mode'], ReadonlySet<string>>`
(`core/src/workspace/workspace-in-use.ts:4-8`) read by eight modules — **adding a mode without
filling it in is a compile error**. `deriveSessionReasons` branches on mode in only two places
(`core/src/attention/attention.ts:118`, `:142`), and `derivePrReasons` (`:160-165`) is
my-own-PR-only and today fires `changes_requested` off the **watch-filtered** `teamActivity`.
`ReviewSessionFactory` throws `OwnPrError` *before* `createWorkspace`
(`core/src/pipeline/review-session-factory.ts:63-72`) — the ordering `RespondSessionFactory`
mirrors. `ciStatus()` already exists (`core/src/gh/pr-view.ts:123-142`) but `statusCheckRollup` is
only in `PR_VIEW_FIELDS` (`:8-9`), never in `PR_INVENTORY_FIELDS` (`:6`). **The engine has no
GraphQL client at all** (grep: no `graphql`, no `reviewThreads` under `core/src`), and `GhRunner`
is a two-line port (`core/src/gh/gh-runner.ts:1-3`), so `gh api graphql` needs no new port and no
new fake. The extension contributes **one view**, `{ id: 'cgremlin.items', name: 'Attention' }`,
with **no `"type"` key** — R54 adds `"type": "webview"` — and has **no bundler and zero
dependencies** today (`build` is `pnpm --dir ../core build:engine && tsc -p tsconfig.json`).

**UNVERIFIED (and how each is closed)**
- **U1** whether `gh pr list --json reviews,comments` emits `is_bot` on an activity author — closed
  by Task A2 recording a real `gh pr list` sample as a fixture; the `[bot]`-suffix rule is the
  fallback regardless.
- **U2** Atlassian Cloud v3 response shapes, pagination and 401/403/429 behaviour — closed by Task
  A4's contract test over recorded fixtures plus **one manual call by the user** (smoke step 9).
  **No live call in any test.** **Both** pagination shapes are implemented and separately fixtured
  (R32): `/search/jql` by `nextPageToken`/`isLast`, `/search` by `startAt`/`maxResults`/`total`,
  with the 404/410 fallback firing **once per scan**. `customfield_10016` (probably story points)
  and `acceptance_criteria` are instance-specific and are **not** in the default field set — an
  unknown field name 400s the whole request.
- **U3 CLOSED by R40** — bundled `markdown-it` (`html: false`, `linkify: true`) built by esbuild.
  There is no spike and no hand-written renderer in this plan.
- **U4** how long the parking lot stays once `watchAuthors` filters it — closed by the smoke pass.
  Under R47 what matters is the **untouched** count, not the total.
- **U6** what `gh pr list --json statusCheckRollup,reviewRequests` emits, and whether the widened
  field set trips GitHub's GraphQL node limit — closed by **A2's** recorded `gh pr list` sample
  and smoke step 1. Until then R59 parses the rollup leniently (`.catch([])` → `ci: 'none'`),
  R60 flattens the user/team `reviewRequests` union, and R67 defines the two-call node-limit
  fallback.
- **U5** the GraphQL shape of `pullRequest.reviewThreads` and what a `gh api graphql` costs per PR
  — the engine has never made a GraphQL call. Closed exactly like U2: a **recorded fixture** plus a
  contract test against a fake `GhRunner` (**no live call in any test**), plus one manual
  `gh api graphql` by the user and a two-tick cache observation in smoke step 6a. The legacy query
  (`bin/cgremlin:14776-14787`) is the starting point, widened from `comments(first:1)` to
  `comments(first:100)` on purpose.

## Global Constraints

- Core: commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
  green at every commit. Extension: from `cgremlin/vscode/`; `pnpm test && pnpm build && pnpm lint`
  green at every commit.
- **Nothing in Phase 9 starts an agent that was not explicitly asked for** (Phase 7 R5,
  `core/docs/ARCHITECTURE.md:186-191`). `GET /items` and `GET /items/…` are pure reads (MG-8).
- **Nothing in `src/work/` takes a session lock** (MG-1, inheriting MG-A3). If it needs session
  state it goes through `AttentionService`.
- **The locking invariant is untouched** (`core/src/pipeline/pipeline-service.ts:1-14`). No task in
  this phase edits that header comment; MG-A9 still pins it byte-for-byte.
- **Every new `InventoryEntry`/`CoreConfig` field is optional-with-a-default** (R9/R45 as extended
  by R53 — eleven fields now), and `jiraCachePath` **and `reviewThreadsCachePath`** are each
  registered in both `resolveCoreConfig` and `DERIVED_PATH_SUFFIXES`.
- **Nothing in Phase 9 writes to GitHub** (R55). No `gh` argv may contain `pr comment`,
  `pr review`, `pr merge`, `pr edit`, `pr close`, `pr ready` or `review-request`, and no GraphQL
  query string may contain `mutation`. The respond agent's allowed-tool set carries no mutating
  verb, and `renderRespondBrief` never instructs one. MG-14 is the guard.
- **The four lists are the core's answer** (R47). The extension re-sorts with the user's selection
  and renders the groups, but never re-derives membership or `demoted` (D2).
- **`jira.apiToken` is treated exactly like `vercel.bypassSecret`** (R44) — 0600 load refusal via
  `hasAnySecret`, `redactCoreConfig`, and never in a brief, a log line, an event frame, an HTTP
  response or `jira.json` (MG-5).
- **No Jira writes, ever.** `JiraSource` has three read methods and no fourth; the adapter issues
  only `GET` (a source grep for `method: 'POST'` under `src/jira` must be empty).
- **No HTML crosses the port, the API or `postMessage`** (R33): the core flattens
  `renderedFields` into text in `src/jira/html-to-text.ts`, and MG-10 greps for any identifier
  ending in `Html`.
- **Ticket linking is off unless `jira.projectKeys` is set** (R46), logged once per process.
- **The extension keeps zero *runtime* dependencies** and imports `vscode` in exactly two files;
  `esbuild`, `markdown-it` and `@types/markdown-it` are devDependencies only, and the `.vsix`
  still contains no `node_modules/` (R40, MG-B10). New pure modules join `pureSourceFiles()` and
  therefore may not contain the string `vscode` at all; **`src/webview/**` deliberately does not
  join that list** and instead gets its own assertion (no `import`/`require` of the `vscode`
  module, and no increase in the two-file `vscode` import count); new `ui/*` modules join the
  exact basename list — every one of those edits happens in the task that creates the module,
  deliberately.
- **`GET /prs`, `GET /attention` and every session route stay.** D6 removes lists from the *panel*,
  not routes from the engine; `cgremlin-core prs` is what the smoke checklist compares against.
- Branches — **one branch per parallel agent**, all off `mission-control-pr-orchestrator`:
  **`phase9-core`** (A0→A9, one agent), **`phase9-ext`** (B1→B6, one agent, developed against
  fixture payloads so it never waits on A), **`phase9-conv`** (C1→C3 on the merged base, one
  agent). Merge order: `phase9-core`, then `phase9-ext`, then C. There is no `B0` branch or task.

## File Structure

**Stream A (core):** create `src/work/work-item.ts`, `src/work/work-item-id.ts`,
`src/work/bot-login.ts`, `src/work/work-item-service.ts`, `src/jira/jira-source.ts`,
`src/jira/jira-rest-source.ts`, `src/jira/html-to-text.ts`, `src/jira/jira-scanner.ts`,
`src/jira/jira-store.ts`, `src/gh/ticket-keys.ts`, `src/gh/review-threads.ts` (R52),
`src/pipeline/respond-session-factory.ts` (R51), `src/cli/commands/check-jira.ts`; and the tests
`test/work/{work-item,bot-login,work-item-id,work-item-service}.test.ts`,
`test/jira/{jira-rest-source,html-to-text,jira-scanner}.test.ts`,
`test/gh/review-threads.test.ts`, `test/pipeline/respond-session-factory.test.ts`,
`test/api/items-routes.test.ts`,
`test/fixtures/jira/*.json` (separate `search-jql-*` and `search-legacy-*` sets — R32),
`test/fixtures/gh/review-threads-*.json`, `test/fixtures/sessions-pre-phase9/*.json` (MG-13),
`test/fixtures/inventory-pre-phase9.json`.
Modify `src/gh/pr-view.ts`, `src/inventory/inventory.ts`, `src/inventory/inventory-scanner.ts`,
`src/config/core-config.ts`, `src/attention/attention-service.ts` (the `dedupe` option, R27),
`src/attention/attention.ts` (R50's two PR reasons + R51's `comments_ready`),
`src/schema/session-mode.ts`, `src/schema/session.ts`, `src/schema/pipeline.ts`,
`src/workspace/workspace-in-use.ts` (R51),
`src/engine/events.ts`, `src/api/server.ts`, `src/host/build-engine.ts`, `src/host/serve.ts`,
`src/pipeline/prompts.ts`, `src/pipeline/pipeline-service.ts`, `src/cli/main.ts`, `README.md`.

**Stream B (extension):** create `src/model/work-items.ts`, `src/model/escape-html.ts`,
`src/model/item-tab-protocol.ts`, `src/model/panel-protocol.ts`, `src/webview/item-tab.ts`,
`src/webview/panel.ts`, `src/ui/item-tab.ts`, `src/ui/panel-view.ts`,
`media/item-tab.css`, `media/panel.css`, and the tests `test/work-items.test.ts`,
`test/markdown-render.test.ts`, `test/item-tab-protocol.test.ts`, `test/panel-protocol.test.ts`,
`test/ui/item-tab.test.ts`, `test/ui/panel-view.test.ts`. `media/item-tab.js` **and
`media/panel.js`** are **generated** by `build:webview`, not authored. Modify
`src/core-client.ts`, `src/model/items.ts`,
`src/model/view-model.ts` (deleted or reduced), `src/model/notify-policy.ts`, `src/ui/refresh.ts`,
`src/ui/commands.ts`, `src/ui/preview.ts`, `src/ui/wiring.ts`, `src/ui/host.ts`,
`src/extension.ts`, `package.json`, `.gitignore`, `.vscodeignore`, `test/purity.test.ts`,
`test/packaging/vsix-contents.test.ts`, `test/support/fake-host.ts`,
`test/support/fixtures/items.json`. **Delete** `src/ui/tree.ts` and its test (R54).

**Convergence:** modify `cgremlin/vscode/test/support/core-harness.ts` (a FakeJira stub server, a
fake `gh api graphql` responder, and a `jira` block in the seeded `core.json`),
`cgremlin/vscode/test/integration/real-engine.test.ts`,
`cgremlin/vscode/docs/SMOKE.md`, `cgremlin/vscode/README.md`, `cgremlin/core/README.md`,
`cgremlin/core/docs/ARCHITECTURE.md`, `cgremlin/core/docs/DECISIONS.md`.

---

## Stream A — core (branch `phase9-core`). Strictly sequential: A1 changes the inventory schema every later task's fixtures assert against, and A9 must not start before A8's recorded thread fixture exists.

### Task A0: collect the user inputs — tier `chore` (no code)

**Depends on:** nothing. **This task is a gate, not an implementation.** The rulings are already
confirmed (R1–R24 `CONFIRMED 2026-09-10`; R25–R46 binding), so what remains is the data only the
user has.

- [ ] The user supplies the Jira **API token** and the `jira.projectKeys` list — **required**:
      under R46 an empty list disables ticket linking entirely, so the phase ships with the
      pr↔ticket merge dark until it is set.
- [ ] The user confirms whether the default JQL or `assignee = currentUser() AND sprint in openSprints()`
      is the one they want first.
- [ ] The user names **one of their own PRs that has review comments**, for A8's recorded
      `reviewThreads` fixture and for smoke step 6a (U5). Without it A8 records nothing and the
      fixture is skipped with a message, exactly as A2 does.
- [ ] The user confirms `watchAuthors` — R47 makes the parking lot a *choosing* surface, so a
      watch list that is too broad now costs more than it did (U4).
- [ ] **Escalate rather than choose** if either answer is missing. A1 may start without them (they
      are runtime config, not code), but the smoke pass (§8) cannot.

### Task A1: inventory gains `humanActivity`, `branch`, `ticketKeys`, `reviewRequests`, and the age/size/CI/labels fields — tier `executor-heavy`

**Depends on:** R4, R5, R6, R8, R9, **R47** (the shape of `humanActivity`), **R53** (the eight new
`gh` fields). **Escalated** because it changes a persisted, zod-validated
document that a load path *throws* on (`inventory-store.ts:46-52`) and because it reverses a
recorded decision (`DECISIONS.md:79-82`).

**Files:** create `src/work/bot-login.ts`, `src/gh/ticket-keys.ts`,
`test/fixtures/inventory-pre-phase9.json`, `test/work/bot-login.test.ts`; modify
`src/gh/pr-view.ts`, `src/inventory/inventory.ts`, `src/config/core-config.ts` (`botLogins`,
`showAllRepoPrs`), `test/inventory/*`.

**Interfaces (produce):** `isBotLogin(login, opts?: { isBot?: boolean; extra?: readonly string[] }): boolean`;
`extractTicketKeys(text: string, projectKeys: readonly string[]): string[]` (**beside**, never
replacing, `extractTicketKey`; **returns `[]` when `projectKeys` is empty** — R46);
`InventoryEntry` gains `branch`, `ticketKeys`, `reviewRequests`,
`humanActivity: { reviewedBy: string[]; commentedBy: string[]; lastAt: string | null }` (R47,
**replacing R6's `humanReviewed`/`reviewers` pair — neither name exists anywhere**), `createdAt`,
`changedFiles`, `additions`, `deletions`, `ci: CiStatus`, `labels`, **all eleven
optional-with-a-default** (R45); `PR_INVENTORY_FIELDS` gains
`createdAt,changedFiles,additions,deletions,reviewRequests,statusCheckRollup,labels,body` (R53) and
**`PR_LIST_FIELDS` is untouched** (R8);
**`PrListItemSchema` and `PrInventoryItemSchema` name every one of those eight explicitly as
optional** — `PrListItemSchema` is not passthrough, so an unnamed field is silently stripped
(R29/R30); `ActivityAuthorSchema` gains `is_bot: z.boolean().optional()`; `ci` is produced by the
**existing** `ciStatus()` (`pr-view.ts:123-142`) — no new CI logic is written.
**R59**: `statusCheckRollup: z.array(StatusCheckSchema).catch([]).optional()` — a parse failure
is `[]`, hence `ci: 'none'`, never a throw (U6). **R60**: `reviewRequests` is
`z.array(z.union([z.object({ login: z.string() }), z.object({ name: z.string().optional(), slug: z.string() })])).catch([]).optional()`,
flattened by one pure helper to `string[]` (a user's `login`, a team's `slug`) — **not**
`z.array(z.object({ login: z.string() }))`, which throws on the first team-requested PR.
**R58**: the entry also gains `reviewDecisionAt: string | null` (default `null`), the latest
`APPROVED`/`CHANGES_REQUESTED` review's `submittedAt`.

- [ ] **RED** — `test/work/bot-login.test.ts`: `is_bot: true` wins; `dependabot[bot]` and
      `Dependabot[Bot]` are bots; `github-actions` is a bot via the default list; a human called
      `robots` is **not**; the `extra` list adds to, never replaces, the defaults.
- [ ] **RED (MG-11)** — `test/gh/ticket-keys.test.ts`: with `projectKeys: ['HB','GRAC']`,
      `feature/HB-627-thing` → `['HB-627']` and `"HB-627 and GRAC-12"` → both, in order, while
      `UTF-8`/`SHA-256`/`PR-123` are dropped; with `projectKeys: []` **every input returns `[]`**
      (R46 — linking disabled, not unfiltered) and the "ticket linking disabled: set
      jira.projectKeys in core.json" line is logged **once per process**, not per call;
      `extractTicketKey` still returns only the first match and its existing test is untouched.
- [ ] **RED (MG-3)** — `test/inventory/inventory.test.ts`: a PR whose only reviews/comments are
      `dependabot[bot]` + `github-actions` has `humanActivity.lastAt === null` and empty
      `reviewedBy`/`commentedBy`; one comment
      by a **non-watched human** sets `lastAt` and lists that login — **while `teamActivity` stays
      empty**, which is the whole point of R6; a comment by the PR author alone does not; a
      review by `me` does. `branch` is `headRefName`; `ticketKeys` is extracted from branch,
      then title, then body, deduped in that order — **and the body path is proven by a fixture
      whose key appears ONLY in `body`** (R29: it fails outright if `body` is not named on
      `PrListItemSchema`); `reviewRequests` is carried through from `gh` (R30);
      **`body` is not a field of `InventoryEntry`** (a source grep in the test asserts the
      persisted document has no `body` key — R8).
- [ ] **RED (R53)** — `createdAt`, `changedFiles`, `additions`, `deletions` and `labels` are
      carried through from `gh` verbatim; `statusCheckRollup` is collapsed to `ci` by the
      **existing** `ciStatus()` (a fixture with a failing check yields `'failure'`, an empty
      rollup `'none'`); a `gh` payload missing all eight new fields still parses and every one
      takes its default.
- [ ] **RED (R59, R60, R67)** — a **malformed** `statusCheckRollup` yields `ci: 'none'` and no
      throw; a `reviewRequests` array mixing `{login:'jane'}` and `{name:'Web',slug:'web'}`
      flattens to `['jane','web']`; a `GhCommandError` whose stderr contains
      `MAX_NODE_LIMIT_EXCEEDED` (or `exceeds the maximum node limit`, case-insensitively) makes
      the scanner issue **exactly** the two partitioned `gh pr list` calls and join them on
      `number`, and a second limit error on the partitioned call falls back to the previous
      scan's entries (`inventory-scanner.ts:72-78`). Asserted by **counting** the `gh` fake's
      calls: one normally, three after a limit error, **never four**.
- [ ] **RED (R58)** — `reviewDecisionAt` is the `submittedAt` of the **newest review whose
      `state` matches the entry's current `reviewDecision`**, and `null` when none matches
      (`''`, `REVIEW_REQUIRED`); on a **mixed** PR (older `APPROVED`, newer
      `CHANGES_REQUESTED`, decision `CHANGES_REQUESTED`) it is the **newer** one's. A **push
      with no new review does not change it**. Mutation that must fail this: taking the latest
      `APPROVED` review regardless of the current decision.
- [ ] **RED (MG-7 / R45 / MG-12 core half)** — `test/inventory/inventory-store.test.ts`:
      **`test/fixtures/inventory-pre-phase9.json` (none of the eleven new fields) loads, and every
      new field takes its default**, with `createdAt`/`changedFiles`/`additions`/`deletions`
      defaulting to **`null`, never `0`**. Mutation that must fail this: making any one of them
      required, or defaulting a number to zero.
- [ ] **GREEN** — implement. `humanActivity` is computed in `buildEntries`
      (`inventory.ts:102-127`) from the raw `item.reviews`/`item.comments`, **not** from
      `teamActivity`; `buildTeamActivity`, `buildOursStatus` and `groupInventory` are not touched.
      The **thread** half of `humanActivity` arrives in A8; A1 leaves the field additive so A8 only
      widens the inputs.
- [ ] **DoD greps:** `grep -rn "\[bot\]" cgremlin/core/src | grep -v src/work/bot-login.ts` → empty
      (MG-4). `grep -rn "humanReviewed" cgremlin/core cgremlin/vscode` → **empty** (the name is
      gone with R47). `grep -n "body" cgremlin/core/src/inventory/inventory.ts` → no schema field.
      `grep -n "body\|reviewRequests\|statusCheckRollup\|changedFiles" cgremlin/core/src/gh/pr-view.ts`
      → all named on the schemas **and** in `PR_INVENTORY_FIELDS`, and **none in
      `PR_LIST_FIELDS`** (R8/R53).
- [ ] Commit `feat(cgremlin-core): inventory rows carry human activity, age, size, CI and ticket keys`.

### Task A2: the `gh` fixture that closes U1 — tier `executor`

**Depends on:** A1.

**Files:** create `test/fixtures/gh/pr-list-with-bot-reviews.json`; modify
`test/inventory/inventory-scanner.test.ts`.

- [ ] Run, by hand, `gh pr list --repo <a real repo with a bot review> --json <PR_INVENTORY_FIELDS>`
      and commit the raw JSON as the fixture, **redacting nothing structural**.
- [ ] **RED (U6)** — the same fixture is the evidence for `statusCheckRollup`'s and
      `reviewRequests`' real shapes on `gh pr list`: assert the lenient parsers (R59/R60) produce
      the right `ci` and the right flattened logins **from the real sample**, and record in
      `docs/DECISIONS.md` whether the lenient path was load-bearing.
- [ ] **RED** — the scanner parses that fixture and reports whether an activity author carried
      `is_bot`. Record the answer in a comment in the fixture's test and, if it is absent, in
      `docs/DECISIONS.md` under Phase 9 — that is what closes U1 either way.
- [ ] If no such repo is reachable, **skip with a message naming what was looked for** (the
      `describe.skipIf` pattern already used at `vscode/test/packaging/vsix-contents.test.ts:38`)
      and leave U1 open in the spec. Do not fabricate a fixture.
- [ ] Commit `test(cgremlin-core): record a real gh pr list sample for the bot-author question`.

### Task A3: config — `jira`, `botLogins`, `showAllRepoPrs`, `jiraCachePath`, `reviewThreads`, and the secret regime — tier `executor-heavy`

**Depends on:** A1, R7, R10, R11. **Escalated** because a missed line in `hasAnySecret` means a
world-readable `core.json` holding an API token loads without complaint.

**Files:** modify `src/config/core-config.ts`, `test/config/core-config.test.ts`.

**Interfaces (produce):** `JiraConfigSchema` (spec §4.2, including `extraFields`, `jql`,
`projectKeys`, `maxResults`, `timeoutMs`, **`scanBudgetMs` default 20000** (R34), and the
injectable `baseUrl`); `CoreConfig.jira?`, `.botLogins`, `.showAllRepoPrs`, `.jiraCachePath?`,
**`.reviewThreads.scanBudgetMs` (default 20000) and `.reviewThreadsCachePath?` (derived
`<stateDir>/review-threads.json`) — R52**.

- [ ] **RED (R44)** — an existing `core.json` with **no** `jira` block still resolves, and
      `hasAnySecret` is false; a `jira` block with **no `apiToken`** (or an empty one) also leaves
      it false; adding a non-empty `jira.apiToken` makes `hasAnySecret` **true**, and a mode-0644
      file with only a Jira token (no Vercel secret) is **refused** with a message naming the file
      (mutation that must fail: extending `redactCoreConfig` but not `hasAnySecret`).
- [ ] **RED** — `redactCoreConfig` replaces `jira.apiToken` with `'[redacted]'` and leaves
      `siteUrl`/`email`/`jql` intact; it is idempotent.
- [ ] **RED** — `jiraCachePath` derives to `<stateDir>/jira.json` **and
      `reviewThreadsCachePath` to `<stateDir>/review-threads.json`**; each is `~`-expanded when
      explicit and **omitted** by `writeCoreConfig` when it equals the derived default (the
      `DERIVED_PATH_SUFFIXES` half; mutation that must fail: registering either in
      `resolveCoreConfig` only — `ARCHITECTURE.md:528-534`). **Two derived paths now, two edits
      each.**
- [ ] **RED** — `jira.baseUrl` defaults to `jira.siteUrl` at resolve time **while `siteUrl` stays
      separately readable** (R37: browse URLs come from `siteUrl`, never `baseUrl`); `jql` defaults
      to D3's string; `projectKeys` rejects `hb` and accepts `HB`; `scanBudgetMs` defaults to
      20000.
- [ ] **GREEN** — implement, two edits per derived path.
- [ ] Commit `feat(cgremlin-core): jira config, bot logins and the parking-lot scope switch`.

### Task A4: `JiraSource` port + REST adapter + `whoami` + `check-jira` — tier `executor-heavy`

**Depends on:** A3, R10, U2. **Escalated** because it is the only network client in the engine
besides `gh`, and because U2 is unverified.

**Files:** create `src/jira/jira-source.ts`, `src/jira/jira-rest-source.ts`,
`src/jira/html-to-text.ts`, `src/cli/commands/check-jira.ts`,
`test/jira/jira-rest-source.test.ts`, `test/jira/html-to-text.test.ts`,
`test/fixtures/jira/*.json`; modify `src/cli/main.ts`.

**Interfaces (produce):** the port of spec §R10 as amended by R33/R37 (`search`, `issue`,
`whoami`; **no `*Html` field anywhere on it**) and
`JiraRestSource({ baseUrl, siteUrl, email, apiToken, fetch?, now?, timeoutMs?, extraFields? })`;
`htmlToText(html: string): string`.

- [ ] **RED** — a `http.Server` on `127.0.0.1:0` is the base URL. Assert the **request** the adapter
      makes: `Authorization: Basic ` + base64(`email:token`); `Accept: application/json`; the JQL
      verbatim; the field list
      `summary,description,issuetype,status,priority,labels,assignee,reporter,attachment,comment`
      plus `jira.extraFields`; `expand=renderedFields` on the issue call. **`acceptance_criteria`
      and `customfield_10016` must NOT be in the default set** (they are instance-specific and an
      unknown field 400s the whole request — U2).
- [ ] **RED (R37)** — `siteUrl` and `baseUrl` are set to **different** values; every returned
      `url` is `${siteUrl}/browse/${key}` and **no** returned value contains the stub's origin.
- [ ] **RED (R37)** — comments come from
      `GET /rest/api/3/issue/{key}/comment?orderBy=-created&maxResults=5&expand=renderedBody`,
      fixtured, newest first — **not** from the issue payload's `comment` field.
- [ ] **RED (R33)** — `html-to-text.ts` fixture table: paragraphs and `<br>`; `<ul>/<ol>/<li>`;
      `<pre><code>` → a fenced block; `<a href>` → `text (href)`; `<img>` → `[image: alt]`;
      `&amp;`/`&lt;`/`&#39;`/`&nbsp;` decoded, with `&amp;lt;` decoding **exactly once**; markup
      inside a code block left alone; an unterminated tag not eating the document. The adapter
      returns `descriptionText`/`bodyText` only — a grep over `src/jira` finds **no identifier
      ending in `Html`** (MG-10). **No ADF walker** is written.
- [ ] **RED (R32)** — pagination, **both shapes, separately fixtured**: `/search/jql` pages by
      `nextPageToken` and stops on `isLast` (no `total` invented); `/search` pages by
      `startAt`/`maxResults` and stops at `total`, reading the **response's** own `maxResults`,
      never its request value. A **404 on `/search/jql` falls back to `/search` exactly once per
      scan, not once per page** — asserted by counting stub requests across a two-page result, and
      the two cursor schemes are never interleaved.
- [ ] **RED** — failures: **401** → a `JiraAuthError` whose message quotes Jira's own
      `errorMessages[0]`; **403** → `JiraAuthError` naming permission/captcha; **429** with
      `Retry-After` → exactly **one** bounded retry then a `JiraUnavailableError` (assert the retry
      count, not just the outcome); a `timeoutMs` expiry → `JiraUnavailableError` and the request is
      **aborted** (`AbortController`); a malformed body → `JiraUnavailableError`, never a throw of
      the raw `SyntaxError`.
- [ ] **RED** — `whoami()` against a recorded `/myself` fixture returns
      `{ accountId, displayName, emailAddress }`; against 401 it throws `JiraAuthError`. This is the
      same call the legacy tool used (`bin/cgremlin:1894-1901`).
- [ ] **RED** — `cgremlin-core config check-jira` prints the display name + accountId on success and
      Jira's own wording + exit 1 on failure; with **no `jira` block** it prints "no jira configured"
      and exits 0.
- [ ] **DoD greps:** `grep -rn "method: *'\(POST\|PUT\|DELETE\|PATCH\)'" cgremlin/core/src/jira` →
      empty (read-only, forever). `grep -rn "apiToken" cgremlin/core/src | grep -v config` → only
      the adapter's own header construction. `grep -rnE "[A-Za-z]Html\b" cgremlin/core/src/jira` →
      empty (MG-10).
- [ ] Commit `feat(cgremlin-core): a read-only Jira REST source with an injectable base URL`.

### Task A5: `JiraScanner` + cache, folded into the discovery tick — tier `executor-heavy`

**Depends on:** A4, R12, R34, R35, R37. **Escalated** (up from `executor`) because R34 makes the
leg a non-awaited, single-flight, budget-aborted background step that `stop()` must still drain —
a lifecycle that is easy to get subtly wrong and that a hung stub will expose only as a hang.

**Files:** create `src/jira/jira-scanner.ts`, `src/jira/jira-store.ts`,
`test/jira/jira-scanner.test.ts`; modify `src/inventory/inventory-scanner.ts`,
`src/host/build-engine.ts`, `src/host/serve.ts` (shutdown drains the leg),
`test/inventory/inventory-scanner.test.ts`.

**Interfaces (produce):** `JiraScanReport = { scannedAt, me: string | null, issues: JiraIssueSummary[], error: string | null, kind: 'notConfigured' | 'auth' | 'unavailable' | 'ok' }`
(R35, R37); `ScanReport` gains `jira: JiraScanReport`; `InventoryScannerDeps` gains
`jira?: { run(): Promise<JiraScanReport>; inFlight(): Promise<void> | null }`.

- [ ] **RED (R35)** — with no `jira` block, **or** a block whose `apiToken` is absent/empty, the
      report is `{ kind: 'notConfigured', issues: [], error: null }` and **no HTTP request is
      made**; a 401/403 gives `kind: 'auth'`; a timeout/5xx/malformed body gives
      `kind: 'unavailable'`. There is no `configured` boolean.
- [ ] **RED (MG-6)** — with a source that throws, the report carries `error !== null`,
      `kind: 'unavailable'`, and **the previously written `jira.json` is returned unchanged and
      still on disk**. Mutation that must fail: returning `[]` on failure.
- [ ] **RED (R37)** — a successful scan resolves `me` from `whoami()` **once per scan** and puts
      the accountId on the report.
- [ ] **RED** — a successful scan writes `jira.json` tmp-then-rename (the `InventoryStore` pattern,
      `inventory-store.ts:26-32`) and **the file contains no `apiToken` and no `Authorization`
      value** (part of MG-5).
- [ ] **RED (R34)** — ordering and budget: `inventory.updated` is emitted **before** the Jira leg
      starts (assert the event ordering, not just that both happened); `run()` **resolves without
      awaiting** the leg, so a hung Jira cannot delay `POST /prs/scan`; `ScanReport.jira` is the
      **last completed** report (the cache on a cold start); a leg exceeding `jira.scanBudgetMs`
      is **aborted** by one `AbortController` spanning whoami + every page and recorded as
      `kind: 'unavailable'`; a tick starting during an in-flight leg starts **no second leg**;
      `stop()` awaits the in-flight leg. A jira failure never affects the PR entries.
- [ ] **RED** — `POST /prs/scan`'s body now carries `jira` (it returns the whole report,
      `server.ts:779-783`), the token is not in it, and the response is not delayed by a stub that
      never answers.
- [ ] Commit `feat(cgremlin-core): scan Jira on the discovery tick, cached and degrading`.

### Task A6: `WorkItem`, the pure grouping, and `WorkItemService` — tier `executor-heavy`

**Depends on:** A1, A5, R1, R2, R3, R13. **Escalated** because the grouping *is* the phase and
because MG-1 (no session lock) is easy to violate by reaching for `SessionStore`.

**Files:** create `src/work/work-item.ts`, `src/work/work-item-id.ts`,
`src/work/work-item-service.ts`, `test/work/*.test.ts`; modify
`src/attention/attention-service.ts` (the `dedupe` option — R27), `src/engine/events.ts`,
`src/host/build-engine.ts`, `src/host/serve.ts`.

**Interfaces (produce):** the types of spec §R2 as amended by R25/R26 **and R47/R51/R53**
(`kind` includes `'session'`; `WorkListKind` is the **four** lists of R47 with **no `reviewing`**;
`prs: WorkItemPr[]` carrying `humanActivity`/`createdAt`/`changedFiles`/`additions`/`deletions`/
`ci`/`labels`; `WorkItem.demoted` **and `WorkItem.parkingLotGroup`**; `WorkItemAgent.mode` is `SessionMode`, respond included; every
`WorkItemPr` field beyond repo/number/url nullable;
`attention.refs`); `groupWorkItems(input): WorkItem[]` (**pure, no clock, no I/O**);
`workItemIdOf` / `parseWorkItemId` over **three** id forms; `WorkItemService.list()`, `.get(id)`,
`.start()`, `.stop()`; `AttentionService.list({ all?, dedupe? })`;
`EngineEventMap['item.changed'] = { id, kind, changedFields? }` (R41).

- [ ] **RED (R27)** — `AttentionService.list()` still dedupes by default (every existing caller and
      `/attention` unchanged); `list({ dedupe: false })` returns **both** the session item and its
      `source: 'pr'` item. Mutation that must fail: flipping the default.
- [ ] **RED (the D2 table, as re-scoped by R47–R50)** — `groupWorkItems` over fixtures: a teammate
      PR with no agent → only
      `parkingLot`, group `'untouched'`; the same PR once we start a **review** → **still**
      `parkingLot`, group `'reviewing'`, and **not** in `myWork` (R47/R48, coordinator override);
      the same PR with an **investigation** instead → `parkingLot` **and** `myWork`;
      **my own** open non-draft PR → never
      `parkingLot`, in **both** `waitingForReview` and `myWork` (R50); a **non-watched** author's
      PR → **no list** with
      `showAllRepoPrs:false` and `parkingLot` with it true (**MG-2 — this is the 58-row regression**);
      **a non-watched author's PR whose `reviewRequests` include me → `parkingLot` regardless
      (R30)**; **a draft PR — mine and a teammate's — in NO list at all (R47, superseding R30's
      marker)**;
      a ticket with no PR → `myWork`; a ticket + PR linked by branch, by title and by body → **one**
      row, `kind: 'pr+ticket'`, id = the **ticket** id; **one ticket with two PRs → one row,
      `prs.length === 2`, newest first, `needsYou` from either (R26)**; an investigation session
      with neither PR nor ticket → `kind: 'session'`, `id: session:<id>`, in **`investigations`
      and NOT `myWork`** (R25 + R49), and the same session **with** a ticket → `myWork`, not
      `investigations`; an investigation **plus** a dev session on one item → `myWork`; **a
      review agent whose PR is merged → still `kind: 'pr'`, `prs[0]` carrying repo/number/url and
      nulls elsewhere (R25)**; two agents on one item → both in `agents`, ordered review →
      respond → investigation → development; `needsYou` rolls up from any agent.
- [ ] **RED (R47 / MG-17)** — `demoted`: a parking-lot PR with a non-bot reviewer, one with a
      non-bot commenter, one with only a review-thread reply, and one with only a **pending review
      request to somebody else** are all `demoted: true` **and still listed**; one whose only
      review request is to **me** is `demoted: false`; a bot-only PR is `demoted: false`.
      **`parkingLotGroup` precedence**: a review agent → `'reviewing'` even when the PR is also
      demoted; else demoted → `'someoneOnIt'`; else `'untouched'`; `null` off the parking lot.
      And the totality/disjointness assertions: **every teammate PR with a review agent of ours
      is in `parkingLot` exactly once, in the `reviewing` group, and `myWork` never contains a
      review-only item**; `investigations` never intersects `myWork`; the legal overlaps are
      `waitingForReview` ∩ `myWork` and `parkingLot` ∩ `myWork` (a teammate PR that also carries
      a non-review session). Mutation that must
      fail this: dropping a row instead of demoting it, or letting a review agent route an item
      into `myWork`.
- [ ] **RED (R47, §4.1 step 5)** — the four **default** sort orders, each asserted **total and
      stable**: `parkingLot` = the three groups in fixed order (`reviewing`, untouched,
      `someoneOnIt`) with the sort applied **within** each group and never across them
      (`needsYou` then `createdAt` ascending inside `reviewing`, `createdAt` ascending inside the
      other two); `waitingForReview` =
      `createdAt` ascending; `myWork` = `needsYou` then most-recently-updated; `investigations` =
      most-recently-updated. A missing key sorts last and ties break on `id` — asserted with a
      fixture where two items differ only by id. **No clock is read.**
- [ ] **RED (R63)** — `ATTENTION_REASONS` is asserted **element-for-element** against R63's
      literal (positions 6, 9 and 10 are `comments_ready`, `review_arrived`, `approved`), and
      `NEEDS_YOU_REASONS` contains all three. Mutation that must fail this: reordering the array,
      which silently rewrites every stored ack signature.
- [ ] **RED (R58)** — each new reason's `at` is the stable timestamp: `review_arrived` →
      `humanActivity.lastAt`, `approved`/`changes_requested` → `reviewDecisionAt`, **never**
      `updatedAt`. The named test: **"a push to an approved, acked PR re-fires nothing"** — ack,
      bump `updatedAt` and `headSha` with no new review, re-derive, assert the signature is
      unchanged and `acked` is still true.
- [ ] **RED (R57)** — `open(pr)` is `pr.isDraft !== true`: a `WorkItemPr` with `isDraft: null`
      (a pre-Phase-9 row, or the agent-only row of R25) is **listed**, not silently dropped. And
      the **totality invariant**: a **merged** teammate PR that still carries our review agent is
      in `parkingLot.reviewing` (the disjunct drops the *state* test, and such a row's `isDraft`
      is `null`, which passes), and a merged own PR with a
      respond or development agent is in `myWork`. But the disjunct **keeps** `pr.isDraft !==
      true`: **a teammate DRAFT PR with a review agent is in NO list** (R47 holds whether or not
      we have an agent on it).
- [ ] **RED (R61)** — two **teammates'** PRs naming `HB-627` produce **two** items with two ids,
      each its own parking-lot row; the same pair with one of them **mine** produces the R26
      two-PR row; a ticket assigned to me absorbs a teammate's PR that names it. Mutation that
      must fail this: merging on the ticket key alone.
- [ ] **RED (R50)** — `derivePrReasons`: my PR with a non-bot review → `review_arrived`; with
      `reviewDecision: 'APPROVED'` → `approved`; with `CHANGES_REQUESTED` → `changes_requested`; a
      reviewer **outside `watchAuthors`** still fires `review_arrived` (the widening away from the
      watch-filtered `teamActivity` at `attention.ts:160-165`); a bot-only review fires nothing; a
      **teammate's** PR fires nothing however loud it is (MG-A8 unchanged). All three are in
      `ATTENTION_REASONS` (in the documented order) **and** in `NEEDS_YOU_REASONS`.
- [ ] **RED (R28)** — a ticket candidate is seeded from a PR's `ticketKeys[0]` or a session's
      filtered `lineage.ticket` **even when the JQL snapshot has no such issue**, carrying the key
      alone. The named test: **"ticket leaves the JQL → id unchanged"** — group with and without
      the issue in the snapshot and assert the same `id` and the same list membership; repeat with
      `ticketSource.kind: 'unavailable'`. Mutation that must fail: seeding ticket candidates from
      the snapshot only.
- [ ] **RED (R29)** — `lineage.ticket` is filtered through `projectKeys` at group time; a session
      whose `lineage.ticket` is `SHA-256` joins nothing. The scan-time/group-time asymmetry is
      stated in a comment on the grouping function.
- [ ] **RED (R3 + R31)** — `attention.acked` is true only when every ref in `attention.refs` is
      acked, and `attention.refs` contains **every agent ref and every PR ref** — it is what the
      server-side ack fan-out (A7) iterates.
- [ ] **RED (R13)** — the label rules: ticket summary preferred; an empty or unfetched summary
      falls back to the bare `<KEY>`; a PR with a null title falls back to `<repo>#<n>`; a
      `session` item uses the session title; **a `parkingLot` row is always `<repo>#<n> — title`
      even when it carries a ticket key** (R47's addition to R13).
- [ ] **RED (MG-9)** — `workItemIdOf`/`parseWorkItemId` round-trip **all three** forms
      (`ticket:…`, `pr:owner/repo#12`, `session:<id>`); `parseWorkItemId` rejects garbage with
      `ValidationError`.
- [ ] **RED (MG-1)** — `WorkItemService.list()` against a **wrapped `KeyedLock`** records zero
      `lock.enter:<sessionId>` entries (the Phase 5 / MG-A3 technique). Mutation that must fail:
      injecting `SessionStore` into `WorkItemService`.
- [ ] **RED (R41)** — `item.changed` fires only on a real delta (the `deltaKeyOf` discipline at
      `attention-service.ts:342-354`, `:557-562`), a burst of `attention.changed` for one item
      coalesces into one `item.changed`, and the **payload is `{ id, kind, changedFields? }`** —
      a test asserts the frame carries **no** `item` key, so 256 whole work items can never sit in
      the event ring (`event-stream.ts:5`).
- [ ] **DoD greps:** `grep -rn "SessionStore\|readFile\|statMtime" cgremlin/core/src/work` → empty.
      `grep -n "item.changed" cgremlin/core/src/engine/events.ts` → **two** hits (the map and
      `ENGINE_EVENT_TYPES`); `grep -n "item.changed" cgremlin/core/src/host/serve.ts` → one.
      `grep -rnE "[A-Za-z]Html\b" cgremlin/core/src/work` → empty (MG-10).
      `grep -rn "'reviewing'" cgremlin/core/src/work` → empty (R47: the list is gone, not renamed).
- [ ] Commit `feat(cgremlin-core): work items group agents, PRs and tickets into four lists`.

### Task A7: the `/items` routes, and the `## Ticket` brief section — tier `executor-heavy`

**Depends on:** A6, R14, R15, R18. **Escalated** because `POST …/agents` creates sessions and starts
runs, and because it must share the existing `pr:<slug>#<n>` lock key rather than inventing one.

**Files:** create `test/api/items-routes.test.ts`; modify `src/api/server.ts`,
`src/pipeline/prompts.ts`, `src/pipeline/pipeline-service.ts`, `src/host/build-engine.ts`,
`test/pipeline/prompts.test.ts`.

**Interfaces (produce):** the six route shapes of spec §4.3 (three GET kinds, `POST …/agents`,
`POST …/ack`); `renderTicketSection(ctx): string`; `TicketBriefContext`; the R36 detail cache on
`JiraStore`.

- [ ] **RED (R35, R47)** — `GET /items` shape, including the **four** list keys
      (`parkingLot`, `myWork`, `investigations`, `waitingForReview` — and **no** top-level
      `reviewing`), with `lists.parkingLot` an **object of three ordered id arrays**
      (`{ reviewing, untouched, someoneOnIt }`) whose membership matches each item's
      `parkingLotGroup` exactly,
      `ticketSource.kind` as the four-value union
      (**no `configured`/`ok` booleans**); `?list=` accepts exactly those four and **400s on
      `reviewing`**; the route 404s cleanly on an unwired
      `WorkItemService` (the `deps.attention` pattern at `server.ts:565-569`).
- [ ] **RED (R25)** — `GET /items/ticket/:key`, `GET /items/pr/:owner/:repo/:number` **and
      `GET /items/session/:id`** return the item, the Jira detail and per-agent artifact listings;
      `:id` is validated by the existing session-id regex (`validation.ts:54`) before use;
      **with Jira returning 500 the route still answers 200** with `ticket: null` and
      `ticketError` set.
- [ ] **RED (R36)** — two opens of the same ticket within 60 s make **one** Jira request; a
      changed `updated` in the scan snapshot invalidates the cache immediately; an `item.changed`
      triggers **zero** detail fetches.
- [ ] **RED (R31)** — `POST /items/<path>/ack` fans out server-side to **every** ref in
      `attention.refs` (each agent ref **and** each PR ref), returns
      `{ item, acked, failed }` with 200 when at least one ref acked and 502 when none did, and
      skips an unknown ref rather than failing. Mutation that must fail: acking only the first ref.
- [ ] **RED (R33 / MG-10)** — a ticket whose description is `<b>bold</b>` comes back as text: the
      `GET /items/…` body contains neither `<b>` nor any `*Html` field.
- [ ] **RED (MG-8)** — both GETs record **zero** `FakeAgentRunner` starts and zero `run.started`;
      `POST …/agents { mode: 'review' }` records exactly one; two concurrent `POST …/agents` for one
      PR yield **one** session, and a concurrent `POST /prs/:o/:r/:n/review` for the same PR also
      collides — because both take `pr:<slug>#<n>` (`server.ts:816`). Mutation that must fail:
      inventing a new lock key.
- [ ] **RED** — `POST /items/ticket/:key/agents { mode: 'development' }` **without `repoUrl`** is a
      **400** whose message names `repoUrl` (R15); with `repoUrl` it creates a session whose
      `lineage.ticket === key`; `mode: 'review'` on a ticket-only item is a 400; `mode: 'review'` on
      my own PR is a **409** with the engine's own `OwnPrError` wording.
- [ ] **RED (MG-9, R65)** — a source grep over `src/api/server.ts` finds no `/items/${` interpolation of a
      raw id, and the three path kinds are parsed through `parseWorkItemId`'s counterpart rather
      than string-sliced ad hoc. **A `pr/…` path resolves to the item whose `prs` contains that
      PR and a `session/:id` path to the item whose `agents` contains that session — not by
      matching the path against the item's `id`**: an item whose `id` is `ticket:HB-627` and
      whose `prs[0]` is `owner/repo#12` answers 200 at `/items/pr/owner/repo/12` with
      `id: 'ticket:HB-627'` in the body. Mutation that must fail this: resolving by id equality,
      which 404s exactly the merged items the phase exists to create.
- [ ] **RED (R18)** — `renderTicketSection` returns `''` for an empty context; caps at 5 comments,
      2000 chars each, 12000 total, and says so in the rendered text when it truncated; the findings
      and develop briefs contain the section **only** when a ticket was fetched, and the existing
      "fetch it via getJiraIssue" line is reworded rather than deleted; **no `BRIEF.md` ever contains
      the token** (part of MG-5).
- [ ] Commit `feat(cgremlin-core): the /items routes and ticket context in the brief`.

### Task A8: review threads — the engine's first GraphQL call — tier `executor-heavy`

**Depends on:** A1 (the `humanActivity` field), A3 (`reviewThreadsCachePath`,
`reviewThreads.scanBudgetMs`), A5 (R34's leg discipline, which this leg copies), **R52**, **U5**.
**Escalated** because it is a new protocol against a system nobody here has called before, because
its cost is the phase's second-biggest risk, and because R55 forbids the mutation half of that
protocol forever.

**Files:** create `src/gh/review-threads.ts`, `test/gh/review-threads.test.ts`,
`test/fixtures/gh/review-threads-{page1,page2,comments-page2,empty}.json`; modify
`src/inventory/inventory-scanner.ts`, `src/inventory/inventory.ts` (the thread half of
`humanActivity`), `src/host/build-engine.ts`, `src/host/serve.ts`, `src/api/server.ts`
(`threadSource` on `GET /items`), `test/inventory/inventory-scanner.test.ts`.

**Interfaces (produce):**
`ReviewThread = { id, isResolved, isOutdated, path, line, truncated, comments: Array<{ author, body, createdAt, url }> }`;
`fetchReviewThreads(gh: GhRunner, repo: string, number: number, opts): Promise<ReviewThread[]>`;
`ReviewThreadStore` over `<stateDir>/review-threads.json`, keyed `"<repo>#<n>"` with the PR's
`updatedAt` beside the threads; `ScanReport` gains `threads: { scannedAt, error: string | null, fetched: number }`.

- [ ] **RED (U5, the fixture)** — run the query by hand against the PR A0 named and commit the raw
      response as the fixture, **redacting nothing structural**. If no such PR is reachable,
      `describe.skipIf` with a message naming what was looked for (the pattern at
      `vscode/test/packaging/vsix-contents.test.ts:38`) and leave U5 open. **Do not fabricate a
      fixture.**
- [ ] **RED** — the argv handed to `GhRunner`: `api graphql` with the query text, `owner`, `repo`
      and `number`, and `after` present **only** on page two. Both paginations are covered by
      separate fixtures: thread pages via `pageInfo.hasNextPage`/`endCursor`, and a thread whose
      `comments` page reports `hasNextPage` is followed; a thread still truncated at the cap comes
      back `truncated: true` rather than silently short.
- [ ] **RED (MG-16, the cost guard)** — over a 60-PR fixture inventory, one tick invokes
      `gh api graphql` **only** for my open non-draft PRs and for parking-lot candidates whose
      `humanActivity` is empty from reviews and comments alone; a second tick with unchanged
      `updatedAt`s invokes it **zero** times. Mutation that must fail this: fetching per PR per
      tick, or keying the cache on anything but `updatedAt`.
- [ ] **RED (MG-3, thread half)** — a non-bot, non-author **thread reply** sets
      `humanActivity.lastAt` and lists that login; a bot reply does not; the PR author's own reply
      does not.
- [ ] **RED (R34's discipline, applied)** — the leg runs **after** `inventory.updated` is emitted,
      is **not awaited** by `run()`, is **single-flight**, is aborted by one `AbortController` at
      `reviewThreads.scanBudgetMs`, records the expiry as an `error` rather than throwing, leaves
      the **previous** cache intact on failure, and is drained by `stop()`. `GET /items` carries
      `threadSource` and a non-null `error` never empties a list (MG-6's shape).
- [ ] **RED (MG-14 / R55)** — the test's `GhRunner` fake **throws on any argv containing
      `mutation`** or a mutating `gh pr` verb, and the suite is green; a source grep over
      `src/gh/review-threads.ts` finds no `mutation` literal.
- [ ] **DoD greps:** `grep -rn "mutation" cgremlin/core/src` → empty.
      `grep -rnE "gh (pr (comment|review|merge|edit|close|ready)|api .*-X (POST|PATCH|PUT|DELETE))" cgremlin/core/src` → empty.
- [ ] Commit `feat(cgremlin-core): fetch and cache pull-request review threads`.

### Task A9: the `respond` mode — schema, **stage**, factory, brief, route, run — tier `executor-heavy`

**Depends on:** A7 (the `/items/.../agents` handler), A8 (the threads the brief carries), **R50**,
**R51**, **R55**. **Escalated** because it adds a value to a persisted discriminated union and to
the one terminal-phase map eight modules read, and because it is the phase's largest judgment
call. **Do not start it before A8's fixture exists** — a brief written against a guessed thread
shape is a brief that has to be rewritten.

**Files:** modify `src/schema/session-mode.ts`, `src/schema/session.ts`, `src/schema/pipeline.ts`,
**`src/schema/stage.ts` (`STAGE_NAMES` gains `'respond'` — R56)**,
`src/workspace/workspace-in-use.ts`, `src/attention/attention.ts`, `src/pipeline/prompts.ts`,
`src/pipeline/pipeline-service.ts` (**`runRespond` + `RESPOND_RUNNABLE_FROM`**),
`src/api/server.ts`, `src/api/validation.ts`,
`src/host/build-engine.ts`; create `src/pipeline/respond-session-factory.ts`,
`test/pipeline/respond-session-factory.test.ts`, `test/fixtures/sessions-pre-phase9/*.json`;
extend `test/pipeline/prompts.test.ts`, `test/api/items-routes.test.ts`,
`test/schema/session.test.ts`, `test/attention/attention.test.ts`.

**Interfaces (produce):** `SessionModeSchema` gains `'respond'`;
`RESPOND_PHASES = ['triaging','addressing','ready','closed','abandoned']` with the transition
table of R51 and `PhaseFor<'respond'>`; `TERMINAL_PHASES_BY_MODE.respond = new Set(['closed','abandoned'])`;
`AttentionReason` gains `'comments_ready'` (session) and `'review_arrived'`/`'approved'` (PR — from
A6/R50, wired here if A6 left them stubbed);
`RespondSessionFactory.createFromPr(...)` + `NotMyPrError`;
`renderRespondBrief(ctx: RespondBriefContext): string`;
**`STAGE_NAMES` gains `'respond'`** (appended, so no persisted `lastRun.stage` shifts meaning);
**`PipelineService.runRespond(id): Promise<Session>`**, written in the shape of `runDevelop`
(`pipeline-service.ts:587-618`) and going through `runStageLocked(id, 'respond', …)`;
**`RESPOND_RUNNABLE_FROM: readonly RespondPhase[] = ['triaging','addressing','ready']`**, declared
and checked beside `REVIEW_RUNNABLE_FROM` (`:647`).

- [ ] **RED (MG-13)** — a committed fixture directory of pre-Phase-9 sessions (v1 and v2, all three
      old modes) loads unchanged through `SessionStore` **after** the fourth variant is added, and
      `migrateV1ToV2` gains **no** respond case (a v1 respond document cannot exist). Mutation
      that must fail this: replacing the discriminated union, or extending the v1 union.
- [ ] **RED (R51)** — `RESPOND_PHASES` and its transitions (`triaging → addressing | abandoned`;
      `addressing → ready | abandoned`; `ready → addressing | closed | abandoned`; `closed` and
      `abandoned` terminal); `TERMINAL_PHASES_BY_MODE.respond`; and
      `deriveSessionReasons` firing `comments_ready` at `ready` and **nothing** at `triaging` or
      `addressing`. `comments_ready` is in `NEEDS_YOU_REASONS`.
- [ ] **RED (R51)** — `RespondSessionFactory` throws `NotMyPrError` on a **teammate's** PR and the
      workspace fake records **zero** `createWorkspace` calls (the same refuse-before-you-create
      ordering as `review-session-factory.ts:63-72`); on **my** PR it creates the worktree on the
      PR's own head branch (`branchName === headRefName`, `baseRef === origin/<headRefName>`) and
      sets `lineage.ticket` from the branch. **`ReviewSessionFactory`'s `OwnPrError` behaviour is
      unchanged** — its existing test must still pass untouched.
- [ ] **RED (R56, the stage)** — `STAGE_NAMES` contains `'respond'` and a **pre-Phase-9
      `lastRun.stage`** still parses; `POST /sessions/:id/run { stage: 'respond' }` validates
      (`validation.ts:85-91`); `run.started`/`run.finished` carry `stage: 'respond'`.
- [ ] **RED (R56, the run)** — `runRespond` refuses a non-`respond` mode with
      `UnsupportedStageError`, refuses a claimed session (`HumanTurnInProgressError`, the
      unlocked advisory check **and** `assertNoHumanTurn` on the **fresh** in-lock load), refuses
      a phase outside `RESPOND_RUNNABLE_FROM` **on that fresh load** (the race the comment at
      `pipeline-service.ts:601-604` exists to close), composes `renderRespondBrief`, and
      transitions **`triaging → addressing`** on success. Mutation that must fail this: checking
      the phase only on the pre-lock load.
- [ ] **RED (R56, MG-8 amended)** — `POST /items/pr/:o/:r/:n/agents { mode: 'respond' }`
      **creates the session and starts the respond run in the same request**, answering `202`
      with `started: true`, and the `FakeAgentRunner` records **exactly one** start; every `GET`
      still records **zero**. The route **takes no claim** — R42 is unchanged, only the chat
      terminal ever claims. This is the one place Phase 7 R5 is deliberately satisfied by a
      click rather than a second button — recorded in `DECISIONS.md`. Mutation that must fail
      this: returning a created-but-unrun session with an empty `BRIEF.md`.
- [ ] **RED (R51 parity)** — a second `POST …/agents { mode: 'respond' }` on a PR with a live
      respond session never creates a second one (`created: false`) and **restarts** the run
      (`started: true`) on a recomposed brief, **unless** a run is in flight or the session is
      claimed, in which case it is `{ created: false, started: false }` with a reason — the same
      parity rule `POST /reviews` has. Mutation that must fail this: restarting over a live run,
      so two agents write one `COMMENTS.md`. Also: two concurrent posts yield **one** session under
      the **same** `pr:<slug>#<n>` lock key as the review path (`server.ts:816`);
      `mode: 'respond'` on a ticket-only or session item is a **400**, on somebody else's PR a
      **409** naming `NotMyPrError`.
- [ ] **RED (R50, the brief)** — `renderRespondBrief` returns `''` with nothing fetched; over a
      two-thread, five-comment fixture it contains **every one of the five comment bodies** with
      its `path:line` and author (the regression the legacy `comments(first:1)` truncation caused);
      resolved and outdated threads are **labelled, not dropped**; per-reviewer review states and
      the `reviewDecision` are present; failing CI checks appear by name with `detailsUrl`;
      `changedFiles`/`additions`/`deletions` are present; the `## Ticket` block is
      `renderTicketSection`'s output **byte-for-byte**; the caps (50 threads, 20 comments/thread,
      2000 chars each, 40000 total) truncate and **say so**; the reconcile-first instruction and
      the legacy `COMMENTS.md` entry shape (`Thread`/`From`/`Where`/`Comment`/`Verdict`/
      `Reasoning`/`Proposed reply`/`Proposed fix`/`Status`) are present.
- [ ] **RED (MG-14 / R55)** — the brief contains **no** instruction to reply, resolve, push or
      otherwise post; the respond flow's tests run against a `GhRunner` fake that throws on every
      mutating verb; a grep finds no `--reply-comment`/`--resolve-comment`/`--push-fix` anywhere.
      The out-of-scope line is written into the brief itself so the agent knows where v1 ends.
- [ ] **DoD greps:** `grep -rn "respond" cgremlin/core/src/workspace/workspace-in-use.ts` → one hit
      (the terminal set); `grep -n "respond" cgremlin/core/src/schema/stage.ts` → one hit
      (`STAGE_NAMES`); `pnpm typecheck` is the real guard — the `Record<Session['mode'],…>` map
      makes a missing entry a compile error.
- [ ] Commit `feat(cgremlin-core): a respond mode for addressing reviews on my own PR`.

---

## Stream B — extension (branch `phase9-ext`). Developed against committed `/items` fixtures; it never waits on Stream A.

*(There is no Task B0. The renderer spike is gone: R40 decided the question — bundled `markdown-it`
via esbuild — and B2 implements it directly.)*

### Task B1: the wire mirror, the four-list view model and the sorts — tier `executor`

**Depends on:** A6's shapes (from the spec, not the code), R24, R25, R26, R30, R35, **R47–R50**.

**Files:** create `src/model/work-items.ts`, `test/work-items.test.ts`,
`test/support/fixtures/items.json`; modify `src/model/items.ts`, `test/purity.test.ts`.

- [ ] **RED (MG-B8)** — `buildWorkLists` returns exactly
      `parkingLot`/`myWork`/`investigations`/`waitingForReview` and **no** `reviewing` (R47); the
      row label follows R13 (including the bare-`<KEY>`, null-title, `session` and
      **parking-lot-is-always-`repo#n`** cases); the
      description carries agent badges (`R`/`I`/`D`/**`C`** for respond, with
      running/needsYou/claimed glyphs), **one
      `repo#n` chip per entry in `prs`** (R26), the **age** cell from `createdAt`, the **size**
      cell (`N files +a/−d`), the CI dot and the `humanActivity` summary
      (`👤 @jane reviewed` / `commented` / `requested`). **No draft ever appears** and there is no
      `draft` marker and no no-human-review badge (R47, superseding R30).
- [ ] **RED (MG-12)** — a row whose PR fields took their R45 defaults renders `—` for age and
      size and no CI dot; nothing renders `0 files` or `opened today`; it sorts **last** under
      `oldest` and `smallestChange`.
- [ ] **RED (R47, sorts)** — `WorkSortKind` is the documented union; each list's **default**
      matches the core's order; each selectable sort produces the documented order
      (`untouchedFirstThenOldest` = within-group, `reviewing` first then untouched then
      `someoneOnIt`, oldest inside each; `smallestChange` = `changedFiles`
      ascending, nulls last; `oldest`/`newest` on `createdAt`); the selection round-trips through a
      **fake `globalState`** keyed `cgremlin.sort.<list>`, and an unknown or absent persisted value
      falls back to that list's default rather than throwing.
- [ ] **RED (R47, the three groups)** — the `parkingLot` view model splits into **three ordered
      sections** — **"Reviewing (N)"** holding exactly the `parkingLotGroup: 'reviewing'` rows
      (with their agent badges and `needsYou`), then the untouched rows, then the collapsed
      **"someone is on it (N)"** section. The
      extension **reads `item.parkingLotGroup`** and the wire's
      `lists.parkingLot: { reviewing[], untouched[], someoneOnIt[] }`; a grep asserts
      `work-items.ts` contains no `humanActivity` predicate and no `mode === 'review'` grouping
      test of its own (D2: the core owns the rule).
- [ ] **RED (R35)** — `ticketSource.kind: 'unavailable'` yields the stale-tickets banner rather
      than an empty `myWork`; **`kind: 'auth'`** yields the *engine-trouble* treatment — a row
      **and** a status-bar state — whose text names `cgremlin-core config check-jira`;
      `kind: 'notConfigured'` yields **nothing at all**.
- [ ] **RED (R25, R65)** — a `kind: 'session'` item renders and its id round-trips to
      `/items/session/:id` when the row is opened. One pure helper maps an item's `id` to a path
      (`ticket:K → ticket/K`, `pr:o/r#n → pr/o/r/n`, `session:s → session/s`), and a **child**
      click uses **that child's own** path — so a PR child of an item whose `id` is
      `ticket:HB-627` opens `/items/pr/o/r/n` (R65).
- [ ] **RED (R48, MG-15)** — `buildItemChildren(item)` returns exactly `agents[]` (in R2's order)
      then `ticket` then `prs[]`, only what exists: adding a fourth agent to the fixture adds a
      fourth child **with no view-model edit**, and removing the ticket removes exactly one child.
      Each child carries its default action (Info, with the right `focus`) and its secondary
      action (Go-to, with the right target). An item with no children reports none.
- [ ] **RED** — the module is added to `pureSourceFiles()` **and contains no occurrence of the
      string `vscode`, prose included** (Phase 8 R30; `test/purity.test.ts:15-33`).
- [ ] Commit `feat(vscode): the work-item wire mirror, four lists and their sorts`.

### Task B2: the bundled renderer, the build step, and the message protocol — tier `executor-heavy`

**Depends on:** B1, R21, R39, R40. **Escalated** because it is the phase's security boundary and
because it changes how the extension is built.

**Files:** create `src/webview/item-tab.ts`, `src/model/escape-html.ts`,
`src/model/item-tab-protocol.ts`, `test/markdown-render.test.ts`,
`test/item-tab-protocol.test.ts`; modify `package.json` (devDependencies + scripts),
`.gitignore`, `test/purity.test.ts`.

- [ ] **GREEN first, exceptionally** — the build step, because the renderer tests import it:
      add `esbuild`, `markdown-it` and `@types/markdown-it` as **devDependencies**; add a
      **`build:webview`** script running esbuild over **both** entry points —
      `src/webview/item-tab.ts` → `media/item-tab.js` and (R54) `src/webview/panel.ts` →
      `media/panel.js` — each `--bundle --format=iife --platform=browser --target=es2020
      --minify`; wire it into
      **both `build` and `vscode:prepublish`**; add `media/item-tab.js` **and `media/panel.js`** to
      `.gitignore`. Assert in
      a test that both scripts reference `build:webview` and that the script names **both**
      outputs — wiring only `build`, or only one entry point, ships an empty tab or an empty panel
      (R40, R54).
- [ ] **RED (MG-B7, renderer half)** — markdown-it is configured `{ html: false, linkify: true }`.
      Over an XSS corpus (`<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`,
      `[x](javascript:alert(1))`, `<iframe>`, an HTML comment containing `-->`, a code fence
      containing `</script>`) **and** over a **PR title** and a **Jira comment author** carrying
      `<script>` and an `on*` attribute, the output contains **no** `<script`, **no** `on\w+=`
      attribute and **no** `javascript:` href, and the injected markup is **inert** (escaped text).
- [ ] **RED (R40)** — the verbatim `REVIEW.md` contract sample renders with its table, its four
      severity rows and its links intact (a golden-file test). Its `<a id="fN"></a>` anchors
      render as **text** under `html: false`; the footnote **references** still resolve to in-page
      links, which the tab implements itself — asserted, so the fidelity trade is a tested
      decision rather than a surprise.
- [ ] **RED (R40)** — every non-markdown string (PR title, author, branch, Jira summary, status,
      assignee, comment author, error text) goes through the single `escapeHtml` helper or
      `textContent`; a grep asserts no other `innerHTML =` assignment in `src/webview/`.
- [ ] **RED (R21, R39)** — `parseWebviewMessage` accepts each known shape **including `ready`**
      and returns `null` for an unknown `type`, a missing field, a wrong type and a
      prototype-pollution attempt (`{"__proto__":{}}`).
- [ ] **RED (R54)** — `src/model/panel-protocol.ts`: `HostToPanel = render | patch`,
      `PanelToHost = ready | openItem | openChild | setSort | toggleGroup | command`, and
      `parsePanelMessage` rejects the same four categories of garbage and accepts `ready`.
- [ ] `src/model/escape-html.ts`, `src/model/item-tab-protocol.ts` and
      `src/model/panel-protocol.ts` join `pureSourceFiles()` and
      carry no `vscode` string; **`src/webview/**` does not join that list** and instead gets the
      narrower assertion (no `import`/`require` of the `vscode` module; the two-file `vscode`
      import count is unchanged) — a deliberate, named widening of MG-B1.
- [ ] Commit `feat(vscode): a bundled markdown renderer and two validated webview protocols`.

### Task B3: the Item tab — tier `executor-heavy`

**Depends on:** B1, B2, R19, R22, R38, R39, R42. **Escalated** because it introduces the first
webview in the package and because the worktree swap must stay exactly one folder.

**Files:** create `src/ui/item-tab.ts`, `media/item-tab.css`,
`test/ui/item-tab.test.ts`; modify `src/ui/host.ts` (a narrow `createWebviewPanel` member, in the
same style as every other `Host` member — `host.ts:113-182`), `src/extension.ts` (the **only**
module that reads `media/` off disk — R62), `src/ui/preview.ts`,
`src/ui/wiring.ts`, `test/support/fake-host.ts`, `test/purity.test.ts` (the exact `src/ui/*`
basename list at `:93-107`), `package.json`.

- [ ] **RED (MG-B9)** — opening a second item **reuses** the one panel; disposing it and opening
      again creates one more, never two; switching to an agent whose worktree differs calls
      `planWorkspaceAction` again and `updateWorkspaceFolders` **at most once**; an item with no
      agent calls it **zero** times (R22); the dirty-editor modal still gates a swap (Phase 7 MG-B5,
      unchanged); **switching agents twice records zero `claim`/`release` calls, while opening
      chat records exactly one claim** (R42).
- [ ] **RED (MG-B7, host half)** — the panel is created with `enableScripts: true`,
      **`retainContextWhenHidden: true`** (R39), and `localResourceRoots` naming **only** the
      extension's `media` directory; the HTML's CSP is R38's string **byte-for-byte**
      (`default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'; img-src 'none';
      font-src 'none'`) with a fresh per-render nonce, and **contains no `unsafe-inline` and no
      `cspSource`**. `media/item-tab.js` and `media/item-tab.css` are **read off disk by the host
      and inlined** into `<script nonce>` / `<style nonce>` — nothing is loaded by URI. Mutation
      that must fail: adding the worktree or `sessionsDir` to `localResourceRoots`, or
      reintroducing `unsafe-inline`. **R62**: the tab takes `{ scriptText, styleText }` as
      injected **strings** (the test passes literals), and the `readFile` lives in
      `extension.ts` — so this test **does not require `build:webview` to have run**. A grep
      asserts `src/ui/item-tab.ts` contains no `media/` path and no `readFile`.
- [ ] **RED (R39)** — the webview posts `ready` on load and the host sends the first `render`
      **only** in response; a `render` is never posted before `ready` (the test asserts the
      ordering, which is what stops the blank-first-open race). There is **no**
      `WebviewPanelSerializer`: a window reload closes the tab, stated in the README and SMOKE.md.
- [ ] **RED** — artifact **content** arrives from the host over `postMessage` (fetched with
      `GET /sessions/:id/artifacts/:name`); the webview is never handed a file URI.
- [ ] **RED (R41, R36)** — an `artifact.changed` for a session in `agents[]` sends a `patch` for
      **that one artifact**; an `item.changed` **whose payload `id` matches this item** refetches
      `GET /items/<path>` and re-renders the header and tabs **without refetching the Jira
      detail**; an event for another id is ignored.
- [ ] **RED (R48, the focuses)** — the tab takes a
      `focus: {kind:'agent',sessionId} | {kind:'ticket'} | {kind:'pr',repo,number}`: an agent focus
      selects that agent and renders its artifacts; a ticket focus renders and reveals the Jira
      section; a **PR focus** renders the PR info block (state, `reviewDecision`, per-reviewer
      review summaries, open thread count, CI checks by name, the diff summary) with an "Open on
      GitHub" link. **All three reuse the SAME panel** — opening a ticket child then a PR child
      creates **one** panel in total (MG-B9, extended). An unknown focus falls back to the primary
      agent rather than rendering blank.
- [ ] **RED (R51)** — the button row shows **"Address review comments"** exactly when
      `prs[0].isMine === true && prs[0].isDraft === false`, while **"Start review" stays hidden**
      there (R42, unchanged); a `respond` agent renders in the switcher with its phase, and the
      tab's **Chat button is disabled on a respond agent at `triaging`** and enabled at
      `addressing`/`ready` (R50).
- [ ] Commit `feat(vscode): an item tab rendering the work, its agents, its PR and its ticket`.

### Task B4: the side panel becomes a WebviewView, and the tree goes — tier `executor-heavy`

**Depends on:** B1, B2, B3, **R54**, R23, R24, R31, R41, R42, R43, D6. **Escalated** because it
deletes a shipped code path and replaces the extension's only view with a second security
boundary.

**Files:** create `src/ui/panel-view.ts`, `src/webview/panel.ts`, `media/panel.css`,
`test/ui/panel-view.test.ts`; **delete** `src/ui/tree.ts` and its test; modify
`src/extension.ts` (the SSE consumer — R41; the provider registration),
`src/ui/refresh.ts`, `src/ui/commands.ts`, `src/ui/preview.ts`, `src/ui/wiring.ts`,
`src/ui/host.ts` (a narrow `registerWebviewViewProvider` member **plus R64's
`getState<T>(key)` / `setState(key, value)` pair**, in the same style as every other
`Host` member — `host.ts:113-182`),
`src/model/view-model.ts` (reduced or deleted), `src/model/notify-policy.ts`, `src/core-client.ts`,
`package.json` (`"type": "webview"` on the `cgremlin.items` view; commands + `when` clauses),
`test/support/fake-host.ts`, `test/ui/*`,
`test/view-model.test.ts`, `test/notify-policy.test.ts`, `test/purity.test.ts` (the exact
`src/ui/*` basename list at `:93-107` — `panel-view.ts` in, `tree.ts` out).

- [ ] **RED (MG-B8)** — a source grep over `vscode/src` finds **no** `client.prs(`, **no**
      `markdown.showPreview`, **no** `markdown.preview.refresh`, **no** `cgremlin.refreshPreview`
      and **no `TreeDataProvider`/`createTreeView`** (R54);
      `package.json` no longer contributes that command, and its `cgremlin.items` view carries
      `"type": "webview"`; `buildWorkLists` still returns exactly the four lists.
- [ ] **RED (MG-B7, panel half)** — the view's HTML CSP is R38's string **byte-for-byte**
      (`default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'; img-src 'none';
      font-src 'none'`) with a fresh per-render nonce and **no `unsafe-inline`, no `cspSource`**;
      `localResourceRoots` names **only** `media`; `media/panel.js` and `media/panel.css` are read
      off disk **by `extension.ts` alone** and handed to the provider as
      `{ scriptText, styleText }` (**R62**, so this test needs no bundle); every row string
      (title, author, login, label) goes through
      `escapeHtml` or `textContent`, and a PR title carrying `<script>` and an `on*` attribute
      renders **inert**. Mutation that must fail this: widening `localResourceRoots`, or
      interpolating a title into `innerHTML`.
- [ ] **RED (R54, the handshake)** — the panel posts `ready` on load and the host sends the first
      `render` **only** in response (the same anti-blank-first-open ordering as R39); a re-created
      view re-posts `ready` and gets a fresh render; there is **no** serializer.
- [ ] **RED (R24)** — one refresh issues exactly **one** request, `GET /items` (assert against the
      stub server's `requests` log, `test/support/stub-server.ts:36`); `GET /config` is still issued
      once at connect. Four lists still cost one round trip.
- [ ] **RED (R41)** — `extension.ts:112-114` now **reads the frame payload**: an `item.changed`
      whose `id` matches the open Item tab refetches that item; every other frame still coalesces
      into one `/items` refresh. The comment on those lines is rewritten to say the payload is
      trusted as an **address**, never as content. Nothing branches on the absence of
      `changedFields` into a different correctness path.
- [ ] **RED (R43)** — the status bar finds the **selected agent** inside `agents[]` (keyed by
      `currentSessionId`) and reads `phase`/`running`/`needsYou` off that `WorkItemAgent`,
      **including a `respond` agent**;
      `needYou` counts `WorkItem`s with `needsYou`, not agents; with no agent selected it shows
      connection state and count only. `refresh.ts:136`'s `links.sessionId` lookup is gone.
      Notifications and the status bar are otherwise **unchanged** by R54.
- [ ] **RED (MG-B2, preserved)** — notifications diff `WorkItem[]` keyed by `item.id` on
      `item.needsYou` — the **core's** flag; a grep still finds no `NEEDS_YOU_REASONS` anywhere in
      the extension; `level: 'off'` returns `[]`.
- [ ] **RED (R31)** — the popup's `Open` opens the **Item tab**, not a preview; `Ack` posts
      **exactly one** request, `POST /items/<path>/ack`, and the extension never loops over refs
      itself (a grep finds no `/attention/ack` call in the item path).
- [ ] **RED (R50/R56/R42), named "the respond click records one run start and zero claim
      attempts"** — clicking a lit `waitingForReview` row issues **one**
      `POST …/agents { mode:'respond' }`, records **zero** `claim`/`release` calls, calls
      `planWorkspaceAction` **once** for the PR's worktree, opens **no** terminal, and renders
      the respond agent as **running**; **Chat is offered on a respond agent only once the phase
      is `addressing` or `ready`** (row action and Item tab button alike), and then uses the
      existing chat-terminal path unchanged. Mutation that must fail this: opening chat, or
      claiming, on the click.
- [ ] **RED (R42, R51)** — row commands: Start review (PR items with no review agent, **hidden
      when `prs[0].isMine`**), **Address review comments** (exactly when the PR is mine and
      non-draft), Start investigation/development (with the repo quick-pick when the item
      is ticket-only, R15), Chat (the **selected** agent), Open PR (**one entry per PR** when the
      item has two, R26), Open ticket, Ack. Each `when` clause is pinned by a manifest test, as
      `test/ui/command-wiring.test.ts` already does.
- [ ] Commit `feat(vscode): a webview side panel with four work-item lists replaces the tree`.

### Task B5: rows that look right — expansion, sorts, groups, keyboard — tier `executor`

**Depends on:** B4. Split out of B4 deliberately: B4 is the security boundary and the deletion,
this is the presentation the user actually asked for, and mixing them makes both harder to review.

**Files:** modify `src/webview/panel.ts`, `media/panel.css`, `src/ui/panel-view.ts`,
`test/ui/panel-view.test.ts`, `test/work-items.test.ts`.

- [ ] **RED (R48, MG-15)** — clicking a `myWork` row expands it to its children (from
      `buildItemChildren`, B1) in order, only what exists; clicking a child fires **Info** with the
      right `focus` and its secondary action fires **Go-to** with the right target; expansion
      state is per-row and survives a re-render.
- [ ] **RED (R47)** — the sort control changes the order live and **persists** through
      `globalState` (`cgremlin.sort.<list>`) across a re-created view; the `parkingLot`
      **three** groups render in the fixed order **"Reviewing (N)"** (the
      `parkingLotGroup: 'reviewing'` rows, with agent badges, never collapsed) → untouched →
      collapsible **"someone is on it (N)"** (collapsed by default), and the selected sort
      reorders **within** each group, never across them.
- [ ] **RED (R66, the tree roles)** — the list container is `role="tree"`, each row
      `role="treeitem"` with `aria-level` 1 (row) / 2 (child), `aria-selected` on the focused row
      and `aria-expanded` on every expandable row and on each collapsible group header —
      asserted **in the same test** as R54's key handling, so roles-without-keys and
      keys-without-roles both fail.
- [ ] **RED (R64)** — the sort selection round-trips through `Host.getState`/`setState` against
      an in-memory fake, including the unknown-persisted-value fallback to the list default.
- [ ] **RED (R54, the look and the keyboard)** — every colour in `media/panel.css` comes from a
      `var(--vscode-*)` token (a grep finds **no** hex literal and **no** `rgb(`); rows are
      two-line cards separated by `var(--vscode-panel-border)`; **no codicon font is loaded**
      (a grep finds no `codicon` and no `@font-face`, because `font-src 'none'` would silently
      drop it); expandable rows carry `aria-expanded`, focus is visible, and up/down/left/right/
      Enter navigation is asserted over a simulated key sequence.
- [ ] **RED (MG-12, panel half)** — a row with default (null) age/size renders `—`, not `0`.
- [ ] Commit `feat(vscode): expandable rows, per-list sorts and the collapsed "someone is on it" group`.

### Task B6: packaging the webview assets — tier `executor`

**Depends on:** B2 (the build step), B3, B4.

**Files:** modify `.vscodeignore`, `test/packaging/vsix-contents.test.ts`, `package.json`.

- [ ] **RED (MG-B10)** — the `.vsix` **contains** `media/item-tab.js`, `media/item-tab.css`,
      **`media/panel.js` and `media/panel.css`** (a
      positive assertion beside the existing negative ones at `vsix-contents.test.ts:47-60`) and
      still contains no `node_modules/`, no `src/`, no `.ts`. Because the two `.js` files are
      generated and gitignored (R40, R54), **their presence in the package is the assertion that
      `vscode:prepublish` ran `build:webview` over both entry points** — the test says so in a
      comment, and deleting either file before packaging must fail it.
- [ ] Commit `chore(vscode): ship the item-tab and panel assets in the vsix`.

---

## Convergence (branch `phase9-conv`, on the merged base)

### Task C1: integration extension → real engine with a FakeJira and a faked `gh api graphql` — tier `executor-heavy`

**Depends on:** the merge of `phase9-core` and `phase9-ext`, D7.

**Files:** modify `cgremlin/vscode/test/support/core-harness.ts`,
`cgremlin/vscode/test/integration/real-engine.test.ts`; create
`cgremlin/vscode/test/support/fake-jira/*.json`.

- [ ] Start a `http.Server` on `127.0.0.1:0` serving `/rest/api/3/myself` and
      `/rest/api/3/search` from fixtures, and add a `jira` block to the seeded `core.json`
      (`core-harness.ts:135-161`) with `baseUrl` pointing at it and a throwaway `apiToken`. The file
      is already written mode 0600 (`:160`), which `hasAnySecret` now demands for a Jira token too.
- [ ] Add a **fake `gh api graphql`** responder to the harness's `gh` stub, serving A8's recorded
      `reviewThreads` fixture and **throwing on any argv containing `mutation`** (R52, R55).
- [ ] **RED (R47–R50)** — `GET /items` through the **real bundled engine** returns the **four**
      lists and no `reviewing` key; the seeded
      review session appears as an **agent of** the fixture PR's item in
      **`lists.parkingLot.reviewing`**, not as its own row and **not** in `myWork` (R47/R48,
      coordinator override); the same PR with a seeded investigation instead appears in
      `myWork` too; a fixture ticket whose key is in the seeded review session's branch merges
      into one `pr+ticket` row; a **draft** fixture PR appears in **no** list; a fixture PR with a
      non-bot reviewer comes back `demoted: true` and still listed; a seeded investigation with no
      PR and no ticket is in `investigations` and **not** `myWork`.
- [ ] **RED (R51 + R56, end to end)** — `POST /items/pr/:o/:r/:n/agents { mode: 'respond' }` on
      the harness's **own** PR answers `202` with `started: true`, takes **no claim**, and
      **after the run completes** `BRIEF.md` exists and contains every comment of
      the fixture threads while the session has moved `triaging → addressing`; `run.started` and
      `run.finished` in `harness.stderr()` carry `stage: 'respond'`. The same call on a
      teammate's PR is a **409**; every pre-existing seeded session still loads (MG-13, e2e).
- [ ] **RED (R57, end to end)** — a seeded **merged** teammate PR that still carries a review
      session comes back in `lists.parkingLot.reviewing`, not missing from every list.
- [ ] **RED (R65, end to end)** — the merged `pr+ticket` row is fetchable at
      `/items/pr/<o>/<r>/<n>` even though its `id` is `ticket:<KEY>`.
- [ ] **RED (MG-5, end to end)** — the throwaway token appears in **none** of `GET /config`,
      `GET /items`, `GET /items/…`, the `/events` stream (including `?include=run.output`), the
      engine log (`harness.stderr()`) or `jira.json`.
- [ ] **RED (MG-6, end to end)** — stop the stub, force a scan → `ticketSource.kind ===
      'unavailable'` and the cached tickets are still returned; point the stub at a 401 →
      `kind === 'auth'`; remove the `apiToken` → `kind === 'notConfigured'` and no request.
- [ ] **RED (R34, end to end)** — with the stub hanging, `POST /prs/scan` still answers promptly
      and its body carries the last completed `jira` report; shutting the harness down does not
      leave a half-written `jira.json`.
- [ ] **RED (MG-8, end to end, as amended by R56)** — across the whole suite every
      `run.started` line in `harness.stderr()` is accounted for by an explicit `POST`: the
      respond test's **one** line and nothing else. Every `GET /items` and `GET /items/…`
      contributes **zero** (the harness's existing "no test here starts a stage" claim,
      `core-harness.ts:12-14`, narrowed rather than dropped).
- [ ] Commit `test(vscode): items over the real engine with a stubbed Jira and faked review threads`.

### Task C2: cross-package guards — tier `executor`

- [ ] **MG-4** — one bot predicate: `grep -rn "\[bot\]" cgremlin/core/src cgremlin/vscode/src` hits
      only `core/src/work/bot-login.ts`.
- [ ] **MG-7 / R45** — the pre-Phase-9 inventory fixture still loads, every new field takes its
      default, and `GET /prs` is 200 (asserted in core, re-asserted end to end here).
- [ ] **MG-10** — `grep -rnE "[A-Za-z]Html\b" cgremlin/core/src cgremlin/vscode/src` hits nothing
      in `src/jira`, `src/work`, `src/api` or any `postMessage` payload type (R33).
- [ ] **MG-11** — with `projectKeys: []` no PR links to a ticket and the "linking disabled" line
      is logged once (R46).
- [ ] **MG-B10** — the packaged `.vsix` carries `media/item-tab.js` **and `media/panel.js`**,
      proving `vscode:prepublish` ran the bundler over both entry points, and still carries no
      `node_modules/` (R40, R54).
- [ ] **MG-12** — a `WorkItem` whose PR fields took their R45 defaults renders `—` for age and
      size in the panel and sorts last under `oldest`/`smallestChange`; nothing renders `0 files`.
- [ ] **MG-13** — the committed pre-Phase-9 sessions fixture (v1 and v2, all three old modes)
      loads unchanged with `respond` in the union (R51).
- [ ] **MG-14** — `grep -rn "mutation" cgremlin/core/src` → empty;
      `grep -rnE "gh (pr (comment|review|merge|edit|close|ready)|api .*-X (POST|PATCH|PUT|DELETE))" cgremlin/core/src cgremlin/vscode/src`
      → empty; `renderRespondBrief` carries no reply/resolve/push instruction (R55).
- [ ] **MG-15** — a `myWork` row's children are derived from `agents[]` + `ticket` + `prs[]` and
      nothing else: a fourth agent in the fixture yields a fourth child with no view-model edit.
- [ ] **MG-16** — over a 60-PR fixture, one tick's `gh api graphql` invocations match R52's fetch
      policy, and a second tick with unchanged `updatedAt`s makes **zero**.
- [ ] **MG-9 (R65)** — an item whose `id` is `ticket:HB-627` is reachable at
      `/items/pr/owner/repo/12`, and the body's `id` comes back `ticket:HB-627`.
- [ ] **R63** — `ATTENTION_REASONS` matches its pinned literal element-for-element.
- [ ] **R67** — a `MAX_NODE_LIMIT_EXCEEDED` stderr yields exactly three `gh pr list` calls for
      that repo (the failed one plus two partitioned), never four.
- [ ] **MG-17** — every item lands in at least one of the four lists or is deliberately in none;
      **every teammate PR with a review agent of ours is in `parkingLot.reviewing` exactly once
      and `myWork` never contains a review-only item**; each id in `lists.parkingLot` is in
      exactly one of its three groups and matches that item's `parkingLotGroup`;
      `investigations` never intersects `myWork`; the legal overlaps are
      `waitingForReview` ∩ `myWork` and `parkingLot` ∩ `myWork` (R47–R50); **a merged teammate
      PR with our review agent is still listed and a merged own PR with a respond agent is still
      in `myWork`** (R57); **two teammates' PRs naming one ticket key stay two items** (R61).
- [ ] **MG-A3 / MG-A9 unchanged** — re-run Phase 7's guards: attention still takes no session lock,
      and `pipeline-service.ts`'s header comment is still byte-identical to its fixture.
- [ ] Commit `test: phase 9 mutation guards`.

### Task C3: docs — tier `chore`

- [ ] `cgremlin/core/docs/ARCHITECTURE.md`: a **Work items** section beside **Attention**, saying
      that `src/work/` *groups* attention items and never re-derives them, and naming the **four**
      lists with their membership rules (R47–R50); the `/items` rows in the
      API route table; `item.changed` in the event table; `check-jira` in the CLI table; a **Jira**
      subsection under Environment/Config naming the secret regime and the `jql`/`projectKeys` knobs;
      a **Review threads** subsection naming the GraphQL call, its cache, its fetch policy and
      `reviewThreadsCachePath` (R52); a **Respond mode** entry in the session-mode/phase tables
      with `RESPOND_PHASES`, its transitions and its terminal set (R51);
      an **Add an item source** entry and an **Add a session mode** entry under Extending (the
      latter naming `TERMINAL_PHASES_BY_MODE` as the compile-time gate).
- [ ] `cgremlin/core/README.md`: the `jira` config block with the real documented values
      (`https://aplaceformom.atlassian.net`, `guilherme.azoubel@aplaceformom.com`), the token as the
      one thing to supply, `chmod 600`, `config check-jira`, **`projectKeys` as required for
      linking (R46)**, `scanBudgetMs`, and **how to change the JQL to
      `assignee = currentUser() AND sprint in openSprints()`**. Add `jira.apiToken` to the Secret
      handling section next to `vercel.bypassSecret` (R44). **Next to the `repos` field**, state
      that a PR in a repo outside `repos` is invisible to the panel *even if it requests your
      review* (R30).
- [ ] `cgremlin/core/docs/DECISIONS.md`: a `## 2026-09-10 — Phase 9 (Work items)` section recording
      D1–D8, R1–R24 as confirmed, and R25–R46; **the reversal of the `DECISIONS.md:79-82`
      no-bot-heuristic line and why** (R6); the removal of the markdown-preview path (R23); the
      "no Jira writes, ever" posture; **R40's narrowing of Phase 7 R13** (esbuild + `markdown-it`
      as devDependencies, runtime deps still zero) and the `<a id>`-renders-as-text trade;
      **R46's "no `projectKeys`, no linking"**; and **R39's "a window reload closes the Item tab,
      by design"**. Then the re-scope: **R47's four lists, drafts excluded and "someone is on it"
      as an exclusion signal** (including R47.1, the decided sub-clause that a pending review
      request to somebody else counts); **R47/R48's coordinator override** — a teammate's PR under our review stays in the parking lot
      in a `'reviewing'` group on top and never enters `myWork`, which is what replaced the
      `reviewing` list; **R49's ticket-linked-investigations-go-to-`myWork`**;
      **R51's fourth session mode**, with the note that the v1 union is deliberately not extended;
      **R52's first GraphQL call and its fetch policy** (the cost decision); **R54's replacement of
      the `TreeView`** and the unicode-glyphs-not-codicons consequence of `font-src 'none'`; and
      **R55's "nothing posts to GitHub in v1"**, naming the legacy verbs that are deliberately not
      ported. Then the re-check: **R56's `respond` stage name and the create-and-start click**,
      recorded explicitly against Phase 7 R5/MG-8; **R57's `isDraft !== true` and the
      live-agent totality invariant**; **R58's stable attention timestamps**; **R59/R60/R67's
      lenient `gh pr list` parsing, the user/team `reviewRequests` union and the node-limit
      two-call fallback** (with whatever A2/smoke found for **U6**); **R61's my-items-only ticket
      merge**; **R62's injected webview text**; **R65's path-resolves-to-containing-item**; and
      **R66's ARIA tree roles**.
- [ ] `cgremlin/vscode/README.md` + `docs/SMOKE.md`: the **four** lists and what each is for, the
      parking lot's **three groups** (Reviewing / untouched / someone is on it), its sorts, row expansion and its children, the Item
      tab and its three focuses, the agent switcher, the respond flow and where v1 stops (R55),
      the reload caveat (R39), and the smoke checklist from spec §8 (steps 1–10, including 3a, 3b
      and 6a).
- [ ] Commit `docs: phase 9 — work items`.

---

## Errata (recorded during execution)

Things this plan got wrong, found while executing it. Each is a defect in the PLAN, corrected
here rather than worked around in the code.

### Wrong DoD greps

1. **MG-14, `grep -rn "mutation" cgremlin/core/src` → empty.** It is not empty and must not be:
   `pipeline-service.ts:222` says *"does whatever pre-run mutation the caller used to do
   unlocked"* about session state. The claim R55 actually makes is about the GraphQL **operation
   kind**. The guard implemented in C2 is `\bmutation\s*[({A-Z]` over `core/src` (empty), plus
   "no file that mentions `graphql` at all contains the word `mutation` in any form", which pins
   `src/gh/review-threads.ts` specifically.

2. **MG-14, the mutating-`gh` grep.** It legitimately hits
   `cgremlin/core/src/workspace/permission-guard.ts`, whose entire job is to **deny** `gh pr
   review|comment|merge|close|edit` to the agent, and one comment in `pipeline-service.ts` that
   points at it. C2 excludes the guard file and comment-only lines, and adds the positive
   assertion that the guard really denies each verb (a grep that only says "absent" would pass
   just as well if the deny list were deleted).

3. **MG-10, `grep -rnE "[A-Za-z]Html\b"` over both `src` trees.** Read as "hits nothing" this is
   wrong: `vscode/src/model/escape-html.ts` and `src/webview/*` must carry `escapeHtml`, which is
   how MG-B7 holds. The plan's own wording already scopes it ("nothing in `src/jira`, `src/work`,
   `src/api` or any `postMessage` payload type"); C2 implements the scoped form and separately
   asserts the only owners anywhere are the escaper and its two webview callers.

4. **MG-1's `'reviewing'` grep over `src/work`.** Inverted. R47 **requires** that literal: it is
   the name of the parking lot's first group, which is what replaced the fourth list. C2 asserts
   it is **present**, and that it is typed as a `ParkingLotGroup` and never as a `WorkListKind`.

5. **R41, "`item.changed` appears once in `serve.ts`".** It appears **twice**, like every other
   event — the `events.on('item.changed', …)` subscription and the `logLine` inside it. C2 pins
   the count at two.

### Task A2 recorded no RED

A2 ("the `gh` fixture that closes U1") is a recording task with no behaviour of its own, so it
has no RED step; U1 and U6 are closed by the fixture's *content* being asserted downstream (A1's
parsing tests, and C1's end-to-end `humanActivity` assertions over a bot review carrying
`is_bot`, a bot comment carrying no flag, and a heterogeneous user/team `reviewRequests`).

### Task A0's inputs were supplied by the supervisor

A0 is a gate on user input. The Jira site, email and account id were supplied by the supervisor
from the user's existing `~/.cgremlin-core-smoke/core.json`; `projectKeys` is `[HB, WEB]` and
`botLogins` is `[apfm-sonar, gitstream-cm]`. The **API token was never read by any agent** and is
not in any fixture: every test uses a throwaway token against a local stub, and the real token
stays in the user's own config for the manual smoke pass (SMOKE.md step 9).

### Two defects C1 found in the merged streams

1. **`RespondSessionFactory` could never create a worktree.** It branched with `-b <headRefName>`,
   and the bare mirror already carries `refs/heads/<that branch>` from `clone --bare`, so every
   respond session failed with *"a branch named X already exists"*. Fixed in the core:
   `createWorktree` gained an opt-in `resetBranch` (`-B`), which is also the only way the worktree
   gets the **fetched** head rather than the clone-time snapshot.

2. **`ticketTrouble` was dead code.** R35 asks for a row **and** a status-bar state on
   `ticketSource.kind === 'auth'`; the helper existed and was unit-tested but nothing called it.
   Fixed in the extension, deliberately kept apart from the `/items` trouble: a rejected Jira
   token leaves every PR row where it is and only colours the bar.

### Test infrastructure: `pnpm test` was quietly running the integration suite too (Phase 10)

Not a defect in this plan's guards, but in the test wiring they all sit on top of: `vitest.config.ts`
had one `include` (`test/**/*.test.ts`) with no `exclude`, so `pnpm test` ran
`test/integration/**` — real engines over real Unix sockets — whenever `../core/dist` happened to
already be built, which it usually was in a working tree. That made the "unit" run take minutes
instead of seconds, and put two real-process cases (a real stop's `STOP_BUDGET_MS` poll and a real
restart's SSE reconnect) at risk of tripping their test-level timeout under full-suite parallel
load, despite always passing in isolation. Separately, `test/packaging/vsix-contents.test.ts` read
the `.vsix` straight out of the package directory, racing any concurrently running `pnpm package`.

Fixed by splitting `test/integration/**` into its own `vitest.integration.config.ts` /
`pnpm test:integration` (`pool: 'forks'`, `fileParallelism: false`, plus a `globalSetup` guard that
fails the run if any `engine.js serve` process with a harness temp `stateDir` outlives the suite),
sizing the two load-sensitive cases' timeouts past the real 45 s stop budget with one documented
retry, and having the packaging test snapshot the `.vsix` into a temp copy before reading it. See
`cgremlin/vscode/README.md`'s "Unit vs. integration" section.

### Phase 10 errata — what the panel workshop changed against this spec

Recorded here rather than by editing §5 in place, so the Phase 9 design still reads as what was
actually built and shipped. The workshop's own rulings are in
`docs/superpowers/specs/2026-09-11-cgremlin-phase10-panel-workshop.md` and are summarised in
`cgremlin/core/docs/DECISIONS.md` under *2026-09-11 — Phase 10*. Six things this plan's spec says
are no longer true.

**1. §5's "card rows, two lines each" is now two lines *of cells*, plus a third on `myWork`.**
Line 2 was specified as one dimmed sentence (`@author · opened 12d ago · 7 files +120/−30 · 👤
@jane reviewed`). In a 300 px sidebar that sentence clipped, and what it clipped first was the
activity — the part that decides whether to pick the PR up. It is now an array of typed cells
(`RowMetaCell`) that the view lays out and is allowed to wrap or drop, and a `myWork` row carries a
third "state" line. A new **size tier** cell (`S`/`M`/`L`/`XL`) sits between the age and the raw
size, and the CI signal became a coloured dot with a tooltip rather than an emoji (emoji size
inconsistently in the sidebar).

**2. §5's "children indented under it when expanded (R48)" — the expansion is a different thing.**
The spec expanded a `myWork` row into its parts: each agent, the ticket, each PR. Every row now
expands, and it expands into **three lifecycle slots** (Investigation → Development → Review),
which exist whether or not an agent fills each, plus **"changes so far"**, plus the parts *minus*
the agents (they are the slots and are not listed twice). The reason is that the spec's version
had a shape that changed per row — a list of whichever agents happened to exist — and so could not
be read at a glance; three fixed slots make an absent stage *information*.

**3. Clicking a row was "open the Item tab and swap the worktree". It is now select + expand +
swap, as one message.** The Item tab is still there and still opens, but it is no longer what a
click on the row body does. Expansion is an accordion (at most one row open) and the selection is a
persistent highlight distinct from the keyboard focus ring, both persisted through `globalState`.

**4. §5's button row is gone in favour of one primary button, a forward-only rule and an
overflow.** The spec's row offered `Start review / investigation / development` together. Only the
stage **after the furthest one reached** is now offered — a PR counts as the development stage's
output — and on your own PR the review verb reads *Start self-review* and carries
`selfReview: true`. Everything that is not the one primary verb (open the PR, open the ticket, Ack)
moved behind `⋯`. The rule lives in `model/row-actions.ts` and the lifecycle slots take their Start
button from the row's own actions rather than deriving it again.

**5. R47.1's second demotion clause is reversed.** This plan's A6/A1 tasks implemented
`demoted` as "any human review or comment **or** a pending review request to somebody other than
me". The request half is removed: `someoneIsOnIt` is `humanActivity.lastAt !== null` and nothing
else. Evidence: `gh#2125` sat in the collapsed group for days with a review requested from somebody
who never opened it. The request is still carried and still rendered on the row.

**6. The core grew two things §4 did not describe**, both of which the extension now depends on:
`WorkItemPr.sizeTier` (per-dimension, worse wins) and `GET /sessions/:id/changes`. The spec had no
route for "how big is this session's work right now" because the panel had nowhere to show it; the
expanded row is that place, and the number moves while an agent works, so it could not be a field
on a listing.

Two more changes are outside this spec's scope but land in the same phase and are recorded for the
reader who arrives here from it: the adoption handshake now compares a **build id** as well as a
version, the `core.json` watcher is content-addressed and an automatic restart is spent once per
engine identity (the restart-storm fix); and a dropped event stream must stay down for 8 s before
the extension says "offline".

---

## Risks

| # | Risk | Mitigation | Owner |
|---|---|---|---|
| 1 | **The Jira token silently loads from a world-readable `core.json`** if `hasAnySecret` is missed. | A3's RED case is written *first* and mutation-checked; MG-5 spans C1. | A3 |
| 2 | **A required inventory field 500s `GET /prs`** on the first launch after upgrade. | R9 + MG-7 + a committed pre-Phase-9 fixture. | A1 |
| 3 | **The ticket-key regex links `SHA-256` and `UTF-8`.** | R46: no `projectKeys`, no linking at all, logged once; MG-11 pins it; A0 gets the list from the user. | A0/A1 |
| 4 | **`markdown-it` + esbuild land in the extension package** and something about the bundle is wrong (missing from the `.vsix`, or a runtime dep sneaks in). | R40 wires `build:webview` into **both** `build` and `vscode:prepublish`; MG-B10 asserts the artifact is in the `.vsix`; the existing "no `node_modules/`" assertion keeps runtime deps at zero. | B2/B5 |
| 5 | **Atlassian's `/search` → `/search/jql` migration** breaks the adapter against the real instance while every fixture test passes (U2). | R32: both shapes implemented, separately fixtured, with a once-per-scan 404/410 fallback asserted by request count; smoke step 9 is a real call. | A4 |
| 6 | **A webview XSS via a PR title, a Jira comment or `REVIEW.md`.** | MG-B7 on both halves (`html:false` + `escapeHtml` on every non-markdown string; R38's CSP verbatim with no `unsafe-inline`; `localResourceRoots` = `media` only), plus "content over `postMessage`, never a file URI", plus R33 (no HTML ever reaches the extension). | B2/B3 |
| 7 | **`WorkItemService` reaches for `SessionStore`** and reintroduces lock contention on the UI path. | MG-1 with a wrapped `KeyedLock` + a DoD grep over `src/work`. | A6 |
| 8 | **`GET /items/…` blocks on a slow Jira** and the panel feels hung. | `jira.timeoutMs` + `AbortController` in A4; the route returns `ticket: null` with `ticketError`; R34 keeps the scan leg off the `POST /prs/scan` path entirely and R36's cache keeps repeat opens off the network. | A4/A5/A7 |
| 13 | **The `item.changed` payload fills the 256-frame event ring with whole `WorkItem`s.** | R41's minimal `{ id, kind, changedFields? }`, asserted by a test that the frame carries no `item` key. | A6 |
| 14 | **A tab switch steals or drops a chat claim.** | R42: claims belong to the chat terminal alone; MG-B9 asserts zero claim/release calls on a switch. | B3 |
| 9 | **The parking lot is still long** because `watchAuthors` is broad (U4). | Not a code fix — smoke step 1 turns it into a config finding. | smoke |
| 10 | **`POST …/agents` races the two existing review entry points.** | The **same** `pr:<slug>#<n>` lock key (`server.ts:816`), asserted by MG-8. | A7 |
| 11 | **Deleting `view-model.ts` breaks a test nobody re-ran.** | B4 rewrites `test/view-model.test.ts` in the same commit; both packages must be green per the Global Constraints. | B4 |
| 12 | **The parallel streams disagree about the wire shape.** | B works against a committed `test/support/fixtures/items.json` that C1 then validates against the **real** engine — a mismatch surfaces in C1, not in production. | C1 |
| 15 | **`statusCheckRollup` + `body` + six more fields make every `gh pr list` materially heavier** across N repos × 58 PRs (R53). | Still **one call per repo**; `body` is discarded after extraction (R8); smoke step 1 times a full scan before and after and records the numbers, and a bad result is a tick-interval change, not a redesign. | A1/smoke |
| 16 | **Review-thread GraphQL becomes a per-PR-per-tick call** and burns the rate limit (R52, U5). | R52's fetch policy (my PRs + untouched parking-lot candidates only) plus an `updatedAt`-keyed cache, so a steady state makes **zero** calls; MG-16 asserts both halves; smoke step 6a watches two idle ticks. | A8 |
| 17 | **The `respond` mode is the phase's largest judgment call** and touches the session union, the phase tables, the terminal map, attention and the API. | R51 decides every landing site by name; `TERMINAL_PHASES_BY_MODE` being a `Record<Session['mode'],…>` makes a missed site a **compile error**; MG-13 pins that old sessions still load; A9 is last in the stream and gated on A8's fixture. | A9 |
| 18 | **The respond agent posts to GitHub** because the legacy tool did. | R55 as its own ruling, the out-of-scope line inside the brief, an allowed-tool set with no mutating verb, a `GhRunner` fake that throws, and MG-14's greps. | A8/A9 |
| 19 | **Deleting `src/ui/tree.ts` breaks the panel with no visible error** — a webview that fails to load renders blank rather than throwing. | R54's `ready` handshake (the host renders only on `ready`), MG-B8's manifest assertion that the view is `"type": "webview"`, MG-B10's proof the bundle shipped, and smoke steps 1–3b which are all "look at the panel". | B4 |
| 21 | **`respond` sessions cannot be started at all** because `STAGE_NAMES` has no entry for them — the failure surfaces as a zod error on `POST /sessions/:id/run` and an unwritable `lastRun`. | R56 lands the stage name, `runRespond`, `RESPOND_RUNNABLE_FROM` and the create-and-start route in **one** task (A9), and `pnpm typecheck` plus the amended MG-8 both fail without it. | A9 |
| 22 | **Rows silently vanish** — `isDraft === false` unlists every pre-Phase-9 and agent-only row, and a merged PR takes its live review agent off the panel with it. | R57's `isDraft !== true` plus the live-agent totality invariant, asserted directly by MG-17's two new fixture cases. | A6 |
| 23 | **A notification re-fires on every push** because `approved`/`changes_requested` are timestamped from `updatedAt`. | R58 pins each reason's `at` to a value that only a human moves (`humanActivity.lastAt`, `reviewDecisionAt`), with the named test "a push to an approved, acked PR re-fires nothing". | A1/A6 |
| 24 | **A widened `gh pr list` returns nothing for a repo** — GitHub's GraphQL node limit is a hard error, not a truncation (U6). | R67's detection on `GhCommandError.stderr` plus the two-call partitioned fallback, call-counted in A1's tests and checked against real repos in smoke step 1. | A1/smoke |
| 25 | **The webview unit tests silently depend on the bundler**, so a red test is ambiguous between bad HTML and a missing bundle. | R62 makes script/style injected **text** with the disk read in `extension.ts`; B3/B4 greps assert neither UI module touches `media/`. | B3/B4 |
| 20 | **The four-list model drops an item on the floor** — the `reviewing` list's members had nowhere to go. | The coordinator override keeps them in the parking lot, in a `'reviewing'` group on top, so nothing has to move to `myWork`; **MG-17** asserts totality, the group precedence and the disjointness rules over a fixture covering every branch. | A6 |

## Task table

One branch per parallel agent: **`phase9-core`** (A0–A9), **`phase9-ext`** (B1–B6),
**`phase9-conv`** (C1–C3). There is no B0. Merge order: core, then ext, then conv.

| Task | Stream | Branch | Tier | Depends on | Key guards |
|---|---|---|---|---|---|
| A0 collect token + projectKeys + JQL + a PR with review comments + watchAuthors | A | `phase9-core` | `chore` | — | gate: user inputs only |
| A1 inventory fields (humanActivity, age, size, CI, labels, ticket keys) | A | `phase9-core` | `executor-heavy` | — | MG-3, MG-4, MG-7, MG-11, MG-12 (core half), R47/R53, **R58/R59/R60/R67** |
| A2 gh fixture (U1, U6) | A | `phase9-core` | `executor` | A1 | closes U1 **and U6** |
| A3 config + secret + two derived paths | A | `phase9-core` | `executor-heavy` | A1 | MG-5 (config half), R44, R52 paths |
| A4 Jira port + REST + check-jira | A | `phase9-core` | `executor-heavy` | A3 | read-only grep, MG-10, R32/R37 contract |
| A5 Jira scanner + cache | A | `phase9-core` | `executor-heavy` | A4 | MG-6, R34 lifecycle |
| A6 WorkItem + four-list grouping + service | A | `phase9-core` | `executor-heavy` | A1, A5 | MG-1, MG-2, MG-9, MG-10, MG-17, R27/R28, R47–R50, **R57/R58/R61/R63** |
| A7 /items routes + ticket brief | A | `phase9-core` | `executor-heavy` | A6 | MG-8, MG-9, MG-10, MG-5 (brief half), R31/R36, R47 list names, **R65** |
| A8 review threads (first GraphQL) | A | `phase9-core` | `executor-heavy` | A1, A3, A5 | MG-3 (thread half), MG-14, MG-16, R52, closes U5 |
| A9 respond mode: schema, **stage**, factory, brief, route, **run** | A | `phase9-core` | `executor-heavy` | A7, A8 | MG-13, MG-14, **MG-8 (amended)**, R50/R51/R55, **R56 (BLOCKER)** |
| B1 wire mirror + four lists + sorts + children | B | `phase9-ext` | `executor` | spec | MG-B8 (lists half), MG-B1, MG-12, MG-15, R47/R48, **R65** |
| B2 renderer + build (two entry points) + protocols | B | `phase9-ext` | `executor-heavy` | B1 | MG-B7 (renderer half), R40/R54 build wiring |
| B3 item tab + its three focuses | B | `phase9-ext` | `executor-heavy` | B1, B2 | MG-B9, MG-B7 (CSP half), R38/R39/R42/R48/R51, **R62** |
| B4 WebviewView panel + removals (tree, preview) | B | `phase9-ext` | `executor-heavy` | B1, B2, B3 | MG-B8, MG-B2, MG-B7 (panel half), R41/R43/R54, **R62/R64** |
| B5 expansion, sorts, groups, keyboard, the look | B | `phase9-ext` | `executor` | B4 | MG-12 (panel half), MG-15, R47/R48/R54, **R64/R66** |
| B6 packaging both bundles | B | `phase9-ext` | `executor` | B2, B3, B4 | MG-B10 |
| C1 integration + FakeJira + fake graphql | C | `phase9-conv` | `executor-heavy` | A, B merged | MG-5, MG-6, MG-8 (amended), MG-13 e2e, R34/R47–R51 e2e, **R56/R57/R65 e2e** |
| C2 cross-package guards | C | `phase9-conv` | `executor` | C1 | MG-4, MG-7, MG-9, MG-10, MG-11, MG-12..MG-17, MG-B10, MG-A3, MG-A9, **R63/R67** |
| C3 docs | C | `phase9-conv` | `chore` | C2 | — |
