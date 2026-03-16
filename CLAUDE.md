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
