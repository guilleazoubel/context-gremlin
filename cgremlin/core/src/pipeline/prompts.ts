export interface EnvironmentBriefContext {
  localUrl: string | null;
  localLogPath: string | null;
  localUnavailableReason: string | null;
  previewUrl: string | null;
  previewUnavailableReason: string | null;
  /** The preview deployment's status (e.g. 'DEPLOYED', 'PENDING') when a preview URL is known — null otherwise. */
  previewStatus: string | null;
  bypassSecretPath: string | null;
  clerk: { emailTemplate: string; verificationCode: string } | null;
}

export const EMPTY_ENVIRONMENT: EnvironmentBriefContext = {
  localUrl: null,
  localLogPath: null,
  localUnavailableReason: null,
  previewUrl: null,
  previewUnavailableReason: null,
  previewStatus: null,
  bypassSecretPath: null,
  clerk: null,
};

/**
 * R18 — the ticket content that reaches an agent, as TEXT. There is no HTML
 * here and none anywhere below it: the adapter flattened `renderedFields` at
 * the port (R33), so by the time a brief is composed there is nothing left
 * to render. `null` means nothing was fetched, and the section renders ''.
 */
export interface TicketBriefContext {
  key: string;
  summary: string;
  status: string;
  url: string;
  descriptionText: string | null;
  comments: Array<{ author: string; at: string; bodyText: string | null }>;
}

export interface BriefCommon { sessionDir: string; ticket: string | null; ticketContext?: TicketBriefContext | null }
export interface FindingsBriefParams extends BriefCommon { intent: 'investigate_only' | 'development'; env?: EnvironmentBriefContext }
export interface PlanBriefParams extends BriefCommon { driveToCompletion: boolean }
export interface DevelopBriefParams extends BriefCommon { hasPlan: boolean; env?: EnvironmentBriefContext }
export interface ReviewBriefParams {
  sessionDir: string;
  prNumber: number;
  env?: EnvironmentBriefContext;
  /** Phase 10: this review session was deliberately created on the author's own PR (selfReview:true bypassed OwnPrError). */
  selfReview?: boolean;
}
export interface RereviewBriefParams { sessionDir: string; prNumber: number; commitCount: number; env?: EnvironmentBriefContext }
export interface ReviewPromptParams { sessionDir: string; reviewSkillCommand?: string; includeLiveUiCheck?: boolean; uiCheckRendered?: boolean }
export interface RereviewPromptParams { sessionDir: string; commitCount: number; reviewSkillCommand?: string }

const DEFAULT_REVIEW_SKILL = '/APFM:apfm-review';

export function bareSkillName(command: string): string {
  const trimmed = command.trim();
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export const STAGE_ENTRY_PROMPT = (sessionDir: string): string =>
  `Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`;

function notes(sessionDir: string): string {
  return `## Status files (the engine reads these; you never call any CLI)
- Progress note: overwrite \`${sessionDir}/AGENT_NOTE\` with ONE line at each milestone (e.g. "tracing checkout path", "root cause found").
- State: overwrite \`${sessionDir}/AGENT_STATE\` with exactly one of \`working\`, \`ready\`, \`needs-input\`, \`blocked\` whenever it changes.`;
}

/**
 * The ONE sentence that describes how to sign in as a Clerk test user. Both
 * the live UI check's `## Environment` block and the QA brief's
 * `## QA environment` block emit exactly this, so there is never a second
 * phrasing to keep in sync. A `+clerk_test` address is Clerk's own test-mode
 * identity: ephemeral, non-privileged, and it emails nobody — which is why
 * signing up as one is the CONFIGURED account, not "creating a user".
 */
export function renderClerkTestUserLine(clerk: { emailTemplate: string; verificationCode: string }): string {
  return `- Clerk test user: sign in with \`${clerk.emailTemplate}\` and the email verification code \`${clerk.verificationCode}\`.`;
}

// Renders the '## Environment' block for a brief. Every line is conditional on the
// corresponding EnvironmentBriefContext field; '' when nothing is set (R14).
export function renderEnvironmentSection(ctx: EnvironmentBriefContext): string {
  const lines: string[] = [];
  if (ctx.localUrl) {
    const log = ctx.localLogPath
      ? `  (dev-server log: ${ctx.localLogPath} — read it when something fails)`
      : '';
    lines.push(`- Local app: ${ctx.localUrl}${log}`);
  } else if (ctx.localUnavailableReason) {
    lines.push(`- Local app: UNAVAILABLE — ${ctx.localUnavailableReason}. Do not attempt to start it yourself; verify what you can statically and say so in your output.`);
  }
  if (ctx.previewUrl) {
    const note =
      ctx.previewStatus !== null && ctx.previewStatus !== 'DEPLOYED'
        ? ` (deployment status ${ctx.previewStatus} — may still be building; retry the page if it does not load)`
        : '';
    lines.push(`- Vercel preview: ${ctx.previewUrl}${note}`);
  } else if (ctx.previewUnavailableReason) {
    lines.push(`- Vercel preview: UNAVAILABLE — ${ctx.previewUnavailableReason}. Fall back to a Storybook preview link in the PR checks/comments if one exists; otherwise note it and continue.`);
  }
  if (ctx.bypassSecretPath) {
    lines.push(`- Deployment-protection bypass secret: read the single line in \`${ctx.bypassSecretPath}\`.`);
  }
  if (ctx.clerk) {
    lines.push(renderClerkTestUserLine(ctx.clerk));
  }
  if (lines.length === 0) return '';
  return `## Environment (started for you by the engine — do NOT start or stop anything yourself)\n${lines.join('\n')}`;
}

/** R18's caps. A brief is a prompt, and an unbounded comment thread is a prompt-injection and cost surface. */
export const TICKET_MAX_COMMENTS = 5;
export const TICKET_MAX_COMMENT_CHARS = 2000;
export const TICKET_MAX_SECTION_CHARS = 12_000;

const TRUNCATION_NOTE = '_(truncated by the engine)_';

/**
 * R18 — the gated `## Ticket` block, in the exact shape of
 * `renderEnvironmentSection`: '' when nothing was fetched, and every caller
 * writes `const block = section ? '\n\n' + section : ''`.
 */
export function renderTicketSection(ctx: TicketBriefContext | null | undefined): string {
  if (ctx === null || ctx === undefined) return '';
  let truncated = false;
  const lines: string[] = [
    `## Ticket ${ctx.key} — ${ctx.summary}`,
    `Status: ${ctx.status}${ctx.url === '' ? '' : ` · ${ctx.url}`}`,
  ];
  if (ctx.descriptionText !== null && ctx.descriptionText.trim() !== '') {
    lines.push('', ctx.descriptionText.trim());
  }
  const comments = ctx.comments.slice(0, TICKET_MAX_COMMENTS);
  if (comments.length < ctx.comments.length) truncated = true;
  if (comments.length > 0) {
    lines.push('', '### Recent comments (newest first)');
    for (const comment of comments) {
      const body = comment.bodyText ?? '';
      const capped = body.length > TICKET_MAX_COMMENT_CHARS ? body.slice(0, TICKET_MAX_COMMENT_CHARS) : body;
      if (capped.length < body.length) truncated = true;
      lines.push('', `**${comment.author}** (${comment.at}):`, capped);
    }
  }
  let text = lines.join('\n');
  // The whole-section cap has to leave room for the note it adds, or saying
  // "truncated" would be what pushed it over the cap.
  const budget = TICKET_MAX_SECTION_CHARS - TRUNCATION_NOTE.length - 2;
  if (text.length > budget) {
    text = text.slice(0, budget);
    truncated = true;
  }
  return truncated ? `${text}\n\n${TRUNCATION_NOTE}` : text;
}

// Reproduces bin/cgremlin:1436-1483 verbatim except the "Reaching the target" bullets,
// which point at the engine-provided URL/.bypass-secret instead of ~/.cgremlin/config (R10).
// Returns '' when neither a local nor a preview URL is available (R14).
export function renderUiCheckProtocol(mode: 'observe' | 'fix', target: string, ctx: EnvironmentBriefContext): string {
  if (!ctx.localUrl && !ctx.previewUrl) return '';
  const code = ctx.clerk?.verificationCode ?? '424242';
  const bypassPath = ctx.bypassSecretPath ?? '<sessionDir>/.bypass-secret';
  const modeBlock = mode === 'fix'
    ? `**Mode — FIX:** feed every confirmed PM/Designer finding into your fix loop — fix the root cause (correct patterns, no hacks, no over-engineering), then re-run this check until both lenses pass.`
    : `**Mode — OBSERVE:** make NO code changes. Merge PM findings as 📋 PM/AC and Designer findings as 🎨 Design into REVIEW.md (same table + detail shape, adding Expected/Actual lines and an Evidence link for design findings). These are additive — they inform the reviewer and do NOT block approval.`;
  return `## LIVE UI CHECK — PM + Designer lenses (dedicated subagents)

After the code tiers, dispatch TWO focused subagents IN PARALLEL (Task tool). They inherit your MCP servers (atlassian, figma, chrome-devtools). Do NOT do their work inline.

**Target:** ${target}

**Reaching the target (both subagents):**
- **Vercel preview behind a login wall:** do NOT attempt an interactive Vercel login. The preview URL is in the \`## Environment\` section above. Bypass deployment protection with the automation secret — read the single line from \`${bypassPath}\` and append \`?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true\` to the preview URL on first navigation (or send it as the \`x-vercel-protection-bypass\` request header).
- **Page behind Clerk auth (dev):** sign in with a Clerk test user — use an email of the form \`<test-specific-name>+clerk_test@example.com\` (the \`+clerk_test\` suffix is what makes it a test account; pick a name specific to this check, e.g. \`uicheck-<ticket>\`) and the email verification code \`${code}\`.
- chrome-devtools runs with an isolated (fresh) profile, so there is no saved session — do the bypass/login on every run.

**PM subagent (product manager verifying the ticket):**
1. Read the Jira ticket (getJiraIssue; fall back to the PR description if Atlassian MCP is unavailable) and extract the acceptance criteria / intended behavior.
2. Open the target in chrome-devtools and navigate to the changed feature.
3. For each acceptance criterion, exercise it and record holds / broken / missing, with a one-line observation and a screenshot for anything not holding.
4. Return findings only (schema below); make NO code changes.

**Designer subagent (designer checking pixel fidelity):**
1. Find a Figma link in the Jira ticket (scan the getJiraIssue description + remote links for a figma.com URL; capture any node-id).
2. IF a link exists: read the design via Figma MCP — get_variable_defs (color/spacing/typography tokens), get_design_context, and get_screenshot of the relevant node. In chrome-devtools, read the rendered values with evaluate_script (getComputedStyle: font-family, font-size, font-weight, color, background-color, padding, margin, width, height, border-radius). Compare against the design and flag each mismatch as design-value vs rendered-value.
3. IF no link exists: do a general visual sanity pass — alignment, spacing consistency, responsive breakpoints (resize via chrome-devtools), obvious visual bugs — and note "no Figma link found in Jira."
4. Produce SIDE-BY-SIDE evidence for each visual discrepancy (below).
5. Return findings only; make NO code changes.

**Side-by-side evidence (per visual discrepancy)** — create a ui-findings/ directory alongside REVIEW.md and write:
- finding-N-figma.png — Figma reference crop (figma get_screenshot); omit on the no-link sanity path.
- finding-N-rendered.png — the screenshot of the same component from the target (chrome-devtools take_screenshot).
- finding-N.html — a self-contained page showing the two images side by side, captioned with the exact mismatch (example: "Figma #1A73E8 / rendered #1B74E9; font-size Figma 16px / rendered 14px").
- finding-N.png — load finding-N.html in chrome-devtools and screenshot it to get one composed image to paste into the PR.
(No image compositor is installed; the HTML page + chrome-devtools screenshot IS the composition mechanism.)

**Findings each subagent returns (merge these into REVIEW.md):** lens (pm | designer), title, severity (Critical / High / Minor), criterion (the AC or design property checked), expected (design/AC value), actual (rendered value), location (URL/route + component/selector), evidence (relative path to ui-findings/finding-N.html plus .png — designer only).

**Degradation:** if a needed MCP tool is unavailable, or no target/preview is ready, NOTE it plainly in REVIEW.md and continue — never fail over unavailable tooling.

${modeBlock}`;
}

const TIER0_INTENT_GATE = `## TIER 0 — Intent gate (Jira is the source of truth) — ALWAYS, FIRST
The ticket defines what this PR is supposed to do. Solving the wrong thing correctly is still a failure.
1. Find the Jira ticket key from the branch name / PR title / context above (e.g. \`HB-627\`, \`GRAC-123\`).
2. Fetch it: if an Atlassian MCP tool is available (e.g. getJiraIssue), use it to read the ticket's summary, description, and acceptance criteria. If not available, fall back to the PR description as the intent.
3. Judge: **does this PR actually satisfy that intent / those acceptance criteria?**
4. Write an \`Intent alignment:\` line at the top of REVIEW.md — ✅ satisfies / ⚠️ partial / ❌ diverges (+ one sentence).
5. If ⚠️ or ❌, create a 🔴 finding: Expected = the ticket criterion, Actual = what the PR does. If no ticket is found, write "No ticket found — reviewed against PR description" and continue.`;

const EVIDENCE_BAR = `When escalating, dispatch parallel sub-agents (Task tool) for the deeper lenses you need (e.g. performance, cross-file data-flow, extra tracing). On a normal PR, SKIP Tier 2. Record in REVIEW.md whether Tier 2 ran.

## THE EVIDENCE BAR — your internal test before writing a finding (do NOT print these labels)
This is how you decide whether something is real enough to write down. Think it through privately; the finding you actually write uses the plain format further below.

**For a bug or performance issue, you must be able to answer:**
- When does it happen? (the exact input, state, or sequence)
- What does the code do in that case?
- What should it do instead?
(Performance: point to the exact repeated work / N+1 / unbounded growth — no hunches.)

**For a maintainability issue, you must be able to answer:**
- What two things are mixed together that shouldn't be? (e.g. business logic sitting inside a UI component, or data-fetching baked into display code)
- What does that concretely cost — what can't be tested on its own, changed without touching unrelated code, or reused?
- How would you separate them?`;

const SEVERITY_LIST = `## Severity (exactly four)
- 🔴 **Critical** — correctness/security bug with concrete impact, OR the PR does not satisfy the ticket. Blocks merge.
- 🟠 **High** — real bug, narrower impact. Should fix; reviewer decides.
- 🟡 **Perf** — provable performance issue. Does not block.
- 🔧 **Maintainability** — concrete separation-of-concerns / coupling violation. Does not block.`;

const LINK_RULE = `- Every finding includes a **Link:** — a clickable GitHub permalink to the exact line, so the reviewer can open it and post a comment there manually. Build it ONCE up front: run \`git config --get remote.origin.url\` to get owner/repo (strip \`https://github.com/\`, \`git@github.com:\`, and \`.git\`) and \`git rev-parse HEAD\` for the full commit SHA (the PR branch is checked out here). The link is: \`https://github.com/<owner>/<repo>/blob/<full-sha>/<path>#L<startLine>\` (or \`#L<start>-L<end>\` for a range). Use the FULL 40-char SHA (a permalink), not \`HEAD\`.`;

// The verbatim legacy REVIEW.md output contract, bin/cgremlin:1596-1660 (R9). This is the
// contract the review agent used to get from CLAUDE.md; evaluateReview and every downstream
// consumer depend on this exact shape.
export function renderReviewContract(): string {
  return `## Output — write \`REVIEW.md\` in this directory, EXACTLY this structure

\`\`\`
# PR Review: #<number> — <title>

**Does it do what the ticket asked?** ✅ Yes / ⚠️ Mostly / ❌ No — <one plain sentence, name the ticket>
**How deep did I look?** Quick pass / Deep pass (<one-line why>)

## Summary
<2-3 plain sentences: what this PR changes, and your overall take. A teammate should understand the gist from this alone.>

## What I found
| # | Severity | Where | Issue | Status |
|---|----------|-------|-------|--------|
| [1](#f1) | 🔴 Critical | \`file.ts:88\` | one plain-English line | open |
| [2](#f2) | 🔧 Maintainability | \`ui/list.tsx:40\` | one plain-English line | open |
| [3](#f3) | 📋 PM/AC | \`/search\` behavior | acceptance criterion not met — <one line> | open |
| [4](#f4) | 🎨 Design | \`PrimaryButton\` on \`/search\` | colour/size differ from Figma — <one line> | open |

📋 PM/AC findings come from the acceptance-criteria check; 🎨 Design findings come from the Figma-fidelity check. Design findings additionally carry Expected vs Actual and an Evidence link (see the detail shape below).

The \`#\` links jump to the full detail below. Keep the \`Status\` column current — it's how the reviewer sees at a glance what's still open.

(If nothing: write "Nothing worth flagging — looks good to me." and set the verdict to Approve.)

## Details

<a id="f1"></a>
### 1. <plain-English title of the problem>
**Severity:** 🔴 Critical   **Where:** \`path/to/file.ext:LN-LN\`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/path/to/file.ext#L<start>-L<end>

**What's wrong:** <2-4 plain sentences. Describe when it happens, what the code does, and what it should do instead — in normal language, no jargon.>

**Why it matters:** <1-2 sentences on the real-world impact: who is affected and how.>

**Suggested fix:** <plain description; add a short code snippet only if it makes it clearer.>

<a id="f2"></a>
### 2. <plain-English title>
**Severity:** 🔧 Maintainability   **Where:** \`path/to/file.ext:LN-LN\`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/ui/list.tsx#L40

**What's wrong:** <same shape — for a maintainability issue, explain in plain words what's mixed together that shouldn't be.>

**Why it matters:** <the concrete cost: what becomes hard to test, change, or reuse.>

**Suggested fix:** <how to separate the concerns.>

<a id="f4"></a>
### 4. Button colour and size don't match the Figma design
**Severity:** 🎨 Design   **Where:** \`/search\` — \`PrimaryButton\`   **Status:** open
**Expected (design):** background \`#1A73E8\`, font-size \`16px\`
**Actual (rendered):** background \`#1B74E9\`, font-size \`14px\`
**Evidence:** ui-findings/finding-4.html (composed image: ui-findings/finding-4.png)

**What's wrong:** <plain sentence: which property differs, on which element/route.>

**Why it matters:** <impact on brand consistency / usability.>

**Suggested fix:** <the design token or style to apply.>

## Verdict
✅ Approve / 🔄 Request Changes / 💬 Comment — <one plain sentence explaining the call>

## Review History
| Version | Date | Commit | Action |
|---------|------|--------|--------|
| v1 | <date> | <sha> | Initial review |
\`\`\`

Rules for the file:
- Follow this structure EXACTLY, every time. Same headings, same order, same finding shape.
- Every finding has a stable anchor \`<a id="fN"></a>\` right before its heading, and the table's \`#\` cell links to it as \`[N](#fN)\`. Anchor ids never change across re-reviews (finding 1 is always \`f1\`).
- \`Status\` appears in TWO places per finding — the table row and the detail heading — and they must always match. Values: \`open\` (new), \`held\` (queued to post), \`posted\` (sent), \`resolved\` (fixed, confirmed on re-review), \`🔇 dismissed\` (skip in re-reviews). Set everything to \`open\`; the triage and re-review agents change it later.
- Keep it tight. The reviewer reads this to get the picture in under a minute, then talks through anything unclear with the agent.`;
}

export function renderFindingsBrief(p: FindingsBriefParams): string {
  const env = p.env ?? EMPTY_ENVIRONMENT;
  const key = p.ticket ?? '(no ticket)';
  const ticketSection = renderTicketSection(p.ticketContext);
  const ticketBlock = ticketSection ? `\n\n${ticketSection}` : '';
  const ticketLine = p.ticket
    ? ticketSection
      // R18: reworded, not deleted — the engine already fetched the ticket,
      // so the MCP call is the fallback for detail the brief does not carry.
      ? `The ticket is ${p.ticket}. Its text is below; fetch it via the Atlassian MCP (getJiraIssue) only if you need more.`
      : `The ticket is ${p.ticket}. Fetch it now via the Atlassian MCP (getJiraIssue) to read the summary, description, and acceptance criteria.`
    : '';
  const after =
    p.intent === 'development'
      ? `This investigation is development-bound. When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_NOTE\` = "findings complete — ready for planning" and \`${p.sessionDir}/AGENT_STATE\` = \`ready\`, then STOP. The engine will start the planning turn.`
      : `When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "FINDINGS.md ready — review it", present a short summary, and STOP. This investigation was NOT started as development-bound — do not draft a plan.`;
  const uiCheck = renderUiCheckProtocol('fix', `the LOCAL url ${env.localUrl}`, env);
  const uiCheckBlock = uiCheck ? `\n${uiCheck}\n` : '';
  const envSection = renderEnvironmentSection(env);
  const envBlock = envSection ? `\n\n${envSection}` : '';
  return `# INVESTIGATION — ${key}

You are running in an isolated git worktree of the repository (the current working directory). Work autonomously. Your first deliverable is a complete, self-contained \`${p.sessionDir}/FINDINGS.md\` — no code changes.

## Source of truth: the Jira ticket
${ticketLine} If the ticket is unavailable or absent, use whatever task description you were given. The ticket defines scope — investigate ONLY what it asks about.

${notes(p.sessionDir)}${envBlock}${ticketBlock}

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
${uiCheckBlock}
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
  const env = p.env ?? EMPTY_ENVIRONMENT;
  const key = p.ticket ?? '(no ticket)';
  const planStep = p.hasPlan
    ? `1. **Read \`${p.sessionDir}/PLAN.md\` (your approved plan), then \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** PLAN.md was already reviewed and approved (PM + Principal Engineer) — implement from it. Copy/adapt PLAN.md into \`${p.sessionDir}/DEVELOPMENT.md\` as your starting point; adapt only if something in PLAN.md is factually wrong against the real code — in that case note the discrepancy in DEVELOPMENT.md, do NOT silently deviate.
2. **No plan re-gate — proceed to implementation.** Promotion into development was explicitly authorized. Do NOT pause for plan approval.`
    : `1. **Read \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** Refine into a concrete implementation plan; capture it in \`${p.sessionDir}/DEVELOPMENT.md\`.
2. **PLAN GATE — pause.** Write \`${p.sessionDir}/AGENT_STATE\` = \`needs-input\` and STOP so a human can read DEVELOPMENT.md. Do NOT implement until a new turn tells you to proceed.`;
  const step5 = env.localUrl
    ? `5. **Verify (local during dev; preview after the PR).** The local app is already running at ${env.localUrl} — drive chrome-devtools against it. Once the draft PR (step 4) is open, ALSO verify against its Vercel preview URL. Run a FOCUSED functional smoke (prove the ticket's issue is fixed, plus a smoke pass of the feature and its likely splash-zone regressions — NOT the full e2e suite) AND the PM + Designer UI check below. Watch ${env.localLogPath ?? 'the dev-server log'}; iterate to green.`
    : `5. **Verify.** Run the project's focused tests for the change (prove the ticket's issue is fixed plus a smoke pass of the feature's likely splash zone — NOT the full suite unless it is fast).`;
  const uiCheckTarget = env.localUrl
    ? `the LOCAL url ${env.localUrl} during development, and the draft PR's Vercel preview URL once the PR is open`
    : `the draft PR's Vercel preview URL once the PR is open`;
  const uiCheck = renderUiCheckProtocol('fix', uiCheckTarget, env);
  const uiCheckBlock = uiCheck ? `\n\n${uiCheck}` : '';
  const envSection = renderEnvironmentSection(env);
  const envBlock = envSection ? `\n\n${envSection}` : '';
  const ticketSection = renderTicketSection(p.ticketContext);
  const ticketBlock = ticketSection ? `\n\n${ticketSection}` : '';
  return `# DEVELOP — ${key}

You are running in an isolated git worktree on the session branch. Keep a running plan/progress log in \`${p.sessionDir}/DEVELOPMENT.md\`.

${notes(p.sessionDir)}${envBlock}${ticketBlock}

## What to do
${planStep}
3. **Implement with TDD.** For each unit: write the failing test, run it (confirm it fails), write minimal code, run to green, commit. Stay strictly in ticket scope.
4. **Open a draft PR** on the pushed branch: \`git push -u origin HEAD\` then \`gh pr create --draft\`, body summarizing the change and linking ${key}. Record the PR URL as the first line of \`${p.sessionDir}/PR_URL\`.
${step5}${uiCheckBlock}
6. **Finish.** When tested, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "tested — draft PR open", and STOP. Marking the PR ready for review is a human decision.

## Rules
- Never post reviews/comments or merge/close PRs from this session (the guard denies them). \`git push\`, \`gh pr create --draft\`, \`gh pr view\` are fine.
- If you hit something you cannot pass (environment broken), write \`${p.sessionDir}/AGENT_STATE\` = \`blocked\` and explain in AGENT_NOTE.
`;
}

export function renderReviewBrief(p: ReviewBriefParams): string {
  const env = p.env ?? EMPTY_ENVIRONMENT;
  const envSection = renderEnvironmentSection(env);
  const uiCheck = renderUiCheckProtocol('observe', "the PR's Vercel preview URL shown in the ## Environment section above", env);
  const selfReviewNote =
    p.selfReview === true ? '**Note:** this is a self-review — the PR under review is your own PR.' : '';
  const parts = [
    `# REVIEW — PR #${p.prNumber}`,
    selfReviewNote,
    TIER0_INTENT_GATE,
    EVIDENCE_BAR,
    SEVERITY_LIST,
    LINK_RULE,
    envSection,
    uiCheck,
    renderReviewContract(),
  ].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n`;
}

export function renderRereviewBrief(p: RereviewBriefParams): string {
  const env = p.env ?? EMPTY_ENVIRONMENT;
  const envSection = renderEnvironmentSection(env);
  const uiCheck = renderUiCheckProtocol('observe', "the PR's Vercel preview URL shown in the ## Environment section above", env);
  const parts = [
    `# RE-REVIEW — PR #${p.prNumber}`,
    `${p.commitCount} new commit(s).`,
    EVIDENCE_BAR,
    LINK_RULE,
    envSection,
    uiCheck,
    renderReviewContract(),
  ].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n`;
}

export function renderReviewPrompt(p: ReviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  const uiCheckRendered = p.uiCheckRendered ?? false;
  const ui =
    (p.includeLiveUiCheck ?? true) && uiCheckRendered
      ? ` Then ALWAYS run the '## LIVE UI CHECK' section in ${p.sessionDir}/BRIEF.md (PM + Designer subagents) and merge its 📋/🎨 findings into REVIEW.md — this is required even when ${bareSkillName(skill)} handled the code review.`
      : '';
  return `Run ${skill} and write the findings to REVIEW.md following ${p.sessionDir}/BRIEF.md.${ui} Proceed autonomously; do NOT ask for confirmation or a verdict. Read the PR with git (the branch is checked out) or gh pr view/diff as needed. If Jira/Atlassian MCP is unavailable, skip Jira context and proceed with the diff alone. Do NOT post to GitHub. Write the output to ${p.sessionDir}/REVIEW.md.`;
}

export function renderRereviewPrompt(p: RereviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  return `STEP 1: Check if ${skill} skill is available. If yes, run it for re-review and follow its output — skip everything else. STEP 2 (only if skill unavailable): RE-REVIEW MODE — PR updated with ${p.commitCount} new commit(s). Read ${p.sessionDir}/RE-REVIEW.md and follow it. Update ${p.sessionDir}/REVIEW.md in-place. FIRST verify each prior finding was properly addressed: re-check whether the problem it describes still happens in the new code and classify ✅ resolved / ⚠️ partial (keep open) / ❌ still open / 🔁 regressed, with evidence — 🔇 dismissed stay untouched. THEN add NEW findings only if they pass the evidence bar in ${p.sessionDir}/BRIEF.md, written in the file's plain format (What's wrong / Why it matters / Suggested fix), and re-check the PR still satisfies its Jira ticket. Severity is 🔴 Critical / 🟠 High / 🟡 Perf / 🔧 Maintainability. Scope: ONLY files in the PR diff. Add a new row to Review History. Self-check: verify every finding references a changed file. As the very last action, write a single line to the file ${p.sessionDir}/rereview_summary. Format: '✅ N/N resolved' if all prior findings are resolved, or '⚠️ K/N resolved, M new' otherwise. Write only that line — no other content.`;
}

// ---------------------------------------------------------------------------
// R50 — the respond brief. Same file, same purity, same gate discipline as
// `renderEnvironmentSection`, and it reuses `renderTicketSection` VERBATIM so
// the ticket text is composed in exactly one place.
// ---------------------------------------------------------------------------

export interface RespondBriefThreadComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface RespondBriefThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  truncated: boolean;
  comments: RespondBriefThreadComment[];
}

export interface RespondBriefContext {
  sessionDir: string;
  prRepo: string;
  prNumber: number;
  threads: RespondBriefThread[];
  reviews: Array<{ author: string; state: string; body: string | null; submittedAt: string }>;
  reviewDecision: string | null;
  /** Failing checks only, by name, with their detailsUrl. */
  failingChecks: Array<{ name: string; detailsUrl: string | null }>;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  ticketContext?: TicketBriefContext | null;
}

/** R50's caps. A brief is a prompt; an unbounded thread is a prompt-injection and cost surface. */
export const RESPOND_MAX_THREADS = 50;
export const RESPOND_MAX_COMMENTS_PER_THREAD = 20;
export const RESPOND_MAX_COMMENT_CHARS = 2000;
export const RESPOND_MAX_BRIEF_CHARS = 40_000;

const COMMENTS_MD_SHAPE = `### <thread id>
- **Thread:** <thread id> (<resolved|open> · <outdated|current>)
- **From:** @<login>
- **Where:** <path>:<line>
- **Comment:** <the reviewer's point, in your words>
- **Verdict:** ✅ valid | 🟡 false-positive
- **Reasoning:** <why>
- **Proposed reply:** <the text a human can paste into GitHub>
- **Proposed fix:** <the change, or "none">
- **Status:** open`;

function respondThreadBlock(thread: RespondBriefThread): { text: string; truncated: boolean } {
  let truncated = thread.truncated;
  const where = thread.path === null ? '(no file)' : `${thread.path}${thread.line === null ? '' : `:${thread.line}`}`;
  const labels = [thread.isResolved ? 'resolved' : 'open', thread.isOutdated ? 'outdated' : 'current'];
  const lines = [`#### ${thread.id} — ${where} (${labels.join(' · ')})`];
  const comments = thread.comments.slice(0, RESPOND_MAX_COMMENTS_PER_THREAD);
  if (comments.length < thread.comments.length) truncated = true;
  for (const comment of comments) {
    const body = comment.body.length > RESPOND_MAX_COMMENT_CHARS
      ? comment.body.slice(0, RESPOND_MAX_COMMENT_CHARS)
      : comment.body;
    if (body.length < comment.body.length) truncated = true;
    lines.push('', `**@${comment.author}** (${comment.createdAt}) ${comment.url}`, body);
  }
  if (thread.truncated) lines.push('', '_(this thread has more comments than the engine fetched)_');
  return { text: lines.join('\n'), truncated };
}

export function renderRespondBrief(ctx: RespondBriefContext): string {
  const hasAnything =
    ctx.threads.length > 0 ||
    ctx.reviews.length > 0 ||
    ctx.failingChecks.length > 0 ||
    ctx.reviewDecision !== null ||
    ctx.changedFiles !== null ||
    (ctx.ticketContext ?? null) !== null;
  // The same gate as `renderEnvironmentSection`: nothing fetched, nothing
  // rendered — the caller decides what to do with ''.
  if (!hasAnything) return '';

  let truncated = false;
  const sections: string[] = [`# RESPOND — ${ctx.prRepo}#${ctx.prNumber}`];

  sections.push(`You are running in an isolated git worktree checked out on this PR's OWN head branch. Your job is to work through every review thread on the pull request and record a verdict for each in \`${ctx.sessionDir}/COMMENTS.md\`.

## Reconcile FIRST, and on every change
Before acting, re-read the live threads the engine caches for you and reconcile them against \`${ctx.sessionDir}/COMMENTS.md\`: a thread that is already recorded keeps its entry, a thread that has a new reply is re-read, and a thread that has disappeared is marked so. Do this again after every change — a reviewer may reply while you work.`);

  sections.push(`${notes(ctx.sessionDir)}`);

  const threads = ctx.threads.slice(0, RESPOND_MAX_THREADS);
  if (threads.length < ctx.threads.length) truncated = true;
  if (threads.length > 0) {
    const blocks = threads.map(respondThreadBlock);
    if (blocks.some((b) => b.truncated)) truncated = true;
    sections.push(`## Review threads (${threads.length})\n\n${blocks.map((b) => b.text).join('\n\n')}`);
  }

  if (ctx.reviews.length > 0 || ctx.reviewDecision !== null) {
    const lines = ctx.reviews.map(
      (r) => `- **@${r.author}** — ${r.state} (${r.submittedAt})${r.body ? `: ${r.body}` : ''}`,
    );
    if (ctx.reviewDecision !== null && ctx.reviewDecision !== '') {
      lines.push(`- **Decision:** ${ctx.reviewDecision}`);
    }
    sections.push(`## Reviews\n${lines.join('\n')}`);
  }

  if (ctx.failingChecks.length > 0) {
    sections.push(
      `## Failing CI checks\n${ctx.failingChecks
        .map((c) => `- ${c.name}${c.detailsUrl === null ? '' : ` — ${c.detailsUrl}`}`)
        .join('\n')}`,
    );
  }

  if (ctx.changedFiles !== null || ctx.additions !== null || ctx.deletions !== null) {
    sections.push(
      `## Diff summary\n- ${ctx.changedFiles ?? '—'} files changed, +${ctx.additions ?? '—'}/−${ctx.deletions ?? '—'}`,
    );
  }

  const ticketSection = renderTicketSection(ctx.ticketContext);
  if (ticketSection !== '') sections.push(ticketSection);

  sections.push(`## What to write
For every thread, append an entry to \`${ctx.sessionDir}/COMMENTS.md\` in exactly this shape:

${COMMENTS_MD_SHAPE}

When every thread has a verdict and the local fixes are committed, write \`${ctx.sessionDir}/AGENT_STATE\` = \`ready\` and \`${ctx.sessionDir}/AGENT_NOTE\` = "COMMENTS.md ready — replies drafted", and STOP.

## Out of scope in v1 — do not do these
Nothing here posts to GitHub. Do NOT reply to a comment, do NOT resolve a thread, do NOT push, and do NOT mark the PR ready. v1 ends at "the fix is committed locally"; the drafted replies live in \`${ctx.sessionDir}/COMMENTS.md\` for a human to paste.`);

  let text = sections.join('\n\n');
  const note = '\n\n_(truncated by the engine)_';
  if (text.length > RESPOND_MAX_BRIEF_CHARS - note.length) {
    text = text.slice(0, RESPOND_MAX_BRIEF_CHARS - note.length);
    truncated = true;
  }
  return truncated ? `${text}${note}` : text;
}

// ---------------------------------------------------------------------------
// Phase 15 — the QA verification brief. Same file, same purity, same gate
// discipline as `renderEnvironmentSection`, and it reuses
// `renderTicketSection` VERBATIM: the ACs ARE the ticket description, so the
// ticket text is still composed in exactly one place.
// ---------------------------------------------------------------------------

export type QaAuthMode = 'clerk-test' | 'vercel-bypass' | 'none';

export interface QaEnvironmentBriefContext {
  url: string | null;
  /** Defaults to `url` when the repo does not configure one. */
  apiBaseUrl: string | null;
  auth: QaAuthMode;
  /** The PATH of the 0600 secret file — never the secret. */
  bypassSecretPath: string | null;
  clerk: { emailTemplate: string; verificationCode: string } | null;
  posthog: { project: string; host: string } | null;
  featureFlags: readonly string[];
  /** Set by `EnvironmentService.qaHealth`; degrades the section, never throws. */
  unreachableReason: string | null;
}

export const EMPTY_QA_ENVIRONMENT: QaEnvironmentBriefContext = {
  url: null,
  apiBaseUrl: null,
  auth: 'none',
  bypassSecretPath: null,
  clerk: null,
  posthog: null,
  featureFlags: [],
  unreachableReason: null,
};

/**
 * The rules of engagement, carried VERBATIM by the brief and by
 * `skills/qa-verify/SKILL.md`. A UI smoke test cannot be read-only against a
 * running app, and this must not pretend otherwise: the agent USES the app.
 * What it must never do is the list below — and only part of it is
 * enforceable by the `qa` permission guard, which covers `Bash(...)` only.
 */
export const QA_CONDUCT_RULE = `You may USE the QA app as a normal user would — navigate, fill forms and submit — signed in with the configured TEST account only. You must never delete records, perform admin operations, trigger anything that emails or texts a real person, capture a payment, touch another user's data, or write to Jira or GitHub. QA is SHARED: other people are using it right now. Some of this is enforced by the permission guard, which covers shell commands only — an MCP tool that can write is NOT blocked, so these rules bind you, not just the sandbox.`;

const QA_NO_SECRETS_RULE =
  'Standing rule: never print a secret, cookie, token or `Authorization` header into `QA.md`, `AGENT_NOTE` or the transcript. Redact them in every response body you quote.';

/**
 * The `## QA environment` block — sibling of `renderEnvironmentSection`, with
 * the same '' gate: nothing configured, nothing rendered, and the caller
 * decides what to do with ''.
 */
export function renderQaEnvironmentSection(ctx: QaEnvironmentBriefContext): string {
  if (ctx.url === null || ctx.url === '') return '';
  const lines: string[] = [];
  if (ctx.unreachableReason !== null) {
    lines.push(
      `- QA: UNREACHABLE — ${ctx.unreachableReason}. Do not attempt to start anything. Write the 🚧 Blocked verdict with this reason and STOP.`,
    );
  }
  lines.push(`- QA app: ${ctx.url}`);
  lines.push(`- API base URL: ${ctx.apiBaseUrl ?? ctx.url}`);
  if (ctx.auth === 'clerk-test' && ctx.clerk !== null) {
    lines.push(renderClerkTestUserLine(ctx.clerk));
    lines.push(
      `  The address above is unique to this verification run and the browser profile is fresh every run, so sign in every run. Use THAT account and no other.`,
    );
  } else if (ctx.auth === 'vercel-bypass' && ctx.bypassSecretPath !== null) {
    lines.push(
      `- Deployment protection: read the single line in \`${ctx.bypassSecretPath}\` at run time and send it as the \`x-vercel-protection-bypass\` request header (or append \`?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true\` on first navigation). Never echo its value anywhere.`,
    );
  } else {
    lines.push(
      `- Test account: no test account is configured for this repo. Verify only what is reachable signed out, and say so plainly in the report rather than guessing at credentials.`,
    );
  }
  if (ctx.posthog !== null) {
    lines.push(`- PostHog: project \`${ctx.posthog.project}\` at ${ctx.posthog.host} — READ-ONLY queries only.`);
  }
  if (ctx.featureFlags.length > 0) {
    lines.push(`- Feature flags this change reads: ${ctx.featureFlags.map((f) => `\`${f}\``).join(', ')}.`);
  }
  lines.push(`- ${QA_NO_SECRETS_RULE}`);
  return `## QA environment (shared — other people are using it right now)\n${lines.join('\n')}`;
}

/** R75 — the protocol lives in the BRIEF, so it works in a target repo where no cgremlin file exists. */
function qaHowToVerify(sessionDir: string): string {
  return `## How to verify
${QA_CONDUCT_RULE}

**1. Read the acceptance criteria.** The \`## Ticket\` section above carries the description (the ACs live there), the status and recent comments. Extract each AC as a numbered, testable statement, verbatim where you can; if there are no explicit ACs, derive them from the summary + PR description and SAY SO. Then read the paths under \`## What we already know\` for known risks and the splash zone. Do not re-review the code — you check the running system.

**2. Know what changed.** From \`## The change\`, map the changed files to (a) routes/screens, (b) API endpoints, (c) analytics calls, (d) feature-flag reads. That map IS your test list; anything outside it is a smoke check, not a verification.

**3. UI.** Drive the QA URL with the chrome-devtools MCP (\`navigate_page\`, \`take_screenshot\`, \`evaluate_script\`, \`list_console_messages\`, \`list_network_requests\`). Authenticate exactly as \`## QA environment\` says; the profile is fresh every run, so do it every run. Per AC: exercise it, record holds / fails / partial with one line of observation and a screenshot into \`${sessionDir}/qa-evidence/\` for anything that is not a clean pass. Check the console for errors and the network log for 4xx/5xx on the routes you touched. Never submit a destructive form.

**4. API / backend.** For each endpoint the diff touched, call it against the API base URL with the same session: the happy path (assert shape and status), authentication (unauthenticated ⇒ 401/403, never 200 with data), and one error path (bad input ⇒ a sane 4xx, not a 500). Reads only, unless an AC cannot be verified without a write — then use the configured test account, stay inside the conduct rule above, and record exactly what you created. Never print an \`Authorization\` header, a cookie or a token.

**5. PostHog events.** If a PostHog MCP is available, use it READ-ONLY: query recent events for the feature's event names in the QA project over the last hour, filtered to the test user you just used. Confirm each fires, ONCE (not twice), with the properties the ticket or the diff implies. If no PostHog MCP is configured, verify the client-side call instead (\`list_network_requests\` for the capture request, or the console) and record that as the weaker evidence it is.

**6. Feature flags.** For each flag named above or read by the diff, record its state in QA and whether you verified the ON path, the OFF path, or only the current one. A feature behind an OFF flag in QA is **not verified** — say so; it is not a pass.

**7. Evidence.** \`${sessionDir}/qa-evidence/\`: \`q<N>.png\` per problem plus any response bodies you assert on (redact tokens). Every problem in the report cites one.

**8. The verdict.** ✅ **Ready to deploy** — every AC holds, no blocker, no major. ❌ **Not ready** — any AC fails, or any blocker/major problem. 🚧 **Blocked** — you could not verify: QA unreachable, auth failed, the flag is off, the build in QA predates the merge commit. Say precisely what you needed; do NOT retry in a loop and do NOT guess.

${notes(sessionDir)}`;
}

function qaOutputContract(sessionDir: string): string {
  return `## Output
Write ONE file, \`${sessionDir}/QA.md\`, in exactly this shape. The engine parses the final block, so it must appear EXACTLY ONCE.

\`\`\`
# QA Verification: <TICKET> — <summary>
**Verdict:** ✅ Ready to deploy / ❌ Not ready / 🚧 Blocked — <one sentence>
**Environment:** <qa url> · merge commit <sha7> · <ISO timestamp>
## Acceptance criteria
| # | Criterion (from the ticket) | Result | Evidence |
|---|---|---|---|
| 1 | <verbatim AC> | ✅ holds / ❌ fails / ⚠️ partial / ⏭ not testable here | <route + observation, or qa-evidence/q1.png> |
## Checks
- **UI:** <routes, what was seen>
- **API/backend:** <endpoint · method · status · assertion>
- **PostHog events:** <event · seen/not seen · properties>
- **Feature flags:** <flag · state · effect>
- **Regressions / splash zone:** <what else was smoke-tested>
## Problems found
<a id="q1"></a>
### 1. <plain title>
**Severity:** 🔴 Blocker / 🟠 Major / 🟡 Minor   **Where:** <route or endpoint>   **Status:** open
**Expected (AC):** …   **Actual:** …   **Evidence:** qa-evidence/q1.png   **Why it matters:** …   **Next step:** …
## QA Verdict
- Verdict: ✅ Ready to deploy
- Blocking problems: 0
\`\`\`

Then set \`${sessionDir}/AGENT_STATE\` to \`ready\` (verdict written) or \`blocked\`, write one line to \`${sessionDir}/AGENT_NOTE\`, and STOP.`;
}

export interface QaChangeContext {
  title: string | null;
  author: string | null;
  mergedAt: string | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  files: readonly string[];
}

export interface QaBriefContext {
  sessionDir: string;
  ticket: string;
  prRepo: string | null;
  prNumber: number | null;
  /** The PR's merge commit oid — the thing QA is supposed to be running. */
  mergeSha: string | null;
  change: QaChangeContext | null;
  /** Absolute paths to REVIEW.md / FINDINGS.md / PLAN.md / COMMENTS.md, existence-checked by the caller. */
  priorArtifacts: readonly string[];
  ticketContext?: TicketBriefContext | null;
  env?: QaEnvironmentBriefContext;
}

export const QA_MAX_BRIEF_CHARS = 40_000;
export const QA_MAX_CHANGED_FILES = 100;
export const DEFAULT_QA_SKILL = '/cgremlin:qa-verify';

function qaChangeSection(ctx: QaBriefContext, change: QaChangeContext): { text: string; truncated: boolean } {
  const lines = [`## The change`];
  const where = ctx.prRepo !== null && ctx.prNumber !== null ? `${ctx.prRepo}#${ctx.prNumber}` : '(no PR)';
  lines.push(`- ${where} — ${change.title ?? '(no title)'} · **MERGED**`);
  lines.push(`- Merge commit: ${ctx.mergeSha ?? '(unknown)'}${change.mergedAt === null ? '' : ` · merged ${change.mergedAt}`}${change.author === null ? '' : ` by @${change.author}`}`);
  lines.push(`- ${change.changedFiles ?? '—'} files changed, +${change.additions ?? '—'}/−${change.deletions ?? '—'}`);
  const files = change.files.slice(0, QA_MAX_CHANGED_FILES);
  const truncated = files.length < change.files.length;
  if (files.length > 0) lines.push('', ...files.map((f) => `- \`${f}\``));
  if (truncated) lines.push('', `_(${change.files.length - files.length} more files not listed)_`);
  if (ctx.prNumber !== null && ctx.prRepo !== null) {
    lines.push(
      '',
      `Three ways to read the diff, all of which work on a MERGED PR: \`gh pr diff ${ctx.prNumber} --repo ${ctx.prRepo}\`, \`git fetch origin pull/${ctx.prNumber}/head\`, or — offline, since this worktree is checked out at the merge commit — \`git show --stat ${ctx.mergeSha ?? 'HEAD'}\`.`,
    );
  }
  return { text: lines.join('\n'), truncated };
}

export function renderQaBrief(ctx: QaBriefContext): string {
  const env = ctx.env ?? EMPTY_QA_ENVIRONMENT;
  const where = ctx.prRepo !== null && ctx.prNumber !== null ? ` (${ctx.prRepo}#${ctx.prNumber}` : '';
  const sha = ctx.mergeSha === null ? '' : `, merged ${ctx.mergeSha.slice(0, 7)}`;
  const title = `# QA VERIFICATION — ${ctx.ticket}${where}${where === '' ? '' : `${sha})`}`;

  let truncated = false;
  const sections: string[] = [title, QA_CONDUCT_RULE];

  const ticketSection = renderTicketSection(ctx.ticketContext);
  if (ticketSection !== '') sections.push(ticketSection);

  if (ctx.change !== null) {
    const block = qaChangeSection(ctx, ctx.change);
    if (block.truncated) truncated = true;
    sections.push(block.text);
  }

  if (ctx.priorArtifacts.length > 0) {
    sections.push(
      `## What we already know\nPaths, not contents — read only what you need:\n${ctx.priorArtifacts
        .map((p) => `- \`${p}\``)
        .join('\n')}`,
    );
  }

  const envSection = renderQaEnvironmentSection(env);
  if (envSection !== '') sections.push(envSection);

  sections.push(qaHowToVerify(ctx.sessionDir), qaOutputContract(ctx.sessionDir));

  let text = sections.join('\n\n');
  const note = '\n\n_(truncated by the engine)_';
  if (text.length > QA_MAX_BRIEF_CHARS - note.length) {
    text = text.slice(0, QA_MAX_BRIEF_CHARS - note.length);
    truncated = true;
  }
  return truncated ? `${text}${note}` : text;
}

export interface QaPromptParams { sessionDir: string; qaSkillCommand?: string }

export function renderQaPrompt(p: QaPromptParams): string {
  const skill = p.qaSkillCommand ?? DEFAULT_QA_SKILL;
  return `Run ${skill} if available and follow ${p.sessionDir}/BRIEF.md; if it is not available follow BRIEF.md's \`## How to verify\` directly. Write ${p.sessionDir}/QA.md. Make no code changes, open no PR, post nothing.`;
}
