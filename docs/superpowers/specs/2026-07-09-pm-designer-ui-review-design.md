# PM / Designer Headless UI Review Design

**Date:** 2026-07-09
**Status:** Draft
**Builds on:** the review/develop agents and their per-session `CLAUDE.md` briefs, the run-local feature (`cgremlin --run-local`), the reviewer-comment/approval flow, `REVIEW.md`, and the confirmed headless MCP access (atlassian, figma, chrome-devtools, playwright).

---

## Problem

A code review today checks the *code*, not the *running UI*. Whether the change actually satisfies the ticket's acceptance criteria, and whether it matches the Figma design in detail (fonts, colors, sizes, spacing), is left to the human. We want the review to also run a **headless UI check** through two lenses — a **PM** (functional / acceptance-criteria) lens and a **Designer** (design-fidelity) lens — against the PR's preview, and fold what it finds into the review with clear, side-by-side visual evidence. The same two-lens check also runs during **develop**, where it drives a fix-loop instead of just reporting.

Feasibility is confirmed: a headless `claude -p --permission-mode bypassPermissions` subprocess has `atlassian`, `figma`, `chrome-devtools`, and `playwright` MCP servers available.

---

## Goals

1. **Two focused lenses as dedicated subagents.** The orchestrating agent spawns a **PM** subagent and a **Designer** subagent (each inheriting MCP), rather than one agent juggling all lenses.
2. **PM lens = acceptance criteria.** Read the Jira ticket (`getJiraIssue`; fall back to PR description), drive the target in chrome-devtools, and check whether each acceptance criterion actually holds in the running UI.
3. **Designer lens = design fidelity.** Find a **Figma link in the Jira**. If present, compare the rendered UI against the design in detail — font family/size/weight, colors, spacing, element sizes, layout — using Figma MCP for the design spec and chrome-devtools `getComputedStyle` for the rendered values. If absent, do a **general visual sanity** pass.
4. **Side-by-side evidence.** For each visual discrepancy, produce a side-by-side artifact (Figma reference next to the actual rendering) captioned with the exact mismatch, so the issue is self-evident and reusable in the PR.
5. **Shared across review and develop**, parameterized by target and mode.
6. **Graceful degradation.** Missing MCP tool or preview → note it in `REVIEW.md` and continue; never fail the review over unavailable tooling.

---

## Non-goals

- Fixing code on the **review** side (observe-only). Develop's engineer does the fixing.
- A full e2e/visual-regression suite. This is a focused, targeted check of the changed feature.
- Auto-posting screenshots to the PR. Evidence is written to the session for the user to reuse.
- Building develop's full autonomous PM→Designer→Engineer fix-loop orchestration here — this spec defines the shared **check**; develop's loop consumes it (its own follow-on work).

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| Review approval gate | UI findings are **additive** — they appear in `REVIEW.md` but do NOT block the approve safety gate. |
| No Figma link in Jira | Designer lens does a **general visual sanity** pass; PM lens still runs. |
| Review side | **Observe-only** — adds findings + evidence, never edits code. |
| Develop side | **Fix** — the two lenses feed develop's fix-loop (engineer fixes root cause, re-check until both pass). |
| Structure | **Dedicated PM + Designer subagents** spawned by the orchestrating agent (approach B). |
| Targets | Review → **preview** (local only if the user asks). Develop → **local** during dev; **preview** after the PR opens. |

---

## Architecture

### The shared two-lens block

A single, well-specified brief block — the **UI check protocol** — written once and referenced by both the review and develop `CLAUDE.md` templates. It is parameterized by:

- `TARGET_URL` — the preview URL (review) or the local URL `https://local.findcare.dev.aplaceformom.com/` (develop / review-on-request).
- `MODE` — `observe` (review: report only) or `fix` (develop: findings drive fixes).

The orchestrating agent, at the UI-check step, spawns two subagents (Task tool; they inherit the parent's MCP servers) and passes each the `TARGET_URL`, the Jira key, and the changed-files/feature context.

### PM subagent

Prompt (role: product manager verifying the ticket):
1. Read the Jira ticket via `getJiraIssue` (fall back to the PR description if Atlassian MCP is unavailable). Extract the acceptance criteria / intended behavior.
2. Open `TARGET_URL` in chrome-devtools; navigate to the changed feature.
3. For each acceptance criterion, exercise it in the UI and record: **holds / broken / missing**, with a one-line observation and a screenshot path for anything not holding.
4. Return structured findings (see schema) — no code edits.

### Designer subagent

Prompt (role: designer checking pixel fidelity):
1. Find a Figma link in the Jira ticket (scan `getJiraIssue` description + remote links for a `figma.com/...` URL; capture any `node-id`).
2. **If a link exists:** read the design spec via Figma MCP — `get_variable_defs` (color / spacing / typography tokens), `get_design_context`, `get_screenshot` of the relevant node. Open `TARGET_URL` in chrome-devtools; for each key element, read rendered values with `evaluate_script` (`getComputedStyle`: `font-family`, `font-size`, `font-weight`, `color`, `background-color`, `padding`, `margin`, width/height, `border-radius`, …). Compare against the design. Flag each mismatch with the design value vs the rendered value.
3. **If no link exists:** general visual sanity — alignment, spacing consistency, responsive breakpoints (resize via chrome-devtools), obvious visual bugs — and note "no Figma link found in Jira."
4. For each visual discrepancy, produce the **side-by-side evidence** (below).
5. Return structured findings — no code edits.

### Side-by-side evidence (per visual discrepancy)

Written to `$SDIR/ui-findings/`:

1. `finding-N-figma.png` — Figma reference crop (`figma get_screenshot` of the node). Omitted for the no-link sanity path.
2. `finding-N-rendered.png` — the preview screenshot of the same component (`chrome-devtools take_screenshot`).
3. `finding-N.html` — a **self-contained** page showing the two images side by side, captioned with the exact mismatch (e.g. *Figma `#1A73E8` / rendered `#1B74E9`; font-size Figma `16px` / rendered `14px`*).
4. `finding-N.png` — `finding-N.html` loaded in chrome-devtools and screenshotted, giving one composed image to paste into the PR.

No external image compositor is required (none is installed); the HTML page + chrome-devtools screenshot is the composition mechanism.

### Findings schema (returned by each subagent, merged by the orchestrator)

```
- lens:        "pm" | "designer"
- title:       short description
- severity:    🔴 Critical | 🟠 High | 🟡 Minor
- criterion:   the AC or design property checked
- expected:    design/AC value (e.g. "#1A73E8, 16px")
- actual:      rendered value (e.g. "#1B74E9, 14px")
- location:    URL/route + component/selector
- evidence:    relative path to finding-N.html / finding-N.png (designer only)
```

---

## Integration

### Review (observe)

- After the code-review findings are written, the review agent runs the two-lens check against the **preview URL** (discover it from `gh pr view <n> --json statusCheckRollup,comments` — the grace-frontend-dev deployment, or a Storybook link). Local only if the user explicitly asks (`cgremlin --run-local` then target the local URL).
- Merge PM/Designer findings into `REVIEW.md`'s findings table with two new types: **📋 PM/AC** and **🎨 Design**. Each Design finding links its `ui-findings/finding-N.html` (and the composed `.png`).
- These are **additive**: they do not feed `_pr_safety_check`; approve is unaffected. The user decides.

### Develop (fix)

- In develop's verify step, run the same two lenses against **local** during development, and against the **preview** once the draft PR exists.
- Findings drive develop's fix-loop: the engineer fixes the root cause (no hacks, correct patterns, no over-engineering), then the check re-runs until PM and Designer both pass.

---

## Error handling

| Condition | Action |
|---|---|
| Atlassian MCP unavailable | PM: fall back to PR description as intent. Designer: note "could not read Jira for a Figma link"; do the general sanity pass. |
| No Figma link in Jira | Designer: general visual sanity pass; note it. |
| Figma MCP unavailable / link unreadable | Note it in `REVIEW.md`; fall back to a screenshot-only visual sanity comparison. |
| chrome-devtools can't load target | Note it; skip the UI check for that lens (never crash the review). |
| Preview URL not ready | Note "preview not yet deployed"; the user can re-run, or (review) ask for a local run. |

---

## Components (files changed — `bin/cgremlin` only)

- **New shared brief block** (the UI check protocol) emitted into both the review and develop `CLAUDE.md` templates, parameterized by `TARGET_URL` and `MODE`. Written by the existing `create_review_agent_pane` / `write_develop_brief` paths.
- **Review CLAUDE.md:** add the UI-check step (observe mode, preview target) after code-review findings; define the 📋 PM/AC and 🎨 Design finding types and the `REVIEW.md` table columns for expected/actual/evidence.
- **Develop CLAUDE.md:** wire the two lenses into the verify step (fix mode; local then preview).
- **`ui-findings/` convention** under the session dir for evidence artifacts.
- No new dispatch subcommand (approach B keeps orchestration inside the agent). No Python dashboard changes required for v1; the dashboard MAY later surface `ui-findings/` — out of scope here.

---

## Verification

Like the run-local smoke test: after building, run one real review on a PR whose Jira ticket has a Figma link. Confirm the Designer subagent (a) finds the link, (b) reads design tokens and rendered computed styles, (c) writes side-by-side `ui-findings/finding-N.html` + `.png`, and (d) the 📋/🎨 findings land in `REVIEW.md` with expected-vs-actual and evidence links — and that a no-link ticket degrades to the sanity pass.
