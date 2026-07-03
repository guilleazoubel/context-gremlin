# Prompt Optimization Design
**Date:** 2026-03-17
**Status:** Approved

---

## Problem

The AI prompts embedded in `bin/cgremlin` are verbose, token-heavy, and hard to maintain. The PR Review CLAUDE.md alone is ~350 lines. Templates for output files (REVIEW.md, FINDINGS.md) are embedded as heredocs inside the script, making independent edits tedious. Claude sessions also interrupt users with "allow this tool?" prompts for routine file reads and writes, slowing down unattended runs.

---

## Goals

1. Reduce token usage on all large prompts (target: 25–35% reduction) without output quality regression
2. Make output templates independently editable (separate files, not embedded in `bin/cgremlin`)
3. Eliminate routine "allow this tool?" interruptions for read/write operations appropriate to each session type
4. Keep output files (REVIEW.md, FINDINGS.md, DEVLOG.md) format-identical — no regressions

---

## Non-Goals

- Changing what Claude does (same behavior, fewer tokens)
- Rebuilding the session or CLI architecture
- Changing output file names or locations

---

## Approach: Iterative, Phase-Gated

Each phase ends with a local verification checkpoint. Nothing is committed until the user has reviewed and tested the changes.

---

## Phase 1 — Surgical Compression

Compress each prompt in-place. Same information architecture, tighter language.

### Template paths in `bin/cgremlin`

There are two CLAUDE.md generation paths. Both need compression:

**Primary path** (full, production prompts — highest impact):
- PR Review CLAUDE.md: lines 1762–2111 (~350 lines, written by `create_review_session`)
- Investigation CLAUDE.md: lines 2356–2474 (~120 lines, written by `create_investigation_session`)
- Development CLAUDE.md: lines 2791–2839 (~50 lines, written by `create_dev_session`)

**Legacy callback path** (used when Python server calls `cgremlin --create-session`, ~lines 326–460):
- `REVIEW_TEMPLATE` heredoc (~46 lines) — already compact, no change needed
- `DEV_TEMPLATE` heredoc (~20 lines) — already compact, no change needed
- `INV_TEMPLATE` heredoc (~24 lines) — already compact, no change needed

Phase 1 targets only the primary path.

### Compression targets

| Prompt | Current ~lines | Target ~lines | Primary cuts |
|---|---|---|---|
| PR Review CLAUDE.md (primary) | ~350 | ~200 | Shorten phase framework headings; replace filled-in REVIEW.md example with section-list format spec (see below); compress React/Next.js best-practices bullets; condense "Ongoing Collaboration" to 2 lines (keep in-place update instruction); cut duplicate "BEGIN NOW" calls |
| Investigation CLAUDE.md (primary) | ~120 | ~75 | Replace step-by-step tutorial prose with directive bullets; shrink FINDINGS.md template to section-list format spec only (remove filled-in examples) |
| Ticket-type guidance (6 snippets, lines 979–1050) | ~5 lines each | ~3 lines each | Remove repeated bold headers; keep only the 2–3 most differentiating points per type |
| Fix-all / fix-single / ACR / re-review prompts | already compact | unchanged | Leave as-is |
| Development CLAUDE.md (primary) | already compact | unchanged | Leave as-is |

### What "concise format spec" means

The current REVIEW.md template embeds filled-in example rows and sample finding text (~100 lines). Replace it with a section list that names each required section and its required fields — no filled-in examples. Required sections that MUST be named explicitly in the replacement spec:

1. At a Glance table (fields: Type, Risk, Scope, Verdict)
2. Findings Tracker table (fields: ID, Finding, Severity, Status, Since)
3. Open Findings by severity tier (Critical / High / Medium / Suggestions) — each finding requires: Location, What the code does, The issue, Why this matters, Suggested Fix
4. Resolved Findings section
5. Verdict with rationale paragraph
6. Review History table (fields: Version, Date, Commit, Action)

Same treatment for the FINDINGS.md template in Investigation CLAUDE.md — name the required sections (Problem Statement, Root Cause Analysis with code evidence, Recommendations) without filling them in.

### Note on "Ongoing Collaboration" section

Do NOT remove this section entirely — it contains the critical instruction to update findings in-place rather than appending. Condense to 2 lines: *"Update findings in-place. Move fixed items to Resolved. Keep Tracker table and Verdict current."*

### Verification

A real PR review session produces a REVIEW.md containing all six required sections listed above.

A real investigation session produces a FINDINGS.md with: Problem Statement, Root Cause Analysis with code evidence, Recommendations.

Output quality must be subjectively equal or better — fewer tokens ≠ less thorough.

Token reduction proxy: line count of the primary PR Review CLAUDE.md heredoc drops from ~350 to ≤210.

---

## Phase 2 — Modularization + Permissions

Two parallel tracks delivered together.

### Track A — Reference Files

cgremlin writes standalone template files into the session directory at session-creation time, alongside CLAUDE.md. CLAUDE.md references them rather than embedding their content.

**New files written per session type:**

| Session type | New file | Content |
|---|---|---|
| Review | `REVIEW_TEMPLATE.md` | Output format spec for REVIEW.md |
| Investigation | `FINDINGS_TEMPLATE.md` | Output format spec for FINDINGS.md |

CLAUDE.md becomes: *"Write your output to REVIEW.md following the format in REVIEW_TEMPLATE.md."*

**Benefit:** Editing the output format no longer requires touching `bin/cgremlin`. Each template is its own file.

### Track B — Pre-Approved Permissions

cgremlin already writes `.claude/settings.local.json` into the session's repo clone (lines 1112–1138 bash, lines 4937–4965 Python). The existing permissions cover git read commands, basic shell reads (`cat`, `ls`, `find`, `head`, `tail`, `wc`), `gh pr view/diff`, and `Write`/`Edit` scoped to `$SESSION_DIR/**`.

**Gaps to close:**

1. **`Read` tool not approved** — the current allow list covers only Bash equivalents (`cat`, `ls`, etc.). Claude's native `Read` tool still prompts for confirmation. Add `"Read(*)"` to all session types so Claude can read files uninterrupted.

2. **Fix and Development sessions need repo-wide write/edit** — currently `Write`/`Edit` are scoped to `$SESSION_DIR/**` for all session types. Fix and Development sessions need `Write`/`Edit` across the repo as well. Scope per session type:

| Session type | Write/Edit scope | Bash additions |
|---|---|---|
| Review | `$SESSION_DIR/**` only | none (existing is sufficient) |
| Investigation | `$SESSION_DIR/**` only | none |
| Fix (all or single) | `$SESSION_DIR/**` + `$REPO_DIR/**` | `Bash(npm test *)`, `Bash(npm run *)`, `Bash(grep *)`, `Bash(rg *)` |
| Development | `$SESSION_DIR/**` + `$REPO_DIR/**` | `Bash(npm test *)`, `Bash(npm run *)`, `Bash(grep *)`, `Bash(rg *)` |

3. **Bash grep/rg not approved** — `grep` and `rg` (ripgrep) are common codebase search tools Claude uses. Add `Bash(grep *)` and `Bash(rg *)` to all session types.

**Where permissions are written per session type:**

- Review, Investigation, Development sessions: `setup_output_files()` (bash line ~1086, called by each `create_*_session` function) writes `settings.local.json`. Make it accept a session-type argument and write the appropriate scoped permissions.
- Fix sessions (launched via Python `fix_finding()`, line ~5493): Fix sessions reuse an already-existing review session directory. `fix_finding()` must overwrite `settings.local.json` before launching Claude — using the fix-scoped permission set (repo-wide `Write`/`Edit` + `Bash(npm test *)` etc.). This is a new write step in `fix_finding()`, not covered by `setup_output_files()`.

Both bash and Python `settings.local.json` generation blocks must be updated in sync (they currently contain identical permission lists).

**Note:** Adding `Bash(grep *)` and `Bash(rg *)` to all session types is intentionally broad (allows filesystem-wide grep). This is safe for review/investigation (read-only) and acceptable for fix/dev sessions where broad search is expected. No further scoping needed.

Genuinely destructive operations (force-push, destructive resets, dropping databases) are not in any allow list and still require confirmation.

### Verification

- A new review session directory contains `REVIEW_TEMPLATE.md` alongside `CLAUDE.md`
- Editing `REVIEW_TEMPLATE.md` directly changes output format without editing `bin/cgremlin`
- A review session completes end-to-end with zero "allow this tool?" prompts for `Read` on repo files or `Write` on REVIEW.md
- A fix session applies a fix and updates REVIEW.md finding status without any user interaction

---

## Phase 3+ — To Be Defined

After Phase 2 is verified. Likely candidates:
- Conditional injection of React/Next.js best-practices based on detected repo tech stack
- Shared prompt fragments reused across session types

---

## Delivery Rules

- Each phase produces a diff reviewed and tested locally before commit
- No commits without explicit user approval
- Output file format is treated as a contract — any unintended format change is a regression

---

## Files Changed

**Phase 1:**
- `bin/cgremlin` — compress 3 large prompt heredocs + 7 ticket-type guidance snippets

**Phase 2:**
- `bin/cgremlin` — write `REVIEW_TEMPLATE.md`, `FINDINGS_TEMPLATE.md` at session-creation time; trim CLAUDE.md heredocs to reference those files; update both bash and Python `settings.local.json` generation blocks to add `Read(*)`, `Bash(grep *)`, `Bash(rg *)`, and session-type-scoped `Write`/`Edit` for fix/dev sessions
