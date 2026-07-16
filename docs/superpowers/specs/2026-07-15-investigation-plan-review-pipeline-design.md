# Investigation → Plan Review → Development Pipeline Design

**Date:** 2026-07-15
**Status:** Draft
**Builds on:** the autonomous investigate/develop sessions design (2026-07-06), the PM/Designer headless UI review design (2026-07-09, dedicated Task-tool subagent pattern), the session lineage/pipeline design (`docs/session-lineage.md`), and today's `REVIEW_MODEL` config precedent.

---

## Problem

Investigation sessions today produce `FINDINGS.md` on whatever the default model is (`MODEL`, typically sonnet), with no independent check on the resulting plan before it's handed to a development agent. For work that's actually going to be implemented, a weak or incomplete plan is expensive to discover late — the cost of catching a bad plan is much lower before code gets written than after.

We want the investigation stage to run at the highest quality bar available (Opus, xhigh effort), and — specifically for investigations headed toward development — produce a distinct, reviewed **plan** document that two independent lenses sign off on before a development agent ever starts writing code:

- **PM lens:** does this plan solve exactly the stated problem, and nothing more?
- **Principal Engineer lens:** is the plan internally consistent and complete — what's being modified, how it will work, how it will be tested?

---

## Goals

1. **Investigation and plan-drafting run at the top quality tier.** New `INVESTIGATION_MODEL`/`INVESTIGATION_EFFORT` config (default `opus`/`xhigh`), mirroring today's `REVIEW_MODEL` pattern.
2. **Three-document lifecycle, not two.** `FINDINGS.md` (investigation output — always produced) → `PLAN.md` (the bulletproof implementation plan, only for development-bound work) → development (implements `PLAN.md`).
3. **Two independent review lenses via the existing subagent pattern.** PM and Principal Engineer reviewers are dispatched via the Task tool from within the investigation session, exactly like today's PM/Designer UI-check subagents (2026-07-09 design) — no new orchestration mechanism.
4. **Iterate to convergence, with a cap.** On rejection, the investigator revises `PLAN.md` and re-dispatches both reviewers. Capped at 3 rounds; if still unresolved, stop and explain the disagreement to the user rather than loop or guess.
5. **Trigger depends on how the session started, not a separate command to remember:**
   - Session created as **Investigate**: stops at `FINDINGS.md`. Planning only begins if the user later explicitly asks for it.
   - Session created as **Develop** (clear development intent, e.g. "work on JIRA-123"): still starts with investigation and `FINDINGS.md` (this is new — today's fresh "develop" entry likely skips straight to code), then **auto-continues into planning** once findings are done — a notification, not a question.
6. **Semi-hard promotion gate, with an opt-in bypass.** By default, once both reviewers approve `PLAN.md`, the agent explains the plan to the user in plain language and waits for explicit approval before any code is written — regardless of how the session started. If the user gave an upfront "drive to completion" instruction, this final pause is skipped too (development proceeds automatically once both reviewers approve), notifying rather than asking at each stage.
7. **Dashboard visibility.** A new `PLAN` tab renders `PLAN.md` (same markdown rendering as today's `FINDINGS` tab) plus the PM/Principal Engineer verdicts and reasoning, with an **"Approve for Development"** button that triggers the same promotion `develop_start()` already performs today.

---

## Non-goals

- Changing how promotion itself works mechanically (still the existing single-session mode-flip from the session-lineage design — no fresh/separate develop session, no new session directory on promotion).
- A new CLI command or bash-level orchestration loop for the review cycle (rejected — see Approach C below). The iterate-until-approved loop is the investigator's own conversational judgment, same as the PM/Designer UI-check loop.
- Changing the PM/Designer **UI-check** subagents (2026-07-09 design) — those are a separate, already-shipped feature (live-browser verification during review/develop), unrelated to this planning-quality gate.
- Making `PLAN.md` review mandatory for pure investigations that never intend to reach development. If an investigation never gets promoted, no plan is ever drafted or reviewed.

---

## Architecture

### Document lifecycle

```
inv-* session
  1. FINDINGS.md  — investigation output (root cause, what's going on). Always produced,
                     on INVESTIGATION_MODEL/INVESTIGATION_EFFORT.
       │
       │  Only when this investigation is development-bound (see Trigger logic below)
       ▼
  2. PLAN.md      — the implementation plan, derived from FINDINGS.md: what will be
                     modified, how it will work, how it will be tested.
                     Drafted by the investigator, then reviewed:
                       - PM subagent (Task-tool dispatch): scope discipline —
                         solves exactly the stated problem, nothing more.
                       - Principal Engineer subagent (Task-tool dispatch): internal
                         consistency — pieces align, behavior is understood, test
                         plan is concrete.
                     Revise + re-dispatch on rejection, capped at 3 rounds.
                     Unresolved after cap → stop, explain disagreement to user.
       │
       │  User's explicit approval (dashboard button or chat) — unless the user
       │  gave an upfront "drive to completion" instruction, in which case this
       │  step is skipped once both reviewers approve.
       ▼
  3. develop_start() promotes the session (in place — mode flip, per the existing
     session-lineage design). The now-development session's CLAUDE.md reads
     PLAN.md (not FINDINGS.md) as its implementation brief.
```

### Trigger logic (which sessions get the plan stage)

Session creation already distinguishes Investigate vs. Develop as a mode choice (interactive picker / CLI entry points). New behavior:

| Started as | Findings | Planning |
|---|---|---|
| **Investigate** | Produced, session stops here | Only if the user later explicitly asks to turn it into development |
| **Develop** (e.g. "work on JIRA-123") | Produced first (new — today likely skips straight to code) | Starts automatically once findings are done; investigator notifies the user rather than asking permission to begin |

The "drive to completion" override (an upfront instruction/flag) suppresses every pause after this point: planning starts automatically (already true above), and the final approval-before-coding gate (below) is also skipped once both reviewers approve — the agent notifies at each transition instead of asking.

### Review mechanism

Once a `PLAN.md` draft exists, the investigator dispatches PM and Principal Engineer subagents in parallel via the Task tool — the same mechanism `ui_check_protocol()` already uses for PM/Designer UI checks (2026-07-09 design). Subagents inherit the parent session's model/effort (`INVESTIGATION_MODEL`/`INVESTIGATION_EFFORT`), so no separate per-role model config is needed.

Each reviewer returns a structured verdict: `approved` or `changes_requested` + reasoning.
- Any rejection → investigator revises `PLAN.md`, re-dispatches both reviewers. Capped at 3 rounds total.
- Cap reached without both approving → stop; present the plan and both reviewers' unresolved objections to the user, who iterates the plan directly and approves manually. Never silently proceeds past an unresolved disagreement.

### Promotion gate (`develop_start()`)

Becomes a semi-hard gate, following the same convention as `--approve-pr`'s existing safety-gate pattern (refuse + explain, `--force` to override):

- Default: refuses to promote unless `plan_review.phase == "approved"` (i.e., the user has explicitly approved after seeing both reviewer verdicts).
- If `plan_review.drive_to_completion == true` and both verdicts are `approved`: promotes automatically, no user action required.

### Config

New keys in `~/.cgremlin/config`, alongside today's `REVIEW_MODEL`:

```
INVESTIGATION_MODEL="opus"
INVESTIGATION_EFFORT="xhigh"
```

`load_config()` gains matching case-statement arms and `DEFAULT_INVESTIGATION_MODEL`/`DEFAULT_INVESTIGATION_EFFORT` initializers, mirroring the existing `MODEL`/`REVIEW_MODEL` pattern exactly. Investigation-mode `claude` invocations pass `--model "$INVESTIGATION_MODEL" --effort "$INVESTIGATION_EFFORT"`; development-mode invocations are untouched (`MODEL`, no effort override).

### `session.json` schema addition

```json
"plan_review": {
  "phase": "findings | planning | plan_ready | approved",
  "drive_to_completion": false,
  "rounds": 0,
  "pm_verdict": { "status": "approved | changes_requested | pending", "notes": "" },
  "principal_verdict": { "status": "approved | changes_requested | pending", "notes": "" }
}
```

Absent on any session created before this feature ships — `develop_start()`'s gate check must treat a missing `plan_review` block as "not gated" (today's existing promotion behavior), not as an implicit failure, so old investigation sessions aren't newly blocked.

### Dashboard UI

- New `PLAN` badge/tab per session (alongside today's `FINDINGS`/`DEVELOPMENT`/`REVIEW`), rendering `PLAN.md` via the same markdown pipeline `FINDINGS.md` uses today.
- The tab also surfaces the PM/Principal Engineer verdicts and their reasoning — not just the bare plan text.
- An **"Approve for Development"** button on the PLAN tab, wired to the same promotion action `develop_start()` performs conversationally today.
- Session cards/pipeline badges show a `plan_review.phase` indicator so a plan awaiting the user's review is visible from the sidebar without opening the session.

---

## Approaches considered

| Approach | Description | Verdict |
|---|---|---|
| **A — Prompt-driven, single session (chosen)** | Reviewers are Task-tool subagents dispatched from within the investigation session's own conversation, exactly like the existing PM/Designer UI-check pattern. | Reuses a proven mechanism, no new subprocess orchestration, iteration loop stays where it belongs (agent judgment). |
| B — Separate reviewer subprocesses | PM/Principal Engineer run as fully independent `claude` processes, each writing its own verdict file, aggregated by a bash step. | More arms-length/auditable, but adds real new orchestration (spawn/wait/aggregate) for a benefit that's mostly about inspectability, not correctness. Rejected for now. |
| C — Dedicated `cgremlin --review-plan` CLI command | Bash-level orchestration of the whole review loop, deterministic round-counting. | Round-tripping "revise based on feedback" through bash orchestration is awkward for something an agent already does naturally in conversation. Rejected. |

---

## Error handling

- **Reviewer cap reached without agreement:** stop; explain both unresolved positions to the user; user iterates the plan and approves manually. Never loop indefinitely or promote past an unresolved disagreement.
- **Old sessions without a `plan_review` block:** `develop_start()` treats this as "not gated" — today's existing promotion behavior is preserved for anything created before this feature ships.
- **`drive_to_completion` set but reviewers never converge:** the cap still applies; automatic promotion only happens on an actual `approved`/`approved` verdict pair, never as a fallback when the cap is hit.

---

## Open questions for the implementation plan (not blocking this spec)

- Exact wording/format the dashboard uses to render reviewer "notes" (plain paragraph vs. structured findings-style list) — a display-polish detail, not an architectural one.
- Whether the `plan_review.phase` badge needs its own color/icon distinct from existing `stage_status` badges, or reuses the existing badge styling conventions from the session-lineage work.

---

## Resolved decisions

1. **Three documents, not two.** `FINDINGS.md` always produced by investigation; `PLAN.md` only for development-bound work, reviewed before promotion.
2. **Trigger is the session's original mode**, not a separate opt-in step: Develop-mode sessions auto-continue from findings into planning; Investigate-mode sessions wait for an explicit later request.
3. **Reviewers run at the same tier as the investigator** (Opus + xhigh) — no cheaper reviewer tier, since catching a bad plan is exactly where quality matters most.
4. **Semi-hard gate by default**, with an explicit upfront "drive to completion" override for users who want the whole pipeline to run unattended through to development.
5. **Task-tool subagent dispatch (Approach A)**, not separate subprocesses or new bash orchestration — consistent with the already-shipped PM/Designer UI-check mechanism.
6. **Dashboard gets a reviewable PLAN tab with an approve button** — not just a bare markdown dump, and not conversational-only approval.
