export interface BriefCommon { sessionDir: string; ticket: string | null }
export interface FindingsBriefParams extends BriefCommon { intent: 'investigate_only' | 'development' }
export interface PlanBriefParams extends BriefCommon { driveToCompletion: boolean }
export interface DevelopBriefParams extends BriefCommon { hasPlan: boolean }
export interface ReviewPromptParams { sessionDir: string; reviewSkillCommand?: string; includeLiveUiCheck?: boolean }
export interface RereviewPromptParams { sessionDir: string; commitCount: number; reviewSkillCommand?: string }

const DEFAULT_REVIEW_SKILL = '/APFM:apfm-review';

export const STAGE_ENTRY_PROMPT = (sessionDir: string): string =>
  `Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`;

function notes(sessionDir: string): string {
  return `## Status files (the engine reads these; you never call any CLI)
- Progress note: overwrite \`${sessionDir}/AGENT_NOTE\` with ONE line at each milestone (e.g. "tracing checkout path", "root cause found").
- State: overwrite \`${sessionDir}/AGENT_STATE\` with exactly one of \`working\`, \`ready\`, \`needs-input\`, \`blocked\` whenever it changes.`;
}

export function renderFindingsBrief(p: FindingsBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const ticketLine = p.ticket
    ? `The ticket is ${p.ticket}. Fetch it now via the Atlassian MCP (getJiraIssue) to read the summary, description, and acceptance criteria.`
    : '';
  const after =
    p.intent === 'development'
      ? `This investigation is development-bound. When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_NOTE\` = "findings complete — ready for planning" and \`${p.sessionDir}/AGENT_STATE\` = \`ready\`, then STOP. The engine will start the planning turn.`
      : `When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "FINDINGS.md ready — review it", present a short summary, and STOP. This investigation was NOT started as development-bound — do not draft a plan.`;
  return `# INVESTIGATION — ${key}

You are running in an isolated git worktree of the repository (the current working directory). Work autonomously. Your first deliverable is a complete, self-contained \`${p.sessionDir}/FINDINGS.md\` — no code changes.

## Source of truth: the Jira ticket
${ticketLine} If the ticket is unavailable or absent, use whatever task description you were given. The ticket defines scope — investigate ONLY what it asks about.

${notes(p.sessionDir)}

## What to do (autonomously — do not ask for routine steps)
1. Understand the request from the ticket. As your first action write \`${p.sessionDir}/AGENT_NOTE\` = "${key}: <one-line goal>".
2. Explore the repository: trace the relevant code paths, reproduce/understand the issue, find the ROOT CAUSE.
3. Write \`${p.sessionDir}/FINDINGS.md\` as a COMPLETE HANDOFF a fresh developer could execute from alone:
   - **What's happening** (the observed problem/behavior)
   - **Root cause** (the specific code and why)
   - **Affected files/paths**
   - **Risks / splash zone** (what a fix could plausibly affect)
   - **Direction / plan** to fix the ticket (concrete steps, scoped to the ticket)
4. Do NOT change code in this step. Investigation produces understanding only.

## Scope discipline
Cover ONLY what the ticket asks. If you find necessary out-of-scope work, note it under a "Tech debt (proposed)" section in FINDINGS.md — do not act on it.

## After FINDINGS.md is complete
${after}
`;
}

export function renderPlanBrief(p: PlanBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const tail = p.driveToCompletion
    ? `## Proceeding automatically (drive-to-completion was requested)
Once both reviewers approve and the "## Review Status" block is written, STOP. The engine promotes this plan into development without waiting for a human.`
    : `## Waiting for human approval
Once both reviewers approve and the "## Review Status" block is written, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and STOP. A human approves the plan through the engine; do not proceed to implementation.`;
  return `# PLAN — ${key}

You are continuing the investigation of ${key} in the same worktree. \`${p.sessionDir}/FINDINGS.md\` is complete. Your deliverable is \`${p.sessionDir}/PLAN.md\`, reviewed by two subagents.

${notes(p.sessionDir)}

## Drafting the plan (PLAN.md)
Write \`${p.sessionDir}/PLAN.md\`, derived from FINDINGS.md's root cause and direction. It must be bulletproof enough that a fresh developer could implement it without asking you anything. Include:
- **What will be modified** — exact files/functions, not vague areas.
- **How it will work** — the actual mechanism/approach, not just the goal.
- **How it will be tested** — concrete test cases, not "add tests."
- **Scope boundary** — what this plan explicitly does NOT do, to prevent scope creep later.

## Reviewing the plan (PM + Principal Engineer)
Once a PLAN.md draft exists, write \`${p.sessionDir}/AGENT_NOTE\` = "plan drafted — under review", then dispatch TWO subagents in PARALLEL (Task tool) — do NOT do their work inline:

**PM subagent:** reads PLAN.md and FINDINGS.md, checks ONLY: does this plan solve exactly the ticket's stated problem, and nothing more? Flag any scope creep beyond the ticket. Return a verdict: APPROVED, or CHANGES_REQUESTED with specific, actionable reasons.

**Principal Engineer subagent:** reads PLAN.md, FINDINGS.md, and the actual code in the repository, checks: are all the pieces internally consistent — is every modified file/function named correctly, does the described mechanism actually work given the real code, is the test plan concrete and sufficient? Return a verdict: APPROVED, or CHANGES_REQUESTED with specific, actionable reasons.

If either returns CHANGES_REQUESTED: revise PLAN.md based on their reasoning, then re-dispatch BOTH subagents again (a partial re-review is not enough — a revision can affect either lens). Repeat up to 3 total rounds. If both have not approved after 3 rounds, STOP: write a "## Unresolved Review Disagreement" section at the top of PLAN.md quoting each unresolved objection verbatim, write \`${p.sessionDir}/AGENT_STATE\` = \`needs-input\` and \`${p.sessionDir}/AGENT_NOTE\` = "plan review stuck — needs your input", and stop — do not keep iterating past the cap.

Once both approve, write a "## Review Status" section at the TOP of PLAN.md, exactly in this shape (the engine parses it):
\`\`\`
## Review Status
- PM: ✅ Approved — <one-line reasoning>
- Principal Engineer: ✅ Approved — <one-line reasoning>
\`\`\`

${tail}
`;
}

export function renderDevelopBrief(p: DevelopBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const planStep = p.hasPlan
    ? `1. **Read \`${p.sessionDir}/PLAN.md\` (your approved plan), then \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** PLAN.md was already reviewed and approved (PM + Principal Engineer) — implement from it. Copy/adapt PLAN.md into \`${p.sessionDir}/DEVELOPMENT.md\` as your starting point; adapt only if something in PLAN.md is factually wrong against the real code — in that case note the discrepancy in DEVELOPMENT.md, do NOT silently deviate.
2. **No plan re-gate — proceed to implementation.** Promotion into development was explicitly authorized. Do NOT pause for plan approval.`
    : `1. **Read \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** Refine into a concrete implementation plan; capture it in \`${p.sessionDir}/DEVELOPMENT.md\`.
2. **PLAN GATE — pause.** Write \`${p.sessionDir}/AGENT_STATE\` = \`needs-input\` and STOP so a human can read DEVELOPMENT.md. Do NOT implement until a new turn tells you to proceed.`;
  return `# DEVELOP — ${key}

You are running in an isolated git worktree on the session branch. Keep a running plan/progress log in \`${p.sessionDir}/DEVELOPMENT.md\`.

${notes(p.sessionDir)}

## What to do
${planStep}
3. **Implement with TDD.** For each unit: write the failing test, run it (confirm it fails), write minimal code, run to green, commit. Stay strictly in ticket scope.
4. **Open a draft PR** on the pushed branch: \`git push -u origin HEAD\` then \`gh pr create --draft\`, body summarizing the change and linking ${key}. Record the PR URL as the first line of \`${p.sessionDir}/PR_URL\`.
5. **Verify.** Run the project's focused tests for the change (prove the ticket's issue is fixed plus a smoke pass of the feature's likely splash zone — NOT the full suite unless it is fast).
6. **Finish.** When tested, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "tested — draft PR open", and STOP. Marking the PR ready for review is a human decision.

## Rules
- Never post reviews/comments or merge/close PRs from this session (the guard denies them). \`git push\`, \`gh pr create --draft\`, \`gh pr view\` are fine.
- If you hit something you cannot pass (environment broken), write \`${p.sessionDir}/AGENT_STATE\` = \`blocked\` and explain in AGENT_NOTE.
`;
}

export function renderReviewPrompt(p: ReviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  const ui =
    (p.includeLiveUiCheck ?? true)
      ? ` Then ALWAYS run the '## LIVE UI CHECK' section in CLAUDE.md (PM + Designer subagents) and merge its 📋/🎨 findings into REVIEW.md — this is required even when ${skill} handled the code review.`
      : '';
  return `Run ${skill} and write the findings to REVIEW.md following CLAUDE.md.${ui} Proceed autonomously; do NOT ask for confirmation or a verdict. Read the PR with git (the branch is checked out) or gh pr view/diff as needed. If Jira/Atlassian MCP is unavailable, skip Jira context and proceed with the diff alone. Do NOT post to GitHub. Write the output to ${p.sessionDir}/REVIEW.md.`;
}

export function renderRereviewPrompt(p: RereviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  return `STEP 1: Check if ${skill} skill is available. If yes, run it for re-review and follow its output — skip everything else. STEP 2 (only if skill unavailable): RE-REVIEW MODE — PR updated with ${p.commitCount} new commit(s). Read ${p.sessionDir}/RE-REVIEW.md and follow it. Update ${p.sessionDir}/REVIEW.md in-place. FIRST verify each prior finding was properly addressed: re-check whether the problem it describes still happens in the new code and classify ✅ resolved / ⚠️ partial (keep open) / ❌ still open / 🔁 regressed, with evidence — 🔇 dismissed stay untouched. THEN add NEW findings only if they pass the evidence bar in CLAUDE.md, written in the file's plain format (What's wrong / Why it matters / Suggested fix), and re-check the PR still satisfies its Jira ticket. Severity is 🔴 Critical / 🟠 High / 🟡 Perf / 🔧 Maintainability. Scope: ONLY files in the PR diff. Add a new row to Review History. Self-check: verify every finding references a changed file. As the very last action, write a single line to the file ${p.sessionDir}/rereview_summary. Format: '✅ N/N resolved' if all prior findings are resolved, or '⚠️ K/N resolved, M new' otherwise. Write only that line — no other content.`;
}
