# cgremlin Homebrew Distribution — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing `sandbox` bash script as `cgremlin`, distributed via Homebrew tap, with configurable sessions directory.

**Architecture:** Rename the single-file bash script, update all internal references (paths, env vars, UI strings), set up repo structure with .gitignore and README, push to GitHub, create Homebrew tap.

**Tech Stack:** Bash, embedded Python, Homebrew formula (Ruby), GitHub CLI

**Spec:** `docs/superpowers/specs/2026-03-16-cgremlin-distribution-design.md`

---

## Chunk 1: Repo Cleanup and Script Rename

### Task 1: Create .gitignore and commit deleted plan docs

**Files:**
- Create: `.gitignore`
- Remove: `docs/plans/` (5 already-deleted files)

- [ ] **Step 1: Create `.gitignore`**

```
# Runtime artifacts
.DS_Store
*.log
*.png

# Session directories (never committed)
pr-*/
inv-*/
dev-*/

# Generated files
.dashboard_server.py
.dashboard_new.html
.dashboard.log

# IDE / tool
.playwright-mcp/
.claude/
```

- [ ] **Step 2: Stage and commit**

```bash
git add .gitignore
git rm docs/plans/2026-02-25-session-color-coding-design.md
git rm docs/plans/2026-02-26-refresh-pr-and-permissions-design.md
git rm docs/plans/2026-02-26-refresh-pr-and-permissions-plan.md
git rm docs/plans/2026-02-27-dev-mode-fix-flows-design.md
git rm docs/plans/2026-02-27-dev-mode-fix-flows-plan.md
git commit -m "chore: add .gitignore and remove stale plan docs"
```

### Task 2: Copy sandbox to bin/cgremlin

**Files:**
- Create: `bin/cgremlin` (copy of `sandbox`)
- Delete: `sandbox` (tracked file)

- [ ] **Step 1: Create bin/ and copy**

```bash
mkdir -p bin
cp sandbox bin/cgremlin
chmod +x bin/cgremlin
```

- [ ] **Step 2: Verify syntax**

```bash
bash -n bin/cgremlin
```
Expected: no output (success)

- [ ] **Step 3: Stage and commit**

```bash
git rm sandbox
git add bin/cgremlin
git commit -m "chore: rename sandbox to bin/cgremlin"
```

### Task 3: Update banner and branding strings

**Files:**
- Modify: `bin/cgremlin`

All references to "sandbox" or "SANDBOX" that are user-visible branding or comments. **Do NOT touch** the `SANDBOX_*` env vars or `.sandbox` config paths yet — those are separate tasks.

- [ ] **Step 1: Update ASCII banner (line 3-6)**

Change:
```bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                              SANDBOX                                       ║
# ║         Isolated environments for PR reviews & code investigations         ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
```
To:
```bash
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                            CONTEXT GREMLIN                                 ║
# ║         Isolated environments for PR reviews & code investigations         ║
# ╚═══════════════════════════════════════════════════════════════════════════╝
```

- [ ] **Step 2: Update show_banner() UI string (line 1062)**

Change `"🧪 SANDBOX"` to `"🧪 CONTEXT GREMLIN"` (or whatever the banner function prints — find the exact string and update).

- [ ] **Step 3: Update fzf header (line 11452)**

Change `--header="Configure sandbox settings"` to `--header="Configure cgremlin settings"`.

- [ ] **Step 4: Update config file comment (line 57)**

Change `# Sandbox Configuration` to `# cgremlin Configuration`.

- [ ] **Step 5: Update config comment (line 63)**

Change `# Auto-start dashboard when sandbox launches` to `# Auto-start dashboard when cgremlin launches`.

- [ ] **Step 6: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 7: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: update branding from sandbox to cgremlin"
```

---

## Chunk 2: Path and Config Migrations

### Task 4: Update SESSIONS_DIR to be configurable

**Files:**
- Modify: `bin/cgremlin:8` (SESSIONS_DIR assignment)
- Modify: `bin/cgremlin:29-50` (load_config function)

- [ ] **Step 1: Change the default SESSIONS_DIR (line 8)**

Change:
```bash
SESSIONS_DIR="$HOME/Agent-temp"
```
To:
```bash
SESSIONS_DIR="${CGREMLIN_SESSIONS_DIR:-}"
```

The final default will be applied after config loading (step 3).

- [ ] **Step 2: Add SESSIONS_DIR case to load_config() (line 46)**

In the `case` block inside `load_config()` (around line 46), add a new branch:

```bash
            case "$key" in
                MODEL) MODEL="$value" ;;
                DASHBOARD_AUTO_START) DASHBOARD_AUTO_START="$value" ;;
                DEFAULT_PROJECT) DEFAULT_PROJECT="$value" ;;
                SESSIONS_DIR) [ -z "$CGREMLIN_SESSIONS_DIR" ] && SESSIONS_DIR="$value" ;;
            esac
```

The `[ -z "$CGREMLIN_SESSIONS_DIR" ]` check ensures env var takes priority over config file.

- [ ] **Step 3: Apply default after config loading**

Right after the `load_config` call (currently at line 73), add:

```bash
load_config

# Apply sessions directory default (env var > config file > default)
SESSIONS_DIR="${SESSIONS_DIR:-$HOME/.cgremlin/sessions}"
mkdir -p "$SESSIONS_DIR"
```

Remove the old `mkdir -p "$SESSIONS_DIR"` from line 9.

- [ ] **Step 4: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: make SESSIONS_DIR configurable with ~/.cgremlin/sessions default"
```

### Task 5: Move CONFIG_DIR from ~/.sandbox to ~/.cgremlin

**Files:**
- Modify: `bin/cgremlin:15-16`

- [ ] **Step 1: Update CONFIG_DIR and CONFIG_FILE (lines 15-16)**

Change:
```bash
CONFIG_DIR="$HOME/.sandbox"
CONFIG_FILE="$CONFIG_DIR/config"
```
To:
```bash
CONFIG_DIR="$HOME/.cgremlin"
CONFIG_FILE="$CONFIG_DIR/config"
```

- [ ] **Step 2: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 3: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: move config dir from ~/.sandbox to ~/.cgremlin"
```

### Task 6: Move Jira config from ~/.config/sandbox to ~/.config/cgremlin

**Files:**
- Modify: `bin/cgremlin` — lines 87, 89, 516, 599

- [ ] **Step 1: Update Jira config path references**

Line 87 — change:
```bash
if [ -f "$HOME/.config/sandbox/jira.conf" ]; then
```
To:
```bash
if [ -f "$HOME/.config/cgremlin/jira.conf" ]; then
```

Line 89 — change:
```bash
    eval "$(grep '^JIRA_DOMAIN=' "$HOME/.config/sandbox/jira.conf")" 2>/dev/null && _jira_domain="$JIRA_DOMAIN"
```
To:
```bash
    eval "$(grep '^JIRA_DOMAIN=' "$HOME/.config/cgremlin/jira.conf")" 2>/dev/null && _jira_domain="$JIRA_DOMAIN"
```

Line 516 — change:
```bash
JIRA_CONFIG="$HOME/.config/sandbox/jira.conf"
```
To:
```bash
JIRA_CONFIG="$HOME/.config/cgremlin/jira.conf"
```

Line 599 — change:
```bash
        success "Credentials saved to ~/.config/sandbox/jira.conf"
```
To:
```bash
        success "Credentials saved to ~/.config/cgremlin/jira.conf"
```

- [ ] **Step 2: Update save_jira_config() mkdir**

Inside `save_jira_config()` (around line 524), ensure the `mkdir -p` creates `~/.config/cgremlin` instead of `~/.config/sandbox`. Find the `mkdir` line and update accordingly.

- [ ] **Step 3: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: move Jira config from ~/.config/sandbox to ~/.config/cgremlin"
```

### Task 7: Move PID file to ~/.cgremlin/dashboard.pid

**Files:**
- Modify: `bin/cgremlin:4250`

- [ ] **Step 1: Update DASHBOARD_PID_FILE (line 4250)**

Change:
```bash
DASHBOARD_PID_FILE="$HOME/.sandbox_dashboard_pid"
```
To:
```bash
DASHBOARD_PID_FILE="$HOME/.cgremlin/dashboard.pid"
```

No `mkdir` needed — `$CONFIG_DIR` (`~/.cgremlin`) is already created by `load_config()`.

- [ ] **Step 2: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 3: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: move dashboard PID file to ~/.cgremlin/dashboard.pid"
```

---

## Chunk 3: Python Heredoc Updates

### Task 8: Update Python server callback to find cgremlin

**Files:**
- Modify: `bin/cgremlin` — inside the Python heredoc, lines ~6238-6244

- [ ] **Step 1: Update the create_new_session callback**

Find the section inside the heredoc (around line 6238):
```python
            # Find the sandbox script - it's in the same directory as this server script
            sandbox_path = Path(SESSIONS_DIR) / 'sandbox'
            if not sandbox_path.exists():
                sandbox_path = Path(__file__).parent / 'sandbox'

            result = subprocess.run(
                [str(sandbox_path), '--create-session'],
```

Replace with:
```python
            # Find the cgremlin script
            import shutil
            cgremlin_path = os.environ.get('CGREMLIN_SCRIPT_PATH') or shutil.which('cgremlin')
            if not cgremlin_path:
                cgremlin_path = Path(SESSIONS_DIR) / 'cgremlin'
            if not Path(cgremlin_path).exists():
                cgremlin_path = Path(__file__).parent / 'cgremlin'

            result = subprocess.run(
                [str(cgremlin_path), '--create-session'],
```

- [ ] **Step 2: Update the docstring (line 6209)**

Change:
```python
        """Create a new session via the sandbox script"""
```
To:
```python
        """Create a new session via the cgremlin script"""
```

- [ ] **Step 3: Update the comment (line 6229)**

Change:
```python
            # Build command to run sandbox in non-interactive mode
```
To:
```python
            # Build command to run cgremlin in non-interactive mode
```

- [ ] **Step 4: Verify syntax (both bash and embedded Python)**

```bash
bash -n bin/cgremlin
```

Then extract and check Python syntax:
```bash
python3 -c "
import ast
with open('bin/cgremlin') as f:
    lines = f.readlines()
in_py = False
py_lines = []
for line in lines:
    if \"<< 'PYSERVER'\" in line:
        in_py = True
        continue
    if line.strip() == 'PYSERVER':
        in_py = False
        continue
    if in_py:
        py_lines.append(line)
ast.parse(''.join(py_lines))
print('Python syntax OK')
"
```

- [ ] **Step 5: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: update Python server to find cgremlin via PATH and env var"
```

### Task 9: Rename SANDBOX_* env vars to CGREMLIN_*

**Files:**
- Modify: `bin/cgremlin` — Python heredoc lines 6231-6236 AND bash handler lines 11929-11947

- [ ] **Step 1: Update Python heredoc env var names (lines 6231-6236)**

Change:
```python
            env['SANDBOX_MODE'] = mode
            env['SANDBOX_URL'] = url
```
and:
```python
                env['SANDBOX_JIRA'] = jira
```
and:
```python
                env['SANDBOX_FOCUS'] = focus
```

To:
```python
            env['CGREMLIN_MODE'] = mode
            env['CGREMLIN_URL'] = url
```
and:
```python
                env['CGREMLIN_JIRA'] = jira
```
and:
```python
                env['CGREMLIN_FOCUS'] = focus
```

- [ ] **Step 2: Update bash --create-session handler (lines 11929-11947)**

Change:
```bash
if [ "$1" = "--create-session" ]; then
    case "$SANDBOX_MODE" in
        review)
            create_pr_session_noninteractive "$SANDBOX_URL" "$SANDBOX_JIRA"
            ;;
        investigation)
            create_investigation_session_noninteractive "$SANDBOX_URL" "$SANDBOX_FOCUS" "$SANDBOX_JIRA"
            ;;
        development)
            create_development_session_noninteractive "$SANDBOX_URL" "$SANDBOX_JIRA"
            ;;
        *)
            echo "ERROR: Unknown mode $SANDBOX_MODE" >&2
            exit 1
            ;;
    esac
    exit 0
fi
```

To:
```bash
if [ "$1" = "--create-session" ]; then
    case "$CGREMLIN_MODE" in
        review)
            create_pr_session_noninteractive "$CGREMLIN_URL" "$CGREMLIN_JIRA"
            ;;
        investigation)
            create_investigation_session_noninteractive "$CGREMLIN_URL" "$CGREMLIN_FOCUS" "$CGREMLIN_JIRA"
            ;;
        development)
            create_development_session_noninteractive "$CGREMLIN_URL" "$CGREMLIN_JIRA"
            ;;
        *)
            echo "ERROR: Unknown mode $CGREMLIN_MODE" >&2
            exit 1
            ;;
    esac
    exit 0
fi
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: rename SANDBOX_* env vars to CGREMLIN_*"
```

### Task 10: Update Python config path references and UI text

**Files:**
- Modify: `bin/cgremlin` — Python heredoc lines 6328, 6523, 7023, 7889, 9443

- [ ] **Step 1: Update projects.json path (line 6328)**

Change:
```python
            projects_config = Path.home() / '.sandbox' / 'projects.json'
```
To:
```python
            projects_config = Path.home() / '.cgremlin' / 'projects.json'
```

- [ ] **Step 2: Update config.json path (line 6523)**

Change:
```python
        config_path = Path.home() / '.sandbox' / 'config.json'
```
To:
```python
        config_path = Path.home() / '.cgremlin' / 'config.json'
```

- [ ] **Step 3: Update HTML title (line 7023)**

Change:
```html
    <title>Sandbox Dashboard</title>
```
To:
```html
    <title>Context Gremlin</title>
```

- [ ] **Step 4: Update logo text (line 7889)**

Change:
```html
            <div class="logo">Sandbox</div>
```
To:
```html
            <div class="logo">Context Gremlin</div>
```

- [ ] **Step 5: Update projects.json UI help text (line 9443)**

Find the string referencing `~/.sandbox/projects.json` and change to `~/.cgremlin/projects.json`.

- [ ] **Step 6: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 7: Commit**

```bash
git add bin/cgremlin
git commit -m "chore: update Python config paths and UI text to cgremlin"
```

### Task 11: Pass CGREMLIN_SCRIPT_PATH when launching the Python server

**Files:**
- Modify: `bin/cgremlin` — `start_dashboard_server()` function, around line 4262

- [ ] **Step 1: Set env var before launching python3**

Find the line that launches the server (around line 4262):
```bash
    nohup python3 "$server_script" > "$SESSIONS_DIR/.dashboard.log" 2>&1 &
```

Change to:
```bash
    CGREMLIN_SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" \
        nohup python3 "$server_script" > "$SESSIONS_DIR/.dashboard.log" 2>&1 &
```

This passes the absolute path of the running script to the Python server via environment variable.

- [ ] **Step 2: Verify syntax**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 3: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: pass CGREMLIN_SCRIPT_PATH to dashboard server on launch"
```

---

## Chunk 4: Full Sweep, README, and Repo Setup

### Task 12: Final sweep for any remaining "sandbox" references

**Files:**
- Modify: `bin/cgremlin`

- [ ] **Step 1: Search for any remaining "sandbox" references**

```bash
grep -n -i "sandbox" bin/cgremlin | head -50
```

Review every match. Some will be legitimate (e.g., inside session names like `pr-grace-*` which don't reference the tool name). Fix any remaining tool-name references that were missed in previous tasks.

Common places to check:
- Comments mentioning "sandbox" as the tool name
- Log messages
- Error messages
- Variable names containing "sandbox"

- [ ] **Step 2: Verify syntax after all changes**

```bash
bash -n bin/cgremlin
```

- [ ] **Step 3: Commit if changes were made**

```bash
git add bin/cgremlin
git commit -m "chore: final sweep replacing remaining sandbox references"
```

### Task 13: Create README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Create `README.md` with the following content:

~~~markdown
# Context Gremlin

Agentic code review and investigation sessions powered by AI. Launch isolated environments for PR reviews, code investigations, and development — with a web dashboard for managing sessions.

## Install

```bash
brew tap guilleazoubel/cgremlin
brew install cgremlin
```

You also need [Claude Code](https://docs.anthropic.com/en/docs/claude-code):

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

## Usage

```bash
cgremlin
```

This launches the interactive TUI. From there you can:
- **Review PRs** — clone, review with AI, post findings
- **Investigate code** — explore repos with AI assistance
- **Develop features** — isolated dev sessions with AI pair programming

A web dashboard starts automatically at `http://localhost:8765`.

## Configuration

Config file: `~/.cgremlin/config`

```
MODEL=sonnet
DASHBOARD_AUTO_START=true
SESSIONS_DIR=/path/to/custom/sessions
```

Or override the sessions directory via environment variable:

```bash
export CGREMLIN_SESSIONS_DIR=/path/to/sessions
```

Default sessions directory: `~/.cgremlin/sessions`

## Dependencies

Installed automatically by Homebrew: `gum`, `fzf`, `gh`, `jq`, `python3`

Required separately: `claude` (Claude Code CLI)

Optional: `acr`, `codex`, `delta`, `glow`

## Requirements

- macOS (uses iTerm2 + AppleScript)
- GitHub CLI authenticated (`gh auth login`)

## License

MIT
~~~

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install and usage instructions"
```

### Task 14: Create CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

Create `CLAUDE.md` with the following content:

```markdown
# Context Gremlin (cgremlin)

## Project Structure
- `bin/cgremlin` — single bash script (~450KB) containing the CLI, TUI, and an embedded Python HTTP dashboard server (~5200 lines as a heredoc)
- The Python server is written to `$SESSIONS_DIR/.dashboard_server.py` on every launch

## Key Conventions
- The bash script and embedded Python server must stay in sync — they share the same file
- After any edit, verify with: `bash -n bin/cgremlin`
- Python syntax check: extract the PYSERVER heredoc and run `ast.parse()`
- Config lives in `~/.cgremlin/`, sessions in `~/.cgremlin/sessions` (configurable)
- The Python server calls back to `cgremlin --create-session` for session creation
- macOS only — uses osascript and iTerm2 AppleScript
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with project conventions"
```

### Task 15: Set up remote, rename branch, push

- [ ] **Step 1: Add the remote**

```bash
git remote add origin https://github.com/guilleazoubel/context-gremlin.git
```

- [ ] **Step 2: Rename master to main**

```bash
git branch -m master main
```

- [ ] **Step 3: Force push to set up main (the remote repo has LICENSE and README we'll overwrite)**

```bash
git push -u origin main --force
```

Note: This force push is expected — the remote only has an auto-generated LICENSE and empty README that we're replacing with the real content.

- [ ] **Step 4: Verify**

```bash
gh repo view guilleazoubel/context-gremlin --web
```

---

## Chunk 5: Homebrew Tap and Release

### Task 16: Create Homebrew tap repository

- [ ] **Step 1: Create the tap repo on GitHub**

```bash
gh repo create guilleazoubel/homebrew-cgremlin --public --description "Homebrew tap for cgremlin"
```

- [ ] **Step 2: Clone it locally**

```bash
git clone https://github.com/guilleazoubel/homebrew-cgremlin.git "$HOME/homebrew-cgremlin"
cd "$HOME/homebrew-cgremlin"
```

- [ ] **Step 3: Create the formula directory and file**

```bash
mkdir -p Formula
```

Create `Formula/cgremlin.rb` — the sha256 will be filled in after tagging (Task 17):

```ruby
class Cgremlin < Formula
  desc "Agentic code review and investigation sessions with AI"
  homepage "https://github.com/guilleazoubel/context-gremlin"
  url "https://github.com/guilleazoubel/context-gremlin/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "PLACEHOLDER"
  license "MIT"

  depends_on "gum"
  depends_on "fzf"
  depends_on "gh"
  depends_on "jq"
  depends_on "python@3.13"

  def install
    bin.install "bin/cgremlin"
  end

  def caveats
    <<~EOS
      cgremlin requires Claude Code CLI. Install it with:
        npm install -g @anthropic-ai/claude-code

      Then authenticate:
        claude auth login
    EOS
  end
end
```

- [ ] **Step 4: Commit but don't push yet** (sha256 needed first)

```bash
git add Formula/cgremlin.rb
git commit -m "Add cgremlin formula v0.1.0 (sha256 placeholder)"
```

### Task 17: Tag, release, and finalize formula

- [ ] **Step 1: Tag v0.1.0 in context-gremlin**

```bash
cd /Users/guilherme.azoubel/Agent-temp
git tag v0.1.0
git push origin v0.1.0
```

- [ ] **Step 2: Create GitHub Release**

```bash
gh release create v0.1.0 --title "v0.1.0" --notes "Initial release of cgremlin (Context Gremlin).

Install:
\`\`\`
brew tap guilleazoubel/cgremlin
brew install cgremlin
\`\`\`"
```

- [ ] **Step 3: Compute sha256**

```bash
curl -sL https://github.com/guilleazoubel/context-gremlin/archive/refs/tags/v0.1.0.tar.gz | shasum -a 256
```

- [ ] **Step 4: Update formula with real sha256**

```bash
cd "$HOME/homebrew-cgremlin"
```

Replace `PLACEHOLDER` in `Formula/cgremlin.rb` with the sha256 from step 3.

- [ ] **Step 5: Commit and push formula**

```bash
cd "$HOME/homebrew-cgremlin"
git add Formula/cgremlin.rb
git commit -m "Update cgremlin formula v0.1.0 with real sha256"
git push -u origin main
```

- [ ] **Step 6: Test the install**

```bash
brew tap guilleazoubel/cgremlin
brew install cgremlin
cgremlin --help || cgremlin
```

Verify the tool launches and the TUI appears.
