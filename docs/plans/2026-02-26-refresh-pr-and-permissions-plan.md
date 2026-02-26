# Refresh PR Reliability + Session Permissions — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Refresh PR reliably fetch latest code, protect session files from git operations, and eliminate permission prompts for research tools.

**Architecture:** Move all session context files (CLAUDE.md, REVIEW.md, FINDINGS.md) to the session root with symlinks into repo/. Replace fragile branch-swap git flow with fetch+reset. Add `.claude/settings.local.json` with pre-allowed research tools to both bash and Python paths.

**Tech Stack:** Bash, Python (embedded in sandbox), git

**Design doc:** `docs/plans/2026-02-26-refresh-pr-and-permissions-design.md`

---

### Task 1: Move CLAUDE.md to session root — bash `generate_claude_md()`

**Files:**
- Modify: `sandbox:314-320` — `generate_claude_md()` function

The function currently writes to `$repo_dir/CLAUDE.md`. Change it to write to `$session_dir/CLAUDE.md` and create a symlink. The symlink creation itself will be handled by `setup_output_files()` (Task 2), but `generate_claude_md` must write to the right place.

**Step 1: Change the target path**

In `sandbox` at line 320, change:
```bash
    local claude_md="$repo_dir/CLAUDE.md"
```
to:
```bash
    local claude_md="$session_dir/CLAUDE.md"
```

**Step 2: Also fix the 3 inline `cat > repo/CLAUDE.md` calls**

These are at lines ~1742, ~2316, ~2751 inside `create_pr_review_session()`, `create_investigation_session()`, and `create_development_session()`. Each writes `cat > repo/CLAUDE.md`. Change to `cat > CLAUDE.md` (these run with cwd = `$SESSION_DIR`).

Check: At line 1742, the cwd is `$SESSION_DIR` (set earlier by `cd "$SESSION_DIR"`). Verify this for all three. If cwd is not session dir, use `"$SESSION_DIR/CLAUDE.md"`.

**Step 3: Add symlink creation after each `cat > CLAUDE.md`**

After each `cat > CLAUDE.md`, add:
```bash
    ln -sf "../CLAUDE.md" "$SESSION_DIR/repo/CLAUDE.md"
```

But actually this will be handled by `setup_output_files` which is called after session creation. So only add the symlink if `setup_output_files` is NOT called afterwards. Check each call site.

**Step 4: Commit**

```bash
git add sandbox
git commit -m "Move CLAUDE.md to session root in bash session creation"
```

---

### Task 2: Add CLAUDE.md to bash `setup_output_files()`

**Files:**
- Modify: `sandbox:1084-1120` — bash `setup_output_files()` function

**Step 1: Add CLAUDE.md to the move-if-real-file block**

After line 1097 (the FINDINGS.md move), add:
```bash
        [ -f "$SESSION_DIR/repo/CLAUDE.md" ] && [ ! -L "$SESSION_DIR/repo/CLAUDE.md" ] && \
            mv "$SESSION_DIR/repo/CLAUDE.md" "$SESSION_DIR/CLAUDE.md"
```

**Step 2: Add CLAUDE.md to the symlink creation**

At line 1100, change:
```bash
        rm -f "$SESSION_DIR/repo/REVIEW.md" "$SESSION_DIR/repo/FINDINGS.md"
        ln -sf "../REVIEW.md" "$SESSION_DIR/repo/REVIEW.md"
        ln -sf "../FINDINGS.md" "$SESSION_DIR/repo/FINDINGS.md"
```
to:
```bash
        rm -f "$SESSION_DIR/repo/REVIEW.md" "$SESSION_DIR/repo/FINDINGS.md" "$SESSION_DIR/repo/CLAUDE.md"
        ln -sf "../REVIEW.md" "$SESSION_DIR/repo/REVIEW.md"
        ln -sf "../FINDINGS.md" "$SESSION_DIR/repo/FINDINGS.md"
        ln -sf "../CLAUDE.md" "$SESSION_DIR/repo/CLAUDE.md"
```

**Step 3: Commit**

```bash
git add sandbox
git commit -m "Add CLAUDE.md to bash setup_output_files symlink management"
```

---

### Task 3: Add CLAUDE.md to Python `setup_output_files()` + add settings.local.json + research tools

**Files:**
- Modify: `sandbox:4694-4721` — Python `setup_output_files()` method
- Modify: `.dashboard_server.py:405-431` — same method (mirror)

**Step 1: Add CLAUDE.md to the file list**

In both files, change:
```python
        for filename in ('REVIEW.md', 'FINDINGS.md'):
```
to:
```python
        for filename in ('REVIEW.md', 'FINDINGS.md', 'CLAUDE.md'):
```

**Step 2: Add settings.local.json creation**

After the `for` loop (after the last `repo_file.symlink_to(...)` line), add:

```python
        # Configure Claude permissions: allow research tools + session file writes
        claude_dir = repo_path / '.claude'
        claude_dir.mkdir(exist_ok=True)
        session_abs = str(session_path.resolve())
        settings = {
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
                    f"Write({session_abs}/**)",
                    f"Edit({session_abs}/**)"
                ],
                "deny": []
            }
        }
        import json as _json
        (claude_dir / 'settings.local.json').write_text(_json.dumps(settings, indent=2) + '\n')
```

**Step 3: Apply identical change to `.dashboard_server.py`**

Same code in `.dashboard_server.py`'s `setup_output_files()`.

**Step 4: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "Add CLAUDE.md symlink and settings.local.json to Python setup_output_files"
```

---

### Task 4: Update bash `settings.local.json` template with research tools

**Files:**
- Modify: `sandbox:1104-1118` — bash settings.local.json heredoc

**Step 1: Replace the permissions block**

Change lines 1106-1118 from:
```bash
        cat > "$SESSION_DIR/repo/.claude/settings.local.json" << CLAUDE_SETTINGS
{
  "permissions": {
    "allow": [
      "Read(**)",
      "Edit(**)",
      "Write($SESSION_DIR/**)",
      "Write($SESSION_DIR/repo/**)"
    ],
    "deny": []
  }
}
CLAUDE_SETTINGS
```
to:
```bash
        cat > "$SESSION_DIR/repo/.claude/settings.local.json" << CLAUDE_SETTINGS
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
      "Write($SESSION_DIR/**)",
      "Edit($SESSION_DIR/**)"
    ],
    "deny": []
  }
}
CLAUDE_SETTINGS
```

**Step 2: Commit**

```bash
git add sandbox
git commit -m "Update bash settings.local.json with research tool permissions"
```

---

### Task 5: Replace git branch gymnastics in Python `refresh_pr()`

**Files:**
- Modify: `sandbox:5597-5650` — Python `refresh_pr()` git operations
- Modify: `.dashboard_server.py` — same method (mirror)

**Step 1: Replace the fetch command**

Change (sandbox ~line 5599):
```python
            fetch_result = subprocess.run(
                ['git', 'fetch', 'origin', f'pull/{pr_number}/head:pr-{pr_number}-new'],
                cwd=str(repo_path), capture_output=True, text=True
            )
```
to:
```python
            fetch_result = subprocess.run(
                ['git', 'fetch', 'origin', f'pull/{pr_number}/head'],
                cwd=str(repo_path), capture_output=True, text=True
            )
```

**Step 2: Replace new_commit rev-parse**

Change (sandbox ~line 5607):
```python
            new_commit = subprocess.run(
                ['git', 'rev-parse', f'pr-{pr_number}-new'],
                cwd=str(repo_path), capture_output=True, text=True
            ).stdout.strip()
```
to:
```python
            new_commit = subprocess.run(
                ['git', 'rev-parse', 'FETCH_HEAD'],
                cwd=str(repo_path), capture_output=True, text=True
            ).stdout.strip()
```

**Step 3: Replace the "no change" cleanup (delete temp branch)**

The blocks at ~line 5615 and ~5630 that do `git branch -D pr-{pr_number}-new` — these can simply be removed since there's no temp branch to clean up anymore. The `FETCH_HEAD` ref is ephemeral and needs no cleanup.

**Step 4: Replace checkout + branch delete + branch rename**

Change (sandbox ~line 5644-5650):
```python
                # Checkout new branch, replace old
                subprocess.run(['git', 'checkout', f'pr-{pr_number}-new'],
                               cwd=str(repo_path), capture_output=True, text=True)
                subprocess.run(['git', 'branch', '-D', f'pr-{pr_number}'],
                               cwd=str(repo_path), capture_output=True, text=True)
                subprocess.run(['git', 'branch', '-m', f'pr-{pr_number}'],
                               cwd=str(repo_path), capture_output=True, text=True)
```
to:
```python
                # Reset to latest PR code
                reset_result = subprocess.run(
                    ['git', 'reset', '--hard', 'FETCH_HEAD'],
                    cwd=str(repo_path), capture_output=True, text=True
                )
                if reset_result.returncode != 0:
                    self.send_error(500, f'Git reset failed: {reset_result.stderr.strip()}')
                    return

                # Re-create session file symlinks (reset may have removed them)
                self.setup_output_files(session_path)
```

**Step 5: Update the diff stats command**

Change (sandbox ~line 5653):
```python
                changes_since = subprocess.run(
                    ['git', 'diff', '--stat', f'{old_commit}...pr-{pr_number}'],
                    ...
```
to:
```python
                changes_since = subprocess.run(
                    ['git', 'diff', '--stat', f'{old_commit}...HEAD'],
                    ...
```

**Step 6: Apply identical changes to `.dashboard_server.py`**

Mirror all changes in `.dashboard_server.py`'s `refresh_pr()`.

**Step 7: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "Replace branch gymnastics with git fetch + reset --hard in refresh_pr"
```

---

### Task 6: Replace git branch gymnastics in bash `refresh_pr_session()`

**Files:**
- Modify: `sandbox:9944-9972` — bash `refresh_pr_session()` git operations

**Step 1: Replace the fetch command**

Change (sandbox ~line 9944):
```bash
        bash -c "git fetch origin 'pull/$PR_NUMBER/head:pr-$PR_NUMBER-new' 2>&1"
```
to:
```bash
        bash -c "git fetch origin 'pull/$PR_NUMBER/head' 2>&1"
```

**Step 2: Replace rev-parse**

Change (sandbox ~line 9946):
```bash
    local NEW_COMMIT=$(git rev-parse "pr-$PR_NUMBER-new" 2>/dev/null)
```
to:
```bash
    local NEW_COMMIT=$(git rev-parse "FETCH_HEAD" 2>/dev/null)
```

**Step 3: Replace checkout + branch delete + branch rename**

Change (sandbox ~line 9970-9972):
```bash
    git checkout "pr-$PR_NUMBER-new" 2>/dev/null
    git branch -D "pr-$PR_NUMBER" 2>/dev/null
    git branch -m "pr-$PR_NUMBER" 2>/dev/null
```
to:
```bash
    git reset --hard FETCH_HEAD 2>/dev/null
    if [ $? -ne 0 ]; then
        error "Git reset failed"
        return 1
    fi
    # Re-create session file symlinks after reset
    setup_output_files "$SESSION_DIR"
```

**Step 4: Remove any temp branch cleanup (`git branch -D pr-N-new`)**

Search for other `pr-$PR_NUMBER-new` references in `refresh_pr_session()` and remove them — there are no temp branches to clean up now.

**Step 5: Update diff stats**

Change any `git diff --stat ... pr-$PR_NUMBER` to `git diff --stat ... HEAD`.

**Step 6: Commit**

```bash
git add sandbox
git commit -m "Replace branch gymnastics with git fetch + reset --hard in bash refresh_pr_session"
```

---

### Task 7: Verify all changes

**Step 1: Syntax check both files**

```bash
python3 -c "import ast; ast.parse(open('.dashboard_server.py').read()); print('OK')"
bash -n sandbox && echo "OK"
```

**Step 2: Check an existing session to verify symlink expectations**

```bash
ls -la pr-grace-frontend-*/repo/CLAUDE.md  # should show symlink after next session creation
```

**Step 3: Final commit if any fixups needed**

```bash
git add sandbox .dashboard_server.py
git commit -m "Fix any issues found during verification"
```
