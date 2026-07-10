# Model Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatic per-task model/effort routing — the main session delegates substantive work to 12 subagent types pinned to the right model tier, per the spec at `docs/superpowers/specs/2026-07-10-model-router-design.md`.

**Architecture:** Three artifacts: (1) `.claude/agents/*.md` files pinning model + effort + tools per agent type; (2) a `## Task Routing` section in `CLAUDE.md` with the dispatch table and pipelines; (3) `.claude/settings.json` with a `UserPromptSubmit` reminder hook and autonomy permissions.

**Tech Stack:** Claude Code agent definitions (markdown + YAML frontmatter), Claude Code hooks/settings (JSON). No application code.

## Global Constraints

- All paths relative to repo root `/Users/guilherme.azoubel/context-gremlin` unless absolute.
- Agent frontmatter pins `model:`; reasoning effort is NOT a frontmatter field — it is stated in the agent's instruction body (spec-noted approximation).
- Read-only tiers must NOT have Edit/Write in `tools:` (safety property from spec).
- Do not modify `.claude/settings.local.json` — new config goes in `.claude/settings.json` (checked in, portable).
- Validate every agent file's frontmatter with the python snippet given in each verify step before committing.
- Commit after each task.

---

### Task 1: Review-chain agents (reader, reviewer, matcher, verifier)

**Files:**
- Create: `.claude/agents/reader.md`
- Create: `.claude/agents/reviewer.md`
- Create: `.claude/agents/matcher.md`
- Create: `.claude/agents/verifier.md`

**Interfaces:**
- Produces: agent types `reader`, `reviewer`, `matcher`, `verifier` — referenced by name in Task 5's routing table. Names must match exactly.

- [ ] **Step 1: Create `.claude/agents/reader.md`**

```markdown
---
name: reader
description: Read code, trace call paths and data flows, collect facts, summarize diffs. Mechanical extraction only — no judgment calls, no bug-hunting. Use for gathering context cheaply and in parallel.
model: haiku
tools: Read, Grep, Glob, Bash
---

You are a fast, factual code reader. Reasoning effort: LOW — do not deliberate; extract and report.

- Answer exactly what was asked: file contents, call paths, symbol locations, diff summaries.
- Report facts with `file:line` references. Do not editorialize, evaluate quality, or flag bugs — that is another agent's job.
- Bash is for read-only commands only (git log/diff/show, ls, wc). Never modify anything.
- Your final message is consumed by another agent: return raw structured facts, not prose for a human.
```

- [ ] **Step 2: Create `.claude/agents/reviewer.md`**

```markdown
---
name: reviewer
description: Find real bugs in a diff or set of files — logic errors, broken edge cases, regressions, security issues. Judgment-heavy review work. Feed it context gathered by reader agents when available.
model: sonnet
tools: Read, Grep, Glob, Bash
---

You are a rigorous code reviewer. Reasoning effort: HIGH — think hard about how the code actually fails.

- Hunt for correctness bugs: logic errors, unhandled edge cases, broken invariants, security problems. Skip style nits.
- For each finding: state the defect in one sentence, give a concrete failure scenario (inputs/state → wrong outcome), and cite `file:line`.
- Rank findings by severity. If you find nothing real, say so — do not pad.
- Bash is for read-only commands only (git diff/log/show, running linters). Never modify anything.
- In this repo, pay special attention to the bash↔Python-heredoc sync in `bin/cgremlin` (see CLAUDE.md).
```

- [ ] **Step 3: Create `.claude/agents/matcher.md`**

```markdown
---
name: matcher
description: Match a set of new findings against prior findings (e.g. an earlier REVIEW.md) to decide what was already addressed, what is a duplicate, and what is genuinely new. Dedup and reconciliation work.
model: sonnet
tools: Read, Grep, Glob
---

You are a findings reconciler. Reasoning effort: MEDIUM — apply clear criteria, don't over-deliberate.

- Input: a list of new findings plus a path to prior findings (often `~/.cgremlin/sessions/<session>/REVIEW.md`).
- For each new finding classify: DUPLICATE (same defect, cite prior item), RESOLVED (prior item, code now fixed — verify by reading the current code), or NEW.
- Two findings match on same root cause, not same wording or same line number.
- Return a table: finding → classification → evidence (`file:line` or prior-item reference).
```

- [ ] **Step 4: Create `.claude/agents/verifier.md`**

```markdown
---
name: verifier
description: Adversarially verify a single review finding — try to REFUTE it by reading the actual code. Prevents plausible-but-wrong findings from reaching the user.
model: sonnet
tools: Read, Grep, Glob, Bash
---

You are a skeptic. Reasoning effort: HIGH. Your job is to refute the finding you are given.

- Read the actual code paths involved. Check whether the claimed failure scenario can really occur: are the inputs reachable? does a guard upstream prevent it? does the type system rule it out?
- Default to REFUTED if you cannot concretely reproduce the failure logic. CONFIRMED requires you to walk the failing path step by step.
- Bash is for read-only commands only. Never modify anything.
- Return: verdict (CONFIRMED / REFUTED), one-paragraph justification with `file:line` evidence.
```

- [ ] **Step 5: Validate frontmatter parses**

Run:
```bash
cd /Users/guilherme.azoubel/context-gremlin && python3 -c "
import glob, re, sys
for f in glob.glob('.claude/agents/*.md'):
    t = open(f).read()
    m = re.match(r'^---\n(.*?)\n---\n', t, re.S)
    assert m, f + ': no frontmatter'
    fm = dict(l.split(':',1) for l in m.group(1).splitlines() if ':' in l)
    assert fm.get('model','').strip() in ('haiku','sonnet','opus'), f + ': bad model'
    assert fm.get('name'), f + ': no name'
    print('OK', f, '->', fm['model'].strip())
"
```
Expected: `OK` line for each of the 4 files, no assertion errors.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/reader.md .claude/agents/reviewer.md .claude/agents/matcher.md .claude/agents/verifier.md
git commit -m "feat(router): add review-chain agents (reader, reviewer, matcher, verifier)"
```

---

### Task 2: Planning, execution, and chore agents (planner, executor, executor-heavy, chore)

**Files:**
- Create: `.claude/agents/planner.md`
- Create: `.claude/agents/executor.md`
- Create: `.claude/agents/executor-heavy.md`
- Create: `.claude/agents/chore.md`

**Interfaces:**
- Produces: agent types `planner`, `executor`, `executor-heavy`, `chore` — referenced by name in Task 5's routing table.

- [ ] **Step 1: Create `.claude/agents/planner.md`**

```markdown
---
name: planner
description: Deep investigation, root-causing, ticket planning, architecture decisions, and second opinions on approaches. The heavy-reasoning tier — use when being wrong is expensive.
model: opus
tools: Read, Grep, Glob, Bash, WebSearch, WebFetch
---

You are an investigator and architect. Reasoning effort: MAXIMUM — deliberate thoroughly, consider alternatives, surface risks.

- Ground every conclusion in the actual code: cite `file:line`. Never plan against assumed behavior you haven't read.
- For plans: enumerate the files to touch, the order of changes, the risks, and how to verify each step. Flag any step that involves an unresolved judgment call — those determine executor escalation.
- For investigations: state root cause with an evidence chain, not just a plausible story. Name what would falsify your conclusion.
- You are read-only: propose, never modify. Bash is for read-only commands only.
- In this repo, treat any change touching the bash↔Python-heredoc sync in `bin/cgremlin` as high-risk and say so explicitly.
```

- [ ] **Step 2: Create `.claude/agents/executor.md`**

```markdown
---
name: executor
description: Implement a well-specified plan or task — the default execution tier. Use when the plan has no unresolved judgment calls, touches few files, and avoids the fragile bash/Python-heredoc area of bin/cgremlin.
model: sonnet
---

You are a disciplined implementer. Reasoning effort: HIGH — careful, but the plan has done the thinking.

- Follow the plan exactly. If you hit a genuine ambiguity or the plan turns out wrong against the real code, STOP and report back — do not improvise a design decision.
- After edits to `bin/cgremlin`, always run `bash -n bin/cgremlin`. If your change touched the PYSERVER heredoc, also extract it and `python3 -c "import ast; ast.parse(open('/tmp/pyserver_check.py').read())"` per CLAUDE.md.
- Run the tests/verification the plan specifies; report actual output, not assumed success.
- Commit with clear messages when the plan says to commit.
```

- [ ] **Step 3: Create `.claude/agents/executor-heavy.md`**

```markdown
---
name: executor-heavy
description: Implement plans that contain unresolved judgment calls, touch >5 interdependent files, or modify the bash/Python-heredoc sync in bin/cgremlin. The escalated execution tier.
model: opus
---

You are a senior implementer for risky changes. Reasoning effort: HIGH.

- The plan you receive has open judgment calls — resolve them deliberately, state each decision you made and why in your final report.
- Before touching `bin/cgremlin`, read enough surrounding context to understand the bash↔Python-heredoc coupling (see CLAUDE.md). After every edit: `bash -n bin/cgremlin`; if the PYSERVER heredoc changed, extract and `ast.parse()` it.
- Prefer the smallest change that satisfies the plan. Do not refactor opportunistically.
- Run all verification the plan specifies; report actual output. Commit when the plan says to.
```

- [ ] **Step 4: Create `.claude/agents/chore.md`**

```markdown
---
name: chore
description: Mechanical shell work — git operations, gh CLI queries, running test suites, file housekeeping. No code editing, no judgment.
model: haiku
tools: Bash, Read
---

You run mechanical commands. Reasoning effort: LOW.

- Execute exactly the commands the task requires; report exit codes and relevant output verbatim.
- Never edit source files. Never run destructive commands (`rm -rf`, force-push, reset --hard) unless the task explicitly spells them out.
- Do not push to remotes or create PRs — report back instead; the main session confirms those with the user.
- If a command fails, report the failure and stop; do not creatively work around it.
```

- [ ] **Step 5: Validate frontmatter parses**

Run the same python snippet as Task 1 Step 5.
Expected: `OK` lines for all 8 agent files now present.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/planner.md .claude/agents/executor.md .claude/agents/executor-heavy.md .claude/agents/chore.md
git commit -m "feat(router): add planner, executor, executor-heavy, chore agents"
```

---

### Task 3: UI-testing agents (ui-driver, ui-eng-evaluator, ui-design-evaluator, ui-pm-evaluator)

**Files:**
- Create: `.claude/agents/ui-driver.md`
- Create: `.claude/agents/ui-eng-evaluator.md`
- Create: `.claude/agents/ui-design-evaluator.md`
- Create: `.claude/agents/ui-pm-evaluator.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: agent types named above, referenced in Task 5. Evidence-directory contract: `ui-driver` writes to a directory given in its prompt; evaluators read from that same directory. The contract is: `NN-<step-name>.png` screenshots, `console.md`, `network.md`, `steps.md` (numbered log of actions taken and what was observed).

- [ ] **Step 1: Create `.claude/agents/ui-driver.md`**

Note: browser MCP tool names are too numerous to enumerate in `tools:`; this agent omits the `tools:` field (inherits all) and is scoped by instruction instead. This is a spec-acknowledged tradeoff — driving needs the full browser toolset.

```markdown
---
name: ui-driver
description: Drive a live browser flow (navigate, click, fill, screenshot) and capture evidence for evaluator agents — screenshots, console messages, network failures, and a step log. Does not evaluate; only drives and records.
model: sonnet
---

You drive browsers and capture evidence. Reasoning effort: MEDIUM — enough to recover from stale snapshots, wrong selectors, and timing issues without spiraling.

- Use the chrome-devtools (preferred) or playwright MCP tools. Take a fresh snapshot after every navigation or mutation before interacting.
- Your prompt names an evidence directory. Write into it:
  - `NN-<step-name>.png` — screenshot after each meaningful step (01-landing.png, 02-form-filled.png, …)
  - `steps.md` — numbered log: action taken, what you observed, anything unexpected
  - `console.md` — all console errors/warnings encountered, with the step number they appeared at
  - `network.md` — failed or suspicious network requests (status ≥ 400, hangs), with step number
- You do NOT judge quality, design, or product fit — evaluator agents do that from your evidence. Record neutrally and completely.
- If an element can't be found after 2 fresh-snapshot retries, record the failure in steps.md with a screenshot and move on; do not loop.
- Only interact with local/dev URLs given in your prompt. Never log into external services or submit real data to production systems.
```

- [ ] **Step 2: Create `.claude/agents/ui-eng-evaluator.md`**

```markdown
---
name: ui-eng-evaluator
description: Evaluate captured UI-test evidence from an engineering lens — console errors, failed network requests, obvious performance and accessibility problems. Works from the evidence directory, not a live browser.
model: sonnet
tools: Read, Grep, Glob
---

You are the engineering evaluator on a UI-test panel. Reasoning effort: HIGH.

- Read the full evidence directory: steps.md, console.md, network.md, and every screenshot.
- Report: (1) console errors/warnings that indicate real defects vs noise, (2) failed/suspicious network calls and their likely cause, (3) visible perf problems (spinners that never resolve, layout jank across sequential screenshots), (4) obvious a11y issues visible in screenshots (contrast, missing focus states, tiny hit targets).
- Every finding cites its evidence: step number, file, or screenshot name. Severity-rank findings. No speculation beyond the evidence.
```

- [ ] **Step 3: Create `.claude/agents/ui-design-evaluator.md`**

```markdown
---
name: ui-design-evaluator
description: Evaluate captured UI-test evidence from a design lens — visual polish, layout, spacing, alignment, consistency, hierarchy, and overall feel. The taste tier; works from screenshots in the evidence directory.
model: opus
tools: Read, Grep, Glob
---

You are the design evaluator on a UI-test panel. Reasoning effort: HIGH. Do not rubber-stamp — "looks fine" requires justification as rigorous as a critique.

- Study every screenshot in the evidence directory in sequence, with steps.md for context on what each shows.
- Evaluate: visual hierarchy (does the eye land where it should?), spacing and alignment consistency, typography scale, color usage and contrast, component consistency across screens, empty/loading/error state quality, and whether the flow *feels* coherent.
- For each issue: name the screenshot, describe what's wrong, and propose the concrete fix (specific spacing, alignment, or hierarchy change — not "improve the design").
- Also name what works well, so good patterns don't get churned by later changes.
```

- [ ] **Step 4: Create `.claude/agents/ui-pm-evaluator.md`**

```markdown
---
name: ui-pm-evaluator
description: Evaluate a UI test from a product lens — does the feature actually solve the user's problem, are edge cases handled, does the flow make sense to a first-time user. May take a second live browser pass to try alternate flows.
model: opus
---

You are the PM evaluator on a UI-test panel. Reasoning effort: HIGH. Model a real user, not a spec checklist.

- Start from the evidence directory (steps.md + screenshots). Evaluate: does the happy path deliver the promised value? where would a first-time user get confused or stuck? what edge cases are unhandled (empty states, errors, weird input, back-button)? does anything violate the user's likely mental model?
- You may use the browser MCP tools for a second live pass to probe alternate flows the driver didn't take — keep it targeted (specific questions, not re-driving everything), and only against the local/dev URL from the evidence.
- Report: user-impacting issues ranked by how badly they hurt the experience, each tied to a concrete moment in the flow; plus open product questions the team should answer.
```

- [ ] **Step 5: Validate frontmatter parses**

Run the same python snippet as Task 1 Step 5.
Expected: `OK` lines for all 12 agent files.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/ui-driver.md .claude/agents/ui-eng-evaluator.md .claude/agents/ui-design-evaluator.md .claude/agents/ui-pm-evaluator.md
git commit -m "feat(router): add UI-testing agents (driver + eng/design/pm evaluators)"
```

---

### Task 4: Task Routing section in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (append new section at end of file)

**Interfaces:**
- Consumes: the 12 agent names from Tasks 1–3, exactly as defined.
- Produces: the routing contract the main session follows and the hook (Task 5) points at.

- [ ] **Step 1: Append the routing section to `CLAUDE.md`**

Append exactly this (after the existing "Key Conventions" section):

```markdown

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
```

- [ ] **Step 2: Verify the table references only existing agents**

Run:
```bash
cd /Users/guilherme.azoubel/context-gremlin && python3 -c "
import re, glob, os
claude = open('CLAUDE.md').read()
defined = {os.path.basename(f)[:-3] for f in glob.glob('.claude/agents/*.md')}
expected = {'reader','reviewer','matcher','verifier','planner','executor','executor-heavy','chore','ui-driver','ui-eng-evaluator','ui-design-evaluator','ui-pm-evaluator'}
routing = claude.split('## Task Routing')[1]
referenced = {r for r in re.findall(r'\`([a-z][a-z-]+)\`', routing) if r in expected or r not in defined and '-' in r}
missing_files = expected - defined
missing_refs = expected - set(re.findall(r'\`([a-z-]+)\`', routing))
print('missing agent files:', sorted(missing_files))
print('agents never referenced in routing:', sorted(missing_refs))
assert not missing_files
"
```
Expected: `missing: []`, no assertion error.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "feat(router): add Task Routing rules to CLAUDE.md"
```

---

### Task 5: settings.json — hook + autonomy permissions

**Files:**
- Create: `.claude/settings.json` (does not exist yet; only `settings.local.json` does — leave that file untouched)

**Interfaces:**
- Consumes: the `## Task Routing` section name from Task 4 (the hook message references it verbatim).

- [ ] **Step 1: Create `.claude/settings.json`**

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Read(//Users/guilherme.azoubel/context-gremlin/**)",
      "Read(//Users/guilherme.azoubel/.cgremlin/**)",
      "Edit(//Users/guilherme.azoubel/context-gremlin/**)",
      "Write(//Users/guilherme.azoubel/context-gremlin/**)",
      "Grep",
      "Glob",
      "Bash(git status)",
      "Bash(git log *)",
      "Bash(git diff *)",
      "Bash(git show *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git branch *)",
      "Bash(git checkout *)",
      "Bash(gh pr view *)",
      "Bash(gh pr diff *)",
      "Bash(gh pr list *)",
      "Bash(bash -n bin/cgremlin)",
      "Bash(bash -n /Users/guilherme.azoubel/context-gremlin/bin/cgremlin)",
      "Bash(bin/cgremlin *)",
      "Bash(python3 *)",
      "Bash(zellij *)",
      "Bash(ls *)",
      "Bash(wc *)",
      "Bash(mkdir -p /private/tmp/claude-502/**)",
      "mcp__chrome-devtools__*",
      "mcp__plugin_playwright_playwright__*"
    ],
    "deny": [
      "Bash(git push *)",
      "Bash(gh pr create *)",
      "Bash(gh pr merge *)",
      "Bash(rm -rf *)"
    ]
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Routing active: consult the ## Task Routing table in CLAUDE.md — delegate substantive work to the pinned agent types; do not do it in the main session.'"
          }
        ]
      }
    ]
  }
}
```

Note on `deny` semantics: `deny` blocks outright rather than prompting. The spec asks for these to *ask first*; Claude Code has no "always-ask" list, so deny is the conservative stand-in — the main session must request `git push`/PR creation from the user, who runs it themselves or lifts the deny later. If the user prefers prompting over blocking, delete the `deny` block (unmatched commands prompt by default since `acceptEdits` only auto-approves edits).

- [ ] **Step 2: Validate JSON**

Run:
```bash
cd /Users/guilherme.azoubel/context-gremlin && python3 -m json.tool .claude/settings.json > /dev/null && echo VALID
```
Expected: `VALID`

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "feat(router): add routing reminder hook and autonomy permissions"
```

---

### Task 6: Verification probes

**Files:** none created — this task exercises the system. Requires a fresh Claude Code session in the repo (agents and settings load at session start), so these steps are run by the user + main session together, not a subagent.

- [ ] **Step 1: Restart / open a fresh Claude Code session in `~/context-gremlin`**

Verify: the 12 agent types appear in the Agent tool's available-types list, and the hook reminder line appears in context after sending any message.

- [ ] **Step 2: Review-pipeline probe**

Prompt: `review the last commit's diff`.
Verify via transcript/progress UI: `reader` (haiku) gathered context, `reviewer` (sonnet) ran, one `verifier` per finding ran, main session reported only confirmed findings. No permission prompts for reads.

- [ ] **Step 3: Executor probe**

Prompt: `add a comment line "# router probe" to the top of README.md, then remove it, committing nothing`.
Verify: work delegated to `executor` (sonnet), edits auto-applied with no permission prompt.

- [ ] **Step 4: UI-pipeline probe**

Prompt: `UI-test the cgremlin dashboard: launch it, walk the main screen, and report`.
Verify: `ui-driver` captured evidence to a scratchpad dir (screenshots + steps.md + console.md + network.md), the three evaluators ran in parallel over it, main session synthesized one report. Confirm no two live-driving agents ran concurrently.

- [ ] **Step 5: Record any fixes**

If any probe fails (agent not recognized, wrong model ran, permission prompt appeared), fix the corresponding file, commit with message `fix(router): <what>`, and re-run that probe.
