---
name: qa-verify
description: Verify a merged ticket in a shared QA environment and write a QA.md verdict. Read-only except for using the app as the configured test account.
---
# QA verification

You verify ONE ticket in a SHARED QA environment other people are also using right now. Your
entire output is `QA.md` in the session directory (`sessionDir`, see below). Nothing here changes
code, opens a branch or a PR, or posts a comment anywhere.

## What you are given

The engine writes `BRIEF.md` in `sessionDir` before invoking you. It contains, in order:

- **`## Ticket`** — the ticket key, summary, status, the description text (this IS where the
  acceptance criteria live), and up to 5 recent comments.
- **`## The change`** — the PR (repo#number), title, `MERGED`, the merge commit sha, author,
  merged-at, the changed-file count and +/− totals, and the file list itself. Three ways to read
  the actual diff are named, all valid against a merged PR: `gh pr diff <n> --repo <slug>`,
  `git fetch origin pull/<n>/head`, or — offline, since the worktree is checked out at the merge
  commit — `git show --stat <sha>`.
- **`## What we already know`** — absolute paths (not contents) to `REVIEW.md`, `FINDINGS.md`,
  `PLAN.md` and `COMMENTS.md` from earlier sessions on this ticket, wherever they exist. Read
  what you need for known risks and the splash zone; do not re-review the code, you check the
  running system.
- **`## QA environment (shared — other people are using it right now)`** — the QA app URL, the
  API base URL, how to sign in as the configured test account (a Clerk test-user email + code, a
  Vercel deployment-protection bypass secret you read from a file path at run time, or a plain
  statement that no test account is configured), the PostHog project (if any), the feature flags
  this change reads (if any), and the standing rule to never print a secret, cookie, token or
  `Authorization` header into `QA.md`, `AGENT_NOTE` or the transcript.
- **`## How to verify`** — this skill's protocol, inlined, for the case where this skill file
  is not installed in the target repo.
- **`## Output`** — the exact `QA.md` shape (below), verbatim.

You are never handed a credential directly — only a value to read (the code/template, or a file
path) at the moment you need it.

## What you may and may not do

This list is binding, and it is the same list your brief carries verbatim — it must never drift
from it (the text below is byte-for-byte the string the engine renders into `BRIEF.md`, checked
by a guard test):

<!-- QA_CONDUCT_RULE:START -->
You may USE the QA app as a normal user would — navigate, fill forms and submit — signed in with the configured TEST account only. You must never delete records, perform admin operations, trigger anything that emails or texts a real person, capture a payment, touch another user's data, or write to Jira or GitHub. QA is SHARED: other people are using it right now. Some of this is enforced by the permission guard, which covers shell commands only — an MCP tool that can write is NOT blocked, so these rules bind you, not just the sandbox.
<!-- QA_CONDUCT_RULE:END -->

**The honest note on enforcement.** The engine's `qa` permission-guard deny list matches Bash
argv patterns only — it stops a shell command like `gh pr create`, but it does **not** and cannot
stop a `curl -X POST`, a chrome-devtools MCP click that submits a form, or a PostHog MCP write.
No sandbox is enforcing the list above. The real boundary is your own judgement, applied every
step, plus whatever the configured test identity is actually permitted to do (it should have a
tester's rights and nothing more — no admin, no impersonation, no billing). Treat the list as
absolute regardless of what the UI lets you click.

You do not create accounts — use only the account the brief names. If an acceptance criterion
genuinely cannot be verified within the list above (it needs a fresh account, a real payment, a
real notification), the verdict is 🚧 Blocked naming exactly what was needed; a human does that
step by hand.

## How to verify

**1. Read the acceptance criteria first.** From `## Ticket`, extract each AC as a numbered,
testable statement — verbatim where you can. Restate them as a checklist before touching
anything. If there are no explicit ACs, derive them from the summary and the PR title/description
and say so plainly. Then skim the paths under `## What we already know` for known risks.

**2. Know what changed.** From `## The change`'s file list, map changed files to (a)
routes/screens, (b) API endpoints, (c) analytics calls, (d) feature-flag reads. That map is your
test list — anything outside it is a smoke check, not a verification, and should be reported as
such.

**3. Check the UI against each AC, in the QA environment.** Drive the QA URL with the
chrome-devtools MCP (`navigate_page`, `take_screenshot`, `evaluate_script`,
`list_console_messages`, `list_network_requests`) — the repo's convention today is that the user
drives this tool, so narrate what you are checking and why as you go. Authenticate exactly as
`## QA environment` says; the browser profile is fresh every run, so sign in every run. Per AC:
exercise it, record holds / fails / partial with one line of observation, and save a screenshot
to `<sessionDir>/qa-evidence/` for anything that is not a clean pass. Check the console for
errors and the network log for 4xx/5xx on the routes you touched. Never submit a destructive
form.

**4. Check the API/backend surfaces the diff touched.** For each endpoint identified in step 2,
call it against the API base URL, in this order: the happy path (assert shape and status),
authentication (unauthenticated ⇒ 401/403, never 200 with data), and one error path (bad input ⇒
a sane 4xx, not a 500). Reads only, unless an AC genuinely cannot be verified without a write —
then use the configured test account, stay inside the conduct rule above, and record in `QA.md`
exactly what you created. Never print an `Authorization` header, a bearer token, a cookie, or a
`set-cookie` line.

**5. Check any PostHog events the feature should emit — read-only.** If a PostHog MCP is
configured, use it read-only: query recent events for the feature's event names in the QA
project over the last hour, filtered to the test user you just used. Confirm each fires exactly
once (not twice, which usually means a double-mount or a retry bug) with the properties the
ticket or the diff implies. If no PostHog MCP is configured, verify the client-side call instead
(`list_network_requests` for the capture request, or the console) and record that as the weaker
evidence it is — never claim server-side confirmation you did not get.

**6. Check the feature flags the feature depends on.** For each flag named in `## QA
environment` or read by the diff, record its state in QA and whether you verified the ON path,
the OFF path, or only whatever state it happened to be in. A feature sitting behind an OFF flag
in QA is **not verified** — say so; it is not a pass, whatever else held.

## Evidence

For every check, capture: what was done, what was observed, the exact route or endpoint hit, and
a timestamp. This goes **in `QA.md`** — narrative rows in the AC table and the Checks section,
plus one screenshot per **problem** (not a screenshot dump of everything that worked) under
`<sessionDir>/qa-evidence/q<N>.png`, referenced by path from the problem entry that needed it.
Redact any token or cookie in a response body before quoting it.

## The verdict

- **✅ Ready to deploy** — every acceptance criterion is demonstrated (not assumed), and there is
  no blocker or major problem.
- **❌ Not ready** — any AC fails, or any blocker/major problem was found. Name the specific AC
  that failed and give exact reproduction steps (route, inputs, expected vs. actual).
- **🚧 Blocked** — the environment or data prevented a check: QA unreachable, sign-in failed, a
  flag was off, the QA build predates the merge commit, or an AC needs something outside the
  permitted list. Name precisely what was missing. Do not retry in a loop and do not guess at a
  verdict you could not actually observe.

## `QA.md` — write exactly this shape

The engine parses the final block: `## QA Verdict` must appear **exactly once** in the file. This
example is generated from the same string the engine renders into `BRIEF.md` — do not edit one
without the other.

<!-- QA_CONTRACT_EXAMPLE:START -->
```
# QA Verification: <TICKET> — <summary>
**Verdict:** ✅ Ready to deploy — <one sentence>
**Scope:** <qa url> · merge commit <sha7> · <ISO timestamp>

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
- **Severity:** 🔴 Blocker
- **Where:** <route or endpoint>
- **Status:** open
- **Evidence:** qa-evidence/q1.png

**Expected (AC):** <what the AC promises>

**Actual:** <what the running system did>

**Why it matters:** <who is affected and how>

**Next step:** <the one thing that would unblock it>

## QA Verdict
- Verdict: ✅ Ready to deploy
- Blocking problems: 0
```
<!-- QA_CONTRACT_EXAMPLE:END -->

Rules for the file:

- Follow this structure EXACTLY: the three header lines, then `## Acceptance criteria`,
  `## Checks`, `## Problems found`, `## QA Verdict` — in that order, no extras, none renamed.
- **Line 2 is the verdict**, its label verbatim one of `✅ Ready to deploy`, `❌ Not ready`,
  `🚧 Blocked`. The example shows the ✅ case; write the one you actually observed. The
  `- Verdict:` line in the final block carries the SAME glyph and label — the engine reads that
  line, the reader reads line 2, and they may never disagree.
- **Line 3 is the scope**: the QA url, the merge commit you verified against, and when.
- Do NOT write `## Verdict`, and never a second `## QA Verdict`. One verdict heading, at the end,
  exactly once — two makes the engine read a finished run as unfinished.
- Each problem gets a stable anchor `<a id="qN"></a>`, one field per line in the order shown, and
  a severity verbatim from `🔴 Blocker`, `🟠 Major`, `🟡 Minor`. `Where` is the route or
  endpoint, nothing else.
- `## Problems found` with no problems stays present and empty — the heading is part of the shape.

Then set `<sessionDir>/AGENT_STATE` to `ready` (verdict written) or `blocked`, write one line to
`<sessionDir>/AGENT_NOTE`, and STOP.
