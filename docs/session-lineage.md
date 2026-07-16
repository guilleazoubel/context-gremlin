# Session Lineage & Pipeline View — Design Note

Status: design/planning only. No code written. Line numbers are current-as-of this
investigation and WILL drift; the implementer must re-verify each with grep before
editing. Source of truth for all edits is the heredoc inside `bin/cgremlin` — NOT
the generated `~/.cgremlin/sessions/.dashboard_server.py`.

After ANY edit: `bash -n bin/cgremlin`, and ast.parse() the extracted PYSERVER
heredoc. Treat every change in this doc that touches the Python heredoc as
bash↔Python-sync-sensitive: keep indentation consistent and never break the
heredoc quoting.

---

## 0. Executive summary of what exists today

- Three session kinds are directories under `$SESSIONS_DIR` distinguished ONLY by
  id prefix (`pr-`, `dev-`, `inv-`) and by the `mode` field in `session.json`.
- There is **already one real in-place transition**: `develop_start()`
  (bin/cgremlin:13627) promotes an investigation to development BY MUTATING THE
  SAME session — it flips `.mode` from `investigation` to `development`
  (line 13641) and keeps the `inv-*` directory name. So "inv→dev" today is a
  single session that changes mode, NOT two linked sessions. This is the single
  most important fact for the design: the lineage model must handle BOTH
  "one session that changed mode in place" AND "separate sessions that should be
  grouped".
- There is **no dev→pr link** at all. PR sessions are created independently
  (`create_pr_session_noninteractive` :13329, interactive :2885, `track_my_pr`
  :13740). Nothing records which dev session a PR came from.
- Grouping across kinds today is purely coincidental: `parse_session_json`
  extracts a `jira` ticket for every mode (:8046-8072), and that is the only
  common key. Nothing renders them together.

---

## 1. Where each session kind is created (initial session.json writers)

All roads write `session.json` through `create_session_json()`
(bin/cgremlin:159-193). It writes the base object `{id, mode, project, created,
status:"active", terminal, history}` and merges caller `extra_fields` via jq
`+ $extra`. **This is the one function to extend** so every new session gets
lineage defaults (see §5).

Investigation (`inv-*`):
- Interactive: `create_investigation_session()` :3359; names session :3507
  (`inv-${REPO}-<ts>`); builds `extra_json` :3567-3577; calls
  `create_session_json ... "investigation"` :3578.
- Non-interactive (web UI / `investigate_start`): `create_investigation_session_noninteractive()`
  :13442; names :13449; extra_json :13459-13465; create call :13467.
- `investigate_start()` :13523 wraps the non-interactive creator and is the entry
  for the web "Investigate" button (Python calls `--investigate` at :7540) and
  the `--investigate` CLI (:13969).

Development (`dev-*`):
- Interactive: `create_development_session()` :3750; names :3913
  (`dev-${REPO}-${ticket_id}-<ts>`); extra_json :3972-3984; create call :3985.
- Non-interactive: `create_development_session_noninteractive()` :13536; names
  :13543 (`dev-${REPO_NAME}-${JIRA_TICKET}-<ts>`); extra_json :13555-13563;
  create call :13565.
- **In-place promotion** from an investigation: `develop_start()` :13627 — does
  NOT create a session; flips `.mode` to development on the existing inv session
  (:13641), sets `.branch` (:13644), keeps FINDINGS.md, seeds DEVELOPMENT.md,
  rewrites the brief. Entry: `--develop` CLI :13974.

PR review (`pr-*`):
- Interactive: within the review flow, names :2885 (`pr-${REPO}-${PR_NUMBER}-<ts>`);
  extra_json :2951-2977; create call :2978.
- Non-interactive: `create_pr_session_noninteractive()` :13329; names :13344;
  extra_json :13374-13382; create call :13384 (+ fallback minimal json :13388).
- `review_pr_noninteractive()` :13713 dedups by PR-number glob `pr-*-${n}-*`
  (:13718) before creating.
- `track_my_pr()` :13740 creates a pr-* session for the user's OWN PR (calls
  `create_pr_session_noninteractive` :13745) and sets `mine_stage=tracking`.

---

## 2. Where transitions happen today

- **inv→dev**: ONLY via `develop_start()` :13627, in place (mode flip, same dir).
  Today it reads `jira.ticket` (:13631) but writes NO lineage/parent field. This
  is the natural insertion point for lineage bookkeeping (§6). Note: because it
  mutates one session, after promotion there is exactly ONE directory whose
  `mode=development` but whose id still starts `inv-`. Any grouping logic keyed on
  the id prefix (see the prefix→type maps at :7835-7868 and :2422-2437) is WRONG
  for this case — `.mode` is authoritative, prefix is only a fallback.
- **dev→pr**: none. The develop brief instructs the agent to run `gh pr create
  --draft` itself (:13592) and later `cgremlin --pr-ready` (:13608 → `pr_ready()`
  :363). `pr_ready()` back-fills `pr.number` onto the SAME dev session by asking
  `gh pr view` (:368-370) — so a promoted dev session gains a `pr.number` in
  place, but NO separate review session is created and nothing links a later
  `pr-*` review session back to it.
- **Dedup**, not lineage: `review_pr_noninteractive()` :13716-13728 reuses an
  existing `pr-*` session for the same PR number. This is the closest thing to a
  link and is keyed on PR number in the dir name.

Conclusion: today lineage is inferable only by (a) same directory after a mode
flip, (b) matching `jira.ticket`, or (c) matching PR number. All three are used
inconsistently. The design makes (a)/(b)/(c) fallbacks and adds explicit fields.

---

## 3. The ~4 near-duplicated pr_number-derivation blocks (Python dashboard)

Each block does the same thing: try `session.json` `.pr.number` + parse
owner/repo from `.project` via `github\.com/([^/]+)/([^/]+)`, else fall back to
regex `PR #(\d+)` and `Repository:` over `session-info.txt`. Consolidate into ONE
helper (proposed `self._derive_pr_ref(session_path) -> (pr_number, owner, repo,
base)`), then call it from all four:

1. `post_review_comment` block — bin/cgremlin:6465-6503 (also parses base? no; sets owner/repo).
2. `refresh_pr_discussion` — bin/cgremlin:6728-6762.
3. `import_pr_comments` — bin/cgremlin:6932-6969.
4. `_do_...` PR-base block — bin/cgremlin:7132-7162 (this one ALSO derives
   `pr_base` from `.pr.base` / `Branch: … → base`).

Related (not identical but should reuse the same owner/repo parse):
- `parse_session_json` review branch — :8029-8045 (derives pr, url, repository).
- `_get_pr_state` — :7982-7993 (parses repo slug from `info['repository']`).
- bash equivalents (leave as-is unless refactoring bash too): `format_session_display`
  :2394, `select_session_simple` :2496, and the many `read_session_field "$d"
  "pr.number"` callers.

The new helper must preserve current behavior exactly: V2-first, V1 fallback,
number coerced to string, owner/repo `.git`-stripped, and `pr_base` default
`'main'` for the block at :7132.

---

## 4. Where the session list is rendered today (both surfaces)

### Bash TUI status pane (Mission Control fzf picker)
- `status_pane_loop()` :1154 drives it; it shells out to `--review-list-grouped`
  (:1165, :1167) whose handler is at :13307 → `review_list_grouped()` :648.
- `review_list_grouped()` :648-772 is THE function to change for grouped pipeline
  rendering in the TUI. It:
  - Iterates `pr-*` only (:652) into zone buckets (mergemine/mycomments/ready/
    rereview/inflight/response/approved/mytracking) and prints section headers
    :745-753.
  - Then, SEPARATELY, iterates ALL sessions with `mode` in
    investigation|development (:756-771) into a flat "🔨 Your work" zone.
  - Output is TSV `label\tsession-name\tzone`; empty col-2 = header row (no-op on
    Enter). Grouping must keep this contract (a lineage header row has empty
    col-2; each stage segment is its own selectable row with its own session name
    in col-2).
- `render_status_table()` :774-791 is a simpler PR-only table (used elsewhere);
  lower priority, update for consistency only.
- `_agent_tab_name` :800 and `work_agent_tab_name` :827 already choose per-stage
  emojis (🔍/🔨 for work, ✅/💬/🔁/🔔/👀 for PR) — reuse these for the badge trail.

### Python web dashboard
- API: `do_GET` `/api/sessions` :5845; the scan/build loop is :7816-7930
  (per-session `info` dict), post-processing/sort :7947-7962. Type detection by
  prefix at :7835-7868 (fallback only). `parse_session_json` :8008-8086 already
  emits `info['jira']` for every mode — the grouping key already exists in the
  payload. **Add lineage fields to the info dict here** (§7).
- Frontend: `loadSessions()` :9441 → `renderSessions()` :9456 → `renderSessionItem()`
  :9498. `renderSessions` buckets by live/active/done/archived (:9464-9489) and
  maps each to `renderSessionItem`. This is where pipeline grouping is added
  (§7): group by pipeline key, render one lineage container with a stage-badge
  trail, each segment calling `selectSession(name)` (:9536) independently.

---

## 5. Proposed session.json schema addition

Add to the base object in `create_session_json()` (:159-193) so EVERY new session
is born with lineage scaffolding. Keep additive + backward compatible (jq `// `
defaults everywhere on read).

New top-level fields:

```
lineage: {
  pipeline_id: string,          // stable per-ticket-pipeline id, e.g. "pl-HB-1090-20260713-120000"
  parent_session_id: string|null, // the session this stage was spawned from (null for the first stage)
  ticket: string|null           // denormalized jira key for cheap fallback matching
},
stage_status: string            // enum, per-kind (see below); default per mode
```

Per-kind `stage_status` enums (state machines):

- investigation: `active` → `promoted` (when develop_start runs) | `abandoned`.
- development:   `active` → `pr_opened` (draft/real PR exists) → `superseded`
                 (a review session took over) → `merged` (terminal: the PR merged;
                 the watch daemon marks this and archives the session) | `abandoned`
                 (terminal: the PR was closed unmerged, or the work was dropped).
- review:        `queued` → `ready` → `approved` | `changes_requested` | `dismissed`.

Design choice — do NOT overload the existing fields:
- Keep existing `status` (active/archived), `review_state`
  (queued/reviewing/ready/failed/interrupted, :226-232), `lifecycle`
  (none/commented/changes-requested/approved, :242-247), `mine_stage`
  (tracking/triaging/ready, :270-272) UNCHANGED — `--dismiss-pr`/`--open-pr` and
  the watch daemon depend on them. `stage_status` is a NEW, higher-level lifecycle
  layer derived-or-set alongside them, not a replacement. For review sessions its
  value can be computed from the existing review_state+lifecycle at render time
  (map: queued/reviewing→queued, ready→ready, lifecycle approved→approved,
  changes-requested→changes_requested, dismissed via `--dismiss-pr`).

`pipeline_id` generation:
- First stage of a ticket (fresh investigation or standalone dev/pr with a jira
  key): `pl-<TICKET>-<ts>` if a ticket exists, else `pl-<session-id>` (a pipeline
  of one). Write at creation.
- Spawned stage: inherit parent's `pipeline_id` and set
  `parent_session_id=<parent id>` (§6).

Helper accessors to add near :242-272 (mirror existing `update_/read_` pairs):
`update_lineage_field`, `read_lineage_field`, `update_stage_status`,
`read_stage_status` (default per mode).

---

## 6. Where to insert write-time linking

1. `create_session_json()` :159-193 — extend base json to always include
   `lineage:{pipeline_id, parent_session_id:null, ticket:null}` and
   `stage_status` defaulted by mode (investigation→active,
   development→active, review→queued). Callers that know the ticket/parent
   override via the existing `extra_fields` merge — so NO new positional args are
   strictly required, but for clarity add optional env-or-arg passthrough.

2. `develop_start()` :13627 (inv→dev, in place) — this is THE key edit:
   - Before/after flipping `.mode` (:13641), if the session has no
     `lineage.pipeline_id`, mint one from `jira.ticket`.
   - Set `stage_status`: the OLD investigation identity becomes `promoted`. Since
     the SAME session is reused, record the transition in `history` (via
     `add_session_history` :1180) with action `promoted-to-development` rather
     than losing the investigation stage. **Design decision flagged for executor:**
     because develop_start reuses one directory, the "promoted investigation" and
     the "active development" are the SAME session at different times. Two options:
     (a) keep single-session + rely on `history` for the trail (simplest, honors
     "never delete/hide" trivially); (b) split into two linked sessions at
     promotion (more faithful to the pipeline badge trail, but changes
     develop_start semantics and risks the bash↔Python sync). Recommend (a) for
     this pass; the pipeline row shows one segment whose badge is derived from
     mode+history. This is an unresolved judgment call → executor-heavy.

3. Standalone `create_development_session*` (:3985, :13565) — if created from an
   approved investigation (future agent handoff), accept an optional
   `--parent <inv-session>` and set `lineage.parent_session_id` +
   inherited `pipeline_id`; mark the parent inv's `stage_status=promoted` via
   `update_stage_status`. Absent a parent, mint a fresh pipeline_id from the
   ticket.

4. dev→pr link: two sub-cases.
   - `pr_ready()` :363 (dev session opens/finalizes its own PR): after
     back-filling `pr.number` (:370), set the dev session's
     `stage_status=pr_opened`. (No separate review session yet — this keeps
     `--pr-ready` behavior otherwise unchanged, satisfying the constraint.)
   - `create_pr_session_noninteractive()` :13329 and `review_pr_noninteractive()`
     :13713: when a review session is created for a PR, look up a dev/inv session
     with a matching `pipeline_id` (preferred) or matching `jira.ticket`
     (fallback) or matching PR number, and write the review session's
     `lineage.parent_session_id` + inherited `pipeline_id`; mark the matched dev
     session `stage_status=superseded`. Because these creators may not know the
     ticket, reuse `parse_session_json`'s jira-from-branch/title logic
     (:8046-8054).

All writes go through jq helpers (`update_session_field`/new lineage helpers) —
never hand-rolled heredoc JSON (see the warning at :163-165 and :13371-13372).

---

## 7. Pipeline grouping / rendering logic

### Shared grouping key
`pipeline_id` when present; else `jira.ticket`; else PR number; else the session's
own id (a pipeline of one). This ordered fallback is the ONLY place old,
lineage-less sessions get grouped — satisfying the "fallback matching for old
sessions only" constraint.

### Bash TUI (`review_list_grouped()` :648)
- Add a new grouping pass: build an associative array `pipeline_key -> list of
  (session, mode, stage_status, badge)`. Iterate BOTH the pr-* loop and the
  work-session loop (:756-771) into this map instead of (or in addition to) the
  current flat zones.
- Emit one header row per pipeline (empty col-2 → non-selectable, matching the
  existing header convention at :745) whose label is the badge trail, e.g.
  `HB-1090: 🔍 promoted → 🔨 active → 🔔 #1725 queued`, built from the per-stage
  emoji helpers (`work_agent_tab_name` :827 for 🔍/🔨, `_agent_tab_name` :800 for
  PR emojis) + `stage_status`.
- Under each header, emit one selectable row per stage segment (col-2 = that
  stage's session name) so each stage still opens via `--open-pr`/work tab
  exactly as today. Preserve the action-zone ordering by sorting pipelines by
  their most-actionable stage.
- Keep single-stage pipelines rendering like today (no visual regression for lone
  sessions).

### Python dashboard
- Server (:7816-7930): after building each `info`, add
  `info['pipeline_id']`, `info['parent_session_id']`, `info['stage_status']`
  (read from lineage, with the §7 fallback computing a synthetic pipeline_id for
  old sessions). Optionally compute `info['pipeline_key']` server-side so the
  client doesn't reimplement fallback logic.
- Frontend `renderSessions()` :9456: add a grouping step — `groupByPipeline(list)`
  keyed on `pipeline_key` — and render each group as a collapsible lineage
  container: a header showing the ticket + badge trail (reuse mode + stage_status
  → emoji), and inside it the existing `renderSessionItem(s)` (:9498) for each
  stage so selection/click (`selectSession` :9536) is unchanged. Single-session
  groups render flat (no container chrome) to avoid clutter. Keep the existing
  live/active/done/archived bucketing as a secondary sort WITHIN or ACROSS groups
  — recommend grouping first, then ordering groups by whether any member is live.
- Add `tag`/badge CSS near the existing `.tag-*` styles (:9508-9516) for stage
  badges (promoted/superseded/etc.).

### Future agent handoff (design only, not implemented)
The `lineage.pipeline_id` + `parent_session_id` + `stage_status` triad is
sufficient for: a dev agent opening a draft PR to flip its own `stage_status` to
`pr_opened` and (later) trigger creation of a review session that inherits the
pipeline_id; and review findings (REVIEW.md / changes_requested) routing back by
looking up the `parent_session_id` dev session and reopening its work tab. No
code required now — the schema just must not preclude it.

---

## 8. Migration / backward-compat note

- Old `session.json` files lack `lineage` and `stage_status`. Every READ must use
  `// ` jq defaults (bash) / `.get(...)` (Python), exactly as existing fields do.
- Grouping for lineage-less sessions falls back to `jira.ticket` → PR number →
  own id (§7). An old inv+dev+pr trio that share a ticket will still group into
  one pipeline row via the ticket fallback; they simply won't show explicit
  parent arrows.
- Sessions with neither lineage nor ticket render as single-stage pipelines
  (identical to today's flat row) — no regression.
- `stage_status` for review sessions can be DERIVED from existing
  `review_state`+`lifecycle` at render time, so old PR sessions get correct
  badges without a migration write.
- No new external store; all fields live in `session.json` (constraint met).
- `--dismiss-pr` (:13284) and `--open-pr` (:14022) behavior unchanged: dismiss
  may additionally set review `stage_status=dismissed`, but the existing triage/
  archive path is untouched.

## 9. Verification checklist per step
- After schema edit to `create_session_json`: create a fresh inv/dev/pr session,
  `jq .lineage,.stage_status session.json` shows defaults; `bash -n bin/cgremlin`.
- After `develop_start` edit: promote an inv session; confirm history entry +
  stage_status, and the dir still opens.
- After Python helper consolidation: exercise post-comment / refresh-discussion /
  import-comments / pr-base paths; ast.parse() the PYSERVER heredoc.
- After rendering edits: load dashboard + TUI; confirm a shared-ticket trio
  groups, a lone session renders flat, and an OLD lineage-less session still
  groups by ticket.

---

## 10. Implementation notes (as-built)

Implemented per this design. Deviations, resolved judgment calls, and confirmations:

### Line drift
All line numbers in this doc drifted (bash edits above the Python heredoc shift it).
Every site was re-located by grep before editing. The PYSERVER heredoc runs
`bin/cgremlin:~5625 → ~10892` (quoted `'PYSERVER'`, no bash expansion inside).

### Schema (§5/§6.1) — `create_session_json`
- Added `lineage:{pipeline_id,parent_session_id,ticket}` + `stage_status` to the base
  object, backfilled AFTER the `+ $extra` merge so callers can override any part via
  `extra_fields` (no new positional args — as the design allowed). `stage_status`
  defaults by mode (review→`queued`, else `active`). `pipeline_id` is minted
  `pl-<TICKET>-<ts>` when a ticket is known (denormalized from `.jira.ticket`), else
  `pl-<session-id>`. jq handles `.jira == null` (interactive creators pass `jira:null`)
  gracefully. The rare fallback minimal JSON in `create_pr_session_noninteractive`
  also got `lineage`/`stage_status` for consistency.
- New bash accessors near the other helpers: `update_lineage_field`,
  `read_lineage_field`, `update_stage_status`, `read_stage_status` (mode-defaulted).

### Promotion (§6.2) — DECISION (a), single-session + history
As directed by the task's architectural decision, inv→dev promotion stays a
single-session mode-flip. `develop_start()` now: mints a `pipeline_id` if the (old)
session lacks one, records `lineage.ticket`, appends a `promoted-to-development`
history entry, then flips mode and sets `stage_status=active`. The 🔍→🔨 trail is
derived at render time from mode + history (or the `inv-` prefix fallback for old
sessions). §6.3 (separate dev-from-inv session with `--parent`) was intentionally
NOT implemented: no code path creates a separate dev session from an investigation
(promotion is in-place), so an `--parent` arg would be dead scaffolding.

### dev→pr linking (§6.4)
- `pr_ready()` sets the dev session `stage_status=pr_opened` on success (behavior
  otherwise unchanged).
- New `link_pr_to_source(PR_DIR, PR_NUMBER, [TICKET])` runs at BOTH PR-session
  creation sites (interactive ~3049 and non-interactive ~13647). It matches a
  dev/inv source by PR number first (strongest — `pr_ready` back-fills `pr.number`
  onto the dev session), then by jira ticket; on a match it inherits the source's
  `pipeline_id`, writes `parent_session_id`+`ticket` on the review session, and marks
  the source `stage_status=superseded`. Best-effort — never fails creation; no source
  → graceful no-op. `review_pr_noninteractive`/`track_my_pr` inherit this via
  `create_pr_session_noninteractive`; the re-review dedup path creates no new session,
  so it needs no linking.

### Python helper consolidation (§3)
- Added `_derive_pr_ref(session_path) -> (pr_number, owner, repo, base)` and replaced
  all FOUR duplicated blocks (`post_pr_comment`, `refresh_pr_discussion`,
  `import_pr_comments`, and the PR-base block in `refresh_pr`). Behavior verified
  byte-identical against the original block logic on all real sessions AND synthetic
  V1 inputs (org/repo slug, full-URL repo, missing branch) and int-vs-str numbers.
  The helper coerces `pr_number` to str (stored numbers are already strings, so this
  is a no-op in practice) and wraps V2 JSON parsing in try/except so malformed JSON
  falls through to V1 (strictly more robust; malformed JSON never occurs since
  session.json is jq-written).
- REGRESSION CAUGHT & FIXED during self-review: the block-4 edit in `refresh_pr`
  removed the `session_json`/`info_file` locals that are reused later in that same
  (280-line) method; re-added those two Path definitions. pyflakes confirms zero
  undefined names after the fix.
- The two "related" sites (§3) were deliberately NOT folded into `_derive_pr_ref`
  because doing so would CHANGE their output shape (violating "preserve exact
  behavior"): `_get_pr_state` parses a slug from the already-built `info` dict
  (different input source, handles the `github.com:` ssh form) and `parse_session_json`
  stores the full project URL as `info['repository']` (not an owner/repo pair). Both
  left as-is.

### Rendering (§7)
- Server: `parse_session_json` now emits `pipeline_id`, `parent_session_id`,
  `stage_status` (review derives from lifecycle/review_state via `_default_stage_status`),
  and `promoted_from_investigation` (history action OR `inv-`-prefix+dev-mode fallback).
  `send_sessions_list` computes `pipeline_key` with the ordered fallback
  `pipeline_id > jira:<ticket> > pr:<num> > sid:<name>`, and defaults the fields for
  V1/broken sessions too.
- Frontend: `renderSessions` groups by `pipeline_key`; multi-stage pipelines (>1
  member, or a lone promoted session worth its 🔍→🔨 trail) render as a collapsible
  `.lineage-group` with a stage-badge trail at the top; lone sessions keep the
  existing Live/Active/Done/Archived sections (no regression). Each badge and each
  nested item calls `selectSession(name)` independently (click-through unchanged).
  Collapse state persists across polls via a module-level `Set`. Added
  `.lineage-*`/`.stage-badge` CSS near `.tag-*`.
- Bash TUI (§7 / task item 4): FULL collapsible grouping is NOT done bash-side —
  `review_list_grouped()` feeds a FLAT TSV to fzf where PR rows and work rows live in
  separate action-zones with different selection semantics (`--open-pr` vs work tab),
  and a nested/collapsible container has no representation in fzf's flat one-row-per-
  line model. Instead, per the task's fallback instruction, work rows now show inline
  lineage indicators: a 🔍→🔨 trail emoji for promoted dev sessions (history or `inv-`
  prefix) and a `[PR open]`/`[in review]` badge for `pr_opened`/`superseded` stages.
  The TSV `label\tsession\tzone` contract is preserved.

### Backward-compat / migration (§8) — confirmed
- Every new read uses jq `//` (bash) / `.get()` (Python) defaults; the real
  `DashboardHandler` code was executed in-process against the six real (lineage-less)
  sessions and produced correct grouping: the promoted `inv-…HB-1090` (dev mode) +
  `pr-…-1725` collapse into ONE pipeline via the ticket fallback; lone sessions render
  flat; old PR sessions get correct derived stage badges (ready/approved/queued) with
  no migration write. No inv/dev/pr session is ever deleted or hidden on progression
  (promoted/superseded/pr_opened are statuses only). No new external store.
- `--dismiss-pr`/`--open-pr` untouched (dismiss does NOT set a stage_status in this
  pass, to keep observable behavior identical).

### Pre-existing bug fixed (required by §6.2)
`add_session_history()` declared `local details="${3:-{}}"` — the SAME
`${x:-{}}` brace-parsing pitfall CLAUDE.md warns about for `create_session_json`.
bash parses it as `${3:-{}` + a literal `}`, appending a stray `}` to any SET `$3`,
producing invalid JSON that fails the internal `jq --argjson det` and SILENTLY drops
the history entry. This had already been silently breaking every existing caller that
passes details (`mode_switch`, `terminal_started`, `migrated`). Because §6.2 relies on
the `promoted-to-development` history entry as the PRIMARY promotion signal, this was
fixed to the guarded form `local details="$3"; [ -z "$details" ] && details="{}"`.
Verified: the history entry now records and the dashboard parser detects the promotion
via the history action (not just the `inv-` prefix fallback). Callers passing no
details are unaffected (still default to `{}`).

### Cosmetic
Two now-unused `import re` statements remain in refactored methods (their only `re`
use moved into `_derive_pr_ref`). Left in place to minimize churn in the fragile
heredoc; harmless at runtime.
