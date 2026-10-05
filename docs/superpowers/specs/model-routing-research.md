# cgremlin model + effort routing: research notes (as of 2026-10-01)

Raw source dumps used for this note are in `scratchpad/src/` (Codex docs .md, OpenAI pricing, etc.).

---

## 0. Corrections to the "known Claude facts"

| Brief said | What current docs say | Source |
|---|---|---|
| "xhigh is best for most coding/agentic work on recent models and is Claude Code's default" | That guidance is written for **Opus 4.7 / 4.8** ("Start with `xhigh` for coding and agentic use cases"). For **Opus 5.5 and Sonnet 5.5, the Claude Code default is `medium`**. Opus 4.7 defaults to `xhigh`, every other model to `high`. For Opus 5.5 the API page says: "Run an effort sweep on your own evals rather than carrying settings over from an earlier model." Claude Code docs: "In Anthropic's testing, Opus 5.5 at `medium` matches or exceeds Opus 5 at `high` on coding and knowledge-work evaluations." | platform.claude.com/docs/en/build-with-claude/effort; code.claude.com/docs/en/model-config (both fetched 2026-10-01) |
| xhigh general guidance | The API table says `xhigh` = "Long-running agentic and coding tasks (over 30 minutes) with token budgets in the millions"; `high` = "Complex reasoning, difficult coding problems, agentic tasks"; `medium` = "Agentic tasks that require a balance of speed, cost, and performance"; `low` = "Simpler tasks ... such as subagents". | effort page |
| Fable 5.1 | "Start with `high`, the default. Step up to `xhigh` or `max` for the most capability-sensitive agentic and coding work." | effort page |
| Sonnet 5.5 | API default is `high`, Claude Code default `medium`. "For agentic coding and multistep tool use, start with `medium` for well-specified tasks and move to `high` for harder or longer ones." `xhigh`/`max` "only where your evals show a quality gain." Set `max_tokens` to 128K for agentic coding. | effort page |
| Opus 5.5 vs Fable 5.1 | Anthropic launch post (2026-09-22): Opus 5.5 "performs at the level of Claude Fable 5.1 on most work". Opus 5.5 scores higher on Terminal-Bench 4.0 (66.4 vs 55.8), FrontierCode v1.1 (54.4 vs 50.3), CursorBench 4.0 (57.8 vs 51.8). Opus 5.5 numbers are at **max effort**. Anthropic also says "In our own use, the gap between Opus 5.5 and Claude Fable 5.1 is narrower than these scores suggest." | anthropic.com/news/claude-opus-5-5 |

Implication: Opus 5.5 is the best default for nearly every stage. Fable 5.1 costs 2.5x as much and is an escalation target, not a default.

---

## 1. Claude Code CLI: per-invocation model and effort (from code.claude.com docs)

**Flags** (cli-reference):
- `--model <alias|full-id>`: aliases are `sonnet`, `opus`, `haiku`, `fable`. It overrides the `model` setting and `ANTHROPIC_MODEL`.
- `--effort low|medium|high|xhigh|max|ultracode`: sets effort for the session only and is not saved. It overrides the `modelSettings` and `effortLevel` settings. `ultracode` means xhigh plus ultracode workflows (v2.1.203+).
- Other flags useful for headless runs: `-p`, `--output-format text|json|stream-json`, `--json-schema`, `--max-turns`, `--max-budget-usd` (counts subagent spend), `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`, `--permission-prompts none` (v2.1.259+; denies prompts in unattended runs), `--append-system-prompt[-file]`, `--agents '<json>'` (accepts `model` and `effort` per agent), `--fallback-model sonnet,haiku`, `--bare` (skips CLAUDE.md, hooks, MCP and skills for fast scripted calls), `--no-session-persistence`, `-r/--resume <id>`, `--session-id <uuid>`, `--fork-session`, `--advisor <model>`, `--worktree`.

**Aliases** (model-config): `default`, `best` (Fable if available, otherwise Opus), `fable` (Fable 5.1), `opus` (Opus 5.5), `sonnet` (Sonnet 5.5), `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan` (Opus in plan mode, then Sonnet for execution; plan-mode only, so it is of little use in `-p` stage runs).

**Model precedence**: `/model`, then `--model`, then `ANTHROPIC_MODEL`, then the settings `model`, then `ANTHROPIC_DEFAULT_MODEL`. Pin aliases with `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`. The subagent default comes from `CLAUDE_CODE_SUBAGENT_MODEL`.

**Effort precedence**: (1) an explicit choice: the `CLAUDE_CODE_EFFORT_LEVEL` env var, `--effort`, or `/effort`. The docs list these three as one tier and don't say which wins between them (**uncertain**). (2) Saved settings: `modelSettings.<model-id>.effort` and the legacy `effortLevel`. (3) The model default.
- **Gotcha:** "A top-level `effortLevel` in your user settings file doesn't count for Opus 5.5". Use `modelSettings: {"claude-opus-5-5": {"effort": "..."}}` or pass `--effort`.
- **Gotcha:** if the orchestrator's environment exports `CLAUDE_CODE_EFFORT_LEVEL`, that value can override per-stage intent. Pass `--effort` on every invocation and unset the env var.

**Subagent frontmatter** (sub-agents): `model` takes `sonnet|opus|haiku|fable|<full-id>|inherit`. `effort` takes `low|medium|high|xhigh|max` (it overrides the session effort; the default is inherit). Model resolution order: per-invocation param, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. Other fields: `maxTurns`, `permissionMode`, `isolation: worktree`, `omitClaudeMd`, `tools`, `disallowedTools`, `skills`, `mcpServers`, `background`.

**Advisor tool** (code.claude.com/docs/en/advisor; experimental, Anthropic API only): `--advisor opus|fable|sonnet` works in `-p` (v2.1.260+). The advisor gets the full transcript at decision points (choosing an approach, a recurring error, before declaring done). The advisor must be at least as capable as the main model. Opus 5.5 main accepts a Fable or Opus 5+ advisor. Sonnet 5.5 main accepts Fable, Opus 5+, or Sonnet 5.5. Haiku 4.5 main accepts Fable, Opus, or Sonnet. The docs say it "typically costs less than running the stronger model throughout." This is Anthropic's built-in planner/executor split.

**Template:**
```
claude -p "$PROMPT" --model opus --effort high \
  --output-format stream-json --verbose \
  --permission-mode acceptEdits --permission-prompts none \
  --max-turns 200 --max-budget-usd 10 \
  --append-system-prompt-file stages/implement.md
```

---

## 2. OpenAI Codex CLI (learn.chatgpt.com docs, formerly developers.openai.com/codex)

### Current models (Codex docs, fetched 2026-10-01)

| Model ID | Positioning (OpenAI wording) | API price $/MTok in/out (cached in) | Reasoning effort |
|---|---|---|---|
| `gpt-6-astra` | "Our most capable model for complex work across code, apps, and research" | 10 / 50 (1.00) | low, medium, high, xhigh, max (API); Codex docs: "Start with ... **Light** for Astra" (Light = `low` in config) |
| `gpt-6.1-sol` (released 2026-09-29) | "Near-Astra performance for complex work at a lower cost than Astra. Consider it for repeated, long-running work." **Recommended Codex default for complex coding.** | 2 / 10 (0.10) | low, medium (default), high, xhigh, max; in Codex up to "Ultra" (Ultra means subagents). No `none`/`minimal`. |
| `gpt-6-luna` | "Most efficient model for focused, high-volume tasks, including summarization, extraction, and focused coding" | 0.10 / 0.50 (0.01) | none, low, medium (default), high, xhigh, max (no Ultra); Codex: "Start with **High** for Luna" |
| `gpt-6-sol` | previous Sol (2026-09-22) | 2 / 10 (0.20) | includes `none` |

All four models have a 1.05M context and 128K max output. Prompts over 272K input tokens cost 2x input and 1.5x output. Fast mode costs 2x. Batch and Flex cost 50% less.

**Retirements:** with ChatGPT sign-in, `gpt-5.5` leaves Codex on **2026-10-14**. `gpt-5.4` and `gpt-5.4-mini` left on 2026-08-31 (replacements: `gpt-6-sol` and `gpt-6-luna`). `gpt-5.3-codex-spark` retired 2026-09-14. `gpt-5.2` and `gpt-5.3-codex` are deprecated. API-key auth is not affected by these. **Don't hardcode any gpt-5.x model.** The older `-codex` model line is gone.

**OpenAI effort guidance** (API model-selection page): Luna·Low for "fine-grained edits, well-scoped problem-solving". Luna·Extra high for "problems with clear constraints". **Sol·Medium for "complex technical work and coordinated deliverables you expect to revise"**. Sol·Extra high for "decisions built from conflicting evidence". Astra·Medium/Extra high for "demanding analysis ... exacting requirements". Codex models page: "Start with the default effort and increase it when the task needs deeper planning or analysis... Most tasks do not need Max or Ultra." It also warns that "Reasoning efforts don't map exactly between model generations."

**Astra behavior caveats** (GPT-6 guide): Astra is "more likely to ask the user a question when additional input could materially change the result. This can cause it to stop when the user may expect it to make reasonable assumptions". That is bad for headless stages unless the prompt biases it toward action (OpenAI gives a prompt for this). Astra is also "more sensitive to instructions contained in ... AGENTS.md" and tends toward over-broad testing on small tasks.

### Headless invocation (developer-commands, non-interactive-mode, config-reference)
- Model: `codex exec -m gpt-6.1-sol ...` or `model = "..."` in config.toml.
- Effort: `-c model_reasoning_effort="high"`. Documented values: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; "Available levels depend on the model and client". There is also `plan_mode_reasoning_effort`. `-c` values parse as TOML.
- Sandbox: `codex exec` is **read-only by default**. Use `-s/--sandbox read-only|workspace-write|danger-full-access`. **`--full-auto` is deprecated** in favor of `--sandbox workspace-write`. `--dangerously-bypass-approvals-and-sandbox` / `--yolo` is only for an isolated VM.
- Approvals: `approval_policy` is `on-request | never | {granular=...}`. `untrusted` is unsupported and `on-failure` is deprecated. The documented CI combo is `--sandbox read-only --ask-for-approval never`. The `codex exec` flag table does not list `-a` (it is a global flag that "mostly propagates"), so `-c approval_policy="never"` is the safe spelling (**uncertain whether exec needs it at all**).
- **Gotchas for an orchestrator:** in `workspace-write`, `<root>/.git`, `.codex` and `.agents` are **read-only**, so Codex cannot commit; keep git operations in the orchestrator. Network is **off** by default; enable it with `-c sandbox_workspace_write.network_access=true`. Runs need a git repo (otherwise pass `--skip-git-repo-check`). Pass `-C <worktree>` to set the workspace.
- Output: `--json` gives JSONL events (`thread.started{thread_id}`, `turn.started/completed/failed`, `item.*`, `error`). `turn.completed.usage` includes `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`. `-o/--output-last-message <path>` writes the final message; `--output-schema schema.json` gives a validated final JSON; `--ephemeral` skips writing rollout files; `--ignore-user-config` and `--ignore-rules` are for hermetic runs; `--profile <name>` layers `$CODEX_HOME/<name>.config.toml`.
- Resume: `codex exec resume <SESSION_ID> "follow-up"` or `codex exec resume --last [--all]`.
- Review: `codex review --uncommitted | --base <branch> | --commit <sha> [PROMPT]`. The config key `review_model` overrides the model used for review.
- Auth: use `CODEX_API_KEY` inline per invocation. Don't export it job-wide where repo code runs.
- AGENTS.md: Codex reads global `~/.codex/AGENTS.override.md` or `AGENTS.md`, then one file per directory from the git root down to the cwd (override, then AGENTS.md, then `project_doc_fallback_filenames`). Files are concatenated root-first, so closer files win. The cap is `project_doc_max_bytes` (32 KiB). **To reuse CLAUDE.md, set `project_doc_fallback_filenames = ["CLAUDE.md"]`.**

**Template:**
```
CODEX_API_KEY=... codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" \
  -s read-only -C "$WORKTREE" --json -o review.txt --output-schema findings.schema.json \
  "Review the diff against main for correctness bugs. Report only; do not edit."
```

---

## 3. Evidence summary

### 3a. Cross-family review vs self-review
- **Xiang et al., "Cross-Model LLM Code Review: Should you use Claude to review Codex or vice versa?" (arXiv 2607.21656, 2026-07-22).** The setup was claude-opus-4-7 (Claude Code 2.1.50) and gpt-5.5 (Codex CLI), both at high effort, on 116 LiveCodeBench hard/medium tasks. The reviewer could not run tests. Results: Claude reviewing Codex drafts raised pass rate 71.6% to 89.7% (p=.001). Codex self-review raised it to 84.5% (p=.022). **Codex reviewing Claude drafts lowered it 91.4% to 82.8% (p=.046)**: Codex "discard[ed] working solutions and rewr[ote] them", with an 11.2% regression rate. Claude self-review gave no gain. A review pass roughly doubled cost (about $1.40 per net fix). Limitations: one model pair, older models, competitive-programming tasks, no execution. **Takeaway:** a cross-family reviewer helps only when it is stronger or complementary. A reviewer allowed to *rewrite* can break correct code, so cross-family reviewers should report findings and a separate verifier should check them.
- **Goel et al., "Great Models Think Alike and this Undermines AI Oversight" (arXiv 2502.04313, Feb 2025).** They define the CAPA similarity metric. LLM judges favor more-similar models, and "as model capabilities increase, model mistakes are becoming more similar."
- **Kim et al., "Correlated Errors in LLMs" (ICML 2025, arXiv 2506.07962).** Across 350+ LLMs, "models agree 60% of the time when both models err." Shared provider or architecture raises the correlation, but "larger and more accurate models have highly correlated errors, even with distinct architectures and providers." So diversity helps but does not make errors independent.
- **Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations" (NeurIPS 2024, arXiv 2404.13076).** Self-recognition is linearly correlated with self-preference bias. This argues for different-model judges for the UI-evaluator and acceptance stages.
- **Zietsman, "The Specification as Quality Gate" (arXiv 2603.25773, Mar 2026; position paper with small experiments).** Without an executable specification, AI review of AI code is circular. A cross-family panel still missed domain-convention bugs, and Claude confidently asserted a wrong rule. **Takeaway:** ground review and verification in tests and execution, not opinion.

### 3b. More reasoning is not always better
- **Gema et al., "Inverse Scaling in Test-Time Compute" (Anthropic et al., arXiv 2507.14417, Jul 2025, rev. Dec 2025).** Longer reasoning hurts on some tasks. "Claude models become increasingly distracted by irrelevant information." o-series models "overfit to problem framings". Models drift to spurious correlations and lose focus on long deductive tasks. Relevant to evaluator and triage stages that receive noisy evidence: curate the evidence, and don't max out effort.
- **Cuadron et al., "The Danger of Overthinking" (arXiv 2502.08235, Feb 2025).** On SWE-bench Verified (4,018 trajectories), reasoning models show analysis paralysis, rogue actions and premature disengagement. Picking lower-overthinking runs gave about 30% better performance at 43% lower cost.
- Vendor guidance agrees. Anthropic (Opus 4.7 table): `max` "can lead to overthinking" on structured-output or less intelligence-sensitive tasks. OpenAI: "Most tasks do not need Max or Ultra."

### 3c. Routing and cascades: cost per solved task
- FrugalGPT (Chen, Zaharia, Zou, arXiv 2305.05176, 2023) and RouteLLM (Ong et al., arXiv 2406.18665, 2024) showed early that cascades and routers can cut cost substantially at similar quality on chat/QA tasks.
- **SWE-Router (Son et al., arXiv 2607.00053, ICML 2026 DL4C workshop).** A cheap model explores for a few turns, then a value head reads the *partial trajectory* and decides whether to escalate. This "greatly improves the cost efficiency ... while maintaining the majority of the performances of the stronger model." Trajectory-based routing provably beats routing on the task description alone.
- **Scrouting / SuperScout (Bhola et al., arXiv 2608.04804, Aug 2026).** A 7B scout writes a sandbox-verified handoff, then a router picks among 4 frontier fixers. On SWE-bench Pro Python it solved 159 of 266 tasks vs 158 for the best single model, at about one-fifth the cost per solve. **The no-routing variant matched it, so the gain came from the verified handoff, not the routing.**
- Anthropic's guidance agrees: prefer the most capable model at lower effort before building cascades, and measure cost per completed task. OpenAI says Astra "achieved stronger results using substantially fewer output tokens ... estimated API cost per task was lower than earlier models despite its higher per-token pricing" (GPT-6 guide).
- **Takeaway for cgremlin:** escalate based on observed failure (fix round N fails, so raise effort, model, or family), not on up-front difficulty guesses. Invest in good stage handoffs (spec, ticket, repro), since they matter more than router cleverness.

### 3d. Planner/executor splits
- **Aider architect/editor (aider.chat, 2024-09-26).** o1-preview as architect with DeepSeek or o1-mini as editor reached 85% (SOTA on the edit benchmark), and the split raised many models' scores over their solo runs. **R1 + Sonnet (2025-01-24)** reached 64.0% on polyglot at 14x less cost than the earlier o1 SOTA. That evidence is from 2024-25 models.
- Claude Code's current equivalents: the **advisor tool** (strong model consulted at decision points; documented as cheaper than running the strong model throughout) and `opusplan` (plan mode only).
- cgremlin already splits this way (planning chat produces a spec and tickets for implement), which matches the evidence. The open question is whether the executor can be cheaper. Given Opus 5.5 at medium ≈ Opus 5 at high, and that Sonnet 5.5 and gpt-6.1-sol cost half as much, a Sonnet 5.5 or Sol executor with an Opus advisor is plausible. **There is no direct 2026 benchmark for this; run an A/B.**

### 3e. Late-2026 benchmarks (cite cautiously)
- Anthropic (2026-09-22; Opus 5.5 at max effort). Terminal-Bench 4.0: Opus 5.5 66.4, GPT-6 Astra 57.9, Fable 5.1 55.8, Opus 5 52.3, GPT-5.6 Sol 37.3. FrontierCode v1.1: Opus 5.5 54.4, Astra 53.3, Fable 5.1 50.3. AutomationBench: Astra 41.4, Opus 5.5 40.0. Terminal-Bench-Science: Astra 64.6, Opus 5.5 58.7.
- Vals.ai Terminal-Bench 4.0 (mini-swe-agent harness, updated 2026-09-29; read through a summarizer, **verify before relying on it**): Opus 5.5 65.15% ($13.20/task), Sonnet 5.5 64.14% ($16.51), Astra 59.60% ($9.58), Fable 5.1 58.08%. GPT-6.1 Sol is 55.05% ±1.82 (rank 6/42, from its model page).
- Third-party claims, not verified: GPT-6.1 Sol is near Astra on the AA index at about a fifth of the cost per task, and Opus 5.5 scores 89.9% on SWE-bench Pro. SWE-bench Verified has been frozen since Feb 2026 and carries no current models.
- No source found compares Claude Code against the Codex CLI *harness* end to end on current models.

---

## 4. Recommended routing table

Defaults are Claude Code with Opus 5.5. "Alt" means a cross-family second opinion or escalation. Prices are per MTok in/out: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Fable 5.1 $10/$50, Haiku 4.5 $1/$5, gpt-6.1-sol $2/$10, gpt-6-astra $10/$50, gpt-6-luna $0.10/$0.50.

| Stage | Primary (model, effort) | Alt / second opinion | Rationale (refs) |
|---|---|---|---|
| Planning chat (grilling, spec, tickets) | `opus`, `high` | Escalate to `fable`/`high` for large or ambiguous initiatives. Optional one-shot spec critique with `codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" -s read-only` | Interactive, so latency matters. Plan quality bounds everything downstream (advisor docs; Aider split). Opus 5.5 ≈ Fable 5.1 on most work (Anthropic 09-22). A different-family critique of the *spec* is cheap diversity (Goel; Kim). **Uncertain:** high vs medium; sweep it. |
| Implement (TDD) | `opus`, `high`; `xhigh` when the ticket is expected to run more than about 30 min | `codex exec -m gpt-6.1-sol -c model_reasoning_effort="medium"` (OpenAI: Sol·Medium for complex technical work) as the cost-saving alternative or the A/B arm. Option: `sonnet`/`medium` + `--advisor opus` (**uncertain, needs A/B**) | Anthropic: high for difficult coding, xhigh for >30-min agentic work. Opus 5.5 at medium already ≈ Opus 5 at high. Tests give the executable spec (Zietsman). |
| Fix rounds (after failing checks) | Round 1: same model/effort as implement, resumed with failure output. Round 2: `opus`/`xhigh`, or add `--advisor fable`. Round 3+: **switch family**, `gpt-6.1-sol`/`xhigh`, or `fable`/`high` | Cross-family fixer on the second repeat failure | Escalate on observed trajectory (SWE-Router). Repeated same-model failures are correlated (Kim; Goel), so a family switch breaks the loop. The advisor targets "when an error keeps recurring". Avoid `max` (overthinking: Cuadron; Gema). |
| Fresh-context code review of diff | `opus`, `high`, read-only (`--permission-mode plan` or a restricted `--tools`) | **Parallel** `codex review --base main` or `codex exec -m gpt-6.1-sol -c model_reasoning_effort="high" -s read-only --output-schema`. **Report-only, never edit.** | Self-preference and similarity bias (Panickssery; Goel). Cross-family reviewers catch different things, but a Codex reviewer that rewrote Claude code *reduced* pass rate 91.4 to 82.8 with 11.2% regressions (Xiang 2607.21656). So collect findings from both and verify them separately. |
| Finding verification | `opus`, `high`; must reproduce each finding (failing test or command) before it counts | Verify with a different family than the reviewer that raised the finding (Codex finding gets a Claude verifier and vice versa) | "high: work where verification matters" (Claude Code docs). Execution-grounded checks beat opinion (Zietsman; the Xiang reviewer could not execute, which the authors say understates the gain). |
| Live UI check: browser driver | `sonnet`, `medium` | `opus`/`medium` if flows are complex | Many short tool calls. Anthropic: Sonnet 5.5 "agentic coding and multistep tool use, start with medium". Lower effort means fewer, terser tool calls (effort page). |
| Live UI check: PM/eng/design evaluators | `opus`, `medium`; give curated evidence (screenshots, DOM excerpts, acceptance criteria) | Make one evaluator cross-family (`gpt-6.1-sol`/`medium` via `codex exec -s read-only -i shot.png`) so the judge panel isn't the implementer's family | Judge bias toward similar models (Goel; Panickssery). Longer reasoning makes Claude more distractible by irrelevant input (Gema), so keep effort moderate and evidence tight. **Uncertain:** no direct study of UI-evaluator panels. |
| PR-comment triage | `sonnet`, `medium` | `opus`/`high` only for comments that require a design decision; `gpt-6-luna`/`high` is a very cheap classifier option | Classification plus light judgment. Luna is meant for "classification ... structured summaries" (Codex models page). |
| Integration acceptance check | `opus`, `high`; run the acceptance tests and judge results against the spec | Cross-family second judge (`gpt-6.1-sol`/`high`, read-only). If the two disagree, escalate to a human rather than averaging | Final gate, where correctness matters more than cost. Disagreement between diverse judges is the useful signal; agreement is weaker evidence than it looks (Kim: 60% shared errors). |
| Lead chat (state summary) | `sonnet`, `low` (or `medium` when reasoning over many stage results) | `haiku` for very short status pings | Summarization over orchestrator state is latency-sensitive (Sonnet 5.5: chat start medium/low). |
| Chores (commit messages, git ops) | `haiku` (no effort param), or `sonnet`/`low` | Codex `gpt-6-luna`/`low` for message text only | Do the git operations deterministically in orchestrator code; the LLM only writes text. Codex `workspace-write` makes `.git` read-only, so Codex can't commit anyway. |

### Operational notes
1. Pass `--effort` explicitly on every Claude invocation. Opus 5.5 ignores the legacy `effortLevel`, and `CLAUDE_CODE_EFFORT_LEVEL` silently overrides everything.
2. Pin models by full ID in the orchestrator config (e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5`, `gpt-6.1-sol`) so alias changes don't shift behavior. Codex `gpt-5.5` stops working under ChatGPT sign-in on 2026-10-14.
3. Log cost per *completed ticket*: Claude `--output-format json` cost fields; Codex `turn.completed.usage`. Run a small effort sweep (medium/high/xhigh) on about 10 real tickets before locking the implement and fix rows. Both vendors say to sweep rather than carry settings over.
4. For headless Astra runs, add OpenAI's "bias towards action" prompt, because Astra tends to stop and ask.
5. Set `project_doc_fallback_filenames = ["CLAUDE.md"]` in Codex so both CLIs read the same repo instructions.

---

## Sources (accessed 2026-10-01 unless noted)
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code model config: https://code.claude.com/docs/en/model-config
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code advisor: https://code.claude.com/docs/en/advisor
- Claude API effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Claude Opus 5.5 launch (2026-09-22): https://www.anthropic.com/news/claude-opus-5-5
- Codex models: https://learn.chatgpt.com/docs/models (redirect from developers.openai.com/codex/models)
- Codex non-interactive: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex CLI commands: https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex approvals/sandbox: https://learn.chatgpt.com/docs/agent-approvals-security
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI model selection: https://developers.openai.com/api/docs/guides/model-selection
- GPT-6 guide: https://developers.openai.com/api/docs/guides/latest-model
- GPT-6.1 Sol model page: https://developers.openai.com/api/docs/models/gpt-6.1-sol
- Vals GPT-6.1 Sol: https://www.vals.ai/models/openai_gpt-6.1-sol ; Terminal-Bench 4.0: https://www.vals.ai/benchmarks/terminal-bench-4
- Xiang et al. 2026: https://arxiv.org/abs/2607.21656
- Goel et al. 2025: https://arxiv.org/abs/2502.04313
- Kim et al. 2025: https://arxiv.org/abs/2506.07962
- Panickssery et al. 2024: https://arxiv.org/abs/2404.13076
- Zietsman 2026: https://arxiv.org/abs/2603.25773
- Gema et al. 2025: https://arxiv.org/abs/2507.14417
- Cuadron et al. 2025: https://arxiv.org/abs/2502.08235
- SWE-Router 2026: https://arxiv.org/abs/2607.00053
- Scrouting 2026: https://arxiv.org/abs/2608.04804
- RouteLLM 2024: https://arxiv.org/abs/2406.18665 ; FrugalGPT 2023: https://arxiv.org/abs/2305.05176 (numbers not re-fetched)
- Aider architect/editor: https://aider.chat/2024/09/26/architect.html ; R1+Sonnet: https://aider.chat/2025/01/24/r1-sonnet.html
