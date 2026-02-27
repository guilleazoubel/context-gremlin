# Dev Mode, Fix Flows & Tab Naming — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the development CLAUDE.md to be a senior engineer playbook, gate fix buttons on dev mode, enrich fix prompts with full session context, add dev_prompt field to switch mode modal, and fix iTerm2 tab names so they persist.

**Architecture:** Changes span two mirror files (`sandbox` and `.dashboard_server.py`). Each task modifies both files in lockstep. Four independent workstreams: (1) CLAUDE.md template rewrite, (2) switch mode modal enhancement, (3) fix button gating + prompt enrichment, (4) tab name persistence.

**Tech Stack:** Bash heredocs, embedded Python, embedded JavaScript/HTML

---

### Task 1: Rewrite development CLAUDE.md template in bash `switch_to_development_mode()`

**Files:**
- Modify: `sandbox:3139-3188` — bash function `switch_to_development_mode()`

**Step 1: Replace the heredoc body**

In `sandbox`, find the function `switch_to_development_mode()` at ~line 3139. Replace everything between `cat > "$claude_file" << 'DEV_MODE'` and `DEV_MODE` with the new senior engineer template:

```bash
cat > "$claude_file" << 'DEV_MODE'
# Development Mode — Senior Engineer

> You are a senior software engineer. Read and understand the codebase's patterns, conventions, and architecture BEFORE writing any code.

## Task Context

[Task details will be appended below from Jira ticket and/or custom instructions]

## Engineering Principles

- **DRY** — Don't repeat yourself; extract shared logic into reusable functions
- **Low complexity** — Simple, readable solutions over clever ones
- **No hacks** — Every solution must be the "right" way, not a workaround or shortcut
- **Maintainability** — Code should be easy for the next developer to understand and modify
- **Follow existing patterns** — Match the codebase's naming conventions, file structure, and coding style
- **Small, focused changes** — One concern per commit; don't mix refactoring with features

## Before Writing Code

1. **Explore the codebase** — Understand existing architecture, patterns, and conventions
2. **Read context files** — Check FINDINGS.md, REVIEW.md, DEVLOG.md for prior work and open issues
3. **Understand the "why"** — Know the goal behind the task, not just the surface request
4. **Plan your approach** — Think through the design before typing code

## Development Process

1. Implement changes following the codebase's conventions
2. Write or update tests for your changes
3. Run tests after every meaningful change
4. Make incremental, logical commits with clear messages
5. Document progress and decisions in **DEVLOG.md**

## What NOT to Do

- Don't introduce new patterns that conflict with existing ones
- Don't add unnecessary abstractions or over-engineer
- Don't leave TODO/FIXME comments as solutions
- Don't bypass existing safety checks, validations, or linting rules
- Don't commit broken or untested code
- Don't write hacks, workarounds, or "temporary" fixes that become permanent

## Available Context Files

- **session-info.txt** — Task/ticket details and requirements
- **FINDINGS.md** — Investigation notes (read if exists!)
- **REVIEW.md** — Code review findings (fix issues found here!)
- **DEVLOG.md** — Your development log (write progress here)

## DEVLOG Format

Write your progress to `DEVLOG.md`:

```markdown
# Development Log

## Task
[Brief description of what you're implementing]

## Progress

### [Timestamp or Step]
- What was done
- Files modified
- Issues encountered

## Changes Made
- `path/to/file.ts` - [what changed]

## Testing
- [ ] Unit tests pass
- [ ] Manual testing done
```

**BEGIN DEVELOPMENT NOW.**
DEV_MODE
```

Keep the existing code after `DEV_MODE` that re-appends Jira context and updates session.json — do not modify that part.

**Step 2: Verify syntax**

Run: `bash -n sandbox`
Expected: No output (clean parse)

**Step 3: Commit**

```bash
git add sandbox
git commit -m "feat: rewrite dev mode CLAUDE.md to senior engineer template (bash)"
```

---

### Task 2: Rewrite development CLAUDE.md in Python `switch_session_mode()` (both files)

**Files:**
- Modify: `sandbox:4611-4678` — Python `switch_session_mode()` method
- Modify: `.dashboard_server.py:285-358` — Python `switch_session_mode()` method (mirror)

The Python `switch_session_mode()` generates a minimal `mode_header` string when switching to development mode. This needs to become the full senior engineer template that matches Task 1.

**Step 1: Update the development branch in `switch_session_mode()` in sandbox**

Find the section inside `switch_session_mode()` where it handles `new_mode == 'development'` (around line 4663 in sandbox). Currently it generates:
```python
mode_header = f"# Development Session\\n\\nYou are implementing changes.\\nJira: {jira}"
```

Replace the entire `elif new_mode == 'development':` block with code that writes the full senior engineer template. Also store the `dev_prompt` from extra_data:

```python
                elif new_mode == 'development':
                    jira = data.get('jira', {}).get('ticket', '')
                    dev_prompt = ''
                    if extra_data and extra_data.get('dev_prompt'):
                        data['dev_prompt'] = extra_data['dev_prompt']
                        dev_prompt = extra_data['dev_prompt']
                    elif data.get('dev_prompt'):
                        dev_prompt = data['dev_prompt']

                    # Write full senior engineer CLAUDE.md
                    task_context = ''
                    if jira:
                        task_context += f'\nJira Ticket: {jira}\n'
                    if dev_prompt:
                        task_context += f'\n{dev_prompt}\n'
                    if not task_context:
                        task_context = '\n[No specific task context provided — read session-info.txt and context files]\n'

                    mode_content = f"""# Development Mode — Senior Engineer

> You are a senior software engineer. Read and understand the codebase's patterns, conventions, and architecture BEFORE writing any code.

## Task Context
{task_context}
## Engineering Principles

- **DRY** — Don't repeat yourself; extract shared logic into reusable functions
- **Low complexity** — Simple, readable solutions over clever ones
- **No hacks** — Every solution must be the "right" way, not a workaround or shortcut
- **Maintainability** — Code should be easy for the next developer to understand and modify
- **Follow existing patterns** — Match the codebase's naming conventions, file structure, and coding style
- **Small, focused changes** — One concern per commit; don't mix refactoring with features

## Before Writing Code

1. **Explore the codebase** — Understand existing architecture, patterns, and conventions
2. **Read context files** — Check FINDINGS.md, REVIEW.md, DEVLOG.md for prior work and open issues
3. **Understand the "why"** — Know the goal behind the task, not just the surface request
4. **Plan your approach** — Think through the design before typing code

## Development Process

1. Implement changes following the codebase's conventions
2. Write or update tests for your changes
3. Run tests after every meaningful change
4. Make incremental, logical commits with clear messages
5. Document progress and decisions in **DEVLOG.md**

## What NOT to Do

- Don't introduce new patterns that conflict with existing ones
- Don't add unnecessary abstractions or over-engineer
- Don't leave TODO/FIXME comments as solutions
- Don't bypass existing safety checks, validations, or linting rules
- Don't commit broken or untested code
- Don't write hacks, workarounds, or "temporary" fixes that become permanent

## Available Context Files

- **session-info.txt** — Task/ticket details and requirements
- **FINDINGS.md** — Investigation notes (read if exists!)
- **REVIEW.md** — Code review findings (fix issues found here!)
- **DEVLOG.md** — Your development log (write progress here)

**BEGIN DEVELOPMENT NOW.**
"""
                    with open(claude_md, 'w') as f:
                        f.write(mode_content)
                    # Skip the generic mode_header logic below
                    mode_header = None
```

Then after the mode_header writing block, add a guard: `if mode_header is not None:` before writing `mode_header + jira_section`.

**Step 2: Apply identical changes to `.dashboard_server.py`**

Find the same `switch_session_mode()` method at ~line 285 in `.dashboard_server.py` and apply the same changes.

**Step 3: Also handle extra_data storage for dev_prompt in the earlier part of the method**

In the `# Handle mode-specific extra data` section, add:
```python
                elif new_mode == 'development' and extra_data.get('jira'):
                    data.setdefault('jira', {})['ticket'] = extra_data['jira']
                    if extra_data.get('dev_prompt'):
                        data['dev_prompt'] = extra_data['dev_prompt']
```

**Step 4: Verify syntax for both files**

Run: `bash -n sandbox && python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"`
Expected: No errors

Also verify embedded Python: `sed -n '/^DASHBOARD_SERVER_PY=/,/^DASHBOARD_SERVER_PY_END$/p' sandbox | sed '1d;$d' | python3 -c "import ast, sys; ast.parse(sys.stdin.read())"`

**Step 5: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "feat: rewrite Python dev mode CLAUDE.md to senior engineer template"
```

---

### Task 3: Enhance switch mode modal — add dev_prompt textarea

**Files:**
- Modify: `sandbox:8949-8965` — JS `selectSwitchMode()` function
- Modify: `sandbox:8973-8988` — JS `confirmSwitchMode()` function
- Modify: `.dashboard_server.py:4623-4660` — JS `selectSwitchMode()` (mirror)
- Modify: `.dashboard_server.py:4649-4664` — JS `confirmSwitchMode()` (mirror)

**Step 1: Update `selectSwitchMode()` in sandbox — add textarea for development mode**

Find the `else if (mode === 'development')` block in `selectSwitchMode()` (~line 8959). Currently:
```javascript
        } else if (mode === 'development') {
            const session = getCurrentSession();
            const detected = session?.jira || extractJiraFromBranch(session?.branch);
            fields.innerHTML = '<label>Jira Ticket:</label><input type="text" id="modeJira" value="' + (detected || '') + '" placeholder="PROJ-123">';
```

Replace with:
```javascript
        } else if (mode === 'development') {
            const session = getCurrentSession();
            const detected = session?.jira || extractJiraFromBranch(session?.branch);
            fields.innerHTML = '<label>Jira Ticket:</label><input type="text" id="modeJira" value="' + (detected || '') + '" placeholder="PROJ-123">' +
                '<label style="margin-top:8px;">Additional Instructions (optional):</label>' +
                '<textarea id="modeDevPrompt" rows="3" placeholder="Describe what to build, focus areas, constraints..." style="width:100%;resize:vertical;"></textarea>';
```

**Step 2: Update `confirmSwitchMode()` in sandbox — pass dev_prompt**

Find the development case in `confirmSwitchMode()` (~line 8978). Currently:
```javascript
        else if (state.pendingModeSwitch === 'development') { const v = document.getElementById('modeJira')?.value; if (v) extraData.jira = v; }
```

Replace with:
```javascript
        else if (state.pendingModeSwitch === 'development') {
            const v = document.getElementById('modeJira')?.value; if (v) extraData.jira = v;
            const p = document.getElementById('modeDevPrompt')?.value; if (p) extraData.dev_prompt = p;
        }
```

**Step 3: Apply identical changes to `.dashboard_server.py`**

Find the same two functions in `.dashboard_server.py` and apply identical changes.

**Step 4: Verify syntax**

Run: `bash -n sandbox && python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"`

**Step 5: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "feat: add dev_prompt textarea to switch mode modal"
```

---

### Task 4: Gate Fix buttons on development mode

**Files:**
- Modify: `sandbox:8675-8738` — JS `createFindingActionButtons()` — hide Fix button when not in dev mode
- Modify: `sandbox:8293-8330` — JS `renderActionBar()` — hide Fix All Findings when not in dev mode
- Modify: `.dashboard_server.py:4349-4410` — JS `createFindingActionButtons()` (mirror)
- Modify: `.dashboard_server.py:3967-4008` — JS `renderActionBar()` (mirror)

**Step 1: Gate the Fix button in `createFindingActionButtons()` in sandbox**

Find where the `fixBtn` is created (~line 8697 in sandbox). Wrap the Fix button creation and appendChild in a mode check:

Before the line `const fixBtn = document.createElement('button');`, add:
```javascript
        const session = getCurrentSession();
        const isDev = (session?.mode || session?.session_type || '') === 'development';
```

Then wrap the fixBtn block: change `btnContainer.appendChild(fixBtn);` (near end of function) to:
```javascript
        if (isDev) btnContainer.appendChild(fixBtn);
```

**Step 2: Gate Fix All Findings in `renderActionBar()` in sandbox**

Find the Fix All Findings button line (~line 8312). Currently:
```javascript
        if (hasReview && hasRepo) {
            html += '<button class="btn-action" onclick="fixAllFindings()">🔧 Fix All Findings</button>';
        }
```

Change to:
```javascript
        const mode = session.mode || session.session_type || '';
        if (hasReview && hasRepo && mode === 'development') {
            html += '<button class="btn-action" onclick="fixAllFindings()">🔧 Fix All Findings</button>';
        }
```

Note: there's already a `const mode` declared lower in the function for the Commit button check. Move it up before both usages, or rename one. The simplest approach: declare `const mode` once near the top of the function (after `const hasReview`), then use it in both places. Remove the duplicate declaration from the Commit button section.

**Step 3: Apply identical changes to `.dashboard_server.py`**

**Step 4: Verify syntax**

Run: `bash -n sandbox && python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"`

**Step 5: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "feat: gate Fix and Fix All buttons on development mode"
```

---

### Task 5: Enrich fix_finding() prompts with full session context

**Files:**
- Modify: `sandbox:5370-5460` — Python `fix_finding()` method
- Modify: `.dashboard_server.py:1044-1130` — Python `fix_finding()` method (mirror)

**Step 1: Rewrite the prompt generation in `fix_finding()` in sandbox**

The current prompts are bare-bones. Replace them with rich context-aware prompts. In `fix_finding()`, after the repo_path check, add code to read session context:

```python
            # Load session context
            session_json = session_path / 'session.json'
            jira_context = ''
            dev_prompt = ''
            if session_json.exists():
                try:
                    with open(session_json) as f:
                        sdata = json.load(f)
                    jira_ticket = sdata.get('jira', {}).get('ticket', '')
                    if jira_ticket:
                        jira_context = f'Jira Ticket: {jira_ticket}'
                    dev_prompt = sdata.get('dev_prompt', '')
                except (json.JSONDecodeError, ValueError):
                    pass

            context_section = ''
            if jira_context or dev_prompt:
                context_section = '\n## Session Context\n'
                if jira_context:
                    context_section += f'{jira_context}\n'
                if dev_prompt:
                    context_section += f'{dev_prompt}\n'
```

Then update the `fix_all` prompt:
```python
            if fix_all:
                prompt = f"""FIX ALL OPEN FINDINGS

You are a senior software engineer. Your CLAUDE.md in the session root has your full instructions.
{context_section}
## Instructions

1. Read REVIEW.md and identify ALL open findings (skip any marked ✅ resolved or 🔇 dismissed)
2. For each open finding, starting with Critical/Important severity first:
   a. Understand the codebase context around the issue
   b. Implement a proper fix following existing patterns (no hacks or workarounds)
   c. Update the finding's status in REVIEW.md to ✅
3. Read FINDINGS.md and DEVLOG.md for additional context if they exist
4. When done, summarize all fixes in DEVLOG.md

DO NOT COMMIT — the user will review and commit manually."""
```

And update the single finding prompt:
```python
            else:
                finding = finding_data
                prompt = f"""FIX FINDING #{finding.get('number', '?')}: {finding.get('title', 'Unknown')}

You are a senior software engineer. Your CLAUDE.md in the session root has your full instructions.
{context_section}
## Finding Details

- **Location:** `{finding.get('file', '')}:{finding.get('line', '')}`
- **Problem:** {finding.get('problem', 'See REVIEW.md')}
- **Impact:** {finding.get('impact', '')}
- **Suggested Fix:** {finding.get('suggestion', '')}

## Instructions

1. Read the surrounding code to understand context and existing patterns
2. Read FINDINGS.md and DEVLOG.md for additional context if they exist
3. Implement a proper fix — no hacks, no workarounds, follow existing conventions
4. Update this finding's status in REVIEW.md to ✅

DO NOT COMMIT — the user will review and commit manually."""
```

Also add session color to the iTerm2 script (currently missing from fix_finding):
```python
            session_name = session_path.name
            color_cmd = iterm_color_escape(session_color(session_name))
```

And in the iTerm2 AppleScript, add the color command and differentiate tab name for fix_all:
```python
            tab_label = f"🔧 Fix All: {session_name}" if fix_all else f"🔧 Fix: {session_name}"
            # ... in the script:
            #   set name to "{tab_label}"
            #   write text "{color_cmd}"
```

**Step 2: Apply identical changes to `.dashboard_server.py`**

**Step 3: Verify syntax**

Run: `bash -n sandbox && python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"`

Also: `sed -n '/^DASHBOARD_SERVER_PY=/,/^DASHBOARD_SERVER_PY_END$/p' sandbox | sed '1d;$d' | python3 -c "import ast, sys; ast.parse(sys.stdin.read())"`

**Step 4: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "feat: enrich fix prompts with full session context and senior engineer role"
```

---

### Task 6: Fix iTerm2 tab name persistence

**Files:**
- Modify: `sandbox` — ALL 8 AppleScript `set name to` locations
- Modify: `.dashboard_server.py` — ALL 6 AppleScript `set name to` locations

**Problem:** iTerm2's `set name to` via AppleScript gets overwritten by the shell prompt. Adding a `printf '\033]1;...\a'` escape sequence after `set name to` sets the "user-defined session name" which persists.

**Step 1: For each `set name to` location in sandbox, add a `write text` line with the tab title escape sequence**

After each `set name to "EMOJI session-name"` line, add:
```applescript
write text "printf '\\033]1;EMOJI session-name\\a'"
```

The locations and their tab names:

| sandbox line | Tab name pattern | Variable |
|---|---|---|
| ~3592 | `🧪 $SESSION_NAME` | Bash variable |
| ~3660 | `🧪 $SESSION_NAME` | Bash variable |
| ~4839 | `🧪 {session_name}` | Python f-string |
| ~4943 | `🧪 {session_name}` | Python f-string |
| ~5433 | `🔧 Fix: {session_name}` (will be `{tab_label}` after Task 5) | Python f-string |
| ~5940 | `🔄 Re-review: {session_name}` | Python f-string |
| ~6155 | `📂 {session_name}` | Python f-string |
| ~6284 | `▶️ App: {session_name}` | Python f-string |

For **bash** locations (lines ~3592, ~3660), the escape uses bash variables:
```applescript
            set name to "🧪 $SESSION_NAME"
            write text "printf '\\033]1;🧪 $SESSION_NAME\\a'"
```

For **Python f-string** locations, use the Python variable:
```applescript
            set name to "🧪 {session_name}"
            write text "printf '\\\\033]1;🧪 {session_name}\\\\a'"
```

Note the extra escaping: in a Python f-string inside an AppleScript string, backslashes need double-escaping.

**Step 2: Apply the same pattern to all 6 locations in `.dashboard_server.py`**

| .dashboard_server.py line | Tab name pattern |
|---|---|
| ~513 | `🧪 {session_name}` |
| ~617 | `🧪 {session_name}` |
| ~1107 | `🔧 Fix: {session_name}` (will be `{tab_label}` after Task 5) |
| ~1614 | `🔄 Re-review: {session_name}` |
| ~1829 | `📂 {session_name}` |
| ~1958 | `▶️ App: {session_name}` |

**Step 3: Verify syntax**

Run: `bash -n sandbox && python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"`

Also: `sed -n '/^DASHBOARD_SERVER_PY=/,/^DASHBOARD_SERVER_PY_END$/p' sandbox | sed '1d;$d' | python3 -c "import ast, sys; ast.parse(sys.stdin.read())"`

**Step 4: Commit**

```bash
git add sandbox .dashboard_server.py
git commit -m "fix: persist iTerm2 tab names with escape sequence"
```

---

### Task 7: Final verification

**Step 1: Full syntax check both files**

```bash
bash -n sandbox
python3 -c "import ast; ast.parse(open('.dashboard_server.py').read())"
sed -n '/^DASHBOARD_SERVER_PY=/,/^DASHBOARD_SERVER_PY_END$/p' sandbox | sed '1d;$d' | python3 -c "import ast, sys; ast.parse(sys.stdin.read())"
```

All should pass with no output.

**Step 2: Manual smoke test checklist**

1. Start dashboard: `./sandbox`, open web UI
2. Select a session → check action bar:
   - In **review mode**: No Commit button, no Fix All Findings button
   - Switch to **development mode**: Commit button appears, Fix All Findings appears
3. Switch to development mode:
   - Modal shows Jira field AND new "Additional Instructions" textarea
   - Enter both values → switch → verify CLAUDE.md in session root has the full senior engineer template with task context
4. View review tab findings:
   - In **review mode**: Fix button is hidden per finding
   - In **development mode**: Fix button is visible per finding
5. Click Fix on a finding → new iTerm2 tab opens with:
   - Session color on tab
   - Tab name persists as "🔧 Fix: session-name"
   - Claude prompt includes session context + finding details
6. Click Fix All Findings → new iTerm2 tab with "🔧 Fix All: session-name"
7. Start Claude on any session → tab name "🧪 session-name" persists (doesn't get overwritten by shell)
