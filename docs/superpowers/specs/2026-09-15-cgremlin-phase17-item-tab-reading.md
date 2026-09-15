# Phase 17 — the artifacts say what they found, and the item tab lets you read it

Repo @ `f8dbbee`, read-only. Paths absolute under `/Users/guilherme.azoubel/context-gremlin/cgremlin/`.
Two halves, designed together: **the contract** the agents write to (§4) and **the tab** that reads it (§1-§3).
The tab can only make good use of the data if the data has a shape.

Speaks phase 11's language (`docs/superpowers/specs/2026-09-14-cgremlin-phase11-panel-redesign.md`):
identity-first, typographic marks not emoji in chrome, `--vscode-*` tokens only, CSP verbatim,
`textContent` only, no `title` attributes, ARIA, zero mutations on identical data.

## 0. What is wrong, read in the code

| Symptom | Cause |
|---|---|
| Title printed twice | `vscode/src/webview/item-tab.ts:52` `h1 = current.title`, where `title` is `labelOf` = `` `${key} — ${summary}` `` (`core/src/work/work-item.ts:681`); then `item-tab.ts:219` `h2 = ${ticket.key} — ${ticket.summary}`. A **third** copy is inside every artifact: the review contract's first line is `# PR Review: #<n> — <title>` (`core/src/pipeline/prompts.ts:245`). |
| Description is a grey monospace box | Not markdown-it, not `html-to-text`. Literal: `item-tab.ts:224` `el('pre','ticket-description')`, styled `background: var(--vscode-textCodeBlock-background)` with the UA's monospace `pre` default (`media/item-tab.css:182-189`). Comments the same (`:229`). `renderInline` exists for exactly this and is never called (`webview/markdown.ts:40`). |
| `[image]` | `core/src/jira/html-to-text.ts:97-99`: `<img>` → `[image: alt]` or `[image]`, and the `src` is discarded. Jira's `renderedFields` attachment markup carries no `alt`, so every image is the bare word. |
| `UAT · 712020:f0ac…` | `core/src/jira/jira-rest-source.ts:55` types `assignee` as `{accountId?}` only; `:337` takes `accountId`. The field **is** requested (`:24`) and Jira's payload carries `displayName` — the adapter drops it. Proof it is available: the comment mapper on the same page uses `c.author?.displayName` (`:309`), as does `whoami` (`:325`). |
| One unbroken scroll | `item-tab.ts:234-259` appends focus section **and** ticket section into one document; `ItemFocusMessage` (`model/item-tab-protocol.ts:13-16`) can address agent/ticket/pr, never one artifact. |
| Three equal buttons, Chat dead and silent | `ui/item-tab.ts:475-478` discards `RowAction.placement` (`model/row-actions.ts:42-50`). `Open <prLabel>` and `Open <ticketKey>` (`row-actions.ts:261,271`) **duplicate the chips** already built at `ui/item-tab.ts:276-278`. Chat is disabled with a reason only for `respond`+`triaging` (`:454-467`); with **no agent at all** it is disabled with `reason: undefined`, so `webview/item-tab.ts:99-102` prints nothing. That is the screenshot. |
| The data is there and unused | A review carries a verdict, per-finding severities, `path:line` references and a status per finding (`prompts.ts:240-317`). The tab renders all of it as undifferentiated markdown. |

## 1. Reading layout

One part on screen at a time. Order of parts, fixed: **Review → Findings → Plan → Development → Comments →
QA → Brief** (the selected agent's artifacts, `model/artifact-labels.ts:52` `PRIMARY_ORDER`, primary first,
brief last) → **Ticket** → **PR** (one per `item.prs`). `artifactRole` gains `development` for
`DEVELOPMENT.md`, which the API already serves (`core/src/api/validation.ts:107`) and which today falls to
`other`. The pane opens on `resolveFocus`'s answer (`ui/item-tab.ts:418-435`), extended so an agent focus
resolves to that agent's primary artifact.

Top to bottom: sticky header (title, chips) · action row · part switcher (sticky) · agent switcher (only when
`agents.length > 1`) · the selected pane. No footer.

```
~700px
┌──────────────────────────────────────────────────────────────────────┐
│ HB-1489  Add web-content read endpoint to the Grace backend          │ 17px/600
│ HB-1489   grace-backend #2180                                        │ chips, links
├──────────────────────────────────────────────────────────────────────┤
│ [Address review comments]  [Chat]                                    │ primary, inline
├──────────────────────────────────────────────────────────────────────┤
│  Review    Findings    QA    Brief    Ticket    #2180                │ tablist, sticky
│ ━━━━━━━                                                              │ 2px focusBorder
├──────────────────────────────────────────────────────────────────────┤
│ ▍Request changes — the endpoint ignores the locale parameter         │ verdict strip
│ ▍Ticket: mostly    2 critical   1 high   3 maintainability           │ 11px counts
│                                                                      │
│ Summary                                                              │ h2 1.15em/700
│ This PR adds a public read endpoint for web content. It works for    │ 72ch, 1.6
│ the default locale and drops the locale segment everywhere else.     │
│                                                                      │
│ What I found                                                         │
│ ┌───┬────────────────┬──────────────────┬──────────────────────────┐ │
│ │ 1 │ ● Critical     │ web-content.ts:88│ locale param is dropped  │ │ file ref = link
│ │ 2 │ ● Maintainab.  │ ui/list.tsx:40   │ route and mapper mixed   │ │
│ └───┴────────────────┴──────────────────┴──────────────────────────┘ │
│ 1. Locale parameter is dropped before the query                      │ h3 1em/600
│ Severity ● Critical   Where web-content.ts:88   Status open          │
└──────────────────────────────────────────────────────────────────────┘

~400px                                   Ticket pane, ~400px
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│ HB-1489  Add web-content read      │   │  … Ticket  #2180                   │
│ endpoint to the Grace backend      │   │ ━━━━━━                             │
│ HB-1489  grace-backend #2180       │   ├────────────────────────────────────┤
├────────────────────────────────────┤   │ UAT · Guilherme Azoubel            │
│ [Address review comments]          │   │                                    │
│ [Chat]                             │   │ We need a read-only endpoint that  │ prose
├────────────────────────────────────┤   │ returns web content by slug.       │
│ ‹ Review  Findings  QA  Brief… ›   │   │                                    │
│ ━━━━━━                             │   │ • Must accept a locale             │
├────────────────────────────────────┤   │ • Must 404 on an unknown slug      │
│ ▍Request changes — the endpoint    │   │                                    │
│ ▍ignores the locale parameter      │   │ Image: endpoint-shape.png ↗        │ link
│ ▍2 critical  1 high  3 maint.      │   │                                    │
│                                    │   │ ▸ 4 earlier comments               │ collapsed
│ Summary                            │   │ Ana Silva · 12 Aug                 │ newest open
│ This PR adds a public read         │   │ Please keep the slug case-sensit…  │
└────────────────────────────────────┘   └────────────────────────────────────┘
```

**Open by default:** the selected pane in full, the newest ticket comment, every finding detail.
**Collapsed by default:** ticket comments 2..n behind one `▸ N earlier comments` disclosure.
Nothing else collapses — an artifact is a pane now, so the `<details>` accordion at
`webview/item-tab.ts:126-139` is deleted. `BRIEF_ONLY_NOTICE` (`artifact-labels.ts:77`) moves onto the
Brief pane, above the body, unchanged.

## 2. Navigation — a segmented part switcher

**Chosen: an ARIA `tablist` of the item's parts, sticky under the action row, one horizontally scrollable
line (`overflow-x:auto`, never wrapping), showing exactly one pane.** It extends the focus union the tab
already has (`item-tab-protocol.ts:13`) with `{ kind:'artifact'; sessionId; name }`, so the host's existing
`setFocus` path (`ui/item-tab.ts:240-244`) carries it.

Keyboard: roving `tabindex` (one tab stop, like `panel/row.ts`); `ArrowLeft`/`ArrowRight` move and select;
`Home`/`End` jump to first/last; `Enter`/`Space` are no-ops because arrow-select already acted. Each tab is
`role="tab"` with `aria-selected` and `aria-controls`; the pane is `role="tabpanel"`, `tabindex="-1"`, and
takes focus on selection so a screen reader lands on the new content. Selecting a part scrolls the pane to
the top; a previous pane's scroll offset is not restored — a different document is a different place.

Inside a long review, navigation is the document's own contents: the contract's `## What I found` table
links each row as `[N](#fN)` (§4) and `webview/markdown.ts:31-37` already synthesises the `<span id="fN">`
targets. The webview intercepts clicks on `a[href^="#"]` inside `.artifact-body`, `preventDefault`s, and
`scrollIntoView({block:'start'})`s the matching id in the same pane — no navigation, no history entry.

Why the others lose. **A sticky contents rail** costs ~176px, 44% of a 400px pane, and restates the findings
table the review already prints — two contents for one document. **A `Jump to…` `<select>`** hides the
item's shape: you cannot see a QA report exists until you open the list; phase 11 chose a select for the
300px sidebar precisely because six sections would not fit, and the tab has the width the sidebar did not.
**In-document anchors alone** leave the unbroken scroll the user complained about. The switcher is the only
option that *removes* content from the screen, which is the actual complaint.

## 3. Reading the structure

New pure module `vscode/src/model/artifact-outline.ts` (DOM-free, `vscode`-free, MG-B1), parsing the §4
contract and its legacy forms. Never guesses.

| Export | Rule |
|---|---|
| `stripLeadingH1(text)` | First block is `# …` → `{ title, body }` with it removed |
| `verdictOf(text)` | `^\*\*Verdict:\*\*\s*(.+)$`, else the first non-empty line under `^## Verdict$`, else `^\s*-\s*Verdict:\s*(.+)$` (the frozen QA block, §4a) |
| `ticketAnswerOf(text)` | `^\*\*Does it do what the ticket asked\?\*\*\s*(.+)$` |
| `findingsOf(text)` | `<a id="fN"></a>` + `### N. <title>` + the field lines; accepts the new one-field-per-line form **and** the legacy three-fields-on-one-line form (§4d) |
| `severityCountsOf(text)` | Counts finding **details**, never the summary table, which would double-count |
| `fileRefOf(text)` | `^([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-L?\d+)?$` → `{path, line}`, else `null` |

Tone from the glyph, mapped once: `✅` pass · `❌` fail · `🚧` blocked · `⚠️`/`🔄` mixed · `💬` neutral.
Severity glyphs `🔴 🟠 🟡 🔧 📋 🎨` map to the words `Critical High Perf Maintainability PM/AC Design`;
the chrome prints the **word** with an 8px dot, never the emoji (phase 11 §2).

**The verdict strip**, above the fold, is the first child of every artifact pane that has a verdict: line 1
the verdict label and its sentence; line 2 the ticket answer (reviews only) and the severity counts as
`2 critical   1 high   3 maintainability`, gap-separated, no `·`, zero counts omitted.

**File references become links.** After `innerHTML = renderArtifact(...)` the webview walks
`.artifact-body code` (skipping any whose `parentElement` is a `PRE`) and, where `fileRefOf` answers,
replaces the `<code>` with `<button class="file-ref">` carrying the same `textContent`. A click posts
`{ type:'openFile', path, line }`; the parser in `model/item-tab-protocol.ts` accepts it only with a
non-empty string `path` and an integer `line ≥ 1`. Host guard in `ui/item-tab.ts`, all four required: the
selected agent exists and its `worktreePath !== null`; `path` is relative (`!path.startsWith('/')`, no `..`
segment after normalisation); the resolved path is inside the worktree (`resolved === root ||
resolved.startsWith(root + '/')`); `host.fileExists(resolved)`. Any failure is one
`host.showWarningMessage` naming the path and no open. `Host.openTextDocument(path, line?)` gains the
optional line; the adapter at `vscode/src/extension.ts:427-430` sets
`selection = new vscode.Range(line-1, 0, line-1, 0)` on `showTextDocument`.

**Degrading.** No verdict → no strip. No findings → no counts. An artifact that parses to nothing renders
exactly as today's markdown under its role label (`artifact-labels.ts:42`). The tab never prints
`0 findings` for a file it could not parse — an absent strip says "unstructured", a `0` would say "clean".

## 4. The artifact contract

### 4a. Frozen — the engine parses these, byte for byte

Read before touching: `core/src/pipeline/artifacts.ts`. **No change may alter any of these.**

| Marker | Parser | Rule |
|---|---|---|
| `## Review Status` in PLAN.md, with `- PM: ✅ …` and `- Principal Engineer: ✅ …` | `artifacts.ts:19-38` | `^#{2,3} Review Status:?\s*$` must match **exactly once** in the file; the two `✅` lines are read only to the next `^#{1,3} ` heading |
| `## Unresolved Review Disagreement` | `artifacts.ts:25` | exact `^## Unresolved Review Disagreement\s*$` |
| `## QA Verdict` + `- Verdict: ✅｜❌｜🚧` in QA.md | `artifacts.ts:79-101` | heading must match **exactly once**; glyph on the `- Verdict:` line decides `ready｜not_ready｜blocked` |
| `rereview_summary`, one line `✅ N/N resolved` or `⚠️ K/N resolved, M new` | `artifacts.ts:55-59` | single line, no other content |
| Filenames `FINDINGS｜PLAN｜DEVELOPMENT｜REVIEW｜RE-REVIEW｜BRIEF｜COMMENTS｜QA｜REVIEW-v<N>｜QA-v<N>.md`, `AGENT_STATE`, `AGENT_NOTE`, `PR_URL` | `api/validation.ts:107`, `artifacts.ts:69-77` | nothing is renamed, nothing is added |
| REVIEW.md non-empty = the run succeeded | `artifacts.ts:50-53` | unchanged |
| `redactSecrets` on every artifact read | `api/server.ts:520` | the tab reads only through this route; no new read path |

Consequence the executor must honour: the new top-of-file verdict line (§4b) uses `**Verdict:**` — a **bold
line, not a heading** — so it can never be mistaken for `## QA Verdict` and can never make that heading
match twice. Nothing new may introduce a second `## Review Status` or `## QA Verdict` at depth 2-3.

### 4b. The header block — the first three lines of every artifact

```
# <Role> — <subject>
**Verdict:** <glyph> <Label> — <one sentence, plain English>
**Scope:** <one line: what was examined>
```

Fixed verdict vocabulary per role — the tab maps the glyph to a tone and prints the label as written:

| Artifact | Labels |
|---|---|
| REVIEW.md, RE-REVIEW.md | `✅ Approve` · `🔄 Request changes` · `💬 Comment` |
| FINDINGS.md | `✅ Root cause found` · `⚠️ Partial` · `❌ Not reproducible` |
| PLAN.md | `✅ Approved` · `🚧 Under review` · `❌ Unresolved disagreement` |
| DEVELOPMENT.md | `✅ Implemented` · `🚧 In progress` · `❌ Blocked` |
| COMMENTS.md | `✅ All threads triaged` · `🚧 N of M triaged` |
| QA.md | `✅ Ready to deploy` · `❌ Not ready` · `🚧 Blocked` (already at `prompts.ts:762`) |

REVIEW.md keeps `**Does it do what the ticket asked?**` as line 4 (`prompts.ts:247`) and **loses** the
trailing `## Verdict` section (`prompts.ts:304`) — nothing in code parses it (`artifacts.ts:50-53`), and one
verdict in one place is the point. PLAN.md's header verdict is written by the drafting agent and is
advisory; the engine still decides from `## Review Status` alone.

### 4c. Stable section headings

Fixed set, fixed order, no extras, so the outline and the anchors are stable across runs.

- **REVIEW / RE-REVIEW:** `## Summary` · `## What I found` · `## Details` · `## Review History`
- **FINDINGS:** `## What's happening` · `## Root cause` · `## Affected files` · `## Risks` · `## Direction`
  (today the same five exist as bold bullets, `prompts.ts:355-359` — promoted to headings)
- **PLAN:** `## Review Status` (frozen, stays at the top) · `## What will be modified` · `## How it works` ·
  `## How it is tested` · `## Scope boundary`
- **DEVELOPMENT:** `## What changed` · `## How it was verified` · `## Follow-ups`
- **COMMENTS:** `## Threads` (one `### <thread id>` each, shape unchanged, `prompts.ts:545-555`)
- **QA:** `## Acceptance criteria` · `## Checks` · `## Problems found` · `## QA Verdict` (frozen, last)

### 4d. The finding shape — one field per line

Replaces the three-fields-on-one-line form at `prompts.ts:271,282,777`, which no line-anchored regex can
split reliably.

```
<a id="f1"></a>
### 1. <plain-English title of the problem>
- **Severity:** 🔴 Critical
- **Where:** `path/to/file.ext:88`
- **Status:** open
- **Link:** https://github.com/<owner>/<repo>/blob/<sha>/path/to/file.ext#L88

**What's wrong:** …
**Why it matters:** …
**Suggested fix:** …
```

- **`Where` is code only** — a backticked repo-relative `path:line` or `path:start-end`, and nothing else.
  A PM/AC or Design finding uses `- **Route:** /search — PrimaryButton` instead, and omits `Where`. This is
  the single change that makes `fileRefOf` exact rather than heuristic.
- Severity vocabulary unchanged (`prompts.ts:230-235` review, `:777` QA), so no downstream reader moves.
- `Status` values unchanged (`prompts.ts:316`), still mirrored in the `## What I found` table row.
- Anchors `f1..fN` (review) and `q1..qN` (QA) stay stable across re-reviews — already the rule
  (`prompts.ts:315`), now also what the tab's intra-document navigation depends on.

### 4e. Artifacts written before this contract

They exist in `~/.cgremlin/sessions` today and must read acceptably. The rule is **parse, never assume**:

- No `**Verdict:**` line 2 → `verdictOf` falls through to `## Verdict` (old reviews) and to
  `- Verdict:` (old QA), so an old file still gets a strip, lifted from the bottom.
- Legacy inline finding line `**Severity:** 🔴 Critical   **Where:** \`f.ts:88\`   **Status:** open` is
  accepted by `findingsOf` as a second alternative; both forms are pinned by fixtures (MG-17j).
- Neither form present → no strip, no counts, no outline; the pane is the rendered markdown under its role
  label. The tab states nothing it did not read.
- Old `## Verdict`-at-the-bottom reviews keep rendering that section; the tab does not remove it, so an old
  file is never silently truncated.

### 4f. Making agents produce it

Every prompt/brief edit below is written with the **`/prompt-master`** skill — that is a requirement of the
task, not a suggestion.

| File | What changes |
|---|---|
| `core/src/pipeline/prompts.ts` `renderReviewContract()` (`:241-317`) | header block, section list, one-field-per-line findings, `## Verdict` removed |
| `core/src/pipeline/prompts.ts` `qaOutputContract()` (`:534-560`) | header block and finding shape; `## QA Verdict` block untouched |
| `core/src/pipeline/prompts.ts` `COMMENTS_MD_SHAPE` (`:545-555`) | header block above the threads |
| `core/src/pipeline/prompts.ts` `renderFindingsBrief` (`:355-359`), plan block (`:380-401`) | bold bullets promoted to `##` headings; `## Review Status` shape untouched |
| `core/skills/qa-verify/SKILL.md` | the QA output shape it carries moves in lockstep, the way `QA_CONDUCT_RULE` already does |
| The configured review skill (`reviewSkillCommand`, default `/APFM:apfm-review`, `config/core-config.ts:145`) | **outside this repo — not edited.** Instead `renderReviewPrompt` (`prompts.ts:484-491`) says the brief's contract overrides the skill's own output shape: *"Run `<skill>`. Whatever shape it proposes, `REVIEW.md` must match the contract in `<sessionDir>/BRIEF.md` exactly — that contract is what the engine and the editor read."* The contract itself already reaches the brief via `renderReviewContract()` (`prompts.ts:462,478`). |

**Anti-drift guard (MG-17k).** The contract's own worked example is the parser's fixture. Export
`REVIEW_CONTRACT_EXAMPLE`, `QA_CONTRACT_EXAMPLE` and `PLAN_REVIEW_STATUS_EXAMPLE` as named consts,
interpolate them into the prompts, and assert: (a) `renderReviewContract()` / `qaOutputContract()` contain
the const byte-identical — the `QA_CONDUCT_RULE` pattern (`core/test/skills/qa-verify-skill.test.ts:51-58`), with
`<!-- MARKER:START -->` / `<!-- MARKER:END -->` fences in `SKILL.md`; (b) `parseQaVerdict(QA_CONTRACT_EXAMPLE) === 'ready'` and
`parsePlanReviewStatus(PLAN_REVIEW_STATUS_EXAMPLE) === 'approved'`; (c) the extension's
`findingsOf(REVIEW_CONTRACT_EXAMPLE)` returns the four findings with their severities and `fileRefOf`
answering on each `Where` — a cross-package test, in the existing `vscode/test/cross-package-guards.test.ts`.
The contract cannot change without the parsers being re-proved in the same commit.

## 5. The four defects

**a. One title.** The `<h1>` in `header()` (`webview/item-tab.ts:52`) is the only title in the document.
`ticketSection`'s `<h2>` (`:219`) is deleted — the pane is named by its tab, the summary is in the header.
Every artifact pane's body goes through `stripLeadingH1`; the stripped text is discarded, not re-printed.

**b. Ticket prose is prose.** Root cause is `el('pre','ticket-description')` at `webview/item-tab.ts:224`
plus `media/item-tab.css:182-189`, **not** the core. Fix in the webview: `div.ticket-description` with
`innerHTML = renderInline(ticket.descriptionText ?? '')` (`webview/markdown.ts:40`, tagged SAFE_HTML like
`:136`); comments the same. Drop `.ticket-description, .ticket-comment pre` from the code-block rule, which
then applies only to real fenced blocks — `html-to-text.ts:133-136` already emits ``` fences for `<pre>`, so
a Jira code sample still renders as code, and only as code.

**c. Images.** Core, `jira/html-to-text.ts:97-99`. Emit `[image: <alt>](<src>)` when a `src` resolves, `alt`
falling back to the last path segment of the `src` and then to `image`; `[image: <alt>]` with no `src`, and
`[image]` only when there is neither. A relative `src` is absolutised against `siteUrl`, so `htmlToText`
takes it as a second parameter defaulting to `null` — every existing caller and test is unchanged. R33 holds:
a URL is not HTML, and no identifier under `src/jira` gains the four letters MG-10 greps for. The webview
never fetches it (`img-src 'none'`, `ui/item-tab.ts:41`); it is a link, and a click posts `openLink`, which
`ui/item-tab.ts:245-247` already routes to `openExternal` where the user's Jira session authenticates.

**d. The assignee has a name.** Core. `JiraIssueSummary` gains `assigneeName: string | null`
(`jira/jira-source.ts:12-22`); `RawIssue.fields.assignee` widens to `{accountId?; displayName?}`
(`jira-rest-source.ts:55`); `toSummary` (`:337`) keeps `assignee: accountId` **unchanged** and adds
`assigneeName: fields.assignee?.displayName ?? null`. `assignee` must stay the accountId — it is compared
against `jira.me` in `qa/qa-trigger.ts:165,372` and `work/work-item.ts:382,620,653`.
`JiraIssueSummarySchema` (`jira/jira-store.ts:29-32`) gains `assigneeName: z.string().nullable().default(null)`
so a cached report from an older build still parses. The field rides `GET /items/<path>`'s opaque `ticket`
(`api/server.ts:1066`) into `TabTicket` (`item-tab-protocol.ts:56-64`). The pane prints
`assigneeName ?? assignee ?? ''` — the id is the honest fallback, never hidden.

## 6. The action row

`buttonsFor` (`ui/item-tab.ts:452-480`) keeps `RowAction.placement` instead of discarding it, and drops
`cgremlin.openPr` / `cgremlin.openTicket` entirely — those are the chips (`:276-278`), and rendering them
twice is what made three buttons look equal. Left to right: **one `primary`** (filled,
`--vscode-button-background`), then `inline` (bordered, `--vscode-button-secondaryBackground`), then `Ack`
when `needsYou`. `overflow` actions are not rendered in the tab.

Chat: with no selected agent it is **not rendered at all** — the rows' own rule (`row-actions.ts:124`
`chatTargetOfAgents`). It renders disabled in exactly one case, `respond` + `triaging`
(`ui/item-tab.ts:454-456`), and the reason line (`webview/item-tab.ts:99-102`) reads: *"Chat opens once the
respond agent has written up the review threads. It is still triaging them."* Every disabled button carries
a `reason`; `buttonsFor` may never emit one without it.

## 7. Type, spacing, colour

`max-width: 72ch` on `.artifact-body`, `.ticket-description`, `.ticket-comment` — measured on
`--vscode-font-family`, which is sans, so `line-height: 1.6` (1.5 today, `media/item-tab.css:16`). Tables and
`<pre>` opt out with `max-width:none` and keep `overflow-x:auto`.

Scale, only these six: title `calc(var(--vscode-font-size,13px)*1.3)`/600 · pane `h2`
`calc(var(--vscode-font-size,13px)*1.15)`/700 · `h3` `1em`/600 · body `var(--vscode-font-size,13px)`/400 ·
`h4`, tabs, table cells `12px`/400, sentence case, never caps · counts, chips, mtime, session id `11px`/400.
Headings `margin: 20px 0 6px`, `h3` `16px 0 4px`, first heading in a pane `margin-top:0`. Spacing scale, only
these: `2 4 8 12 20`.

Code inside a review: `--vscode-textCodeBlock-background`, 8px padding, `white-space: pre-wrap`,
`font-family: var(--vscode-editor-font-family, monospace)` at `0.92em` — the one place monospace is correct,
which is the contrast defect (b) destroys. Inline `<code>` takes the same face with no background, so
`file.ts:88` reads as an address and not as a box. `.file-ref` is a borderless `<button>` in
`--vscode-textLink-foreground`, underlined on hover, `:focus-visible { outline: 1px solid
var(--vscode-focusBorder) }`.

Tables: `border-collapse: collapse`, 1px `--vscode-panel-border`, 4px/8px cells, header row
`--vscode-editorWidget-background` at weight 600, `tabular-nums` on the `#` column.

Colour: tokens only, no hex, no palette invented. Verdict tone on the strip's 3px left rule and its label —
pass `--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-descriptionForeground))`; fail
`--vscode-errorForeground` (already in use, `media/item-tab.css:215`); blocked and mixed
`--vscode-notificationsWarningIcon-foreground` (phase 11's one accent); neutral
`--vscode-descriptionForeground`. Severity dots reuse those three plus `--vscode-descriptionForeground` for
Maintainability, PM/AC and Design. Strip background `color-mix(in srgb, <tone> 10%, transparent)` — phase 11's
badge recipe. `--vscode-charts-red` stays reserved for CI. The strip carries `role="status"`, so the verdict
is announced when the pane changes.

## 8. Guards

- **MG-17a title-appears-once** — a state whose `title`, `ticket.summary` and artifact `# ` heading are the
  same string yields exactly one element with that text.
- **MG-17b ticket-prose-is-not-preformatted** — no `PRE` ancestor for the description or a comment body;
  `- a\n- b` yields two `LI`; a ``` fence still yields one `PRE`.
- **MG-17c verdict-above-the-fold** — for a QA body and a review body the pane's first child is
  `.verdict-strip` with the verdict's own sentence and `role="status"`; an artifact with no verdict renders
  no strip and no zero counts.
- **MG-17d file-refs-are-links** — `` `web-content.ts:88` `` in a `Where` line becomes `BUTTON.file-ref`; the
  same text inside a fenced block stays `CODE` inside `PRE`; a click posts `{type:'openFile',path,line:88}`.
  Host half: `../../etc/passwd`, an absolute path, and a null `worktreePath` each produce zero
  `openTextDocument` calls and one warning.
- **MG-17e zero-mutations-on-identical-data** — the same `render` twice, and a `patch` with byte-identical
  text, mutate no node; selected tab, pane scroll offset and focused element unchanged.
- **MG-17f no-tooltips** — extends `test/webview/no-tooltips.test.ts`: `.title =` in `src/webview/**` only as
  `document.title`, switcher and file-ref buttons included.
- **MG-17g csp-unchanged** — `cspFor` (`ui/item-tab.ts:38-43`) byte-identical; one nonce'd `<style>`, one
  nonce'd `<script>`.
- **MG-17h assignee-name** — `fields.assignee` with both fields yields both; `assignee` still equals the
  accountId; a cached report without `assigneeName` parses.
- **MG-17i no-bare-image** — `htmlToText('<img src="/x/a.png">')` contains the src, not the bare `[image]`;
  an `<img>` with neither is exactly `[image]`.
- **MG-17j legacy-artifacts-degrade** — fixtures of a pre-contract `REVIEW.md` and `QA.md` from
  `~/.cgremlin/sessions` shape: the strip is lifted from the trailing `## Verdict` / `- Verdict:`, legacy
  inline findings parse, and a plain-prose artifact yields no strip, no counts and no fabricated zero.
- **MG-17k contract-and-parser-cannot-drift** — §4f(a)(b)(c): byte-identity of the example consts in the
  prompts and in `qa-verify/SKILL.md`, and the engine + extension parsers proved against those same consts.
- **MG-17l frozen-markers** — `renderReviewContract()`, `qaOutputContract()` and the plan block each contain
  exactly one `## QA Verdict` / `## Review Status` at depth 2-3, and `parseQaVerdict` /
  `parsePlanReviewStatus` still return `ready` / `approved` on the rendered text.
- **MG-B1 / MG-10 unchanged** — `model/artifact-outline.ts` never mentions `vscode`; no identifier under
  `core/src/jira` ends in the four letters MG-10 greps for.

## 9. Tasks

Tier A is what the user pointed at; B is the structure A rests on; C is core; **P is written with
`/prompt-master`**.

| # | Tier | Where | Task | Guard |
|---|---|---|---|---|
| 1 | C | core | `assigneeName` through `jira-source.ts`, `jira-rest-source.ts:55,337`, `jira-store.ts:29` | MG-17h |
| 2 | C | core | `htmlToText(html, siteUrl?)` emits `[image: alt](src)`; adapter passes `siteUrl` | MG-17i |
| 3 | P | core | The §4 contract in `prompts.ts` (review, QA, comments, findings, plan) + example consts | MG-17k, MG-17l |
| 4 | P | core | `skills/qa-verify/SKILL.md` moved in lockstep behind `<!-- MARKER -->` fences | MG-17k |
| 5 | P | core | `renderReviewPrompt` says the brief's contract overrides the external skill's shape | MG-17k |
| 6 | B | ext | `model/artifact-outline.ts` — the six parsers of §3, both finding forms | MG-17j |
| 7 | B | ext | `artifactRole` gains `development`; focus union gains `{kind:'artifact'}`; `resolveFocus`/`selectedFor`/parser follow; `ItemTabState` carries the ordered part list | `item-tab-protocol.test.ts`; unknown artifact focus falls back to primary |
| 8 | A | ext | Part switcher: tablist DOM, roving keyboard, one pane, sticky | new `test/webview/item-tab-parts.test.ts`; MG-17e |
| 9 | A | ext | Ticket pane: prose via `renderInline`, assignee name, comments 2..n collapsed, no `h2` | MG-17a, MG-17b |
| 10 | A | ext | Artifact pane: `stripLeadingH1`, verdict strip, severity counts, no `<details>` | MG-17c |
| 11 | A | ext | File refs → buttons; `openFile` message + parser; host guard; `openTextDocument(path,line)` + `extension.ts:427` | MG-17d |
| 12 | A | ext | Action row: keep `placement`, drop the two `Open …`, hide Chat with no agent, new copy | `ui/item-tab.test.ts`: a ticket-only item renders no Chat; exactly one filled button |
| 13 | A | ext | `media/item-tab.css` rewritten to §7 | MG-17f, MG-17g |

Order: 1-2 ship alone. 3-5 ship together (the contract and its guards in one commit). 6-7 before 8; 8 before
9-11; 12-13 last. The tab (6-13) does **not** wait on 3-5 — §4e is why it can read today's files.

Risks. **(3) is the largest**: it edits the strings the engine's completion detection reads. `## Review
Status` and `## QA Verdict` are frozen (§4a) and MG-17l is the proof; anything that makes either heading
match twice silently turns a finished run into `missing`. **(7)** — `ItemFocusMessage` is parsed from
untrusted webview input (`item-tab-protocol.ts:110+`) and drives the worktree swap
(`ui/item-tab.ts:377-386`); a focus that no longer resolves to an agent must still swap correctly, so do 7 in
one commit with its parser test. **(2)** changes a function every brief depends on (`prompts.ts:134`); the
new parameter must default. **(10)** deletes the `<details>` accordion that
`test/webview/item-tab-artifacts.test.ts` asserts on — rewrite that file rather than amend it. Nothing here
touches `bin/cgremlin`, so the bash↔Python-heredoc sync is not in play.
