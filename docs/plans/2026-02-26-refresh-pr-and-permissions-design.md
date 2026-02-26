# Design: Refresh PR reliability + session file permissions

## Problems

### 1. Refresh PR doesn't pick up latest commits
The dashboard's "Refresh PR" button reports success but Claude reviews stale code. Root cause: the git checkout/branch operations after fetch don't check return codes. If any fail silently (dirty working tree, leftover temp branches), HEAD stays on old code.

### 2. CLAUDE.md lives inside repo/ and gets destroyed
`CLAUDE.md` is created as a real file in `repo/`. Unlike REVIEW.md and FINDINGS.md (which live in the session root with symlinks), CLAUDE.md is tracked by git (`M` status). Any `git reset --hard` or branch operation overwrites it with the PR's original version, destroying review instructions.

### 3. Permission prompts for session files
The Python `setup_output_files()` doesn't create `.claude/settings.local.json` — only the bash version does. Sessions launched from the dashboard (Python HTTP path) never get the permission config, so users get prompted to allow writes to REVIEW.md, FINDINGS.md, etc.

### 4. Research tool prompts slow down reviews
Claude gets prompted for read-only bash commands like `git log`, `git diff`, `ls` that are essential for investigation. These should be pre-allowed.

## Design

### Fix 1: Replace branch gymnastics with fetch + reset

**Current flow** (fragile, 4 git commands, no error checking):
```
git fetch origin pull/N/head:pr-N-new   # can fail if branch exists
git checkout pr-N-new                    # can fail silently
git branch -D pr-N                       # can fail silently
git branch -m pr-N                       # can fail silently
```

**New flow** (2 commands, error checked):
```
git fetch origin pull/N/head             # fetch into FETCH_HEAD
git reset --hard FETCH_HEAD              # move HEAD to latest
```

After reset, re-create symlinks for session files (CLAUDE.md, REVIEW.md, FINDINGS.md, PR_DISCUSSION.md) since reset may remove untracked symlinks or overwrite tracked files.

Check return codes after both commands — abort with error if either fails.

**Why this is safe:**
- REVIEW.md, FINDINGS.md, PR_DISCUSSION.md, ACR_REVIEW.md, session-info.txt, session.json all live in the session root (outside repo/). Confirmed on disk.
- CLAUDE.md will be moved to session root (Fix 2) before this matters.
- Symlinks in repo/ are untracked (`??` status) — `git reset --hard` leaves them alone. But we re-create them defensively anyway.

**Apply to:** Python `refresh_pr()` in both `sandbox` and `.dashboard_server.py`. Also update bash `refresh_pr_session()` for consistency.

### Fix 2: Move CLAUDE.md to session root

Same pattern as REVIEW.md/FINDINGS.md:
- Create CLAUDE.md in session root (`$SESSION_DIR/CLAUDE.md`)
- Symlink from `repo/CLAUDE.md` → `../CLAUDE.md`
- Add CLAUDE.md to `setup_output_files()` so it gets re-symlinked after any git operation

**Where to change:**
- Bash `generate_claude_md()` — write to `$SESSION_DIR/CLAUDE.md`, then symlink
- Bash `setup_output_files()` — add CLAUDE.md to the symlink list
- Python `setup_output_files()` — add CLAUDE.md to the symlink list
- Python refresh_pr re-review CLAUDE.md prepend — write to session root

### Fix 3: Add settings.local.json to Python setup_output_files()

Mirror what the bash version does at line 1106. Create `.claude/settings.local.json` inside `repo/` with permissions scoped to the session directory.

The bash version uses `$SESSION_DIR` which gets expanded by the heredoc. The Python version will use the resolved absolute path.

### Fix 4: Pre-allow research tools

Update the `settings.local.json` template in both bash and Python to include read-only bash commands:

```json
{
  "permissions": {
    "allow": [
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
      "Bash(gh pr view *)",
      "Bash(gh pr diff *)",
      "Write(SESSION_PATH/**)",
      "Edit(SESSION_PATH/**)"
    ],
    "deny": []
  }
}
```

Where `SESSION_PATH` is replaced with the actual absolute path at generation time.

## Files to modify

- `sandbox` — bash `setup_output_files()`, `generate_claude_md()`, `refresh_pr_session()`, Python `setup_output_files()`, `refresh_pr()`
- `.dashboard_server.py` — Python `setup_output_files()`, `refresh_pr()`

## What does NOT change

- Session data model / session.json
- How sessions are created (only how files are placed)
- API endpoints or response formats
- Dashboard UI
- Terminal.app fallback behavior

## Verification

1. Create a PR review session, verify CLAUDE.md is a symlink in repo/ pointing to session root
2. Hit Refresh PR with new commits pushed — verify Claude reviews the NEW code
3. Hit Refresh PR again — verify CLAUDE.md survives (symlink intact, content preserved)
4. Start Claude from dashboard — verify no permission prompts for `git log`, `git diff`, writing REVIEW.md
5. Check `.claude/settings.local.json` exists in repo/ with correct paths
