# Round 3 — the expanded item answers "what did it find, and what do I do"

Design proposal, 2026-09-22. Read-only research at `mission-control-pr-orchestrator`.
Settled by phase 10/11 and NOT re-litigated: the six sections and their colour rule, the
three-line collapsed row, no tooltips, one composer (`row-composition.ts`), forward-only
stages, P0-2 (no verb invented outside `row-actions.ts`).

## 0. What the code actually does (verified, not taken on trust)

All ten reported defects reproduce from source. Three are mechanically different from the
report, and one prior spec turns out to be stale.

| # | Verified cause |
|---|---|
| 1 | The verdict is genuinely absent. `/items` carries no verdict/count (`WorkItemAgent`), and `loadExpanded` (`src/ui/wiring.ts:99-117`) fetches only artifact mtimes and `changes`. But `verdictOf`/`severityCountsOf` exist and work on artifact text (`src/model/artifact-outline.ts:110,220`), `primaryArtifact` is on the wire, and `CoreClient.artifactText` exists (`src/core-client.ts:280`). The expanded row can show the verdict today with ONE extra fetch and ZERO engine change. |
| 2 | `src/model/lifecycle.ts:124` — `return ` + "`needs you · ${agent.phase}`" + `;`. A gate and a pipeline phase, two different axes, joined by a `·` implying they are the same kind of thing. |
| 3 | Confirmed and worse: the three numbers have three different BASES. `14 files +455/−51` is the PR vs its base (`sizeOf`, `row-composition.ts:245`). `Committed`/`Working tree` come from `client.changes(sessionId)` on the agent's worktree (`wiring.ts:114-115`) — a different diff against a different ref. Nothing on screen says so. |
| 4 | `item-parts.ts:277-279` — `openAction()` hardcodes `label: 'Open'` for every part, so Review and PR both render `Open`; the PR part also renders `Open on GitHub`. |
| 5 | A CSS wrap bug, not a data bug. `.part { flex-wrap: wrap }` with `.part-text { flex: 1 1 auto }` (`media/panel.css:667-698`). Flex line-breaking uses the FLEX BASE SIZE, and `flex-basis: auto` means max-content, so at sidebar widths the long PR state string is pushed to line 2 and the 14px glyph is stranded alone on line 1. `min-width: 0` governs shrinking AFTER the line is chosen, so it does not help. |
| 6 | Confirmed. `expanded.ts:29-31` renders `MANAGED_WORKSPACE_HINT` as text with no control — a sentence with its verb amputated. |
| 7 | Confirmed, and the cause is upstream: `ActionPlacement` is computed through three modules and then DISCARDED. `expanded.ts:94-108` renders every leftover action as an identical button and never reads `placement`. (`src/webview/item-tab.ts:149` does honour it — the panel is the outlier.) |
| 8 | The item has NO linked ticket, so `identityKeysOf` (`row-composition.ts:81-89`) yields `['#2140']` only, and `HB-1555` survives solely inside the conventional-commit prefix of the title. `feat(HB-1555): ` is 14 characters of a ~36-character budget. |
| 9 | `peopleLine` (`item-parts.ts:318-322`) maps every login in `humanActivity.reviewedBy` with no self-filter. |
| 10 | The "avatar chip" is `.cell-tier`, a 10px letter in a padded box. The bare dot is `ciCell('success')`, deliberately `text: ''` with a `label`. Both are legible by convention only. |

**A prior spec is stale, and it unblocks defect 9.** Phase 11 §8(a) says "the panel never learns
`me`". No longer true: `CoreConfigView.me: string` (`src/model/items.ts:225`) is on `GET /config`,
and `wiring.ts:89-91` already proves the thunk pattern for feeding config into the panel.

## (a) How comparable tools solve this

- **GitHub's PR list** — the review DECISION is a first-class token beside the title. The decision is list-level furniture, not detail-level.
- **Linear** — the detail opens with status + assignee + one activity line; everything structural sits below the fold. The detail leads with the ANSWER, not an inventory of related objects.
- **Graphite** — best in class at exactly our problem. A per-PR REASON chip ("changes requested", "review requested from you") rather than a pipeline state.
- **VS Code Source Control** — no per-row glyph column for text items; verbs live in a group that never reflows the text; counts are right-aligned badges. Our 14px glyph column is a cost with no payoff and is the direct cause of defect 5.
- **VS Code Testing** — a failed test shows the failure message INLINE in the tree, not behind a click.
- **Sourcegraph Batch Changes** — an explicit "what changed since you last looked" line. Freshness is only useful next to the thing that is stale.

The thread all six share and we do not: **one status word per item, naming a decision, not a stage.**

## (b) Three options

All keep the collapsed row at three lines and change only what sits under it. All go through
`row-composition.ts` and take every verb from `rowActions`. Frames are 38 columns ≈ 300px.

### Option A — Answer first  (PANEL ONLY)

```
| ▾ HB-1555 #2140                      |
| register signup-remove-lambda in th… |
| grace-frontend  ! review  23h  L  ●  |
|                                      |
| Review says: request changes         |
| 2 critical · 3 high · 1 design       |
|                                      |
| [ Read the review ]                  |
| [ Chat ]        [ Open on GitHub ]   |
|                                      |
| Your PR, open · 14 files +455/−51    |
| Large · CI passing · opened 21 Sep   |
| Nobody else has reviewed it yet      |
|                                      |
| HB-1555 · In Review                  |
|                                      |
| ▸ Agent worktree and housekeeping    |
```

Fixed order: verdict → one primary verb → supporting verbs → PR facts → ticket → disclosure.
The verdict block is ABSENT (never "0 findings") when nothing parsed.

*Cost.* One `artifactText` fetch per expansion on top of the two `loadExpanded` already makes,
plus a parse. Needs a one-line in-place loading state. The verdict wording is the artifact's own,
so a novel label prints as written.
*Wrong for.* A row with no artifact at all: the block starts at the PR facts instead, so its
shape is not constant across rows. Also wrong for auditing a long-running item — history is gone.

### Option B — What happened, newest first  (NOT HONESTLY BUILDABLE)

A reverse-chronological event list. **Rejected on ground truth:** there is exactly ONE
human-activity timestamp per PR (`humanActivity.lastAt`, `row-composition.ts:256-262`), no CI
timestamp and no ticket-transition time. Half the dates would be fabricated, which MG-12 forbids.
Making it true is a larger engine change than anything else here. It is also wrong for the
everyday case: most items have two or three events, so the timeline is a list with dates added.

### Option C — Objects, labelled  (PANEL ONLY)

Today's parts list repaired rather than replaced: glyph column deleted, a left label column added
(`Review` / `Pull req.` / `Ticket` / `Agent`), verbs under the object they act on.

*Cost.* The smallest diff — `itemParts` already emits this sequence, so the work is CSS plus
labels. But the label column eats 11–12 of 38 characters so every fact wraps, and it keeps the
structural flaw: the MOST important thing (the verdict) is typographically identical to the LEAST
(the worktree diff). It reads as a settings table.
*Wrong for.* Anyone scanning. Four equal-weight blocks means the eye lands nowhere — the original
complaint restated with better alignment.

## (c) Recommendation

**Option A, with Option C's object list demoted whole into A's disclosure.** The row's job is
"what do I do about this, and why is it here", and only A puts both answers in the first two
lines. B cannot be built truthfully on the current wire; C is a tidier arrangement of the same
flat hierarchy that produced the complaint. A also makes the existing `ActionPlacement` field
MEAN something — `primary` becomes the one full-width button, `inline` the pair beneath,
`overflow` the disclosure's contents — so defects 4 and 7 are fixed by USING a rule the model
already computes rather than by adding one. Its cost, the extra fetch, is bounded to the single
row the user just clicked.

## (d) Information hierarchy

**Without expanding (three lines, one edit).** Identity (`HB-1555 #2140`, ticket key promoted
onto line 1 even with no linked ticket); the prose title with the conventional-commit prefix
stripped; a signals line whose single state token is the REASON, not the phase.

**On expanding.** The verdict and its severity counts; the one recommended next action as a
full-width button; at most two supporting verbs; the PR's facts in words (state, size, tier
spelled out, CI spelled out, opened date, whether anyone ELSE has reviewed); ticket key and
status on one line; one disclosure.

**Deliberately cut.** The three lifecycle slots as the organising structure (they survive inside
the disclosure). `Working tree 0 files +0/−0` whenever zero. The `Committed` line as a top-level
fact (moves into the disclosure, relabelled to name its base). The glyph column in the expanded
block. The floating workspace hint. The bare word `Open`. `@me reviewed`. The word `Ack`.

## (e) The ten defects, answered

1. **No verdict.** Extend `ExpandedDetail` (`panel-view.ts:118`) with `verdict: { tone, label, sentence, counts } | null`. In `wiring.ts:99`, resolve the review/QA agent's `primaryArtifact`, call `client.artifactText`, then `verdictOf` + `severityCountsOf`. Absent parse → absent block, never `0 findings` (MG-17j). Panel only.
2. **"needs you · ready".** Delete the phase from the non-running state texts in `lifecycle.ts:122-126`. The phase word stays only on `running`, where it is genuine progress. What the user wanted from `ready` is the verdict, which now has its own line.
3. **Three diff numbers.** Keep one above the fold: the PR's own, because that is the change under review. Move the worktree pair into the disclosure as ONE line naming its base. Drop `Working tree` entirely when zero.
4. **Two `Open`s.** `openAction()` takes its label from the part kind: review → `Read the review`, findings → `Read the findings`, plan → `Read the plan`, qa → `Read the QA result`; pr and ticket lose theirs entirely (they keep `Open on GitHub` / `Open in Jira`). No button reads `Open` alone.
5. **Lone glyph.** `.part-text { flex: 1 1 0 }` so the wrap decision uses a zero base, and `.part-actions { flex: 1 0 100% }` so verbs take their own row. Under the recommended layout the glyph column is removed outright, making the bug unreachable.
6. **Floating hint.** Delete `row.hint` and `.expanded-hint`. If the offer belongs in the row it belongs as a button in the disclosure.
7. **Ack / Rename / Dismiss.** Make `expanded.ts` HONOUR `ActionPlacement`. Then rename to name the effect: `Ack` → `Mark as seen`, `Rename` → `Rename this item`, `Dismiss` → `Hide from the panel`.
8. **Truncation and buried ticket.** `identityKeysOf` gains a fallback lifting a ticket-shaped key out of the title prefix or branch when `ticket === null`; `descriptionOf` strips a leading `type(scope):` prefix. The expanded block opens with the FULL title wrapped over two lines, so truncation is never the last word. The block is a sibling BELOW the row, so nothing moves under the cursor.
9. **`@guilleazoubel reviewed`.** Thread `CoreConfigView.me` into the panel with the existing thunk pattern, drop self in `peopleLine`, render the remainder as `2 others reviewed` or `Nobody else has reviewed it yet`. Retires phase 11 §8(a).
10. **Unlabelled `L` and dot.** PUSHED BACK ON as a collapsed-row defect: at 300px a letter and a dot are the cheapest honest signals available. The real fault is that they are spelled out NOWHERE, which the expanded facts line fixes (`Large · 14 files +455/−51 · CI passing`).

## Engine-field question, answered

- Options A and C are **panel only**. B is not honestly buildable.
- **The collapsed row needs no new field either.** `attention.reasons` already expresses WHY the item is here (`review_ready`, `changes_requested`, `approved`, `run_failed`, `blocked`, …) and `reasonText` already words them. Today that vocabulary is spent only on the needs-you strip; render `reasons[0]` as the collapsed row's state token, replacing `◆ ready`. Presentation change in `rowMetaCells`, costs nothing.
- **What attention cannot express** is the SHAPE of the answer: `review_ready` does not distinguish approve from request-changes and carries no count. If a future round wants the verdict on EVERY collapsed row, the smallest useful field is one optional object per agent on `WorkItemAgent`:
  `result?: { tone: 'pass'|'fail'|'blocked'|'mixed'|'neutral'; label: string; findings: number | null } | null`
  Not severity buckets (six numbers for a line with room for one), not a summary sentence (it would arrive truncated and duplicate the title). Optional, so an older engine degrades to today's behaviour. **The recommendation does not depend on it.**

## Acceptance criteria

1. An expanded review row states the verdict and finding counts as TEXT, above every button, with no hover.
2. No string of the form `needs you · <phase>` appears anywhere.
3. Exactly one size measurement is visible above the disclosure; any second one names the ref it is measured against.
4. No button in the panel is labelled `Open`.
5. At 280px, 300px and 380px, no part line renders a glyph or label with nothing beside it.
6. Every sentence in the expanded block is either a fact about the item or the label of a control.
7. A grep for `.title =` under `src/webview/**` still returns only `document.title`; no emoji; no non-`--vscode-*` colour.
8. Expanding a row moves nothing above or at the click point.
