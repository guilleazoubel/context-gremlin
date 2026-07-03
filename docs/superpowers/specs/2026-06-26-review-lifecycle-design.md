# Review Lifecycle Design
**Date:** 2026-06-26
**Status:** Draft — pending user review
**Sub-project:** 1b of the Mission Control effort. Builds on `2026-06-25-mission-control-pr-orchestrator-design.md`. The automation (sub-project 2: scanner/daemons) is deferred and consumes this lifecycle's commands.

---

## Problem

The Mission Control cockpit can queue headless reviews and open a finished REVIEW.md with a discussion agent, but the review's life ends at "ready." There is no way to:
- see a review go `reviewing → ready` live in the panel (the fzf picker only redraws on interaction, so an in-progress review looks static);
- act on a review from the agent (approve / comment / request changes on GitHub);
- track a PR you've given feedback on and re-review it once the author responds, while preserving what you flagged.

This sub-project adds the full manual review lifecycle. The future automation (sub-project 2) will drive the exact same commands.

---

## Goals

1. The panel reflects review state **live** (auto-refresh ~2s): `reviewing` appears immediately, transitions to `ready` on its own.
2. From the discussion agent, **act on a PR** — post a GitHub review (Approve / Comment / Request-Changes) — **always after explicit user confirmation of the type**.
3. PRs you've commented on / requested changes move to a **Waiting for re-review** section; approved PRs are archived and removed.
4. **Re-review** is incremental: it checks whether prior findings (some posted as comments) were resolved, finds new issues from new commits, and **updates REVIEW.md in place**, preserving the Findings Tracker and Review History.
5. Every new action is a CLI command, so sub-project 2's daemons reuse them with no new lifecycle logic.

## Non-Goals (deferred)

- The automation/daemons (scan team PRs, merged-cleanup, new-commit polling) — sub-project 2.
- Inline per-line GitHub comments — the agent posts a single PR review with a composed body (line-specific comments may come later).
- Review-quality prompt tuning beyond what re-review needs.

---

## State Model

Three fields on `session.json`, each with one responsibility:

| Field | Values | Meaning | Owner |
|---|---|---|---|
| `review_state` | `queued`/`reviewing`/`ready`/`failed`/`interrupted` | the (re-)review worker's progress | worker |
| `lifecycle` | `none`/`commented`/`changes-requested`/`approved` | the human's posted decision | discussion agent via CLI |
| `triage_state` | `open`/`done` | visible vs hidden/archived | approve, dismiss, merged-cleanup |

Defaults: `lifecycle` defaults to `none` (like `review_state` → `none`, `triage_state` → `open`).

### Transitions

```
ask review ─→ review_state=queued → reviewing → ready   (lifecycle=none)

ready ─approve──────────→ gh pr review --approve  → lifecycle=approved, triage=done (archived, removed)
ready ─comment──────────→ gh pr review --comment  → lifecycle=commented        (→ Waiting section)
ready ─request-changes──→ gh pr review --request-changes → lifecycle=changes-requested (→ Waiting section)

waiting ─click re-review→ review_state=reviewing → ready (lifecycle reset to none, REVIEW.md updated)

(sub-project 2) merged/closed → triage=done
```

### Picker grouping (derived from the fields)

- **── Reviews ──**: `triage_state=open` AND `lifecycle=none` (covers queued/reviewing/ready/failed/interrupted).
- **── Waiting for re-review ──**: `triage_state=open` AND `lifecycle ∈ {commented, changes-requested}`.
- **Hidden**: `triage_state=done` (approved or dismissed or merged).

---

## Components (all extend `bin/cgremlin`)

### 1. State helpers
Add `update_lifecycle <session_dir> <none|commented|changes-requested|approved>` and `read_lifecycle <session_dir>` (default `none`), mirroring the existing `*_review_state` / `*_triage_state` helpers (near line ~191).

### 2. Live, two-section picker (`--status-pane`)
Rewrite the picker loop so it:
- Builds two labeled groups (Reviews, Waiting) from the fields above. Group headers are non-selectable rows (e.g., fzf `--header` lines or disabled rows that no-op on select).
- **Auto-refreshes** without user interaction: use fzf's reload binding so the list regenerates ~every 2s (e.g. `--bind 'load:reload(sleep 2; cgremlin --review-list)'` style loop, or fzf `--listen`/periodic `reload`). The picker must stay responsive to selection while refreshing. If a fully reliable in-fzf timer proves impossible on the installed fzf, fall back to a short-timeout redraw loop (`fzf ... ; regenerate; repeat`) — pick whichever reliably shows `reviewing→ready` without a keystroke; record which was used.
- Selection behavior by the item's state:
  - item in **Reviews** with `review_state=ready` → `cgremlin --open-pr <session>` (existing).
  - item in **Reviews** still `reviewing/queued` → no-op (or a "still running" toast).
  - item in **Waiting** → `cgremlin --rereview-pr <session>` (triggers incremental re-review; it returns to Reviews as `reviewing→ready`).
- Provide a machine-readable `cgremlin --review-list` that emits the picker's lines (`<label>\t<session>\t<group>`), so the picker and any reload binding share one generator.

### 3. Discussion-agent posting actions
The discussion agent (opened by `--open-pr`) gains the ability to post a GitHub review, **always confirming the type with the user first** (conversationally, in-pane). It composes the review body from REVIEW.md. New CLI helpers it calls AFTER posting (or that wrap posting):

- `cgremlin --approve-pr <session>`: runs `gh pr review <num> --repo <owner/repo> --approve --body "<body>"`, then `update_lifecycle approved` + `update_triage_state done` + archive the clone (free disk, keep `session.json` + REVIEW.md). Removed from panel.
- `cgremlin --comment-pr <session>` and `cgremlin --request-changes-pr <session>`: run `gh pr review … --comment` / `--request-changes` with the body, then `update_lifecycle commented` / `changes-requested`. Moves to Waiting.

Body source: the agent writes the intended review body to `$SESSION_DIR/.review_body.md`, and the helper posts it with `gh pr review … --body-file "$SESSION_DIR/.review_body.md"`. The agent also marks the Findings-Tracker IDs it posted as `posted` in REVIEW.md so re-review can check exactly those.

The discussion-agent CLAUDE.md is updated: it MAY post via these commands, but MUST confirm the review type with the user before doing so. The **headless review/re-review worker still never posts** to GitHub.

### 4. Re-review (`cgremlin --rereview-pr <session>`)
Like `--review-pr` but operates on the existing session:
- `cd repo && git fetch` the PR ref and fast-forward/checkout the latest head commit.
- Set `review_state=reviewing`, `lifecycle=none`.
- Launch a headless worker with an **incremental re-review prompt**: "REVIEW.md contains the prior Findings Tracker; some findings were posted as comments (marked `posted`). For each prior finding, determine Resolved or Still-open and update its status in the tracker. Review the new commits since the last review for new issues and add them. Update REVIEW.md IN PLACE — keep the tracker and append a Review History row. Do not start from scratch; preserve prior state." Proceed autonomously, no GitHub posting.
- On completion: `review_state=ready`. The card reappears in Reviews for the user's decision.

### 5. REVIEW.md format contract
The review and re-review prompts must produce/maintain: a **Findings Tracker** (ID, Finding, Severity, Status[open/resolved/posted], Since-version), per-finding detail, a **Verdict**, and a **Review History** (version, date, commit, action). This already matches the existing review format; re-review depends on it being present and stable.

---

## Data Flow (end to end)

1. Orchestrator: you ask to review PR N → `cgremlin --review-pr <url>` → `review_state` queued→reviewing. **Picker shows `reviewing` within ~2s** (live refresh).
2. Worker writes REVIEW.md → `review_state=ready`. Picker shows ✅ ready in **Reviews**.
3. You select it → md + agent open in PRs tab. You discuss.
4. You tell the agent to act; it confirms the type, posts the GitHub review, calls the matching helper:
   - approve → archived, removed from panel.
   - comment / request-changes → moves to **Waiting**.
5. Later you select the Waiting card → `--rereview-pr` → incremental re-review updates REVIEW.md in place → `ready` → reappears in **Reviews**.
6. Repeat 3–5 until approved.

---

## Error Handling

- `gh pr review` failure (network/auth/perms): the helper reports the error to the agent, does NOT change `lifecycle` (so the card stays actionable), and the agent surfaces it to the user.
- Re-review with no new commits: still runs; the tracker simply shows prior findings unchanged — acceptable (the user chose to re-review).
- Interrupted re-review worker: existing `detect_interrupted` sweep marks it `interrupted`; the card stays in Reviews for retry.
- Archive-on-approve must be safe if the clone is already gone (idempotent).

---

## Verification

- Starting a review shows `reviewing` in the picker within ~2s **without** any keypress; it flips to `ready` on its own.
- The picker shows two sections; a `ready` item opens md+agent; a Waiting item triggers re-review.
- In the agent, requesting "approve" → it confirms type → posts a real GitHub Approve review (verifiable on the PR) → card disappears and the session is archived.
- Requesting "comment" → posts a GitHub Comment review → card moves to Waiting.
- Selecting a Waiting card re-reviews incrementally: REVIEW.md keeps prior findings, marks resolved/still-open, adds new ones, appends a Review History row; card returns to Reviews as `ready`.
- The headless worker never posts to GitHub; only the agent does, and only after confirmation.

---

## Files Changed (anticipated)

- `bin/cgremlin` — `update_lifecycle`/`read_lifecycle`; `--review-list` generator; rewrite `--status-pane` picker (two sections + live refresh); add `--approve-pr`/`--comment-pr`/`--request-changes-pr`/`--rereview-pr` dispatch + functions + dashboard-skip-guard exclusions; incremental re-review worker prompt; update discussion-agent CLAUDE.md to allow confirmed posting; ensure review prompt emits the Findings Tracker/Review History contract.
- No new files required.

---

## Build Order

1. State helpers (`lifecycle`) + `--review-list` generator.
2. Two-section live picker.
3. `--rereview-pr` (incremental worker + prompt).
4. Agent posting helpers (`--approve-pr`/`--comment-pr`/`--request-changes-pr`, archive-on-approve) + discussion CLAUDE.md update.
5. Wire picker selection to `--open-pr` (Reviews) and `--rereview-pr` (Waiting).
6. REVIEW.md format contract check (tracker/history present and stable).
