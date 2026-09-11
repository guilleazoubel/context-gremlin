# Phase 10 workshop — "make the panel really useful"

Repo @ 90bbc7b. Read-only. All paths absolute under `/Users/guilherme.azoubel/context-gremlin/cgremlin/`.

## 0. Ground truth (evidence before opinions)

**0.1 The three complaints are three distinct, confirmed defects, not one.**

| Complaint | Root cause (read, not guessed) |
|---|---|
| "not reachable" flapping every couple of seconds | `vscode/src/sse.ts:200-208` — every dropped `GET /events` emits `offline`; `src/extension.ts:128` routes it to `ui.offline()`; `src/ui/wiring.ts:133` calls `coordinator.markOffline()`; `src/ui/refresh.ts:161-165` calls `panel.setConnected(false)`; `src/webview/panel.ts:232-234` paints the banner. Reconnect backoff is `[1000, 2000, 5000, 10000]` (`src/sse.ts:83`) → the banner appears/disappears on a **1–2 s** cycle. There is **zero** debounce anywhere on that path. |
| "content shift", "buttons hard to click" | `src/webview/panel.ts:215` — `container.textContent = ''` then a **full rebuild** on every render. And `media/panel.css:127-136` — `.row-actions { display: none }` → `.row:hover .row-actions { display: flex }`, i.e. hovering a row **grows it by a whole button line**, pushing the rows below down under the pointer. The two compound: the rebuild kills `:hover`, the row shrinks, the button vanishes mid-click. |
| Amplifier: renders per refresh | `src/ui/refresh.ts:114-115` calls `setConnected(true)` **and** `setItems(...)`, and `readItems()` (`:137`) calls `setSourceTrouble(null)` — each of `panel-view.ts:113/118/127/132` calls `this.render()`. That is **3 full DOM teardowns per `/items` poll**, once per SSE frame burst. |

**0.2 The nonsensical actions are one function that never looks at the list.**
`vscode/src/ui/panel-view.ts:352` — `export function actionsFor(item: WorkItem)`. It takes **no `list` argument**. Lines 372-373 push `Start investigation` and `Start development` **unconditionally, for every row in every list**, and line 388 pushes `Ack` unconditionally. `rowView` (`:243`) calls it with no list context even though `WorkRow.list` exists (`src/model/work-items.ts:261`). The Item tab repeats the same bug: `src/ui/item-tab.ts:471-473`, same two unconditional pushes.
That is exactly the user's "I click on parking lot items and I get start investigation, start development".

**0.3 Age and size ARE on the wire. They are rendered, then clipped.**
- Core: `core/src/gh/pr-view.ts:10-11` — `PR_INVENTORY_EXTRA_FIELDS` already includes `createdAt,changedFiles,additions,deletions,reviewRequests,statusCheckRollup,labels`, one `gh pr list` per repo (R53). Persisted at `core/src/inventory/inventory.ts:239-240,314-315`, mapped onto the wire at `core/src/work/work-item.ts:153-157`.
- Extension: `src/model/work-items.ts:482-499` computes `ageOf` ("opened 12d ago") and `sizeOf` ("43 files +900/−12"); `:388-396` joins them into **one** `description` string; `panel-protocol.ts:26-27` carries `age` and `size` as their **own** fields.
- The webview **never reads `row.age` or `row.size`** (grep of `src/webview/panel.ts`: no match). It renders only `row.description` into `.row-line2`, which is `white-space: nowrap; text-overflow: ellipsis` (`media/panel.css:106-112`). In a ~300 px sidebar, `@author · opened 12d ago · 43 files +900/−12 · 👤 @x reviewed` is **ellipsised after the author**. So: **no new core work is needed for age/size.** There is **no size tier** anywhere (grep `S|M|L|XL` tier: absent) — that is genuinely new, and it is cheap.

**0.4 What the spec already promised and the UI did not deliver.**
Spec `core/docs/superpowers/specs/2026-09-10-cgremlin-phase9-work-items-design.md:1150-1154` (R47 "Row fields") lists `repo#n`, title, `@author`, openFor, size, humanActivity summary, CI dot, `reviewDecision`, `labels`. The panel renders label + badges + CI + a truncated description. `reviewDecision` and `labels` are on the item and **never surfaced on a row**. R54 (`:1361-1394`) literally says "like the Codex chat panel" and `media/panel.css:1-3` says so too — the file is 178 lines and has no card, no divider rhythm, no accent.
Scope brief `…/scratchpad/phase9-scope/LEGACY-AND-SCOPE.md:145-158` is the user's own words for the parking-lot row; `:160-166` for the expansion model; `:212-215` marks all of this **UI-only**.

**0.5 One real spec/user divergence to name.** LEGACY-AND-SCOPE.md:142-143 says a reviewed PR *leaves* waiting-for-review; R50 (`spec:1204-1208`) **supersedes** that — it stays and lights up. The user's latest message ("PRs waiting for review … those should be my prs") matches R50. Keep R50.

---

## 1. PM

**Jobs-to-be-done, one per list. Each list answers one question in under five seconds.**

1. **Parking lot — "which teammate's PR should I pick up next?"** Decision inputs, ranked: is anyone already on it → how old → how big → is CI green → who wrote it. Today the panel gives the eye *title + emoji badges* and buries the rest in a clipped line. The list is a **shortlist**, not an inbox.
2. **My dev work — "what is the state of the thing I'm building, without me remembering?"** One row per ticket, merged (R48). The row answers: where is it (ticket status), does it have a PR, is an agent mid-flight, does it want me.
3. **Investigations — "what did I ask Claude to look into?"** Lowest-stakes list. Newest first, one click to the artifact.
4. **PRs waiting for review — "tell me when I'm needed, and drop me into the conversation."** These are **mine**. The only news is: a review landed / approved / CI broke. One click → the respond flow (R50).

**ONE primary action per row.** Everything else is overflow.

| List | Row state | Primary action (the click) |
|---|---|---|
| Parking lot | no review agent | **Start review** |
| Parking lot | review agent, running | **Open review** (item tab, that agent focused) |
| Parking lot | review agent, `needsYou` | **Open review** + needs-you accent |
| My dev work | has agent | **Open** (item tab, newest agent focused) |
| My dev work | ticket only, no agent | **Start development** |
| My dev work | ticket only, no PR, exploratory | Start development primary; Start investigation in overflow |
| Investigations | always | **Open investigation** (artifact) |
| Waiting for review | no respond agent, review landed | **Address review comments** |
| Waiting for review | respond agent at `addressing`/`ready` | **Chat** |
| Waiting for review | respond agent `triaging` | **Open** (disabled Chat with the R50 reason) |
| Waiting for review | quiet, nothing landed | **Open PR** — no agent verbs at all |

**Must never be offered (this is the hard list):**
- `Start development` or `Start investigation` on a **parking-lot** row. It is a teammate's PR. (Today: always offered, `panel-view.ts:372-373`.)
- `Start review` on my own PR — already correct (`panel-view.ts:364`), the core would 409 `OwnPrError`.
- `Start development` on a **waiting-for-review** row. The user said it: "I should already have a session for this one because it's already with a PR."
- `Start investigation` anywhere a PR exists. An investigation is the *no-PR* mode (R49, spec:1195-1201).
- A second `Start review` when a review agent exists — already correct (`:365`).
- `Ack` when `attention.reasons` is empty **or** already `acked` (today unconditional, `:388`).
- `Chat` on a respond agent still `triaging` (correct in `chatTargetOf`, `work-items.ts:604-615`).

**Success criteria the user would recognise.**
- Morning triage: opens the panel, reads the parking lot **without scrolling or hovering**, picks the oldest untouched small PR, one click, review starts. Target: under 10 seconds, zero hovers.
- Mid-day interrupt: a review lands on his PR; status bar badges; he opens the panel, the waiting-for-review row is the only accented thing; one click → worktree swapped, respond run started, then Chat.
- End of day: scans My dev work; every row tells him ticket status + PR state + agent phase without expanding. Expanding is for *going to* a part, not for *learning* the state.
- Negative criterion, verbatim from him: **no button he clicks may produce an error or a nonsensical session.**

---

## 2. Designer

**The "Codex chat panel" feel, concretely:** flat card rows, generous vertical padding (8/10 px), a hairline divider at ~40 % opacity instead of a full-strength border, primary text at 13 px / weight 400, a **secondary metadata line at 11 px in `descriptionForeground`**, exactly **one** accent colour reserved for needs-you (a 2 px left bar, not a red emoji), no chrome until hover, and hover changes **background only — never height**.

### 2.1 Row anatomy

Parking-lot row (2 lines, fixed height 46 px):
```
┌─────────────────────────────────────────────────────────┐
│ grace-frontend#1482  Fix hydration on /communities   ●  │  ← title 13px, CI dot right
│ @jdoe · 12d · M · 8 files +240/−31                      │  ← 11px muted; tier chip inline
└─────────────────────────────────────────────────────────┘
   (someone-on-it variant, inside the collapsed group)
│ grace#903  Bump node to 22                           ●  │  opacity .65
│ @rsmith · 3d · S · 👤 @alopez reviewed                  │
   (reviewing variant, pinned top)
▌ grace-frontend#1501  Cart totals off by a cent       ●  │  ← 2px accent bar = needs you
│ @mkim · 1d · L · 🔎 reviewing · plan ready              │
```
My dev work, collapsed then expanded:
```
│ ▸ HB-627 — Convert the tour scheduler to RSC         ●  │
│   In Progress · 🔀 grace-frontend#1499 open · 🔨 coding │
│ ▾ HB-627 — Convert the tour scheduler to RSC         ●  │
│     🔨 Development · coding            ⌁ worktree       │  ← children: 11px, 22px indent
│     🎫 HB-627 · In Progress            ⌁ Jira           │
│     🔀 grace-frontend#1499 · open ●    ⌁ GitHub         │
```
Waiting for review:
```
▌ grace-frontend#1499  Tour scheduler RSC             ●  │
│  2d · M · 💬 @teammate requested changes · 3 threads     │
```
Investigations: `│ Why do saved searches drop on logout │ 🔍 ready · 2h`

### 2.2 Rules that kill the two visible bugs
1. **No layout shift, ever.** Actions live in a fixed-width right gutter (28 px) that is **always reserved**; hover swaps its contents from empty to a `⋯` overflow trigger plus at most **one** inline primary button. `display:none → flex` on a block that occupies flow (today `media/panel.css:127-136`) is banned.
2. **Hit targets ≥ 24×24 px** with `padding: 4px 8px`; the overflow menu is a popover anchored to the row, so its items are full-width and cannot be missed.
3. **Single click on the row = open the item tab** (already `panel.ts:102-105`). The **primary action** is the one inline button; the primary action is *not* the row click.
4. **No re-sorting while the pointer is inside the list** or while a menu is open; queue the order and apply on pointer-leave. Sort changes **only** on explicit user action. This is what stops "the content shift makes a horrible UI to click around".
5. **Stable keys, in-place patch.** Row key is `row:<list>:<item.id>` (already computed, `panel.ts:55`) — reuse the node, set `textContent` on changed leaves only.
6. **Tier chips.** From `changedFiles` and `additions+deletions`, whichever is larger: **S** ≤ 3 files or ≤ 50 lines · **M** ≤ 10 or ≤ 300 · **L** ≤ 25 or ≤ 1000 · **XL** beyond. Unknown → `—`, never a fabricated zero (MG-12, `work-items.ts:493-499`). Chip = 1-char letter, `border-radius: 3px`, `background: badge.background`, `font-variant: tabular-nums`.
7. **Age**: compact — `4h`, `12d`, `6w`. Tooltip = full ISO. Drop the word "opened" on the row; it costs 7 characters in a 300 px sidebar. Keep `ageOf`'s `—` for null.
8. **Someone-on-it** treatment: `opacity: .65`, the `👤 @login verb` chip, inside the collapsed group. No badge on the untouched rows — absence is the signal (R47).
9. **CI dot**: an 8 px `border-radius:50%` span with `charts.green/yellow/red`, not the emoji; `title` = the state. Emoji sizes inconsistently across the sidebar.
10. **needs-you accent**: `box-shadow: inset 2px 0 0 var(--vscode-notificationsWarningIcon-foreground)`. Replaces the `❗` badge at `panel.ts:76`. One accent in the whole panel.
11. **States.** Loading = 3 skeleton rows, never an empty list. Empty parking lot = "Nothing waiting. Nice." Trouble = the row that already exists, but **only after the debounce** (§3.2). A stale banner must **never** replace the lists (today `panel-view.ts:155` empties `lists` on trouble — correct for `foreign`, wrong for a transient drop).
12. **Keyboard** is already right (`src/model/panel-tree.ts`, R66). Add: `Enter` = primary action, `Space` = open item tab, `.` = overflow menu, matching the mouse model.

### 2.3 CSS/structure guideline for the frontend-design skill
`.row { display:grid; grid-template-columns: 1fr 28px; grid-template-rows: auto auto; column-gap:8px; padding:8px 10px; min-height:46px; border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 40%, transparent); }` · `.row:hover { background: var(--vscode-list-hoverBackground); }` — **no other property may change on hover** · `.row-gutter { grid-row:1/3; opacity:0; }` `.row:hover .row-gutter, .row:focus-within .row-gutter { opacity:1; }` (opacity, never display) · `.row-meta { font-size:11px; color:var(--vscode-descriptionForeground); display:flex; gap:6px; align-items:center; min-width:0; }` with `.row-meta > *:not(:first-child)::before { content:'·'; margin-right:6px; }` so separators are CSS, not string-joined · `.tier { font-size:10px; padding:0 4px; border-radius:3px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }` · `.row.demoted { opacity:.65 }` · `.row.needs-you { box-shadow: inset 2px 0 0 var(--vscode-notificationsWarningIcon-foreground) }` · `@media (prefers-reduced-motion: reduce)` disables the 80 ms hover fade. All tokens `--vscode-*` only (R54).

---

## 3. Engineer

### 3.1 Wire audit
| Signal | On the wire? | Where |
|---|---|---|
| age (`createdAt`) | **yes** | `core/src/work/work-item.ts:154`, `PanelRowView.age` `panel-protocol.ts:26` |
| size (`changedFiles/additions/deletions`) | **yes** | `work-item.ts:155-157`, `PanelRowView.size:27` |
| CI | yes, rendered | `work-item.ts:158`, `panel.ts:75` |
| `reviewDecision`, `labels` | **yes, never rendered** | `work-item.ts:151,159` |
| `humanActivity` / "someone on it" | yes, in `description` (clipped) | `work-items.ts:502-512` |
| **size tier** | **no — new** | compute in core, next to the PR mapping |
| open-thread count on a list row | no (`openThreads` optional, detail-only, `work-items.ts:61`) | leave for P2 |

**Cost of age/size: zero.** They already ride the one `gh pr list` per repo (`core/src/gh/pr-view.ts:10-17`, R53). No extra call for tiers either — tier is arithmetic on fields already present.

**Where tier belongs: the core.** `WorkItemPr.sizeTier: 'S'|'M'|'L'|'XL'|null` computed in `prFromEntry` (`core/src/work/work-item.ts:140-161`), `null` in `prFromAgentLinks` (`:165-186`). Rationale: it is a property of the work, the future CLI and any second client must agree, and `smallestChange` sorting already lives on `changedFiles`. Age **formatting** stays in the extension (`work-items.ts:482-491`) — it is clock-relative presentation.

### 3.2 Engine-trouble flapping — what the panel must do
Root cause is being handled elsewhere; the panel's own obligations, independent of it:
1. `sse` `offline` must **not** reach the view synchronously. Introduce a `ConnectionMonitor` between `extension.ts:128` and `wiring.ts:132-136` with **hysteresis**: enter `offline` only after the socket has been down **≥ 8 s** *and* one `GET /items` has failed; leave `offline` immediately on the first success (fast up, slow down).
2. A transient drop **must not empty the lists** — keep the last snapshot, paint a 1-line dimmed "reconnecting…" strip in the header that occupies **reserved** space, so nothing reflows. `panel-view.ts:155` (`lists: trouble === null ? … : []`) stays only for `foreign`/`unusable`.
3. Notifications already latch once per outage (`ui/notifications.ts:44-49`) — keep, and drive it from the same monitor so popup and banner cannot disagree.
4. Never let a trouble state toggle more than once per 8 s window, even if the monitor is wrong.

### 3.3 Re-render architecture
Current: `render(next)` blows away the DOM (`src/webview/panel.ts:206-237`); the `patch` message (`panel-protocol.ts:84`) is a lie — `panel.ts:298` merges and then full-renders anyway.
Required:
- **Reconcile by key.** Maintain `Map<key, HTMLElement>`; for each section, diff the id sequence, move/insert/remove, and for a surviving row set only changed `textContent`/`className`. Keys already exist (`panel.ts:55,110,146`).
- **Preserve** expansion (host-side already, `panel-view.ts:83`), scroll top, `document.activeElement`, and `:hover` (preserved for free once nodes survive).
- **Coalesce host-side.** `panel-view.render()` (`:275`) should mark dirty and flush on a microtask/16 ms timer, so `setConnected` + `setItems` + `setSourceTrouble` in one refresh produce **one** post, not three (`refresh.ts:114-115`, `:137`).
- **Freeze ordering** while the pointer is inside the list or a menu is open; apply the pending order on `pointerleave`.
- **SSE storm guard.** `refresh.ts:82-89` already coalesces at 150 ms — keep, and add a max-rate of one render per 250 ms in the webview.

### 3.4 Actions-per-list rule table (the code change)
Change the signature to `actionsFor(item: WorkItem, list: WorkListKind): PanelActionView[]` (`src/ui/panel-view.ts:352`), pass `row.list` from `rowView` (`:243`), and mirror it in `buttonsFor` (`src/ui/item-tab.ts:443`) — which needs the item's lists too, available at `ItemDetailResponse.item.lists`. Allowed sets:

| list | startReview | addressReview | startDevelopment | startInvestigation | chat | openPr/openTicket | ack |
|---|---|---|---|---|---|---|---|
| parkingLot | if `!isMine` and no review agent | never | **never** | **never** | if `chatTargetOf` | yes | if reasons and not acked |
| myWork | never | if own non-draft PR | if no dev agent | if no PR **and** no dev agent | if `chatTargetOf` | yes | if reasons and not acked |
| investigations | never | never | if no PR (promote) | never (one exists) | if `chatTargetOf` | n/a | if reasons and not acked |
| waitingForReview | never | if own non-draft PR and no respond agent | **never** | **never** | if `chatTargetOf` | yes | if reasons and not acked |

Exactly one of these is flagged `primary`; the rest render in the overflow. Guard test: *"no list offers an action the core would refuse"* plus a table-driven test per cell.

### 3.5 Task breakdown
| # | Task | Files | Tier |
|---|---|---|---|
| T1 | `ConnectionMonitor` hysteresis; keep last snapshot on transient drop | `src/ui/wiring.ts`, `src/ui/refresh.ts`, `src/extension.ts`, new `src/model/connection.ts` | executor |
| T2 | `actionsFor(item, list)` + `buttonsFor` parity + rule-table tests | `src/ui/panel-view.ts`, `src/ui/item-tab.ts` | executor |
| T3 | Render coalescing host-side (one post per refresh) | `src/ui/panel-view.ts` | executor |
| T4 | Keyed DOM reconciler in the webview, state preservation, order freeze | `src/webview/panel.ts` | **executor-heavy** (only real algorithmic risk) |
| T5 | `sizeTier` in core + wire type + fixtures | `core/src/work/work-item.ts`, `vscode/src/model/work-items.ts` | executor |
| T6 | Row anatomy: structured meta line (age/tier/size/activity as elements), compact age, CI dot, accent bar | `src/webview/panel.ts`, `src/model/work-items.ts`, `media/panel.css` | executor |
| T7 | Overflow menu + fixed gutter + hit targets | `src/webview/panel.ts`, `media/panel.css` | executor |
| T8 | Empty/loading/reconnecting states, keyboard parity | `src/webview/panel.ts`, `media/panel.css` | executor |

**Risks.** (a) T4 is where a regression hides — the ARIA tree (`src/model/panel-tree.ts`, R66) and `focusedKey` must survive reconciliation; require a test that focus and expansion survive 50 renders. (b) T5 crosses the core/extension boundary — the extension must tolerate `sizeTier` absent (older engine) and derive a fallback locally. (c) T2 changes an exported pure function used by tests — expect churn. (d) None of this touches `bin/cgremlin`; **if any task grows to touch the bash↔Python-heredoc sync in `bin/cgremlin`, it is high-risk and must escalate to `executor-heavy`.** (e) Unresolved judgment call for the executor: whether the overflow menu is a custom popover or a native `<select>`-style list under CSP `default-src 'none'` — decide before T7.

---

## 4. Joint resolution

**P0 — must fix; the panel is currently untrustworthy without these.**
1. **Stop the flapping.** *Acceptance:* with the engine up and the SSE connection dropping, the user never sees "The cgremlin engine is not reachable" appear and disappear; a genuine outage shows it once, after ~8 s, and it clears the instant the engine answers. The lists never blank out on a transient drop.
2. **Actions match the list.** *Acceptance:* a parking-lot row offers **Start review, Open PR, Open ticket** and nothing else. A waiting-for-review row offers **Address review comments** (or **Chat**) and **Open PR** — never Start development, never Start investigation. No button the user clicks returns an engine error.
3. **The signals he decides on are visible without hovering or scrolling.** *Acceptance:* every parking-lot row shows, at 300 px width, `@author · <age> · <tier> · <n> files +a/−d`, and the "someone is on it" rows are visibly dimmed in their own collapsed group.
4. **No content shift.** *Acceptance:* hovering a row changes only its background; row height is identical hovered and not. Rows do not move, reorder or vanish under the pointer during a background refresh; scroll position, expansion and keyboard focus survive.

**P1 — the row redesign.**
5. **One primary action per row, everything else in an overflow.** *Acceptance:* one visible button per row on hover, ≥ 24 px tall, plus a `⋯`; clicking `⋯` opens a full-width menu whose items cannot be mis-clicked.
6. **Size tier chip S/M/L/XL** from the core, with the stated thresholds. *Acceptance:* the user can sort the parking lot by smallest and the chips agree with the order; unknown size shows `—`.
7. **My-work row reads as state, not as a title.** *Acceptance:* collapsed, it shows ticket status + PR state + agent phase; expanded, each part is one click to its info and one click to its destination (Jira / GitHub / worktree).
8. **Waiting-for-review rows say what landed.** *Acceptance:* `@reviewer requested changes` / `approved` / `review arrived`, with the needs-you accent bar, and one click begins the respond flow with the worktree swapped.

**P2 — polish.**
9. `reviewDecision` and `labels` on the row; open-thread count on waiting-for-review rows.
10. Loading skeletons, empty-state copy, reduced-motion, `Enter`/`.` keyboard parity with the mouse model.
11. Retire the emoji badges for tokenised chips and dots (R54 forbids an icon font; unicode stays, but sized and aligned).

**Done means:** he opens the panel in the morning, reads the parking lot without touching the mouse, picks the oldest small untouched PR, clicks once, and a review starts — and nothing on screen moved while he did it.
