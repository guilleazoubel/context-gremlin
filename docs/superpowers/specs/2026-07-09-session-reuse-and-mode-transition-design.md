# Session Reuse + Investigate→Develop In One Session Design

**Date:** 2026-07-09
**Status:** Draft
**Builds on:** the Mission-Control session model (`pr-*` / `inv-*` / `dev-*` dirs, `session.json` with `mode`), the review path (`review_pr_noninteractive`, `rereview_pr`, `open_pr_row`), the investigate/develop flow (`investigate_start`, `develop_start`, `write_investigate_brief`, `write_develop_brief`, `create_work_agent_pane`), and the new status-pane "🔨 Your work" section.

---

## Problem

The status panel duplicates work. Two causes:

1. **Multiple review sessions per PR.** `cgremlin --review-pr <url>` (used by the orchestrator and manually) always creates a fresh timestamped session with no dedupe, so triggering a review for a PR that already has a session produces a second (third, fourth…) session. The watch daemon already dedupes; the manual/orchestrator path does not.
2. **Investigate + develop show as two sessions for one piece of work.** Promotion ("build it") spawns a separate `dev-*` session seeded with a copy of `FINDINGS.md` and closes the investigation *pane* — but the investigation *session* lingers on disk, so the new "🔨 Your work" list shows both `🔍 <key>` and `🔨 <key>`.

Underlying model correction from the user: **a session is the persistent unit for one piece of work.** Each mode contributes a document under that one session — `REVIEW.md` (review), `FINDINGS.md` (investigate), `DEVELOPMENT.md` (develop) — and a piece of work should not fragment into multiple sessions. Development in particular must have its investigation and any review right there to work from.

---

## Goals

1. **One session per PR review**, from every entry point. A review triggered for a PR that already has a session re-reviews it in place (if changed) or just opens it — never duplicates.
2. **One session across investigate→develop.** Promotion transitions the *same* session from investigate to develop in place: no second session, no duplication by construction.
3. **Develop works from the investigation and review.** The develop agent reads `FINDINGS.md` (primary seed) and `REVIEW.md` (if present) from its own session dir.
4. **Type detection by `mode`, not dir-name prefix**, so a session that stays `inv-…`-named but becomes `mode=development` is still handled correctly everywhere it matters.
5. **Clean up the current duplicates** (done for the `#1711` smoke sessions; reconcile the existing `HB-1094` inv/dev pair).

---

## Non-goals (deferred to a follow-up spec)

- **Document rename `FINDINGS.md`→`INVESTIGATION.md`.** The user wants standardized names (`REVIEW.md` / `INVESTIGATION.md` / `DEVELOPMENT.md`), but the `FINDINGS.md`→`INVESTIGATION.md` sweep ripples through the Python dashboard server (`has_findings`, findings-file detection, the web "Findings" tab), the symlink logic, the status pane, and many briefs. It carries the most regression risk and the least urgency, so it is its own follow-up spec with backward-compat (read `FINDINGS.md` as a fallback). **This spec keeps the `FINDINGS.md` name** and only introduces the brand-new `DEVELOPMENT.md` (a new file = no rename churn).

---

## Decisions (resolved with the user)

| Decision | Choice |
|---|---|
| Review of a PR that already has a session | **Reuse:** head SHA changed vs `reviewed_sha` → re-review in place; unchanged → just open the existing agent |
| Open discussion agent on re-review | **Close + reopen fresh** on the updated `REVIEW.md` (current `rereview_pr` behavior — keep) |
| Investigate→develop | **One session, mode transition in place** (no second session) |
| Type detection | By the **`mode` field**, not the dir-name prefix |
| Develop's inputs | `FINDINGS.md` (primary) + `REVIEW.md` if present, in the same session dir |
| Doc names | Standardize eventually; **this spec introduces `DEVELOPMENT.md`**, defers the `FINDINGS.md`→`INVESTIGATION.md` rename to a follow-up |

---

## Architecture

### Part A — Review session reuse

`review_pr_noninteractive` (the `--review-pr <url>` handler) gains a dedupe/route step before creating anything:

1. Parse the PR number from the URL (the same regex `create_pr_session_noninteractive` uses).
2. Find an existing session: newest match of `$SESSIONS_DIR/pr-*-<num>-*` with a live `repo/`.
3. If found:
   - `head=$(gh pr view <num> --repo <repo> --json headRefOid -q .headRefOid)`.
   - `head` != `read_reviewed_sha(session)` (new commits) → `rereview_pr <session>` (the existing verified re-review: archive `REVIEW.md`→`REVIEW-v{n}.md`, verify each prior finding, update in place, close the stale agent tab).
   - Equal (nothing new) → `open_pr_row <session>` (focus/open the existing agent; no new analysis).
   - Head fetch fails (network) → fall back to `rereview_pr` (safer than opening a stale view).
4. If not found (or the existing session's `repo/` is missing/archived) → today's behavior: create the session + headless review.

The watch daemon's own dedupe stays; this simply makes the manual/orchestrator path behave the same. `rereview_pr` and `--rereview-pr` are unchanged.

### Part B — Investigate→develop in one session

Today `develop_start` builds a new `dev-*` session and closes the investigation. New behavior — **promote in place**:

1. Operate on the investigation's OWN session dir (`$INV_DIR`).
2. `update_session_field mode development`.
3. Keep `FINDINGS.md` as-is. Create `DEVELOPMENT.md` (a running dev log/plan doc the develop agent maintains).
4. Overwrite `CLAUDE.md` with the develop brief (`write_develop_brief`), which now instructs: "Read `FINDINGS.md` (your investigation — the primary seed) and `REVIEW.md` if present, then plan." The develop brief already lives in this dir; no copy/seed step needed.
5. In the tab: **rename** it `🔍 <key>` → `🔨 <key>` (`zellij … action rename-tab`, after `go-to-tab-name` the old name), then **kill the investigation agent and respawn the develop agent in the same session/tab** (same mechanism `create_work_agent_pane` uses, but into the existing tab rather than a new one). No pane/tab close.
6. No new session dir; no `dev-*` creation. The `create_development_session_noninteractive` copy/seed path is no longer used by promotion (left for any other caller, or removed if unused).

Because promotion never creates a second dir, the `🔨 Your work` list shows exactly one row for the work, and the earlier "hide promoted investigation" hack is unnecessary.

**Type detection by `mode`:** audit the places that branch on the dir-name prefix (`inv-*`/`dev-*`/`pr-*`) for behavior that now depends on a session having *transitioned* (e.g. the `IS_DEV_SESSION` detection ~line 2217, allow-list-for-dev decisions, the status-pane WORK filter which already reads `mode`). Where the distinction matters for a transitioned session, read `read_session_field mode` instead of matching the prefix. The dir name stays whatever it was created as (`inv-…`); `mode` is the source of truth.

### Cleanup (one-time, operational)

- The three smoke `#1711` sessions are already deleted (kept `…115514`, the real one).
- The existing `HB-1094` pair was made by the OLD flow (separate `inv-…152350` + `dev-…HB-1094-173939`). The develop session is the active one and already carries the findings, so remove the orphan `inv-…152350`. (Going forward, Part B prevents such pairs.)

---

## Error handling

- **Review dedupe:** missing/archived `repo/` in the matched session → treat as no session, create fresh. Multiple matches → use the newest. `gh` head fetch failure → re-review (fail safe).
- **Promotion:** if the tab rename or agent respawn fails (Mission Control not running), still perform the on-disk transition (mode flip, `DEVELOPMENT.md`, brief swap) so the state is correct; the agent starts on next open. Never leave the session half-transitioned (write `session.json` mode + `CLAUDE.md` together, before touching Zellij).
- **Develop inputs:** `REVIEW.md` absent is normal (most develop work has no prior review) — read it only if present; `FINDINGS.md` absent means the session wasn't a promoted investigation — the develop brief notes that and proceeds from the ticket.

---

## Components (files changed — `bin/cgremlin` only)

- **`review_pr_noninteractive`:** the dedupe/route block (Part A), reusing `read_reviewed_sha`, `rereview_pr`, `open_pr_row`, `gh pr view … headRefOid`.
- **`develop_start`:** rewrite to promote in place — mode flip, `DEVELOPMENT.md`, `write_develop_brief` over the same `CLAUDE.md`, tab rename, agent kill+respawn in the same tab. Stop creating a `dev-*` session for promotion.
- **`write_develop_brief`:** read `FINDINGS.md` (primary) + `REVIEW.md` (if present); maintain `DEVELOPMENT.md`.
- **Type-detection audit:** switch prefix-based `dev-*`/`inv-*` checks to the `mode` field where a transitioned session must be classified correctly (notably the dev-permissions/`IS_DEV_SESSION` path).
- **Sync:** if the Python `PYSERVER` heredoc is touched (e.g. a mode/prefix detection it does), re-run `bash -n` + `ast.parse`.
- One-time cleanup command for the orphan `inv-…152350` (operational, not committed code).

---

## Verification

`bash -n bin/cgremlin` (+ `ast.parse` if PYSERVER touched). Functional:
1. **Review dedupe:** with an existing `pr-…-1707-…` session, `cgremlin --review-pr <1707-url>` does NOT create a new dir — it re-reviews (if head advanced) or opens; a PR with no session still creates one.
2. **Promote in place:** start an investigation, promote it; confirm NO new `dev-*` dir, the same dir now has `mode=development` + `DEVELOPMENT.md` + the develop `CLAUDE.md`, `FINDINGS.md` still present, and the tab renamed `🔍`→`🔨`; the `🔨 Your work` list shows ONE row for it.
3. **Develop inputs:** the emitted develop brief references `FINDINGS.md` and `REVIEW.md`.
4. **Type detection:** a promoted (mode=development, `inv-`-named) session is treated as a dev session by the audited checks (e.g. gets dev write permissions).
5. Live: promote a real investigation and confirm the single-row, renamed-tab, develop-agent-in-place result.
