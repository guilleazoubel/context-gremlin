# Prompt Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token usage in cgremlin's AI prompts, modularize output templates into separate files, and eliminate routine "allow this tool?" interruptions.

**Architecture:** Two phases. Phase 1 compresses the three large CLAUDE.md heredocs in-place inside `bin/cgremlin`. Phase 2 extracts output templates to standalone files and expands pre-approved tool permissions, scoped per session type. All changes are in a single file (`bin/cgremlin`). Each task ends with a syntax check; nothing is committed until the user reviews and tests locally.

**Tech Stack:** Bash heredocs, embedded Python (lines ~4357–9516 in `bin/cgremlin`). No test framework — verification is `bash -n bin/cgremlin` (bash syntax), `python3 -c "import ast; ast.parse(open('f').read())"` (Python syntax), and manual session inspection.

---

## File Structure

**Only one file changes throughout this plan:**

| File | What changes |
|---|---|
| `bin/cgremlin` | Phase 1: compress 3 heredocs + 6 ticket-type snippets. Phase 2: new template file writes in `create_review_session`/`create_investigation_session`, updated `setup_output_files()` permissions, new permissions write in Python `fix_finding()`. |

---

## How to Verify After Each Task

After every edit, run:
```bash
bash -n bin/cgremlin
echo "Syntax OK: $?"
```

If that fails, the heredoc was broken. Fix before continuing.

For Phase 2 Python edits, also run:
```bash
python3 -c "
import re, ast
src = open('bin/cgremlin').read()
m = re.search(r\"cat << 'PYSERVER_EOF'(.+?)^PYSERVER_EOF\", src, re.DOTALL | re.MULTILINE)
ast.parse(m.group(1))
print('Python syntax OK')
"
```

---

## PHASE 1 — Surgical Compression

---

### Task 1: Compress PR Review CLAUDE.md — Phases 1–3 framework sections

**File:** `bin/cgremlin` lines ~1817–1934

The current Phase 1/2/3 framework is verbose with redundant sub-bullets. Compress each phase section by removing repeated explanatory prose, keeping only directive bullets.

- [ ] **Step 1: Note the current line count of the PR Review heredoc**

```bash
awk '/cat > CLAUDE.md << CLAUDE_EOF/{found=1} found{count++} /^CLAUDE_EOF$/{if(found){print "PR Review CLAUDE.md lines:", count; exit}}' bin/cgremlin
```

Record this number. Target after all Phase 1 tasks: ≤210 lines.

- [ ] **Step 2: Replace the Phase 1/2/3 sections**

Find the block from `## PHASE 1: Classify the PR Type` through the end of `### 3.9 Repo-Specific Review Skills` (lines ~1817–1932). Replace with this compressed version:

```
## Step 1: Classify

| Type | Key Concern |
|------|-------------|
| **Feature** | Completeness, correctness |
| **Bug Fix** | Minimal fix, no scope creep |
| **Refactor** | Zero functional/behavioral changes |
| **Performance** | Identical behavior, different speed |
| **Chore** | No logic changes hidden in deps/config |
| **Docs** | Code unchanged |

## Step 2: Macro Analysis

- **Intent**: Does the PR do what it claims? Scope appropriate?
- **Type violations** (🚨 most important): Refactors with behavior changes, bug fixes with scope creep, features touching unrelated code
- **Architecture**: Fits existing patterns? Simpler alternatives?
- **Completeness**: TODOs, missing migrations/configs/env vars, missing docs for public APIs?

## Step 3: Micro Analysis

Run these in parallel using the Task tool:

- **Correctness**: Logic errors, null handling, race conditions, unhandled edge cases
- **Security**: Input validation, injection (SQL/XSS/command), auth bypasses, secrets in code, sensitive data in logs
- **Performance**: N+1 queries, missing indexes, unbounded loops, missing pagination
- **Code quality**: Readability, naming, DRY violations, dead code, style consistency
- **Complexity**: Over-engineering, deep nesting, long functions, simpler alternatives
- **Testing**: New code has tests? Tests verify behavior (not just coverage)? Edge cases covered?
- **Regression risk**: Changes to shared utilities, API contract changes, schema changes, config changes
- **Best practices**:
  - React: `Promise.all()` for independent fetches; avoid barrel imports; `React.cache()` in server components; ternary not `&&` for conditional render
  - A11y: semantic HTML, keyboard nav, 44px touch targets, visible focus, loading/error states
- **Repo skills**: Check `.agents/skills/` or `.claude/skills/` for review-relevant skills; invoke and incorporate findings
```

- [ ] **Step 3: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 2: Replace the embedded REVIEW.md template with a section-list spec

**File:** `bin/cgremlin` lines ~1936–2094

This is the biggest token win. The current template embeds ~148 lines of filled-in example text. Replace the entire `## PHASE 4: Write Review` section through `## Ongoing Collaboration` (exclusive — that's Task 3) with a compact format spec.

- [ ] **Step 1: Replace the Phase 4 / output template section**

Find `## PHASE 4: Write Review` through (but not including) `## Ongoing Collaboration`. Replace with:

```
## Step 4: Write REVIEW.md

Write to `REVIEW.md`. Include all sections below in order:

1. **At a Glance** — table: Type | Risk (🟢Low/🟡Medium/🔴High) | Scope (✅/⚠️) | Verdict
2. **Summary** — 2–3 sentences: what this PR does, why, overall assessment
3. **Understanding the Changes** — What Changed / Why It Changed / How It Works
4. **Macro Analysis** — Intent Alignment / PR Type Check / Architecture Fit
5. **Findings Tracker** — table: ID | Finding | Severity | Status | Since
6. **Open Findings** — grouped by tier:
   - 🔴 Critical (blocks merge) / 🟠 High (should fix) / 🟡 Medium / 🔵 Suggestions
   - Each finding must include: `📍 Location` (file:line), **What the code does**, **The issue**, **Why this matters**, **Suggested Fix**
7. **Resolved Findings** — brief per-item note with resolution and commit
8. **What's Done Well** — positive callouts
9. **Verdict** — ✅ Approve / 🔄 Request Changes / 💬 Comment + rationale paragraph
10. **Review History** — table: Version | Date | Commit | Action

**NEVER post to GitHub.** Do not run `gh pr comment`, `gh pr review`, or any GitHub-writing command. Write REVIEW.md only.
```

- [ ] **Step 2: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

- [ ] **Step 3: Check line count reduction**

```bash
awk '/cat > CLAUDE.md << CLAUDE_EOF/{found=1} found{count++} /^CLAUDE_EOF$/{if(found){print "PR Review CLAUDE.md lines:", count; exit}}' bin/cgremlin
```

Should now be significantly below the original. The target after all Phase 1 tasks is ≤210.

---

### Task 3: Condense "Ongoing Collaboration" and remove duplicate BEGIN NOW

**File:** `bin/cgremlin` lines ~2097–2111

- [ ] **Step 1: Replace "Ongoing Collaboration" section**

Find `## Ongoing Collaboration` through the end of the section (before `**BEGIN NOW**`). Replace with:

```
## Collaboration

Update findings in-place. Move fixed items to Resolved. Keep Tracker table and Verdict current.
```

- [ ] **Step 2: Consolidate BEGIN NOW**

The heredoc currently ends with `**BEGIN NOW: Classify the PR type, then run macro analysis, then parallel micro analyses. Include code snippets for every finding.**`

Keep this single line. If there is a duplicate `> **IMPORTANT**: Start the review immediately` near the top of the heredoc (line ~1765), remove it and rely solely on the final BEGIN NOW.

- [ ] **Step 3: Verify and check final line count**

```bash
bash -n bin/cgremlin && echo "OK"
awk '/cat > CLAUDE.md << CLAUDE_EOF/{found=1} found{count++} /^CLAUDE_EOF$/{if(found){print "PR Review CLAUDE.md lines:", count; exit}}' bin/cgremlin
```

Expected: ≤210 lines.

---

### Task 4: Compress Investigation CLAUDE.md

**File:** `bin/cgremlin` lines ~2356–2474

Current: ~120 lines of step-by-step tutorial prose + verbose FINDINGS.md template. Target: ~75 lines.

- [ ] **Step 1: Replace the Investigation CLAUDE.md heredoc content**

The heredoc runs from `cat > CLAUDE.md << CLAUDE_EOF` (line ~2356) to `CLAUDE_EOF` (line ~2474). Replace its contents with this compressed version (keep the surrounding bash — only change what's between the heredoc markers):

```
# Investigation Session - AUTO-START

> Read this document, then begin immediately.

## Problem

### $JIRA_TICKET_ID: $JIRA_SUMMARY

$([ -n "$JIRA_TICKET_ID" ] && echo "Jira context below includes the reported issue, description, team comments, and any attachments.")
$([ -n "$INVESTIGATION" ] && echo "
**Additional context:**
$INVESTIGATION")

---

$PROBLEM_CONTEXT

$([ -n "$JIRA_TICKET_TYPE" ] && generate_jira_guidance "$JIRA_TICKET_TYPE" "investigation")

---

## Mission

1. **Understand the issue**: What's the expected vs actual behavior?
2. **Find the root cause**: Trace through code to identify WHY this happens
3. **Document findings**: Write to `FINDINGS.md` as you go

## Repo

- **Repository**: $REPO_URL
- **Branch**: \`$BRANCH_INFO\`

## Investigation Steps

1. Re-read the problem — note key terms, components, error messages, reproduction steps
2. Find related files — understand architecture around the affected area, map data flow
3. Trace code paths — look for edge cases, race conditions, logic errors; check git log/blame on affected files
4. Write `FINDINGS.md` with these sections:
   - **Problem Statement** — restate the issue in your own words
   - **Summary** — 2–3 sentences: what you found, root cause
   - **Key Files** — `path/to/file.ts:line` with role description
   - **Root Cause Analysis** — What's Happening / Why It's Happening / Code Evidence (with file:line)
   - **Recommendations** — Immediate Fix / Follow-up Improvements
   - **Questions / Unknowns**

Always include file paths and line numbers. Every finding must relate back to the reported problem.

---

**BEGIN NOW**: Summarize your understanding of the problem, then explore the codebase.
```

- [ ] **Step 2: Verify bash syntax and line count**

```bash
bash -n bin/cgremlin && echo "OK"
awk '/cat > CLAUDE.md << CLAUDE_EOF/{p=0} /create_investigation_session/{p=1} p && /cat > CLAUDE.md << CLAUDE_EOF/{found=1} found{count++} found && /^CLAUDE_EOF$/{print "Investigation CLAUDE.md lines:", count; exit}' bin/cgremlin
```

Expected: ≤80 lines.

---

### Task 5: Compress ticket-type guidance (6 snippets)

**File:** `bin/cgremlin` lines ~979–1050 (function `generate_jira_guidance`)

Each snippet currently has: a bold section header + 4 numbered points. Compress to a 1-line intro + 2–3 essential points, removing the redundant bold section header.

- [ ] **Step 1: Replace all 6 snippets in `generate_jira_guidance()`**

Replace each heredoc body. Exact replacements:

**Story PR** (replaces `STORY_PR` body):
```
Story PR — verify acceptance criteria met, implementation delivers intended user value, scope is appropriate.
```

**Story Investigation** (replaces `STORY_INV` body):
```
Story investigation — identify the best technical approach, consider edge cases, propose solution meeting acceptance criteria.
```

**Bug PR** (replaces `BUG_PR` body):
```
Bug fix PR — verify fix addresses root cause (not symptoms), no regressions introduced, regression test present, scope is minimal.
```

**Bug Investigation** (replaces `BUG_INV` body):
```
Bug investigation — reproduce the behavior, identify root cause, determine minimal fix, consider side effects.
```

**Task** (replaces `TASK_CTX` body):
```
Technical task — focus on correctness, maintainability, and documentation if applicable.
```

**Spike** (replaces `SPIKE_CTX` body):
```
Spike — gather information, evaluate trade-offs, document findings and recommendations, provide implementation estimates.
```

Keep the `echo ""` for the `*` default case unchanged.

- [ ] **Step 2: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 6: Phase 1 verification checkpoint

- [ ] **Step 1: Check final PR Review heredoc line count**

```bash
awk '/cat > CLAUDE.md << CLAUDE_EOF/{found=1; count=0} found{count++} /^CLAUDE_EOF$/{if(found && count>5){print "PR Review CLAUDE.md lines:", count; found=0}}' bin/cgremlin
```

Must be ≤210. If over, find the remaining verbose section and trim further.

- [ ] **Step 2: Verify all required sections are present**

```bash
python3 - << 'EOF'
import re, sys

src = open('bin/cgremlin').read()

# Extract the PR Review CLAUDE.md heredoc
m = re.search(r'cat > CLAUDE\.md << CLAUDE_EOF\n(.+?)\nCLAUDE_EOF', src, re.DOTALL)
if not m:
    print("ERROR: Could not find PR Review CLAUDE.md heredoc")
    sys.exit(1)

content = m.group(1)
required = [
    "At a Glance",
    "Findings Tracker",
    "Open Findings",
    "Resolved Findings",
    "Verdict",
    "Review History",
    "NEVER post to GitHub",
    "Update findings in-place",
]
missing = [r for r in required if r not in content]
if missing:
    print("MISSING from PR Review CLAUDE.md:", missing)
    sys.exit(1)
print("All required sections present ✓")
EOF
```

- [ ] **Step 3: Verify Investigation CLAUDE.md required sections**

```bash
python3 - << 'EOF'
import re, sys

src = open('bin/cgremlin').read()

# Find the second CLAUDE.md heredoc (Investigation)
matches = list(re.finditer(r'cat > CLAUDE\.md << CLAUDE_EOF\n(.+?)\nCLAUDE_EOF', src, re.DOTALL))
if len(matches) < 2:
    print("ERROR: Could not find Investigation CLAUDE.md heredoc")
    sys.exit(1)

content = matches[1].group(1)
required = [
    "Problem Statement",
    "Root Cause Analysis",
    "Recommendations",
    "BEGIN NOW",
]
missing = [r for r in required if r not in content]
if missing:
    print("MISSING from Investigation CLAUDE.md:", missing)
    sys.exit(1)
print("All required investigation sections present ✓")
EOF
```

- [ ] **Step 4: Show the diff to the user for review**

```bash
git diff bin/cgremlin | head -300
```

**STOP HERE.** Show the diff to the user and wait for approval before continuing to Phase 2. Do not commit yet.

---

## PHASE 2 — Modularization + Permissions

---

### Task 7: Update `setup_output_files()` to accept session type and scope permissions

**File:** `bin/cgremlin` lines ~1086–1140

`setup_output_files()` currently writes one fixed `settings.local.json` for all session types. Extend it to accept a second argument `session_type` and write scoped permissions.

- [ ] **Step 1: Replace `setup_output_files()` function**

Replace the entire function (lines ~1086–1140) with:

```bash
# Setup output files in session root with symlinks in repo
# Args: SESSION_DIR, SESSION_TYPE (review|investigation|development|fix)
setup_output_files() {
    local SESSION_DIR="$1"
    local SESSION_TYPE="${2:-review}"

    # Create output files in session root if they don't exist
    [ ! -f "$SESSION_DIR/REVIEW.md" ] && touch "$SESSION_DIR/REVIEW.md"
    [ ! -f "$SESSION_DIR/FINDINGS.md" ] && touch "$SESSION_DIR/FINDINGS.md"
    [ ! -f "$SESSION_DIR/CLAUDE.md" ] && touch "$SESSION_DIR/CLAUDE.md"

    # Create symlinks in repo directory (remove existing files first)
    if [ -d "$SESSION_DIR/repo" ]; then
        # If there's already content in repo, move it to session root
        [ -f "$SESSION_DIR/repo/REVIEW.md" ] && [ ! -L "$SESSION_DIR/repo/REVIEW.md" ] && \
            mv "$SESSION_DIR/repo/REVIEW.md" "$SESSION_DIR/REVIEW.md"
        [ -f "$SESSION_DIR/repo/FINDINGS.md" ] && [ ! -L "$SESSION_DIR/repo/FINDINGS.md" ] && \
            mv "$SESSION_DIR/repo/FINDINGS.md" "$SESSION_DIR/FINDINGS.md"
        [ -f "$SESSION_DIR/repo/CLAUDE.md" ] && [ ! -L "$SESSION_DIR/repo/CLAUDE.md" ] && \
            mv "$SESSION_DIR/repo/CLAUDE.md" "$SESSION_DIR/CLAUDE.md"

        # Remove any existing files/links and create fresh symlinks
        rm -f "$SESSION_DIR/repo/REVIEW.md" "$SESSION_DIR/repo/FINDINGS.md" "$SESSION_DIR/repo/CLAUDE.md"
        ln -sf "../REVIEW.md" "$SESSION_DIR/repo/REVIEW.md"
        ln -sf "../FINDINGS.md" "$SESSION_DIR/repo/FINDINGS.md"
        ln -sf "../CLAUDE.md" "$SESSION_DIR/repo/CLAUDE.md"

        # Configure Claude permissions scoped to session type
        mkdir -p "$SESSION_DIR/repo/.claude"

        local write_scopes="\"Write($SESSION_DIR/**)\", \"Edit($SESSION_DIR/**)\""
        if [ "$SESSION_TYPE" = "fix" ] || [ "$SESSION_TYPE" = "development" ]; then
            local repo_abs
            repo_abs=$(realpath "$SESSION_DIR/repo" 2>/dev/null || echo "$SESSION_DIR/repo")
            write_scopes="\"Write($SESSION_DIR/**)\", \"Edit($SESSION_DIR/**)\", \"Write($repo_abs/**)\", \"Edit($repo_abs/**)\""
        fi

        local fix_bash=""
        if [ "$SESSION_TYPE" = "fix" ] || [ "$SESSION_TYPE" = "development" ]; then
            fix_bash="\"Bash(npm test *)\", \"Bash(npm run *)\","
        fi

        cat > "$SESSION_DIR/repo/.claude/settings.local.json" << CLAUDE_SETTINGS
{
  "permissions": {
    "allow": [
      "Read(*)",
      "Bash(git status *)",
      "Bash(git log *)",
      "Bash(git diff *)",
      "Bash(git show *)",
      "Bash(git branch *)",
      "Bash(git rev-parse *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(find *)",
      "Bash(wc *)",
      "Bash(grep *)",
      "Bash(rg *)",
      "Bash(gh pr view *)",
      "Bash(gh pr diff *)",
      $fix_bash
      $write_scopes
    ],
    "deny": []
  }
}
CLAUDE_SETTINGS
    fi
}
```

**Note:** The `$fix_bash` variable interpolation inside the heredoc requires the heredoc marker to be unquoted (`<< CLAUDE_SETTINGS`, not `<< 'CLAUDE_SETTINGS'`). The existing heredoc is already unquoted (`<< CLAUDE_SETTINGS`), so this is consistent.

- [ ] **Step 2: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 8: Write REVIEW_TEMPLATE.md at review session creation

**File:** `bin/cgremlin` — inside `create_review_session()` function, near `setup_output_files` call (~line 2114)

- [ ] **Step 1: Pass "review" type to `setup_output_files` in `create_review_session()`**

Find the call `setup_output_files "$SESSION_DIR"` inside `create_review_session()`. Change it to:

```bash
setup_output_files "$SESSION_DIR" "review"
```

- [ ] **Step 2: Add REVIEW_TEMPLATE.md write after the `setup_output_files` call**

Immediately after `setup_output_files "$SESSION_DIR" "review"`, insert:

```bash
    # Write REVIEW_TEMPLATE.md — defines output format independently of CLAUDE.md
    cat > "$SESSION_DIR/REVIEW_TEMPLATE.md" << 'REVIEW_TMPL_EOF'
# REVIEW.md Format

Include all sections below in order:

1. **At a Glance** — table: Type | Risk (🟢Low/🟡Medium/🔴High) | Scope (✅Appropriate/⚠️Too Broad/⚠️Too Narrow) | Verdict
2. **Summary** — 2–3 sentences: what this PR does, why, overall assessment
3. **Understanding the Changes** — What Changed / Why It Changed / How It Works
4. **Macro Analysis** — Intent Alignment / PR Type Check / Architecture Fit
5. **Findings Tracker** — table: ID | Finding | Severity | Status | Since
6. **Open Findings** — grouped: 🔴 Critical / 🟠 High / 🟡 Medium / 🔵 Suggestions
   Each finding: `📍 Location` (file:line), **What the code does**, **The issue**, **Why this matters**, **Suggested Fix**
7. **Resolved Findings** — brief per-item note with resolution and commit ref
8. **What's Done Well** — positive callouts
9. **Verdict** — ✅ Approve / 🔄 Request Changes / 💬 Comment + rationale paragraph
10. **Review History** — table: Version | Date | Commit | Action

Never post to GitHub. Write REVIEW.md only.
Update findings in-place. Move fixed items to Resolved. Keep Tracker and Verdict current.
REVIEW_TMPL_EOF
    ln -sf "../REVIEW_TEMPLATE.md" "$SESSION_DIR/repo/REVIEW_TEMPLATE.md" 2>/dev/null || true
```

- [ ] **Step 3: Update the PR Review CLAUDE.md Step 4 section to reference the template**

In the PR Review CLAUDE.md heredoc (compressed in Task 2), find the `## Step 4: Write REVIEW.md` section. Replace its body with:

```
## Step 4: Write REVIEW.md

Follow the format specified in `REVIEW_TEMPLATE.md`. All 10 sections are required.

**NEVER post to GitHub.** Do not run `gh pr comment`, `gh pr review`, or any GitHub-writing command.
```

(Remove the inline section list — it now lives in REVIEW_TEMPLATE.md.)

- [ ] **Step 4: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 9: Write FINDINGS_TEMPLATE.md at investigation session creation

**File:** `bin/cgremlin` — inside `create_investigation_session()` function, near `setup_output_files` call (~line 2476)

- [ ] **Step 1: Pass "investigation" type to `setup_output_files`**

Find `setup_output_files "$SESSION_DIR"` inside `create_investigation_session()`. Change to:

```bash
setup_output_files "$SESSION_DIR" "investigation"
```

- [ ] **Step 2: Add FINDINGS_TEMPLATE.md write after setup**

Immediately after, insert:

```bash
    # Write FINDINGS_TEMPLATE.md — defines output format independently of CLAUDE.md
    cat > "$SESSION_DIR/FINDINGS_TEMPLATE.md" << 'FINDINGS_TMPL_EOF'
# FINDINGS.md Format

Include all sections:

1. **Problem Statement** — restate the issue in your own words after investigating
2. **Summary** — 2–3 sentences: what you found, root cause
3. **Key Files** — `path/to/file.ts:line` with role description for each
4. **Root Cause Analysis**
   - What's Happening — detailed explanation
   - Why It's Happening — underlying cause
   - Code Evidence — code block with `file:line` reference
5. **Recommendations**
   - Immediate Fix — what should be done to fix this specific issue
   - Follow-up Improvements — related improvements worth considering
6. **Questions / Unknowns** — anything needing clarification

Always include file paths and line numbers. Every finding must relate to the reported problem.
FINDINGS_TMPL_EOF
    ln -sf "../FINDINGS_TEMPLATE.md" "$SESSION_DIR/repo/FINDINGS_TEMPLATE.md" 2>/dev/null || true
```

- [ ] **Step 3: Update Investigation CLAUDE.md to reference the template**

In the compressed Investigation CLAUDE.md heredoc (Task 4), find the "Write `FINDINGS.md` with these sections:" bullet inside the Investigation Steps. Replace the section list with:

```
4. Write `FINDINGS.md` following the format in `FINDINGS_TEMPLATE.md`.
```

- [ ] **Step 4: Pass "development" type for dev sessions**

Find `setup_output_files "$SESSION_DIR"` inside `create_dev_session()`. Change to:

```bash
setup_output_files "$SESSION_DIR" "development"
```

- [ ] **Step 5: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 10: Update Python server — permissions + fix_finding() scoped write

**File:** `bin/cgremlin` — Python server section (~lines 4937–4965 and ~5493–5574)

The Python server has its own `settings.local.json` generation (identical to bash). It also has `fix_finding()` which needs to write fix-scoped permissions before launching Claude.

- [ ] **Step 1: Update the Python `setup_output_files` permissions block (~lines 4941–4959)**

Find the Python `settings` dict that builds the permissions. It looks like:
```python
settings = {
    "permissions": {
        "allow": [
            "Bash(git status *)",
            ...
            f"Write({session_abs}/**)",
            f"Edit({session_abs}/**)"
        ],
        "deny": []
    }
}
```

Replace the entire `settings` dict with:

```python
settings = {
    "permissions": {
        "allow": [
            "Read(*)",
            "Bash(git status *)",
            "Bash(git log *)",
            "Bash(git diff *)",
            "Bash(git show *)",
            "Bash(git branch *)",
            "Bash(git rev-parse *)",
            "Bash(ls *)",
            "Bash(cat *)",
            "Bash(head *)",
            "Bash(tail *)",
            "Bash(find *)",
            "Bash(wc *)",
            "Bash(grep *)",
            "Bash(rg *)",
            "Bash(gh pr view *)",
            "Bash(gh pr diff *)",
            f"Write({session_abs}/**)",
            f"Edit({session_abs}/**)",
        ],
        "deny": []
    }
}
```

(This is the base set for review/investigation sessions created via the Python server. Fix sessions get further permissions in the next step.)

- [ ] **Step 2: Add fix-scoped permissions write inside `fix_finding()` before Claude launch**

Find `fix_finding()` in the Python server (around line ~5493). It builds `claude_cmd` and launches Claude. Before the `claude_cmd` construction, add:

```python
            # Write fix-scoped permissions (repo-wide write + test runners)
            import json as _fix_json
            session_abs = str(session_path.resolve())
            repo_abs = str(repo_path.resolve())
            fix_settings = {
                "permissions": {
                    "allow": [
                        "Read(*)",
                        "Bash(git status *)",
                        "Bash(git log *)",
                        "Bash(git diff *)",
                        "Bash(git show *)",
                        "Bash(git branch *)",
                        "Bash(git rev-parse *)",
                        "Bash(ls *)",
                        "Bash(cat *)",
                        "Bash(head *)",
                        "Bash(tail *)",
                        "Bash(find *)",
                        "Bash(wc *)",
                        "Bash(grep *)",
                        "Bash(rg *)",
                        "Bash(gh pr view *)",
                        "Bash(gh pr diff *)",
                        "Bash(npm test *)",
                        "Bash(npm run *)",
                        f"Write({session_abs}/**)",
                        f"Edit({session_abs}/**)",
                        f"Write({repo_abs}/**)",
                        f"Edit({repo_abs}/**)",
                    ],
                    "deny": []
                }
            }
            claude_dir = repo_path / '.claude'
            claude_dir.mkdir(exist_ok=True)
            (claude_dir / 'settings.local.json').write_text(_fix_json.dumps(fix_settings, indent=2) + '\n')
```

The `session_abs` assignment is included at the top of the code block above.

- [ ] **Step 3: Verify Python syntax**

```bash
python3 - << 'EOF'
import re, ast, sys
src = open('bin/cgremlin').read()
m = re.search(r"cat << 'PYSERVER_EOF'\n(.+?)\nPYSERVER_EOF", src, re.DOTALL)
if not m:
    print("ERROR: Could not find PYSERVER heredoc")
    sys.exit(1)
ast.parse(m.group(1))
print("Python syntax OK ✓")
EOF
```

- [ ] **Step 4: Verify bash syntax**

```bash
bash -n bin/cgremlin && echo "OK"
```

---

### Task 11: Phase 2 verification checkpoint

- [ ] **Step 1: Verify REVIEW_TEMPLATE.md is written on session creation**

Create a test review session via the CLI (or check the bash function directly):

```bash
# Inspect the function to confirm the writes are present
grep -n "REVIEW_TEMPLATE\|FINDINGS_TEMPLATE" bin/cgremlin
```

Expected: at least 4 hits — write + symlink for review, write + symlink for investigation.

- [ ] **Step 2: Verify settings.local.json includes Read(*) and grep**

```bash
grep -n '"Read(\*)"' bin/cgremlin
grep -n '"Bash(grep \*)"' bin/cgremlin
```

Expected: at least 2 hits each (bash block + Python block).

- [ ] **Step 3: Verify fix_finding() writes its own permissions**

```bash
grep -n "fix_settings\|fix-scoped" bin/cgremlin
```

Expected: the new block is present in the Python section.

- [ ] **Step 4: Show the full diff for user review**

```bash
git diff bin/cgremlin
```

**STOP HERE.** Present the diff to the user. Wait for explicit approval before any commit.

---

## Final Notes

- The legacy callback path templates (lines ~326–460: `REVIEW_TEMPLATE`, `DEV_TEMPLATE`, `INV_TEMPLATE`) are intentionally unchanged — they are compact and serve a different code path.
- Development CLAUDE.md (lines ~2791–2839) is intentionally unchanged — it is already compact.
- Fix-all and fix-single user prompts (Python ~5533–5569) are intentionally unchanged — already well-written.
- ACR and re-review prompts are intentionally unchanged.
- No commits until user has reviewed and tested locally.
