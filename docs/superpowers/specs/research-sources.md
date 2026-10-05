# Skill & Agent Rubric: verified against sources (v2, 2026-09-30)

Legend: **CONFIRMED** / **CORRECTED** / **NUANCED** (true but needs a qualifier) / **UNSOURCED** / **NEW**. `[n]` = source number in part (b).
Scoring stays as in draft (meets / partial / missing / n/a, cite line numbers).

---

## (a) Corrected rubric

### A. Discovery (frontmatter)

**A1. `name`** — CORRECTED.
- Open spec / API / claude.ai: required; 1–64 chars; lowercase a-z, 0-9, hyphens; no leading/trailing hyphen; no `--`; **must match the parent directory name**; no XML tags; must not contain reserved words "anthropic" or "claude" [1][4].
- Claude Code: `name` is **optional** (defaults to directory name); it sets the `/command`. Plugin skills become `/plugin-name:skill-name`. Reserved in Claude Code: folder `synced`, and anything named `anthropic-skills` or `anthropic-skills:*` [2].
- Gerund form (`processing-pdfs`) is only a *consider* recommendation; noun phrases (`pdf-processing`) and action forms (`process-pdfs`) are explicitly "acceptable". What the docs actually reject: vague names (`helper`, `utils`), overly generic names (`documents`), reserved words, and **inconsistent patterns within one collection** [1].
- Check: consistent naming convention across the whole skill set.

**A2. `description`** — CORRECTED (limits) / CONFIRMED (content).
- Content: third person ("Processes Excel files…", not "I can help…" / "You can use…"), says both *what* and *when*, includes key terms/triggers users would actually say [1][2]. CONFIRMED.
- Limits: 1,024 chars, non-empty, no XML tags is the **spec/API** rule [1][4]. In **Claude Code** the listing entry (description + `when_to_use` combined) is **truncated at 1,536 chars** (configurable: `skillListingMaxDescChars`), so **put the key use case first** [2]. If omitted, Claude Code uses the first non-empty body line [2].
- For portable skills keep it ≤1,024.

**A3. Not over-triggering / no sibling collision** — CONFIRMED [1][2][5][27].
- Docs: "Skill triggers too often → make the description more specific, or add `disable-model-invocation: true`" [2]. Context-engineering: "If a human engineer can't definitively say which tool should be used… an AI agent can't be expected to do better" [5].
- Evidence: SkillSeam: bland triggers pushed routing conflicts from 3/32 to 30/32 and inflated loaded-skill tokens 3.7x; overlapping ownership escalated conflicts 0→14/16 [27].
- Also check for "CRITICAL: You MUST use this skill when…" language in descriptions, which causes overtriggering on current models [3].

**A4. Invocation control** — CONFIRMED, with a precision fix [2].
- `disable-model-invocation: true` → only the user can invoke; the description is **removed from Claude's context entirely** (saves listing budget); also blocks preloading into subagents and running from a scheduled task. Use for side-effecting workflows (`/commit`, `/deploy`, `/send-slack-message`). If Claude tries anyway, Claude Code blocks it [2].
- `user-invocable: false` → hidden from `/` menu, but **Claude can still invoke it**. It's for background knowledge, *not* a safety control. To block Claude, use `disable-model-invocation` [2].

**A5. Tool permissions** — CORRECTED (important).
- In Claude Code, skill `allowed-tools` is a **pre-approval grant, not a restriction**: "It does not restrict which tools are available: every tool remains callable." The grant lasts only for the turn that invokes the skill [2].
- To *restrict*, use skill `disallowed-tools` (removes tools while the skill is active), or for subagents `tools` (allowlist) / `disallowedTools` [2][11].
- **Workspace trust does not gate `allowed-tools`**. A project skill can grant itself broad access even in `-p` runs in untrusted folders, so audit repo skills' `allowed-tools` [2].
- Least privilege = narrow patterns, e.g. `Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` or `Bash(git add *) Bash(git commit *)`, not `Bash` or `Bash(*)` [2].
- Spec: `allowed-tools` is **experimental**, space-separated, "support may vary" [4].

**A6. NEW — Frontmatter validity & exact field names** [2].
- Opening `---` must be line 1. Malformed YAML → skill loads **with no fields set**, so Claude can't match on description. **Unknown/misspelled fields are silently ignored** (e.g. `allowed_tools`, `disableModelInvocation` in a skill). Only `when_to_use` uses an underscore. Validate with `claude plugin validate .claude/skills` (v2.1.233+) or `skills-ref validate` [2][4].
- Current Claude Code SKILL.md fields (all optional; `description` recommended): `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context` (`fork`), `agent`, `background`, `hooks`, `paths`, `shell` (`bash`|`powershell`), `metadata`, `license`, `compatibility` [2].
- Command files in `.claude/commands/` accept the same fields **except `name` and `paths`** [2].

**A7. NEW — Portability of frontmatter** [2][4].
- Uploading to claude.ai / Skills API / `package_skill.py` allows only the spec's 6 fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). Any other field is a **hard error** ("Unexpected key(s) in SKILL.md frontmatter"). `!` injection doesn't work outside Claude Code. Enabling a personal skill on claude.ai (for Cowork/cloud/routines) counts as an upload [2].

**A8. NEW — Listing-budget cost** [2].
- Every model-invocable skill's description is in context every turn. The listing budget is **1% of the model's context window** (`skillListingBudgetFraction`, or `SLASH_COMMAND_TOOL_CHAR_BUDGET` for a fixed char count). On overflow, Claude Code drops descriptions **starting with the least-invoked skills** (names always stay). Diagnose with `/doctor`, `/context`, `/skill-doctor`. Mitigate with `disable-model-invocation`, `skillOverrides: "name-only"`, and trimming [2].
- Subagents: combined custom descriptions over 15,000 tokens trigger a startup warning [11].

**A9. NEW — Scoped activation** [2].
- Use `paths` (globs) for skills only relevant to certain files. Use `when_to_use` for trigger phrases (counts toward the 1,536 cap). Use `argument-hint` / `arguments` for parameterized user-invoked skills [2].

### B. Conciseness & progressive disclosure

**B1. Only context Claude lacks** — CONFIRMED [1][2][9].
- "Default assumption: Claude is already very smart… Does this paragraph justify its token cost?" [1]. CLAUDE.md test: "Would removing this cause Claude to make mistakes? If not, cut it" [9].

**B2. Body < 500 lines** — CONFIRMED, with a token target added [1][2][4].
- Spec adds metadata ≈100 tokens and body **<5,000 tokens recommended** [4].
- Claude Code: once invoked, the body **stays in context for the rest of the session**, so every line is a recurring cost [2].

**B3. One level deep, signposted; TOC** — CONFIRMED [1][4].
- Nested references make Claude partially read (`head -100`). Keep all references linked directly from SKILL.md. **Reference files >100 lines get a TOC at top.** Name files descriptively (`form_validation_rules.md`, not `doc2.md`) and organize by domain [1].
- Evidence: progressive disclosure changed runtime behavior (resources accessed 1.18→3.85 per trajectory, +4.1% verifier passes). Gains were weaker when success depends on exact output conventions or numeric thresholds, so keep those in SKILL.md [26].

**B4. No duplication with CLAUDE.md / other skills** — CONFIRMED (inferred) [9][27].
- CLAUDE.md is for broadly applicable facts; "For domain knowledge or workflows that are only relevant sometimes, use skills" [9]. SkillSeam: synonymous aliases produced non-canonical routes 0→15/32 [27]. No doc says "single source of truth" verbatim.

**B5. No time-sensitive info** — CONFIRMED [1].
- Put legacy content in an "Old patterns" `<details>` section [1]. Evidence: SWE-Skills-Bench found 3/49 skills **degraded** performance (up to −10%) because of **version-mismatched guidance** conflicting with project context [21].

**B6. NEW — Write for the skill's lifecycle** [2].
- Rendered SKILL.md is injected once and **not re-read**, so write standing instructions, not one-time steps. After auto-compaction only the **first 5,000 tokens** of each invoked skill are re-attached (25,000 total, most-recent first), so put critical rules early [2].

**B7. NEW — Paths** [1][2].
- Forward slashes only. Reference bundled files via `${CLAUDE_SKILL_DIR}` (or `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}`). Injected commands run in the session's *current* cwd, which moves with `cd` [1][2].

### C. Instructions

**C1. Right altitude + the why** — CONFIRMED, with a nuance [3][5][2].
- "Specific enough to guide behavior effectively, yet flexible enough to provide… strong heuristics"; avoid both brittle hardcoded logic and vague guidance [5]. "Providing context or motivation… explaining… why… Claude is smart enough to generalize from the explanation" [3].
- Nuance: the Claude Code skills page says "State what to do rather than narrating how or why" [2]. Reconcile as: give a one-clause *why* where it changes behavior, and no narrative essays.

**C2. Degrees of freedom match fragility** — CONFIRMED [1] (narrow bridge vs open field; low/medium/high freedom).

**C3. Checklists for multi-step tasks** — CONFIRMED with a caveat [1][25].
- Copyable checklist for "particularly complex workflows" [1].
- Caveat: "Agent Skills Can Be Harmful" found skills that "turn validation checklists and construction recipes into mandatory work" caused efficiency regressions (182 of 307 failures), including **67 cases of unnecessary verification** [25]. Make checklists **conditional** ("for batch/destructive ops…"), not universal.

**C4. Feedback loop / definition of done** — NUANCED [1][9][10][25].
- Keep: run validator → fix → repeat. Use plan-validate-execute for batch, destructive or high-stakes ops. Validators give specific error messages. Show evidence (test output, command + result) [1][9].
- Correct: **don't add generic "double-check / re-verify / use a subagent to verify" instructions**. Opus 5 docs say these cause over-verification and should be removed, because the model self-verifies [10]. Prefer a *runnable deterministic check* (test, build, script, Stop hook) over prose "verify" steps [9].

**C5. Default path, not a menu** — CONFIRMED [1] ("Provide a default (with escape hatch)").

**C6. Concrete examples** — CONFIRMED [1][3][5].
- Input/output pairs. Prompting guide: 3–5 examples that are relevant, **diverse**, and wrapped in `<example>` tags [3]. "Curating diverse, canonical examples rather than… exhaustive edge case lists" [5]. Positive examples of the desired style beat "don't" instructions [10].

**C7. Consistent terminology** — CONFIRMED [1].

**C8. Tone / emphasis** — NUANCED [3][9][1].
- CONFIRMED: dial back aggressive language. "Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this tool when...'" [3]. "Tell Claude what to do instead of what not to do" [3]. Anti-laziness prompting overtriggers on 4.6+ models [3].
- Qualifier: emphasis isn't banned. The skills best-practices page uses "ALWAYS use this exact template" for strict formats and suggests "MUST filter" when a rule keeps being missed [1]. Claude Code: "If Claude keeps skipping one instruction, add emphasis such as 'IMPORTANT' to that line alone. If you emphasize many lines, none of them stands out" [9]. **Rubric: emphasis is rare, targeted, and justified by an observed failure.**
- Tool: the bundled Claude Code skill `prompt-audit` (v2.1.221+) flags instructions written for older models in skills and proposes diffs [2].

**C9. Manageable instruction count, prioritized** — CONFIRMED [12][9][13].
- IFScale: even the best frontier models reach only 68% accuracy at 500 simultaneous instructions, with a **bias toward earlier instructions** [12]. So put top-priority rules first. "Bloated CLAUDE.md files cause Claude to ignore your actual instructions" [9]. Context rot: performance degrades non-uniformly as input grows [13][5].

**C10. NEW — Explicit scope** [10][3].
- For narrow skills, state the scope and the stop point ("Deliver what was asked, at the scope intended…"). Current models may widen scope or overengineer [10][3].

**C11. NEW — `context: fork` used correctly** [2].
- Only for skills with an explicit **task**. A guidelines-only skill forked returns nothing useful. The forked subagent **doesn't see conversation history**, so instructions must stand alone. It runs in the background by default (`background: false` to wait) with the narrower background tool set. Its edits bypass checkpoints (`/rewind` won't undo). `agent` picks the type (default `general-purpose`) [2].

**C12. NEW — Dynamic context injection used safely** [2].
- Syntax: `` !`cmd` `` at line start or after whitespace, or a fenced ` ```! ` block for multi-line. Runs **before** Claude sees the content; output is not re-scanned. Any non-zero exit **aborts the whole invocation**, so append `|| true` where non-zero is expected. Needs allow rules or `allowed-tools` or it aborts. Disabled by `disableSkillShellExecution` and for claude.ai-synced skills [2].
- Injected output (PR bodies, comments) is untrusted data (see F1).

### D. Tools layer

**D1. Deterministic work → bundled script** — CONFIRMED [1][6]. Scripts are "more reliable than generated code, save tokens… ensure consistency". "Sorting a list via token generation is far more expensive than simply running a sorting algorithm" [6].

**D2. Solve, don't punt; no magic constants; dependencies listed** — CONFIRMED [1][4]. ("Voodoo constants", Ousterhout's law; "List required packages in your SKILL.md".)

**D3. Execute vs read made explicit** — CONFIRMED [1].

**D4. Verifiable, token-efficient output; useful errors** — CONFIRMED [1][7].
- Verbose validator errors that name the available options [1]. Tools: pagination/filtering/truncation with sensible defaults, `concise`/`detailed` response modes, natural-language identifiers over UUIDs, errors that steer toward efficient strategies [7]. Poka-yoke inputs (e.g. absolute paths) [8]. SWE-agent: interface design (concise feedback, guardrails) drives agent performance [18].

**D5. MCP tools by fully qualified name** — CORRECTED (format).
- Platform docs give `ServerName:tool_name` [1]. In **Claude Code** tool names are `mcp__<server>__<tool>` (patterns `mcp__<server>`, `mcp__<server>__*` in `tools` / `allowed-tools`) [11]. Rubric: use the exact name the target harness exposes, and check it's current.

**D6. NEW — Permissions tied to the script** [2]. Pair `Bash(${CLAUDE_SKILL_DIR}/scripts/x.sh *)` in `allowed-tools` with the same path in the body, so exactly that command runs without a prompt [2].

**D7. NEW — Hooks for must-happen behavior** [9][14][2].
- "Unlike CLAUDE.md instructions which are advisory, hooks are deterministic." If a skill "seems to stop influencing behavior… use hooks to enforce behavior deterministically" [9][2].
- Skill `hooks` register on invocation and **persist for the rest of the session** (`once: true` removes after first success, honored only in skill frontmatter). Agent hooks run only while the subagent runs, and `Stop` becomes `SubagentStop` [14].

### E. Composability

**E1. Single responsibility** — CONFIRMED [11][20][27].
- "Design focused subagents" [11]. SkillsBench: **focused skills with ≤3 modules outperform larger/exhaustive bundles** [20]. SkillSeam: granularity misalignment caused the largest accuracy drop (−12.5 pp) [27].

**E2. Compose rather than copy** — CONFIRMED (inferred) [11][2][27]. Subagent `skills:` preloads skills. Skills can name other skills. Orthogonal coverage [27]. No doc says "compose" verbatim.

**E3. Portable (repo facts separated from method)** — UNSOURCED as stated. Related, sourced: portability of frontmatter (A7); domain-split reference files [1]. Keep as a judgment item.

**E4. NEW — Collection-level audit** [27][1]. Check the *set*: consistent naming, no overlapping ownership, no synonymous aliases, no dangling references (dangling anchors: +64% tokens, −3.1 pp accuracy) [27].

### F. Safety

**F1. Untrusted input treated as data** — CONFIRMED [16][17][15].
- "Once an LLM agent has ingested untrusted input, it must be constrained so that it is impossible for that input to trigger any consequential actions" [16]. Patterns: action-selector, plan-then-execute, LLM map-reduce, dual-LLM, code-then-execute, context-minimization [16]. CaMeL separates control flow from untrusted data flow (77% of AgentDojo tasks solved with provable security) [17]. XML-delimiting untrusted content helps parsing but is **not** a security boundary. (That last point is inferred from [16][17]; no source states it verbatim.)

**F2. Rule of Two** — CONFIRMED [15].
- Exact form: within a session an agent should satisfy **no more than two** of [A] processes untrustworthy inputs, [B] accesses sensitive systems or private data, [C] changes state or communicates externally. If all three are needed, it "should not be permitted to operate autonomously and at a minimum requires supervision — via human-in-the-loop approval or another reliable means of validation". Starting a fresh context window is the other escape [15]. Meta AI, 31 Oct 2025.

**F3. Human confirmation for irreversible/outward actions** — CONFIRMED [3][2]. Sample prompt: ask before destructive, hard-to-reverse, or visible-to-others actions (push, PR comments, messages) [3]. Pair with `disable-model-invocation: true` [2].

**F4. NEW — Skill supply-chain hygiene** [6][19][2].
- "Install skills only from trusted sources… thoroughly audit" others [6]. 26.1% of 31,132 marketplace skills had ≥1 vulnerability. Skills bundling scripts were **2.12x** more likely to be vulnerable [19].
- Audit `allowed-tools`, `hooks`, `!` commands, and scripts in any third-party or repo skill. Project skill hooks and `allowed-tools` apply even before workspace trust [2][14].

### G. Evaluation & improvement

**G1. Evals vs baseline** — CONFIRMED and strengthened [1][2][20][21].
- "Create evaluations BEFORE writing extensive documentation." Steps: identify gaps without the skill → build **≥3** scenarios → baseline → minimal instructions → iterate [1].
- Claude Code: measure **triggering** and **output quality** separately. Run each prompt in a **fresh session** with and without the skill (`skillOverrides: "off"`). Tools: `skill-creator` plugin (`evals/evals.json`, blind A/B, description tuning) and `claude plugin eval` (CI gate) [2].
- Why it matters: SWE-Skills-Bench found 39/49 public SWE skills gave **zero** pass-rate gain (avg +1.2%), with token overhead up to +451% [21]. SkillsBench found curated skills gave +16.6 pp on average [20].

**G2. "Known pitfalls / lessons" section** — NUANCED [22][1]. Supported by ACE's evolving playbook of itemized insights [22] and "Old patterns" sections [1]. Keep it pruned so it doesn't bloat the body (B2/C9).

**G3. Defined update mechanism; incremental deltas** — CONFIRMED [22][23][20][24].
- ACE: wholesale rewrites cause **context collapse**, and summarizers show **brevity bias**. Use structured, incremental delta updates (generator/reflector/curator) [22].
- Qualifiers: self-evolution is "sparse, validation-filtered search… rather than steady improvement" (55/388 candidates improved). Failed trajectories were in every successful selection [24]. **Self-generated skills gave negligible or negative gains** without curation [20]. So the rubric needs a human- or eval-gated acceptance step for edits.

**G4. Tested on the models that run it** — CONFIRMED [1] (Haiku: enough guidance? Sonnet: clear and efficient? Opus: avoids over-explaining?). Also check `model:` / `effort:` pins are deliberate [2].

**G5. NEW — Claude A / Claude B iteration** [1]. One instance authors/refines, a fresh instance tests on real tasks, and observations go back to the author [1].

**G6. NEW — Observe navigation** [1][6]. Watch for unexpected read order, missed links, over-read files (promote into SKILL.md), and never-read files (delete or signpost better) [1].

**G7. NEW — Prune unused skills** [2]. `/skill-doctor` shows per-skill context cost and invocation counts [2].

### H. Subagents (`.claude/agents/*.md`)

**H1. Description says when to delegate** — CONFIRMED [11]. "Write descriptions that single out one subagent"; include "use proactively" to encourage automatic delegation [11].

**H2. Tools restricted; model pinned deliberately** — CONFIRMED [11].
- `tools` inherits **all** tools if omitted. Use `disallowedTools` to subtract (applied before `tools`). Omit `Agent` to stop nesting. Default nesting depth is 3 [11].
- `model`: `sonnet` / `opus` / `haiku` / `fable` / full ID / `inherit`. Resolution order: per-invocation param → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → main model [11].

**H3. Single responsibility; input contract & output format** — CONFIRMED [11][5].
- The subagent **does not see conversation history, invoked skills, or files already read**. The body **replaces** the Claude Code system prompt. CLAUDE.md + git status + preloaded `skills` + a sibling roster do load (Explore/Plan skip CLAUDE.md). So the body must define what it expects in the delegation message [11].

**H4. Condensed results** — CONFIRMED [5]. "Returns only a condensed, distilled summary of its work (often 1,000–2,000 tokens)" [5].

**H5. NEW — Exact subagent frontmatter (camelCase)** [11].
- `name` (req; no leading `-`, no `:`), `description` (req), `tools`, `disallowedTools`, `model`, `permissionMode` (`default`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`/`plan`/`manual`), `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` (`user`/`project`/`local`), `background`, `omitClaudeMd`, `effort`, `isolation` (`worktree`), `color`, `initialPrompt`, `experimental` (`cacheTtl`) [11].
- **Plugin agents ignore `hooks`, `mcpServers`, `permissionMode`** [11]. Note the casing difference: skills use kebab-case (`disallowed-tools`), agents use camelCase (`disallowedTools`) [2][11].

**H6. NEW — Don't over-delegate / over-verify** [3][10]. Current models spawn subagents readily. Agent descriptions shouldn't invite delegation for small tasks, and "do not use subagents to verify or double-check your own work" [10].

### V. Video's 4 rules (UNSOURCED as a framework; mapped)
- V1 replaces a repeated prompt: aligns with the Claude Code guidance "Create a skill when you keep pasting the same instructions…" [2] and with the Claude A step "Notice what information you repeatedly provide" [1]. **Confirmed in spirit.**
- V2 beyond prose: D1 [1][6].
- V3 composable: E1 [11][20].
- V4 self-improving: G3, with the qualifier that improvement needs validation gates and isn't monotonic [22][24][20].

---

## (b) Sources

1. Anthropic, "Skill authoring best practices", platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices (live doc, accessed 2026-09-30).
2. Anthropic, "Extend Claude with skills", code.claude.com/docs/en/skills (live doc, accessed 2026-09-30; versions up to v2.1.28x referenced).
3. Anthropic, "Prompting best practices", platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (live doc, accessed 2026-09-30).
4. Agent Skills open standard, "Specification", agentskills.io/specification (accessed 2026-09-30).
5. Anthropic Engineering, "Effective context engineering for AI agents", anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09-29).
6. Anthropic Engineering (B. Zhang, K. Lazuka, M. Murag), "Equipping agents for the real world with Agent Skills", anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills (2025-10-16).
7. Anthropic Engineering, "Writing effective tools for agents — with agents", anthropic.com/engineering/writing-tools-for-agents (2025-09-11).
8. Anthropic Engineering (E. Schluntz, B. Zhang), "Building effective agents", anthropic.com/engineering/building-effective-agents (2024-12-19).
9. Anthropic, "Best practices for Claude Code", code.claude.com/docs/en/best-practices (live doc, accessed 2026-09-30).
10. Anthropic, "Prompting Claude Opus 5", platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 (live doc, accessed 2026-09-30).
11. Anthropic, "Subagents", code.claude.com/docs/en/sub-agents (live doc, accessed 2026-09-30).
12. Jaroslawicz et al. (Distyl AI), "How Many Instructions Can LLMs Follow at Once?" (IFScale), arXiv:2507.11538 (2025-07).
13. Hong, Troynikov, Huber (Chroma), "Context Rot: How Increasing Input Tokens Impacts LLM Performance", research.trychroma.com/context-rot (2025-07). Details from secondary summaries; original not fetched.
14. Anthropic, "Hooks reference" (section "Hooks in skills and agents"), code.claude.com/docs/en/hooks (accessed 2026-09-30).
15. Meta AI, "Agents Rule of Two: A Practical Approach to AI Agent Security", ai.meta.com/blog/practical-ai-agent-security/ (2025-10-31).
16. Beurer-Kellner et al., "Design Patterns for Securing LLM Agents against Prompt Injections", arXiv:2506.08837 (2025-06).
17. Debenedetti et al. (Google/DeepMind/ETH), "Defeating Prompt Injections by Design" (CaMeL), arXiv:2503.18813 (2025-03).
18. Yang et al., "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering", arXiv:2405.15793 (NeurIPS 2024). Language models are a new kind of end user and need interfaces built for them. 12.5% SWE-bench pass@1 at the time.
19. Liu et al., "Agent Skills in the Wild: An Empirical Study of Security Vulnerabilities at Scale", arXiv:2601.10338 (2026-01-15).
20. "SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks", arXiv:2602.12670 (2026-02-13). Details from abstract/secondary summaries; authors not verified.
21. Han et al., "SWE-Skills-Bench: Do Agent Skills Actually Help in Real-World Software Engineering?", arXiv:2603.15401 (2026-03).
22. Zhang et al., "Agentic Context Engineering (ACE)", arXiv:2510.04618 (2025-10; ICLR 2026).
23. Suzgun et al., "Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory", arXiv:2504.07952 (2025-04). A persistent, evolving memory of reusable strategies/code across queries; the ACE paper builds on it.
24. Liu et al. (HKUST), "Rethinking Self-Evolving Agent Skills: Feedback Dynamics over Multiple Rounds", arXiv:2608.02636 (2026-07-31).
25. Dong et al., "Agent Skills Can Be Harmful: An Empirical Study of Skill-Induced Failures in LLM Agents", arXiv:2608.11888 (2026-08-12).
26. Chen et al., "SkillJuror: Measuring How Agent Skill Organization Changes Runtime Behavior", arXiv:2606.11543 (2026-06-10).
27. Kang, "SkillSeam: Six Principles for Auditing Agent Skill Collections", arXiv:2609.13321 (2026-09-10). Single-author, very recent: treat as preliminary.
28. Wang et al., "Voyager: An Open-Ended Embodied Agent with LLMs", arXiv:2305.16291 (2023-05). Skill library of executable code plus iterative prompting with env feedback, errors and self-verification. 3.3x more unique items; tech-tree milestones up to 15.3x faster.
29. Wang et al., "SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills", arXiv:2504.07079 (2025-04). Skills distilled into APIs: +31.8% relative on WebArena. Strong-agent skills transfer to weaker agents (up to +54.3%).
30. Wang, Mao, Fried, Neubig, "Agent Workflow Memory", arXiv:2409.07429 (2024-09). Induced reusable workflows: +24.6% (Mind2Web) and +51.1% (WebArena) relative. Beat human-written workflows by 7.9%.
31. Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning", arXiv:2303.11366 (NeurIPS 2023). Verbal self-reflection stored in episodic memory; 91% pass@1 on HumanEval.
32. Agrawal et al., "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning", arXiv:2507.19457 (ICLR 2026 oral). Reflecting on full traces beats GRPO by about 6% on average (up to 20%) with up to 35x fewer rollouts, and beats MIPROv2 by >10%.
33. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", arXiv:2307.03172 (TACL 2024). U-shaped recall: information at the beginning or end is used best.
34. Ding et al., "Agent Skill Evaluation and Evolution: Frameworks and Benchmarks" (survey), arXiv:2606.11435 (2026-06-09).

Not found / not verified: no Meta paper specifically on skill libraries or agent self-improvement prompting was found beyond the Rule of Two post. Chroma's report and SkillsBench details come from secondary summaries.

---

## (c) Top 12 principles

1. **Evaluate first, against a no-skill baseline, in fresh sessions.** Measure triggering and output quality separately. Most public skills show no measurable gain [1][2][21].
2. **The description is the router.** Third person, what + when, key terms first (Claude Code cuts at 1,536 chars; the spec caps at 1,024). No overlap with siblings [1][2][27].
3. **Every listed skill costs context every turn.** Use `disable-model-invocation` for manual or side-effecting skills and prune unused ones [2].
4. **Only write what Claude doesn't know.** Body under 500 lines / ~5k tokens, with critical rules in the first 5k tokens [1][2][4].
5. **Progressive disclosure, one level deep.** Signposted, descriptively named reference files; TOC on files over 100 lines [1][4][26].
6. **Match freedom to fragility.** Exact scripts for fragile ops, heuristics plus a short *why* for judgment work, and one default instead of a menu [1][3][5].
7. **Keep rules few, calm and ordered.** Priority rules first. Emphasis only on a line that has actually been ignored. Say what to do [3][9][12].
8. **Push determinism into code and hooks.** Scripts that handle their own errors and print specific messages; hooks for must-happen behavior [1][6][9].
9. **Verify with runnable checks, not prose.** Validators, tests, plan-validate-execute for risky or batch ops. Avoid blanket "double-check" steps and mandatory checklists on current models [1][10][25].
10. **Least privilege, correctly understood.** `allowed-tools` grants and doesn't restrict. Use `disallowed-tools` / agent `tools`. Audit third-party skills' scripts, hooks and `!` commands [2][11][19].
11. **Rule of Two.** Untrusted input + sensitive access + outward action in one session requires a human or another reliable validator. Treat injected or fetched content as data [15][16][17].
12. **Improve incrementally, gated by evals.** Delta edits, not rewrites (context collapse). Learn from failed trajectories. Accept an edit only after validation, since self-generated or self-evolved skills often don't help [20][22][24].
