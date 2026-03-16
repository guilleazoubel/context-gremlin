# cgremlin — Homebrew Distribution Design

**Date:** 2026-03-16
**Status:** Approved
**Version:** v0.1.0 (initial release)

## Goal

Package the existing sandbox script as an installable CLI tool (`cgremlin`) distributed via Homebrew, so users can install and use it without cloning the repo.

## Background

The sandbox tool is a ~448KB bash script that creates isolated environments for AI-powered PR reviews and code investigations. It embeds a ~5,200-line Python HTTP dashboard server as a heredoc. Today it lives as a single file in `~/Agent-temp` with no distribution mechanism.

### Current Architecture

- `sandbox` (bash) — CLI entry point, TUI, session creation, embedded Python server
- `.dashboard_server.py` — generated artifact, overwritten from the heredoc on every startup
- The Python server calls back to `sandbox --create-session` for session creation
- macOS-only: uses `osascript`, iTerm2 AppleScript

### Dependencies

**Required (Homebrew-installable):** `gum`, `fzf`, `gh`, `jq`, `git`, `python3`

**Required (manual install):** `claude` (Claude Code CLI, installed via `npm install -g @anthropic-ai/claude-code`)

**Optional:** `acr`, `codex`, `delta`, `glow`, `code`/`cursor`

## Design

### Distribution Strategy

Single bash script distributed via a Homebrew custom tap. No compilation or build step — Homebrew copies the script to the user's PATH and installs dependencies.

### Repositories

| Repo | Purpose |
|---|---|
| `guilleazoubel/context-gremlin` | Source code — the script, README, docs |
| `guilleazoubel/homebrew-cgremlin` | Homebrew tap — contains the formula |

### Source Repo Structure (`context-gremlin`)

```
context-gremlin/
├── bin/
│   └── cgremlin              # the bash script (renamed from sandbox)
├── docs/
│   └── superpowers/
│       └── specs/            # design docs
├── .gitignore
├── README.md
├── LICENSE
└── CLAUDE.md
```

Only the script and documentation ship. Session directories, screenshots, logs, and other runtime artifacts do not belong in the repo.

### Script Changes

#### 1. Rename

`sandbox` becomes `cgremlin`. All internal self-references update accordingly.

#### 2. Sessions Directory

**Default:** `~/.cgremlin/sessions`

Resolution order (first wins):
1. `CGREMLIN_SESSIONS_DIR` environment variable
2. `sessions_dir` setting in `~/.cgremlin/config`
3. Default: `$HOME/.cgremlin/sessions`

#### 3. Config Directory

Moves from `~/.sandbox` to `~/.cgremlin`.

Files:
- `~/.cgremlin/config` — user settings (model, dashboard auto-start, default project, sessions_dir)
- `~/.cgremlin/projects.json` — saved project configurations

#### 4. Internal Self-References

The embedded Python server calls back to `sandbox --create-session`. This reference updates to find `cgremlin` (the running script's own path via `$0` or `command -v cgremlin`).

### Homebrew Formula

Lives in `guilleazoubel/homebrew-cgremlin` as `Formula/cgremlin.rb`:

```ruby
class Cgremlin < Formula
  desc "Agentic code review and investigation sessions with AI"
  homepage "https://github.com/guilleazoubel/context-gremlin"
  url "https://github.com/guilleazoubel/context-gremlin/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "<computed-after-tagging>"
  license "MIT"

  depends_on "gum"
  depends_on "fzf"
  depends_on "gh"
  depends_on "jq"
  depends_on "python@3"
  depends_on :macos

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

### Install Experience

```bash
# Install
brew tap guilleazoubel/cgremlin
brew install cgremlin

# Run
cgremlin
```

### Upgrade Experience

```bash
brew upgrade cgremlin
```

### Release Flow (v0.1.0 — manual)

1. Finalize changes in `context-gremlin` repo on `main` branch
2. `git tag v0.1.0 && git push origin main --tags`
3. Create GitHub Release from the tag
4. Compute sha256 of the release tarball
5. Create/update formula in `homebrew-cgremlin` with URL + sha256
6. Push formula to `homebrew-cgremlin` repo

Automation via GitHub Actions is out of scope for v0.1.0.

### Developer Workflow

The maintainer (you) clones `context-gremlin`, edits `bin/cgremlin`, and tests locally. To keep existing sessions in `~/Agent-temp`, set the config:

```
# ~/.cgremlin/config
sessions_dir=/Users/guilherme.azoubel/Agent-temp
```

Or via environment variable:

```bash
export CGREMLIN_SESSIONS_DIR="$HOME/Agent-temp"
```

### .gitignore

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
.dashboard.log

# IDE / tool
.playwright-mcp/
.claude/
```

## Out of Scope (Future Versions)

- Splitting the Python server out of the bash script
- GitHub Actions for automated releases / formula updates
- Linux support
- Multi-platform testing
- Homebrew core submission (vs. custom tap)

## Success Criteria

1. `brew tap guilleazoubel/cgremlin && brew install cgremlin` installs the tool and all Homebrew-available dependencies
2. `cgremlin` launches the TUI from any directory
3. Sessions are created in `~/.cgremlin/sessions` by default
4. `CGREMLIN_SESSIONS_DIR` and config file override the sessions directory
5. Existing sessions in `~/Agent-temp` are accessible by configuring the sessions directory
6. The maintainer can edit, commit, tag, and release new versions with minimal friction
