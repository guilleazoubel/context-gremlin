# Senior PR Review Skill: Research Notes (2026-10-01)

Purpose: a review that sits on top of an existing CI AI review (general bugs and standards on every non-draft PR). This one covers placement, security, architecture fit, hacks/workarounds, alternatives (best vs easiest), scalability, maintainability, and regression risk. Rule: no inference. Every claim must come from code the reviewer actually read.

---

## 1. Human code review: what the evidence says

**Google Eng Practices: "What to look for"** (https://google.github.io/eng-practices/review/reviewer/looking-for.html)
- Order of checks: Design, Functionality, Complexity (including over-engineering: "more generic than it needs to be, or added functionality that isn't presently needed"), Tests ("tests actually fail when code breaks"), Naming, Comments (explain why), Style, Consistency, Docs, Every line, Context, Good things.
- Design asks: "does this change belong here, and is now the right time?" This is the placement and architecture lens.
- Context: look at the whole file and the system around it, because small changes can slowly degrade code health.

**Google: "The Standard of Code Review"** (https://google.github.io/eng-practices/review/reviewer/standard.html)
- Approve once the change "definitely improves the overall code health… even if the CL isn't perfect." There is no perfect code, only better code.
- "Technical facts and data overrule opinions and personal preferences." Design calls must rest on engineering principles, not taste. When nothing else applies, consistency with existing code is the default.
- Prefix optional comments with "Nit:".

**Google: comment writing** (https://google.github.io/eng-practices/review/reviewer/comments.html)
- Explain why. Often point out the problem and let the author pick the fix. Label severity (Nit / Optional / FYI). If the author explains something in a reply, ask for a code change or comment instead, so future readers get the explanation too.

**Bacchelli & Bird, ICSE 2013** (https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/)
- Finding defects is the stated motive, but actual outcomes lean toward knowledge transfer, awareness, and **alternative solutions**. "Code and change understanding" is the main challenge, and tools do not meet it well. This supports making an evidence-gathering phase mandatory.

**Bosu, Greiler, Bird, MSR 2015** (https://www.semanticscholar.org/paper/Characteristics-of-Useful-Code-Reviews:-An-Study-at-Bosu-Greiler/4c535cd6557b148cc048686ec64e20291b61c698)
- Comments about functional correctness were rated most useful. Comments about structure and **alternative approaches** were "somewhat useful". Across 1.5M comments, 64–68% were classified useful. So alternatives comments need concrete grounding to earn attention.

**SmartBear/Cisco** (https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/ ; https://static1.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf)
- 200–400 LOC per session and under 500 LOC/hour. Defect discovery falls beyond that. For an agent: split large PRs into review units, such as modules, and scale depth to size.

**Conventional Comments** (https://conventionalcomments.org/)
- `<label> [decorations]: <subject>` + discussion. Labels: praise, nitpick, suggestion, issue, todo, question, thought, chore, note. Decorations: (blocking), (non-blocking), (if-minor). A good fit for the finding format.

---

## 2. Architecture and design lenses

- **Ousterhout, A Philosophy of Software Design**: "Design it twice", i.e. consider several options for each major decision. Deep vs shallow modules (simple interface, lots of functionality). Red flags: shallow module, information leakage (one design decision repeated across modules leads to change amplification), temporal decomposition, pass-through methods. (Summary: https://newsletter.pragmaticengineer.com/p/the-philosophy-of-software-design)
- **SEI ATAM** (https://www.sei.cmu.edu/documents/2021/2003_004_001_14150.pdf ; https://en.wikipedia.org/wiki/Architecture_tradeoff_analysis_method): quality-attribute scenarios (stimulus → response → measure). Outputs are explicit **risks, non-risks, sensitivity points, tradeoff points**. For PRs: name the quality attribute at stake (modifiability, security, performance, availability) and write a concrete scenario, e.g. "when a 2nd locale is added, N files must change".
- **Design docs at Google, "Alternatives considered"** (https://www.industrialempathy.com/posts/design-docs-at-google/): list designs that would "reasonably achieve similar outcomes", including reusing an existing system or doing nothing, and focus on trade-offs. Called one of the most important sections.
- **ADR / MADR** (https://ozimmer.ch/practices/2022/11/22/MADRTemplatePrimer.html): Context → Decision Drivers → Considered Options → Pros/Cons per option → Outcome + Consequences. Use this as the template for the alternatives section.
- **Chesterton's fence** (https://hackerlaws.dev/chestertons-fence ; https://sph.sh/en/posts/chestertons-fence-in-software/): before flagging the removal or bypass of a guard, find out why it exists (git blame/log, linked issue, tests). The principle requires an investigation, and removal is an allowed outcome of it.
- **Hyrum's Law** (https://lawsofsoftwareengineering.com/laws/hyrums-law/): every observable behaviour gets depended on. Changes to ordering, error text, defaults, response shape, or timing are regression risks even when the "contract" is unchanged.

---

## 3. Regression-risk analysis

- **Change impact analysis in PRs** (Empirical Software Engineering, 2024: https://link.springer.com/article/10.1007/s10664-024-10600-2): adding impact analysis (affected dependents) to PRs helps reviewers find issues that come from changes elsewhere. Reviewers otherwise rebuild call graphs by hand.
- **Google mutation testing in review** (https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/): mutate only the changed lines during review and show surviving mutants. Test adequacy means "would a test fail if this line were wrong?", not coverage %.
- Practical evidence for an agent: (1) list every exported symbol, type, prop, route, env var, or DB/schema field that changed; (2) grep all callers and importers; (3) for each caller, check whether the new behaviour or contract still holds; (4) find the tests that exercise the changed path and judge whether they would fail on a plausible mutation; (5) check shared config, feature flags, caching keys, and serialized formats (Hyrum).

---

## 4. Security review for a TS/Next.js PR

- **OWASP Secure Code Review Cheat Sheet** (https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html): diff-based review. **Source → sink tracing** with validation "at each trust boundary crossing". Sources: user input, uploads, API calls, DB reads, env. Sinks: DB queries, file writes, rendering, logging, external APIs. Manual review wins on business logic and authorization.
- **OWASP ASVS 5.0** (May 2025, 17 chapters: encoding/sanitization, validation and business logic, web frontend, API, files, authN, session, authZ, self-contained tokens, OAuth/OIDC, crypto, comms, config, data protection, secure coding and architecture, logging/errors). (https://softwaremill.com/whats-new-in-asvs-5-0/)
- **Next.js "How to Think About Security"** (https://nextjs.org/blog/security-nextjs-server-components-actions) and the Data Security guide (https://nextjs.org/docs/app/guides/data-security). Audit list:
  - Data Access Layer: are DB packages and `process.env` imported only inside the DAL?
  - `"use client"` files: do props carry private data, and are type signatures too broad (whole `User`, `token`)?
  - `"use server"` files: are arguments validated (TS types are not enforced at runtime) and is the user re-authorized inside each action? Actions are reachable by direct POST. `.bind()` arguments are NOT encrypted.
  - `/[param]/` folders are user input. Is access re-verified (being on `/[team]` does not prove membership)?
  - `middleware.ts` and `route.ts` are escape hatches: CSRF is manual in route handlers, use allow-list matchers, and GET handlers with side effects need audit.
  - `NEXT_PUBLIC_` env vars are exposed to the client. `server-only` imports protect server modules. Use parameterized queries. Errors and stack traces must not reach the client.
  - Mixing data-handling models is itself a smell ("Exceptions pop out as suspicious").
- **Anthropic claude-code-security-review** (https://github.com/anthropics/claude-code-security-review): in scope are injection, authN/authZ/IDOR, data exposure/secrets/PII logging, crypto, business logic/TOCTOU, config (CORS, headers), supply chain, RCE, XSS. **Excluded by default as noise-prone:** DoS, rate limiting, memory/CPU exhaustion, generic input validation without proven impact, open redirect.
- **PrimeVul** (https://arxiv.org/pdf/2403.18624): code LMs that look strong on old benchmarks collapse on realistic data (68% → 3% F1). Unverified LLM vulnerability claims have a high false-positive base rate. A security finding needs a concrete source → sink path in this repo.

What an AI reviewer can reliably check from code: missing authZ check on a new action/route/handler; unvalidated input reaching a sink; secrets or PII in client bundles, logs, or `NEXT_PUBLIC_`; overly broad client props; raw SQL or `dangerouslySetInnerHTML` with tainted data; permissive CORS or headers in config; new dependencies (name, maintainer, postinstall). What it cannot reliably check: runtime infra, WAF, rate limits, and anything that depends on deployed config it cannot see. Report those as questions.

---

## 5. AI code review evidence (2024–2026)

- **Anthropic Code Review** (Mar 2026; https://claude.com/blog/code-review ; https://code.claude.com/docs/en/code-review): parallel agents find candidates, a **verification step checks candidates against actual code behaviour**, and results are ranked by severity. Output is one overview comment plus inline comments. <1% of findings marked incorrect. Substantive-comment rate went from 16% to 54% of PRs. Depth scales with PR size (under 50 LOC: 31% get findings, avg 0.5; over 1000 LOC: 84%, avg 7.5).
- **Claude Code code-review plugin** (https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md): confidence 0–100 with a ≥80 threshold. Filters out: pre-existing issues, things that look like bugs but are not, pedantic nitpicks, linter-catchable issues, general quality concerns unless codified in CLAUDE.md, and lint-ignored lines. Citations are full-SHA permalinks with line ranges. Includes a git-history agent.
- **Cursor Bugbot** (https://cursor.com/blog/building-bugbot): metric is **resolution rate**, i.e. was the flagged issue fixed by merge. Eight parallel passes with shuffled diff order, then majority vote (drop single-pass findings), then a validator model. Resolution rate went from 52% to over 70%. The later agentic version (dynamic context via tools) became "too cautious" and needed more aggressive investigation prompts. Lesson: investigate aggressively, report conservatively.
- **GitHub Copilot code review** (https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/ ; https://github.blog/ai-and-ml/github-copilot/better-tools-made-copilot-code-review-worse-heres-how-we-actually-improved-it/ ; agentic changelog https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/): "Silence is better than noise". It surfaces actionable feedback in about 71% of reviews and says nothing in the rest. Better tools at first made review worse: the agent browsed like a coding assistant. The fix was to start from the diff, narrow with grep/glob, read exact ranges, and then decide. That cut cost about 20% at the same quality. A useful comment states both the problem and the fix.
- **Atlassian RovoDev** (https://arxiv.org/html/2601.01129v2): generate, then an LLM-judge factual check, then an actionability classifier. Actionability filtering helped about 15 points more than the factual filter: vague comments are a bigger problem than hallucinated ones. Code-resolution rate 38.7% vs 44.5% for humans. Failures came from missing context (language, framework, version, conventions). Design comments are resolved least often in the same PR, and humans give more design feedback than the bot. That design gap is the opening for this skill.
- **HalluJudge** (https://arxiv.org/abs/2601.19072): the main failure mode is context misalignment, e.g. claiming SQL injection where no SQL changed. A grounding check (comment ↔ code) reaches F1 0.85.
- **Beko / Qodo PR-Agent** (https://arxiv.org/abs/2412.18531): 73.8% of comments resolved, but PR close time went up from 5h52m to 8h20m. Developers reported faulty reviews, unnecessary corrections, and irrelevant comments. Noise costs real time.
- **Google AutoCommenter** (https://arxiv.org/abs/2405.13565): over 50% rated helpful. Real-world acceptance differed from offline evaluation, and "a few negative user experiences can erode trust".

Cross-cutting: (1) verify every candidate against the code in a separate step; (2) use independent passes or a second model and keep only agreed findings; (3) cite exact file:line; (4) give problem + consequence + concrete fix; (5) never report pre-existing issues or linter territory; (6) scale depth to size; (7) staying silent is a valid outcome.

---

## 6. Distilled design for the skill

### 6a. Lens checklist: evidence required before a finding may be raised

Phase 0 (mandatory, all lenses): read the PR description and linked ticket. Run `git diff base...head --stat` and the full diff. Read repo conventions (CLAUDE.md, README, ADRs, lint/tsconfig paths). Find what the CI reviewer already covers and skip it. If the PR is over ~400 LOC, split it into review units.

| Lens | Evidence the reviewer MUST gather | May raise only if |
|---|---|---|
| **Placement / folder structure** | `ls`/tree of the target dir and its siblings. Find 2+ existing files with the same role (`rg -l` for similar exports/suffixes). Read path aliases (tsconfig paths) and any lint import boundaries (eslint-plugin-boundaries, `no-restricted-imports`). | It can cite ≥2 existing examples of the convention, or a written rule, that the new file breaks. "I'd put it elsewhere" with no precedent is not a finding. |
| **Architecture / design fit** | Trace the layers touched (UI → hook/service → DAL/API). Check whether the same responsibility already exists (`rg` for similar function names, types, endpoints). Read the modules the new code imports and the modules that import it. | It names the existing abstraction being duplicated or bypassed, or the layer boundary crossed (e.g. DB import in a client component), with file:line for both sides. Also states the quality attribute and scenario affected (ATAM). |
| **Hacks / workarounds** | For each suspicious construct (`as any`, `@ts-ignore`, `eslint-disable`, `setTimeout(0)`, retry loops, magic constants, string matching on errors, duplicated branches, `!` non-null, catch-and-ignore, feature checks on env names): read the surrounding code, run `git log -L`/blame on removed guards (Chesterton), check whether a proper API exists in the codebase or dependency (read node_modules types or docs). | It shows the root cause the hack avoids AND the non-hack path that exists (with location), or shows that the hack hides a failure mode. Otherwise it may only be a `question:`. |
| **Security** | Run source → sink for each new input: route params, searchParams, form data, headers, server-action args, webhook bodies. For each new server action, route handler, or middleware change, read the authN/authZ helper and confirm it is called. Check what crosses to `"use client"` (prop types). `rg NEXT_PUBLIC_`, `process.env` outside the DAL, `dangerouslySetInnerHTML`, raw SQL/`$queryRawUnsafe`, `eval`, CORS/headers config. For new deps: package.json diff + lockfile. | It has a concrete path in this repo: source file:line → (missing check) → sink file:line, plus the attacker capability. No path means a `question:` at most. Skip DoS, rate-limit, and generic validation unless there is proven impact. |
| **Alternatives (best vs easiest)** | See protocol 6b. | It enumerated options and the chosen one loses on named criteria with codebase evidence. |
| **Scalability** | Find the data sizes and call frequency: where the code runs (per request, per render, per item, cron), loops over collections, N+1 queries (await inside map/for), unbounded fetches without pagination, cache keys, revalidation, bundle impact for client imports. | It names the growth variable (users, items, locales, tenants) and the code line where cost scales with it. "Might not scale" is banned. |
| **Maintainability** | Count the places a future change would touch (information leakage, change amplification), shallow pass-through modules, duplicated logic (`rg` near-duplicates), public API surface growth, naming vs domain glossary, and whether new behaviour is documented where the team documents it. | It gives the concrete future change and the N files it would force, or the duplicate with location. |
| **Regression risk** | List the changed exported symbols, props, routes, schemas, env vars, flags, and serialized shapes. `rg` every caller and importer, and read each one that a behaviour or contract change affects. Find the tests that cover the changed paths (`rg` the symbol in `*.test.*`/`__tests__`/e2e). Ask "would a test fail if this line were inverted?" (mutation thinking). Check observable-behaviour changes (Hyrum): ordering, defaults, error text, response shape, cache keys, analytics event names. Optionally run the affected tests. | It cites the specific caller or consumer that breaks or changes, or the specific untested path with its blast radius. Callers count as evidence only after they have been read. |

### 6b. Alternatives protocol ("design it twice" + MADR)

Trigger it for any PR that adds a new module, abstraction, dependency, data flow, or workaround. Skip it for trivial changes.
1. **State the problem** in one sentence, from the PR description and ticket plus the code. Name the decision drivers: correctness, security, consistency with codebase, blast radius, effort, perf/scalability, reversibility, testability.
2. **Enumerate 2–3 viable options, all grounded in the repo.** (a) The chosen approach. (b) Reuse or extend an existing pattern or module found by `rg`, with a file path required. (c) A framework or library native mechanism already in use (check package.json and existing usage). Optionally (d) do nothing / fix at the root cause elsewhere. An option is valid only if there is evidence it is possible here (existing precedent or an installed dependency's API). No invented infrastructure.
3. **Compare** in a small table: options × drivers, each cell backed by a fact (file:line, doc link) or marked "unknown".
4. **Judge.** "Chosen = best": no finding (optionally `praise:`). "Chosen = easiest but materially worse on ≥1 high-weight driver (security, regression, consistency)": `suggestion`/`issue` with the concrete migration. "Trade-off is a judgment call": `thought (non-blocking)` with the table, letting the author decide. Note the cost of switching now vs later (reversibility).
5. Never demand an alternative that costs more than the benefit it brings. Google's standard is to improve code health, not reach perfection.

### 6c. Severity + confidence

Severity (impact if real):
- **S1 blocking**: security vulnerability with a concrete path; data loss or corruption; a broken caller or contract confirmed by reading it; an architecture violation that is hard to undo (persisted schema, public API).
- **S2 should-fix**: a workaround that hides a failure mode; a missing test on a high-blast-radius path; duplication of an existing abstraction; a placement violation of a written or clearly established convention; a scalability issue on a named growth variable.
- **S3 consider**: a better alternative exists but the trade-off is debatable; maintainability improvements.
- (No nits. Style belongs to CI and linters.)

Confidence (based on evidence, not on how the model feels):
- **High (verified)**: read the code on both ends (e.g. source and sink, changed fn and its caller) and/or reproduced it with a test or command. Required for S1/S2.
- **Medium**: read the change and the relevant context, but one link is assumed (e.g. a runtime config not in the repo). Post it as `question:` and state what was not verified.
- **Low**: drop it. Do not post.
- Rule: post S1/S2 only at High. Post S3 at High or Medium. Every finding lists `Evidence:` (paths:lines read, commands run) and `Not verified:` (if anything).

### 6d. Anti-noise rules

1. **No-inference rule**: a claim about behaviour must cite code that was read in this session. "Probably", "might", or "could" without a path means the finding is dropped or turned into a question.
2. **Verify step**: re-check each candidate finding in a separate pass (fresh context or a second model), asking "Is this actually true in this code? Is it introduced by this PR?" Drop it on disagreement. Optionally run 2–3 independent passes and keep findings that ≥2 agree on (Bugbot).
3. **Diff-anchored**: report only issues introduced or made worse by the PR. Pre-existing issues go in an optional "FYI out-of-scope" line, at most 1.
4. **Do not duplicate CI**: skip bugs, style, lint, typing, and formatting that the existing AI review or linters cover. Stay in this skill's lenses.
5. **Actionable or nothing**: each finding = problem + consequence (scenario) + concrete fix or alternative with location. Vague "consider improving" comments are banned (RovoDev: actionability matters more than hallucination filtering).
6. **Respect Chesterton and author context**: if a weird construct has a comment, ticket, or test explaining it, accept it or ask. Do not flag it as a hack.
7. **Budget**: cap at ~5–7 findings, sorted by severity. Merge duplicates. Silence or "no findings in these lenses" is a valid result. State which lenses were checked.
8. **Format**: Conventional Comments label + (blocking/non-blocking) + lens tag + file:line permalink + Evidence + Fix. Use one summary comment and inline comments only for S1/S2.
9. **Security noise exclusions** by default: DoS, rate limiting, resource exhaustion, generic validation, theoretical crypto. Include them only with demonstrated impact.
10. **Scale depth to size**: for large PRs, split into units and keep findings per unit focused. For small PRs, go light.
11. **Praise sparingly and specifically**, e.g. when the chosen option was clearly the best of those enumerated (Google: "Good things").
