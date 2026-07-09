# PM / Designer Headless UI Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless PM (acceptance-criteria) + Designer (Figma-fidelity) UI check, sharing one protocol block between the review analyzer (observe-only, against the PR preview) and the develop brief (fix-loop, local then preview), with side-by-side visual evidence per discrepancy.

**Architecture:** One shared shell function `ui_check_protocol MODE TARGET` emits the markdown protocol (spawn two Task subagents; PM checks ACs, Designer checks Figma detail or does a general sanity pass; both write side-by-side evidence to `ui-findings/`). It's injected into the review analyzer template `generate_claude_md()` (quoted heredoc → injected via a `{UI_CHECK}` placeholder + a multiline-safe python replace) and into `write_develop_brief()` (unquoted heredoc → inlined via `$(ui_check_protocol …)`).

**Tech Stack:** Bash (single script `bin/cgremlin`), the `claude` CLI headless agent, MCP servers atlassian/figma/chrome-devtools (confirmed reachable from a headless `claude -p` subprocess), python3 (already used in-script for JSON).

## Global Constraints

- **`bin/cgremlin` is the ONLY file changed.** After every edit: `bash -n bin/cgremlin` must pass. The embedded Python `PYSERVER` heredoc is NOT touched, so no `ast.parse` step is needed.
- **DRY:** exactly one copy of the protocol text — the `ui_check_protocol` function. Both briefs reference it; do not duplicate the prose.
- **Do NOT touch the dead/TUI-only templates:** `create_pr_session()` (~2817), `create_investigation_session()` (~3423), `create_development_session()` (~3858), `switch_to_review_mode()` (~3976). The live paths are `generate_claude_md()` (review) and `write_develop_brief()` (develop) only.
- **Review side = OBSERVE:** the analyzer makes NO code changes; PM/Designer findings are **additive** — they land in `REVIEW.md` but must NOT feed the approve safety gate (`_pr_safety_check`). Do not modify `_pr_safety_check`.
- **Develop side = FIX:** findings feed develop's existing fix loop.
- **No Figma link in Jira → general visual sanity pass + PM lens** (never skip the PM lens).
- **Targets:** review → the PR's Vercel preview / Storybook link (local ONLY if the reviewer explicitly asks); develop → local during dev, and the draft PR's Vercel preview after the PR is open.
- **Side-by-side evidence** is built with a self-contained HTML page rendered+screenshotted via chrome-devtools (no ImageMagick/PIL/sips compositor is installed).
- **Graceful degradation:** if an MCP tool or preview is unavailable, note it in `REVIEW.md` and continue — never fail the review over tooling. (Mirrors the existing Tier-0 "if Atlassian MCP available… else fall back" pattern.)
- **New finding types:** `📋 PM/AC` and `🎨 Design`. Design findings carry `Expected` vs `Actual` and an `Evidence` link.

## File Structure

- `bin/cgremlin` — three edits:
  1. New function `ui_check_protocol()` inserted immediately before `generate_claude_md()` (~line 1229). One responsibility: emit the shared protocol markdown for a given mode+target.
  2. `generate_claude_md()` review branch (`REVIEW_TEMPLATE`, 1239–1383): a `{UI_CHECK}` placeholder section, output-format additions (📋/🎨 rows + a Design detail example + Expected/Actual/Evidence), an updated `BEGIN NOW` line, and a python injection after the existing `{CONTEXT}` sed (1385–1386).
  3. `write_develop_brief()` (`DEV`, 13388–13424): step 5 rewritten to run the shared check (local during dev, preview after PR) via inline `$(ui_check_protocol fix …)`.
- Evidence artifacts live under `<session>/ui-findings/` at runtime (created by the agent; no code creates it).

---

### Task 1: Shared `ui_check_protocol` function

**Files:**
- Modify: `bin/cgremlin` — insert the function immediately before `generate_claude_md() {` (currently line 1229).

**Interfaces:**
- Produces: `ui_check_protocol MODE TARGET` — writes the protocol markdown to stdout. `MODE` ∈ `observe|fix`. `TARGET` is a one-sentence string telling the agent where to point the browser. Consumed by Task 2 (review, `observe`) and Task 3 (develop, `fix`).

- [ ] **Step 1: Insert the function**

Insert these lines immediately before the line `generate_claude_md() {`:

```bash
# Emits the shared PM/Designer live-UI-check protocol (markdown) for a brief.
# $1 = mode: observe (review — report only) | fix (develop — drive fixes)
# $2 = target: one sentence telling the agent where to point the browser
# Quoted heredocs keep the body literal; only $target is interpolated (via printf).
ui_check_protocol() {
    local mode="$1" target="$2"
    cat <<'PROTO_HEAD'
## LIVE UI CHECK — PM + Designer lenses (dedicated subagents)

After the code tiers, dispatch TWO focused subagents IN PARALLEL (Task tool). They inherit your MCP servers (atlassian, figma, chrome-devtools). Do NOT do their work inline.
PROTO_HEAD
    printf '\n**Target:** %s\n' "$target"
    cat <<'PROTO_BODY'

**PM subagent (product manager verifying the ticket):**
1. Read the Jira ticket (getJiraIssue; fall back to the PR description if Atlassian MCP is unavailable) and extract the acceptance criteria / intended behavior.
2. Open the target in chrome-devtools and navigate to the changed feature.
3. For each acceptance criterion, exercise it and record holds / broken / missing, with a one-line observation and a screenshot for anything not holding.
4. Return findings only (schema below); make NO code changes.

**Designer subagent (designer checking pixel fidelity):**
1. Find a Figma link in the Jira ticket (scan the getJiraIssue description + remote links for a figma.com URL; capture any node-id).
2. IF a link exists: read the design via Figma MCP — get_variable_defs (color/spacing/typography tokens), get_design_context, and get_screenshot of the relevant node. In chrome-devtools, read the rendered values with evaluate_script (getComputedStyle: font-family, font-size, font-weight, color, background-color, padding, margin, width, height, border-radius). Compare against the design and flag each mismatch as design-value vs rendered-value.
3. IF no link exists: do a general visual sanity pass — alignment, spacing consistency, responsive breakpoints (resize via chrome-devtools), obvious visual bugs — and note "no Figma link found in Jira."
4. Produce SIDE-BY-SIDE evidence for each visual discrepancy (below).
5. Return findings only; make NO code changes.

**Side-by-side evidence (per visual discrepancy)** — create a ui-findings/ directory alongside REVIEW.md and write:
- finding-N-figma.png — Figma reference crop (figma get_screenshot); omit on the no-link sanity path.
- finding-N-rendered.png — the screenshot of the same component from the target (chrome-devtools take_screenshot).
- finding-N.html — a self-contained page showing the two images side by side, captioned with the exact mismatch (example: "Figma #1A73E8 / rendered #1B74E9; font-size Figma 16px / rendered 14px").
- finding-N.png — load finding-N.html in chrome-devtools and screenshot it to get one composed image to paste into the PR.
(No image compositor is installed; the HTML page + chrome-devtools screenshot IS the composition mechanism.)

**Findings each subagent returns (merge these into REVIEW.md):** lens (pm | designer), title, severity (Critical / High / Minor), criterion (the AC or design property checked), expected (design/AC value), actual (rendered value), location (URL/route + component/selector), evidence (relative path to ui-findings/finding-N.html plus .png — designer only).

**Degradation:** if a needed MCP tool is unavailable, or no target/preview is ready, NOTE it plainly in REVIEW.md and continue — never fail over unavailable tooling.
PROTO_BODY
    if [ "$mode" = "fix" ]; then
        cat <<'PROTO_FIX'

**Mode — FIX:** feed every confirmed PM/Designer finding into your fix loop — fix the root cause (correct patterns, no hacks, no over-engineering), then re-run this check until both lenses pass.
PROTO_FIX
    else
        cat <<'PROTO_OBS'

**Mode — OBSERVE:** make NO code changes. Merge PM findings as 📋 PM/AC and Designer findings as 🎨 Design into REVIEW.md (same table + detail shape, adding Expected/Actual lines and an Evidence link for design findings). These are additive — they inform the reviewer and do NOT block approval.
PROTO_OBS
    fi
}
```

- [ ] **Step 2: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 3: Behavioral test — extract the function and run both modes**

The function is short and self-contained (no line in its body begins with `}`), so an awk range extraction is safe:

```bash
awk '/^ui_check_protocol\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/uicp.sh
# observe mode
bash -c '. /tmp/uicp.sh; ui_check_protocol observe "PREVIEW_URL_HERE"' > /tmp/uicp_obs.txt
# fix mode
bash -c '. /tmp/uicp.sh; ui_check_protocol fix "LOCAL_THEN_PREVIEW"' > /tmp/uicp_fix.txt
echo "--- checks ---"
grep -c 'PM subagent' /tmp/uicp_obs.txt            # expect 1
grep -c 'Designer subagent' /tmp/uicp_obs.txt      # expect 1
grep -c 'getComputedStyle' /tmp/uicp_obs.txt       # expect 1
grep -c 'ui-findings/' /tmp/uicp_obs.txt           # expect >=1
grep -c 'side by side' /tmp/uicp_obs.txt           # expect 1
grep -c 'PREVIEW_URL_HERE' /tmp/uicp_obs.txt       # expect 1 (target interpolated)
grep -c 'Mode — OBSERVE' /tmp/uicp_obs.txt         # expect 1
grep -c 'Mode — OBSERVE' /tmp/uicp_fix.txt         # expect 0
grep -c 'Mode — FIX' /tmp/uicp_fix.txt             # expect 1
grep -c 'LOCAL_THEN_PREVIEW' /tmp/uicp_fix.txt     # expect 1
```
Expected: the counts shown in the comments (1/1/1/≥1/1/1/1, then 0/1/1 for fix).

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: shared ui_check_protocol (PM+Designer live UI check)"
```

---

### Task 2: Wire the protocol into the review analyzer (observe)

**Files:**
- Modify: `bin/cgremlin` — `generate_claude_md()` review branch, `REVIEW_TEMPLATE` heredoc (1239–1383) + the sed block right after it (1385–1386).

**Interfaces:**
- Consumes: `ui_check_protocol observe TARGET` from Task 1.
- Produces: a generated review `CLAUDE.md` whose analyzer runs the UI check and whose `REVIEW.md` format documents 📋/🎨 findings.

- [ ] **Step 1: Add the `{UI_CHECK}` placeholder section**

In `REVIEW_TEMPLATE`, immediately BEFORE the line `## Output — write \`REVIEW.md\` in this directory, EXACTLY this structure` (currently line 1322), insert:

```
{UI_CHECK}

```

(A blank line after, so the placeholder block is separated from `## Output`.)

- [ ] **Step 2: Extend the "What I found" table with 📋/🎨 examples**

Immediately AFTER the existing example row `| [2](#f2) | 🔧 Maintainability | \`ui/list.tsx:40\` | one plain-English line | open |` (line 1337), add:

```
| [3](#f3) | 📋 PM/AC | `/search` behavior | acceptance criterion not met — <one line> | open |
| [4](#f4) | 🎨 Design | `PrimaryButton` on `/search` | colour/size differ from Figma — <one line> | open |
```

And immediately AFTER the sentence line `The \`#\` links jump to the full detail below...` (line 1339), add:

```
📋 PM/AC findings come from the acceptance-criteria check; 🎨 Design findings come from the Figma-fidelity check. Design findings additionally carry Expected vs Actual and an Evidence link (see the detail shape below).
```

- [ ] **Step 3: Add a 🎨 Design detail example**

Immediately BEFORE the `## Verdict` line (line 1367), insert this detail block (it documents the extra Expected/Actual/Evidence lines that design findings use):

```
<a id="f4"></a>
### 4. Button colour and size don't match the Figma design
**Severity:** 🎨 Design   **Where:** `/search` — `PrimaryButton`   **Status:** open
**Expected (design):** background `#1A73E8`, font-size `16px`
**Actual (rendered):** background `#1B74E9`, font-size `14px`
**Evidence:** ui-findings/finding-4.html (composed image: ui-findings/finding-4.png)

**What's wrong:** <plain sentence: which property differs, on which element/route.>

**Why it matters:** <impact on brand consistency / usability.>

**Suggested fix:** <the design token or style to apply.>

```

(📋 PM/AC findings reuse the ordinary What's wrong / Why it matters / Suggested fix shape; only 🎨 Design findings add the Expected/Actual/Evidence lines.)

- [ ] **Step 4: Update the `BEGIN NOW` line**

Replace line 1382:

```
BEGIN NOW: run Tier 0 (intent), Tier 1 (core), Tier 2 only if triggered; apply the evidence bar in your head; write REVIEW.md in plain language; stop.
```

with:

```
BEGIN NOW: run Tier 0 (intent), Tier 1 (core), Tier 2 only if triggered; then run the LIVE UI CHECK (PM + Designer subagents); apply the evidence bar in your head; write REVIEW.md in plain language; stop.
```

- [ ] **Step 5: Inject the protocol after the `{CONTEXT}` sed**

Immediately AFTER the two `sed ... "s|{CONTEXT}|$context|g"` lines (1385–1386), add:

```bash
            # Inject the shared UI-check protocol (observe mode). Multiline-safe via env var
            # (sed can't handle the multiline replacement); backticks in the target are escaped
            # so they stay literal markdown rather than triggering command substitution.
            UI_CHECK_TEXT="$(ui_check_protocol observe "the PR's Vercel preview URL — find it via \`gh pr view <number> --json statusCheckRollup,comments\` (the grace-frontend-dev deployment), or a Storybook preview link in the checks/comments. Point the browser there; run against the LOCAL url only if the reviewer explicitly asked.")" \
            python3 -c 'import os,sys
p=sys.argv[1]; s=open(p).read()
open(p,"w").write(s.replace("{UI_CHECK}", os.environ["UI_CHECK_TEXT"]))' "$claude_md"
```

- [ ] **Step 6: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 7: Test the injection mechanism in isolation**

This proves the env-var + python replacement handles the multiline protocol and leaves no placeholder — without needing a full session:

```bash
awk '/^ui_check_protocol\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/uicp.sh
printf 'before\n{UI_CHECK}\nafter\n' > /tmp/tmpl.md
bash -c '. /tmp/uicp.sh
UI_CHECK_TEXT="$(ui_check_protocol observe "TGT with \`code\`")" \
python3 -c "import os,sys
p=sys.argv[1]; s=open(p).read()
open(p,\"w\").write(s.replace(\"{UI_CHECK}\", os.environ[\"UI_CHECK_TEXT\"]))" /tmp/tmpl.md'
echo "--- checks ---"
grep -c '{UI_CHECK}' /tmp/tmpl.md        # expect 0 (placeholder consumed)
grep -c 'Designer subagent' /tmp/tmpl.md # expect 1 (protocol injected)
grep -c 'TGT with `code`' /tmp/tmpl.md   # expect 1 (target + literal backticks preserved)
head -1 /tmp/tmpl.md                     # expect: before
tail -1 /tmp/tmpl.md                     # expect: after
```
Expected: 0, 1, 1, `before`, `after`.

- [ ] **Step 8: Confirm the template edits are present in the source**

```bash
command grep -c '{UI_CHECK}' bin/cgremlin        # expect 2 (placeholder in template + the replace() arg)
command grep -c '📋 PM/AC' bin/cgremlin           # expect >=2
command grep -c '🎨 Design' bin/cgremlin          # expect >=2
command grep -c 'then run the LIVE UI CHECK' bin/cgremlin  # expect 1
```
Expected: the counts shown.

- [ ] **Step 9: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: review analyzer runs PM+Designer UI check, REVIEW.md documents 📋/🎨 findings"
```

---

### Task 3: Wire the protocol into the develop brief (fix)

**Files:**
- Modify: `bin/cgremlin` — `write_develop_brief()`, `DEV` heredoc, step 5 (line 13401).

**Interfaces:**
- Consumes: `ui_check_protocol fix TARGET` from Task 1 (inlined; the `DEV` heredoc is unquoted so `$(…)` expands at write time).

- [ ] **Step 1: Rewrite step 5**

Replace line 13401 (the current `5. **Verify locally.** …` line) with:

```
5. **Verify (local during dev; preview after the PR).** During development, run \`cgremlin --run-local $sn\` and drive chrome-devtools against https://local.findcare.dev.aplaceformom.com/ . Once the draft PR (step 4) is open, ALSO verify against its Vercel preview URL. Run a FOCUSED functional smoke (prove the ticket's issue is fixed, plus a smoke pass of the feature and its likely splash-zone regressions — NOT the full e2e suite) AND the PM + Designer UI check below. Watch logs/dev-server.log; iterate to green; \`cgremlin --stop-local $sn\` when done.

$(ui_check_protocol fix "the LOCAL url https://local.findcare.dev.aplaceformom.com/ during development, and the draft PR's Vercel preview URL once the PR is open")
```

- [ ] **Step 2: Syntax check**

Run: `bash -n bin/cgremlin`
Expected: no output, exit 0.

- [ ] **Step 3: Behavioral test — generate a develop brief with stubs**

`write_develop_brief` depends on `read_session_field`; stub it, extract both functions, run, and grep the emitted brief:

```bash
awk '/^ui_check_protocol\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin > /tmp/fns.sh
awk '/^write_develop_brief\(\) \{/{f=1} f{print} f&&/^\}/{exit}' bin/cgremlin >> /tmp/fns.sh
D=$(mktemp -d)
bash -c '. /tmp/fns.sh
read_session_field(){ echo "HB-1051"; }
write_develop_brief "'"$D"'"'
echo "--- checks ---"
grep -c 'LIVE UI CHECK' "$D/CLAUDE.md"        # expect 1
grep -c 'Designer subagent' "$D/CLAUDE.md"    # expect 1
grep -c 'Mode — FIX' "$D/CLAUDE.md"           # expect 1
grep -c 'Mode — OBSERVE' "$D/CLAUDE.md"       # expect 0
grep -c 'run-local' "$D/CLAUDE.md"            # expect >=1 (step 5 still launches local)
grep -c "Vercel preview URL once the PR is open" "$D/CLAUDE.md"  # expect 1
```
Expected: 1, 1, 1, 0, ≥1, 1.

- [ ] **Step 4: Commit**

```bash
git add bin/cgremlin
git commit -m "feat: develop verify step runs PM+Designer UI check (fix mode, local then preview)"
```

---

### Task 4: Live smoke — real review with a Figma-linked Jira

**Non-destructive:** reviews target the PR preview (not port 8080), so this does not disturb any local dev server. It launches a headless review that drives a browser against a live Vercel preview + Figma. No gating required.

**Files:** none (verification only).

- [ ] **Step 1: Pick a target PR**

List candidate review sessions and choose one whose branch/PR maps to a Jira ticket that has a Figma link (ask the user if unsure which PR qualifies):

```bash
ls "$HOME/.cgremlin/sessions" | grep '^pr-'
```

- [ ] **Step 2: Run one real review and watch it**

Trigger a review/re-review for the chosen session (e.g. via the orchestrator, or `cgremlin --rereview-pr <session>`), then confirm the analyzer executed the UI check:

```bash
S=<chosen-session>
ls "$HOME/.cgremlin/sessions/$S/ui-findings/" 2>/dev/null            # expect finding-*.html / .png if a discrepancy was found
command grep -E '🎨 Design|📋 PM/AC' "$HOME/.cgremlin/sessions/$S/REVIEW.md"   # expect UI findings merged in
command grep -E 'Expected \(design\)|Evidence:' "$HOME/.cgremlin/sessions/$S/REVIEW.md"  # expect design detail shape
```

Expected: the Designer subagent found the Figma link, produced `ui-findings/finding-N.html` + `.png`, and 🎨/📋 findings with Expected/Actual + Evidence links landed in `REVIEW.md`.

- [ ] **Step 3: Confirm graceful degradation (no-link case)**

For a PR whose Jira has NO Figma link, confirm the review still completes, `REVIEW.md` notes "no Figma link found in Jira," and a general visual sanity pass ran (📋 PM/AC and/or 🎨 Design sanity findings, no `finding-N-figma.png`).

- [ ] **Step 4: Report**

Summarize to the user: which PR was reviewed, whether the Figma comparison ran with side-by-side evidence, and the no-link degradation result. No commit (verification only).

---

## Execution notes

- Restart Mission Control (kill the stale watch daemons + `--mission-control --fresh`) is required before the live smoke picks up the new analyzer brief — the running daemon holds the old `generate_claude_md`. Only newly-created review panes get the UI check.
- The `_pr_safety_check` (approve gate) is intentionally NOT modified — UI findings are additive.
