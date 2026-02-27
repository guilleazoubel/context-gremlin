# Development Mode, Fix Flows & Tab Naming — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make development mode a first-class experience with senior engineer CLAUDE.md instructions, rich fix-finding flows that pass full session context, and persistent iTerm2 tab names.

**Architecture:** Four independent changes to the sandbox dashboard (both `sandbox` and `.dashboard_server.py`): (1) rewrite development CLAUDE.md template, (2) enhance switch-mode modal with additional instructions field, (3) gate fix buttons on development mode and enrich fix prompts with full context, (4) fix iTerm2 tab names so they persist.

**Tech Stack:** Bash, Python, JavaScript (all embedded in sandbox/dashboard_server.py)

---

## 1. Development Mode CLAUDE.md Rewrite

**Current state:** Generic template — "implement the requested feature or fix" and "document in DEVLOG.md".

**New template:** Senior engineer playbook with:
- Role definition: senior software engineer who reads and understands codebase patterns before writing code
- Task Context section: Jira ticket details (if available) + custom development prompt (if provided)
- Engineering Principles: DRY, low complexity, no hacks, maintainability, follow existing patterns, small focused changes
- Before Writing Code checklist: read codebase, check FINDINGS.md/REVIEW.md, understand the "why"
- Development Process: implement, test, commit incrementally, document in DEVLOG.md
- What NOT to Do: no conflicting patterns, no over-engineering, no TODO-as-solution, no bypassing safety checks

Template must be updated in:
- `sandbox` bash `switch_to_development_mode()` (~line 3139)
- `sandbox` Python `switch_session_mode()` development case
- `.dashboard_server.py` Python `switch_session_mode()` development case

## 2. Switch Mode Modal Enhancement

**Current state:** Development mode shows only a Jira ticket field.

**New state:** Two fields when development mode is selected:
1. **Jira Ticket** (existing) — auto-detected from branch, editable text input
2. **Additional Instructions** (new) — textarea for custom context/prompt, placeholder: "Optional: describe what you want to build, focus areas, constraints..."

Both fields are optional. Values stored in `session.json`:
```json
{
  "mode": "development",
  "dev_prompt": "Focus on the authentication flow...",
  "jira": "PROJ-123"
}
```

The `dev_prompt` field persists and is available to fix-finding flows.

Changes in:
- JS `selectSwitchMode()` — add textarea when mode is "development"
- JS `confirmSwitchMode()` — pass `dev_prompt` to API
- Python `switch_session_mode()` — store `dev_prompt` in session.json, inject into CLAUDE.md
- Mirror to `.dashboard_server.py`

## 3. Fix Finding & Fix All — Dev Mode Gating + Rich Context

### Visibility Rules

- **"Fix" button** on individual findings: hidden unless `session.mode === 'development'`
- **"Fix All Findings" button** in action bar: hidden unless `session.mode === 'development'`
- Consistent with Commit button (already dev-only)

### Fix Single Finding Flow

1. User clicks "Fix" on a finding
2. Frontend calls `/api/fix-finding` with finding data + `fix_all: false`
3. Backend builds prompt:
   - Senior engineer role (the dev CLAUDE.md already provides this via `--add-dir`)
   - Session Jira context + custom dev prompt
   - Specific finding details: number, title, file, line, problem, impact, suggested fix
   - Instruction: fix the finding, update REVIEW.md status, do NOT commit
4. Opens fresh iTerm2 tab: session color + name "🔧 Fix: {session_name}"
5. Launches `claude --add-dir '{session_path}' -- '{prompt}'`

### Fix All Findings Flow

1. User clicks "Fix All Findings" → confirmation dialog
2. Frontend calls `/api/fix-finding` with `fix_all: true`
3. Backend builds prompt:
   - Same senior engineer context
   - Instruction: read REVIEW.md, identify all open findings (skip dismissed/resolved), work through each, update status after each, do NOT commit
4. Opens fresh iTerm2 tab: session color + name "🔧 Fix All: {session_name}"

### Context Enrichment

The fix prompt now references all available context files. Since `--add-dir` points to the session folder and CLAUDE.md is in session root, Claude automatically has:
- CLAUDE.md with senior engineer instructions + task context
- REVIEW.md with all findings
- FINDINGS.md with investigation notes
- DEVLOG.md with development progress
- session-info.txt with ticket details

The fix prompt explicitly tells Claude to read these files for context.

## 4. iTerm2 Tab Name Persistence

**Problem:** `set name to` in AppleScript sets the tab title, but the shell prompt immediately overwrites it via ANSI escape sequences.

**Fix:** After `set name to`, send an iTerm2 escape sequence that sets the "user-defined title" which persists over shell title changes:

```applescript
set name to "🧪 session-name"
write text "printf '\\033]1;🧪 session-name\\a'"
```

The `\033]1;...\a` escape sets the "icon name" (tab title) in iTerm2, which takes precedence when a user-defined name is set.

Apply to ALL tab creation points in both files:
- Start Claude session (🧪)
- Start ACR+Claude (🧪)
- Fix finding (🔧 Fix:)
- Fix all findings (🔧 Fix All:)
- Refresh PR (🔄 Re-review:)
- Open Terminal (📂)
- Run App (▶️ App:)

Terminal.app fallback is unchanged (no tab naming API).

## What Does NOT Change

- Review mode CLAUDE.md template
- Investigation mode CLAUDE.md template
- API response formats
- Session data model (only adds optional `dev_prompt` field)
- Terminal.app fallback behavior
- Existing session color coding
