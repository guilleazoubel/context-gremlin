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

1. **Solves the right thing** — the Jira ticket is the source of truth. The review first checks the PR actually satisfies the ticket's intent/acceptance criteria before judging the code.
2. **High signal only** — real bugs (correctness, security, regression), *provable* performance issues, and *concrete* separation-of-concerns / maintainability violations. Drop cosmetic style, naming, and vague "could be cleaner" suggestions entirely.
3. **Evidence bar** — a finding is written only if the model can state concrete evidence for it (Trigger/Expected/Actual for bugs; Tangle/Consequence/Direction for maintainability). If it can't, the finding is dropped.
4. **Fast by default, deep when complex** — a tiered review: cheap intent + core scan on every PR; a deeper fan-out only when the PR is large, risky, or the core scan surfaces something deep.
5. **Fast judgment** — each finding is tight (severity + evidence + location + fix), so the reviewer can decide in seconds.
6. **Guided triage** — the agent presents a summary menu first, then drills into findings on demand, capturing a post/hold/dismiss decision for each.
7. **Flexible posting** — the reviewer can post a finding mid-conversation or hold it and submit everything at the end.
8. **Clean layering** — generator writes data, agent renders data + records decisions, bash helpers own GitHub. `REVIEW.md` is the seam.
9. **Owned prompt, not a sealed skill** — the review logic lives in cgremlin's own prompt (borrowing proven pieces from the apfm skill), so intent-gate, depth, posting path, and re-review are all under our control.

---

## Layering (architecture)

`REVIEW.md` is the single source of truth and the contract between layers.

### Data layer — `REVIEW.md`

Holds findings in a fixed schema. Per finding:

| Field | Meaning |
|---|---|
| `id` | Sequential integer (stable across re-reviews) |
| `severity` | `🔴 Critical` / `🟠 High` / `🟡 Perf` / `🔧 Maintainability` |
| `location` | `path/to/file.ts:LN-LN` (must be a changed file) |
| `evidence` | For bugs/perf: **Trigger / Expected / Actual**. For maintainability: **Tangle / Consequence / Direction** (see below). |
| `fix` | Suggested fix snippet or refactor direction |
| `status` | `open` / `held` / `posted` / `🔇 dismissed` |

An `intent alignment` note also lives at the top of `REVIEW.md` (see Intent Gate) — it is not a numbered finding unless the PR fails to satisfy the ticket, in which case it becomes a 🔴 finding.

Nothing else stores findings. Both prompts and the re-review worker agree on this schema.

### Business logic

- **Review generation** (generator prompt): analyze the diff → emit only findings that pass the confidence gate → write `REVIEW.md`. Produces **data only**. Does NOT format ready-to-post comments, does NOT give collaboration instructions, and NEVER calls `gh`.
- **Posting** (existing bash helpers `_post_review` / `approve_pr` / `comment_pr` / `request_changes_pr`): the ONLY code that mutates GitHub. The agent shells out to these.

### UI layer — triage agent (`AGENT_CONTEXT.md`)

Reads `REVIEW.md`, presents findings, captures the reviewer's decision, writes it back to the `status` field, and calls a bash helper to post. It renders and records — it does not analyze or talk to GitHub directly.

---

## Severity model

Four levels:

| Severity | Meaning | Blocks merge? |
|---|---|---|
| 🔴 Critical | Correctness or security bug with concrete impact; OR the PR does not satisfy the Jira ticket | Yes |
| 🟠 High | Real bug, narrower impact — should fix | Reviewer's call |
| 🟡 Perf | Provable performance issue (points to the exact N+1 / unbounded loop / repeated work) | No |
| 🔧 Maintainability | Concrete separation-of-concerns or coupling violation with a real consequence | No |

Removed: 🟡 Medium (generic), 🔵 Suggestions/Nice-to-have, and all *cosmetic* code-style categories (naming, formatting, import order, "consider extracting").

---

## The evidence bar (the core rule)

Before writing ANY finding, the generator must be able to fill in concrete evidence. There are two forms depending on the finding type.

### Bugs & performance — Trigger / Expected / Actual
- **Trigger:** the exact input or state that exercises it
- **Expected:** what should happen
- **Actual:** what happens instead

Performance findings must name the specific hot path (the exact N+1 / unbounded loop / repeated work), not a hunch.

### Maintainability & separation of concerns — Tangle / Consequence / Direction
- **Tangle:** the two concerns that are mixed, named concretely — e.g. "business logic (tax calc) lives inside the React render body" or "data fetching is embedded in the UI component"
- **Consequence:** the concrete cost — what *cannot* be tested in isolation, changed without touching unrelated code, or reused, *as a direct result*. Not "this is harder to read."
- **Direction:** the separation to apply — e.g. "extract the calc into a pure function / move the fetch into a hook or service."

If a finding can't fill in its form concretely, it is **dropped, not downgraded**. "This might be slow", "this could be cleaner", "consider extracting" (with no named consequence) never qualify. A maintainability finding without a concrete Consequence is a style opinion — drop it.

This is what keeps the maintainability lens from regressing into noise: it must prove a coupling that will actually bite, not express a preference.

---

## Intent gate (Jira as source of truth)

Runs first, on every PR, before any code finding.

1. Resolve the Jira ticket from the branch/PR (cgremlin already auto-detects the key). Fetch it via the Atlassian MCP if available; otherwise fall back to the PR description.
2. Extract the intent / acceptance criteria.
3. Judge: **does this PR actually do what the ticket asked?** Write a one-line `Intent alignment:` note at the top of REVIEW.md — ✅ satisfies / ⚠️ partial / ❌ diverges.
4. If ⚠️ or ❌, that becomes a 🔴 finding (with the ticket criterion as Expected and the PR's behavior as Actual). Solving the wrong thing correctly is still a failure.
5. If no ticket is resolvable, note "No ticket found — reviewed against PR description" and proceed.

---

## Tiered depth (fast by default, deep when complex)

One owned prompt, three tiers:

- **Tier 0 — Intent (always, cheap):** the Intent Gate above.
- **Tier 1 — Core scan (always, fast):** a single pass over the diff for correctness / security / regression, plus the maintainability lens, under the evidence bar.
- **Tier 2 — Deep dive (conditional):** the agent escalates ONLY when a complexity trigger is met — large diff (e.g. > ~400 changed lines or > ~15 files), changes to shared/critical paths (auth, payments, migrations, shared utils), or Tier 1 surfaced something whose blast radius needs cross-file tracing. On escalation it fans out parallel sub-agents (e.g. perf, cross-file data-flow, the extra apfm lenses). On a normal PR, Tier 2 is skipped — keeping it quick.

The prompt states the triggers explicitly so the decision is deterministic, and notes in REVIEW.md whether Tier 2 ran.

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

- *Cosmetic* code quality — naming, formatting, import order, line length
- "Complexity/over-engineering" as a *preference* (kept only when it's a concrete separation-of-concerns violation with a named consequence — see the Maintainability lens)
- Best-practice style rules (React/UX) that are not tied to a bug
- "🔵 Suggestions (Nice to Have)" output section
- "Ready-to-Post Review Comments" output section (presentation → moves to triage agent)
- "Ongoing Collaboration" instructions (UI → moves to triage agent)

Kept: scope gate (changed-files-only), PR-type classification, correctness, security, regression risk, provable performance, and — new — the Jira intent gate and the gated maintainability / separation-of-concerns lens.

---

## Files changed (code structure)

`bin/cgremlin` only — no new files (single-bash-script rule). Three prompt sites, kept in sync:

| # | Location | Prompt | Change |
|---|---|---|---|
| 1 | `generate_claude_md()` `REVIEW_TEMPLATE` (the generator the automated flow actually uses) | Generator → session `CLAUDE.md` | Intent gate, tiered depth, evidence bar, 4-severity (+ Maintainability), data-only schema |
| 2 | `create_review_agent_pane()` `AGENT_CONTEXT.md` heredoc | Triage agent | Summary-menu-first triage protocol (severity-agnostic; handles the new lens automatically) |
| 3 | `rereview_pr()` RE-REVIEW.md + interactive `refresh_pr_session` + Python server re-review | Re-review worker | Inherit evidence bar + 4-severity; verify each prior finding was *properly* addressed; preserve 🔇 dismissals |
| 4 | Launch prompts (bash + Python + JS constant) | Review/re-review launch | Align severity enumeration and intent-gate reference |

**Relationship to the apfm skill:** the initial-review prompt borrows apfm's proven ideas (Jira agent, confidence rubric, exclude-filters) but the logic is owned in cgremlin — the sealed skill is not depended on, so the single posting path (REVIEW.md → triage → `--comment-pr`) and the re-review verification stay under our control.

**Sync requirement (CLAUDE.md):** the bash script and the embedded Python server must stay in sync — the re-review changes go into both the bash `rereview_pr()` and the Python dashboard re-review path.

**Verification after edits:** `bash -n bin/cgremlin`, and extract the PYSERVER heredoc + `ast.parse()`.

---

## Error handling

- **Generator finds nothing provable** → `REVIEW.md` shows "No high-confidence findings" and verdict ✅ Approve; triage agent opens with an empty menu and offers to approve.
- **Re-review: prior fix is incomplete/wrong** → the re-review must re-run each prior finding's Trigger against the new code and classify ✅ properly resolved / ⚠️ partially fixed / ❌ still broken / 🔁 fix introduced a new problem, with evidence, before scanning for new issues. A partial/regressed fix stays open (or becomes a new finding), and the `rereview_summary` reflects it accurately.
- **Intent gate: no Jira access** → note "reviewed against PR description" and continue; never block the review on Jira being unavailable.
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
