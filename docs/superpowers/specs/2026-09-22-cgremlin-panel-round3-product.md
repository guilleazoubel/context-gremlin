# Panel round 3 — the row must carry the answer, not the machinery

Read-only product argument. Repo @ `mission-control-pr-orchestrator`. No production code proposed.
Ground truth cited from `cgremlin/vscode/src/model/{items,work-items,lifecycle,row-actions,item-parts,artifact-outline,needs-you}.ts`
and `cgremlin/core/src/pipeline/{artifacts,prompts}.ts`, `cgremlin/core/src/schema/pipeline.ts`,
`cgremlin/core/src/inventory/inventory.ts`.
Settled ground from Phase 10 (`2026-09-11`) and Phase 11 (`2026-09-14`) is not reopened: one primary action per row,
no tooltips, three-line collapsed row, six sections, parts-not-slots in the expansion, tokens only.

Constraints honoured throughout: ~300px sidebar, no tooltip / hover-reveal / popup / toast / emoji, a click expands in place.

---

## 0. The one fact this whole document rests on

`REVIEW_PHASES` (`core/src/schema/pipeline.ts:22`) is `queued | reviewing | ready | approved | changes_requested | dismissed | failed`.
`ready` means **`REVIEW.md` is non-empty and the process exited 0** — that is literally all `evaluateReview`
(`core/src/pipeline/artifacts.ts:48-51`) checks. The verdict is not in the phase. It never was.

Meanwhile every artifact contract the engine ships freezes the answer on **line 2**:

| Artifact | Line 2, verbatim from the contract | Labels allowed |
|---|---|---|
| `FINDINGS.md` | `**Verdict:** ✅ Root cause found — <one sentence naming the cause>` | `✅ Root cause found`, `⚠️ Partial`, `❌ Not reproducible` |
| `PLAN.md` | `**Verdict:** 🚧 Under review — <one sentence>` | `✅ Approved`, `🚧 Under review`, `❌ Unresolved disagreement` |
| `REVIEW.md` | `**Verdict:** 🔄 Request changes — <one sentence: the call, and the reason>` | `✅ Approve`, `🔄 Request changes`, `💬 Comment` |
| `COMMENTS.md` | `**Verdict:** ✅ All threads triaged — <one sentence>` | `✅ All threads triaged`, `🚧 N of M triaged` |
| `QA.md` | `**Verdict:** ✅ Ready to deploy — <one sentence>` | `✅ Ready to deploy`, `❌ Not ready`, `🚧 Blocked` |

Line 3 of each is `**Scope:**` — *what the agent actually examined*. `REVIEW.md` additionally carries a
`## What I found` table with a severity per row, and `QA.md` ends with `- Blocking problems: N`.

And `vscode/src/model/artifact-outline.ts` **already parses all of it**: `verdictOf` returns `{tone, label, sentence}`,
`findingsOf` returns anchors + severity + status, and there is a severity-count helper.
It is wired into the Item tab and nowhere else.

**So the panel's central defect is not missing data. It is that the one surface the user looks at first
renders the pipeline's internal state machine, while the answer sits parsed, one module away, behind a second click.**

---

## 1. The job — three moments

The user is an engineer with four kinds of work on their plate (teammates' PRs to review, their own PRs waiting
on others, tickets to investigate, merged work awaiting QA). Agents do the work; the panel is where the human
**adjudicates** it. The panel is not a task list and not a log viewer — it is a **queue of small judgements**.

### Moment 1 — triage (list level, ~5 seconds, mouse untouched)
*"What wants me, and in what order, and what can I skip?"*

Needs: for each row, one line that is **an outcome** — not a stage. "Request changes, 1 critical" sorts above
"Approve, nothing flagged" without the user opening either. Today L3 carries `◆ ready` — mode glyph plus phase —
so ten rows that reached different conclusions are visually identical. The needs-you accent tells you *that*
something wants you; nothing tells you *how much it wants you*.
**Served: adequately for "which", badly for "how urgently".**

### Moment 2 — decide on one item (expanded, ~30 seconds, the judgement)
*"What did the agent conclude, on what evidence, and do I agree?"*

Needs, in this order: the verdict; the sentence behind it; how much it looked at (`Scope`, line 3 of every contract);
the worst finding; one way to disagree.
The dump gives: a workspace hint, `needs you · ready`, a bare `◇`, a repo slug the row already showed, two diff
measurements of a session, and seven buttons — and **not one word the agent wrote**.
**This is the moment the current design serves worst, and it is the moment the product exists for.**

### Moment 3 — come back to something in flight (~3 seconds, re-entry)
*"Is it still going, did it die, and has the world moved under it?"*

Needs: motion with a duration ("reviewing, 6m"), failure with a way forward, and — the one nobody has built —
**whether the thing the agent looked at is still the thing on GitHub**.
Today a running agent, a finished one, a failed one and one whose PR grew three commits ago share the vocabulary
`running` / `ready` / `failed` / `ready`. Phase 18 fixed the failure case (`runFailed` + `Retry`) and Phase 19 fixed
the running case (`lastRun.stage` + `startedAt`). **Staleness is untouched and is the only one of the three that can
make the user act wrongly** rather than merely act late.

There is a fourth, rarer moment — *hand off / prove it happened* ("did the review actually land on the PR?") — folded
into §6 because it is a missing fact, not a missing screen.

---

## 2. The one-line test — the five kinds of finished agent work

Rules for these sentences: they lead with the **call**, quantify it, and never print a phase name. Each is tagged:
**(a)** expressible today from list-level wire data · **(b)** expressible for the one expanded item by fetching its
primary artifact (`CoreClient.artifactText`, `WorkItemAgent.primaryArtifact`) and running `artifact-outline`, no engine
change · **(c)** needs a new engine field.

| Kind | The sentence the row shows when the work finishes | Where each part comes from |
|---|---|---|
| **Investigation** | `Root cause found — the offer cache keys on session id, not user id. 6 files in the splash zone.` | **(b)** label + sentence = `FINDINGS.md` line 2 via `verdictOf`; file count = `## Affected files` lines. `⚠️ Partial` and `❌ Not reproducible` render as themselves — a failed investigation is a *result*, not an error. |
| **Development** | `Draft PR #2140 open — 14 files, CI failing. Nothing pushed for 23h.` | **(a)** entirely wire: `WorkItemPr.state/changedFiles/additions/deletions/ci/updatedAt`. Development is the one mode with **no verdict contract** in `prompts.ts` — its answer is the PR, and the PR is already on the wire. Do not invent a development verdict. |
| **Review** | `Request changes — 2 findings, 1 critical: the payment retry loop can double-charge.` | **(b)** label + sentence = `REVIEW.md` line 2; counts and the critical's title from `## What I found` via `findingsOf` + severity counts. Severity words, never the emoji (Phase 11 §2). |
| **Respond** | `6 threads triaged — 4 valid, 2 false positives. Replies drafted, none posted.` | **(b)** label = `COMMENTS.md` line 2; the split from the per-thread `- **Verdict:** ✅ valid \| 🟡 false-positive` lines; posted/not from the per-thread `- **Status:**`. Needs a small extension to `artifact-outline` (same file, same parse-never-assume rule) — still no engine change. |
| **QA** | `Not ready — AC 2 fails on /tour-scheduler. 1 blocker.` | **(a)+(b)**: the tri-state is *already on the wire* as `WorkItemAgent.qaVerdict` (`work-items.ts:122`); the sentence and the blocker count come from `QA.md` line 2 and `- Blocking problems: N`. **QA is the proof that this works** — someone already did exactly this for one mode and stopped. |

### The single field, if only one is added — and the honest caveat

The (b) route is real and free, but it only serves **one expanded item**. Moment 1 needs the answer on *every* row,
and N artifact fetches per refresh is not a design.

**The one field: generalise `qaVerdict` into a per-agent verdict.**

```
WorkItemAgent.verdict?: { tone: 'pass'|'fail'|'blocked'|'mixed'|'neutral'; label: string; sentence: string } | null
```

Why this one: the engine **already parses these files at exactly the moment the phase flips**
(`parseQaVerdict`, `parsePlanReviewStatus`, `evaluateReview`, `parseRereviewSummary` — all in `artifacts.ts`), so the
work is reading one more line in code that has the file open. It is additive and optional, exactly like `qaVerdict`,
`sizeTier`, `state` and `lastRun` before it, so an older engine degrades to today's wording. It serves four of the five
kinds at list level, and it makes the (b) parse a *progressive enhancement* for the expanded item (findings table,
severity split) rather than the only source.

**The caveat, and it is not small:** a verdict without a freshness bit is worse than no verdict, because it invites
the user to act on a conclusion about code that may no longer exist. Which brings us to the coordinator's question.

### "The PR changed after the agent looked at it" — not expressible today

Checked. The engine **has** the pair: `SessionView.pr.headSha` and `.reviewedSha` (`core/src/schema/stage.ts:64-65`),
and `core/src/inventory/inventory.ts:153` literally computes `const newCommits = reviewedSha !== null && reviewedSha !== headSha`
and ships it on `InventoryEntry.ours.newCommits` — consumed today by exactly one thing, the CLI
(`core/src/cli/commands/prs.ts:10`). The **panel's** wire has neither: `WorkItemPr` (`work-items.ts:37-79`) carries no
sha, and `WorkItemAgent` (`:94-137`) carries no `reviewedSha`.

So: **(c)**, and the smallest field is a boolean that already exists one layer down —
`WorkItemAgent.sawLatest?: boolean | null` (or `staleSince: string | null` if the row should say *how long*).

Two things make me rank this **second, not first** — narrowly:

1. `discovery/reconciliation.ts:171-190` auto-starts a re-review the moment `headSha !== reviewedSha`, so the stale
   window is usually one poll interval. It is *not* always short: the auto-re-review is skipped while a human holds
   the conversation (`isClaimed`), only fires from `ready`/`changes_requested`, and a failed re-review leaves the
   stale verdict standing with no signal at all. Those are exactly the moments a human is mid-decision.
2. There is a **usable interim with no engine change**: the expanded row already knows `pr.updatedAt` and the
   artifact's mtime (`LifecycleInput.artifactAt`). `updatedAt > artifactAt` → `PR updated since this review`.
   It over-reports (a comment bumps `updatedAt`), and over-reporting doubt is the safe direction. Ship that with the
   verdict; replace it with `sawLatest` in the same breath as the next engine change.

**Ruling: add `verdict` first** — without it four of five kinds have *no answer at all*, at any zoom level, which is
the complaint. Add `sawLatest` immediately after; it is a rename of an existing computation, not new work, and the
verdict is only honest once it is there. **Do not ship the verdict with nothing standing in for freshness.**

---

## 3. What earns its place — a ruling on every element in the dump

| # | Element as it renders today | Ruling | Why |
|---|---|---|---|
| 1 | `▾ #2140` | **keep as is** | Phase 11 §2: identity is keys only. Correct. |
| 2 | `feat(HB-1555): register signup-remove-la…` | **say it differently** | This is the PR's conventional-commit subject. Two of its three components are chrome (`feat(...)`) and a ticket key the panel has a *field* for. Strip the prefix, lift `HB-1555` into L1 (`HB-1555 #2140`, already what `identityKeysOf` does when a ticket is linked), and let L2 carry the human half of the subject. The ellipsis is not a width problem; it is a content problem. |
| 3 | `grace-frontend` | **keep as is** | Phase 11 §2: repo tail, first and only shrinkable token on L3. |
| 4 | `◆ ready` | **cut, and replace with the verdict** | The whole complaint in two tokens. The glyph says *which mode*, the word says *which phase*. Neither is an outcome. This slot becomes `Request changes · 2 findings` (tone carried by the existing needs-you accent and text weight — never colour alone, never emoji). |
| 5 | `23h` | **say it differently** | Ambiguous today: age of the PR, of the session, or of the answer? After #4 it is the **age of the verdict**, and it must read that way by adjacency (`Request changes · 2 findings · 23h`). An answer 23h old about a PR touched 2h ago is the staleness signal doing its job. |
| 6 | `[L]` tier, `●` CI | **keep as is** | Phase 10 §P1-6 and Phase 11 §3. Both are decision inputs for "is this worth my hour". |
| 7 | `Open the cgremlin workspace to follow the code in the editor` | **cut from the row** | Workspace configuration, not item information. It is dismissible-once (`WORKSPACE_NOTICE_DISMISSED_KEY`) but until dismissed it occupies **the first line of the expansion on every row** — the exact position the verdict must own. Move it to the panel header, where a panel-wide setting belongs. |
| 8 | `◆ Review` + `needs you · ready` | **say it differently** | The part is right (Phase 11 §4); the state line is machinery said twice. Becomes `Review — Request changes · 2 findings · 4h`, then the verdict sentence on its own line, then `Scope: the diff and HB-1555` from line 3 of the artifact. `needs you` is already the accent bar; it does not also need to be a word. |
| 9 | `◇` (bare glyph, no text) | **cut** | A part header with nothing under it. Whatever it is, it renders as a decoration. If it is a PR part whose fields were all null, the part should not be drawn (`parse, never assume` — `artifact-outline.ts`'s own rule, applied to parts). |
| 10 | `aplaceformom/grace-frontend#2140` | **demote** | L1 says `#2140`, L3 says `grace-frontend`. The org slug is the one component the user never needs on screen; it survives in the GitHub action's `aria-label` (Phase 11 §3 already moved chip URLs there). |
| 11 | `open · 14 files +455/−51 · Opened Sep 21` | **keep as is** | **The one diff measurement a human needs.** It is the size of the object of the judgement — what merging costs, what reviewing costs. |
| 12 | `@guilleazoubel reviewed` | **say it differently** | That is the user. A line telling someone they did the thing is noise; the useful version is *who else* (`@dtorres reviewed 2d`) and, when it is only you, `you reviewed this Sep 21`. `peopleLine` (`item-parts.ts`) should exclude self unless it dates it. |
| 13 | `Committed 80 files +2942/−669` | **cut** | The second diff measurement, and the most confusing line in the dump: it disagrees with the PR's 14 files because it is counted against a different base (`changes.ts` `base`/`baseResolved`). No question a human asks is answered by it. "How big is this change?" is #11. "What did the agent do just now?" is not a file count. |
| 14 | `Working tree 0 files +0/−0` | **demote to a conditional** | The third measurement. Zero is the normal case and it renders a whole line to say *nothing happened*. It earns a line in exactly one case — non-zero, on an agent of mine — where it is genuine news: `The agent left 3 uncommitted files in your worktree`. That is an action prompt, not a statistic. |
| 15 | `Ack` | **cut from the row** (see §4) | |
| 16 | `Rename` | **demote** | Once per item, ever. Overflow / Item tab. |
| 17 | `Dismiss` | **keep, reword** | `Hide this item`, last position, visually separated from the verbs that start work. |

**Net: the expansion loses four lines (7, 9, 13, 14) and gains the three that matter — verdict, sentence, scope.**
It gets shorter and answers more.

---

## 4. The verbs

Today: `Open`, `Chat`, `Open`, `Open on GitHub`, `Ack`, `Rename`, `Dismiss`. Two buttons share a label and mean
different things; one is a no-op the user never wants; the most valuable verb in the product is unnamed.

| Today | Ruling | Plain wording |
|---|---|---|
| `Open` (on the Review part, `cgremlin.openChild` → agent) | **keep, rename** | **`Read the review`** — and per mode: `Read the findings`, `Read the QA report`, `Read the replies`. Name the document, not the act. `item-parts.ts:openAction()` labels every part's open `Open`; it should take the part's noun. |
| `Open` (on the PR part) | **cut** | It opens the Item tab on a PR that has nothing to read locally. The PR part has exactly one destination, and it is GitHub. |
| `Open on GitHub` | **keep** | The one true exit. |
| `Chat` | **keep, reframe** | Still `Chat`, but it must be positioned as *the disagreement channel* — it sits under the verdict sentence, not in a button row with Rename. Its disabled sentence is already right (`CHAT_BUSY_REASON`), and `Stop` beside it (Phase 19) is right. |
| `Ack` | **cut from the row** | It clears `attention` and does nothing else. Nobody opens a sidebar in order to say "seen". **Reading is acknowledging**: opening the artifact should clear the flag. Keep an explicit `Ack` in one place only — the needs-you strip (`needs-you.ts`), where dismissing an alert without acting *is* the intent. |
| `Rename` | **demote** | Overflow. |
| `Dismiss` | **keep, reword** | `Hide this item`. |

**Missing from the row** (all exist as engine capability, none as a row verb):
- **`Re-review the new commits`** — the engine can re-review (`rereview` stage) but only reconciliation triggers it.
  The moment a human most wants it is precisely the moment the auto-trigger was skipped (they were holding the
  conversation). Rank: first among missing verbs.
- **`Retry`** exists (Phase 18) and is correct. Leave it.

---

## 5. Failure and doubt — five states, five sentences, none of them "ready"

| State | The row says | Availability |
|---|---|---|
| **Agent failed** | `Review failed after 4m — nothing was written.` + `Retry` | **(a)** — `runFailed` + `lastRun.stage/startedAt` are both on the wire (Phase 18/19). Already possible; the wording is what is missing. |
| **Still running** | `Reviewing since 6m — reading the diff.` | **(a)** — `lastRun.startedAt` + `phase`. Never the bare word `running`; a duration is the difference between "working" and "hung". |
| **Finished, verdict you may disagree with** | `The agent says: Request changes — the payment retry loop can double-charge.` then, smaller: `Looked at: the diff and HB-1555 · 2 findings, 1 critical` then `Chat` | **(b)** — the attribution (`The agent says`) is free and load-bearing: it marks the verdict as a claim rather than a fact. The `Looked at` line is contract line 3 (`**Scope:**`), surfaced nowhere today, and it is the single best calibrator of trust the artifacts already carry. |
| **PR changed since the agent looked** | `2 new commits since this review.` + `Re-review the new commits` | **(c)** — `sawLatest`/`staleSince` (§2). Interim today: `PR updated since this review` from `pr.updatedAt > artifactAt`, over-reporting on comments. |
| **Report unreadable** | `The review finished but its report could not be read.` | Currently **indistinguishable from a crash**: `evaluateReview`/`evaluateQa` return `failed` both when the process died and when the file is empty or its verdict block is missing (`artifacts.ts:48-51, 117-124`). The user is told "failed" and offered `Retry` for something that may have produced a perfectly good document with a malformed header. Small engine change; see open questions. |

Ordering rule when several are true: **staleness outranks the verdict, and failure outranks both.** A stale ✅ must
never render as a plain ✅.

---

## 6. What is missing entirely — ranked by how often it bites

1. **The answer.** Verdict + sentence, every kind, every zoom level. Bites on every single finished item — which is
   every item the user came to the panel for. (§2)
2. **Whether the answer still applies.** Staleness. Bites less often than #1 but is the only gap that causes a *wrong*
   action rather than a slow one. (§2, §5)
3. **Whether the review actually reached GitHub.** The review agent posts to the PR itself, and `prompts.ts:533`
   anticipates the exact failure: *"report the review as NOT delivered — say plainly that REVIEW.md is written but
   GitHub has nothing on it"*. The panel has no word for this. A review that exists locally and not on the PR is,
   from the team's point of view, a review that did not happen. Parseable today **(b)** from the per-finding
   `- **Status:** open | held | posted`; a `posted: boolean` would be cheaper. Bites on every review where posting
   fails, silently, forever.
4. **Where the ticket actually is.** The row shows the Jira status as a bare word (`item-parts.ts` ticket part →
   `stateText: item.ticket.status`). "In QA" vs "In Review" vs "Blocked" is the single best predictor of what the user
   should do next, and it renders as undifferentiated grey text under the two agent parts.
5. **What changed since I last looked.** Every moment-3 re-entry is the user reconstructing a delta by memory. The
   engine has `attention.since` and every part has an mtime; nothing renders "new since you were last here".
6. **A way to disagree with a finding, on the record.** `REVIEW.md` has a `🔇 dismissed` status that re-reviews honour —
   written by agents only. The human, who is the one with standing to dismiss a finding, cannot.
7. **What the run cost** (time, tokens). Lowest rank: interesting monthly, never at the moment of judgement.

---

## 7. Open product questions the team must answer

1. **Does the engine own the verdict, or does the panel parse it?** My ruling is the engine (§2) — one parse, one
   vocabulary, two clients. But it makes the engine responsible for a *presentation* string, which the codebase has
   so far avoided. Decide explicitly rather than letting `qaVerdict` set precedent by accident.
2. **If the row shows the answer, why open the artifact?** This is a real product fork. Either the panel is an
   **index** (row = pointer, artifact = content) or a **reader** (row = the answer, artifact = the evidence). I argue
   reader — the user's complaint is a reader's complaint. But that changes what the Item tab is for, and Phase 17
   built it as the reader.
3. **Is "failed" allowed to mean two things?** Crash and unparseable-report are one word today (§5). Splitting them
   costs one field and changes what `Retry` means.
4. **Does the three-slot lifecycle still describe the product?** Investigation → Development → Review was the ladder;
   `respond` and `qa` both sit off it by explicit design (R70, R51), which is two of five kinds outside the model the
   expansion is organised around. Worth re-asking before another phase builds on it.
5. **What does a human disagreement do to the pipeline?** If the user rejects a finding, does the next re-review know?
   (§6.6) Today the answer is no, and the agent will re-raise it.
6. **Should the panel ever act on GitHub directly** (approve, merge, re-request review), or is the agent always the
   hand? Today the agent is, and the panel's verbs are all "start an agent" or "go look". That is a defensible line —
   but it should be a decision, because "Approve" is the verb a user will look for the moment the row says `Approve`.
