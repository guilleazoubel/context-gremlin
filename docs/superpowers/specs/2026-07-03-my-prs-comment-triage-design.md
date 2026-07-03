# My-PRs Flow + Reviewer-Comment Triage Design

**Date:** 2026-07-03
**Status:** Draft
**Builds on:** `2026-07-03-high-signal-review-triage-design.md` (review/triage flow, status groups, watch daemon, GITHUB_ME)

---

## Problem

Today every watched PR — including the reviewer's own — goes through the same code-review flow and lands in "Needs your attention," competing for the reviewer's time. But the reviewer's own PRs need the opposite treatment:

- They should NOT be auto-code-reviewed (the author wrote them) and must NOT take a slot in the "review others" queue.
- The reviewer wants to see their own open PRs at a glance, and be nudged when action is needed:
  - **Approved** → a clear place to scan and go merge.
  - **Reviewer left comments** → an automatic first-pass that classifies each comment as *makes-sense* or *false-positive*, then a guided list the reviewer works through: reply-with-explanation for false positives, fix-and-commit for valid ones.

This design separates "my PRs" from "PRs I review," and adds an automatic reviewer-comment triage workflow.

---

## Identifying "mine"

A PR is **mine** when `pr.author` equals `GITHUB_ME` (existing config, case-insensitive). Mine PRs never enter the code-review flow; they use the lifecycle below. Non-mine PRs are unchanged.

Drafts are skipped (consistent with the existing review pickup) — a draft isn't ready for review or merge.

---

## Lifecycle of a mine PR

```
Watch daemon finds my open non-draft PR, no session
  → track_my_pr: create session, shallow-clone repo, mine_stage=tracking
  → status pane: "📋 My pull requests" (bottom, idle)

reviewDecision == APPROVED
  → lifecycle=approved
  → status pane: "🚀 Approved — MERGE YOURS" (top)

New reviewer comments from others (unresolved threads not yet triaged)
  → mine_stage=triaging, launch --triage-comments (headless)
  → status pane: "👀 Agent reviewing (triaging comments)"
  → worker writes COMMENTS.md, records triaged thread ids, mine_stage=ready
  → status pane: "💬 My PRs — comments to address" (top)

Reviewer opens the triage pane, works the list
  → per item: reply to thread (false positive) OR fix+commit (valid), push on request
  → when all handled: mine_stage=tracking (back to idle / awaiting next round)

Author (me) merges → watch daemon: PR MERGED → delete session
```

Second round of comments after the reviewer addresses the first: because we record which thread ids were triaged, newly-arrived threads re-trigger `--triage-comments`.

---

## Components (all in `bin/cgremlin`)

### 1. `track_my_pr(pr_url)` / `--track-my-pr`
Like `create_pr_session_noninteractive` but:
- Builds `session.json` with pr metadata (via `jq`, escaped) and `mine_stage=tracking`.
- Shallow-clones the repo (needed later to fix + commit + push).
- Does NOT run any code review, does NOT write REVIEW.md.

### 2. Watch daemon — pickup branch
In the auto-pickup loop, after matching a watched author and confirming no existing session:
- `author == GITHUB_ME` → `--track-my-pr "$url"`.
- else → `--review-pr "$url"` (unchanged).

### 3. Watch daemon — monitoring branch (per existing session)
For a mine session (author == me):
- MERGED/CLOSED → delete (unchanged path).
- `reviewDecision == APPROVED` and `lifecycle != approved` → set `lifecycle=approved` (kill any triage pane).
- Else fetch unresolved review threads authored by someone other than me. If any thread id is not in the session's `triaged_threads` list → set `mine_stage=triaging`, launch `--triage-comments`.

Non-mine sessions keep today's behavior (rereview on new commits, etc.).

### 4. `--triage-comments <session>` (headless worker)
- Fetches unresolved review threads/comments from others via `gh api graphql` (path, line, author, body, thread id).
- For EACH comment, judges **valid** (makes sense, should fix) vs **false-positive** (doesn't apply / already handled / wrong), with a one-line reason. Uses the repo (checked out on the PR branch) to verify.
- Writes `COMMENTS.md` in the session root, one entry per comment:
  - thread id, author, `path:line`, the comment text (quoted)
  - **Verdict:** ✅ valid / 🟡 false-positive
  - **Reasoning:** one or two plain sentences
  - **Proposed reply** (for false-positive) or **Proposed fix** (for valid)
  - **Status:** `open` (updated by the interactive pane to `replied` / `fixed` / `skipped`)
- Records the triaged thread ids into `session.json` (`triaged_threads`).
- Sets `mine_stage=ready`. Posts NOTHING (guarded like the review worker: bypassPermissions + deny gh review/comment/merge/push during this headless pass).

### 5. Interactive comment-triage pane (`AGENT_CONTEXT.md` variant for mine)
When the reviewer opens a mine PR that is `mine_stage=ready`, the floating pane runs an agent whose context is COMMENTS.md, with a protocol:
- Opens with a roll-up: `N comments — X valid, Y false-positive. Go through them?`
- Per item, shows: the comment, `path:line`, the agent's verdict + reasoning, and the proposed reply/fix.
- On the reviewer's decision, the agent acts through **cgremlin helpers** (never raw `gh`/`git`), so the same deny-guard used by the headless worker stays in place:
  - **false positive → "reply"**: write the explanation to `.reply_body.md`, run `cgremlin --reply-comment <session> <thread_id>`, set item Status `replied`.
  - **valid → "fix"**: apply the code edit (allowed), then `cgremlin --commit-fix <session> "<msg>"`. **Push only when the reviewer explicitly says so** via `cgremlin --push-fix <session>`. Set item Status `fixed`.
  - **"skip"** → Status `skipped`.
- The agent acts ONLY on explicit per-item confirmation — never autonomously.
- When the list is exhausted, set `mine_stage=tracking`.

`open_pr_row` already closes other panes and opens one; it works for mine sessions unchanged (the pane's AGENT_CONTEXT just differs by mine_stage).

### Permissions model (important)
Both the headless worker and the interactive pane run under the review guard (`write_review_guard` denies raw `gh pr review/comment/merge`, `gh api --method`, `git push`, `git commit`). All mutations go through allowlisted `cgremlin` helpers instead — mirroring how the review flow posts via `--comment-pr`:
- `--reply-comment <session> <thread_id>` — posts `.reply_body.md` to the given review thread via `gh api`.
- `--commit-fix <session> "<msg>"` — `git add -A && git commit` in the session repo.
- `--push-fix <session>` — `git push` the PR branch.
The pane's `settings.local.json` allows `Bash(cgremlin --reply-comment *)`, `Bash(cgremlin --commit-fix *)`, `Bash(cgremlin --push-fix *)`. This keeps raw destructive commands blocked while enabling the guided actions.

### 6. Status pane (`review_list_grouped`) — new grouping
Classify each session as mine (author == GITHUB_ME) or not, then:

| Group (top → bottom) | Contents |
|---|---|
| 🚀 Approved — MERGE YOURS | mine, lifecycle=approved |
| 💬 My PRs — comments to address | mine, mine_stage=ready |
| 🔔 Needs your attention | NOT mine, review ready/failed + finished re-reviews (unchanged) |
| 👀 Agent reviewing | any in-flight: review, re-review, or comment-triage |
| 💬 Waiting for response | NOT mine, lifecycle=commented/changes-requested |
| ✅ Approved (author will merge) | NOT mine, lifecycle=approved |
| 📋 My pull requests | mine, mine_stage=tracking (idle, awaiting others' review) |

A mine PR appears in exactly one group by state. Mine PRs are excluded from "Needs your attention."

---

## Data / session fields (mine sessions)

| Field | Meaning |
|---|---|
| `mine_stage` | `tracking` (idle) / `triaging` (worker running) / `ready` (COMMENTS.md waiting for me) |
| `lifecycle` | reused: `approved` when the PR is approved |
| `triaged_threads` | JSON array of review-thread ids already triaged (detect NEW comments) |

`COMMENTS.md` (session root) is the data contract between the headless worker and the interactive pane, mirroring how REVIEW.md works for the review flow.

---

## Error handling

- **No Atlassian/gh access for a thread fetch** → worker logs and leaves `mine_stage` unchanged; retried next tick.
- **Triage worker fails** → `mine_stage=tracking` (not stuck in triaging); daemon retries when it still sees untriaged threads.
- **Push rejected** (branch protection / non-fast-forward) → agent reports it; the fix commit stays local; item Status stays `fixed` (committed) so the reviewer can resolve manually.
- **Comment already resolved on GitHub** between fetch and action → reply/fix is a no-op; skip.
- **A mine PR that was force-classified before GITHUB_ME was set** → once GITHUB_ME is set it reclassifies at render time (author compare), no migration needed.

---

## What is NOT changing

- The review/triage/re-review flow for other people's PRs.
- Floating pane mechanism, single-pane open, larger modal, titles.
- Merged/closed cleanup, approved-detection for others' PRs.
- The high-signal review prompts and REVIEW.md template.

---

## Files changed

`bin/cgremlin` only:
- New: `track_my_pr()` + `--track-my-pr` handler.
- New: `--triage-comments` worker + its headless prompt.
- New: helpers `--reply-comment`, `--commit-fix`, `--push-fix` (allowlisted mutations).
- New: mine variant of `AGENT_CONTEXT.md` (comment-triage protocol) in `create_review_agent_pane` (branch on `mine_stage`).
- Modified: watch daemon pickup branch (mine → track, not review).
- Modified: watch daemon monitoring branch (mine → approved / comment detection).
- Modified: `review_list_grouped` (mine classification + two new groups, exclude mine from "Needs your attention").

Sync note: no Python-server changes required (this is Zellij/CLI + watch-daemon behavior); the dashboard already renders sessions generically. Verify with `bash -n` after edits.
