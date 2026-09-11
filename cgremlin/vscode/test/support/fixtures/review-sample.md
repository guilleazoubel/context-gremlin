# PR Review: #<number> — <title>

**Does it do what the ticket asked?** ✅ Yes / ⚠️ Mostly / ❌ No — <one plain sentence, name the ticket>
**How deep did I look?** Quick pass / Deep pass (<one-line why>)

## Summary
<2-3 plain sentences: what this PR changes, and your overall take. A teammate should understand the gist from this alone.>

## What I found
| # | Severity | Where | Issue | Status |
|---|----------|-------|-------|--------|
| [1](#f1) | 🔴 Critical | `file.ts:88` | one plain-English line | open |
| [2](#f2) | 🔧 Maintainability | `ui/list.tsx:40` | one plain-English line | open |
| [3](#f3) | 📋 PM/AC | `/search` behavior | acceptance criterion not met — <one line> | open |
| [4](#f4) | 🎨 Design | `PrimaryButton` on `/search` | colour/size differ from Figma — <one line> | open |

📋 PM/AC findings come from the acceptance-criteria check; 🎨 Design findings come from the Figma-fidelity check. Design findings additionally carry Expected vs Actual and an Evidence link (see the detail shape below).

The `#` links jump to the full detail below. Keep the `Status` column current — it's how the reviewer sees at a glance what's still open.

(If nothing: write "Nothing worth flagging — looks good to me." and set the verdict to Approve.)

## Details

<a id="f1"></a>
### 1. <plain-English title of the problem>
**Severity:** 🔴 Critical   **Where:** `path/to/file.ext:LN-LN`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/path/to/file.ext#L<start>-L<end>

**What's wrong:** <2-4 plain sentences. Describe when it happens, what the code does, and what it should do instead — in normal language, no jargon.>

**Why it matters:** <1-2 sentences on the real-world impact: who is affected and how.>

**Suggested fix:** <plain description; add a short code snippet only if it makes it clearer.>

<a id="f2"></a>
### 2. <plain-English title>
**Severity:** 🔧 Maintainability   **Where:** `path/to/file.ext:LN-LN`   **Status:** open
**Link:** https://github.com/<owner>/<repo>/blob/<full-sha>/ui/list.tsx#L40

**What's wrong:** <same shape — for a maintainability issue, explain in plain words what's mixed together that shouldn't be.>

**Why it matters:** <the concrete cost: what becomes hard to test, change, or reuse.>

**Suggested fix:** <how to separate the concerns.>

<a id="f4"></a>
### 4. Button colour and size don't match the Figma design
**Severity:** 🎨 Design   **Where:** `/search` — `PrimaryButton`   **Status:** open
**Expected (design):** background `#1A73E8`, font-size `16px`
**Actual (rendered):** background `#1B74E9`, font-size `14px`
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
