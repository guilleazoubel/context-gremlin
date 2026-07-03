# Review Lifecycle v2 Design
**Date:** 2026-06-29
**Status:** Draft — pending user review
**Builds on:** `2026-06-26-review-lifecycle-design.md` (lifecycle v1) and the Mission Control cockpit. Revises the picker's grouping, click behavior, and adds a background watch daemon. The team-PR *discovery* scanner remains a separate later sub-project.

---

## Problem

Lifecycle v1 gave us two picker sections (Reviews / Waiting) and manual re-review. In use, that doesn't tell you *what needs your action*: a PR you've commented on sits in the same bucket whether or not the author has responded, re-review only happens if you remember to click, and clicking a "waiting" card silently re-reviewed instead of opening it. Merged PRs only got hidden, so stale sessions pile up on disk. And opened reviews landed in Mission Control's own tab next to a leftover placeholder pane rather than a clean, dedicated review space.

v2 reorganizes the lifecycle around **who needs to act**, makes re-review **automatic on new commits**, makes **click always open** a PR into a **dedicated review tab**, and **deletes merged sessions**.

---

## Goals

1. Three picker sections by who-acts: **Waiting for review**, **Waiting for re-review**, **Waiting for response**.
2. **Auto-re-review on new commits**: when the author pushes after you posted, re-review runs automatically (incremental, updates REVIEW.md in place) so findings are current before you look.
3. **Click always opens** a PR — into a **dedicated Zellij "PR Reviews" tab** as a `[glow REVIEW.md | agent]` row; Mission Control (orchestrator + status) is never disturbed; the placeholder pane is gone.
4. **Focus a row**: you can select/expand one PR's row so it's easy to interact with.
5. **Merged/closed → delete the whole session** (clone + REVIEW.md + metadata) — gone from disk and panel.
6. GitHub-touching checks run on a **slow (~60s) background cadence**, decoupled from the 2s UI refresh, to avoid hammering `gh`.

## Non-Goals (deferred)

- Discovering NEW team PRs (the scanner) — separate sub-project.
- Inline per-line GitHub comments (still a single PR review with a composed body).

---

## State Model

Fields on `session.json` (additions in **bold**):

| Field | Values | Meaning | Set by |
|---|---|---|---|
| `review_state` | `queued`/`reviewing`/`ready`/`failed`/`interrupted` | (re-)review worker progress | worker |
| `lifecycle` | `none`/`commented`/`changes-requested`/`approved` | your posted decision | posting helpers |
| **`reviewed_sha`** | git SHA (string) | PR head when you last posted a review | posting helpers |
| **`rereview_pending`** | `true`/absent | author pushed new commits since `reviewed_sha` | watch daemon |
| `triage_state` | `open`/`done` | visible vs hidden | (rarely used now — merged deletes outright) |

### Section assignment (derived; what `--review-list-grouped` emits)

For each session whose repo still exists (skip `triage_state = done`, i.e. manually dismissed):
- **Waiting for review** — `lifecycle = none` (queued/reviewing/ready/failed/interrupted all live here; the row's icon shows the `review_state`).
- **Waiting for re-review** — `lifecycle ∈ {commented, changes-requested}` **and** `rereview_pending = true`. (While the auto-re-review runs, the icon shows `reviewing`; when done, `ready`.)
- **Waiting for response** — `lifecycle ∈ {commented, changes-requested}` **and** `rereview_pending` not set.

`approved` sessions are deleted at approve time, so they never appear.

### Transitions

```
ask review → review_state queued→reviewing→ready   (lifecycle=none)          [Waiting for review]
  approve  → gh --approve  → DELETE whole session (gone)
  comment / request-changes → gh review → lifecycle set, reviewed_sha = current PR head → [Waiting for response]

watch daemon (~60s), for each posted (commented/changes-requested) session:
  • live head != reviewed_sha → set rereview_pending=true + auto-launch --rereview-pr  → [Waiting for re-review]
  • PR merged or closed → rm -rf the session dir (gone)

re-review worker → review_state reviewing→ready (REVIEW.md updated in place; stays in re-review section, ready to act)
  you act again (comment/approve) → reviewed_sha updated + rereview_pending cleared → back to Waiting for response, or deleted on approve
```

---

## Components (all extend `bin/cgremlin`)

### 1. State helpers
Add `update_reviewed_sha`/`read_reviewed_sha`, `set_rereview_pending`/`clear_rereview_pending`/`read_rereview_pending` — thin wrappers over `update_session_field`/`read_session_field`, beside the existing `lifecycle` helpers.

### 2. `--review-list-grouped` — three sections
Rewrite to emit three labeled groups (review / re-review / response) using the assignment rules above. Same tab-delimited `<display>\t<session>\t<group>` contract; `group ∈ {review, rereview, response}`; header rows have empty session. Icons: review_state-based for `review`/`rereview`; a static "💬 awaiting author" for `response`.

### 3. Picker (`--status-pane`) — click always opens
The two-section picker becomes three-section. **Selection routing changes: every data row → `cgremlin --open-pr <session>`** (no more silent re-review on select). The picker keeps the pipe-seed + `reload-sync` live refresh already in place.

### 4. `--open-pr` — dedicated PR Reviews tab, as a focusable row
Rework `open_pr_row` so it:
- Targets a **dedicated tab named `PR Reviews`** (create it if absent; do NOT use the Mission Control layout's panes). Mission Control tab is never touched.
- Removes the old layout "placeholder" pane concept — the PR Reviews tab starts empty and is populated by rows.
- Adds the PR as a **row = `[glow REVIEW.md | agent]`** (two panes side by side). A second PR opens as another row.
- **Focusable rows:** arrange rows as a Zellij **stacked** group so the focused PR's row expands and the others collapse to title bars; selecting a PR in the picker focuses (expands) its row. If stacked panes prove unreliable, fall back to Zellij's native fullscreen-zoom on the focused pane. (Validate the stacking primitive early — it was never confirmed.)
- Dedupe via `.tab2_open` as today (re-selecting an already-open PR just focuses its row).
- Continues to merge the posting-command permissions into the session settings before launching the agent.

### 5. Watch daemon (`--watch-daemon`) — the ~60s background ticker
A long-running loop launched with the cockpit (self-terminates when the `mission-control` Zellij session no longer exists). Every ~60s, for each open session:
- **Merged/closed** (`gh pr view --json state`) → `rm -rf` the session dir (clone + REVIEW.md + metadata). Idempotent.
- **Posted (commented/changes-requested) with new commits** (`gh pr view --json headRefOid` != `reviewed_sha`) → `set_rereview_pending` + launch `cgremlin --rereview-pr <session>` (incremental, updates REVIEW.md, never posts). 
- Runs `gh` calls with a per-call timeout so one hang can't stall the loop; logs to `$SESSIONS_DIR/.watch-daemon.log`. This is the ONLY component that polls GitHub; the picker stays local + 2s.

### 6. Posting helpers — record `reviewed_sha`, delete on approve
- `approve_pr`: post `gh --approve`, then **`rm -rf` the whole session** (supersedes v1's archive-then-keep). Removed from panel + disk.
- `comment_pr` / `request_changes_pr`: post, set `lifecycle`, and **record `reviewed_sha` = current PR head** (`gh pr view --json headRefOid`), and clear `rereview_pending`. → moves to Waiting for response.
- On `gh` failure: leave state unchanged (card stays actionable).

### 7. Re-review worker
Unchanged from v1 (`--rereview-pr`: git-fetch latest, incremental prompt, REVIEW.md in place, never posts), with one addition: on completion it does NOT clear `rereview_pending` (the PR stays in "Waiting for re-review" — needs your action); `rereview_pending` is cleared only when you post again.

---

## Data Flow

1. Ask review → card in **Waiting for review** (`reviewing → ready`, live). Click → opens in PR Reviews tab.
2. You comment/request-changes via the agent → posts to GitHub, records `reviewed_sha` → card moves to **Waiting for response**.
3. Author pushes commits. Within ~60s the watch daemon sees a new head → sets `rereview_pending`, auto-launches incremental re-review → card moves to **Waiting for re-review** (`reviewing → ready`), REVIEW.md updated.
4. You click the re-review card → opens the updated `[review | agent]` row → approve (→ session deleted) or comment again (→ new `reviewed_sha`, back to Waiting for response).
5. PR merges → within ~60s the watch daemon deletes the session entirely.

---

## Error Handling

- `gh` failures in the daemon: skip that session this cycle, log, continue (never block the loop or change state).
- `gh` failure when posting: lifecycle/`reviewed_sha` unchanged; agent surfaces the error.
- Daemon orphan prevention: each cycle checks the `mission-control` session exists (`zellij list-sessions`); if gone, the daemon exits.
- `rm -rf` delete is idempotent and guarded to session dirs under `$SESSIONS_DIR/pr-*` only.
- Re-review with no actual diff: harmless (tracker unchanged), still clears nothing.

---

## Verification

- Picker shows three sections; a PR you commented on sits in **Waiting for response** with no new commits.
- Push a commit to that PR → within ~60s it auto-re-reviews and appears in **Waiting for re-review** with an updated REVIEW.md (prior findings preserved, Review History row appended).
- Clicking any card (any section) opens it in a **separate "PR Reviews" tab** as a `[review | agent]` row; Mission Control is untouched; no placeholder pane; opening a second PR adds a second row; selecting a PR focuses/expands its row.
- Approve via the agent → GitHub shows the approval and the session directory is deleted.
- Merge a PR on GitHub → within ~60s its session directory is deleted and it leaves the panel.
- The picker itself never calls `gh`; only `--watch-daemon` does, on the ~60s cadence.

---

## Files Changed (anticipated)

- `bin/cgremlin` — new state helpers (`reviewed_sha`, `rereview_pending`); rewrite `--review-list-grouped` to 3 sections; picker selection routes all rows to `--open-pr`; rework `open_pr_row` (dedicated `PR Reviews` tab, stacked focusable rows, drop placeholder); add `--watch-daemon` (60s merged-delete + new-commit→auto-rereview) + launch it with the cockpit + self-terminate; posting helpers record `reviewed_sha` and approve deletes the session; remove the layout's placeholder pane.
- No new files.

---

## Build Order

1. State helpers (`reviewed_sha`, `rereview_pending`).
2. `--review-list-grouped` → three sections.
3. Picker routing → all rows open (`--open-pr`).
4. `open_pr_row` → dedicated PR Reviews tab + stacked focusable rows + no placeholder.
5. Posting helpers → record `reviewed_sha`; approve deletes the session.
6. `--watch-daemon` → 60s merged-delete + new-commit auto-re-review; launch with cockpit + self-terminate.
