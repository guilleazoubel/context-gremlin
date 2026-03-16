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
