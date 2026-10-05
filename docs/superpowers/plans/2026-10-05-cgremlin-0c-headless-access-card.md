# Step 0c — Headless runs must have Jira + PR access, and say so when they don't (PROPOSED CARD)

Status: **accepted into the program tracker as step 0c (2026-10-05), with amendments A–D below.** Written 2026-10-05 after step 0b (`cgremlin-0b`). To be verified against
`docs/superpowers/plans/2026-10-05-cgremlin-program.md` (Global Constraints, Review Focus #3 and #5, steps 1, 1b, P4, 6, 10)
and the spec `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md`.

## Why
The user's requirement: *"if there is a Jira linked, we NEED the Jira; headless runs must have access to the Jira and the PR
so they can do a good job."* Today that is not guaranteed, and a failure is silent.

## Evidence (read-only investigation, cgremlin/core, branch mission-control-pr-orchestrator @ 5ada853)
1. **Headless spawn:** `claude -p … --permission-mode bypassPermissions --add-dir <sessionDir>` (`src/agent/claude-code-runner.ts:66-83`),
   cwd = session worktree (`stage-runner.ts:276`), env inherited. **No `--mcp-config` is passed**; the Atlassian MCP is available only
   if the user-level Claude Code settings provide it. The deny-list guard covers `Bash(...)` only, not MCP tools (`permission-guard.ts:314-317`).
2. **Engine Jira fetch:** `PipelineService.ticketContext(key)` (`pipeline-service.ts:191-194`) → `tickets.forBrief` (`build-engine.ts:315-327`) →
   `JiraRestSource.issue`. Token = `config.jira.apiToken`, read by the engine only (`jira-rest-source.ts:101`).
   **On any failure: `.catch(() => null)` (`pipeline-service.ts:193`) → empty `## Ticket` section (`prompts.ts:142`); the agent is not told.**
3. **Linking:** ticket key from branch name (`review-session-factory.ts:107`), PR title/body (`inventory.ts:206`), `session.lineage.ticket`;
   pattern `/\b([A-Z][A-Z0-9]+-\d+)\b/`, filtered by `jira.projectKeys` (empty list disables linking with a warning, `ticket-keys.ts:27-32`).
4. **gh:** `gh pr view` / `gh pr diff` are not denied (works on merged PRs, `prompts.ts:~1145`); writes are denied (`permission-guard.ts:52-77`).
   Nothing verifies `gh` is authenticated before a run.
5. **Prompts tell the agent to proceed without Jira** when the MCP is unavailable (`prompts.ts:196, 225, 698`).
6. **No preflight** runs before a headless stage. The only check is the manual `cgremlin-core config check-jira` (`check-jira.ts:34-59`).
   Scanner failures are stored in `jira.json` (`kind: notConfigured|auth|unavailable|ok`, `jira-store.ts:6`) but never shown to the agent.
7. **Not verified:** whether the Atlassian MCP is actually installed in the settings a headless run uses on this machine.

## Spec / program references
- Program Review Focus **#5** (claims of verification need an engine-checked artifact; otherwise ❓) and **#3** (interrupted/unavailable → `stopped`/`needs_input`, nothing half-done reported done).
- Program Global Constraints: scope = cgremlin only; protected actions need approval; TDD; `pnpm test/typecheck/lint` in `cgremlin/core` and `cgremlin/vscode`; release per `RELEASES.md`; **never read `~/.cgremlin/config` or `core.json`**.
- Related steps: **P4** (rotate Jira token, secrets to Keychain — do 0c before or independently of it), **1b** (cgremlin plugin carrying agents/skills), **6** (`cgremlin:ui-check`), **10** (`cgremlin:review`).
- Out of scope for 0c: `renderQaBrief`'s blind 40k truncation (same bug class fixed for respond in 0b) — fold into step 6 (instructions first, ticket capped ≈5k, "how to verify" moved into the skill).

## Done when (proposed)
- [ ] **Visible Jira state in every brief that has a ticket slot** (review, rereview, respond, qa, plan, development):
  - ticket linked and loaded → the existing `## Ticket` block (unchanged, byte-for-byte);
  - ticket linked but **not loaded** → an explicit line, e.g. `## Ticket — HB-123: NOT LOADED (auth error | unavailable | not configured)`, never an empty/missing section;
  - no ticket linked → `## Ticket — none linked`.
  The *reason* comes from the engine's own result, not from the agent. Tests for all three states in each affected renderer.
- [ ] **Preflight before launching a headless stage** (qa, review, rereview, respond; see D2), built as **one shared function** (e.g. `preflightAccess(session)`) so R94's Jira re-check before each workplan phase reuses it (amendment C): checks (a) Jira loadable *if a ticket is linked*, (b) `gh` authenticated and the PR readable. Failure → the session goes to `needs_input` with a clear one-line reason; the agent is **not** launched blind. (Decision D1 below.)
- [ ] **The engine is the only Jira source (amendment A).** No agent-side Atlassian MCP fallback: MCP-fetched text would bypass the 0b untrusted-data treatment, its availability in headless runs is unverified (no `--mcp-config`), and the token must stay in the engine. The prompt lines at `prompts.ts:196, 225, 698` change from "skip Jira and proceed" to "the ticket is in `## Ticket`; do not fetch Jira yourself". If the engine could not load a *linked* ticket, the run stops (D1). The "none linked" wording may stay.
- [ ] **Ticket text gets the 0b treatment (amendment B):** the `## Ticket` content (summary, description/ACs, comments) is capped on its own budget and fenced as untrusted data (the same delimiter + neutralization as respond's `<untrusted-pr-data>`), with the instructions before it and never truncated. Tests include an oversized ticket and a ticket containing a fake closing delimiter.
- [ ] **Surface the state to the user** (Work list / tab): linked-but-unavailable shows ❓ / needs-input with the reason, never ✅ (Review Focus #5).
- [ ] Tests fail first and pass after; `pnpm test`, `pnpm typecheck`, `pnpm lint` pass in `cgremlin/core` and `cgremlin/vscode`.
- [ ] Released as `cgremlin-0c` per `RELEASES.md` (tags `cgremlin-pre-0c` + `cgremlin-0c`, `.vsix` saved, table row, push) — release/merge/install/push only with the user's go-ahead.

## Decisions (resolved 2026-10-05)
- **D1 — linked Jira unreachable → STOP.** The session goes to `needs_input` with the engine's reason. A one-click **"run anyway"** override records `jira: skipped by user` in the brief. **The automatic re-review** (no human present) goes to `needs_input` **without launching a run**, so nothing burns on a blind review.
- **D2 — gated stages:** qa, review, rereview, respond. The **interactive planning chat warns, it doesn't block** (I'm present). Lead/plain chat: not gated. Workplan phases get the same preflight later via R94 (same shared function).

## Amendments (2026-10-05, accepted by the user)
- **A** — engine is the only Jira source; no agent-side MCP fallback.
- **B** — ticket text capped + fenced as untrusted data (0b treatment), as a Done-when item.
- **C** — D1/D2 refined (auto re-review → `needs_input` without a run; planning chat warns); preflight is one shared function reused by R94.
- **D** — branch `step/0c`; runs in parallel with step 1; whichever releases second rebases first.

## Review Focus for this step (most likely first)
1. Linked ticket + Jira down → the agent must never silently proceed as if there were no ticket.
2. Jira returns a ticket with hostile text (prompt injection) → still capped and delimited (carry the 0b `<untrusted-pr-data>` treatment; instructions never cut).
3. No `projectKeys` configured → linking disabled: say "none linked (Jira linking not configured)", don't claim "no ticket".
4. `gh` unauthenticated or rate-limited mid-run → `needs_input`/`stopped`, no half-done phase reported done.
5. Preflight must not leak the token (engine-only, never in brief, logs, or errors) and must not read `core.json` in a transcript.

## Start prompt
`Run step 0c of the cgremlin program. Read docs/superpowers/plans/2026-10-05-cgremlin-0c-headless-access-card.md (this card), docs/superpowers/plans/2026-10-05-cgremlin-program.md (Global Constraints, Review Focus) and the spec sections it cites. Decisions D1/D2 are resolved in the card; confirm them with me in one line. Write the detailed plan with superpowers:writing-plans, show it to me, then execute with superpowers:subagent-driven-development in .claude/worktrees/0c on branch step/0c (branch from the current mission-control-pr-orchestrator; if step 1 releases first, rebase onto it and re-run the suites before releasing — amendment D), get a fresh-context review, release per RELEASES.md, and update the tracker.`

## Instruction for the verifying agent
Check this card against the program plan and spec: (1) every cited file:line still exists on `mission-control-pr-orchestrator`; (2) the card contradicts no Global Constraint; (3) the Done-when items cover Review Focus #3 and #5; (4) the sequencing against P4/1b/6/10 is sound and nothing here duplicates a later step; (5) list anything in the card the program already schedules elsewhere. Report discrepancies; do not edit files or read `~/.cgremlin/config` / `core.json`.
