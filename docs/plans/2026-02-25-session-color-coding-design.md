# Session Color-Coding Design

## Goal

Each dashboard session gets a persistent color dot in the sidebar. When the dashboard spawns an iTerm2 tab (Start Claude, Refresh PR, etc.), that tab gets the same color so the user can visually link terminals to sessions.

## Color Palette

8 distinct colors, high-contrast on dark backgrounds:

| Index | Name   | Hex       |
|-------|--------|-----------|
| 0     | Rose   | `#e5484d` |
| 1     | Amber  | `#f0b429` |
| 2     | Green  | `#3dd68c` |
| 3     | Blue   | `#5b9ef0` |
| 4     | Purple | `#7c5cfc` |
| 5     | Pink   | `#e879a8` |
| 6     | Cyan   | `#7ee7fc` |
| 7     | Orange | `#f09858` |

## Color Assignment

Deterministic hash of session folder name mod 8. Same session always maps to the same color across page reloads and terminal spawns.

Hash function: simple djb2 (JS frontend) and equivalent in Python (backend).

## Dashboard Sidebar

- Add 8px colored circle to the left of each session title in `renderSessionItem()`
- Live sessions: keep green pulse animation but add colored ring/border around it
- Selected session: colored dot remains visible alongside the active highlight

## iTerm2 Tab Coloring

iTerm2 accepts tab color via escape sequences:
```
\033]6;1;bg;red;brightness;R\a
\033]6;1;bg;green;brightness;G\a
\033]6;1;bg;blue;brightness;B\a
```
R, G, B are 0-255 integers.

Inject color-setting command via `write text` immediately after creating the tab in all 3 terminal-spawning locations.

## Files to Modify

- `sandbox` (primary)
- `.dashboard_server.py` (mirror)

## Touch Points

### Backend (Python)
- Add `session_color(name)` utility: hash → palette hex
- Add `iterm_color_cmd(hex)` utility: hex → printf escape sequence string
- `start_claude_session()` (line ~4729): inject color command after tab creation
- `refresh_pr()` (line ~5778): inject color command after tab creation

### Backend (Bash)
- `start_claude_terminal()` (line ~3542): inject color command after tab creation

### Frontend (JS)
- Add `getSessionColor(name)` function: hash → palette hex
- `renderSessionItem()`: add colored dot element before title

### Frontend (CSS)
- Add `.session-color-dot` style: 8px circle, inline with title

## What Does NOT Change

- Terminal.app fallback (no tab coloring API)
- Session data model / session.json
- Existing CSS variables or tag colors
- API endpoints or response formats
