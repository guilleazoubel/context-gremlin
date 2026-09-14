# Phase 11 — the panel says what it is, once, in ink

Repo @ b8f0e93, read-only. Paths absolute under `/Users/guilherme.azoubel/context-gremlin/cgremlin/vscode/`.
Ground truth for every claim is cited. **No core change**: every field used below already crosses the wire
(`core/src/work/work-item.ts:41-105`).

## 0. What is actually wrong (evidence)

| Complaint | Cause, read |
|---|---|
| "on hover it shows the popup" | The DOM `title` attribute. `src/webview/panel/cells.ts:25` `setTitle(node, cell.title ?? '')`, setter at `src/webview/panel/reconcile.ts:53`. Producers: `src/model/work-items.ts:691,698` (ISO date behind the age), `:706` (the size string behind the tier), `:734` `ciCell` — `text: ''`, meaning **CI is hover-only**. Three more in the item tab: `src/webview/item-tab.ts:64,81,96`. |
| "titles almost the same" | `labelOf` (`src/model/work-items.ts:531-546`) builds `grace-frontend#4821 — Fix pagination on the offer list`. The repo prefix is 14 identical characters on every row and `.row-label` is `nowrap; ellipsis` (`media/panel.css:398-404`), so the *number* — the only difference — survives but the differentiating tail dies. |
| "options that don't apply" | Mostly fixed in phase 10 (`src/model/row-actions.ts:114-199`), but `expanded.ts:142-161` renders **all three** lifecycle slots always, including `Investigation / not started` on a teammate's PR. The rule exists (`nextStages`, `row-actions.ts:98-111`); the view ignores it. |
| "can't separate the sections" | One colour per *list* (4), on the header glyph and a 2px row border (`media/panel.css:35-76`). The parking lot's three groups (`work-items.ts:405-409`) share one colour and a 11px grey header (`panel.css:292-303`). |
| "overwhelmed / narrow to one area" | No filter exists. `panelTreeNodes` (`src/model/panel-tree.ts:38`) always walks every list. |
| "breakpoints between items" | A single 1px hairline at 40% (`panel.css:26,335`) with zero gap. |

**Design-skill note:** the shipped panel is built on two treatments the frontend-design skill calls generic tells —
meta strings joined with `·` (`panel.css:420-425`) and `IDENT — fragment` titles (`work-items.ts:545`). They are also
*exactly* the user's "almost the same" problem. Both go. Type personality cannot come from a typeface here
(`font-src 'none'`, `src/ui/item-tab.ts:39`), so it comes from **scale, weight and tabular numerals** only.

## 1. Jobs

| Section | Job (one sentence) | The ONE thing the row answers |
|---|---|---|
| Parking lot | Pick the next teammate PR worth my hour. | How big and how old is it? |
| Reviewing | Track the reviews I already started. | Does it want me now? |
| Someone is on it | Confirm it is covered so I can skip it. | Who has it, and when? |
| My dev work | Know where my ticket stands without remembering. | Which stage is it in? |
| Investigations | Get back to what I asked Claude to look into. | Is it done? |
| Waiting for review | Learn the moment my PR gets an answer. | What landed, and from whom? |

## 2. Row anatomy, collapsed

Three lines, fixed order, fixed meaning. **Identity is not prose.**

- **L1 identity** — keys only, `tabular-nums`, 13px/600. PR → `#4821`. Ticket → `HB-627`. Both → `HB-627 #4821`.
  Investigations (no PR, no ticket) → the session title; that list is the one place the title *is* the identifier.
- **L2 description** — 12px/400 in `--vscode-foreground`. Ticket summary when a ticket exists, else the PR title,
  else empty (the line is then not rendered; it is not a blank gap).
- **L3 signals** — 11px/400 in `--vscode-descriptionForeground`. First token is **the repo's last path segment**
  (`repo.split('/').pop()`), and it is the only shrinkable child. Then fixed tokens, in this order, right-packed.

**Truncation rule.** On every line exactly one child carries `min-width:0; overflow:hidden; text-overflow:ellipsis`;
every other child is `flex:0 0 auto`. L1 never truncates (≤14 chars by construction). On L2 the description shrinks.
On L3 the repo shrinks. Nothing wraps, ever. `.cell-size` is hidden below a 380px container (§8), so the full
`43 files +900/−12` appears only when there is room; the tier badge `L` is always there.

Frames: 38 columns ≈ 300px sidebar; 64 columns ≈ 500px.

```
Parking lot / Someone is on it            300px │ 500px
┌──────────────────────────────────────┐  ┌──────────────────────────────────────────────────────────────┐
│▌#4821                                │  │▌#4821                                                        │
│▌Fix pagination on the offer list     │  │▌Fix pagination on the offer list so counts stay stable       │
│▌grace-frontend  @dtorres  12d  L  ●  │  │▌grace-frontend   @dtorres  12d  L  43 files +900/−12  ●      │
└──────────────────────────────────────┘  └──────────────────────────────────────────────────────────────┘
Reviewing                                 300px │ 500px
│▌#4103                                │  │▌#4103                                                        │
│▌Cache the availability lookup        │  │▌Cache the availability lookup for the search page            │
│▌grace  🔎 drafting  6d  ●            │  │▌grace            🔎 drafting  6d  M  9 files +210/−40  ●      │
My dev work                               300px │ 500px
│▌HB-627 #4821                         │  │▌HB-627 #4821                                                 │
│▌Offer list pagination is off by one  │  │▌Offer list pagination is off by one on the second page       │
│▌grace-frontend  In Review  🔨 coding │  │▌grace-frontend   In Review  🔨 coding  4d  M  ●              │
Investigations                            300px │ 500px
│▌Why does the offer cache thrash      │  │▌Why does the offer cache thrash on the second page          │
│▌🔍 done  3h                          │  │▌🔍 done  3h                                                  │
Waiting for review                        300px │ 500px
│▌HB-612 #4790                         │  │▌HB-612 #4790                                                 │
│▌Backfill the referral source column  │  │▌Backfill the referral source column for legacy rows          │
│▌grace  @jane requested changes  2d   │  │▌grace            @jane requested changes  2d  L  CI failing   │
```

Someone-is-on-it swaps `@author` for `@jane reviewed 2d` (`work-items.ts:655-677`); Investigations has no L2.
`▌` is the 3px section rule (§5). No `·` separators anywhere: tokens are separated by an 8px gap, and the
right-hand cluster lines up down the column so ten near-identical rows differ visibly at the number and the tier.

## 3. No tooltips

Every `title` assignment in `src/webview/**` is deleted, `setTitle` included (`reconcile.ts:53-55`), and
`RowMetaCell.title` is dropped from `src/model/work-items.ts:339`. `document.title` (`item-tab.ts:227`) is a window
title, not a tooltip, and stays.

| Hover string today | Where it goes |
|---|---|
| Full ISO behind the age (`work-items.ts:691,698,705`) | Submenu, PR part: `Opened 12 Aug` (`toLocaleDateString` host-side, absent → omitted). |
| `43 files +900/−12` behind the tier (`work-items.ts:706`) | L3 when the container is ≥380px, and always on the submenu's PR part. |
| `CI: success\|pending\|failure` (`work-items.ts:734`) | The cell gets text: `success` → the 8px dot alone; `pending` → `CI pending`; `failure` → `CI failing`. A green dot needs no word; a red one does. The cell also carries `aria-label`. |
| `chip.url` (`item-tab.ts:64`) | Deleted. The chip already names the PR; `aria-label="Open grace#4821 on GitHub"` replaces it. |
| A disabled button's `reason` (`item-tab.ts:81`) | A 11px line under the button group, in `descriptionForeground`. |
| `agent.sessionId` (`item-tab.ts:96`) | The agent pane's header line, as text. |

## 4. Click = submenu

A click on a row still posts one `selectRow` (`panel-protocol.ts:176`, `panel-view.ts:609-618`): select, accordion-expand,
swap the worktree. What it opens into stops being "three lifecycle slots + parts + people + changes" and becomes **one
list of the item's parts**, in this fixed order, each a row with its own state and its own buttons:

`Investigation → Development → Review → Jira ticket → PR (one per `item.prs`)`

| Part | Shown when | Hidden when | Buttons |
|---|---|---|---|
| Investigation | an investigation agent exists, **or** `nextStages(facts)` contains `investigation` (`row-actions.ts:98`) and the list is `myWork`/`investigations` | a PR exists and no investigation agent ran (R49, `row-actions.ts:155`); **always** in `parkingLot` and `waitingForReview` | `Open`, `Chat` (agent only); `Start investigation` only when `slot.start !== null` |
| Development | a development agent exists, **or** `nextStages` contains `development` and the list is `myWork`/`investigations` | `parkingLot` always — it is a teammate's PR; `waitingForReview` unless a dev agent of ours exists (then read-only) | `Open`, `Chat`; `Start development` when allowed |
| Review | `parkingLot`/`Reviewing`: always. `myWork`: when `nextStages` contains `review` or a review agent exists. `waitingForReview`: only when a `review` or `respond` agent exists, or `addressReview` is offered | `investigations` always (no PR to review) | `Open`, `Chat`; `Start review` / `Start self-review` / `Address review comments` — the label comes from `rowActions`, never invented here |
| Jira ticket | `item.ticket !== null` | otherwise | `Open` (item tab), `Open in Jira` |
| PR | one per entry in `item.prs` | `item.prs.length === 0` | `Open` (item tab), `Open on GitHub` |

**State text** per part: agent parts reuse `lifecycleSlots` verbatim (`src/model/lifecycle.ts:110-121`) —
`not started` / `running · coding` / `needs you · review` / `done · 2h`. Ticket part: `In Review`
(`ticket.status`). PR part: `open · 43 files +900/−12 · CI failing · Opened 12 Aug`, built from
`prState` (`work-items.ts:1024`), `sizeOf` (`:595`), `ci`, `createdAt`.

**Forward-only lifecycle is unchanged.** `furthestStage`/`nextStages` (`row-actions.ts:87-111`) stay the only rule;
a part behind the furthest stage shows state and `Open`/`Chat` but never a `Start`, and a part ahead of the next
allowed stage is not rendered. `Chat` is hidden exactly where `chatTargetOfAgents` refuses (`row-actions.ts:124`).

**Everything else in the expanded block is subtracted.** `people` (`expanded.ts:112`) folds into the PR part's
second line. `changes` stays, as one line at the foot. `leftoverActions` (`expanded.ts:97`) must now subtract part
actions too, leaving `Ack` — and `Ack` renders only when `needsYou && !acked`.

## 5. Sections

Six first-class sections. The parking lot's three groups (`work-items.ts:405-409`, `panel-tree.ts:44-61`) are
**promoted** to sections in the view model (`panel-view.ts:348-381`); core membership is untouched.

| Section | key | Colour token |
|---|---|---|
| Parking lot | `parkingLot:untouched` | `--vscode-charts-blue` |
| Reviewing | `parkingLot:reviewing` | `--vscode-charts-purple` |
| Someone is on it | `parkingLot:someoneOnIt` | `--vscode-charts-foreground` |
| My dev work | `myWork` | `--vscode-charts-green` |
| Investigations | `investigations` | `--vscode-charts-orange` |
| Waiting for review | `waitingForReview` | `--vscode-charts-yellow` |

`--vscode-charts-red` is reserved: it never marks a section, only a failing CI.

The colour is carried by **the 3px left rule on the header and on every row of the section, the header glyph, and the
count badge's background** (`color-mix(in srgb, <token> 22%, transparent)`, text `--vscode-foreground`). The header
*text* stays `--vscode-sideBarSectionHeader-foreground`: yellow and green titles fail contrast on a light theme, and
size plus weight already make it stand out.

Header: `calc(var(--vscode-font-size, 13px) * 1.15)` (≈15px, up from 11px), weight 700, sentence case — never all caps.
10px vertical padding. `position: sticky; top: 0; z-index: 3` — one sticky level now that groups are sections, so the
28px offset at `panel.css:296` goes. Count badge on the right, the rows the tree actually paints, i.e. today's
`visibleRowCount` (`work-items.ts:468`). Each header stays a `<button>` disclosure with `aria-expanded`; collapse
state persists through the existing `CollapseState` (`work-items.ts:275-287`) keyed by the new section key.

## 6. Focus control

**A native `<select>`, pinned at the top of the panel, above the needs-you strip.** Decided over segmented tabs
(seven targets do not fit 300px) and chips (they wrap to three rows, which is the clutter being removed): a select
is one line at any width, the platform gives it keyboard and screen-reader behaviour for free, and it needs no popup
of our own — the user is removing popups, not adding one.

- Label and options: `All areas (17)`, then the six sections with their own counts, e.g. `Parking lot (6)`.
- Keyboard: it is the panel's first tab stop; the tree's roving stop (`row.ts:24`, `reconcile.ts:48`) is the second.
  `Alt+Down` opens it natively; arrows change the selection; no custom handler, and `keyboard.ts:70-71` already
  ignores keys on a control — extend that guard to `SELECT`.
- Persistence: `cgremlin.panel.focus` in the host's `globalState`, read with the same defensive shape as
  `readSort` (`work-items.ts:234-240`) — an unrecognised value falls back to `all`.
- "All" renders all six sections in the table's order. A single area renders **only** that section, and
  `panelTreeNodes` must not walk the others (`panel-tree.ts:38`) so the keyboard cannot reach a hidden row.
  The header is still drawn, so the user always sees which area he is in.
- Empty focused section: the section's own `Nothing waiting for you` (`list.ts:41`), never a blank panel.

## 7. Separation

- 4px of sidebar background between consecutive rows in a section, and the **section rule breaks across that gap**.
  The interrupted rule is the breakpoint — structure carrying information, not a divider for its own sake.
- 16px between sections. No cards, no radius on rows, no shadows.
- Row padding 10px vertical / 10px horizontal, so a 3-line row is ~68px and a 2-line row ~50px.
- Hover: `--vscode-list-hoverBackground` and **nothing else** — no height change, ever (`panel.css:339-342` rule kept).
- Selected: `--vscode-list-inactiveSelectionBackground`, the section rule at full opacity, L1 at weight 700.
- Expanded: the submenu is a sibling node (`list.ts:208-213`) that shares the row's background and its section rule
  **with no 4px gap between them** — an open item reads as one taller band, which is why the submenu reads as part
  of the item rather than as a panel that appeared.
- needs-you: the one accent, `--vscode-notificationsWarningIcon-foreground`, as an `inset 3px 0 0` box-shadow drawn
  over the section rule (`panel.css:357-359`), so it never moves text sideways.

## 8. CSS and structure the executor follows

**Tokens only** — every colour is `var(--vscode-*)`; the only derived values are `color-mix` on those tokens. No hex.
No `@font-face`, no icon font (`font-src 'none'`); glyphs are unicode via `dom.ts:20`.

Type scale (only these five): `calc(var(--vscode-font-size,13px)*1.15)`/700 section header; `var(--vscode-font-size,13px)`/600
`tabular-nums` L1; `12px`/400 L2 and part names; `11px`/400 L3, part state, buttons; `10px` count badge.
Spacing scale (only these): `2 4 6 10 16`.

```
div.row[data-key=row:<list>:<id>][role=treeitem][aria-level=1]
  div.row-id            <- L1, one span.id-key per key (tabular)
  div.row-desc          <- L2, single text node, omitted when empty
  div.row-signals       <- L3, span.cell.cell-<kind>, first is .cell-repo
div.submenu[data-key=expanded:row:<list>:<id>]
  div.part[data-key=part:<id>:<partKey>][role=treeitem][aria-level=2][data-part=<kind>]
    span.part-glyph / div.part-name / div.part-state / div.part-actions > button.part-action
  div.changes
  div.actions > button.row-action        <- Ack only
```
`partKey` ∈ `investigation | development | review | ticket:<KEY> | pr:<repo>#<n>`.
`#cgremlin-panel { container-type: inline-size }` and `@container (max-width: 380px) { .cell-size { display: none } }`
— the only responsive rule.

**The keyed reconciler must patch in place, with zero mutations on identical data** (`reconcile.ts:30-51,78-106`):
L1/L2/L3 text, every cell's class and text, `aria-selected`/`aria-expanded`, the tab stop, the section rule colour
(a class, not a style), each part's state text, each button's label, and each part's presence (create/remove by key).
`rowKey` stays `row:${row.list}:${row.id}` (`row.ts:28-30`) even though sections flattened — a row is in exactly one
parking group, so it stays unique, and changing it would break the persisted selection and the focus map
(`index.ts:37`).

**Unbreakable:** CSP verbatim (`item-tab.ts:36-41`, nonce'd script and style, `default-src 'none'`); no `vscode` import
in `src/webview` (`test/purity.test.ts:31`); `textContent` only, no `innerHTML`; `role=tree/treeitem` with matching
keys from `panel-tree.ts`; no change under `core/`.

**What the wire cannot do.** Two gaps, designed around rather than papered over: (a) the panel never learns `me`, so
`reviewRequests` (`work-item.ts:52`) cannot render "requested from you" — the needs-you strip carries that urgency
instead; (b) `pr.labels` (`work-item.ts:61`) arrives and stays unused — at 300px there is no honest room, and a label
is not a decision input for any of the six jobs. Everything else in §2-§4 is already on the wire.

## 9. Acceptance criteria

1. Hovering any row, cell, chip or button anywhere in the panel or the item tab shows no tooltip; a grep for `.title =`
   over `src/webview/**` returns only `document.title`.
2. CI state is readable without hovering: a failing PR says `CI failing` in red on its third line.
3. Clicking a row opens a block directly under it listing only the parts that item has, each with its own state line
   and its own buttons; a teammate's parking-lot PR shows Review and PR, and no Investigation or Development.
4. Section headers are visibly larger and heavier than row text, and each of the six carries a different coloured rule
   and glyph that also runs down its rows.
5. A control at the very top narrows the panel to one area; choosing `My dev work` leaves only My dev work on screen,
   and the choice survives closing and reopening the window.
6. Two PRs from the same repo with near-identical titles are told apart at a glance by the number on the first line;
   the repo appears once, as its last segment, on the third line.
7. Consecutive items are separated by a visible gap with a break in the coloured rule; an open item and its submenu
   read as one continuous band.
8. No button in the panel produces an engine error or a nonsensical session.
9. Scrolling, hovering and a background refresh never move a row under the pointer or change a row's height.

## 10. Task breakdown (executor-heavy)

Tier A is the user's complaints; Tier B is the structural work they rest on; Tier C is the item tab's tooltips.

| # | Tier | Task | Files | Guard to write |
|---|---|---|---|---|
| 1 | B | Delete `setTitle`, `RowMetaCell.title`, and all `title=` in the panel; give `ciCell` text + tone | `panel/reconcile.ts`, `panel/cells.ts`, `model/work-items.ts` | source-level test: no `.title =` in `src/webview/panel/**`; `ciCell('failure').text === 'CI failing'` |
| 2 | B | Split `labelOf` into `identityOf` / `descriptionOf` / `repoTailOf`; rebuild `metaOf` as the L3 token list with no `·` and no emoji prefixes | `model/work-items.ts` | per-list table test of the three lines; `identityOf` never contains `/` or `—` |
| 3 | A | Row DOM: three lines, one shrinkable child per line, class names per §8 | `panel/row.ts`, `media/panel.css` | `row.test.ts`: exactly one node per line has `min-width:0`; identical data → zero mutations (extend `reconcile.test.ts`) |
| 4 | A | Promote the parking-lot groups to six sections; per-section colour, 15px/700 sticky header, count, collapse | `ui/panel-view.ts`, `model/panel-protocol.ts`, `model/panel-tree.ts`, `panel/list.ts`, `media/panel.css` | `section-counts.test.ts` + `section-collapse.test.ts` extended to six keys; `panelTreeNodes` order matches DOM order |
| 5 | A | The submenu: replace slots/parts/people with the five-part list and its show/hide rule | `panel/expanded.ts`, `ui/panel-view.ts`, `model/lifecycle.ts` | `expanded.test.ts`: a parking-lot PR yields parts `[review, pr]`; a waiting-for-review PR yields no `development` Start; every rendered button's command appears in `rowActions` for that list |
| 6 | A | Focus `<select>`: state key, defensive read, render, tree exclusion, keyboard guard for `SELECT` | `ui/panel-view.ts`, `model/work-items.ts`, `panel/index.ts`, `panel/keyboard.ts` | round-trip test: write `myWork`, re-read → only that section in `panelTreeNodes`; an unknown stored value → `all` |
| 7 | A | Separation: 4px gaps, rule breaks, expanded band, hover background-only | `media/panel.css` | `panel-render.test.ts`: no rule changes height on `:hover`; no `display` toggle on a flow node |
| 8 | C | Item tab: drop the three `title=` assignments, add `aria-label`, render the disabled reason and the session id as text | `webview/item-tab.ts`, `media/item-tab.css` | repo-wide guard: `title =` appears in `src/webview/**` only as `document.title` |

Risks. (4) is the largest — it changes the shape `panel-tree.ts`, `panel-view.ts` and `list.ts` agree on, and ARIA,
keyboard and DOM order must stay identical; do it in one commit with the tree test. (2) churns `work-items.test.ts`;
(5) rewrites `expanded.test.ts` rather than amending it. Nothing here touches `bin/cgremlin`, so the
bash↔Python-heredoc sync is not in play. Every chart token falls back through
`var(--vscode-charts-foreground, var(--vscode-descriptionForeground))`.
