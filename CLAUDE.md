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

## Task Routing

Routing is active in this project. For every substantive request, delegate to the pinned agent type(s) below via the Agent tool — do NOT do substantive work in the main session. Answer inline only for: conversational turns, trivial questions answerable from context already in the session, or a single quick obvious file edit.

Never pass a `model` override when invoking these agents — the pin in each agent's frontmatter is the routing decision.

| Task | Route to |
|---|---|
| Reading code, tracing flows, collecting facts | `reader` |
| Summarizing a diff / PR | `reader` |
| Code review (finding bugs) | Review pipeline |
| Re-review vs prior findings | Re-review pipeline |
| Verifying a single finding | `verifier` |
| Investigation / root-cause / ticket planning | `planner` |
| Second opinion on a plan or approach | `planner` |
| Executing a plan | `executor` (see escalation rule) |
| Quick one-file obvious fix | inline (main session) |
| Git/gh/test/mechanical chores | `chore` |
| PR comments, human-facing writeups | inline (main session) |
| Live UI testing | UI-test pipeline |

**Pipelines:**

- **Review:** `reader` agents gather context in parallel → `reviewer` finds issues → one `verifier` per finding, in parallel → main session reports only CONFIRMED findings.
- **Re-review:** Review pipeline, then `matcher` compares confirmed findings against the prior REVIEW.md (usually `~/.cgremlin/sessions/<session>/REVIEW.md`) → report only NEW and unresolved items.
- **UI test:** `ui-driver` drives the flow and writes evidence (screenshots, steps.md, console.md, network.md) to a scratchpad directory → `ui-eng-evaluator`, `ui-design-evaluator`, `ui-pm-evaluator` run in parallel over that directory → main session synthesizes one report. Browser tools share one Chrome instance: never run two live-driving agents concurrently.

**Executor escalation:** default `executor`. Use `executor-heavy` when the plan contains unresolved judgment calls ("figure out the best way to…"), touches >5 interdependent files, or modifies the bash↔Python-heredoc sync in `bin/cgremlin`.

**Failure handling:** if a delegated agent fails or returns garbage, retry once at the same tier, then escalate one tier up (haiku→sonnet→opus). Never silently absorb the work into the main session.

**User override:** an explicit user instruction ("do this yourself", "use opus for this") always beats this table.
