# High-Signal PR Review + Guided Triage Design

**Date:** 2026-07-03
**Status:** Draft
**Builds on:** `2026-06-30-review-agent-floating-pane-design.md` (floating pane, posting helpers, re-review worker)

---

## Problem

The current review prompt flags 7+ categories — correctness, security, performance, code quality, complexity, best-practice style rules, and "nice to have" suggestions. Most are low-signal: style opinions, suspected-but-unproven performance issues, and cosmetic nits. The reviewer (Guilherme) wants the opposite: **only high-confidence, provable findings**, each framed so he can instantly judge severity — *what was supposed to happen vs. what actually happens*. Then the launched agent should walk him through the findings so he can decide, per finding, whether to post or dismiss.

Two prompts drive this and both are misaligned:
- The **generator prompt** (writes `REVIEW.md`) over-produces and mixes presentation ("Ready-to-Post Comments") and UI ("Ongoing Collaboration") into what should be pure data.
- The **triage agent prompt** (`AGENT_CONTEXT.md`) is vague ("help the user understand the analysis") with no protocol, so it dumps everything at once.

---

## Goals

1. **High signal only** — real bugs (correctness, security, regression) plus *provable* performance issues. Drop style, complexity, and suggestions entirely.
2. **Confidence gate** — a finding is written only if the model can state its exact Trigger, Expected, and Actual behavior. If it can't, the finding is dropped.
3. **Fast judgment** — each finding is tight (severity + Expected/Actual + trigger + location + fix snippet), so the reviewer can decide in seconds.
4. **Guided triage** — the agent presents a summary menu first, then drills into findings on demand, capturing a post/hold/dismiss decision for each.
5. **Flexible posting** — the reviewer can post a finding mid-conversation or hold it and submit everything at the end.
6. **Clean layering** — generator writes data, agent renders data + records decisions, bash helpers own GitHub. `REVIEW.md` is the seam.

---

## Layering (architecture)

`REVIEW.md` is the single source of truth and the contract between layers.

### Data layer — `REVIEW.md`

Holds findings in a fixed schema. Per finding:

| Field | Meaning |
|---|---|
| `id` | Sequential integer (stable across re-reviews) |
| `severity` | `🔴 Critical` / `🟠 High` / `🟡 Perf` |
| `location` | `path/to/file.ts:LN-LN` (must be a changed file) |
| `trigger` | The exact input/state that exercises the bug |
| `expected` | What the code is supposed to do |
| `actual` | What it actually does |
| `fix` | Suggested fix snippet |
| `status` | `open` / `held` / `posted` / `🔇 dismissed` |

Nothing else stores findings. Both prompts and the re-review worker agree on this schema.

### Business logic

- **Review generation** (generator prompt): analyze the diff → emit only findings that pass the confidence gate → write `REVIEW.md`. Produces **data only**. Does NOT format ready-to-post comments, does NOT give collaboration instructions, and NEVER calls `gh`.
- **Posting** (existing bash helpers `_post_review` / `approve_pr` / `comment_pr` / `request_changes_pr`): the ONLY code that mutates GitHub. The agent shells out to these.

### UI layer — triage agent (`AGENT_CONTEXT.md`)

Reads `REVIEW.md`, presents findings, captures the reviewer's decision, writes it back to the `status` field, and calls a bash helper to post. It renders and records — it does not analyze or talk to GitHub directly.

---

## Severity model

Collapses from 5 levels to 3:

| Severity | Meaning | Blocks merge? |
|---|---|---|
| 🔴 Critical | Correctness or security bug with concrete impact | Yes |
| 🟠 High | Real bug, narrower impact — should fix | Reviewer's call |
| 🟡 Perf | Provable performance issue (points to the exact N+1 / unbounded loop / repeated work) | No |

Removed: 🟡 Medium (generic), 🔵 Suggestions/Nice-to-have, all code-style and complexity categories.

---

## Confidence gate (the core rule)

Before writing ANY finding, the generator must be able to fill in:

- **Trigger:** the exact input or state that exercises it
- **Expected:** what should happen
- **Actual:** what happens instead

If any of the three can't be stated concretely, the finding is **dropped, not downgraded**. "This might be slow" / "this could be cleaner" / "consider extracting" never qualify. Performance findings must name the specific hot path, not a hunch.

---

## Triage protocol (`AGENT_CONTEXT.md`)

The launched agent follows a fixed script:

1. **Open with a summary menu** — read `REVIEW.md`, print a one-line roll-up and a numbered list:
   ```
   3 findings — 1 🔴  2 🟠.  Which to discuss? (number, or "all")
   1. 🔴 Race in checkout total   payment/cart.ts:88
   2. 🟠 Null deref on empty list  ui/list.tsx:40
   3. 🟠 Missing await on save     api/save.ts:12
   ```
2. **On selection** — present that finding tight: severity, **Expected vs. Actual**, trigger, location, and the fix snippet. Then discuss.
3. **Capture decision** — the reviewer says one of:
   - **"post it"** → agent posts that finding as a line comment now (via a bash helper) and sets `status: posted`.
   - **"hold it"** → agent sets `status: held` (queued for batch submit).
   - **"dismiss"** → agent sets `status: 🔇 dismissed` so re-reviews skip it.
4. **On "submit"** — agent posts one GitHub review carrying all `held` comments plus the verdict, via `--comment-pr` / `--approve-pr` / `--request-changes-pr`.

The agent updates the `status` field in `REVIEW.md` after every decision, so state survives a pane restart and re-reviews respect dismissals.

---

## What is removed from the generator prompt

- PHASE 3.4 Code Quality
- PHASE 3.5 Complexity
- PHASE 3.8 Best Practices (React/UX style rules)
- "🔵 Suggestions (Nice to Have)" output section
- "Ready-to-Post Review Comments" output section (presentation → moves to triage agent)
- "Ongoing Collaboration" instructions (UI → moves to triage agent)

Kept: scope gate (changed-files-only), PR-type classification, correctness, security, regression risk, and provable performance.

---

## Files changed (code structure)

`bin/cgremlin` only — no new files (single-bash-script rule). Three prompt sites, kept in sync:

| # | Location | Prompt | Change |
|---|---|---|---|
| 1 | `# PR REVIEW` section, `CLAUDE_EOF` heredoc (~line 2137) | Generator → `repo/CLAUDE.md` | Confidence gate, 3-severity, new finding schema, remove noise sections |
| 2 | `create_review_agent_pane()` `AGENT_CONTEXT.md` heredoc (~line 394) | Triage agent | Replace vague text with the triage protocol above |
| 3 | `rereview_pr()` `claude -p` prompt (~line 12650) + Python server re-review launch (~line 6536 / RE-REVIEW.md ~line 6412) | Re-review worker | Inherit confidence gate + 3-severity + schema; preserve dismissals |

**Sync requirement (CLAUDE.md):** the bash script and the embedded Python server must stay in sync — the re-review changes go into both the bash `rereview_pr()` and the Python dashboard re-review path.

**Verification after edits:** `bash -n bin/cgremlin`, and extract the PYSERVER heredoc + `ast.parse()`.

---

## Error handling

- **Generator finds nothing provable** → `REVIEW.md` shows "No high-confidence findings" and verdict ✅ Approve; triage agent opens with an empty menu and offers to approve.
- **Reviewer dismisses everything** → all `🔇 dismissed`; nothing posts; re-reviews skip them.
- **Post fails (GitHub error)** → bash helper leaves `status` unchanged; agent reports the error; finding stays `held` for retry.
- **Pane restart mid-triage** → `status` fields in `REVIEW.md` preserve progress; agent re-reads and resumes the menu.

---

## What is NOT changing

- Floating pane mechanism, PID tracking, `ensure_agent_panes`, watch-daemon auto-pickup, posting-helper plumbing — all carry over unchanged.
- The scope gate (changed-files-only) and PR-type classification stay.
- The three-section status picker and re-review summary line stay.

---

## Prompt authoring

After this spec is approved, the three prompts are rewritten using the `prompt-master` skill to follow the proper structure for our models (clear role, explicit constraints, ordered steps, output contract). This spec defines *what* the prompts must enforce; prompt-master governs *how* they're written.
