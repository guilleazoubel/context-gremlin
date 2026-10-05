# Mission Control Review Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, at a glance in mission control, which open PRs another human has already reviewed, so the review queue reflects only PRs genuinely waiting on you.

**Architecture:** The watch daemon already fetches PR metadata from GitHub; add the `latestReviews` field to those existing calls, reduce it to a compact `login:STATE,login:STATE` string, and persist it as a single `other_reviews` field on `session.json`. The bash TUI and the embedded Python dashboard both read that one field — badge text, ordering, header count, and filters are all derived from it.

**Tech Stack:** bash 3.2 (macOS system bash), `gh` CLI, `jq`, an embedded Python 3 HTTP server, and `fzf` for the interactive pane.

**Spec:** `docs/superpowers/specs/2026-07-28-mission-control-review-coverage-design.md`

## Global Constraints

- `bin/cgremlin` is the only production file changed. It is a single ~450KB bash script containing an embedded Python server as a `PYSERVER` heredoc (`bin/cgremlin:5763`–`bin/cgremlin:11344`).
- After **every** edit: `bash -n bin/cgremlin` must pass.
- After every edit **inside the PYSERVER heredoc**: extract it and `ast.parse()` it (exact command in Task 5).
- Target bash is macOS system bash **3.2** — no associative arrays, no `${var^^}`, no `mapfile`.
- A review is "covered" only when submitted by someone who is **not** `GITHUB_ME`, **not** the PR author, and **not** a bot.
- All review states count equally: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`.
- Staleness is ignored — a review counts regardless of later pushes.
- No new GitHub API calls. `latestReviews` is added to `--json` field lists on calls that already happen.
- Never commit until the user has reviewed and tested locally. Each task's commit step is written out, but **stop and ask** before running it.

---

## File Structure

**Modified:** `bin/cgremlin` only.

| Region | Lines (pre-change) | Responsibility |
|---|---|---|
| `load_config` / `save_config` | 46–65, 83–122 | New `REVIEW_BOT_LOGINS` config key |
| New helpers | insert after `save_config`, ~124 | Bot list normalization, review derivation, badge text |
| `review_list_grouped` | 718–880 | Badge, uncovered-first ordering, header count, filter |
| `status_pane_loop` fzf binds | 1280–1284 | `Ctrl-R` toggle + header text |
| `parse_session_json` (Python) | 8150–8234 | Expose `other_reviews`, count, `is_mine` |
| Tag CSS (Python heredoc) | 8713–8732 | `.tag-reviewed` rule |
| Filter controls HTML (Python) | 9432–9434 | `hideReviewed` checkbox |
| `renderSessions` (Python) | 9834–9839, 9900 | Dashboard filter + awaiting count |
| `renderSessionItem` (Python) | 9926–9964 | Dashboard tag |
| Event listeners (Python) | 10391–10392 | `hideReviewed` change handler |
| Watch daemon | 13498–13500, 13539–13541 | Fetch + persist |
| Arg dispatch | ~13810 | `--other-reviews`, `--needs-review` |

**Created:** `tests/mission-control-review-coverage.sh` — a self-contained bash assertion script. The repo has no test suite today; this adds one for this feature.

---

## Task 1: Bot config + review derivation (the pure logic)

This is the heart of the feature and the only part with non-trivial logic, so it is built first and tested standalone through a new internal flag.

**Files:**
- Modify: `bin/cgremlin:46-65` (`load_config`), `bin/cgremlin:83-122` (`save_config`)
- Modify: `bin/cgremlin` insert new helpers after `save_config` (line ~124)
- Modify: `bin/cgremlin` arg dispatch near line 13810
- Test: `tests/mission-control-review-coverage.sh` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `REVIEW_BOT_LOGINS` — space-separated config/global, default set below.
  - `other_reviews_from_pr_json()` → reads **one** PR JSON object on stdin, prints `login:STATE,login:STATE` (empty string if none). Requires `$1` = PR author login.
  - `cgremlin --other-reviews <pr-author-login>` → same, exposed for tests.

- [ ] **Step 1: Write the failing test**

Create `tests/mission-control-review-coverage.sh`:

```bash
#!/usr/bin/env bash
# Tests for mission-control review-coverage. Run: bash tests/mission-control-review-coverage.sh
set -uo pipefail

CG="$(cd "$(dirname "$0")/.." && pwd)/bin/cgremlin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     want: [%s]\n     got:  [%s]\n' "$1" "$2" "$3"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has()  { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "contains: $3" "$2";; esac; }
hasnt(){ case "$2" in *"$3"*) bad "$1" "NOT contains: $3" "$2";; *) ok "$1";; esac; }

# Isolated HOME so the real ~/.cgremlin/config never leaks in.
export HOME="$TMP/home"
mkdir -p "$HOME/.cgremlin"
cat > "$HOME/.cgremlin/config" <<'EOF'
GITHUB_ME="guilleazoubel"
EOF
export CGREMLIN_SESSIONS_DIR="$TMP/sessions"
mkdir -p "$CGREMLIN_SESSIONS_DIR"

derive() { # $1 = pr author, stdin = PR json
    "$CG" --other-reviews "$1"
}

printf '\n== Task 1: derivation ==\n'

is "no reviews -> empty" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[]}' | derive granttuttle)"

is "one other human" "ebubae:COMMENTED" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"ebubae"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "APPROVED counts" "ebubae:APPROVED" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"ebubae"},"state":"APPROVED"}]}' | derive granttuttle)"

is "CHANGES_REQUESTED counts" "ebubae:CHANGES_REQUESTED" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"ebubae"},"state":"CHANGES_REQUESTED"}]}' | derive granttuttle)"

# THE critical regression case: our own agent posts reviews as GITHUB_ME.
is "my own review does NOT count" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"guilleazoubel"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "my own review, case-insensitive" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"GuilleAzoubel"},"state":"APPROVED"}]}' | derive granttuttle)"

is "self-review by PR author does NOT count" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"granttuttle"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "copilot reviewer does NOT count" "" "$(printf '%s' \
  '{"author":{"login":"copilot-pull-request-reviewer"},"latestReviews":[{"author":{"login":"copilot-pull-request-reviewer"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "[bot] suffix does NOT count" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"dependabot[bot]"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "two humans, order preserved" "ebubae:APPROVED,DavidAPFM:COMMENTED" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"ebubae"},"state":"APPROVED"},{"author":{"login":"DavidAPFM"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "human survives alongside bot+me" "ebubae:COMMENTED" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":{"login":"coderabbitai"},"state":"COMMENTED"},{"author":{"login":"guilleazoubel"},"state":"APPROVED"},{"author":{"login":"ebubae"},"state":"COMMENTED"}]}' | derive granttuttle)"

is "missing latestReviews key -> empty" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"}}' | derive granttuttle)"

is "null author login is skipped" "" "$(printf '%s' \
  '{"author":{"login":"granttuttle"},"latestReviews":[{"author":null,"state":"COMMENTED"}]}' | derive granttuttle)"

is "malformed json -> empty, no crash" "" "$(printf '%s' 'not json' | derive granttuttle 2>/dev/null)"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash tests/mission-control-review-coverage.sh
```

Expected: every derivation assertion FAILS, because `--other-reviews` is not a recognized flag yet (cgremlin will fall through to its normal startup path and print unrelated output or nothing).

- [ ] **Step 3: Add the `REVIEW_BOT_LOGINS` config key**

In `load_config`, add a case arm immediately after the `WATCH_AUTHORS` arm at `bin/cgremlin:56`:

```bash
                WATCH_AUTHORS) WATCH_AUTHORS="$value" ;;
                REVIEW_BOT_LOGINS) REVIEW_BOT_LOGINS="$value" ;;
```

In the defaults block at the end of `load_config` (after line 76, alongside the other `:` defaults):

```bash
    : "${REVIEW_BOT_LOGINS:=copilot-pull-request-reviewer coderabbitai vercel github-actions codecov sonarcloud greptile ellipsis-dev}"
```

In `save_config`, add to the heredoc immediately after the `WATCH_AUTHORS` block (after `bin/cgremlin:110`):

```bash
# Bot reviewer logins that do NOT count as "reviewed by another person"
# (space-separated, case-insensitive; replaces the built-in default list)
REVIEW_BOT_LOGINS="$REVIEW_BOT_LOGINS"
```

> **Note for the implementer:** `save_config` rewrites the whole file from variables, so any key it does not template is silently dropped. That is why the `save_config` half is mandatory, not optional. There is a pre-existing instance of this bug — `VERCEL_AUTOMATION_BYPASS_SECRET` is read by `load_config` but never written by `save_config`. **Do not fix that here**; it is out of scope and is being reported to the user separately.

- [ ] **Step 4: Add the helper functions**

Insert after `save_config`'s closing brace (`bin/cgremlin:124`), before the `# Load config at startup` comment:

```bash
# --- Review coverage: has anyone OTHER than me already reviewed this PR? ---------
# A PR is "covered" when latestReviews holds a review from someone who is not
# GITHUB_ME (our agent reviews post as us), not the PR author, and not a bot.
# Bots can't be detected by suffix alone — GitHub's own Copilot reviewer is a
# bare "copilot-pull-request-reviewer" — hence the denylist alongside the
# "[bot]" check.

# stdin: one PR JSON object with .author.login and .latestReviews[]
# $1:    the PR's author login
# stdout: "login:STATE,login:STATE" in GitHub's order, or "" when uncovered.
# gh's built-in --jq takes no --arg, so callers pipe raw JSON to real jq here.
other_reviews_from_pr_json() {
    local pr_author="${1:-}" me_l bots_l
    me_l=$(printf '%s' "${GITHUB_ME:-}" | tr '[:upper:]' '[:lower:]')
    bots_l=$(printf '%s' "${REVIEW_BOT_LOGINS:-}" | tr '[:upper:]' '[:lower:]')
    jq -r --arg me "$me_l" --arg bots "$bots_l" --arg prauthor "$pr_author" '
        ($bots | split(" ") | map(select(length > 0))) as $botlist
      | ($prauthor | ascii_downcase) as $pa
      | [ (.latestReviews // [])[]
          | (.author.login // "") as $rl
          | ($rl | ascii_downcase) as $l
          | select($l != "")
          | select($l != $me)
          | select($l != $pa)
          | select($l | endswith("[bot]") | not)
          | select($botlist | index($l) | not)
          | $rl + ":" + (.state // "")
        ] | join(",")
    ' 2>/dev/null || printf ''
}
```

- [ ] **Step 5: Add the internal `--other-reviews` dispatch flag**

`bin/cgremlin:13810` already holds the `--review-list-grouped` handler. Insert this block immediately before it:

```bash
# Handle --other-reviews (internal/testing: derive review coverage from PR JSON on stdin)
if [ "$1" = "--other-reviews" ]; then
    other_reviews_from_pr_json "${2:-}"
    exit 0
fi
```

Also add the flag to the long `if [ "$1" != ... ]` startup guard at `bin/cgremlin:13816`. Strictly speaking the handler above already `exit 0`s before that line is reached, but every existing internal flag — `--review-list-grouped` included — appears in both places, and following that convention keeps the guard a complete list of non-interactive entry points. Add `&& [ "$1" != "--other-reviews" ]` to the chain, in the same style as its neighbors:

```bash
[ "$1" != "--agent-note" ] && [ "$1" != "--other-reviews" ]; then
```

- [ ] **Step 6: Verify syntax, then run the test**

```bash
bash -n bin/cgremlin && echo "SYNTAX OK"
bash tests/mission-control-review-coverage.sh
```

Expected: `SYNTAX OK`, then all 14 Task 1 assertions pass, `0 failed`.

- [ ] **Step 7: Commit** *(ask the user first — see Global Constraints)*

```bash
git add bin/cgremlin tests/mission-control-review-coverage.sh
git commit -m "feat(review-coverage): derive other-human review coverage from latestReviews"
```

---

## Task 2: Fetch and persist `other_reviews`

**Files:**
- Modify: `bin/cgremlin:13498-13500` (daemon PR poll)
- Modify: `bin/cgremlin:13539-13541` (per-session refresh)

**Interfaces:**
- Consumes: `other_reviews_from_pr_json()` from Task 1.
- Produces: `session.json` field `other_reviews` (string; `""` = uncovered **or** the PR is mine), written via the existing `update_session_field "$d" "<key>" "<value>"` helper.

There is no automated test here — both steps require live GitHub calls. Verification is manual against a real PR, specified in Step 4.

- [ ] **Step 1: Add `latestReviews` to the daemon's PR poll**

Replace `bin/cgremlin:13498-13500`:

```bash
                pr_rows=$(timeout 20 gh pr list --repo "$wrepo" --state open --limit 50 \
                    --json number,url,author,isDraft,reviewDecision \
                    --jq '.[] | select(.reviewDecision != "APPROVED") | [(.number|tostring), .url, .author.login, (.isDraft|tostring)] | @tsv' 2>/dev/null)
```

with — note the pipe to real `jq`, needed because `gh --jq` accepts no `--arg`:

```bash
                local _me_l _bots_l
                _me_l=$(printf '%s' "${GITHUB_ME:-}" | tr '[:upper:]' '[:lower:]')
                _bots_l=$(printf '%s' "${REVIEW_BOT_LOGINS:-}" | tr '[:upper:]' '[:lower:]')
                pr_rows=$(timeout 20 gh pr list --repo "$wrepo" --state open --limit 50 \
                    --json number,url,author,isDraft,reviewDecision,latestReviews 2>/dev/null \
                    | jq -r --arg me "$_me_l" --arg bots "$_bots_l" '
                        ($bots | split(" ") | map(select(length > 0))) as $botlist
                      | .[]
                      | select(.reviewDecision != "APPROVED")
                      | . as $pr
                      | (($pr.author.login // "") | ascii_downcase) as $pa
                      | ([ ($pr.latestReviews // [])[]
                           | (.author.login // "") as $rl
                           | ($rl | ascii_downcase) as $l
                           | select($l != "")
                           | select($l != $me)
                           | select($l != $pa)
                           | select($l | endswith("[bot]") | not)
                           | select($botlist | index($l) | not)
                           | $rl + ":" + (.state // "")
                         ] | join(",")) as $others
                      | [($pr.number|tostring), $pr.url, $pr.author.login, ($pr.isDraft|tostring), $others] | @tsv
                    ' 2>/dev/null)
```

- [ ] **Step 2: Widen the row reader**

`bin/cgremlin:13496` declares the loop locals and `:13503` reads the row. Add `pr_others` to both.

Line 13496 — append `pr_others` to the `local` list:

```bash
                local pr_rows pr_num pr_url pr_author pr_isdraft pr_others wauthor matched already_tracked ex me_l
```

Line 13503 — add the fifth field:

```bash
                while IFS=$'\t' read -r pr_num pr_url pr_author pr_isdraft pr_others; do
```

Leave the `[ -z "$pr_num" ] || [ -z "$pr_url" ] || [ -z "$pr_author" ] && continue` guard at `:13504` untouched — `pr_others` is legitimately empty for uncovered PRs and must never gate the row.

> Newly picked-up PRs get their `other_reviews` written by the refresh loop on the daemon's next cycle (Step 3), not at creation time. `--review-pr` runs asynchronously in the background, so writing the field here would race the session-dir creation.

- [ ] **Step 3: Fetch and persist on the per-session refresh**

Replace `bin/cgremlin:13539`:

```bash
            meta=$(timeout 15 gh pr view "$num" --repo "$repo" --json state,reviewDecision,isDraft -q '.state + "\t" + (.reviewDecision // "") + "\t" + (.isDraft|tostring)' 2>/dev/null)
```

with a raw fetch reused for both the existing tab-string parse and the new derivation:

```bash
            local _meta_json _pr_author_gh
            _meta_json=$(timeout 15 gh pr view "$num" --repo "$repo" --json state,reviewDecision,isDraft,author,latestReviews 2>/dev/null)
            meta=$(printf '%s' "$_meta_json" | jq -r '.state + "\t" + (.reviewDecision // "") + "\t" + (.isDraft|tostring)' 2>/dev/null)
            _pr_author_gh=$(printf '%s' "$_meta_json" | jq -r '.author.login // ""' 2>/dev/null)
            if [ -n "$_meta_json" ]; then
                # My own PRs are not part of the review queue, so coverage never
                # applies to them. Writing "" keeps the field's meaning uniform —
                # "another human reviewed a PR that is waiting on me" — so neither
                # renderer has to know which login is mine.
                if pr_is_mine "$d"; then
                    update_session_field "$d" "other_reviews" ""
                else
                    update_session_field "$d" "other_reviews" \
                        "$(printf '%s' "$_meta_json" | other_reviews_from_pr_json "$_pr_author_gh")"
                fi
            fi
```

The `if [ -n "$_meta_json" ]` guard matters: a timed-out or failed `gh` call must leave the previous value alone rather than blanking a covered PR back to uncovered.

Place the `update_session_field` call **after** the `meta`/`state` parse but **before** the `if [ "$state" = "MERGED" ]` block at `:13548`, so it runs for every live session regardless of which branch it later takes.

- [ ] **Step 4: Verify syntax and confirm against a real PR**

```bash
bash -n bin/cgremlin && echo "SYNTAX OK"
```

Then pick a real open PR that another human has commented on and check the derivation end-to-end:

```bash
gh pr view <NUM> --repo aplaceformom/grace-frontend \
  --json state,reviewDecision,isDraft,author,latestReviews \
  | bin/cgremlin --other-reviews "$(gh pr view <NUM> --repo aplaceformom/grace-frontend --json author -q .author.login)"
```

Expected: a `login:STATE` string naming the other reviewer, with your own login absent.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add bin/cgremlin
git commit -m "feat(review-coverage): fetch latestReviews and persist other_reviews on sessions"
```

---

## Task 3: TUI badge, uncovered-first ordering, header count

**Files:**
- Modify: `bin/cgremlin:718-836` (`review_list_grouped`)
- Modify: `bin/cgremlin` insert `other_reviews_badge()` next to the Task 1 helpers (~line 124)
- Test: `tests/mission-control-review-coverage.sh` (append)

**Interfaces:**
- Consumes: `session.json` field `other_reviews` (Task 2), read with the existing `read_session_field "$d" "other_reviews"`.
- Produces: `other_reviews_badge()` → given the raw `other_reviews` string, prints `  👥 alice reviewed` / `  👥 3 others reviewed`, or `""` when uncovered.

Ordering is achieved by splitting each affected accumulator into `_un` (uncovered) and `_cov` halves and printing `_un` first. This is stable by construction — directory order is preserved inside each half — so no `sort` is involved and existing relative ordering is untouched.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mission-control-review-coverage.sh`, immediately before the final `printf '\n%d passed...'` summary lines:

```bash
printf '\n== Task 3: TUI rendering ==\n'

# Build a PR session dir the way review_list_grouped expects to find one.
# $1 = num, $2 = author, $3 = other_reviews, $4 = review_state, $5 = lifecycle
mkpr() {
    local d="$CGREMLIN_SESSIONS_DIR/pr-grace-frontend-$1-fixture"
    mkdir -p "$d/repo"
    cat > "$d/session.json" <<EOF
{
  "mode": "review",
  "pr": { "number": "$1", "title": "fixture PR $1", "author": "$2",
          "url": "https://github.com/aplaceformom/grace-frontend/pull/$1",
          "head": "feat/fixture-$1", "base": "main" },
  "project": "https://github.com/aplaceformom/grace-frontend",
  "lifecycle": "$5",
  "review_state": "$4",
  "other_reviews": "$3"
}
EOF
}
rmprs() { rm -rf "$CGREMLIN_SESSIONS_DIR"/pr-*; }

# --- badge text ---
rmprs
mkpr 101 granttuttle ""                                   ready none
mkpr 102 granttuttle "ebubae:COMMENTED"                   ready none
mkpr 103 granttuttle "ebubae:APPROVED,DavidAPFM:COMMENTED" ready none
OUT="$("$CG" --review-list-grouped)"

hasnt "uncovered PR has no badge"  "$(printf '%s' "$OUT" | grep '#101')" "👥"
has   "1 reviewer names them"      "$(printf '%s' "$OUT" | grep '#102')" "👥 ebubae reviewed"
has   "2 reviewers -> count"       "$(printf '%s' "$OUT" | grep '#103')" "👥 2 others reviewed"
has   "uncovered keeps its label"  "$(printf '%s' "$OUT" | grep '#101')" "🆕 new · full review"

# --- ordering: uncovered first within "Needs your attention" ---
rmprs
mkpr 201 granttuttle "ebubae:COMMENTED" ready none
mkpr 202 granttuttle ""                 ready none
ORDER="$("$CG" --review-list-grouped | grep -oE '#(201|202)' | tr -d '#' | tr '\n' ' ')"
is "uncovered sorts before covered" "202 201 " "$ORDER"

# --- header count ---
rmprs
mkpr 301 granttuttle ""                 ready none
mkpr 302 granttuttle ""                 ready none
mkpr 303 granttuttle "ebubae:COMMENTED" ready none
has "header counts only uncovered" "$("$CG" --review-list-grouped)" "(2 awaiting first review)"

rmprs
mkpr 304 granttuttle "ebubae:COMMENTED" ready none
hasnt "no count when all covered" "$("$CG" --review-list-grouped)" "awaiting first review"

# --- my own PRs are untouched by this feature ---
rmprs
mkpr 401 guilleazoubel "ebubae:APPROVED" ready none
hasnt "my own PR gets no coverage badge" "$("$CG" --review-list-grouped)" "👥"

# --- backward compatibility: sessions written before this change ---
rmprs
mkdir -p "$CGREMLIN_SESSIONS_DIR/pr-grace-frontend-501-fixture/repo"
cat > "$CGREMLIN_SESSIONS_DIR/pr-grace-frontend-501-fixture/session.json" <<'EOF'
{ "mode": "review",
  "pr": { "number": "501", "title": "legacy", "author": "granttuttle",
          "url": "https://github.com/aplaceformom/grace-frontend/pull/501",
          "head": "feat/legacy", "base": "main" },
  "lifecycle": "none", "review_state": "ready" }
EOF
LEGACY="$("$CG" --review-list-grouped)"
has   "legacy session still renders"   "$LEGACY" "#501"
hasnt "legacy session reads uncovered" "$LEGACY" "👥"
rmprs
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/mission-control-review-coverage.sh
```

Expected: Task 1 assertions still pass; the Task 3 badge/ordering/count assertions FAIL (no badge is rendered yet). The two `hasnt` assertions and "uncovered keeps its label" may already pass — that is fine and expected, since nothing renders a badge yet.

- [ ] **Step 3: Add the badge helper**

Insert directly after `other_reviews_from_pr_json()` from Task 1:

```bash
# "ebubae:COMMENTED" -> "  👥 ebubae reviewed"
# "a:APPROVED,b:COMMENTED" -> "  👥 2 others reviewed"
# "" -> ""   (uncovered; caller appends nothing)
other_reviews_badge() {
    local raw="${1:-}" n first
    [ -z "$raw" ] && return 0
    n=$(printf '%s' "$raw" | tr ',' '\n' | grep -c '[^[:space:]]')
    first="${raw%%:*}"
    if [ "${n:-0}" -le 1 ]; then
        printf '  👥 %s reviewed' "$first"
    else
        printf '  👥 %s others reviewed' "$n"
    fi
}
```

- [ ] **Step 4: Split the accumulators and add the counter**

In `review_list_grouped`, replace the declaration at `bin/cgremlin:719`:

```bash
  local mergemine="" ready="" inflight="" rereview="" response="" approved="" mycomments="" mytracking=""
```

with split halves for the two action-zone groups plus a counter:

```bash
  local mergemine="" inflight="" response="" approved="" mycomments="" mytracking=""
  # Action-zone groups are split so PRs nobody else has reviewed print first.
  # Splitting (rather than sorting) keeps directory order stable inside each half.
  local ready_un="" ready_cov="" rereview_un="" rereview_cov="" n_uncovered=0
```

Add `orev` and `obadge` to the locals at `bin/cgremlin:720`:

```bash
  local d sname num author rs lc rp icon line prtag jira rowpfx jira_suffix _prepo orev obadge
```

- [ ] **Step 5: Read the field and build the badge**

In the per-session loop, after `rp=$(read_rereview_pending "$d")` at `bin/cgremlin:743`, add:

```bash
    # Has another human already reviewed this? (empty = nobody but us/bots)
    orev=$(read_session_field "$d" "other_reviews" 2>/dev/null)
    obadge=$(other_reviews_badge "$orev")
```

- [ ] **Step 6: Route the `rereview` rows into the split halves**

Replace `bin/cgremlin:801-810` (the `if [ "$rp" = "true" ]` branch body) so the badge is appended and the row lands in the right half:

```bash
    if [ "$rp" = "true" ]; then
      # Re-review has FINISHED (in-flight ones were caught above as "Agent
      # reviewing"). Needs your attention, but it's a quick check — only the
      # delta since last review, with a resolution summary.
      local summary; summary=$(cat "$d/rereview_summary" 2>/dev/null)
      icon="🔁 re-review · quick"; [ "$rs" = "failed" ] && icon="⚠ re-review failed — retry"
      local aicon; aicon=$(attention_icon "$d" 1); [ -n "$aicon" ] && aicon="  $aicon"
      local reline="$(printf '%s  @%-14s%s %s%s%s' "$rowpfx" "${author:-?}" "$jira_suffix" "$icon" "$aicon" "$obadge")"
      [ -n "$summary" ] && reline="${reline}  ·  ${summary}"
      if [ -n "$orev" ]; then
        rereview_cov="${rereview_cov}${DIM}${reline}${RST}\t${sname}\trereview"$'\n'
      else
        rereview_un="${rereview_un}${reline}\t${sname}\trereview"$'\n'
        n_uncovered=$((n_uncovered+1))
      fi
```

- [ ] **Step 7: Route the `ready` rows into the split halves**

Replace `bin/cgremlin:811-820` (the `elif [ "$lc" = "none" ]` branch body):

```bash
    elif [ "$lc" = "none" ]; then
      # Fresh review complete (or failed) → a full first-time review to work through.
      case "$rs" in
        ready)       icon="🆕 new · full review";;
        failed)      icon="⚠ review failed — retry";;
        interrupted) icon="⏸ interrupted";;
        *)           icon="${rs:-…}";;
      esac
      local aicon; aicon=$(attention_icon "$d" 1); [ -n "$aicon" ] && aicon="  $aicon"
      local rdline="$(printf '%s  @%-14s%s %s%s%s' "$rowpfx" "${author:-?}" "$jira_suffix" "$icon" "$aicon" "$obadge")"
      if [ -n "$orev" ]; then
        ready_cov="${ready_cov}${DIM}${rdline}${RST}\t${sname}\tready"$'\n'
      else
        ready_un="${ready_un}${rdline}\t${sname}\tready"$'\n'
        n_uncovered=$((n_uncovered+1))
      fi
```

- [ ] **Step 8: Add the badge to the informational groups**

These groups are not reordered, but the badge is still useful context. Replace `bin/cgremlin:824` (inside the final `else`):

```bash
      response="${response}$(printf '%s  @%-14s%s 💬 waiting on author%s%s' "$rowpfx" "${author:-?}" "$jira_suffix" "$aicon" "$obadge")\t${sname}\tresponse"$'\n'
```

- [ ] **Step 9: Define the dim escapes**

The pane runs `fzf --ansi` (`bin/cgremlin:1280`), so ANSI dimming renders. Add next to the `show_archived` locals at `bin/cgremlin:725`:

```bash
  # fzf runs with --ansi, so covered rows can be dimmed to sink them visually.
  local DIM=$'\033[2m' RST=$'\033[0m'
```

- [ ] **Step 10: Print the halves and the header count**

Replace `bin/cgremlin:830-832`:

```bash
  printf '── 🔔 Needs your attention ──\t\t\n'
  [ -n "$rereview" ] && printf '%b' "$rereview"
  [ -n "$ready" ]    && printf '%b' "$ready"
```

with:

```bash
  local attn_hdr='── 🔔 Needs your attention ──'
  [ "$n_uncovered" -gt 0 ] && attn_hdr="── 🔔 Needs your attention ($n_uncovered awaiting first review) ──"
  printf '%s\t\t\n' "$attn_hdr"
  # Uncovered (nobody else has looked) first, then rows another human already reviewed.
  [ -n "$rereview_un" ]  && printf '%b' "$rereview_un"
  [ -n "$ready_un" ]     && printf '%b' "$ready_un"
  [ -n "$rereview_cov" ] && printf '%b' "$rereview_cov"
  [ -n "$ready_cov" ]    && printf '%b' "$ready_cov"
```

- [ ] **Step 11: Verify syntax and run the tests**

```bash
bash -n bin/cgremlin && echo "SYNTAX OK"
bash tests/mission-control-review-coverage.sh
```

Expected: `SYNTAX OK` and `0 failed` across both Task 1 and Task 3 assertions.

> If the ordering assertion fails, check that no stale `$ready` / `$rereview` variable reference survives — `grep -n '\$ready\b\|\$rereview\b' bin/cgremlin` should return only the new `_un`/`_cov` names.

- [ ] **Step 12: Commit** *(ask first)*

```bash
git add bin/cgremlin tests/mission-control-review-coverage.sh
git commit -m "feat(mission-control): badge and prioritize PRs with no outside review"
```

---

## Task 4: `Ctrl-R` hide-covered toggle

**Files:**
- Modify: `bin/cgremlin:718-728` (`review_list_grouped` filter read)
- Modify: `bin/cgremlin:1280-1284` (fzf binds and header)
- Test: `tests/mission-control-review-coverage.sh` (append)

**Interfaces:**
- Consumes: `$orev` and the split accumulators from Task 3.
- Produces: sentinel file `$SESSIONS_DIR/.mc_hide_reviewed`; env override `CG_HIDE_REVIEWED=1`.

This mirrors the existing `Ctrl-A` show/hide-archived toggle exactly (`bin/cgremlin:726-727` for the read, `:1283` for the bind). Plain letters cannot be bound — fzf routes them into the search query — and `Ctrl-U` (`unix-line-discard`) and `Ctrl-G` (`abort`) are fzf defaults that must be left alone. `Ctrl-R` is not an fzf default.

- [ ] **Step 1: Write the failing tests**

Append to `tests/mission-control-review-coverage.sh` before the summary lines:

```bash
printf '\n== Task 4: hide-covered toggle ==\n'

rmprs
mkpr 601 granttuttle ""                 ready none
mkpr 602 granttuttle "ebubae:COMMENTED" ready none

BOTH="$("$CG" --review-list-grouped)"
has "default shows covered"   "$BOTH" "#602"
has "default shows uncovered" "$BOTH" "#601"

HIDDEN="$(CG_HIDE_REVIEWED=1 "$CG" --review-list-grouped)"
has   "env override keeps uncovered" "$HIDDEN" "#601"
hasnt "env override hides covered"   "$HIDDEN" "#602"

: > "$CGREMLIN_SESSIONS_DIR/.mc_hide_reviewed"
SENT="$("$CG" --review-list-grouped)"
has   "sentinel keeps uncovered" "$SENT" "#601"
hasnt "sentinel hides covered"   "$SENT" "#602"
rm -f "$CGREMLIN_SESSIONS_DIR/.mc_hide_reviewed"

RESTORED="$("$CG" --review-list-grouped)"
has "removing sentinel restores covered" "$RESTORED" "#602"

# The two toggles must not interfere with each other.
: > "$CGREMLIN_SESSIONS_DIR/.mc_hide_reviewed"
BOTHTOG="$(CG_SHOW_ARCHIVED=1 "$CG" --review-list-grouped)"
has   "ctrl-a state does not resurrect covered" "$BOTHTOG" "#601"
hasnt "ctrl-r still applies with archived shown" "$BOTHTOG" "#602"
rm -f "$CGREMLIN_SESSIONS_DIR/.mc_hide_reviewed"
rmprs
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bash tests/mission-control-review-coverage.sh
```

Expected: the four `hasnt` assertions FAIL — covered PRs are still listed because no filter exists yet.

- [ ] **Step 3: Read the toggle state**

Add immediately after the `show_archived` block at `bin/cgremlin:727`:

```bash
  # PRs another human already reviewed are hidden when the status-pane Ctrl-R
  # sentinel is set (CG_HIDE_REVIEWED=1 also forces hide). A view filter only —
  # nothing is deleted, exactly like show_archived above.
  local hide_reviewed=0
  [ -f "$SESSIONS_DIR/.mc_hide_reviewed" ] && hide_reviewed=1
  [ "${CG_HIDE_REVIEWED:-}" = "1" ] && hide_reviewed=1
```

- [ ] **Step 4: Apply the filter**

Add immediately after the `obadge=$(other_reviews_badge "$orev")` line added in Task 3, Step 5:

```bash
    # Hide already-reviewed PRs when the toggle is on. Own PRs are exempt —
    # they live in their own group and aren't part of the review queue.
    if [ "$hide_reviewed" = "1" ] && [ -n "$orev" ] && ! pr_is_mine "$d"; then
      continue
    fi
```

> The `pr_is_mine` guard is belt-and-braces: Task 2 already writes `other_reviews=""` for own PRs, so `$orev` is empty for them anyway. It stays because a session written before Task 2 landed could still carry a stale non-empty value, and silently hiding one of your own PRs would be a confusing failure.

- [ ] **Step 5: Add the `Ctrl-R` bind and update the header**

Replace `bin/cgremlin:1280-1284`:

```bash
        sel=$("$_cg" --review-list-grouped | fzf --ansi --reverse --delimiter='\t' --with-nth=1 \
            --header='Mission Control — Enter: open · Ctrl-A: show/hide archived (merged/abandoned) · Ctrl-R: hide/show already-reviewed' \
            --bind="load:reload-sync:sleep 2; $_cg --review-list-grouped" \
            --bind="ctrl-a:execute-silent(f=\"$SESSIONS_DIR/.mc_show_archived\"; if [ -f \"\$f\" ]; then rm -f \"\$f\"; else : > \"\$f\"; fi)+reload-sync($_cg --review-list-grouped)" \
            --bind="ctrl-r:execute-silent(f=\"$SESSIONS_DIR/.mc_hide_reviewed\"; if [ -f \"\$f\" ]; then rm -f \"\$f\"; else : > \"\$f\"; fi)+reload-sync($_cg --review-list-grouped)" \
            --bind='double-click:accept' 2>/dev/null)
```

- [ ] **Step 6: Verify syntax and run the tests**

```bash
bash -n bin/cgremlin && echo "SYNTAX OK"
bash tests/mission-control-review-coverage.sh
```

Expected: `SYNTAX OK`, `0 failed`.

- [ ] **Step 7: Confirm interactively**

```bash
bin/cgremlin --status-pane
```

Press `Ctrl-R` — already-reviewed PRs vanish and the header count stays accurate; press it again to restore. Type a few letters to confirm search still works, and `Ctrl-U` still clears the query.

- [ ] **Step 8: Commit** *(ask first)*

```bash
git add bin/cgremlin tests/mission-control-review-coverage.sh
git commit -m "feat(mission-control): Ctrl-R toggle to hide already-reviewed PRs"
```

---

## Task 5: Dashboard tag, count, and filter

**Files:**
- Modify: `bin/cgremlin:8176-8181` (`parse_session_json`, review branch)
- Modify: `bin/cgremlin:8713-8732` (tag CSS)
- Modify: `bin/cgremlin:9939-9949` (`renderSessionItem`)

**Files (additional):**
- Modify: `bin/cgremlin:9432-9434` (filter controls HTML)
- Modify: `bin/cgremlin:9834-9836` (`renderSessions` state reads), `:9837-9839` (filtering), `:9900` (Active section label)
- Modify: `bin/cgremlin:10391-10392` (event listeners)

**Interfaces:**
- Consumes: `session.json` fields `other_reviews` (Task 2) and `mine_stage` (pre-existing).
- Produces on each review session in the sessions-list payload:
  - `other_reviews` (string) — `"login:STATE,login:STATE"`, `""` when uncovered or mine.
  - `other_reviews_count` (int).
  - `is_mine` (bool) — true when the session carries a `mine_stage` key.
- Produces CSS class `.tag-reviewed` and DOM id `hideReviewed`.

All edits are **inside the PYSERVER heredoc** (`bin/cgremlin:5763`–`:11344`), so the `ast.parse()` check is mandatory here.

Two notes on approach:

- The dashboard filter keeps its own client-side state and deliberately does **not** share the `.mc_hide_reviewed` sentinel — a click in the browser must not silently change what the terminal pane shows.
- `GITHUB_ME` is never plumbed into the dashboard, so "is this my PR?" is derived from the **presence** of a `mine_stage` key in `session.json`. Every `update_mine_stage` call site in the script operates on the user's own PRs (`triage_done` at `bin/cgremlin:649`, `--track-my-pr` at `:14613`, and the triage flows at `:14753`/`:14813`/`:14815`), so presence is a reliable marker. Note this is *presence*, not truthiness of the read-side default — `read_mine_stage` defaults absent to `"tracking"`, which is why the Python check must use `in data`, not `data.get(...)`.

- [ ] **Step 1: Expose the fields on the payload**

In `parse_session_json`, in the `if mode == 'review':` branch, after `info['url'] = pr.get('url', '')` at `bin/cgremlin:8181`:

```python
                # Review coverage: who OTHER than us has already reviewed this PR.
                # Written as "login:STATE,login:STATE" by the watch daemon; "" means
                # nobody else has, or the PR is our own (never in the review queue).
                _orev = data.get('other_reviews', '') or ''
                info['other_reviews'] = _orev
                info['other_reviews_count'] = len([p for p in _orev.split(',') if p.strip()])
                # Our own PRs carry a mine_stage key (--track-my-pr stamps it); others
                # never do. Presence — not value — is the marker, since the bash-side
                # read_mine_stage() defaults an absent key to "tracking".
                info['is_mine'] = 'mine_stage' in data
```

- [ ] **Step 2: Add the CSS rule**

After `bin/cgremlin:8732` (`.tag-stale`), matching the surrounding one-line style:

```css
        .tag-reviewed { background: var(--green-bg); color: var(--green); }
```

- [ ] **Step 3: Add the tag**

In `renderSessionItem`, after the `tag-stale` line at `bin/cgremlin:9949`:

```javascript
        if (s.other_reviews_count > 0) {
            const _rev = s.other_reviews_count === 1
                ? '👥 ' + escapeHtml(String(s.other_reviews).split(':')[0])
                : '👥 ' + s.other_reviews_count + ' others';
            tags += '<span class="tag tag-reviewed" title="Already reviewed by: ' +
                    escapeHtml(String(s.other_reviews)) + '">' + _rev + '</span>';
        }
```

- [ ] **Step 4: Add the awaiting-first-review count to the Active section label**

`renderSessions` builds each section label as `text · count` (`bin/cgremlin:9885-9910`). PR review sessions land in `active`. Replace line `bin/cgremlin:9900`:

```javascript
            html += '<div class="section-label">Active &middot; ' + active.length + '</div>';
```

with:

```javascript
            // Surface how many PRs nobody else has reviewed yet — the real queue.
            // Own PRs are excluded: coverage never applies to them.
            const _awaiting = active.filter(s =>
                s.mode === 'review' && !s.is_mine && !s.other_reviews_count).length;
            html += '<div class="section-label">Active &middot; ' + active.length +
                    (_awaiting > 0 ? ' &middot; ' + _awaiting + ' awaiting first review' : '') +
                    '</div>';
```

- [ ] **Step 5: Add the hide-already-reviewed checkbox**

Copy the existing `showArchived` pattern exactly. After the checkbox label at `bin/cgremlin:9434`, add a sibling control:

```html
        <label class="show-archived-toggle"><input type="checkbox" id="hideReviewed"> Hide already-reviewed</label>
```

> Match the surrounding markup: `bin/cgremlin:9434` wraps its input in `<label class="show-archived-toggle">`. Reuse that class rather than introducing a new one, so spacing stays consistent.

- [ ] **Step 6: Read the checkbox state and filter on it**

In `renderSessions`, after the `showArchived` state read at `bin/cgremlin:9836`:

```javascript
        const hideReviewed = document.getElementById('hideReviewed').checked;
```

Then extend the filter at `bin/cgremlin:9837-9839`. Replace:

```javascript
        const filtered = state.sessions.filter(s =>
            Object.values(s).some(v => typeof v === 'string' && v.toLowerCase().includes(filter))
        );
```

with:

```javascript
        const filtered = state.sessions.filter(s =>
            Object.values(s).some(v => typeof v === 'string' && v.toLowerCase().includes(filter))
        ).filter(s =>
            // Hide-already-reviewed applies only to PRs in the review queue; work
            // sessions and our own PRs are never filtered out by it.
            !(hideReviewed && s.mode === 'review' && !s.is_mine && s.other_reviews_count > 0)
        );
```

- [ ] **Step 7: Wire the event listener**

After the `showArchived` listener at `bin/cgremlin:10392`:

```javascript
        document.getElementById('hideReviewed').addEventListener('change', renderSessions);
```

The client re-renders from the cached `state.sessions` array — no refetch — so the toggle is instant, exactly like `showArchived`.

- [ ] **Step 8: Verify both syntaxes**

```bash
bash -n bin/cgremlin && echo "BASH OK"
awk '/^    cat > "\$script_file" << .PYSERVER.$/{f=1;next} /^PYSERVER$/{f=0} f' bin/cgremlin \
  > /tmp/cg_pyserver.py
python3 -c "import ast,sys; ast.parse(open('/tmp/cg_pyserver.py').read()); print('PYTHON OK')"
```

Expected: `BASH OK` then `PYTHON OK`.

> If the `awk` extraction yields an empty file, the heredoc opener line has changed — re-locate it with `grep -n 'PYSERVER' bin/cgremlin` and adjust the pattern rather than skipping the check.

Note that `ast.parse()` only validates the **Python**. The JavaScript edits in Steps 3–7 live inside Python string literals and are not syntax-checked by it — Step 9's browser console check is the only thing that catches a JS typo.

- [ ] **Step 9: Confirm in the browser**

Restart the dashboard and open it. Confirm all of:

- A PR another human reviewed shows a green `👥 <login>` tag; hovering reveals the full reviewer list.
- A PR with no outside review shows no such tag.
- One of your own PRs shows no `👥` tag even if someone reviewed it.
- The Active section label reads `Active · N · M awaiting first review`, and `M` matches the TUI's header count.
- Ticking "Hide already-reviewed" drops covered PRs and leaves work sessions and your own PRs untouched; unticking restores them.
- The browser console is clean — no errors.

- [ ] **Step 10: Commit** *(ask first)*

```bash
git add bin/cgremlin
git commit -m "feat(dashboard): show review-coverage tag on PR sessions"
```

---

## Task 6: `--needs-review` CLI flag

**Files:**
- Modify: `bin/cgremlin` arg dispatch near line 13810
- Test: `tests/mission-control-review-coverage.sh` (append)

**Interfaces:**
- Consumes: `CG_HIDE_REVIEWED` (Task 4) and `review_list_grouped`.
- Produces: `cgremlin --needs-review` — the grouped list with covered PRs filtered out.

- [ ] **Step 1: Write the failing test**

Append before the summary lines:

```bash
printf '\n== Task 6: --needs-review flag ==\n'
rmprs
mkpr 701 granttuttle ""                 ready none
mkpr 702 granttuttle "ebubae:COMMENTED" ready none
NR="$("$CG" --needs-review)"
has   "--needs-review keeps uncovered" "$NR" "#701"
hasnt "--needs-review hides covered"   "$NR" "#702"
rmprs
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bash tests/mission-control-review-coverage.sh
```

Expected: both new assertions FAIL — `--needs-review` is not yet a flag.

- [ ] **Step 3: Add the flag**

Immediately before the `--review-list-grouped` handler at `bin/cgremlin:13810`:

```bash
# Handle --needs-review (grouped list, PRs another human already reviewed omitted)
if [ "$1" = "--needs-review" ]; then
    CG_HIDE_REVIEWED=1 review_list_grouped
    exit 0
fi
```

Add it to the startup guard chain at `bin/cgremlin:13816` as in Task 1, Step 5:

```bash
[ "$1" != "--other-reviews" ] && [ "$1" != "--needs-review" ]; then
```

- [ ] **Step 4: Verify syntax and run the full suite**

```bash
bash -n bin/cgremlin && echo "SYNTAX OK"
bash tests/mission-control-review-coverage.sh
```

Expected: `SYNTAX OK` and `0 failed` across all four test sections.

- [ ] **Step 5: Commit** *(ask first)*

```bash
git add bin/cgremlin tests/mission-control-review-coverage.sh
git commit -m "feat(cli): add --needs-review to list only PRs awaiting a first review"
```

---

## Final Verification

- [ ] `bash -n bin/cgremlin` passes.
- [ ] PYSERVER heredoc `ast.parse()` passes.
- [ ] `bash tests/mission-control-review-coverage.sh` reports `0 failed`.
- [ ] `bin/cgremlin --status-pane`: badges render, uncovered PRs sort first, header count is right, `Ctrl-R` toggles, `Ctrl-A` still toggles archived, typing still searches, `Ctrl-U` still clears.
- [ ] Dashboard shows the `👥` tag on covered PRs only, its "awaiting first review" count agrees with the TUI's, and "Hide already-reviewed" filters without touching work sessions or your own PRs.
- [ ] Browser console is clean — `ast.parse()` does not check the JS inside the Python string literals.
- [ ] A PR reviewed **only** by `guilleazoubel` reads as **uncovered** — the regression that would make the whole feature meaningless.
- [ ] `~/.cgremlin/config` still contains `VERCEL_AUTOMATION_BYPASS_SECRET` (guards against the `save_config` gap noted in Task 1, Step 3).

## Out of Scope

- Staleness detection — reviews count regardless of later pushes.
- Ordering by review state; `CHANGES_REQUESTED` and `COMMENTED` from others are equally "covered".
- Changes to which PRs the daemon picks up; the `reviewDecision != "APPROVED"` filter stays.
- Fixing the pre-existing `save_config` / `VERCEL_AUTOMATION_BYPASS_SECRET` bug.
