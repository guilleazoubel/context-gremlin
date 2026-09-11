# cgremlin Phase 9 — Work items: the panel shows my work, not agent sessions: Design

Date: 2026-09-10
Status: **D1–D8 are binding supervisor decisions and are folded in verbatim.
R1–R24 are `CONFIRMED 2026-09-10`, with the amendments R25–R46 folded into their text.
R25–R46 are binding rulings from review rounds #1–#22 and carry the same force as a D.
R47–R55 are binding supervisor rulings from the user's re-scope of 2026-09-10 (§0.1) and
outrank every earlier R and D they touch.**
Where an R contradicts a D, the R says so explicitly and names the evidence. No R is a TBD — every
one has a decided value, and the plan is executable as written.
**Reading order:** where an earlier R and a later R disagree, the later one wins and the earlier
one's text says so inline. The parts of R2, R6, R13, R15, R18, R19, R23, R24, R30, R43 and §4.1
that R47–R55 supersede are marked **SUPERSEDED** in place, with a pointer to the ruling that
replaced them; nothing is silently rewritten.
**Coordinator sign-off, 2026-09-10:** one override was issued and is folded in — *a teammate's PR
carrying a review agent of ours stays in the parking lot, in a "Reviewing" group on top, and never
routes the item into `myWork`* (R47, R48, §4.1 step 4, §4.3, §5, MG-2, MG-17). The following
judgment calls are **CONFIRMED** as written: **R47.1** (a pending review request to somebody else
counts as "someone is on it"); **R50** (a reviewed PR stays in `waitingForReview` and lights up);
**R51**'s respond phase list and transitions; **R52**'s thread fetch policy; **R47**'s
core-default / extension-selected sort split; **R54**'s unicode glyphs instead of codicons; and
**R48**'s PR info as a third *focus* on the single Item tab rather than a second panel.
**Re-check, 2026-09-10:** twelve further rulings, **R56–R67**, are folded in at the end of §3 —
two of them (**R56** the `respond` stage name, **R57** `isDraft !== true` plus the
live-agent totality invariant) were **BLOCKERS** without which the phase does not run. They amend
R4/R14/R15/R19/R25/R26/R28/R30/R38/R47/R50/R51/R53/R54, §4.1, §4.3, §5, MG-8, MG-9, MG-17 and
MG-B7, each with a cross-reference in place.
Parent specs: `2026-09-10-cgremlin-phase7-vscode-ui-v1-design.md` (R18 generic `Item`/`ItemRef`,
§5.2 the descriptor array, **§10.1 the deferred Jira parking lot — Phase 9 *is* §10.1, evolved**),
`2026-09-10-cgremlin-phase8-bundled-engine-design.md` (the bundled engine, the one setting).
Engine grounding: read directly, cited inline as `file:line`.

---

## 0. Why

After real use, the panel showed **58 PRs from every author** in "Parking lot" and a smoke session
under "PRs we are reviewing". The user's verdict: *"not helpful as it is at all."*

The panel is a view of **agent sessions and raw inventory rows**. What the user needs is a view of
**work items**: a PR and its Jira ticket are one row; the agents (review, investigation,
development) attached to that work are a *property* of the row, not the row itself. Concretely, in
the user's words:

- the parking lot should be **my teammates' open PRs**, with an indicator on the ones **no human has
  reviewed yet** (bots do not count) — **SUPERSEDED by R47**: the indicator became an *exclusion*
  signal, and drafts left the list entirely;
- "my dev work" should be **Jira tickets assigned to me** plus **my own unmerged PRs**, merged into
  one row when a ticket and a PR describe the same work — **extended by R48**: my sessions join that
  merge, and the row expands to its parts;
- clicking a row should **open a tab in the editor that renders the files nicely** — the review
  file, the findings file, the dev file, and **the Jira ticket underneath** — and should **move to
  that worktree** and **resume Claude Code on that work's agent**;
- when a work item has **more than one agent** (a review agent, then a dev or investigation agent),
  there should be a way to **switch between them**.

Phase 7's model already anticipated this: R18 made every item generic over a `source`, §5.2 made
the panel a descriptor array, and §10.1 recorded the Jira list as "one more `LIST_ORDER` entry"
with a named join rule. **Phase 9 evolves that model rather than forking it**: `AttentionItem`
stays exactly what it is (the per-*agent* answer to "does this want me"), and a new, thin
`WorkItem` layer groups those answers into the unit a person actually works on.

### 0.1 The user's re-scope (2026-09-10, binding, verbatim)

> "the prs in the parking lot are open prs, not drafts. I am using this to look at all the prs we
> have (parking lot), but expecting it to help me choose the next one to look at. so if anyone else
> is already looking or commenting or has reviewed it, I should go to another one. then I look at
> how long it's been there, and how many file changes it has. so I can help with ones there for a
> long time and also find easy quick ones to knock out. On my dev work I expect to see jiras I am
> assigned to, and PRs I have opened, dev sessions I have that I am working on now, all merged
> together in a row. When we click it, it shows under it what we have for it: an investigation
> session, a dev session, the jira ticket, the PR and its status, and I can click any of those items
> and see info about it or choose to go to that page (a tab in the editor with a nicely rendered md
> file, or the jira ticket content). Investigations are the sessions I only have investigation for.
> PRs waiting for review are my PRs that I have opened for review and I am waiting for a review.
> When I do get a review, I click on it (switches to that repo worktree) and go to Claude (resumed
> to that conversation with all the context it needs from the PR) and I can address the comments.
> The UI is supposed to look really nice, like the Codex chat panel."

Four things follow, and R47–R55 turn each into a ruling:

1. **The parking lot is a *choosing* surface, not an inbox.** Drafts are not choosable (R47). A PR
   somebody else is already on is not choosable — it is *demoted*, not badged (R47). Age and change
   size are the two axes the user sorts on (R47).
2. **"My work" is one row per piece of work that *expands* into its parts** — investigation, dev,
   ticket, PR — each part individually clickable and openable (R48).
3. **Investigations are their own list**, and they are exactly the items whose only agent is an
   investigation (R49).
4. **My open PRs waiting on a reviewer are their own list, and a review arriving is the trigger for
   a fourth kind of agent** — a `respond` session that reads the review threads and helps me address
   them (R50, R51), ported from the legacy own-PR flow (`bin/cgremlin:1028-1071`, `:14743-14822`).
   The panel that shows all four lists stops being a `TreeView` (R54).

## 1. Scope

**In — stream A (core, `cgremlin/core`)**

1. **`WorkItem` model + `WorkItemService`** (`src/work/`) — a pure grouping function over
   `AttentionItem[]` + `Inventory` + a Jira snapshot, plus the **four** list memberships
   (`parkingLot`, `myWork`, `investigations`, `waitingForReview` — **R47**; the three-list wording
   here and everywhere below is superseded, and `reviewing` as a list is gone). No new attention
   derivation; the per-agent `needsYou` is reused and rolled up (D1).
2. **`humanActivity`** on `InventoryEntry` — "somebody who is not a bot and not the author has
   reviewed, commented, or replied in a review thread", computed at scan time from the *unfiltered*
   review/comment/thread data, plus a `botLogins` config knob. This is deliberately **not**
   `teamActivity`, which is a watch-list allow-list (§2, R6). **R47 generalises R6's boolean
   `humanReviewed` into `humanActivity { reviewedBy[], commentedBy[], lastAt }` and turns it from an
   indicator into an exclusion-style grouping signal.**
3. **Ticket keys on inventory rows** — `ticketKeys: string[]`, extracted at scan time from the PR's
   branch name, title and body with `extractTicketKeys`, **filtered by `jira.projectKeys`, which is
   required for linking at all** (R7 as amended by R46). The body itself is **not** persisted (R8).
   `reviewRequests` is persisted beside it (R30).
3a. **The rest of the PR row the panel needs** (R53) — `createdAt` (age), `changedFiles`,
   `additions`, `deletions` (size), `ci` (from the existing `ciStatus()` over
   `statusCheckRollup`), `labels`, and `humanActivity`. All optional-with-a-default (R45), all off
   the **same one `gh pr list` call per repo** that runs today.
3b. **Review threads** (R52) — a first GraphQL call in the engine
   (`gh api graphql`, `pullRequest.reviewThreads`), cached per PR in the state dir. It feeds both
   the respond brief (R50) and the thread half of `humanActivity`.
4. **`JiraSource` port + `JiraRestSource` adapter + `JiraScanner`** — Atlassian Cloud REST v3, Basic
   auth from `core.json`, an injectable base URL, a `<stateDir>/jira.json` cache, and degradation to
   "ticket source unavailable" (never an empty list that looks like "no tickets") (D3).
5. **`cgremlin-core config check-jira`** — one `GET /rest/api/3/myself` call that prints the
   display name + accountId or Jira's own error, so a bad token is diagnosed before the first
   scan. The legacy tool did exactly this (`bin/cgremlin:1894-1901`).
6. **Secret handling for `jira.apiToken`**, identical to `vercel.bypassSecret`: `hasAnySecret`,
   the 0600 load refusal, `redactCoreConfig`, and never in a brief, a log line, an event frame or an
   HTTP response (D3, R11).
7. **Routes** `GET /items`, `GET /items/ticket/:key`, `GET /items/pr/:owner/:repo/:number`,
   `GET /items/session/:id` (R25), `POST /items/{…}/agents { mode, repoUrl? }` — **`mode` now
   includes `'respond'` (R51)** — and `POST /items/{…}/ack` (R31); event `item.changed` (D4,
   amended by R14 on addressing and by R41 on the payload).
8. **Ticket context in the brief** — a `## Ticket` section rendered by a pure function in
   `src/pipeline/prompts.ts`, gated on "was anything actually fetched", exactly like
   `renderEnvironmentSection`'s R14 gate (`src/pipeline/prompts.ts:52-79`).
8a. **A fourth `SessionMode`, `respond`** (R51) — the own-PR "address the review comments" agent
   ported from the legacy flow: its own phase list and transitions, its own terminal phases, its
   own attention reasons, a `RespondSessionFactory`, and `renderRespondBrief` (R50) carrying every
   review thread, the review decisions, CI, the diff summary and the ticket.

**In — stream B (extension, `cgremlin/vscode`)**

9. **Four** lists from `GET /items` — `parkingLot`, `myWork`, `investigations`,
   `waitingForReview` (R47) — with agent badges, age/size columns, CI dots, the collapsible
   "someone is on it" group, and per-list user-selectable sorts persisted in extension state.
9a. **The side panel becomes a `WebviewView`** (R54): rich two-line card rows, badges, expansion,
   sort controls, keyboard navigation, theme-aware, under the same CSP as the Item tab (R38).
   `src/ui/tree.ts` and the `TreeView` contribution are removed.
9b. **Row expansion** (R48): a `myWork` row expands to its children — Investigation, Development,
   Ticket, PR — each individually clickable, with **Info** (a tab) and **Go to** (worktree +
   Claude, or the browser) actions.
10. An **Item tab**: a webview panel in the editor area rendering the item header, an agent switcher,
   that agent's artifacts (newest first) and the Jira ticket, live-updating on `artifact.changed`
   and `item.changed`. **R48 adds two more focuses to the same single panel** — a ticket focus and
   a PR-info focus — so a child click never opens a second panel (MG-B9 is unchanged).
11. Buttons: Chat, Start review / investigation / development / **respond**, Open PR, Open ticket,
    Ack.
12. Selecting an item (or switching agent) swaps the single managed worktree folder to the
    **selected agent's** worktree — R15 of Phase 7 is untouched.
13. Removal of the repo-wide PR lists, of the markdown-preview open path (D5, D6) and of the
    `TreeView` (R54).

**Out (and nothing here may preclude it)**

- Any Jira **write** (D3: "No Jira writes ever"). No transitions, no comments, no assignment.
- Slack (Phase 7 §10.2).
- A per-item chat pane; Chat is still a terminal (Phase 7 R4).
- More than one worktree folder at a time (Phase 7 R15).
- **Posting anything to GitHub, anywhere in v1** (`docs/DECISIONS.md:81-85`, restated as **R55**).
  Named explicitly because the respond flow makes the temptation concrete: the legacy verbs
  `--reply-comment`, `--resolve-comment` and `--push-fix` (`bin/cgremlin:1010-1013`) are **out of
  scope**, are not ported, and the respond agent's allowed-tool set must not contain a mutating
  `gh` verb. **v1 ends at "the fix is committed locally".** Replying and resolving on GitHub is a
  v2 poster component (§9).
- Server-side filtering of `/events`.

---

## 2. Verified Ground Truth (2026-09-10, planner grounding pass)

Everything below was read in this tree at `9b5797c`.

**The join key already exists — no session-schema change is needed.**
- `LineageSchema` is `{ pipelineId, parentSessionId, ticket: string|null }` on **every** session
  (`cgremlin/core/src/schema/session.ts:15-19`), v1 and v2 alike.
- Investigations and development sessions set it from the create request, validated by the same
  regex in two places (`cgremlin/core/src/api/validation.ts:54`, `:72`).
- Review sessions derive it from the head branch: `ticket: extractTicketKey(mapped.headRefName)`
  (`cgremlin/core/src/pipeline/review-session-factory.ts:90`), where `extractTicketKey` is
  `/\b([A-Z][A-Z0-9]+-\d+)\b/` (`cgremlin/core/src/gh/ticket-key.ts:1-6`) — **already exactly the
  regex D1 specifies**.
- `linkPrToSource` already joins a review to a dev/investigation session by PR *then* by
  `lineage.ticket` (`cgremlin/core/src/discovery/link-pr-to-source.ts:31-38`).
- `ItemLinks.ticket` is already carried out over the API
  (`cgremlin/core/src/attention/attention-service.ts:208`, mirrored at
  `cgremlin/vscode/src/model/items.ts:53`).

**"Team activity" is an allow-list and therefore cannot answer "has any human reviewed this".**
- `buildTeamActivity` filters both `reviews` and `comments` through
  `watchSet.has(loginLower)` (`cgremlin/core/src/inventory/inventory.ts:60-80`), so a review by a
  human who is not in `watchAuthors` is invisible.
- That is deliberate and recorded: *"Team activity counts any review or conversation comment from a
  watched-authors login that isn't `me` — bots are excluded by construction (the watch list is an
  allowlist, not a denylist heuristic on `is_bot`)"* (`cgremlin/core/docs/DECISIONS.md:79-82`).
  Phase 9's `humanActivity` (R6 as superseded by R47) **is** that denylist heuristic, for a
  different question. Reversing a
  recorded decision is a `DECISIONS.md` entry, not a silent edit (R6).

**Bot detection has a real gap in the data we fetch today.**
- `PrListItemSchema.author` carries an optional `is_bot`
  (`cgremlin/core/src/gh/pr-view.ts:19-23`), but review and comment authors are parsed by
  `ActivityAuthorSchema = z.object({ login: z.string() })` (`:35`) — **no `is_bot`, no
  `__typename`**. The review/comment schemas are `.passthrough()` (`:37-52`), so the field may be
  arriving in the JSON and being discarded, but nothing in this repo proves it does.
- `PR_INVENTORY_FIELDS = PR_LIST_FIELDS + ',latestReviews,reviews,comments'`
  (`cgremlin/core/src/gh/pr-view.ts:5-6`) — and `PR_LIST_FIELDS` carries `headRefName` but **not
  `body`**. Linking by PR body therefore needs a new `gh` field.

**The inventory document is schema-validated on both write and read.**
- `InventoryStore.save` runs `InventorySchema.parse` (`inventory-store.ts:26-27`) and `load` runs it
  again, **throwing `InventoryCorruptError`** on a mismatch (`:46-52`).
- `GET /prs` reads through `loadCurrentInventory` (`src/api/server.ts:113-115`) with no catch, so a
  schema break becomes a 500 on that route; `PrSourceAdapter.collect` is luckier — `AttentionService`
  swallows an adapter throw and contributes nothing (`attention-service.ts:383-389`).
- Therefore **every field Phase 9 adds to `InventoryEntrySchema` must be
  optional-with-a-default**, or the first load after an upgrade breaks `/prs` (R9).

**Config, secrets and derived paths are each owned by exactly one function.**
- `hasAnySecret` looks only at `environments[*].vercel.bypassSecret`
  (`src/config/core-config.ts:122-124`) and is what triggers the 0600 mode refusal (`:171-178`).
- `redactCoreConfig` replaces only that same field (`:127-135`).
- A derived path must be registered **twice** — `resolveCoreConfig`'s `expandOrDerive`
  (`:104-118`) and `DERIVED_PATH_SUFFIXES` (`:264-274`); registering one is the documented failure
  mode (`cgremlin/core/docs/ARCHITECTURE.md:528-534`).
- `GET /config` returns `redactCoreConfig(deps.config)` (`src/api/server.ts:598-605`).

**The discovery tick and its report.**
- `InventoryScanner.run()` reconciles, then loops `config.repos` calling
  `gh pr list --json PR_INVENTORY_FIELDS`, saves, and emits `inventory.updated`
  (`src/inventory/inventory-scanner.ts:40-99`). A per-repo failure falls back to the previous
  scan's entries for that repo (`:72-78`).
- `DiscoveryScheduler<R>` is generic over the tick's report type and exposes `runNow`, `waitForIdle`,
  `lastError`, `skippedBeats` (`src/discovery/scheduler.ts:17-113`).
- `POST /prs/scan` returns the whole `ScanReport` verbatim (`src/api/server.ts:779-783`);
  `Engine.scheduler` is typed `DiscoveryScheduler<ScanReport>`
  (`src/host/build-engine.ts:50`, `:207`).
- `serve()` calls `scheduler.start()` then `attention.start()` (`src/host/serve.ts:323-326`).

**Attention already computes everything Phase 9 needs per agent, without locks.**
- `AttentionService.list({all:true})` returns `AttentionItem[]` carrying `mode`, `stageStatus`,
  `running`, `claimed`, `attention.needsYou` and `links.primaryArtifact`
  (`src/attention/attention-service.ts:399-412`, `:65-76`, `:174-212`).
- It takes **zero session locks** by design and by guard (MG-A3;
  `attention-service.ts:141-146`, `:608-612` prose in the Phase 7 spec).
- It already **dedupes** a PR row against the session that covers it (`:596-620`), merging *only*
  `prRepo`/`prNumber`/`prUrl` into the session item and **dropping the PR item** — which is a
  smaller, lossier version of exactly the grouping Phase 9 generalises. The dropped PR item carries
  `humanActivity`, `isDraft`, `reviewDecision` and its own `attention`, all of which a `WorkItem`
  needs, so **Phase 9 consumes the pre-dedupe list** (R27), not the deduped one.
- `AttentionService.list` today takes only `{ all?: boolean }` (`:399`), and `dedupe()` is a
  module-private function called unconditionally inside it (`:596`).
- `pickPrimaryArtifact` (`src/api/artifacts.ts:34-56`) ranks `REVIEW.md`/`RE-REVIEW.md`/`BRIEF.md`
  for reviews and mtime-ranks `PLAN.md`/`DEVELOPMENT.md`/`FINDINGS.md` otherwise. The readable
  allow-list is the single regex at `src/api/validation.ts:101-102`.

**Events, and how a new one must be registered.**
- `EngineEventMap` plus `ENGINE_EVENT_TYPES` — *"A new event must be added here too, or `/events`
  silently never carries it"* (`src/engine/events.ts:7-41`).
- `serve()` logs one JSON line per event and must gain a case for a new one
  (`src/host/serve.ts:229-251`).
- **Every emitted frame is buffered**: `EVENT_RING_CAPACITY = 256`
  (`src/api/event-stream.ts:5`), and `MAX_PENDING_FRAMES = 256` per connection (`:7`). A payload of
  `{ item: WorkItem }` would put 256 whole work items — each with its PRs, ticket, agents and
  reasons — in that ring. Hence R41's minimal payload.
- **The extension ignores frame payloads today**: `sse.on('frame', () => coordinator.schedule())`
  (`cgremlin/vscode/src/extension.ts:112-114`), with the comment *"the extension never trusts a
  frame's payload to be the whole truth"*. R41 is a deliberate, named change to that line.

**Extension state that Phase 9 re-points.**
- The status bar's "current" row is found by `item.links.sessionId === this.currentSessionId` over
  the `/attention` snapshot (`cgremlin/vscode/src/ui/refresh.ts:136`). With `/attention` gone from
  the refresh path (R24) that lookup has no snapshot to search — R43 names its replacement.
- A **claim is taken and released by the chat terminal alone**: `ChatSessions.open` calls
  `client.claim(sessionId)`, starts a TTL/3 heartbeat, and releases on terminal close
  (`cgremlin/vscode/src/ui/terminal.ts`). Nothing else in the extension claims. R42 keeps it that
  way.

**Brief composition, and the precedent for a conditional section.**
- `renderEnvironmentSection` returns `''` when nothing is set, and every caller does
  `const block = section ? '\n\n' + section : ''` (`src/pipeline/prompts.ts:52-79`, used at
  `:255-256`, `:341-342`, `:372`). That is the exact gate a `## Ticket` section must copy.
- The three composition sites are `pipeline-service.ts:421` (findings), `:599` (develop),
  `:637` (review); each already passes `session.lineage.ticket`.
- The findings brief today only *tells the agent to fetch the ticket itself* via Atlassian MCP
  (`prompts.ts:246-248`, `:261-262`) — Phase 9 can hand it the content instead.

**Extension facts the panel change lands on.**
- `LIST_ORDER` is the four-descriptor array and each `build` reads `groups` + `items` + `sessions`
  (`cgremlin/vscode/src/model/view-model.ts:117-160`); `ListKind` and `ListItem` are at
  `src/model/items.ts:238-248`.
- `RefreshCoordinator.refreshNow()` fetches `/prs`, `/sessions`, `/attention?all=1` on **every**
  refresh (`src/ui/refresh.ts:84-113`).
- Open item = `markdown.showPreview` on `<sessionsDir>/<id>/<primary>` plus the worktree swap
  (`src/ui/preview.ts:63-80`, `:82-134`); `cgremlin.refreshPreview` runs
  `markdown.preview.refresh` (`src/ui/commands.ts:148-150`).
- `planWorkspaceAction` is pure and returns `noop | swap | offer-open-managed`
  (`src/model/workspace-file.ts:28-48`) — Phase 9 reuses it byte-for-byte.
- MG-B1 is two assertions the phase must extend on purpose: `pureSourceFiles()` is a **plain
  `includes('vscode')`** check, prose included (`test/purity.test.ts:15-33`), and `src/ui/*` is
  pinned by an **exact basename list** (`:93-107`).
- The extension has **zero runtime dependencies** and builds with `tsc` (Phase 7 R13); the packaged
  `.vsix` may contain no `node_modules/`, no `src/`, no `.ts`
  (`test/packaging/vsix-contents.test.ts:47-60`).
- The core already carries `esbuild` as a **devDependency** and bundles two artifacts into
  `cgremlin/vscode/engine/` (`cgremlin/core/package.json` `build:engine`).

**The Jira target, and the scheme the legacy tool already used (supervisor-supplied, 2026-09-10).**
- Site: **`https://aplaceformom.atlassian.net`** (Atlassian Cloud; cloudId
  `326247b9-ab3e-4a1e-b7c8-80655ee39cf5`). User: **`guilherme.azoubel@aplaceformom.com`**,
  accountId `712020:f0acd024-8d3a-4b87-9d4b-768ee3eb3f74`. **The API token is the one input the
  user must still supply**; everything else is a documented default.
- The legacy bash tool already used **exactly** this credential scheme, which is why D3's choice is
  a port rather than a new integration:
  - credentials live in `~/.config/cgremlin/jira.conf` as `JIRA_DOMAIN`/`JIRA_EMAIL`/`JIRA_API_TOKEN`,
    written `chmod 600` (`bin/cgremlin:1819-1836`);
  - the credential check is `curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN" https://$JIRA_DOMAIN/rest/api/3/myself`,
    accepted when the body has an `accountId` (`bin/cgremlin:1894-1901`);
  - ticket content is
    `/rest/api/3/issue/<key>?fields=summary,description,issuetype,status,priority,labels,assignee,reporter,acceptance_criteria,customfield_10016,attachment,comment`
    (`bin/cgremlin:1930-1932`).
- **There is no `~/.config/cgremlin/jira.conf` on this machine** (checked 2026-09-10: the
  `~/.config/cgremlin` directory does not exist). So there is **nothing to import** and Phase 9
  adds no `config import-legacy-jira` — the same posture Phase 8 took for the state dir
  (`docs/DECISIONS.md:248-252`, U3 "no legacy import — start fresh").

**The re-scope's new ground (read 2026-09-10, this tree).**
- **`SessionMode` is a three-value zod enum** (`src/schema/session-mode.ts:3`) and `SessionSchema`
  is a **`z.discriminatedUnion('mode', …)`** over three `V2Base.extend` variants
  (`src/schema/session.ts:57-76`), with a parallel v1 union kept so old documents still parse
  (`:29-33`). Adding a fourth variant is therefore **additive and migration-safe** — an existing
  session document still matches its own branch (R51).
- **Phase lists and transitions live in `src/schema/pipeline.ts`** (`INVESTIGATION_PHASES`,
  `DEVELOPMENT_PHASES`, `REVIEW_PHASES` at `:3`, `:13`, `:22`, with `PhaseFor<M>` at `:32-36` and a
  `Record<Phase, readonly Phase[]>` transition table per mode from `:38`), and terminal phases in
  **one** place: `TERMINAL_PHASES_BY_MODE: Record<Session['mode'], ReadonlySet<string>>`
  (`src/workspace/workspace-in-use.ts:4-8`), read by eight modules (`pipeline-service.ts:157`,
  `attention-service.ts:123`, `link-pr-to-source.ts:15`, `reconciliation.ts:92`/`:174`/`:192`/`:219`,
  `inventory.ts:86`, `server.ts:182`/`:742`). Because that map is a `Record` over `Session['mode']`,
  a fourth mode is a **compile error until it is filled in** — which is the property R51 relies on.
- **Attention derivation branches on mode in exactly two places**: `deriveSessionReasons`
  (`src/attention/attention.ts:118` for `investigation`/`plan_ready`, `:142` for `review`/`ready`).
  Everything else is mode-agnostic. `derivePrReasons` (`:160-165`) is the one inventory-only
  deriver: **my own PR only**, firing `changes_requested` when `reviewDecision ===
  'CHANGES_REQUESTED'` **or** `teamActivity.length > 0` — i.e. today it is watch-list-filtered and
  has no notion of "a review arrived" or "it was approved" (R50 adds both).
- **`ReviewSessionFactory` refuses my own PR before it creates anything**: `refuseAuthor` is
  compared against the already-fetched `mapPrView` author and throws `OwnPrError` *before*
  `createWorkspace` (`src/pipeline/review-session-factory.ts:63-72`), so a refusal leaves no
  worktree and no session. `RespondSessionFactory` is the mirror of that check (R51).
- **`ciStatus(checks): CiStatus` already exists and is reusable verbatim**
  (`src/gh/pr-view.ts:123-142`), but `statusCheckRollup` is fetched only by `PR_VIEW_FIELDS`
  (`:8-9`), never by `PR_INVENTORY_FIELDS` (`:6`). R53 adds it to the list query; no new CI logic
  is written.
- **`PR_LIST_FIELDS` today is
  `number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt`**
  (`:4-5`) — no `createdAt`, no `changedFiles`, no `additions`/`deletions`, no `labels`, no
  `reviewRequests`, no `body`. `PR_INVENTORY_FIELDS` is that string plus
  `latestReviews,reviews,comments` (`:6`).
- **`STAGE_NAMES` is three contracts in one file**: `['findings','plan','develop','review','rereview']`
  (`src/schema/stage.ts:3`) backs `StageNameSchema`, which validates `POST /sessions/:id/run`
  (`src/api/validation.ts:85-91`), types `LastRunSchema.stage` (`stage.ts:12`) on every persisted
  session, and types the `run.started`/`run.finished` payloads (`src/engine/events.ts:10`, `:12`).
  Every `run*` method on `PipelineService` funnels through `runStageLocked(id, <stage>, brief,
  prompt, cb)` (`pipeline-service.ts:201`, used at `:424`, `:473`, `:606`, `:655`, `:776`) with
  the phase re-checked on a **fresh** load inside the lock, and `runDevelop`
  (`:587-618`) is the smallest example. `REVIEW_RUNNABLE_FROM` (`:647`) and
  `REREVIEW_RUNNABLE_FROM` (`:764`) are the precedent for a per-mode runnable-phase list. R56
  lands `respond` in all of it.
- **The engine has no GraphQL client at all** — a grep over `cgremlin/core/src` finds no
  `graphql` and no `reviewThreads`. `GhRunner` is a two-line port,
  `run(args: string[]): Promise<{stdout, stderr}>` (`src/gh/gh-runner.ts:1-3`), so a GraphQL call is
  `gh api graphql …` through the same port and the same fake (R52, U5).
- **The side panel is a `TreeView` today**: the manifest contributes one view,
  `{ id: 'cgremlin.items', name: 'Attention' }` under the `cgremlin` activity-bar container, with
  no `"type"` key, and `src/ui/tree.ts` implements it. R54 replaces that contribution with
  `"type": "webview"` and a `WebviewViewProvider`.
- **The extension has zero runtime dependencies and no bundler today**: `build` is
  `pnpm --dir ../core build:engine && tsc -p tsconfig.json`, `vscode:prepublish` is `pnpm build`,
  and `devDependencies` are eslint/typescript/vitest/vsce/types only. R40 already adds esbuild +
  `markdown-it` as devDependencies; R54's `media/panel.js` reuses that same build step.

**UNVERIFIED, and how each is closed**
- **U1 — whether `gh pr list --json reviews,comments` emits `is_bot` (or `__typename`) on a
  review/comment author.** Not provable from this repo (`ActivityAuthorSchema` discards it). Closed
  by Task A2: widen the schema with `is_bot: z.boolean().optional()` and record a real
  `gh pr list` sample as a fixture; the login-suffix rule is the fallback either way (R5).
- **U2 — Atlassian Cloud REST v3 specifics.** From knowledge, not from this machine:
  `GET /rest/api/3/search?jql=…&fields=…&startAt=&maxResults=` (paginated, `maxResults` capped
  server-side, typically 50–100); `GET /rest/api/3/issue/{key}?expand=renderedFields` returns
  `renderedFields.description` as **HTML** while `fields.description` is **ADF JSON**; auth is
  `Authorization: Basic base64(email:apiToken)`; 401 = bad credentials, 403 = no permission /
  captcha challenge (`X-Seraph-LoginReason`), 429 carries `Retry-After`. Atlassian has been
  migrating `/search` to `/search/jql`, whose pagination is a `nextPageToken` + `isLast` cursor
  rather than `startAt`/`total` — **both shapes are implemented and fixtured (R32)**. **All of this is closed by
  a contract test against recorded fixtures plus one manual call by the user (§7), never by a live
  call in CI** (D7). The legacy `/myself` and `/rest/api/3/issue/<key>?fields=…` calls above are
  *verified as what the bash tool sent*, not as what the API returns today — the response shapes are
  still U2. **`customfield_10016` is almost certainly story points but is unverified**, and Phase 9
  therefore requests it only behind an optional `jira.extraFields: string[]` and never depends on it.
- **U3 — CLOSED by R40.** The renderer is a **bundled `markdown-it`** with `html: false`, built by
  esbuild into `media/item-tab.js`. There is no spike and no hand-written subset renderer anywhere
  in this phase; any surviving mention of one is a stale edit.
- **U4 — how many of the user's 58 PRs survive the `watchAuthors` filter.** Unknown without the
  user's `core.json`. If `watchAuthors` is broad, the parking lot stays long — but under R47 the
  drafts are gone and the "someone is on it" rows are demoted into a collapsed group, so the
  *untouched* count, not the total, is what matters. Closed by the smoke pass (§8 step 1), not by
  code.
- **U5 — the GraphQL shape of `pullRequest.reviewThreads`, and what a `gh api graphql` invocation
  costs per PR.** The engine has never made a GraphQL call (verified above), so nothing in this
  repo pins the response shape, the pagination cursor, or the rate-limit cost. Closed the same way
  U2 is: a **recorded fixture** plus a contract test against a fake `GhRunner` (never a live call
  in CI), and one manual `gh api graphql` by the user in the smoke pass (§8 step 6a). The legacy
  tool's query is the starting point and is **verified as what the bash tool sent**, not as what
  GitHub returns today: `reviewThreads(first:100){ id isResolved comments(first:1){ author.login
  path line body } }` (`bin/cgremlin:14776-14787`). R50 widens `comments(first:1)` to
  `comments(first:100)` on purpose — the legacy brief had to reconcile replies by hand precisely
  because of that truncation. The **cost** question is what R52's fetch policy answers, and the
  policy is measured in smoke step 6a before the tick interval is trusted.
- **U6 — what `gh pr list --json statusCheckRollup,reviewRequests` actually emits, and whether the
  widened field set trips GitHub's GraphQL node limit.** `ciStatus` branches on `__typename`
  (`pr-view.ts:131`) because the rollup is a `CheckRun`/`StatusContext` union, and
  `reviewRequests` mixes users and teams — but both are only *verified* for `gh pr view`, never
  for `gh pr list`. Closed by **A2's recorded `gh pr list` sample** (the same manual run that
  closes U1) plus smoke step 1 against the user's real repos. Until then **R59** makes the rollup
  parse leniently (`.catch([])` → `ci: 'none'`), **R60** fixes the review-request union, and
  **R67** defines the node-limit fallback and the stderr strings that detect it — so every
  unverified branch degrades rather than throwing.

---

## 3. Rulings

Every ruling below is **binding**. R1–R24 were `CONFIRMED 2026-09-10` together with the amendments
R25–R46, which are interleaved into the sections they belong to and cross-referenced from the R
they amend.

### The model

**R1 — `WorkItem` is a *grouping* over `AttentionItem`, not a second derivation.**
`WorkItemService.list()` calls `AttentionService.list({ all: true, dedupe: false })` (R27),
`InventoryStore.load()` and `JiraStore.load()`, and groups. It never reads a session, an `AGENT_STATE` file or an artifact
mtime itself. Rationale: `deriveSessionReasons`/`evaluateAttention` is the one place the "does this
want me" rule lives (Phase 7 R22, `docs/ARCHITECTURE.md:256-286`); a second reader of session state
would be a second copy of that rule, and it would also be a second thing that could take a session
lock. Consequence: `WorkItemService` inherits MG-A3 for free, and the grouping half
(`groupWorkItems(...)`) is a **pure function** with no I/O, testable by table.

**R2 — the shape.** In `src/work/work-item.ts` (pure):

**R2 is amended by R47 (four lists), R53 (the new PR fields) and R51 (the fourth mode). The
`WorkListKind` union and the `WorkItemPr`/`WorkItemAgent` shapes below are the amended ones; the
literal `'reviewing'` list is SUPERSEDED and gone.**

```ts
// R25: 'session' is a real kind — an agent with neither a PR nor a ticket.
export type WorkItemKind = 'pr' | 'ticket' | 'pr+ticket' | 'session';
// R47: four lists. 'reviewing' is SUPERSEDED as a LIST — a PR with a review agent of ours stays
// in `parkingLot`, in its `'reviewing'` group (see `parkingLotGroup` below), and never lands in
// `myWork` (coordinator override, 2026-09-10).
export type WorkListKind = 'parkingLot' | 'myWork' | 'investigations' | 'waitingForReview';

/**
 * R25: only `repo`, `number` and `url` are guaranteed. Everything else is nullable, because a
 * merged or closed PR that still has a live agent leaves the open-PR inventory while its work item
 * must survive — the agent, not the inventory row, keeps the item alive.
 */
export interface WorkItemPr {
  repo: string; number: number; url: string;
  title: string | null; author: string | null;
  branch: string | null;            // headRefName; null for a pre-Phase-9 inventory row (R9/R45)
  isDraft: boolean | null; isMine: boolean | null;
  reviewDecision: '' | 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED' | null;
  /**
   * R47, SUPERSEDING R6's boolean `humanReviewed` + `reviewers`: who is already on this PR.
   * `reviewedBy`/`commentedBy` are the distinct non-bot, non-author logins; `lastAt` is the
   * newest of their timestamps, or null when nobody is on it. `humanReviewed` as a field name no
   * longer exists anywhere — `humanActivity.lastAt !== null` is the same answer.
   */
  humanActivity: { reviewedBy: string[]; commentedBy: string[]; lastAt: string | null } | null;
  reviewRequests: string[] | null;  // R30: logins/teams GitHub has requested a review from
  teamActivity: TeamActivity[] | null;  // unchanged, still the watch-list view
  updatedAt: string | null;
  // ---- R53: the fields the re-scope's rows are made of ----
  createdAt: string | null;         // "opened 12d ago" — age is measured from HERE, not updatedAt
  changedFiles: number | null; additions: number | null; deletions: number | null;
  ci: 'success' | 'pending' | 'failure' | 'none' | null;   // from the existing ciStatus()
  labels: string[] | null;
}
export interface WorkItemTicket {
  key: string; summary: string; status: string; statusCategory: string;
  url: string; assignee: string | null; updatedAt: string;
}
export interface WorkItemAgent {
  sessionId: string; mode: SessionMode;   // R51: 'review'|'investigation'|'development'|'respond'
  phase: string; running: boolean; needsYou: boolean; claimed: boolean;
  primaryArtifact: string | null; worktreePath: string | null;
  ref: ItemRef;                     // the AttentionItem it came from — the ack key stays the ref
}
export interface WorkItem {
  id: WorkItemId;                   // see R14, R25
  kind: WorkItemKind;
  lists: WorkListKind[];            // computed by the core (D2); the extension does not re-derive
  /**
   * R47: "somebody is already on this PR" — true when any of `prs` satisfies `someoneIsOnIt`.
   * Computed by the core so the panel does not re-derive the rule (D2).
   */
  demoted: boolean;
  /**
   * R47 (coordinator override): which of the parking lot's THREE ordered groups this row is in.
   * `null` when the item is not in `parkingLot`. Derived, in this precedence:
   * `agents.some(a => a.mode === 'review')` -> 'reviewing'; else `demoted` -> 'someoneOnIt';
   * else 'untouched'. The core owns the rule; the panel only renders the groups.
   */
  parkingLotGroup: 'reviewing' | 'untouched' | 'someoneOnIt' | null;
  title: string;                    // R13
  /** R26: a ticket with two PRs is ONE item with two PRs. Empty for a ticket-only or session item. */
  prs: WorkItemPr[];
  ticket: WorkItemTicket | null;
  agents: WorkItemAgent[];          // ordered: review, respond, investigation, development, then by phase age
  needsYou: boolean;                // agents.some(a => a.needsYou) || any pr-level attention reason
  attention: { reasons: AttentionReason[]; since: string; acked: boolean; refs: ItemRef[] };
}
```

**R26 — `prs` is a list, and it replaces the singular `pr`.** A Jira ticket routinely carries a
stacked pair (an API PR and a web PR), and two rows for one ticket is exactly the failure Phase 9
exists to fix. `prs` is ordered **most-recently-updated first**; the **primary PR** is `prs[0]`.
Wherever an earlier ruling in this document says `pr.…`, read `prs[0].…`, and wherever it says
`pr !== null`, read `prs.length > 0`. Membership clauses that quantify over PRs say so explicitly
in §4.1. Test coverage is required for the two-PR case specifically: one row, both PRs on it, the
title from the ticket (R13), `needsYou` rolled up from **either** PR, and the ack fan-out (R31)
covering **both** PR refs.

`attention` on the item is the **union** of its agents' reasons (plus each PR item's own, from the
`source: 'pr'` `AttentionItem`s the pre-dedupe list preserves — R27), ordered by
`ATTENTION_REASONS` with no sort — the same ordering discipline `evaluateAttention` uses
(`src/attention/attention.ts:80-89`). `attention.refs` is the **contributing refs**: every agent's
ref plus every PR ref, which is what R31's server-side ack fan-out iterates.

**R27 — `AttentionService.list` gains `{ dedupe?: boolean }`, defaulting to `true`.**
`WorkItemService` passes `dedupe: false` and gets the **pre-dedupe** items: both the session item
and the PR item for a PR under review. Rationale: `dedupe()` drops the PR item and keeps only three
of its link fields (`attention-service.ts:596-620`), so a deduped list cannot tell a work item
whether the PR is a draft, who requested review, or whether a human has reviewed it. The
alternative — re-reading the inventory row and re-evaluating its attention inside `src/work/` —
would be **a second copy of the attention rule**, which R1 exists to forbid. `/attention` and every
existing caller keep the deduped default byte-for-byte; the new parameter is additive and its
default is asserted by a test.

**R3 — acknowledgement stays keyed by `ItemRef`, not by `WorkItemId`.** A work item is a *view*
that can change shape between two ticks (a PR appears and a ticket row becomes a `pr+ticket` row);
an ack keyed to that view would silently un-ack. So `POST /attention/ack { ref }` is unchanged and
`AttentionService.ack` stays the one ack path. `WorkItem.attention.acked` is `true` only when
*every* ref in `attention.refs` is acked. Rationale: R10/§4.2 of Phase 7 fixed the ack key as the
`ItemRef` (`src/attention/item-ref.ts:12-21`) and `AttentionService.ack` is the one path
(`attention-service.ts:415-431`).

**R31 — the *client* posts one request: `POST /items/<path>/ack`, and the core fans out.**
Amends R3's client half. The route iterates `item.attention.refs` — **every agent ref and every PR
ref** — calling `AttentionService.ack(ref)` for each, and returns the re-read `WorkItem`. Rationale:
an extension that loops over refs is an extension that re-derives which refs an item contributes,
which is a second copy of the grouping rule, and a partial failure halfway through the loop leaves
an item half-acked with nothing to report it. Server-side the fan-out is one handler with one
outcome: any per-ref failure is collected and the response is `{ item, acked: ItemRef[],
failed: Array<{ ref, error }> }` with status 200 when at least one ref acked and 502 when none did.
An unknown ref is skipped, not an error — a ref can vanish between the read and the ack.

**R4 — linking a PR to a ticket.** A PR row carries `ticketKeys: string[]`, extracted at scan time
by running `extractTicketKey`-style matching over, in order, `headRefName`, `title`, `body`, and
keeping **every** distinct match, filtered to `jira.projectKeys` (**required** — R46).
`extractTicketKey` returns only the *first* match (`src/gh/ticket-key.ts:3-6`), so Phase 9 adds
`extractTicketKeys(text, projectKeys): string[]` **beside** it and leaves the existing single-match
function untouched (it is load-bearing at `review-session-factory.ts:90`). A PR with several keys
links to the **first** one in that precedence order; the rest are carried for display.

**R46 — ticket linking requires `jira.projectKeys`; without it, linking is off.** Amends R4 and R7.
When `jira.projectKeys` is absent or empty, `extractTicketKeys` returns `[]`, no PR is ever merged
into a ticket candidate, and the engine logs **once per process** (not per PR, not per scan):
`ticket linking disabled: set jira.projectKeys in core.json`. Rationale: the empty-means-no-filter
default of R7 shipped a regex that links `SHA-256`, `UTF-8`, `HTTP-2` and `PR-123` to imaginary
Jira tickets, and a wrong merge is worse than no merge — it puts two unrelated PRs on one row.
Guard **MG-11**: with `projectKeys: []`, a PR titled `bump to SHA-256 / UTF-8 (PR-123)` produces
`ticketKeys: []` and stays its own item; with `projectKeys: ['HB']` the same PR still produces
`[]`, and `HB-627` in the branch produces `['HB-627']`.

**R29 — `body` is an explicit optional field on the schemas, and the join filters `lineage.ticket`
too.** `PrListItemSchema` and `PrInventoryItemSchema` gain `body: z.string().optional()` **named in
Task A1's Interfaces list**, rather than relying on `.passthrough()` to carry it: `PrListItemSchema`
is *not* passthrough (`pr-view.ts:14-29`), so an unnamed `body` is silently stripped before
`buildEntries` ever sees it and `ticketKeys` would quietly never match a body reference.
The **join asymmetry, stated**: a PR's `ticketKeys` are filtered by `projectKeys` **at scan time**
and persisted already-filtered; a session's `lineage.ticket` is written **unfiltered** by
`extractTicketKey` at session-creation time (`review-session-factory.ts:90`,
`validation.ts:54`/`:72`) and may predate the config. `groupWorkItems` therefore filters
`lineage.ticket` through `projectKeys` **again, at group time**, and ignores it when it does not
pass. Consequence to keep in mind: an old session created from a `SHA-256` branch keeps that
`lineage.ticket` on disk forever; Phase 9 does not rewrite sessions, it just declines to join on it.

**R5 — bot detection, in this precedence.** A login is a bot when: (a) the parsed author carries
`is_bot === true`; else (b) the login ends in `[bot]` (case-insensitive); else (c) the login is in
`jira`-unrelated config `botLogins: string[]`, default
`['github-actions', 'dependabot', 'renovate', 'codecov', 'vercel', 'sonarcloud', 'coderabbitai', 'copilot-pull-request-reviewer']`.
It is one exported pure predicate, `isBotLogin(login, opts)`, used everywhere — there is no second
copy (this is what MG-4 pins). (a) depends on U1; (b) and (c) hold regardless.

**R6 — the signal is computed at scan time and stored, and it is a deliberate reversal of the
`DECISIONS.md:79-82` "no `is_bot` heuristic" line.** Computed in `buildEntries` from the raw,
**unfiltered** `item.reviews` and `item.comments`, counting any entry whose author is neither a bot
(R5) nor the PR author. `me` is **not** excluded — if I reviewed a teammate's PR, a human is on it.
`teamActivity` and `groupInventory` keep their current semantics untouched. Stored rather than
recomputed because the review/comment arrays are not persisted in `inventory.json` and re-fetching
them per request would be a `gh` call per PR. **The reversal of `DECISIONS.md:79-82` stands and is
still recorded in `DECISIONS.md`, not silently.**

**SUPERSEDED, in two parts, by R47:** (a) the *shape* — the boolean `humanReviewed` and the flat
`reviewers[]` become `humanActivity { reviewedBy[], commentedBy[], lastAt }`, and review-thread
comments (R52) count alongside reviews and conversation comments; (b) the *use* — it is not an
indicator on a row that stays in the parking lot, it is what demotes the row into the collapsed
"someone is on it" group. Everything else in R6 — scan-time computation, the unfiltered arrays,
the bot predicate, the author exclusion, `me` counting as a human — is unchanged.

**R7 — `jira.projectKeys` is config, and it is what stops the regex from being a menace.**
`/\b[A-Z][A-Z0-9]+-\d+\b/` matches `UTF-8`, `HTTP-2`, `SHA-256`, `PR-123`. With
`projectKeys: ['HB','GRAC']` only those prefixes link. **Amended by R46: the default `[]` no longer
means "no filtering", it means "linking is disabled".** The README says so next to the field.

**R8 — the PR body is fetched but never persisted.** `PR_INVENTORY_FIELDS` gains `body`; the scan
extracts `ticketKeys` from it and throws the body away. A 58-PR inventory with full bodies would
grow `inventory.json` by megabytes, and the body is not otherwise read anywhere. `PR_LIST_FIELDS`
(used by the plain list) is **not** changed.

**R9 — every new `InventoryEntry` field is optional-with-a-default in the zod schema.**
`branch: z.string().nullable().default(null)`, `ticketKeys: z.array(z.string()).default([])`,
`reviewRequests: z.array(z.string()).default([])` (R30), and, **per R47/R53** (superseding this
ruling's original `humanReviewed`/`reviewers` pair):
`humanActivity: z.object({ reviewedBy: z.array(z.string()).default([]), commentedBy: z.array(z.string()).default([]), lastAt: z.string().nullable().default(null) }).default({ reviewedBy: [], commentedBy: [], lastAt: null })`,
`createdAt: z.string().nullable().default(null)`,
`changedFiles: z.number().int().nullable().default(null)`,
`additions: z.number().int().nullable().default(null)`,
`deletions: z.number().int().nullable().default(null)`,
`ci: z.enum(['success','pending','failure','none']).default('none')`,
`labels: z.array(z.string()).default([])`,
`reviewDecisionAt: z.string().nullable().default(null)` (**R58** — the timestamp
`approved`/`changes_requested` are pinned to).
The rule is the rule, not the list: **any** field Phase 9 adds is optional-with-a-default.
Evidence: `InventoryStore.load` throws `InventoryCorruptError` on a schema mismatch
(`inventory-store.ts:46-52`) and `GET /prs` has no catch around it (`server.ts:113-115`,
`:771-777`). A required field would 500 `/prs` on the first launch after an upgrade, until the next
scan. **This one is not really a judgment call — it is a correctness requirement — but it is listed
so the executor cannot "simplify" it away.**

**R45 — R9 restated as binding, with the guard named.** *Every* field Phase 9 adds to
`InventoryEntrySchema` — the eleven now named in R9 and anything an executor adds later in the
phase — is optional with a default. **MG-7** loads a committed pre-Phase-9 `inventory.json` fixture
(one that has none of them) through `InventoryStore.load`, asserts every new field took its
default, and asserts `GET /prs` answers 200 on that state. A row that took the defaults is a row
with no age and no size: the panel renders those cells as `—`, never as `0 files` or `opened
today`, and MG-12 pins that.

**R30 — the parking-lot rules, in full.** Amends §4.1's membership clause:
- ~~**Draft PRs are listed**, with a `draft` marker, and they **never** carry the no-human-review
  badge.~~ **SUPERSEDED IN FULL BY R47: a draft PR is never listed in any list, and the `draft`
  marker on a parking-lot row no longer exists.** The user's words are "the prs in the parking lot
  are open prs, not drafts". The original rationale (a draft is not waiting on a human) argues for
  exclusion at least as well as it argued for a marker. **My own** drafts are also excluded from
  `waitingForReview` for the same reason (R50); they still appear in `myWork`, which is a view of
  *my* work rather than a queue of things waiting on somebody.
- **A PR whose `reviewRequests` include me is in the parking lot regardless of author** — including
  a PR by someone outside `watchAuthors`, and including one where GitHub requested review from a
  team I am in (the login list is matched case-insensitively against `config.me`; a team slug is
  carried and displayed but only matches when it equals `me`). GitHub asking me for a review is the
  strongest possible "this wants you" signal and outranks the watch list. `reviewRequests` is
  therefore fetched (`PR_INVENTORY_FIELDS` gains `reviewRequests`) and persisted as an optional
  field with a `[]` default (R45).
- **A PR in a repo outside `config.repos` is invisible** — it is never scanned, so it cannot appear
  in any list, *even if it requests my review*. This is an accepted limitation of Phase 9, not a
  bug: making it work means a repo-less `gh search prs --review-requested=@me`, which is a
  different data source with a different rate-limit profile. It is documented in the README **next
  to the `repos` field**, in those words.

### Jira

**R10 — the port, and where the base URL lives.**

```ts
// src/jira/jira-source.ts (port)
export interface JiraIssueSummary {
  key: string; summary: string; status: string; statusCategory: string;
  assignee: string | null; updated: string;
  /** R37: always built from `jira.siteUrl`, NEVER from `baseUrl`. */
  url: string;
}
export interface JiraIssueDetail extends JiraIssueSummary {
  /** R33: plain text only. There is no `descriptionHtml` on this port. */
  descriptionText: string | null;
  comments: Array<{ author: string; at: string; bodyText: string | null }>;
}
export interface JiraSource {
  search(jql: string, opts?: { maxResults?: number }): Promise<JiraIssueSummary[]>;
  issue(key: string): Promise<JiraIssueDetail>;
  whoami(): Promise<{ accountId: string; emailAddress?: string; displayName: string }>;
}
```

`JiraRestSource` takes `{ baseUrl, email, apiToken, fetch?, now? }`. **`baseUrl` is injectable**
(D7): `jira.baseUrl` in `core.json`, defaulting to `jira.siteUrl`, so a test harness points it at a
local stub server. `fetch` is `globalThis.fetch` by default (Node ≥ 20 — `engines.node` is
`">=20"`), injected in tests. The port carries a third method, **`whoami(): Promise<{ accountId, emailAddress, displayName }>`**,
backed by `GET /rest/api/3/myself` — the *same* credential check the legacy tool used
(`bin/cgremlin:1894-1901`). It is the one call `cgremlin-core config check-jira` makes, and it is
also how the scanner learns **its own accountId**, which is what `myWork`'s
`ticket.assignee === jira.me` clause compares against (a display name would be ambiguous and an
email is not always exposed by Jira's privacy settings).

**R33 — no HTML crosses the port, the API or `postMessage`; the core flattens it.** Amends R10 and
R18. The adapter fetches `expand=renderedFields` (Jira's own ADF→HTML rendering, which is far
better than anything we would write), then **strips tags and decodes entities** into
`descriptionText` and each comment's `bodyText`. The flattener is one pure module,
`src/jira/html-to-text.ts`, with a **fixture table** covering: paragraphs and `<br>` → newlines;
`<ul>/<ol>/<li>` → `- ` / `1. ` lines; `<pre><code>` → a fenced block; `<a href>` → `text (href)`;
`<img>` → `[image: alt]`; `&amp;`/`&lt;`/`&#39;`/`&nbsp;` decoded (including a double-encoded
`&amp;lt;` decoding exactly once); tags inside a code block **not** treated as markup; an
unterminated tag not eating the rest of the document.
**No ADF walker.** Walking Atlassian Document Format means implementing a spec that adds node types
on Atlassian's schedule; `renderedFields` is Atlassian doing that work for us, and text is all a
brief and a webview paragraph need.
**MG-10** — a source grep finds **no identifier matching `/Html$/`** in `src/jira`, `src/work`,
`src/api` or the extension's `postMessage` payload types, and a `GET /items/...` response body for
a ticket whose description contains `<b>bold</b>` contains neither `<b>` nor `descriptionHtml`.

**R37 — three details the adapter gets wrong by default.**
- **`url` comes from `siteUrl`, never `baseUrl`.** `baseUrl` is injectable so tests can point at
  `http://127.0.0.1:<port>` (R10, D7); if the browse URL were derived from it, every ticket chip in
  a test — and behind a proxy, in production — would link to the stub. `JiraRestSource` takes both
  and uses `${siteUrl}/browse/${key}` for `url`. Asserted by a test that sets them to different
  values.
- **`JiraScanReport` includes `me`** — the `accountId` from `whoami()`, resolved once per scan.
  `myWork`'s `ticket.assignee === jira.me` clause has nothing to compare against otherwise, and the
  grouping function is pure so it cannot go and ask.
- **Comments come from the comment endpoint, newest first**:
  `GET /rest/api/3/issue/{key}/comment?orderBy=-created&maxResults=5&expand=renderedBody`. The
  `comment` field on the issue fetch returns the **oldest** comments and a total, which is the
  opposite of what the brief and the tab want. Fixtured as its own recorded response.

**R11 — `jira.apiToken` inherits the entire bypass-secret regime.** `hasAnySecret` gains
`|| cfg.jira?.apiToken !== undefined` (`core-config.ts:122-124`); `redactCoreConfig` gains one line
(`:127-135`). No `redactJiraTokens(text)` free-text scrubber is added: unlike a bypass secret, the
token is never suggested to an agent, never appears in a URL and never reaches a brief — the brief
carries *ticket content*, fetched by the engine, never a credential (R18). MG-5 pins that.

**R44 — the secret regime, enumerated so none of it is optional.** `hasAnySecret` returns true when
`jira.apiToken` is a non-empty string, which is what makes the **0600 refusal** apply to a
`core.json` that holds a Jira token and no Vercel secret (`core-config.ts:122-124`, `:171-178`) —
a token-bearing config is **refused to load** unless mode 0600, with a message naming the file.
`redactCoreConfig` replaces `jira.apiToken` with `'[redacted]'`. The token appears in **none** of:
`GET /config`, `GET /items`, `GET /items/…`, any `/events` frame, any brief the pipeline writes,
the engine log, or `<stateDir>/jira.json`. MG-5 asserts all seven.

**R32 — pagination, both shapes, and one fallback per scan.**
- **`/rest/api/3/search/jql`** (the current endpoint) pages by **`nextPageToken`**, stopping when
  `isLast === true` or the token is absent. It has no `total`; the adapter must not invent one.
- **`/rest/api/3/search`** (the legacy fallback) pages by `startAt`/`maxResults`, stopping at
  `total`, and reads the **response's** `maxResults`, never the requested value (Jira caps it
  server-side).
- Each shape gets its **own** recorded fixtures — two pages plus a terminal page — and its own
  test. A fixture from one shape must not be reused for the other; that is how a broken cursor
  passes CI.
- The fallback trigger is a **404 or 410** on `/search/jql`, and it flips a per-scan flag: the
  adapter falls back **once per scan, not once per page**, so a two-page result cannot issue four
  requests and cannot interleave the two cursor schemes. The flag is not persisted across scans —
  a re-migrated instance recovers on the next tick. Asserted by counting requests against the stub.

**R12 — the scan is a second `Tickable`, composed into the existing tick, and its failure is
reported, not thrown.** `ScanReport` gains `jira: JiraScanReport` where
`JiraScanReport = { scannedAt, me: string | null, issues: JiraIssueSummary[], error: string | null, kind: TicketSourceKind }`
(`me` per R37, `kind` per R35).
`InventoryScanner` gains an optional `jira?: { run(): Promise<JiraScanReport> }` dep and calls it
**after `inventory.updated` is emitted** (R34), in its own try/catch, cached to
`<stateDir>/jira.json`. Rationale for folding
it in rather than adding a second scheduler: `Engine.scheduler` is `DiscoveryScheduler<ScanReport>`
and `POST /prs/scan` returns that report (`build-engine.ts:50`, `server.ts:779-783`) — a second
scheduler would mean a second `runNow`, a second `lastError` and a second thing `serve()` must
start and stop. Rationale for the cache: an unreachable Jira must degrade to *stale tickets plus a
banner*, never to an empty `myWork` list that reads as "you have no work".

**R34 — the Jira leg runs after the PR half is published, on its own budget, and never blocks
`POST /prs/scan`.** Amends R12's ordering.
- `InventoryScanner.run()` saves the inventory and emits `inventory.updated` **first**
  (`inventory-scanner.ts:94-98`, unchanged), and only then touches Jira.
- The leg is **not awaited by `run()`**. `ScanReport.jira` carries the **last completed**
  `JiraScanReport` — from `jira.json` on a cold start — so `POST /prs/scan` answers at PR speed
  even against a Jira that is timing out. When the leg finishes it writes `jira.json` and the
  resulting `item.changed` deltas reach the panel the normal way.
- The leg is **single-flight**: a tick that starts while one is in flight does not start a second.
- It has its own **total** budget, `jira.scanBudgetMs`, default **20000** — one `AbortController`
  spanning the whole leg (whoami + every page), not per request, so a paginated search against a
  slow instance cannot add `timeoutMs` per page indefinitely. Expiry is an `error`, never a throw.
- `stop()` awaits the in-flight leg, so a shutdown does not leave a half-written cache — the
  existing `waitForIdle` discipline (`src/discovery/scheduler.ts:17-113`) extends to it.
Rationale: with the leg inline, a Jira that hangs for `timeoutMs × pages` also stalls the PR
inventory, the panel's only fresh data, and stalls a user-initiated rescan behind a system nobody
asked about.

**R35 — `ticketSource.kind` is a four-value union, not two booleans.** Amends R12's last line.

```ts
type TicketSourceKind = 'notConfigured' | 'auth' | 'unavailable' | 'ok';
```

- **`notConfigured`** — no `jira` block, **or** a block whose `apiToken` is absent or empty. Those
  are the same state to a user ("I haven't set this up"), and treating a token-less block as
  configured produces a permanent red banner for someone who is mid-setup. Surfaced as nothing at
  all in the panel.
- **`auth`** — a `JiraAuthError` (401/403). The user must act, and the message says how, naming the
  command verbatim: *"Jira rejected the credentials. Run `cgremlin-core config check-jira` to see
  Jira's own message."* The extension surfaces this **the same way it surfaces engine trouble** — a
  row in the panel **and** the status bar — not as a quiet list footnote, because a silently stale
  `myWork` is exactly the failure the user reported.
- **`unavailable`** — a timeout, a 5xx, a 429 that survived its retry, a malformed body. Stale
  cached tickets are shown with a "ticket source unavailable" banner. No action demanded.
- **`ok`**.
`configured` as a boolean is gone; `kind !== 'notConfigured'` is the same answer where anything
needed it.

**R36 — ticket detail is fetched on tab open and cached with a 60 s TTL keyed on `updated`.**
Amends §4.3's "on demand". `GET /items/<path>` returns the detail from `JiraStore`'s detail cache
when the entry is younger than **60 s** *and* the ticket's `updated` in the current scan snapshot
matches the one the entry was fetched at; otherwise it fetches and stores. So: opening the same tab
twice in a minute is one network call; a ticket edited in Jira between two scans invalidates
immediately rather than waiting out the TTL. **`item.changed` does not refetch the detail** — a
work item changes for many reasons (an agent's phase, a PR update) and refetching the ticket on
each would turn one busy pipeline into a Jira rate-limit incident. The tab re-renders from the
cached detail; the user gets fresh ticket text by reopening the tab.

**R13 — the row label.** A ticket, with or without PRs → `<KEY> — <ticket.summary>`, falling back
to `<KEY>` alone when the summary is empty or was never fetched (R28). PRs and no ticket →
`<repo>#<n> — <prs[0].title>`, and `<repo>#<n>` alone when the title is null (R25); a second PR
adds a chip, never a second title. No ticket and no PR (`kind: 'session'`, R25) → the session's
title. Preferring the ticket summary is deliberate: it is the description of the *work*, and the
PR title is often a restatement of the branch name.
**R47 adds one case:** a `parkingLot` row is always `<repo>#<n> — <prs[0].title>` even when the PR
carries a ticket key, because in that list the user is choosing between *PRs to read*, and the
`repo#n` is how they are named everywhere else (`gh`, the browser tab, the terminal). The ticket
key is still shown, as a chip. Every other list keeps R13 as written.

### API

**R14 — item addressing is segmented, not an opaque id in a path. This amends D4.**
`GET /items/ticket/:key`, `GET /items/pr/:owner/:repo/:number`, `GET /items/session/:id` (R25),
and the same three shapes for `POST …/agents` and `POST …/ack` (R31). Evidence: `handleRequest` routes by splitting `url.pathname` on `/`
(`src/api/server.ts:501-502`) and never decodes a segment. A `pr:owner/repo#12` id in the path
would need `%2F`/`%23` and a `decodeURIComponent` that no other route performs — a new class of
bug in the one function every route goes through. The **body** of every item still carries an
opaque `id` string (`ticket:HB-627` / `pr:owner/repo#12` / `session:<id>`, same grammar as
`ItemRef`) so the extension keys, diffs and de-dupes on one value; only the *path* is segmented.
`parseWorkItemId` and `workItemIdOf` are exported so the **three** forms can never drift.

**R25 — `'session'` is a fourth `WorkItemKind`, with its own id form and its own path.** Amends R2
and R14. An `AttentionItem` that matches no PR and no ticket — an investigation started from a
stack trace, a development session on a branch with no ticket key, a review whose PR has since been
merged — becomes a work item with `kind: 'session'`, `id: session:<sessionId>`, addressed at
`/items/session/:id`. Without it, §4.1 step 3's "its own `WorkItem`" had no id grammar and no route,
so the one row a user cannot reach any other way (there is no PR chip and no ticket chip to click)
would be unopenable. The id is stable for the session's life, and `:id` is validated by the
existing session-id regex (`src/api/validation.ts:54`) before it is used as a path component.
**A merged or closed PR with a live agent keeps its item**: the PR leaves the open-PR inventory but
the agent's `links.prRepo`/`prNumber`/`prUrl` remain, so the item stays `kind: 'pr'` with a
`WorkItemPr` whose every other field is `null` (R25's nullability half). It does **not** silently
turn into a `session` item and change its id under the user.

**R28 — identity follows the *link*, not the Jira snapshot.** Amends §4.1 step 1. A **ticket
candidate is seeded from any evidence of the link**: a PR's `ticketKeys[0]`, or a session's
`lineage.ticket` (filtered per R29), **even when the JQL snapshot contains no such issue**. The
candidate then carries `ticket: { key, summary: '', … }` — key only — and the tab fills the rest
**on demand** (R36), which is how a ticket the JQL never returned still renders.
Consequence, and the reason this is a ruling: **an item's id never flips because Jira is down, or
because a ticket left the JQL.** If ticket candidates were seeded only from the snapshot, an item
would be `ticket:HB-627` while the ticket is in the sprint and `pr:owner/repo#12` the moment it is
closed or the network fails — the ack would un-ack (R3), the open tab would point at a dead route,
and the notification diff would fire on every ticket for a scan. Required test, by name:
**"ticket leaves the JQL → id unchanged"** — group once with the issue in the snapshot, once
without, and assert the same `id` and the same list membership from the PR/agent evidence alone
(only `ticket.summary`/`status` degrade). A second test does the same for `kind: 'unavailable'`.

**R15 — `POST …/agents { mode, repoUrl?, intent?, driveToCompletion? }` composes existing routes
and starts exactly one run.**
- `mode: 'review'` requires the item to have a PR; the handler delegates to the existing
  `handleReviewStart` path (`server.ts:157-208`) under the **same** `pr:<slug>#<n>` lock key
  (`:816`) so it cannot race `POST /prs/…/review` or `POST /reviews`.
- `mode: 'investigation' | 'development'` requires a repo. When the item has a PR, `repoUrl` is
  derived from `pr.repo`; when it is a ticket-only row, the request **must** carry `repoUrl` (400
  otherwise, with a message naming the field) — a Jira ticket does not know which repo it belongs
  to, and guessing would create a worktree in the wrong place. It then calls
  `pipeline.createInvestigationSession` / `createDevelopmentSession` with
  `ticket: item.ticket?.key ?? null` and issues one explicit `POST`-equivalent run, exactly as the
  extension's Phase 7 creation flow does (`vscode/src/ui/commands.ts:244-266`) — **the run is
  explicit, never implicit** (Phase 7 R5, MG-A11).
- **`mode: 'respond'` (R51)** requires the item to have a PR **authored by me**; the handler
  delegates to `RespondSessionFactory` under the **same** `pr:<slug>#<n>` lock key as the review
  path, so a respond start cannot race a review start on the same PR. It is a **409** on somebody
  else's PR (the mirror of `OwnPrError`, named `NotMyPrError`) and a **400** on an item with no PR.
  A second `POST` for a PR that already has a live respond session returns that session with
  `created: false` rather than making a second one.
- The ticket key must satisfy `/^[A-Za-z0-9._-]+$/` (`src/api/validation.ts:54`) before it becomes
  a session id component; a Jira key always does, but the validation is not skipped.

**R16 — `item.changed` is a new `EngineEventMap` key and must be registered in three places.**
`EngineEventMap`, `ENGINE_EVENT_TYPES` (`src/engine/events.ts:7-41` — its own comment says a new
event added to only the first is silently never carried by `/events`), and `serve()`'s log
subscription list (`src/host/serve.ts:229-251`). Payload per **R41**. `WorkItemService`
subscribes to `attention.changed` and `inventory.updated` and re-emits at item granularity, with the
same "emit only on a real delta" discipline `AttentionService` uses
(`attention-service.ts:557-562`).

**R41 — the payload is minimal, and the extension's SSE consumer changes on purpose.** Amends R16.

```ts
'item.changed': { id: WorkItemId; kind: WorkItemKind; changedFields?: string[] }
```

Two reasons the payload is not the whole item. First, **`EVENT_RING_CAPACITY = 256`**
(`src/api/event-stream.ts:5`) and `MAX_PENDING_FRAMES = 256` per connection: 256 buffered
`WorkItem`s — each with its PRs, its ticket, its agents and its reasons — is a resident-memory
cost paid for frames nobody will read. Second, a frame is a *hint*: the extension refetches
`GET /items` (or `GET /items/<path>` for an open tab) and renders from that, so two engines'
answers can never disagree.
**The named change:** `cgremlin/vscode/src/extension.ts:112-114` today is
`sse.on('frame', () => ready.coordinator.schedule())` with the comment *"the extension never trusts
a frame's payload to be the whole truth"*. Phase 9 makes the consumer **read the payload** — but
only its `id`, to decide *what* to refetch (the open Item tab refetches only when the id matches;
everything else still coalesces into one `/items` refresh). The comment is rewritten to say exactly
that: the payload is trusted as an *address*, never as content. `changedFields` is advisory,
present for logging and for a future narrow patch, and nothing may branch on its **absence** into a
different correctness path.

**R17 — `GET /attention` and `GET /prs` both stay.** D4 says `/attention` stays for compatibility;
`/prs` additionally backs `cgremlin-core prs` (`src/cli/commands/prs.ts`), which is the CLI the
smoke checklist compares the panel against. D6's "remove repo-wide PR lists" is a **panel** change,
not a route removal. Nothing is deleted from the core in Phase 9.

### Briefs

**R18 — ticket content reaches the agent as *text*, in a gated `## Ticket` section, and only for a
session started from a ticket.** `renderTicketSection(ctx: TicketBriefContext): string` returns
`''` when nothing was fetched — the exact shape of `renderEnvironmentSection`
(`src/pipeline/prompts.ts:52-79`) and its callers' `const block = section ? … : ''` idiom
(`:255-256`). It renders the key, summary, status, a plain-text description and up to **5** most
recent comments, each truncated to 2000 characters, with a total cap of 12000 characters. The
existing "fetch it yourself via getJiraIssue" instruction (`prompts.ts:246-248`) stays as the
fallback and is reworded to "the ticket text is below; fetch it only if you need more". Rationale
for text and not HTML: a brief is markdown a model reads; `renderedFields` HTML would be noise —
and per R33 no HTML exists to render by the time the brief is composed, since the flattening
happens in the adapter.
Rationale for the caps: a brief is a prompt, and an unbounded comment thread is a prompt-injection
and cost surface.
**R50 adds a second renderer beside this one, `renderRespondBrief`** — same file, same purity, same
gate discipline. It reuses `renderTicketSection` verbatim for its `## Ticket` block, so the ticket
text is composed in exactly one place.

**R19's CSP, `localResourceRoots` and "no external resources" rules are extended verbatim to the
side panel by R54; R23's removal list grows by `src/ui/tree.ts`; R24's single `/items` fetch is
unchanged (the four lists arrive in that one response); R43's status-bar lookup is unchanged and
now also has to cope with a selected agent of `mode: 'respond'`.**

### Extension

**R19 — the Item tab is a `WebviewPanel` in the editor area, with no external resources.**
`enableScripts: true`, `localResourceRoots` restricted to the extension's own `media/` directory,
`retainContextWhenHidden: true` (**R39**), and the CSP of **R38**. No `file://` access to the
worktree, no remote images, no `vscode-resource` outside `media/`.
Artifact **content** arrives over the message channel from the extension host (which read it via
`GET /sessions/:id/artifacts/:name`), never by giving the webview filesystem access.

**R38 — the CSP, verbatim.** Amends R19's meta tag. The `<meta http-equiv="Content-Security-Policy">`
content is exactly:

```
default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'; img-src 'none'; font-src 'none'
```

with `<n>` a fresh 128-bit base64 nonce per render. **No `unsafe-inline` anywhere**, and **no
`${webview.cspSource}`**: the page loads nothing over the network or over `vscode-resource`.
The consequence, decided here so no executor has to guess: the page **inlines `media/item-tab.js`
and `media/item-tab.css`** into a `<script nonce>` and a
`<style nonce>`. **R62 fixes who reads them**: the tab and the panel take the two as injected
**text**, and `extension.ts` alone reads them off disk at activation, so their unit tests do not
depend on `build:webview` having run. A nonce does authorise a `src`'d script in CSP3, but inlining sidesteps the
question entirely, and with `img-src 'none'`/`font-src 'none'` there is nothing else to fetch.
`localResourceRoots` is still set to the `media` directory alone — belt and braces, since nothing
is loaded by URI. Ticket images therefore do not render (R33 already turns them into
`[image: alt]` text); that is the accepted cost of `img-src 'none'`.

**R39 — `retainContextWhenHidden: true`, an explicit `ready` handshake, and no serializer.**
Amends R19 and R21.
- **`retainContextWhenHidden: true`** — the tab holds the rendered artifacts, the selected agent
  and the scroll position. With it false, every tab switch throws that away and re-fetches every
  artifact from the engine; the memory cost of one retained panel is far smaller than that of a
  user who stops using tabs. Exactly one panel exists at a time (MG-B9), which bounds the cost.
- **`WebviewToHost` gains `ready`**, posted by the script on load; the host replies with the first
  `render`. Without it the host races the webview's script: a `render` posted before the listener
  is attached is dropped silently and the tab stays blank, which is the classic first-open bug.
- **No `WebviewPanelSerializer` in Phase 9.** A window reload closes the tab, and that is stated in
  the README and in SMOKE.md so it reads as a decision rather than a defect. Restoring a webview
  across a reload means re-establishing the engine connection, the agent selection and the
  artifact content from a serialized blob whose shape is a second wire contract; it is a v2 hook.

**R20 — SUPERSEDED IN FULL BY R40.** There is no spike, no hand-written subset renderer and no
`src/model/markdown.ts`. R20's three-candidate comparison is retained only as the rationale R40
decides against; **any text in this document or the plan that describes a hand-written renderer is
stale and must be deleted, not implemented.**

**R40 — the renderer is bundled `markdown-it`, built by esbuild, and the build is wired.**
- The extension's `devDependencies` gain **`esbuild`** and **`markdown-it`** (plus
  `@types/markdown-it`). Both are dev-only: the bundle is a build output, so the **runtime**
  dependency count stays **zero** and the `.vsix` still contains no `node_modules/`. This
  consciously narrows Phase 7 R13 ("the extension builds with `tsc`") — recorded in `DECISIONS.md`
  — because a hand-written markdown renderer is 200 lines of security-critical parser we would own
  forever, against a build step the core already runs for `build:engine`.
- A **`build:webview`** script runs esbuild over `src/webview/item-tab.ts` (the webview entry,
  which imports `markdown-it`) producing **`media/item-tab.js`** — `--bundle --format=iife
  --platform=browser --target=es2020 --minify`. It is wired into **both `build` and
  `vscode:prepublish`**; wiring only the first ships a `.vsix` with no script in it.
- **`media/item-tab.js` is a generated artifact**: `.gitignore`d, never committed, and **included
  in the `.vsix`** (so it is not `.vscodeignore`d). `media/item-tab.css` is hand-written and
  committed.
- **`markdown-it` is configured `{ html: false, linkify: true }`** — `html:false` is what makes raw
  `<script>` in a `REVIEW.md` render as text. The `<a id="fN"></a>` footnote anchors from the
  review contract therefore render as **text, not anchors**; the tab keeps footnote *links*
  working by rendering `[^fN]`-style references as in-page links itself. That is a deliberate,
  small fidelity loss traded for not enabling `html:true` and hand-rolling a sanitizer.
- **Every non-markdown string is escaped before it reaches the DOM** — PR title, author, branch,
  Jira summary, status, assignee, comment author, error text. They go through one `escapeHtml`
  helper (`src/model/escape-html.ts`, pure, unit-tested), or through `textContent`; a string that
  is *not* an artifact body never goes through markdown-it and never through `innerHTML`.
- **MG-B7** covers both halves: for an XSS corpus (`<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`, `[x](javascript:alert(1))`, `<iframe>`, an HTML comment
  containing `-->`, a fence containing `</script>`) **and** for a **PR title and a Jira comment
  author containing `<script>` and an `on*` attribute**, the rendered HTML contains no `<script`,
  no `on\w+=` and no `javascript:` href, and the injected markup is **inert** (present as escaped
  text). The panel's CSP is the R38 string byte-for-byte and `localResourceRoots` names only
  `media`.

**R21 — the webview message protocol is a pure, tested module.** `src/model/item-tab-protocol.ts`
declares the two unions (`HostToWebview` = `render | patch`, `WebviewToHost` = `ready |
selectAgent | command | openLink` — `ready` per R39) and a
`parseWebviewMessage(raw): WebviewToHost | null` that **rejects anything it does not recognise**.
The webview is untrusted input like any other.

**R22 — selecting an item swaps to the selected agent's worktree; an item with no agent swaps
nothing.** `planWorkspaceAction` (`src/model/workspace-file.ts:28-48`) is reused unchanged,
including its dirty-editor modal (Phase 7 R-10a / MG-B5). A parking-lot row with no agent opens the
Item tab and leaves the workspace alone — it has no worktree, and Phase 7's current behaviour of
opening the PR in a browser (`src/ui/preview.ts:44-48`) becomes an explicit "Open PR" button
instead of the click action.

**R42 — switching agents never touches a claim, and "Start review" is hidden on my own PR.**
Amends R22.
- **Claims belong to the chat terminal's lifecycle and to nothing else.** `ChatSessions.open`
  claims, heartbeats at TTL/3 and releases on terminal close (`vscode/src/ui/terminal.ts`).
  Selecting an item, switching the agent tab, or closing the Item tab **must not** call
  `client.claim` or `client.release`. Rationale: a claim means "a human is driving this
  conversation"; a tab switch is browsing. Claiming on selection would block the engine's own runs
  behind an idle tab, and releasing on switch would yank the claim out from under a chat terminal
  that is still open in the other agent's worktree. Asserted: a test that switches agents twice
  records **zero** claim/release calls, while opening chat records exactly one claim.
- **"Start review" is hidden when `prs[0].isMine === true`** (and on any item with no PR). The core
  already answers 409 `OwnPrError` there; offering a button whose only outcome is an error is the
  kind of thing that made the old panel untrustworthy. The `when` clause is pinned by the manifest
  test.

**R23 — the markdown preview path is removed, and this is a recorded change to Phase 7 §5.5.**
`cgremlin.refreshPreview` and the `markdown.showPreview` call go away
(`src/ui/commands.ts:148-150`, `src/ui/preview.ts:76-79`); `ItemOpener` keeps only the
workspace-swap half and is renamed to reflect that. Phase 7 R11 (the core chooses the primary
artifact) survives and is *more* used, not less: it decides which artifact the Item tab shows first
per agent. Recorded in `docs/DECISIONS.md` under Phase 9.

**R24 — the coordinator fetches `/items` and nothing else on a refresh.** `GET /prs`,
`GET /sessions` and `GET /attention?all=1` all disappear from `refreshNow`
(`src/ui/refresh.ts:84-113`), replaced by one `GET /items`. `GET /config` is still fetched once at
connect. Notifications diff `WorkItem[]` keyed by `item.id` on `needsYou`, which preserves MG-B2's
property (the extension never re-derives needs-you) because `WorkItem.needsYou` is computed by the
core. Rationale: three round-trips per SSE burst over a Unix socket is measurable at 58 PRs, and the
three answers could disagree with each other mid-scan.

**R43 — the status bar reads the selected agent's `sessionId` out of `agents[]`.** Amends R24 with
the one thing removing `/attention` breaks. `RefreshCoordinator.renderStatus` today finds the
current row with `this.snapshot.find(item => item.links.sessionId === this.currentSessionId)`
(`vscode/src/ui/refresh.ts:136`) over the `/attention` snapshot, and reads `stageStatus` off it.
With `/items` as the only snapshot, the replacement is: find the `WorkItem` whose `agents[]`
contains the **selected agent** (the one the Item tab and the worktree swap are on), and read
`phase`, `running` and `needsYou` from **that `WorkItemAgent`**, not from the item. So
`currentSessionId` stays the key — it is now looked up one level deeper. Consequences that are
part of the ruling: `needYou` in the status bar counts `WorkItem`s with `needsYou`, not agents
(one badge per row the user would click); and with no agent selected the status bar shows the
connection state and the count only, exactly as it does today with no current session.

### The re-scope (R47–R55)

**R47 — there are FOUR lists, and the parking lot is a choosing surface.** Supersedes the
three-list model of §1 item 1, R2's `WorkListKind`, §4.1 step 4 and MG-B8. The lists are
`parkingLot`, `myWork`, `investigations`, `waitingForReview`. `reviewing` is gone as a list.

- **Membership.** `parkingLot` = **open, non-draft** PRs that are **not mine**, whose author is in
  `watchAuthors` (dropped when `showAllRepoPrs` is true — the `isMine` exclusion never is), **plus**
  any open non-draft PR whose `reviewRequests` include me *regardless of author* (R30's second
  bullet, unchanged). **A PR that already carries a review agent of ours stays in the parking
  lot** (coordinator override, 2026-09-10, superseding this ruling's original
  `agents.length === 0` exclusion and R48's earlier "any agent" clause): the parking lot is the
  one place all of *our team's* PRs live, so a PR we are already reviewing belongs at the **top**
  of it, not in `myWork`. Only a review agent has that effect — an investigation, development or
  respond session on a teammate's PR still routes the item into `myWork` (R48) **and** leaves it
  in the parking lot, which is a legal overlap.
- **Three ordered groups**, computed by the core as `WorkItem.parkingLotGroup` and rendered in
  this order:
  1. **"Reviewing"** — PRs carrying a review agent of ours, **in any state**, pinned on top, with
     the agent badges and the `needsYou` badge. This is where the removed `reviewing` list went.
  2. **Untouched** — no `humanActivity` and no pending review request to somebody else. Sorted by
     the list's selected sort; these are the rows the sorts exist for.
  3. **Collapsed "someone is on it"** — the `demoted` rows, de-emphasised at the bottom.
  A row is in exactly **one** group: `'reviewing'` wins over `'someoneOnIt'`, which wins over
  `'untouched'`.
- **"Someone is already on it" is an exclusion-style signal, not a badge.**
  `someoneIsOnIt(pr) = pr.humanActivity.lastAt !== null || requestedFromOthers(pr).length > 0`,
  where `requestedFromOthers` is `reviewRequests` minus me and minus bots. Rows where it holds and
  that carry **no review agent of ours** are
  **still in the list** but rendered **de-emphasised inside the collapsible "someone is on it"
  group pinned to the bottom**; untouched rows sit between the "Reviewing" group and it, expanded,
  and are what the sorts sort. They
  are not hidden, because the user must still be able to pile onto a stalled PR — but they are
  never what the eye lands on first.
  **Decided sub-clause (R47.1), and flagged as a decision:** a *pending review request from
  somebody else* counts towards `someoneIsOnIt` even though it is not "human activity" in R47's own
  parenthetical, because GitHub has already assigned that PR to a named person and picking it up is
  duplicated work. It is carried as its own `requested: @login` chip so the two causes are
  distinguishable on the row. Reverting to the literal reading of R47 is deleting one disjunct and
  one chip; nothing else depends on it.
- **Row fields**: `repo#n`, title, `@author`, **openFor** (rendered from `createdAt`, e.g.
  "opened 12d ago" — *not* from `updatedAt`), size (`changedFiles` files, `+additions/−deletions`),
  the `humanActivity` summary (`👤 @login reviewed` / `commented` / `requested`), the CI dot
  (`ci`), `reviewDecision`, and `labels`. A row whose fields took their R45 defaults renders `—`,
  never a fabricated zero (MG-12).
- **Sorts** are user-selectable and **persisted per list in extension state**
  (`globalState`, key `cgremlin.sort.<list>`; an unknown or absent value falls back to the list's
  default). The vocabulary is one union,
  `WorkSortKind = 'untouchedFirstThenOldest' | 'oldest' | 'newest' | 'smallestChange' | 'needsYouThenRecent'`.
  Defaults: `parkingLot` → `untouchedFirstThenOldest`; `waitingForReview` → `oldest`;
  `myWork` → `needsYouThenRecent`; `investigations` → `newest` (most recently updated).
  `parkingLot` offers all of `untouchedFirstThenOldest`, `oldest`, `smallestChange`, `newest`; the
  other three offer their default plus `oldest`/`newest`.
  **Where sorting happens, decided:** the **core** returns every list in its **default** order and
  that order is total, deterministic and stable (ties break on `id`), so `cgremlin-core` and any
  future client agree; the **extension** may re-sort a list with the user's selection, which is
  presentation and is already what §6's "ordering, badges" row assigns to it. `smallestChange`
  sorts `changedFiles` ascending with `null` last; `oldest`/`newest` sort on `createdAt` for PR
  rows and on the newest of ticket `updated` / agent phase-age for the rest, with `null` last.
- **Drafts are never listed** in any of the four (R30's first bullet, superseded there).

**R48 — `myWork` is a merge, and every row expands into its parts.** Supersedes §4.1 step 4's
`myWork` clause and extends §5's tab layout.
- **Membership.** An item is in `myWork` when **any** of: its ticket is assigned to me
  (`ticket.assignee === jira.me`); it has a PR of mine (`prs.some(pr => pr.isMine === true)`); or
  it carries an **investigation, development or respond** session of ours.
  **A review agent NEVER routes an item into `myWork`** (coordinator override, 2026-09-10,
  superseding the earlier "any agent of ours, review included" clause and its rationale): a
  teammate's PR that we are reviewing is a *teammate's PR*, and it belongs at the top of the
  parking lot (R47's "Reviewing" group), not in the list of things I am building. The four-list
  model stays total because the parking lot **keeps** those rows rather than dropping them.
  **Exception:** an item that qualifies for `investigations` (R49) is **not** in `myWork` — the two
  are mutually exclusive so a pure investigation appears exactly once.
- **Children, in this order, only what exists** — `🔍 Investigation` (session) · `🔨 Development`
  (session) · `🎫 <KEY> — summary (status)` · `🔀 repo#n — <draft|open|approved|changes_requested|
  merged> · <ci>`; a `respond` session renders as `💬 Respond` between the dev session and the
  ticket. The children are exactly the item's parts — `agents[]` in R2's order, then `ticket`, then
  `prs[]` — and MG-15 asserts that correspondence rather than a hand-built list.
- **Every child is clickable, with two actions.** Default click = **Info**: the *one* Item tab
  (MG-B9 unchanged) opens **focused on that child** — an agent child focuses the agent switcher on
  that agent and renders its artifacts; a ticket child focuses the ticket section; a PR child
  renders a **PR info** focus (title, state + `reviewDecision`, per-reviewer review summaries, open
  thread count, CI checks, the diff summary). Secondary action = **Go to**: the browser for a PR or
  a ticket (`Open on GitHub` / `Open in Jira`), and worktree-swap + `claude --resume` for a session.
  The focus is one field on the tab's state, `focus: {kind:'agent',sessionId} | {kind:'ticket'} |
  {kind:'pr',repo,number}` — **not** a second panel, and not a second wire contract.

**R49 — `investigations` is the "only an investigation" list.** An item is in `investigations` when
it has **no PR**, its agents are **all** `mode: 'investigation'`, and there is at least one of them.
A **ticket-linked** investigation (no PR, but a ticket) goes to **`myWork`, not here** — the
supervisor's open question, decided that way because a ticket is a commitment to deliver and the
user described `myWork` as "jiras I am assigned to … all merged together in a row". So
`investigations` is literally the user's "the sessions I only have investigation for": no PR, no
ticket, investigation agents only. Sorted most-recently-updated by default.

**R50 — `waitingForReview`, and the click that starts the respond flow.**
- **Membership**: my open, **non-draft** PRs — `prs.some(pr => pr.isMine === true && pr.isDraft ===
  false)`. A PR stays in this list after a review arrives; it does **not** move to `myWork`
  (my PRs are in `myWork` anyway, by R48). *This supersedes the earlier scope note that a reviewed
  PR "leaves waiting-for-review"* — leaving would hide the row at the exact moment it became
  actionable.
- **The row lights up** via three attention reasons on the PR source (R50 adds two to
  `ATTENTION_REASONS`, in this order after `changes_requested`): **`review_arrived`** — a non-bot,
  non-author review, conversation comment or review-thread comment exists on my PR
  (`humanActivity.lastAt !== null`); **`approved`** — `reviewDecision === 'APPROVED'`
  (the legacy "🚀 Approved — MERGE YOURS", `bin/cgremlin:748-750`); and the existing
  **`changes_requested`**, whose deriver is widened from the watch-filtered `teamActivity.length >
  0` to `humanActivity.lastAt !== null` so a reviewer outside `watchAuthors` counts. All three join
  `NEEDS_YOU_REASONS`, at the positions **R63** pins, and each reason's `at` is the stable
  timestamp **R58** names (never `updatedAt`); "since I last acted" is the existing ack/signature
  machinery (R3), not a new timestamp. `derivePrReasons` stays **my-own-PR-only** — no parking-lot row ever needs attention
  (MG-A8 unchanged).
- **The click, in order, and it is not a chat click** (amended with R56): **one**
  `POST /items/pr/:o/:r/:n/agents { mode: 'respond' }` which **creates the session and starts the
  respond run in the same request** (R56); **no claim is attempted** — the run is the engine's
  turn, and a claim would mean "a human is driving this conversation", which is exactly what is
  not happening yet (R42 unchanged: only the chat terminal ever claims); the workspace folder
  **swaps to that PR's worktree** (`planWorkspaceAction`, R22); and the panel row and the Item
  tab show the **running** respond agent.
  **Chat comes second.** The Chat row action and the Item tab's Chat button are offered on a
  respond agent **only once the run has finished** — phase `addressing` or `ready` — and they use
  the **existing** chat-terminal path unchanged (`claude --resume`, one claim, released on close).
  Chatting into a session whose `BRIEF.md` is still being written is the failure this ordering
  prevents.
  Required test, by name: **"the respond click records one run start and zero claim attempts"**.
- **The brief**, `renderRespondBrief(ctx): string` in `src/pipeline/prompts.ts`, pure, gated like
  `renderEnvironmentSection`, carrying:
  1. **Every review thread** — `id`, `isResolved`, `isOutdated`, `path`, `line`, and **every**
     comment in the thread (`author`, `body`, `createdAt`, `url`), oldest-first within the thread.
     The legacy query took `comments(first:1)` (`bin/cgremlin:14780`), which is why its brief had to
     reconcile replies by hand; R52 takes the whole thread.
  2. **Review summaries** — per reviewer `state` (APPROVED / CHANGES_REQUESTED / COMMENTED) + body,
     and the PR's `reviewDecision`.
  3. **CI** — the failing checks by name with their `detailsUrl`, from `statusCheckRollup`.
  4. **Diff summary** — `changedFiles`, `additions`, `deletions`.
  5. **`## Ticket`** — `renderTicketSection` verbatim (R18), so the agent can judge intent.
  Caps mirror R18's: at most 50 threads and 20 comments per thread, each comment truncated to 2000
  characters, 40000 characters total, and the text says so where it truncated. A brief is a prompt;
  an unbounded thread is a prompt-injection and cost surface.
- **The protocol, ported from MYCTX (`bin/cgremlin:1028-1071`)**: *reconcile first and on every
  change* — before acting, re-read the live threads through the engine's read-only artifact (the
  cached `review-threads.json` of R52, refreshed by the engine, which is this phase's replacement
  for `cgremlin --pr-threads`, `:454-471`) and reconcile against `COMMENTS.md`; open with a roll-up;
  then, per comment, offer reply-draft / fix / skip behind an explicit human gate; classify each
  thread into `COMMENTS.md` with the legacy per-entry shape (`Thread` / `From` / `Where path:line` /
  `Comment` / `Verdict ✅ valid | 🟡 false-positive` / `Reasoning` / `Proposed reply` /
  `Proposed fix` / `Status: open`, `bin/cgremlin:14792-14804`) so the artifact is recognisable to
  someone who used the old tool.
- **Out of scope, stated (R55):** the respond agent **never posts to GitHub** — no reply, no
  resolve, no push. Its allowed-tool set contains no mutating `gh` verb, and **MG-14** asserts that
  by running it against a `GhRunner` fake that throws on anything but a read. v1 ends at "the fix is
  committed locally"; the drafted replies live in `COMMENTS.md` for the human to paste.

**R51 — `respond` is a fourth `SessionMode`, and here is every place it lands.**
- `SessionModeSchema` becomes `z.enum(['review','investigation','development','respond'])`
  (`src/schema/session-mode.ts:3`), and `SessionSchema` gains a fourth `V2Base.extend` variant.
  Because both unions are **discriminated on `mode`**, every session already on disk keeps matching
  its own branch: the change is additive and migration-safe. The **v1** union is *not* extended —
  there were no respond sessions before Phase 9, so a v1 respond document cannot exist, and
  `migrateV1ToV2` needs no new case. **MG-13** loads a committed pre-Phase-9 sessions fixture
  (v1 and v2) and asserts every one still parses.
- **Phases** (`src/schema/pipeline.ts`): `RESPOND_PHASES = ['triaging','addressing','ready',
  'closed','abandoned']`. `triaging` = the agent is classifying the live threads into
  `COMMENTS.md`; `addressing` = working the entries (fixes, reply drafts); `ready` = every entry
  has a verdict and the local fixes are committed — the human is what it is waiting on;
  `closed` / `abandoned` = done. Transitions: `triaging → addressing | abandoned`;
  `addressing → ready | abandoned`; `ready → addressing | closed | abandoned` (a new review
  arriving sends it back to `addressing`); `closed` and `abandoned` have none. `PhaseFor<M>` gains
  the branch.
- **`TERMINAL_PHASES_BY_MODE` gains `respond: new Set(['closed','abandoned'])`**
  (`src/workspace/workspace-in-use.ts:4-8`). Because that constant is a
  `Record<Session['mode'], …>`, adding the mode without adding the entry **is a compile error** —
  which is exactly why the fourth mode is safe to add here rather than in a later phase.
- **Attention** (`src/attention/attention.ts`): one new reason, **`comments_ready`**, at the
  position **R63** pins, fired by
  `deriveSessionReasons` when `s.mode === 'respond' && s.stageStatus === 'ready'` — the mirror of
  the existing `review`/`ready → review_ready` clause at `:142`. It joins `NEEDS_YOU_REASONS`.
  Nothing else in the deriver branches on mode, so nothing else changes.
- **`RespondSessionFactory`** (`src/pipeline/respond-session-factory.ts`), the mirror of
  `ReviewSessionFactory`: it fetches the PR once with `PR_VIEW_FIELDS`, and **before**
  `createWorkspace` it requires `mapped.pr.author === me` (case-insensitive), throwing
  `NotMyPrError` otherwise — the same "refuse before you create a worktree" ordering as
  `review-session-factory.ts:63-72`. `ReviewSessionFactory`'s `OwnPrError` is **untouched**: review
  mode still refuses my own PR, and respond mode is the answer to why. The worktree is checked out
  on the **PR's own head branch** (`branchName = headRefName`, `baseRef = origin/<headRefName>`),
  not a detached `pr-N` branch, because the point of the mode is to commit a fix onto that branch;
  the session's `lineage.ticket` is `extractTicketKey(headRefName)`, as review does.
- **What deliberately does *not* change**: `buildOursStatus` (`src/inventory/inventory.ts:82-100`)
  and the `s.mode === 'review'` filters in `reconciliation.ts` and `server.ts` stay review-only —
  a respond session does not make a PR "ours" in the review sense, and widening those filters would
  change reconciliation behaviour that has nothing to do with this phase.
- **API**: `POST /items/pr/:owner/:repo/:number/agents { mode: 'respond' }` (R15's new bullet),
  which creates **and starts** (R56). There is no respond route on a ticket-only or session item
  — a 400.
  **A second POST on a PR that already has a live respond session follows the same parity rule as
  `POST /reviews`**: it never creates a second session (`created: false`), and it **restarts** the
  respond run (`started: true`) *unless* a run is already in flight or the session is claimed, in
  which case it is `{ created: false, started: false }` and the caller is told why. Restarting is
  the useful behaviour — a second review landed and the brief needs recomposing — and refusing
  mid-run is what stops two agents writing one `COMMENTS.md`.
- **Extension**: R42's "Start review is hidden when `prs[0].isMine`" stands, and **"Address review
  comments" takes its place on that row** when the PR is mine and non-draft. Both `when` clauses
  are pinned by the manifest test.

**R52 — review threads: the engine's first GraphQL call.** New `src/gh/review-threads.ts`.
- **The query**, through the existing `GhRunner` (`gh api graphql -f query=… -F owner=… -F repo=…
  -F number=… -F cursor=…`), so there is no new port, no new process spawner and no new fake:
  `repository(owner:,name:){ pullRequest(number:){ reviewThreads(first:100, after:$cursor){
  pageInfo{ hasNextPage endCursor } nodes{ id isResolved isOutdated path line
  comments(first:100){ pageInfo{hasNextPage} nodes{ author{login} body createdAt url } } } } } }`.
  Both the thread page and the comment page are paginated; a comment page that reports
  `hasNextPage` is followed, and a thread whose comments are still truncated after the cap is
  marked `truncated: true` in the brief rather than silently short.
- **Caching**, `<stateDir>/review-threads.json`, written tmp-then-rename like `InventoryStore`
  (`inventory-store.ts:26-32`), keyed `"<repo>#<n>"` with the PR's `updatedAt` recorded beside the
  threads. **A PR whose `updatedAt` is unchanged since the cached entry is never refetched** — that
  is the whole cost control. The path is a derived config value, `reviewThreadsCachePath`,
  registered in **both** `resolveCoreConfig`'s `expandOrDerive` and `DERIVED_PATH_SUFFIXES`
  (`core-config.ts:104-118`, `:264-274`) — one registration is the documented failure mode
  (`ARCHITECTURE.md:528-534`).
- **The fetch policy, decided, because "threads for all 58 PRs every tick" is the cost risk.**
  Threads are fetched only for: (a) **my** open non-draft PRs (they feed `waitingForReview` and the
  respond brief), and (b) a parking-lot candidate whose `humanActivity` is **empty** from reviews
  and comments alone — the only case where a thread comment could change the answer. A PR that
  already has human activity needs no thread call to stay demoted. Combined with the `updatedAt`
  cache key, a steady-state tick makes **zero** GraphQL calls. **MG-16** asserts both halves: no
  call for an unchanged PR, and no call for a teammate's PR that already has a non-bot reviewer.
- **Lifecycle**: the thread leg runs on the same discovery tick as the Jira leg, **after**
  `inventory.updated` is emitted, non-awaited, single-flight, under its own
  `reviewThreads.scanBudgetMs` (default 20000) `AbortController` — R34's discipline, applied
  verbatim to a second leg rather than reinvented. A failure is an `error` on the report, never a
  throw, and the previous cache survives (MG-6's shape).
- **`humanActivity` derives from reviews + conversation comments (as R6 says) plus thread
  comments**, all three through `isBotLogin` and the author exclusion, in `buildEntries`.
- **Read-only, guarded**: the fake `GhRunner` used in these tests **throws on any argv containing a
  `mutation`** or a non-`api`/`pr`/`repo` mutating verb, and a source grep over
  `src/gh/review-threads.ts` finds no `mutation` literal (part of MG-14).

**R53 — the inventory row gains the fields the re-scope's rows are made of, on the same one call.**
`PR_INVENTORY_FIELDS` gains `createdAt,changedFiles,additions,deletions,reviewRequests,
statusCheckRollup,labels,body`. **`PR_LIST_FIELDS` is not touched** (R8 unchanged — the plain list
is a different, cheaper query). `PrListItemSchema` gains each of them as **explicitly named
optional** fields — the schema is not `.passthrough()` (`pr-view.ts:14-29`), so an unnamed field is
silently stripped before `buildEntries` sees it (R29's lesson, applied to eight more fields).
`ActivityAuthorSchema` gains `is_bot: z.boolean().optional()` (U1). `body` is extracted and
**thrown away** (R8): it is not a field of `InventoryEntry`. `statusCheckRollup` is collapsed to
`ci` by the **existing** `ciStatus()` (`pr-view.ts:123-142`) — no new CI logic. It is still
**one `gh pr list` call per repo** on the happy path; the risk this ruling accepts is a materially
larger response body per scan, measured in smoke step 1 before the tick interval is trusted.
**R67** adds the fallback for when that one call trips GitHub's GraphQL node limit (two calls,
fields partitioned), **R59** makes `statusCheckRollup` parse leniently (U6) and **R60** fixes
`reviewRequests`' heterogeneous user/team shape.

**R54 — the side panel becomes a `WebviewViewProvider`, and the `TreeView` is removed.**
- `vscode.window.registerWebviewViewProvider('cgremlin.items', …)`, with `"type": "webview"` on the
  existing view contribution so the id, the container and the activity-bar icon are unchanged.
  `src/ui/tree.ts` and its `TreeDataProvider` are **deleted**; MG-B8's grep grows a
  `TreeDataProvider` term. Notifications and the status bar are **unchanged** (R43 still applies).
- **The same CSP as R38, byte-for-byte**, with its own nonce per render:
  `default-src 'none'; script-src 'nonce-<n>'; style-src 'nonce-<n>'; img-src 'none'; font-src 'none'`.
  `localResourceRoots` names only `media`. Row content — titles, authors, artifact text — crosses
  the message channel, never a file URI, and every non-markdown string goes through the one
  `escapeHtml` of R40. **MG-B7 covers the panel as well as the tab.**
- **The script is `media/panel.js`, bundled by the same esbuild step as `media/item-tab.js`**
  (R40): a second entry point in `build:webview`, wired into **both** `build` and
  `vscode:prepublish`, gitignored, and asserted present in the `.vsix` (MG-B10 grows one file).
  `media/panel.css` is hand-written and committed. `src/webview/panel.ts` joins `src/webview/**`
  and therefore gets the *narrow* purity assertion (no `import`/`require` of the `vscode` module),
  not the `includes('vscode')` one (§5).
- **The message protocol is pure and tested**, like R21's: `src/model/panel-protocol.ts` declares
  `HostToPanel = render | patch` and `PanelToHost = ready | openItem | openChild | setSort |
  toggleGroup | command`, with `parsePanelMessage(raw): PanelToHost | null` rejecting anything it
  does not recognise. `ready` is required before the first `render` (R39's handshake, same reason).
  There is **no** `WebviewViewProvider` serializer; a view that is re-created re-posts `ready` and
  gets a fresh render, which costs one `/items` read.
- **"Looks like the Codex chat panel"**, decided concretely so it is reviewable: card rows with a
  1px `var(--vscode-panel-border)` divider and no tree twisties; two lines per row (title line, then
  a dimmed metadata line at 0.9em in `var(--vscode-descriptionForeground)`); every colour from a
  `--vscode-*` variable so light, dark and high-contrast themes all work with no palette of our own;
  the parking lot's three groups as three labelled sections in the fixed order "Reviewing" /
  untouched / "someone is on it", of which only the last is a `<details>`-style collapsible,
  each with a count; sort controls as a
  compact segmented control in the view's header row; full **keyboard navigation** (up/down between
  rows, left/right to collapse/expand a row's children, Enter = default action, all with a visible
  `:focus-visible` outline and the full ARIA tree roles **R66** requires). **Codicons** may be used **only**
  via VS Code's built-in codicon font if it loads under `font-src 'none'` — it does not, so the
  decision is made here: **unicode glyphs, not codicons**, and no icon font is added.

**R55 — nothing in v1 writes to GitHub, anywhere.** Restated as its own ruling because the respond
flow is the first thing in this codebase that would obviously want to. No comment, no review, no
resolve, no push, no label, no merge — `docs/DECISIONS.md:81-85` is unchanged and Phase 9 adds a
second reason for it. Jira stays read-only too (D3, R10 — three read methods and no fourth).
**MG-14** is the guard: a source grep over `cgremlin/core/src` finds no `gh api graphql` string
containing `mutation` and no `gh pr comment|review|merge|edit|close|ready|review-request` argv, and
the respond-flow tests run against a `GhRunner` fake that throws on every mutating verb.

### The re-check (R56–R67)

Twelve rulings from the 2026-09-10 re-check. Two are **BLOCKERS** — without them the phase does
not run at all.

**R56 — BLOCKER: `respond` is a `STAGE_NAME`, and the click that creates the session also starts
the run.** Amends R15, R51 and MG-8.
- `STAGE_NAMES` is `['findings','plan','develop','review','rereview']`
  (`src/schema/stage.ts:3`) and it is **three things at once**: `StageNameSchema` validates
  `POST /sessions/:id/run` (`src/api/validation.ts:85-91`), it is the `stage` field of
  `LastRunSchema` (`stage.ts:12`) which is persisted on every session, and it is the payload type
  of `run.started` / `run.finished` (`src/engine/events.ts:10`, `:12`). A respond session that
  runs a stage called anything else cannot be started, cannot record its run, and cannot emit an
  event. **`STAGE_NAMES` gains `'respond'`** — appended, so no existing persisted `lastRun.stage`
  value shifts meaning.
- **`PipelineService.runRespond(id)`** is written in the shape of `runDevelop`
  (`pipeline-service.ts:587-618`), verbatim where it can be: load, refuse a non-`respond` mode
  with `UnsupportedStageError`, the unlocked advisory `isClaimed` check, compose
  `renderRespondBrief` (R50) + `STAGE_ENTRY_PROMPT(sessionDir)`, then
  `runStageLocked(id, 'respond', brief, prompt, async () => { … })` whose callback **re-loads
  fresh inside the lock**, calls `assertNoHumanTurn`, and re-checks the phase — the race the
  comment at `:601-604` exists to close. On success it transitions **`triaging → addressing`**.
- **`RESPOND_RUNNABLE_FROM: readonly RespondPhase[] = ['triaging', 'addressing', 'ready']`**,
  declared beside the existing `REVIEW_RUNNABLE_FROM` (`:647`) and `REREVIEW_RUNNABLE_FROM`
  (`:764`) and checked on the **fresh** load inside the lock, exactly as they are. `closed` and
  `abandoned` are not runnable.
- **`POST /items/pr/:owner/:repo/:number/agents { mode: 'respond' }` creates the session *and*
  starts the run in the same request**, answering `202` with `{ session, created, started: true,
  item }`. **Recorded against Phase 7 R5 / MG-8** ("nothing starts an agent that was not
  explicitly asked for"): the user's click on a lit `waitingForReview` row **is** the explicit
  ask, and it is a `POST`, not a read. MG-8's wording is amended to say so — the guard still
  asserts **zero** starts from every `GET`, and now asserts **exactly one** start from this
  `POST`. Anything else would hand the user a session with an empty `BRIEF.md` and a second
  button to press.

**R57 — BLOCKER: `open(pr)` is `pr.isDraft !== true`, and no item with a live agent of ours is
ever unlisted.** Amends §4.1 step 4 and MG-17.
- `open(pr) = pr.isDraft !== true`. R45 makes every new inventory field default, and a
  pre-Phase-9 row or an agent-only `WorkItemPr` (R25) carries `isDraft: null`; `isDraft === false`
  would silently drop **every** such row out of all four lists. Unknown-draftness is treated as
  not-a-draft, which errs towards showing the user a row they can dismiss rather than hiding work.
- **Totality clause, stated as an invariant**: *an item carrying a live (non-terminal) agent of
  ours is in at least one list, whatever its PR's state.* Two cases the membership rules would
  otherwise drop:
  - a **merged or closed teammate PR that still has our review agent** → `parkingLot`, group
    `'reviewing'`. The parking-lot clause therefore reads
    `(the open/watchAuthors/reviewRequests clause) || (prs.some(pr => pr.isMine !== true) && agents.some(a => a.mode === 'review'))`,
    the second disjunct carrying no `open()` test at all;
  - a **merged own PR with a respond or development agent** → `myWork`, already covered by
    `agents.some(a => a.mode !== 'review')`, and the invariant makes that non-accidental.
- **MG-17's fixture gains "a review agent whose PR has been merged is still listed"** (and the
  matching own-PR respond case), asserting the invariant directly rather than by inspection.

**R58 — the `at` of each new attention reason is stable while the condition holds.** Amends R50.
`evaluateAttention` builds `since` and the ack signature from the derived reasons' timestamps
(`src/attention/attention.ts`), so a reason whose `at` moves on every scan re-fires a
notification the user already acknowledged. Therefore:
- **`review_arrived`** → `entry.humanActivity.lastAt` (already the newest human touch, and it
  does not move unless a human does something).
- **`approved`** and **`changes_requested`** → `entry.reviewDecisionAt`, defined once:
  **the `submittedAt` of the newest review in the unfiltered `reviews` array whose `state`
  matches the entry's current `reviewDecision`, and `null` when no review matches.** That covers
  the cases a "latest APPROVED review" rule gets wrong: `reviewDecision` of `''` or
  `REVIEW_REQUIRED` (no matching review exists → `null`, and neither reason fires anyway), and a
  PR with **mixed** reviewers where an older `APPROVED` sits beside a newer
  `CHANGES_REQUESTED` — the decision GitHub computed is the one that must pick the timestamp.
  Persisted on the entry as `reviewDecisionAt: string | null`, optional-with-a-default per R45.
  A reason whose `at` resolves to `null` keeps `evaluateAttention`'s existing null handling;
  it is **never** filled in from `updatedAt`, which moves on every push.
- Required test, by name: **"a push to an approved, acked PR re-fires nothing"** — ack the item,
  bump `updatedAt` and `headSha` with no new review, re-derive, and assert the signature is
  unchanged and `acked` is still true.

**R59 — `statusCheckRollup` is parsed leniently, and its shape is U6.** Amends R53.
The rollup is a heterogeneous union (`CheckRun` and `StatusContext`, which is exactly why
`ciStatus` branches on `__typename` at `pr-view.ts:131`) and nothing in this repo proves what
`gh pr list` emits for it, as opposed to `gh pr view`. So the field is
`statusCheckRollup: z.array(StatusCheckSchema).catch([]).optional()` — **a parse failure yields
`[]`, and `ciStatus([])` is `'none'`** — and a malformed rollup can therefore never 500 a scan or
`InventoryCorruptError` a load. **U6** is "the `statusCheckRollup` shape on `gh pr list`", closed
by **A2's recorded `gh pr list` fixture** (the same manual run that closes U1), which either
confirms the shape or proves the lenient path is load-bearing. Recorded either way in
`DECISIONS.md`.

**R60 — `reviewRequests` is a heterogeneous array and is flattened at parse time.** Amends R30
and R53. `gh` emits a mixed array of **users** (`{ login }`) and **teams** (`{ name, slug }`).
The zod shape is
`z.array(z.union([z.object({ login: z.string() }), z.object({ name: z.string().optional(), slug: z.string() })])).catch([]).optional()`,
flattened by one pure helper to `string[]` — a user contributes its `login`, a team contributes
its `slug`. R30's "a team slug is carried and displayed but only matches when it equals `me`"
is unchanged, and now has a defined source. Named in **Task A1's Interfaces list** so it cannot
be reduced to `z.array(z.object({ login: z.string() }))`, which would throw on the first
team-requested PR.

**R61 — ticket-merging applies only to *my* items; teammates' PRs are never merged by ticket
key.** Amends R4, R26 and §4.1 step 2.
A ticket candidate absorbs a PR **only** when the resulting item would be mine — that is, when
the PR `isMine`, **or** the ticket is assigned to me (`ticket.assignee === jira.me`), **or** a
session of ours already references the ticket. Two teammates' PRs that happen to name the same
ticket stay **two separate parking-lot rows**. Rationale: the merge exists so *my* work is one
row (§0.1), and in the parking lot the user is choosing between *PRs to read* — merging two
teammates' PRs into one row hides one of them behind the other and makes "how many file changes"
meaningless. The per-PR actions were already per-PR ("Start review" and "Open PR" are one entry
per `prs[]` entry, R26/R42), so nothing else changes. **MG-17 gains the case**: two teammates'
PRs naming `HB-627` produce **two** items with two ids; the same two PRs with one of them mine
produce the R26 two-PR row.

**R62 — the `Host` takes the webview script and style as injected **text**, and the disk read
lives in `extension.ts`.** Amends R19, R38, R54 and Tasks B3/B4.
R38 has the host read `media/item-tab.js` and `media/item-tab.css` off disk and inline them; R54
does the same for the panel. If `ui/item-tab.ts` and `ui/panel-view.ts` perform that read, then
**every test of them needs `build:webview` to have run**, which couples the unit suite to the
bundler and makes a red test ambiguous between "the HTML is wrong" and "the bundle is missing".
So the seam is: `createItemTab`/`registerPanelView` take `{ scriptText, styleText }` as plain
strings, the fake `Host` supplies literals, and **`extension.ts` alone** does the
`readFile(context.extensionUri + '/media/…')` at activation. The CSP, the nonce and the inlining
are unchanged; only who hands over the bytes changes. **MG-B7 still asserts the CSP string and
`localResourceRoots`, now against injected text**, and MG-B10 remains the assertion that the real
bundle shipped.

**R63 — `ATTENTION_REASONS` is pinned verbatim, in this order.** Amends R50 and R51. The array is
the ordering discipline for every reason list and the ack signature (`attention.ts:12-22`,
`:80-89`), so its **positions** are part of the contract:

```ts
export const ATTENTION_REASONS = [
  'plan_ready',            // 0
  'needs_input',           // 1
  'blocked',               // 2
  'run_failed',            // 3
  'review_ready',          // 4
  'rereview_ready',        // 5
  'comments_ready',        // 6  R51 — a respond session at 'ready'
  'local_prereq_failed',   // 7
  'changes_requested',     // 8
  'review_arrived',        // 9  R50
  'approved',              // 10 R50
] as const;
```

`comments_ready` sits beside its mirror `review_ready`/`rereview_ready`; `review_arrived` and
`approved` sit beside their mirror `changes_requested`. `NEEDS_YOU_REASONS` gains all three.
A test asserts the array **element-for-element** against this literal, so a reordering that
silently rewrites every stored ack signature fails.

**R64 — the `Host` gains `globalState` get/update.** Amends R47 and Task B4. The per-list sort is
persisted in `globalState` (R47), and `Host` is the one seam the extension's pure-ish UI modules
reach VS Code through (`vscode/src/ui/host.ts:113-182`). Two narrow members —
`getState<T>(key: string): T | undefined` and `setState(key: string, value: unknown):
Thenable<void>` — in the same style as every other member, with the fake supplying an in-memory
`Map`. Without them B5's "the sort survives a re-created view" test has nothing to assert
against.

**R65 — a `pr` or `session` path resolves to the item that *contains* it.** Amends R14, R25 and
R28. An item's `id` may be `ticket:HB-627` while the thing the user clicked is
`pr:owner/repo#12` — R28 fixes the id to the ticket the moment a link exists, so a route that
looked up `pr/owner/repo/12` as an id would 404 on exactly the items the phase exists to create.
So `GET|POST /items/pr/:owner/:repo/:number` resolves to **the item whose `prs` contains that
PR**, and `/items/session/:id` to **the item whose `agents` contains that session**, each unique
by construction (a PR belongs to one candidate, a session to one item). The response body still
carries the item's own `id`, which may be a `ticket:` id. The **extension** maps an item's `id`
to a path with one pure helper (`ticket:K → ticket/K`, `pr:o/r#n → pr/o/r/n`,
`session:s → session/s`) and, for a **child** click, uses that child's own path. **MG-9 gains the
case**: an item whose `id` is `ticket:HB-627` and whose `prs[0]` is `owner/repo#12` is reachable
at `/items/pr/owner/repo/12`, and the returned body's `id` is `ticket:HB-627`.

**R66 — the panel is an accessible tree, not a pile of divs.** Amends R54. The list container is
`role="tree"`, each row `role="treeitem"` with `aria-level` (1 for a row, 2 for a child),
`aria-selected` on the focused row and `aria-expanded` on any row with children or on a
collapsible group header. The keyboard model of R54 is the tree model those roles promise, so
declaring the roles and not implementing the keys — or the reverse — is the failure mode; both
are asserted together in B5.

**R67 — `gh pr list` can exceed GitHub's GraphQL node limit, and the fallback is two calls per
repo.** Amends R53's "one call per repo".
`gh pr list --json` is a GraphQL query under the hood, and adding `statusCheckRollup`,
`reviews`, `comments`, `body` and `labels` to a 100-PR page can trip GitHub's **hard** node
limit. It is not a soft degradation: the whole request fails, so a repo returns **nothing**.
- **Detection**: `GhCommandError` (`src/gh/gh-runner.ts:5-13`) whose `stderr` contains
  `MAX_NODE_LIMIT_EXCEEDED` or the text `exceeds the maximum node limit` (case-insensitive; both
  are matched because the exact wording is instance- and version-dependent and is part of **U6**).
- **Fallback**: split that repo's scan into **two** `gh pr list` calls with the fields
  partitioned — call A the cheap scalars
  (`PR_LIST_FIELDS + ',createdAt,changedFiles,additions,deletions,labels,reviewRequests,body'`),
  call B the expensive connections (`number,latestReviews,reviews,comments,statusCheckRollup`) —
  joined on `number`. The split is **per repo and per scan**, remembered for the rest of that
  scan only, and it is tried **once**: if call B also trips the limit, that repo falls back to the
  previous scan's entries, which is the behaviour `inventory-scanner.ts:72-78` already has.
- The happy path is still **one** call per repo. Asserted by counting calls against the `gh` fake:
  one call normally, three (the failed one plus two) after a node-limit stderr, and never four.
- **Smoke step 1** checks it against the user's real repos, which is the only place the real PR
  count and the real field cost meet.

---

## 4. Core shapes

### 4.1 `src/work/` (new)

```
src/work/work-item.ts        PURE: the types above + groupWorkItems() + list membership (D2)
src/work/work-item-service.ts  the I/O shell: composes AttentionService + InventoryStore + JiraStore,
                               emits item.changed, and takes NO session lock (MG-1)
src/work/work-item-id.ts     PURE: workItemIdOf / parseWorkItemId, three forms (R14, R25)
src/work/bot-login.ts        PURE: isBotLogin (R5)
```

and, under `src/jira/`, one more pure module: `src/jira/html-to-text.ts` (R33), the
`renderedFields` HTML → text flattener, fixture-tabled and used by the adapter alone; and, under
`src/gh/`, `src/gh/review-threads.ts` (R52), the GraphQL query, its fixture-backed parser and its
`<stateDir>/review-threads.json` cache; and, under `src/pipeline/`,
`src/pipeline/respond-session-factory.ts` (R51).

`groupWorkItems(input): WorkItem[]` is pure and takes
`{ items: AttentionItem[]; inventory: Inventory | null; jira: JiraScanReport | null; me: string; watchAuthors: string[]; showAllRepoPrs: boolean; projectKeys: string[] }`.
`items` is the **pre-dedupe** list (R27); `jira.me` is the accountId from the scan (R37);
`projectKeys` is what filters a session's `lineage.ticket` at group time (R29/R46).
Review threads reach the grouping only through the inventory row's `humanActivity` (R52), so the
pure function stays free of a second data source.

**Grouping algorithm** (deterministic, no clock):
1. Seed one candidate per inventory entry (keyed `pr:<repo>#<n>`) and one per Jira issue
   (keyed `ticket:<KEY>`). **R28:** also seed a ticket candidate — key only, no summary — for every
   ticket key named by a PR's `ticketKeys[0]` or by a session's filtered `lineage.ticket` that the
   Jira snapshot does not contain. Identity follows the link, never the snapshot.
2. Merge a PR into a ticket candidate when the PR's first `ticketKeys` entry names it → kind
   `pr+ticket`, id = the **ticket** id (the ticket is the stabler identity; a work item survives its
   PR being closed and reopened). **R26:** two PRs naming the same key merge into the **same**
   candidate, and land in `prs` ordered by `updatedAt` descending.
   **R61 gates the whole step:** the merge happens **only** when the result would be *mine* —
   the PR `isMine`, or `ticket.assignee === jira.me`, or a session of ours references the ticket.
   Two **teammates'** PRs naming the same key stay **two** items, each its own parking-lot row.
3. Attach each `AttentionItem` with `mode !== null` to a candidate by, in order: `links.prRepo` +
   `links.prNumber`; then `links.ticket` (filtered through `projectKeys` first — R29). An agent
   that matches neither becomes its **own** `WorkItem`: `kind: 'pr'` when it has PR links (a merged
   or closed PR still under review — R25), else `kind: 'session'`, `id: session:<sessionId>`, title
   = the session's title — D2's "investigations/development sessions without pr/ticket appear in
   myWork too (they are my work)", as narrowed by R49 (a session-only item whose agents are all
   investigations lands in `investigations`, not `myWork`).
   A `respond` agent (R51) attaches by its PR links like any other agent; it needs no special case
   here.
   An `AttentionItem` with `mode === null` (a `source: 'pr'` row, which the pre-dedupe list now
   preserves) contributes its `attention` and its ref to the PR's candidate and creates no item of
   its own.
4. Compute list membership over the **four** lists of R47 (`p = prs[0]`, the primary PR; clauses
   that quantify over all PRs say `prs.some`). **This step replaces the earlier three-list
   version in full.** Define first:
   `open(pr) = pr.isDraft !== true` (**R57**, not `=== false`: an unknown draft state is treated
   as not-a-draft, or every pre-Phase-9 and agent-only row silently vanishes) — a draft is in
   **no** list (R47, superseding R30's marker);
   `someoneIsOnIt(pr) = pr.humanActivity.lastAt !== null || requestedFromOthers(pr).length > 0`
   (R47.1), where `requestedFromOthers(pr) = pr.reviewRequests` minus `me` minus `isBotLogin`.
   - **`parkingLot`** — `prs.some(pr => open(pr) && pr.isMine !== true && (`
     `watchAuthors.includes(pr.author)` (case-insensitive) **or**
     `pr.reviewRequests.some(r => r.toLowerCase() === me.toLowerCase())` (**R30**: a review
     requested from me outranks the watch list, whoever the author is)`))`. When `showAllRepoPrs`
     is true the `watchAuthors` clause is dropped; the `isMine` exclusion never is.
     **There is no agent exclusion** (coordinator override): a PR we are already reviewing stays
     here, in the "Reviewing" group. **R57's totality disjunct**, appended with `||`:
     `(prs.some(pr => pr.isMine !== true && pr.isDraft !== true) && agents.some(a => a.mode === 'review'))`
     — it drops the *state* test (a merged or closed teammate PR that still carries our review
     agent is still listed, and `isDraft` is `null` on such a row, which passes) but **keeps the
     draft test**, because R47's "the parking lot is open PRs, not drafts" holds whether or not
     we have an agent on it.
     `someoneIsOnIt` does **not** remove the row either — it sets `demoted: true`, and the row
     lands in the collapsed group unless a review agent puts it in "Reviewing" first (R47).
     `parkingLotGroup` = `'reviewing'` when `agents.some(a => a.mode === 'review')`, else
     `'someoneOnIt'` when `demoted`, else `'untouched'`.
   - **`waitingForReview`** — `prs.some(pr => pr.isMine === true && open(pr))`.
   - **`investigations`** — `prs.length === 0 && ticket === null && agents.length > 0 &&
     agents.every(a => a.mode === 'investigation')` (R49).
   - **`myWork`** — **not** in `investigations`, and any of:
     `(ticket !== null && ticket.assignee === jira.me)`, `prs.some(pr => pr.isMine === true)`,
     `agents.some(a => a.mode !== 'review')` (**review never counts** — R48, coordinator
     override).
   Overlaps are expected and legal: my own open PR is in both `waitingForReview` and `myWork`;
   a teammate's PR that carries **both** a review agent and an investigation/development/respond
   session is in `parkingLot` (group `'reviewing'`) **and** `myWork`.
   `parkingLot` is disjoint from `waitingForReview` by `isMine !== true`, and from
   `investigations` by `prs.length > 0`; a review agent **alone** never puts an item in `myWork`.
   `investigations` and `myWork` are disjoint by the explicit exception.
   **R57's invariant, stated:** an item carrying a live (non-terminal) agent of ours is in at
   least one list, whatever its PR's state — a review agent lands it in `parkingLot.reviewing`,
   anything else in `myWork`. MG-17 asserts it directly.
5. Sort each list into its **default** order (R47 names the default per list, and says the
   extension may re-sort with the user's selection):
   - `parkingLot` → `untouchedFirstThenOldest`, applied **within** the three groups and never
     across them: group order is always `'reviewing'`, `'untouched'`, `'someoneOnIt'`, and inside
     each group the rows sort by `createdAt` ascending (the `'reviewing'` group sorts `needsYou`
     first, then `createdAt` ascending, because a review that wants me outranks an old one).
   - `waitingForReview` → `oldest`: `createdAt` ascending.
   - `myWork` → `needsYouThenRecent`: `needsYou` first, then most-recently-updated (the newest of
     the item's PR `updatedAt`s and its ticket's `updated`).
   - `investigations` → `newest`: most-recently-updated.
   In **every** list a missing key sorts last and ties break on `id`, so each order is total,
   stable and clock-free.

### 4.2 Config additions

```ts
export const JiraConfigSchema = z.object({
  // Documented example for this user: 'https://aplaceformom.atlassian.net'
  siteUrl: z.string().url(),
  // Documented example for this user: 'guilherme.azoubel@aplaceformom.com'
  email: z.string().min(1),
  /** THE one thing the user must supply. Secret: 0600 + redaction, exactly like vercel.bypassSecret (R11). */
  apiToken: z.string().min(1).optional(),
  /** Extra issue fields to request; unverified ones (e.g. 'customfield_10016') go here, never in the default set. */
  extraFields: z.array(z.string().min(1)).default([]),
  /** Injectable for tests and for a proxy; defaults to siteUrl (R10, D7). */
  baseUrl: z.string().url().optional(),
  /**
   * The default is D3's. A user who wants "the current sprint instead" edits this ONE string to
   * `assignee = currentUser() AND sprint in openSprints()` — documented in the README next to
   * the field, because it is the single most likely thing to be tuned.
   */
  jql: z.string().min(1).default(
    'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
  ),
  /** R7 as amended by R46 — anti-false-positive. Empty means ticket linking is DISABLED. */
  projectKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).default([]),
  maxResults: z.number().int().positive().max(100).default(50),
  /** Per HTTP request. */
  timeoutMs: z.number().int().positive().default(15_000),
  /** R34 — one budget for the WHOLE Jira leg of a tick (whoami + every page). */
  scanBudgetMs: z.number().int().positive().default(20_000),
});
// CoreConfigSchema gains:
jira: JiraConfigSchema.optional(),
botLogins: z.array(z.string().min(1)).default(DEFAULT_BOT_LOGINS),   // R5
showAllRepoPrs: z.boolean().default(false),                          // D2
jiraCachePath: z.string().optional(),                                // derived <stateDir>/jira.json
// R52 — the review-thread leg
reviewThreads: z.object({
  scanBudgetMs: z.number().int().positive().default(20_000),
}).default({ scanBudgetMs: 20_000 }),
reviewThreadsCachePath: z.string().optional(),        // derived <stateDir>/review-threads.json
```

`jiraCachePath` **and `reviewThreadsCachePath`** are each registered in **both**
`resolveCoreConfig`'s `expandOrDerive` and `DERIVED_PATH_SUFFIXES` (`core-config.ts:104-118`,
`:264-274`) — registering one is the documented failure mode (`ARCHITECTURE.md:528-534`).
There is **no** config for the panel sorts: they are per-user presentation and live in the
extension's `globalState` (R47).

### 4.3 Routes

| Method | Path | Body / query | Response | Codes |
|---|---|---|---|---|
| GET | `/items` | `?list=parkingLot\|myWork\|investigations\|waitingForReview` | `{ evaluatedAt, lists: { parkingLot: { reviewing: WorkItemId[], untouched: WorkItemId[], someoneOnIt: WorkItemId[] }, myWork: WorkItemId[], investigations: WorkItemId[], waitingForReview: WorkItemId[] }, items: WorkItem[], ticketSource: {kind,error,scannedAt}, threadSource: {error,scannedAt} }` | 200 |
| GET | `/items/ticket/:key` | — | `{ item, ticket: JiraIssueDetail\|null, ticketError, artifacts: Record<sessionId, ArtifactListing[]> }` | 200, 404 |
| GET | `/items/pr/:owner/:repo/:number` | — | same shape | 200, 404 |
| GET | `/items/session/:id` | — | same shape (R25) | 200, 404 |
| POST | `/items/{ticket/:key \| pr/:owner/:repo/:number \| session/:id}/agents` | `{ mode, repoUrl?, intent?, driveToCompletion? }` | `{ session, created, started, item }` | 202, 200, 400, 404, 409 |
| POST | `/items/{…same three…}/ack` | — | `{ item, acked: ItemRef[], failed: [{ref,error}] }` (R31) | 200, 404, 502 |

`ticketSource.kind` is R35's `'notConfigured' | 'auth' | 'unavailable' | 'ok'`; there is no
`configured` boolean and no `ok` boolean. `threadSource` (R52) is the same idea one notch simpler —
review threads have no credential of their own, so it is `{ error: string | null, scannedAt }` and
a non-null `error` renders as the same "stale, not empty" banner as `unavailable`.
`POST …/agents` accepts `mode: 'respond'` **only** on a `pr/:owner/:repo/:number` path and only
when the PR is mine: 400 elsewhere, 409 (`NotMyPrError`) on somebody else's PR (R51). That call
**also starts the respond run** and answers `202` with `started: true` (**R56**).
**R65:** a `pr/…` path resolves to the item whose `prs` contains that PR and a `session/:id` path
to the item whose `agents` contains that session — **not** by matching the path against the
item's `id`, which may be a `ticket:` id (R28). The body still carries the item's own `id`.
The four `?list=` values are R47's; `reviewing` is not one of them and is a 400 — it is a
**group inside `parkingLot`**, not a list. `lists.parkingLot` is therefore an **object of three
ordered id arrays**, not a flat array, and every id in it appears in exactly one of the three
(the same answer `WorkItem.parkingLotGroup` gives, carried twice so neither client nor CLI has to
re-derive it). The other three lists stay flat arrays.

The detail fetch requests, as its starting field set (ported verbatim from `bin/cgremlin:1930-1932`
minus the two unverified ones): `summary,description,issuetype,status,priority,labels,assignee,reporter,attachment,comment`,
plus `expand=renderedFields`, plus anything in `jira.extraFields`. `acceptance_criteria` and
`customfield_10016` are **not** in the default set — both are instance-specific and an unknown field
name makes Jira 400 the whole request.

`GET /items/…` fetches the Jira detail **on tab open, through the 60 s / `updated`-keyed detail
cache of R36**, with `jira.timeoutMs`; a failure fills `ticketError` and leaves `ticket: null` —
the route never 5xxs because Jira is down. Comments come from the comment endpoint (R37), not from
the issue's `comment` field, and both description and comments arrive as **text** (R33).

### 4.4 Event map after Phase 9

Unchanged from Phase 7's table (`ARCHITECTURE.md` "Events"), plus:

| Event | Payload | New? |
|---|---|---|
| `item.changed` | `{ id, kind, changedFields? }` (R41 — **not** the whole item) | **new** |

---

## 5. Extension architecture delta

```
cgremlin/vscode/src/
  model/work-items.ts          PURE: the WorkItem wire mirror + the FOUR-list view model (R47),
                               the sort comparators, and the "someone is on it" grouping
  model/escape-html.ts         PURE: the one escaper for non-markdown strings (R40)
  model/item-tab-protocol.ts   PURE: the two message unions + parseWebviewMessage (R21, R39)
  model/panel-protocol.ts      PURE: HostToPanel/PanelToHost + parsePanelMessage (R54)
  webview/item-tab.ts          the webview entry; imports markdown-it; esbuild's input (R40)
  webview/panel.ts             the side-panel webview entry; esbuild's second input (R54)
  ui/item-tab.ts               the WebviewPanel: create/reveal/dispose, one panel at a time,
                               with R48's `focus` (agent | ticket | pr)
  ui/panel-view.ts             the WebviewViewProvider registered for `cgremlin.items` (R54);
                               takes script/style TEXT, never a path (R62)
  ui/tree.ts                   DELETED (R54)
  ui/preview.ts                keeps only the worktree swap (R23)
  media/item-tab.js            GENERATED by `build:webview`; gitignored; ships in the .vsix (R40)
  media/item-tab.css           hand-written, committed, theme-aware via var(--vscode-*)
  media/panel.js               GENERATED by `build:webview`; gitignored; ships in the .vsix (R54)
  media/panel.css              hand-written, committed, theme-aware via var(--vscode-*)
```

There is **no `model/markdown.ts`** — R40 replaced it with bundled `markdown-it`.
`model/work-items.ts`, `model/escape-html.ts`, `model/item-tab-protocol.ts` and
`model/panel-protocol.ts` join
`pureSourceFiles()` (`test/purity.test.ts:15-23`) — and therefore may not contain the string
`vscode` **even in a comment** (Phase 8 R30).
**`src/webview/**` deliberately does NOT join that list**: it calls `acquireVsCodeApi()` and styles
with `var(--vscode-*)`, so a plain `includes('vscode')` check would be unsatisfiable there. It gets
its own, narrower assertion in the same test file instead: **no `import`/`require` of the `vscode`
module** anywhere under `src/webview/` (the webview runs in a browser context where that module
does not exist), plus the existing "imports `vscode` in exactly two files" count, which
`src/webview/**` must not increase. This is a deliberate, named widening of MG-B1 and is made in
the task that creates the directory. `ui/item-tab.ts` **and `ui/panel-view.ts`** join the exact `src/ui/*` basename list (`:93-107`),
and `ui/tree.ts` leaves it. `media/**`
joins the `.vsix` allow-list assertions (`test/packaging/vsix-contents.test.ts:47-60`) — the "no
`.ts`, no `src/`, no `node_modules/`" rules already permit it, and the **positive** assertion that
`media/item-tab.js` **and `media/panel.js`** are present is what proves `vscode:prepublish` ran the
bundler (R40, R54, MG-B10).

**Panel layout** (R54, top to bottom): a header row per list (name, count, the segmented sort
control) → card rows, two lines each — line 1 `repo#n · title` with the badges (`needsYou`, CI dot,
`reviewDecision`, agent glyphs), line 2 dimmed metadata (`@author · opened 12d ago · 7 files
+120/−30 · 👤 @jane reviewed`) → for a `myWork` row, its children indented under it when expanded
(R48) → for `parkingLot`, **three ordered groups** (R47, coordinator override): a **"Reviewing
(N)"** group pinned on top holding the rows whose `parkingLotGroup === 'reviewing'`, each showing
its review agent's badges and `needsYou`; then the untouched rows, ungrouped and sorted; then a
collapsible **"someone is on it (N)"** group pinned to the bottom
holding the `'someoneOnIt'` rows. The panel reads `parkingLotGroup` and never re-derives it. Every colour is a `--vscode-*` variable; icons are unicode glyphs, not
codicons (R54).

**Item tab layout** (top to bottom): header (title, `KEY` chip linking to Jira, one `repo#n` chip
**per PR** in `prs` linking to GitHub, the CI dot, `needsYou` badge — the `draft` marker and the
no-human-review badge are gone with R47/R30) → button row (Chat, Start review / investigation /
development, **Address review comments** on my own non-draft PR (R51), Ack) → agent tabs (one per
`agents[]`, showing mode + phase + running / needsYou / claimed glyph) → the selected focus'
content (R48): an **agent** focus renders that agent's artifacts, newest mtime first, each
collapsible; a **ticket** focus scrolls to and expands the Jira section; a **PR** focus renders the
PR info block (state, `reviewDecision`, per-reviewer review summaries, open thread count, CI checks
with names, the diff summary) plus an "Open on GitHub" link → the Jira section (description text,
then the five newest comments).

The webview posts `ready` on load and the host answers with the first `render` (R39); the side
panel does the same with `parsePanelMessage` (R54). Both are handed
`{ scriptText, styleText }` by `extension.ts`, which is the only module that touches
`media/` on disk (R62); the panel's rows carry the ARIA tree roles of **R66**, and the sort
selection round-trips through the `Host`'s `getState`/`setState` (**R64**).
`artifact.changed` for a session in `agents[]` re-fetches just that artifact and sends a `patch`
message; `item.changed` **whose `id` matches this item** (R41) re-fetches `GET /items/<path>` and
re-renders the header and the tabs — it does **not** refetch the Jira detail (R36).

---

## 6. Layer split — the Phase 9 rows

| Capability | Layer | Why |
|---|---|---|
| What a "work item" is, and which list it belongs to | **core** | It is a rule over engine state; the CLI and a future MCP client need the same answer (D2 says the core computes membership). |
| "Nobody but a bot has reviewed this" | **core** | It is a fact about GitHub data the engine already fetches; recomputing it per frontend means a `gh` call per PR per client. |
| Which agents belong to a work item | **core** | It is the same join `linkPrToSource` already performs (`src/discovery/link-pr-to-source.ts:31-38`). |
| Reading Jira | **core** | It holds a credential, it is a scheduled read, and it caches — all three are engine concerns (Phase 7 §10.1). |
| Rendering a ticket or an artifact | **extension** | The core "never renders HTML" (`cgremlin/core/README.md:7`, `:267-268`) — a non-negotiable, and the reason the renderer lives in the webview. |
| Which artifact to show first per agent | **core** | `pickPrimaryArtifact`, unchanged (Phase 7 R11). |
| "Somebody is already on this PR" | **core** | Same reason as the row above it: it is a fact about GitHub data the engine fetched, and D2 puts membership *and* its modifiers in the core so no client re-derives them (`WorkItem.demoted`, R47). |
| Fetching review threads, and caching them | **core** | A `gh` call, on a schedule, with a cache — the same three engine concerns as reading Jira (R52). |
| The respond brief | **core** | Every brief is composed by `src/pipeline/prompts.ts`; a second composer would be a second truth (R50). |
| Ordering, badges, the agent switcher, the **user-selected** sort, row expansion | **extension** | Presentation. The core still returns each list in a total, deterministic **default** order (R47/§4.1 step 5) so a headless client is not left unsorted. |
| Swapping the worktree | **extension** | Workspace-folder membership is window state (Phase 7 R15). |

---

## 7. Testing strategy

**Core (vitest, fakes per port, `test/support/*`).**
- `groupWorkItems` table-driven: a bot-only-reviewed PR; a human-reviewed PR; a PR whose only
  commenter is the author; a ticket with no PR; a PR with no ticket; a `pr+ticket` merge by branch,
  by title and by body; a PR whose key is not in `projectKeys`; **`projectKeys: []` → no linking at
  all (R46)**; a teammate PR that already has a review agent (**stays** in `parkingLot` with
  `parkingLotGroup: 'reviewing'` and is **not** in `myWork` — R47/R48, coordinator override); the
  same PR with an investigation session instead → `parkingLot` **and** `myWork`; my own
  PR (never in the parking lot; in **both** `waitingForReview` and `myWork` — R50); a non-watched
  author's PR (in no list, and in `parkingLot` once
  `showAllRepoPrs` is true); **a non-watched author's PR that requests my review (in `parkingLot`
  regardless — R30)**; **a draft PR — mine and a teammate's — in NO list at all (R47, superseding
  R30's marker)**; **a parking-lot PR with a non-bot reviewer, one with a non-bot commenter, one
  with only a thread reply, and one with only a pending review request from somebody else → all
  four `demoted: true` and still listed (R47/R47.1); one with a review request from *me* and
  nothing else → `demoted: false`**; **a demoted PR that also carries a review agent →
  `parkingLotGroup: 'reviewing'`, not `'someoneOnIt'`**; an
  investigation session with neither PR nor ticket (`kind: 'session'`, `id: session:<id>`, in
  **`investigations` and NOT `myWork`** — R49); the same session once it has a ticket → `myWork`,
  not `investigations` (R49); an investigation **plus** a dev session on one item → `myWork`;
  a review agent whose PR has been merged (**still `kind: 'pr'`**, every
  `WorkItemPr` field but repo/number/url null — R25); **one ticket with two PRs → one item,
  `prs.length === 2`, ordered newest first, `needsYou` from either (R26)**; two agents on one item,
  ordered; **"ticket leaves the JQL → id unchanged" (R28)**, and the same with
  `ticketSource.kind: 'unavailable'`; **the four default sort orders of §4.1 step 5, each asserted
  total and stable including the null-key and tie cases, with the parking lot's sort applied
  WITHIN each of its three groups and never across them**.
- **`ATTENTION_REASONS` (R63)** is asserted **element-for-element** against the literal in R63,
  and `NEEDS_YOU_REASONS` contains `comments_ready`, `review_arrived` and `approved`.
- **`reviewDecisionAt` (R58)**: it is the `submittedAt` of the **newest review whose `state`
  matches the entry's current `reviewDecision`**; `null` for `''`/`REVIEW_REQUIRED`; on a
  **mixed** PR (an older `APPROVED`, a newer `CHANGES_REQUESTED`, decision
  `CHANGES_REQUESTED`) it is the newer one's, not the older one's.
- **`derivePrReasons` (R50/R58)**: each reason's `at` is the stable timestamp R58 names, and the
  named test **"a push to an approved, acked PR re-fires nothing"** — ack, bump `updatedAt` and
  `headSha` with no new review, re-derive, assert the signature is unchanged and `acked` stays
  true. Then: my PR with a non-bot review → `review_arrived`; with
  `reviewDecision: 'APPROVED'` → `approved`; with `CHANGES_REQUESTED` → `changes_requested`; a
  reviewer **outside `watchAuthors`** still fires `review_arrived` (the widening away from
  `teamActivity`); a bot-only review fires **nothing**; a **teammate's** PR fires nothing, however
  loud it is (MG-A8 unchanged); all three reasons are in `NEEDS_YOU_REASONS` and in
  `ATTENTION_REASONS` order.
- **The respond click (R50/R56/R42)**, named: **"the respond click records one run start and
  zero claim attempts"** — one `POST …/agents { mode:'respond' }` yields exactly one
  `FakeAgentRunner` start, **zero** `client.claim`/`client.release` calls, one
  `planWorkspaceAction` swap to the PR's worktree, and **no** chat terminal; Chat becomes
  available only once the phase is `addressing` or `ready`.
- **The second POST (R51)**: with a run in flight, or a claimed session, it is
  `{ created: false, started: false }`; otherwise `{ created: false, started: true }` and the run
  restarts on a recomposed brief — the same parity `POST /reviews` has.
- **`respond` stage (R56)**: `STAGE_NAMES` contains `'respond'` and a pre-Phase-9 `lastRun.stage`
  still parses; `POST /sessions/:id/run { stage: 'respond' }` validates; `runRespond` refuses a
  non-`respond` mode, refuses a claimed session, refuses a phase outside
  `RESPOND_RUNNABLE_FROM` **on the fresh in-lock load** (the race `pipeline-service.ts:601-604`
  closes), composes `renderRespondBrief`, and transitions `triaging → addressing` on success;
  `run.started`/`run.finished` carry `stage: 'respond'`.
- **`respond` mode (R51)**: `RESPOND_PHASES`, the transition table (including `ready → addressing`
  and the two terminal phases), `TERMINAL_PHASES_BY_MODE.respond`, and
  `deriveSessionReasons` firing `comments_ready` at `ready` and nothing at `triaging`;
  `RespondSessionFactory` throws `NotMyPrError` on a teammate's PR **before** any
  `createWorkspace` call (assert the workspace fake recorded zero calls), creates the worktree on
  the PR's own head branch on mine, and sets `lineage.ticket` from the branch; a second create for
  a PR with a live respond session returns it with `created: false`.
- **`renderRespondBrief` (R50)**: it returns `''` with nothing fetched; it contains **every comment
  of every thread** (a two-thread, five-comment fixture asserts all five bodies are present — the
  regression the legacy `comments(first:1)` truncation caused); resolved and outdated threads are
  labelled, not dropped; the caps truncate and say so; the `## Ticket` block is
  `renderTicketSection`'s output byte-for-byte; **the reconcile-first instruction and the
  `COMMENTS.md` entry shape are present**; and the brief contains **no** instruction to reply,
  resolve or push (R55).
- **`gh pr list` resilience (R59, R60, R67)**: a malformed `statusCheckRollup` yields `ci: 'none'`
  and **no throw**; a `reviewRequests` array mixing `{login}` and `{name,slug}` flattens to
  logins and team slugs; a `GhCommandError` whose stderr says `MAX_NODE_LIMIT_EXCEEDED` triggers
  **exactly** the two partitioned calls, joined on `number`, and a second limit error on call B
  falls back to the previous scan's entries — asserted by **counting** the fake's calls: one
  normally, three after a limit error, never four.
- **Review threads (R52)**: the GraphQL argv the runner is handed (query text, `owner`/`repo`/
  `number`, and `after` on page two); thread pagination and comment pagination each over a recorded
  two-page fixture; a comment page still truncated at the cap marks the thread `truncated`; the
  cache round-trips tmp-then-rename and a PR whose `updatedAt` is unchanged is **not** refetched;
  a teammate PR that already has a non-bot reviewer is **not** fetched (the R52 policy); a failing
  `gh` call leaves the previous cache intact and sets `threadSource.error`.
- `AttentionService.list` default stays deduped; `{ dedupe: false }` returns both the session item
  and its PR item (R27).
- `isBotLogin` table over `is_bot`, the `[bot]` suffix, the config list and a human called
  `robots`.
- `htmlToText` fixture table (R33): paragraphs/`<br>`, lists, `<pre><code>`, `<a href>`, `<img>`,
  entity decoding including a double-encoded `&amp;lt;`, markup inside a code block, an
  unterminated tag.
- `JiraRestSource` **contract test against recorded fixtures** — no live call, ever (D7): the JQL
  and `fields`/`expand` it sends; **`/search/jql` `nextPageToken`/`isLast` pagination and, in
  separate fixtures, `/search` `startAt`/`maxResults`/`total` pagination (R32)**; **a 404 on
  `/search/jql` falls back exactly once per scan, not once per page — asserted by request count**;
  a 401, a 403, a 429 with `Retry-After` (one bounded retry, then give up), a timeout, and a
  malformed body. **`url` is built from `siteUrl` while `baseUrl` points at the stub, and the two
  are set to different values on purpose (R37)**. The base URL points at a `http.Server` on
  `127.0.0.1:0` started by the test.
- `issue(key)` fetches comments from `/issue/{key}/comment?orderBy=-created&maxResults=5` (R37),
  fixtured, and returns `bodyText` — the response type has **no `*Html` field at all** (R33/MG-10).
- `whoami()` against a recorded `/myself` fixture, and against a 401 — the two answers
  `cgremlin-core config check-jira` must distinguish.
- `JiraScanner` degradation: a throwing source leaves `error !== null`, `kind: 'unavailable'`, and
  the **previous** `jira.json` contents intact; a 401 leaves `kind: 'auth'`; a block with no
  `apiToken` leaves `kind: 'notConfigured'` and makes **no** request (R35).
- **R34 ordering and budget**: `inventory.updated` is emitted **before** the Jira leg starts;
  `run()` resolves without awaiting it and `ScanReport.jira` carries the last completed report; a
  leg that outlives `scanBudgetMs` is aborted and recorded as an error; a second tick during an
  in-flight leg starts no second leg; `stop()` awaits the leg.
- **R36 detail cache**: two opens within 60 s make one request; a changed `updated` in the snapshot
  invalidates immediately; an `item.changed` triggers no detail fetch.
- Route tests for all six route shapes (including `/items/session/:id` and `POST …/ack`), the
  ack fan-out over every ref with a partial failure reported (R31), the 400 when a ticket-only
  item's `POST …/agents { mode: 'development' }` omits `repoUrl`, and the 409 own-PR path for
  `mode: 'review'`.
- `renderTicketSection` gate + caps.

**Extension (vitest, no `@vscode/test-electron`).**
- `buildWorkLists` over fixture `/items` payloads: **four** lists (R47), badges, the age and size
  cells (and `—` for a row whose fields took their R45 defaults), the CI dot, the
  `humanActivity` summary, the parking lot's **three ordered groups** — "Reviewing" on top holding exactly the
  `parkingLotGroup: 'reviewing'` rows with their agent badges, the untouched rows next, and the
  collapsed "someone is on it" group last — the two-PR row, **each selectable sort producing the documented
  order and round-tripping through a fake `globalState`** (including an unknown persisted value
  falling back to the list default), and a
  `ticketSource.kind: 'auth'` payload producing the **engine-trouble** treatment (a row **and** a
  status-bar state), not a footnote (R35).
- **Row expansion (R48)**: a `myWork` row's children are exactly `agents[]` (in R2's order) then
  `ticket` then `prs[]`, only what exists, in that order; each child's default action is Info with
  the right `focus`, and its secondary action is Go-to with the right target; a row with no
  children does not render an expander.
- **`parsePanelMessage` (R54)** rejects unknown shapes, a wrong-typed field and a
  `{"__proto__":{}}` payload, and accepts `ready`; the panel HTML's CSP is R38's string
  byte-for-byte with `localResourceRoots` naming only `media`. The tab's and the panel's tests
  pass **literal** `scriptText`/`styleText` and therefore **never require `build:webview` to have
  run** (R62); a grep asserts neither `ui/item-tab.ts` nor `ui/panel-view.ts` reads from
  `media/`.
- **The panel is a tree (R66)**: the container is `role="tree"`, rows are `role="treeitem"` with
  `aria-level` 1 (row) / 2 (child), `aria-selected` on the focused row and `aria-expanded` on
  every expandable row and group header — asserted **together with** R54's key handling, so
  roles-without-keys and keys-without-roles both fail.
- **The sort round-trips through `Host.getState`/`setState` (R64)** against an in-memory fake,
  including the unknown-persisted-value fallback.
- The bundled renderer over the **verbatim** `REVIEW.md` contract sample (`prompts.ts:165-240`), a
  `FINDINGS.md` sample and the R40 XSS corpus, **plus a PR title and a Jira comment author carrying
  `<script>` and an `on*` attribute**, all of which must render inert.
- `parseWebviewMessage` rejects unknown shapes and accepts `ready` (R39).
- Switching agents twice records **zero** claim/release calls; opening chat records exactly one
  claim (R42).
- The status bar reads the selected agent out of `agents[]` (R43), including the no-agent case.
- Integration extension→**real engine** for `GET /items`, with a **FakeJira** wired by pointing
  `jira.baseUrl` at a stub `http.Server` the harness starts (D7) and a `jira.apiToken` in the
  0600 `core.json` the harness already writes (`test/support/core-harness.ts:135-161`).

### Mutation guards

| Guard | Asserts | Mutation that must fail it |
|---|---|---|
| **MG-1** `work-items-never-lock-a-session` | a full `GET /items` records zero `lock.enter:<sessionId>` entries on a wrapped `KeyedLock` (the Phase 5 / MG-A3 technique) | reading sessions directly in `WorkItemService` instead of going through `AttentionService` |
| **MG-2** `parking-lot-is-teammates-only` | a PR by a non-watched author is in **no** list with `showAllRepoPrs: false`, and in `parkingLot` with it true; my own PR is never in `parkingLot`; a teammate PR with a review agent is in `parkingLot` with `parkingLotGroup: 'reviewing'` and is **not** in `myWork` (R47/R48, coordinator override); **a non-watched author's PR that requests my review IS in `parkingLot`; a draft PR is in NO list at all** (R47, superseding R30) | dropping the `watchAuthors` filter (the regression that produced the 58-row panel), dropping the `reviewRequests` override, or letting a draft back in |
| **MG-3** `bots-are-not-people` | a PR reviewed **only** by `dependabot[bot]`, `github-actions` and `copilot-pull-request-reviewer` has `humanActivity.lastAt === null` and empty `reviewedBy`/`commentedBy`; one non-bot comment — **or one non-bot review-thread reply** (R52) — sets `lastAt` and lists that login; a comment by the **author** does not | counting any review, or using `teamActivity.length > 0` (which is watch-filtered and would call a non-watched human's review "no review") |
| **MG-4** `one-bot-predicate` | `isBotLogin` is referenced from every site that decides bot-ness, and a source grep finds no second `[bot]` literal outside `src/work/bot-login.ts` | inlining a second suffix check in the scanner |
| **MG-5** `jira-token-never-escapes` | the raw `apiToken` appears in **none** of: `GET /config`, `GET /items`, `GET /items/…`, any `/events` frame (including `?include=run.output`), any `BRIEF.md` the pipeline writes, the engine log, or `jira.json` | forgetting `hasAnySecret`/`redactCoreConfig`, or caching the auth header into `jira.json` |
| **MG-6** `jira-down-degrades-not-empties` | with the stub returning 500, `GET /items` still returns yesterday's `jira.json` tickets and `ticketSource: { kind: 'unavailable', error: … }`; `myWork` is **not** empty; a 401 gives `kind: 'auth'` and a token-less block gives `kind: 'notConfigured'` (R35) | returning `[]` on a fetch failure, or collapsing the four kinds back to a boolean |
| **MG-7** `inventory-schema-stays-loadable` | a pre-Phase-9 `inventory.json` (committed as a fixture, with **none** of `humanActivity`/`branch`/`ticketKeys`/`reviewRequests`/`createdAt`/`changedFiles`/`additions`/`deletions`/`ci`/`labels`) loads, every new field takes its default, and `GET /prs` answers 200 (R45) | making any new field required |
| **MG-8** `an-agent-is-started-only-when-asked` | `GET /items` and `GET /items/…` record **zero** `FakeAgentRunner` starts and zero `run.started`; `POST …/agents` records **exactly one** — including `{ mode: 'respond' }`, where the same request creates the session **and** starts the `respond` stage, because the user's click is the explicit ask (**R56**, recorded against Phase 7 R5); two concurrent `POST …/agents {review}` for one PR yield one session (same `pr:<slug>#<n>` lock key as `server.ts:816`) | any auto-start on read (Phase 7 R5), dropping the lock key, or leaving a respond session with an unrun, empty `BRIEF.md` |
| **MG-9** `item-ids-round-trip-and-never-reach-a-path-raw` | `workItemIdOf`/`parseWorkItemId` round-trip **all three** forms (R25); a source grep finds no `/items/${` template that interpolates a raw id (R14); **an item whose `id` is `ticket:HB-627` and whose `prs[0]` is `owner/repo#12` is reachable at `/items/pr/owner/repo/12`, and the body's `id` comes back `ticket:HB-627`** (R65) | putting `pr:owner/repo#12` into a request path, or resolving a `pr/…` path by matching it against the item's `id` |
| **MG-10** `no-html-crosses-the-boundary` | a source grep finds **no identifier matching `/Html$/`** in `src/jira`, `src/work`, `src/api` or the extension's `postMessage` payload types; a `GET /items/…` body for a ticket whose description is `<b>bold</b>` contains neither `<b>` nor `descriptionHtml` (R33) | returning `renderedFields` HTML over the port "just for the tab" |
| **MG-11** `ticket-linking-needs-project-keys` | with `projectKeys: []`, a PR titled `bump to SHA-256 / UTF-8 (PR-123)` yields `ticketKeys: []` and its own item, and the "linking disabled" line is logged **once**; with `projectKeys: ['HB']` the same PR still yields `[]` and an `HB-627` branch yields `['HB-627']` (R46) | restoring "empty means no filtering" |
| **MG-12** `defaults-render-as-unknown` | a `WorkItem` whose PR fields took their R45 defaults (`createdAt: null`, `changedFiles: null`, `ci: 'none'`) renders `—` for age and size and no CI dot, and sorts **last** under `oldest`/`smallestChange`; nothing renders `0 files` or `opened today` (R45, R47) | treating `null` as `0`, or `?? new Date()` |
| **MG-13** `old-sessions-still-load` | a committed fixture directory of pre-Phase-9 sessions — v1 and v2, all three old modes — loads through `SessionStore` unchanged after `respond` is added, and `migrateV1ToV2` gains no respond case (R51) | replacing the discriminated union with a non-discriminated one, or extending the v1 union |
| **MG-14** `nothing-posts-to-github` | a source grep over `cgremlin/core/src` finds no `mutation` inside any GraphQL query string and no `gh pr comment\|review\|merge\|edit\|close\|ready\|review-request` argv; the respond-flow tests run against a `GhRunner` fake that **throws** on any mutating verb and the suite is green; `renderRespondBrief` contains no reply/resolve/push instruction (R50, R52, R55) | porting the legacy `--reply-comment`/`--resolve-comment`/`--push-fix` verbs, or letting the respond agent's tool list widen |
| **MG-15** `children-are-the-item-parts` | a `myWork` row's rendered children are derived from `agents[]` + `ticket` + `prs[]` and from nothing else — adding a fourth agent to the fixture adds a fourth child with no view-model edit, and removing the ticket removes exactly one child (R48) | hand-building the child list, so a new agent mode silently renders nothing |
| **MG-16** `threads-are-not-fetched-for-every-pr` | across one tick over a 60-PR fixture, `gh api graphql` is invoked **only** for my open non-draft PRs and for parking-lot candidates with empty `humanActivity`; a second tick with unchanged `updatedAt`s invokes it **zero** times (R52) | fetching threads per PR per tick, or keying the cache on anything but `updatedAt` |
| **MG-17** `four-lists-are-total-and-disjoint-where-they-must-be` | over a fixture covering every membership branch, every item lands in at least one list or is deliberately in none (a draft, a non-watched author's PR with `showAllRepoPrs:false`); **every teammate PR carrying a review agent of ours is in `parkingLot` exactly once, in the `reviewing` group, and `myWork` never contains a review-only item**; each id in `lists.parkingLot` appears in exactly one of its three groups and matches that item's `parkingLotGroup`; `investigations` never intersects `myWork`; the legal overlaps are `waitingForReview` ∩ `myWork`, and `parkingLot` ∩ `myWork` for a teammate PR that also carries a non-review session (R47–R50); **a review agent whose teammate PR has been merged is still listed, in `parkingLot.reviewing`, and a merged own PR with a respond agent is still in `myWork`** (R57's invariant); **a teammate DRAFT PR with a review agent is in NO list** (R57's disjunct keeps the draft test); **two teammates' PRs naming the same ticket key produce TWO items, while the same pair with one of them mine produces the R26 two-PR row** (R61) | dropping `reviewing`'s items on the floor when the list was removed, or letting a review agent route an item into `myWork` |
| **MG-B7** `webview-renders-no-script` | for the XSS corpus **and** for a PR title / Jira comment author containing `<script>` and an `on*` attribute, the rendered HTML contains no `<script`, no `on\w+=` and no `javascript:` href, and the injected markup is inert escaped text (R40); **both** the item tab's and the side panel's CSP are R38's string byte-for-byte and `localResourceRoots` names only `media` (R54) | enabling `html: true`, skipping `escapeHtml` on a non-markdown string, or widening `localResourceRoots` to the worktree |
| **MG-B8** `four-lists-and-no-tree` | `buildWorkLists` returns exactly `parkingLot`/`myWork`/`investigations`/`waitingForReview` (R47) and **no** `reviewing`; a source grep over `vscode/src` finds no `client.prs(`, no `markdown.showPreview`, no `cgremlin.refreshPreview` (R23, D6) and **no `TreeDataProvider`/`createTreeView`** (R54); the manifest's `cgremlin.items` view carries `"type": "webview"` | keeping the old lists, the preview path or the tree alongside the new panel |
| **MG-B9** `one-item-tab-and-one-worktree` | opening a second item **reuses** the same panel; switching to an agent with a different worktree calls `planWorkspaceAction` again and `updateWorkspaceFolders` at most once; an item with no agent calls it zero times (R22); **switching agents records zero claim/release calls** (R42) | creating a panel per item, appending a folder, or claiming on selection |
| **MG-B10** `webview-bundle-is-built-and-shipped` | the `.vsix` **contains** `media/item-tab.js`, `media/item-tab.css`, **`media/panel.js` and `media/panel.css`** — which is only true if `vscode:prepublish` ran `build:webview` over **both** entry points — and still contains no `node_modules/`, no `src/`, no `.ts` (R40, R54) | wiring `build:webview` into `build` only, adding only one entry point, or committing a stale generated bundle |

---

## 8. Manual smoke checklist

1. **Parking lot.** Compare against `gh pr list --repo <r> --state open`: only `watchAuthors`
   logins, never mine — **plus** any PR that requests my
   review, whoever wrote it — and **no drafts at all** (R47). Three groups, in order:
   **"Reviewing (N)"** on top holding every PR we have a review agent on, with its agent badges;
   then the untouched rows; then the collapsed
   "someone is on it (N)" group holding exactly the PRs with a
   non-bot reviewer/commenter/thread-reply or a pending request to somebody else (R47.1).
   Start a review on an untouched row → it moves to the top group and **does not** appear in
   "My dev work" (coordinator override). **Check the node limit (R67):** watch the engine log for
   a `MAX_NODE_LIMIT_EXCEEDED` stderr on any repo — if it fires, confirm that repo still produces
   entries (via the two partitioned calls) and record the exact wording, which closes that half
   of U6. Each row
   shows its age from `createdAt` and its `N files +a/−d`. Count the **untouched** rows — if that
   is still long, it is a `watchAuthors` finding, not a bug (U4). Also time one full scan before
   and after R53's extra `gh pr list` fields, and record the numbers: that is the cost measurement
   R53 accepts the risk on.
2. **Parking-lot sorts.** Switch the sort to *oldest*, then *smallest change*, then *newest*, and
   confirm the order matches the row data each time; reload the window and confirm the choice
   survived (extension `globalState`, R47). Take one row from the untouched group and leave a
   comment on it as yourself → on the next scan it moves into the collapsed group.
3. **My work, and its children.** Every Jira ticket the `jql` returns appears; every one of my open
   unmerged PRs appears; **no teammate's PR appears here just because we are reviewing it**; a ticket that has a PR appears **once**, as one row; a ticket with two PRs
   appears once, with two `repo#n` chips (R26). Expand a row → its investigation, dev session,
   ticket and PR appear as children in that order, and only the ones that exist (R48). Click each
   child: the session opens the Item tab focused on that agent, the ticket opens it focused on the
   ticket, the PR opens the PR info focus with its reviews, threads count and CI — and **the same
   one tab** is reused every time. Use each child's "go to" → the browser for the PR and the
   ticket, the worktree swap plus `claude --resume` for a session.
3a. **Investigations.** A session with only an investigation agent, no PR and no ticket appears
   **only** in `investigations`; give it a ticket and it moves to `myWork` (R49).
3b. **Waiting for review.** My open non-draft PRs are listed oldest-first; my draft is not there
   (R47/R50). Have somebody review one → the row lights up with `review_arrived` on the next scan.
4. **Ticket source down.** Put a wrong `apiToken` in `core.json`, restart → the panel shows the
   **auth** treatment (a row *and* a status-bar state) naming `cgremlin-core config check-jira`,
   plus the previously-cached tickets, not an empty list (R35). Fix it → recovers on the next tick.
   Then stop the network instead → the **unavailable** banner, not the auth one.
5. **Item tab.** Click a `pr+ticket` row with a review agent → a tab opens rendering `REVIEW.md`
   with its table intact and its footnote links working, the ticket description and the five
   newest comments below as text, and the explorer now shows **that** worktree (one folder).
   Append a line to `REVIEW.md` from a shell → the tab updates with no click. Hide the tab behind
   another editor and come back → it is still scrolled where you left it (R39). Reload the window
   → the tab is **gone**, by design (R39).
6. **Two agents.** On an item with a review agent and a development agent, switch tabs → the
   artifacts change and the worktree swaps; with an unsaved editor in the outgoing worktree, the
   modal appears first and dismissing it changes nothing. A chat terminal open on the *other*
   agent keeps its claim across the switch (R42).
6a. **The respond flow, and the GraphQL cost (closes U5).** First, by hand:
   `gh api graphql -f query='{repository(owner:"<o>",name:"<r>"){pullRequest(number:<n>){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:100){nodes{author{login} body createdAt url}}}}}}}'`
   on one of my PRs that has review comments — record the response shape as the fixture and confirm
   the field names (R52). Then in the panel: click the lit `waitingForReview` row. **One** thing
   happens: a respond session is created and its run **starts**, the explorer swaps to that PR's
   worktree (**one** folder), and the row and the Item tab show the respond agent **running**.
   **No terminal opens and no claim is taken** — Chat is not offered while the run is in flight.
   When the run finishes, the phase has moved `triaging → addressing`, `BRIEF.md` contains
   **every** comment of **every** thread with its `path:line`, the review decisions, the failing
   CI checks by name, the diff summary and the `## Ticket` section — and **now** the Chat action
   appears on the row and in the tab, opening the ordinary `claude --resume` terminal (which is
   the only thing that claims, R42). Click the row again mid-run → nothing restarts and the panel
   says so; click it again after the run → the run restarts on a recomposed brief (R51).
   Ask the agent to reply on GitHub → it must refuse and point at `COMMENTS.md` (R55). Let it
   triage → the session reaches `ready` and the row shows `comments_ready`. Finally, watch the engine log across
   two idle ticks and confirm **zero** further `gh api graphql` invocations (R52's cache, MG-16).
7. **Chat.** Chat on the selected agent → a terminal in that agent's worktree running
   `claude --resume <id>`; `POST /sessions/:id/run` then 409s (Phase 7 R9/R19 unchanged).
8. **Start an agent from a ticket.** "New investigation" on a ticket-only row → a repo quick-pick,
   then a session whose `lineage.ticket` is the key and whose `BRIEF.md` contains the `## Ticket`
   section with the real summary and description.
9. **Credential check.** `cgremlin-core config check-jira` against
   `https://aplaceformom.atlassian.net` with the real token prints the display name and the
   accountId (expected `712020:f0acd024-8d3a-4b87-9d4b-768ee3eb3f74`); with a wrong token it prints
   Jira's own 401 wording and exits non-zero. Then swap the JQL to
   `assignee = currentUser() AND sprint in openSprints()` and confirm `myWork` changes on the next tick.
10. **Secrets.** With `jira.apiToken` set: `cgremlin-core config show`, `GET /config`, `GET /items`,
   the engine log and the new `BRIEF.md` all show no token. `chmod 644 core.json` → the engine
   refuses to start, naming the file.

## 9. v2 hooks (not precluded)

- **A fifth list** (Slack, Phase 7 §10.2) is one `WorkListKind` plus one membership clause.
- **Posting to GitHub** — replying to a review comment, resolving a thread, pushing a fix — is the
  deferred-poster component of `docs/DECISIONS.md:81-85`, restated as R55. The respond flow is
  designed to make it a *later, additive* step: the classification and the drafted replies already
  live in `COMMENTS.md` in the legacy per-entry shape, so a poster reads that file and needs no
  change to the brief, the mode or the schema.
- **Jira writes** (transition on merge, comment a review summary) would be the same deferred-poster
  pattern (`docs/DECISIONS.md:81-85`) — a separate component taking structured
  input. `JiraSource` is read-only on purpose so that component cannot be smuggled in.
- **A `WebviewViewProvider` serializer / restore-on-reload** for the panel and the tab (R39, R54).
- **Findings as cards** — `WorkItem` carries agents and artifact names, not parsed findings; a
  `GET /sessions/:id/findings` would be additive.
- **Pinned worktrees** — still one `planWorkspaceAction` change (Phase 7 R15).
