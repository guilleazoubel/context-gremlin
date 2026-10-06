# cgremlin step 1b — The `cgremlin` plugin (agents + qa-verify) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage sessions in any repo can use the 12 cgremlin agents and `/cgremlin:qa-verify`, because both ship in a `cgremlin` plugin installed at user level.

**Architecture:** A new `plugin/` directory at the repo root holds `.claude-plugin/plugin.json`, `agents/` (the 12, tightened) and `skills/qa-verify/` (moved from `cgremlin/core/skills/qa-verify/`, the single source). A root `.claude-plugin/marketplace.json` makes the repo a local marketplace (`cgremlin-local`) whose one entry has `source: "./plugin"`. The project's `.claude/agents/*.md` become symlinks into `plugin/agents/`, so cgremlin development keeps the bare agent names the CLAUDE.md routing table uses, with no second copy to drift.

**Tech Stack:** Claude Code plugin format (`claude plugin validate|marketplace|install`), vitest (`cgremlin/core`), git worktree/tags.

**Spec:** `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md` §18 A3, §17, §10. Card: `docs/superpowers/plans/2026-10-05-cgremlin-program.md` step 1b (lines 112–120).

## Global Constraints

- **Scope:** change only cgremlin (`~/context-gremlin`) and my personal `~/.claude`. **Never** change team repos (grace, grace-frontend, web-fastcar). Verifying from `~/Projects/grace-frontend` must leave `git status --porcelain` there identical before and after.
- **Protected actions** need my explicit approval: opening a PR for review, merging, approving, posting review findings (R112). Commit, push to own branches are fine; `git push` will prompt the user.
- **TDD** for behaviour; `pnpm test`, `pnpm typecheck` and `pnpm lint` pass in `cgremlin/core` and `cgremlin/vscode` before any release.
- **Isolation:** worktree `.claude/worktrees/1b` on branch `step/1b` (never `cgremlin-1b`, reserved for the tag), branched from `mission-control-pr-orchestrator`. Commit after every task. Push with explicit refs: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-1b refs/tags/cgremlin-1b`.
- **Release:** the `RELEASES.md` checklist: tag `cgremlin-pre-1b` + `cgremlin-1b`, save the `.vsix` to `~/cgremlin-releases/`, add a table row (Date | Tag | Commit | Saved build | What changed | Roll back to), push branch + tags.
- **Delegate** substantive work to subagents pinned per §17; never pass a `model` override to the pinned agents.
- `bin/cgremlin` (legacy) is **frozen**.
- **Skills:** the `qa-verify` body must stay byte-identical (git must report a 100 % rename), so the ≥3-eval rule does not trigger. If any line of `SKILL.md` changes, stop and add three `claude plugin eval` cases first.
- **Never read** `~/.cgremlin/config` or `~/.cgremlin-core*/core.json` into a transcript.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or the model actually used).

## Review Focus

1. **Duplicate or drifting agents** — in the cgremlin repo both `.claude/agents` and the installed plugin load. Expected: `.claude/agents/*.md` are symlinks to `plugin/agents/*.md`, so there is one source (Task 2 test).
2. **A tools list that strips an agent of a tool it needs** — executor without Edit/Write, ui-driver without browser MCP tools, ui-pm-evaluator without a second live pass. Expected: each has the tools its description promises (Task 2 test + smoke check).
3. **`UNVERIFIABLE` verdict mishandled** — a consumer treating it as CONFIRMED, or dropping it silently. Expected: only CONFIRMED is reported as a finding; UNVERIFIABLE is shown as ❓ (Task 2 grep + test).
4. **Marketplace pointing at a deleted worktree** — the install is made from `.claude/worktrees/1b`, which is removed after merge. Expected: marketplace re-pointed at the main checkout and `/cgremlin:qa-verify` re-verified before the worktree is removed (Task 5).
5. **The plugin missing in a session** — `qaSkillCommand` defaults to `/cgremlin:qa-verify`; with no plugin the brief must still carry the protocol. Expected: existing degrade-silently tests still pass unchanged (Task 1).

---

### Task 1: Plugin scaffold; move `qa-verify` as the single source

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Move (git mv): `cgremlin/core/skills/qa-verify/SKILL.md` → `plugin/skills/qa-verify/SKILL.md`
- Modify: `cgremlin/core/test/skills/qa-verify-skill.test.ts` (the path it reads the skill from)
- Modify: `cgremlin/core/README.md:182-186` (installation note)
- Test: `cgremlin/core/test/plugin/plugin-manifest.test.ts`

**Interfaces:**
- Produces: the plugin root `plugin/` (Task 2 adds `plugin/agents/`, Task 3 references `./plugin`); skill path `plugin/skills/qa-verify/SKILL.md`.

- [ ] **Step 1: Create the worktree.** From `/Users/guilherme.azoubel/context-gremlin`: `git worktree add .claude/worktrees/1b -b step/1b mission-control-pr-orchestrator`. All later work happens in `.claude/worktrees/1b`. Copy this plan file into the worktree at the same relative path and commit it: `docs(cgremlin): step 1b plan`.
- [ ] **Step 2: Write the failing manifest test** `cgremlin/core/test/plugin/plugin-manifest.test.ts` (match the import style of `qa-verify-skill.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../plugin');

describe('cgremlin plugin manifest', () => {
  it('declares name cgremlin and a semver version', () => {
    const m = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(m.name).toBe('cgremlin');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.description).toBe('string');
  });
  it('ships qa-verify and the old location is gone', () => {
    expect(existsSync(resolve(root, 'skills/qa-verify/SKILL.md'))).toBe(true);
    expect(existsSync(resolve(root, '../cgremlin/core/skills/qa-verify/SKILL.md'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it, expect FAIL.** `cd cgremlin/core && pnpm vitest run test/plugin/plugin-manifest.test.ts` → FAIL (no plugin.json).
- [ ] **Step 4: Implement.** `mkdir -p plugin/.claude-plugin plugin/skills && git mv cgremlin/core/skills/qa-verify plugin/skills/qa-verify`. Create `plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "cgremlin",
  "version": "0.1.0",
  "description": "Context Gremlin agents (reader, reviewer, verifier, executor, planner, UI evaluators, …) and the qa-verify skill, for stage sessions in any repo.",
  "author": { "name": "guilleazoubel" }
}
```

  In `qa-verify-skill.test.ts` change the skill path to `plugin/skills/qa-verify/SKILL.md` (resolve relative to the test file; keep both fence tests unchanged). In `cgremlin/core/README.md` lines 182–186 replace the "copy the skill into ~/.claude/skills" style instruction with: install the plugin (`claude plugin marketplace add <repo path>` then `claude plugin install cgremlin@cgremlin-local`). Read those lines first and keep the surrounding wording.
- [ ] **Step 5: Verify.** `grep -rn "core/skills/qa-verify" --include='*' . | grep -v node_modules | grep -v '^./docs/'` returns nothing (fix any hit). `git diff -M --stat --cached` shows `SKILL.md` as `rename ... (100%)`. Then in `cgremlin/core`: `pnpm vitest run test/plugin test/skills test/pipeline/qa-prompts.test.ts test/config/qa-config.test.ts` → PASS (qaSkillCommand tests unchanged — Review Focus 5).
- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(cgremlin-plugin): plugin scaffold; qa-verify moves to plugin/skills (single source)"` with the trailer.

### Task 2: The 12 agents in the plugin, tightened; `.claude/agents` become symlinks

**Files:**
- Move (git mv) then modify: `.claude/agents/*.md` (12) → `plugin/agents/*.md`
- Create: 12 symlinks `.claude/agents/<name>.md` → `../../plugin/agents/<name>.md`
- Test: `cgremlin/core/test/plugin/plugin-agents.test.ts`

**Interfaces:**
- Consumes: `plugin/` from Task 1.
- Produces: `plugin/agents/<name>.md` with frontmatter keys `name, description, tools, model, effort`, and a `## Output format` section in each body.

Target frontmatter (exact; keep each file's existing body below it, then append the output-format section). Descriptions are third person ("Does…", not "Do…").

| name | model · effort | tools | description (first sentence replaced; the rest of the existing text is kept) |
|---|---|---|---|
| chore | haiku · low | Bash, Read | "Does mechanical shell work — …" |
| reader | haiku · low | Read, Grep, Glob, Bash | "Reads code, traces call paths and data flows, collects facts and summarizes diffs. …" |
| matcher | sonnet · medium | Read, Grep, Glob | "Matches a set of new findings against prior findings …" |
| planner | opus · high | Read, Grep, Glob, Bash, WebSearch, WebFetch | "Investigates deeply, root-causes, plans tickets, … " |
| reviewer | **opus** · high | Read, Grep, Glob, Bash | "Finds real bugs in a diff or set of files …" |
| verifier | opus · high | Read, Grep, Glob, Bash | "Adversarially verifies a single review finding …" |
| executor | sonnet · high | Read, Write, Edit, Bash, Grep, Glob | "Implements a well-specified plan or task …" |
| executor-heavy | opus · high | Read, Write, Edit, Bash, Grep, Glob | "Implements plans that contain unresolved judgment calls …" |
| ui-driver | sonnet · medium | Read, Write, Bash, Grep, Glob, mcp__chrome-devtools, mcp__chrome-devtools-visible, mcp__plugin_playwright_playwright | "Drives a live browser flow …" |
| ui-eng-evaluator | opus · medium | Read, Grep, Glob | "Evaluates captured UI-test evidence from an engineering lens …" |
| ui-design-evaluator | opus · medium | Read, Grep, Glob | "Evaluates captured UI-test evidence from a design lens …" |
| ui-pm-evaluator | opus · medium | Read, Grep, Glob, Bash, mcp__chrome-devtools, mcp__chrome-devtools-visible, mcp__plugin_playwright_playwright | "Evaluates a UI test from a product lens …" |

Output-format section to append (exact text per agent):
- **chore:** `## Output format` / "Report the commands run, their exit status, and the relevant output lines. No interpretation."
- **reader:** "Return a bullet list of facts, each as `file:line — quoted text`. No opinions or recommendations."
- **matcher:** keep the existing DUPLICATE / RESOLVED / NEW line and add: "One line per finding: `<id> — DUPLICATE|RESOLVED|NEW — <prior item or evidence>`."
- **planner:** "Return: Findings (with `file:line` evidence), Options with trade-offs, one Recommendation, Open questions."
- **reviewer:** "Return a list of findings. Each: `file:line`, one-sentence defect, concrete failure scenario (input/state → wrong behaviour). If there are none, say `No findings.`"
- **verifier:** replace the verdict line with: "Return exactly one verdict: `CONFIRMED` (reproduced or proven from code), `REFUTED` (the code or a test contradicts the finding), or `UNVERIFIABLE` (cannot be decided from the code or by running a command; say what is missing). Follow with a one-paragraph justification with `file:line` evidence."
- **executor / executor-heavy:** "Return: files changed, the test command run with its pass/fail result, commit hash(es), and any deviation from the plan."
- **ui-driver:** "Write evidence to the scratchpad directory you were given: `screenshots/`, `steps.md`, `console.md`, `network.md`. Reply with the directory path and a one-line summary. Do not evaluate."
- **ui-*-evaluator:** "Return findings as a list ordered by severity, each citing the evidence file it comes from. End with a one-line verdict."

- [ ] **Step 1: Write the failing test** `cgremlin/core/test/plugin/plugin-agents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(__dirname, '../../../..');
const pluginAgents = resolve(repo, 'plugin/agents');
const projectAgents = resolve(repo, '.claude/agents');
const NAMES = ['chore','executor-heavy','executor','matcher','planner','reader','reviewer','verifier',
  'ui-design-evaluator','ui-driver','ui-eng-evaluator','ui-pm-evaluator'];

function fm(file: string): { meta: Record<string, string>; body: string } {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

describe('cgremlin plugin agents', () => {
  it('has exactly the 12 agents', () => {
    expect(readdirSync(pluginAgents).filter((f) => f.endsWith('.md')).sort())
      .toEqual(NAMES.map((n) => `${n}.md`).sort());
  });
  for (const n of NAMES) {
    describe(n, () => {
      const { meta, body } = fm(resolve(pluginAgents, `${n}.md`));
      it('has name, third-person description, tools, model, effort', () => {
        expect(meta.name).toBe(n);
        expect(meta.description).toMatch(/^[A-Z][a-z]+s\b/);
        expect(meta.description).not.toMatch(/\b(you|your|I)\b/i);
        expect(meta.tools.length).toBeGreaterThan(0);
        expect(['opus', 'sonnet', 'haiku']).toContain(meta.model);
        expect(['low', 'medium', 'high', 'xhigh']).toContain(meta.effort);
      });
      it('states an output format', () => {
        expect(body).toMatch(/^## Output format$/m);
      });
      it('is symlinked from .claude/agents (single source)', () => {
        const p = resolve(projectAgents, `${n}.md`);
        expect(lstatSync(p).isSymbolicLink()).toBe(true);
        expect(realpathSync(p)).toBe(realpathSync(resolve(pluginAgents, `${n}.md`)));
      });
    });
  }
  it('reviewer runs on opus (§17)', () => {
    expect(fm(resolve(pluginAgents, 'reviewer.md')).meta.model).toBe('opus');
  });
  it('verifier verdict is CONFIRMED / REFUTED / UNVERIFIABLE', () => {
    const { body } = fm(resolve(pluginAgents, 'verifier.md'));
    for (const v of ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE']) expect(body).toContain(v);
  });
  it('executors can edit and run commands; ui-driver can drive a browser', () => {
    for (const n of ['executor', 'executor-heavy']) {
      const t = fm(resolve(pluginAgents, `${n}.md`)).meta.tools;
      for (const tool of ['Edit', 'Write', 'Bash']) expect(t).toContain(tool);
    }
    expect(fm(resolve(pluginAgents, 'ui-driver.md')).meta.tools).toContain('mcp__chrome-devtools');
    expect(fm(resolve(pluginAgents, 'ui-pm-evaluator.md')).meta.tools).toContain('mcp__chrome-devtools');
  });
});
```

  (`readlinkSync` import is unused — drop it.)
- [ ] **Step 2: Run, expect FAIL** (`plugin/agents` missing): `cd cgremlin/core && pnpm vitest run test/plugin/plugin-agents.test.ts`.
- [ ] **Step 3: Move and rewrite.** `mkdir -p plugin/agents && git mv .claude/agents/*.md plugin/agents/`. Rewrite each file's frontmatter per the table (frontmatter values are single-line, comma-separated `tools`), keep the body, append the `## Output format` section. Then create the links: `cd .claude/agents && for f in ../../plugin/agents/*.md; do ln -s "$f" "$(basename "$f")"; done` and `git add .claude/agents`.
- [ ] **Step 4: Verifier consumers.** `grep -rn "CONFIRMED\|REFUTED" cgremlin/core/src cgremlin/vscode/src bin/cgremlin | head -40`. For every place that branches on the verifier verdict, confirm `UNVERIFIABLE` is neither counted as confirmed nor dropped; if one does, add a failing test there first, then fix (Review Focus 3). If there are no consumers, note that in the commit message.
- [ ] **Step 5: Run, expect PASS.** The agents test, then `pnpm test` in `cgremlin/core`.
- [ ] **Step 6: Smoke the tools syntax.** In the worktree, `claude plugin validate plugin` (expect pass, no warnings about `tools`). In a throwaway `claude -p` session run from the worktree, ask `ui-driver` to list the tools it has; expect browser MCP tools present. If `mcp__chrome-devtools` (server-name form) is rejected or yields no tools, replace it with the explicit tool names the ui-check flow uses (`mcp__chrome-devtools__navigate_page`, `…take_screenshot`, `…take_snapshot`, `…click`, `…fill`, `…list_console_messages`, `…list_network_requests`, `…evaluate_script`, `…wait_for`) and update the test's `toContain`.
- [ ] **Step 7: Commit.** `feat(cgremlin-plugin): 12 agents with tools, effort, output formats; .claude/agents symlinked to the plugin`.

### Task 3: Local marketplace and manifest validation

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Modify: `cgremlin/core/test/plugin/plugin-manifest.test.ts` (add one test)

**Interfaces:**
- Consumes: `plugin/` (Tasks 1–2).
- Produces: marketplace `cgremlin-local` with plugin `cgremlin` → install id `cgremlin@cgremlin-local`.

- [ ] **Step 1: Failing test** (append in the same describe):

```ts
it('marketplace lists the plugin at ./plugin with the same version', () => {
  const mk = JSON.parse(readFileSync(resolve(root, '../.claude-plugin/marketplace.json'), 'utf8'));
  const pj = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
  expect(mk.name).toBe('cgremlin-local');
  const entry = mk.plugins.find((p: { name: string }) => p.name === 'cgremlin');
  expect(entry.source).toBe('./plugin');
  expect(entry.version).toBe(pj.version);
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Create** `.claude-plugin/marketplace.json`:

```json
{
  "name": "cgremlin-local",
  "owner": { "name": "guilleazoubel" },
  "plugins": [
    {
      "name": "cgremlin",
      "source": "./plugin",
      "version": "0.1.0",
      "description": "Context Gremlin agents and the qa-verify skill."
    }
  ]
}
```

- [ ] **Step 4: Run, expect PASS; then validate.** `claude plugin validate .` (marketplace) and `claude plugin validate plugin --strict` must both exit 0. Fix any reported issue (e.g. missing fields) and re-run.
- [ ] **Step 5: Commit.** `feat(cgremlin-plugin): local marketplace cgremlin-local`.

### Task 4: Install at user level and verify from another repo

**Files:** none in the repo (user-level state in `~/.claude/plugins`). Record the outcome in the Task 5 DECISIONS entry.

- [ ] **Step 1: Baseline the other repo.** `git -C ~/Projects/grace-frontend status --porcelain > $SCRATCH/gf-before.txt` (`$SCRATCH` is the session scratchpad).
- [ ] **Step 2: Install from the worktree.** `claude plugin marketplace add /Users/guilherme.azoubel/context-gremlin/.claude/worktrees/1b` then `claude plugin install cgremlin@cgremlin-local --scope user`. Record `git -C .claude/worktrees/1b rev-parse HEAD` as `$INSTALLED_COMMIT` (Task 5 uses it for `cgremlin-pre-1b`'s reasoning check).
- [ ] **Step 3: Resolve it from grace-frontend.** `cd ~/Projects/grace-frontend && claude -p "reply with the single word ok" --output-format stream-json --verbose --max-turns 1 > $SCRATCH/gf-init.jsonl`; then `grep -o 'cgremlin:qa-verify' $SCRATCH/gf-init.jsonl | head -1` and `grep -o 'cgremlin:reader' $SCRATCH/gf-init.jsonl | head -1` must both print a match (they appear in the `init` message's skills/slash_commands/agents lists). If the init message does not list skills, use `claude plugin details cgremlin` for the component inventory plus a `-p "/cgremlin:qa-verify"` dry check that the output is the skill's "What you are given" prompt, not "Unknown command". Do not let the skill run against a real ticket.
- [ ] **Step 4: Prove nothing changed there.** `git -C ~/Projects/grace-frontend status --porcelain > $SCRATCH/gf-after.txt && diff $SCRATCH/gf-before.txt $SCRATCH/gf-after.txt` → no output. Also `ls -a ~/Projects/grace-frontend/.claude 2>/dev/null` is unchanged from before (compare to a pre-Step-3 listing).
- [ ] **Step 5: Repo agents still load.** From the worktree, `claude agents` (or a `-p` init dump) lists the 12 bare-named agents once each (no duplicates from the symlinks) — Review Focus 1.
- [ ] **Step 6: Report** the evidence (the grep matches, empty diff) to the user in the task result; no commit.

### Task 5: Review, release, and cleanup

**Files:**
- Modify: `cgremlin/core/docs/DECISIONS.md` (new entry: plugin layout, symlink choice, effort table, verifier verdict, why executor stays on sonnet pending the step 12 A/B, no evals because SKILL.md is byte-identical)
- Modify: `RELEASES.md` (new row)
- Modify: `docs/superpowers/plans/2026-10-05-cgremlin-program.md` (tracker row 1b, Log row)

- [ ] **Step 1: Gates in the worktree.** `pnpm test`, `pnpm typecheck`, `pnpm lint` in `cgremlin/core` and in `cgremlin/vscode` — all pass. Paste the summary lines.
- [ ] **Step 2: DECISIONS.md entry**, then commit `docs(cgremlin-core): decisions for step 1b`.
- [ ] **Step 3: Fresh-context review.** Review pipeline from CLAUDE.md: `reader` agents gather the diff `mission-control-pr-orchestrator..step/1b` → `reviewer` over the Review Focus above → one `verifier` per finding in parallel. Fix every CONFIRMED finding (tests first), re-run the gates, commit. Findings marked UNVERIFIABLE are listed for the user.
- [ ] **Step 4: Step 2 check.** `git branch --list 'step/2'` and `git tag -l 'cgremlin-2'`. If step 2 has released, `git rebase` (or merge, whichever step 1 used: `git log --merges` shows merge commits) `step/1b` onto the new `mission-control-pr-orchestrator`, re-run all gates, and note it in the log.
- [ ] **Step 5: Tag the baseline.** `PRE=$(…)` is the commit of the build installed right now: read the last row of `RELEASES.md` and the `~/cgremlin-releases/` build currently installed (the commit in that row, `b1a096b` for `cgremlin-1` unless step 2 or another release has landed since). `git tag cgremlin-pre-1b <that commit>`; confirm with `git rev-parse cgremlin-pre-1b`. Show the user the commit and why.
- [ ] **Step 6: Merge.** In `/Users/guilherme.azoubel/context-gremlin`: `git merge --no-ff step/1b -m "Merge step/1b: cgremlin plugin (agents + qa-verify) (cgremlin-1b)"` (same style as step 1), then `git tag cgremlin-1b`.
- [ ] **Step 7: Build and save the vsix** exactly as the RELEASES.md checklist prescribes into `~/cgremlin-releases/cgremlin-vscode-0.0.1-1b-built-<date>.vsix` (the extension code is unchanged apart from tests; the build keeps the checklist uniform). Ask before installing it over the current extension.
- [ ] **Step 8: Re-point the marketplace at the main checkout** (Review Focus 4): `claude plugin marketplace remove cgremlin-local && claude plugin marketplace add /Users/guilherme.azoubel/context-gremlin && claude plugin install cgremlin@cgremlin-local --scope user`, then repeat Task 4 Steps 3–4 (grace-frontend resolves `cgremlin:qa-verify`, status unchanged).
- [ ] **Step 9: RELEASES.md row** (Date 2026-10-06 or today | `cgremlin-1b` | merge commit | saved build | "**1b:** `cgremlin` plugin 0.1.0 (12 agents + `qa-verify`), local marketplace `cgremlin-local`, installed at user level; `.claude/agents` symlink to `plugin/agents`" | `cgremlin-pre-1b`) plus a `cgremlin-pre-1b` baseline row like the earlier `pre` rows. Tracker: row 1b → `✅ done <date>`, release tag `cgremlin-1b`, plan link; Log row. Commit `docs(cgremlin): release 1b in RELEASES.md; tracker marks 1b done`.
- [ ] **Step 10: Push.** Ask the user, then run exactly `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-1b refs/tags/cgremlin-1b` (the user will get the permission prompt).
- [ ] **Step 11: Remove the worktree** only after Step 8 passed and the user confirms: `git worktree remove .claude/worktrees/1b && git branch -d step/1b`.

---

## Self-review

- **Spec coverage:** plugin.json + 12 agents with third-person descriptions, `tools`, output format, model/effort per §17, reviewer on Opus, verifier three-way verdict (Task 2); `skills/qa-verify` single source with the fence-sync tests kept (Task 1); local marketplace, user-level install, resolution in grace-frontend, `claude plugin validate` (Tasks 3–4); `qaSkillCommand` already defaults to `/cgremlin:qa-verify` (no change; Review Focus 5 tests); `.claude/agents` decision made here (symlinks); release with plugin version in the RELEASES row (Task 5).
- **Open choices flagged for review:** `executor` stays sonnet·high and `executor-heavy` opus·high (§17 lists opus·high as primary and sonnet+advisor as an A/B arm — say so if you want executor on opus now); `ui-eng-evaluator` moves to opus·medium (§17 "evaluators opus medium"); no evals because `SKILL.md` is a pure rename.
- **Type/name consistency:** `cgremlin-local`, `cgremlin@cgremlin-local`, `plugin/`, `$INSTALLED_COMMIT` and tag names are used identically across tasks.
