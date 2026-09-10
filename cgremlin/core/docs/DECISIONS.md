# Decisions

Dated rulings recorded in the phase design specs (`cgremlin/core/docs/superpowers/specs/`).
Each entry is one line of rationale plus a pointer to where it was decided. Where the
shipped code and a spec disagree, the code is what actually runs — see the parent
conversation's report for the specific discrepancies found while writing this doc set.

## 2026-08-28 — Rebuild design

- **Rebuild, don't patch.** `bin/cgremlin` (~15,000 lines of bash + an embedded ~5,200-line
  Python heredoc) has no test suite and no separation between engine and shell; a ground-up
  TypeScript rebuild is deterministic and unit-testable in a way the bash never could be.
  *§0.*
- **Three independently-replaceable layers**: frontends → engine (daemon, local
  HTTP-over-socket API) → agent-runner adapters. No frontend ever touches `session.json` or
  git directly. *§2.*
- **Worktrees, not shallow clones.** One bare/mirror clone per repo, a `git worktree` per
  session — cheap to create and discard, avoids re-fetching the whole repo per session.
  *§4.*
- **One `AgentRunner` interface, two adapters** (Claude Code, Codex), contract-tested
  identically so the engine's pipeline logic stays agent-CLI-agnostic. *§5.*
- **PR-discovery is its own module**, deliberately over-separated relative to how small the
  logic is, because it's the piece expected to keep changing independently of the
  orchestration engine. *§6.*
- **The engine never posts to GitHub** — invocation + bookkeeping only; the
  reader→reviewer→verifier review logic itself stays in an external Claude Code skill,
  invoked headlessly. *§7.*
- **Phase-1 UI is deliberately disposable** — a placeholder local dashboard, later dropped
  entirely (see 2026-09-04 below) in favor of CLI + a future plugin-style UI against the
  same API. *§9.*

## 2026-09-04 — Phase 3 (Pipelines)

- **Artifact-driven completion, not agent callbacks.** The agent never calls back into the
  engine (legacy had it invoke `cgremlin --plan-ready` etc.); the engine runs one headless
  turn, waits for exit, and reads what was left on disk. Removes the whole class of bug
  where an agent skips or misorders a callback, and needs no CLI shipped inside the
  worktree. *§2.1.*
- **Local-only side effects.** Only read-only `gh` calls (`pr view`, `pr list`) run from the
  engine; any GitHub mutation is deferred to a later, explicit, user-triggered action.
  *§2.2.*
- **Own-PR comment triage deferred** — a distinct feature with its own polling/mutation
  surface, parked past Phase 4. *§2.3, §1 Out.*
- **Failure is a phase only where the phase is an activity.** Review phases gain `failed`
  (they're activity states); investigation/development leave `stageStatus` unchanged on a
  failed run and record it in `lastRun` (they're artifact milestones). *§2.4.*
- **Promotion creates a new development session** rather than flipping `mode` in place —
  the new schema makes `promoted_to_development` terminal, so both records exist and the
  audit trail is honest about what happened. *§2.5.*
- **The brief lives in the session directory, not the worktree** (`<sessionDir>/BRIEF.md`
  via `--add-dir`), so the worktree stays clean of engine files except the permission
  guard. *§2.6.*
- **Multi-turn stages use `--resume`** so a findings→plan sequence keeps its conversation
  context, with the resume id persisted on the session so a restarted engine can continue.
  *§2.7.*
- **Amended mid-phase**: `plan_ready`/`approved` both get a direct edge to
  `promoted_to_development` — the table originally lacked this and an implementation
  synthesized an `approved` step nobody actually took; the audit trail must never show an
  approval that didn't happen. *§3, amended during Task 8.*
- **Amended mid-phase**: GitHub facts (merge, close, approval) apply from any non-terminal
  review phase, matching legacy's unconditional behavior — not just the phases the local
  pipeline would naturally have reached. *§3, amended during 3b Task 6.*
- **A supervising-agent feature was proposed and deferred** to its own phase, after Phase 4,
  because it is a client of the engine API plus the (then-planned) event stream and
  introduces a second, long-lived-interactive agent-runner shape the original interface
  didn't anticipate. *§8.*

## 2026-09-04 — Phase 4 (PR inventory, host, CLI)

- **The dashboard was dropped.** The user decided the UI will be a VS Code plugin or app
  later, reading the engine's API — Phase 4 replaces the planned dashboard with a runnable
  host (`serve`) and a CLI. *§0.*
- **No more auto-reviewing every discovered PR.** The tick used to auto-start a review for
  any newly-discovered candidate; that policy burns tokens on PRs nobody asked to have
  reviewed. Discovery becomes a scan that only produces data; starting a review is now an
  explicit action (`review <url>` / `POST /prs/.../review`); re-review of PRs *already*
  tracked stays automatic. This reverses the earlier Phase 3b ruling and retires
  `DefaultPRDiscoveryStrategy`'s auto-start path. *§0, §4.*
- **Team activity counts any review or conversation comment** from a watched-authors login
  that isn't `me` — bots are excluded by construction (the watch list is an allowlist, not
  a denylist heuristic on `is_bot`). *§3.*
- **Posting to GitHub, when built, is a separate structured-input component** — it would
  receive a verdict and per-finding `{path, line, body}` items and perform the `gh` write;
  it would never itself read or know `REVIEW.md`'s format. Still fully deferred as of this
  writing. *§9.*

## 2026-09-09 — Phase 5 (Environment tooling)

- **Environment preparation happens before the per-session lock is taken; the engine still
  starts the app before the stage run and stops it after; agents never request it.** An
  earlier draft put the local-app start inside the locked pre-run callback; that would hold
  the session lock for up to 90+ seconds (healthcheck) plus a cold `vercel
  link`/`env pull`/`pnpm install`, blocking `stop` and everything else on that session for
  the whole window. Moved outside the lock instead, accepting that a concurrent action can
  occasionally race it (handled safely: the locked pre-run re-validates and, if it loses,
  the just-started app is torn down). *R4, amended.*
- **A failed local-app start degrades the stage; it does not fail it.** Killing a
  40-minute investigation because a dev backend was briefly unreachable is strictly worse
  than telling the agent to verify what it can statically. *R5.*
- **Foreign processes are never killed.** A port held by anything the engine did not
  itself start becomes an `unavailable` status, never a kill — this deliberately diverges
  from the legacy tool, which killed the squatter with only a warning. An engine running
  unattended must not kill a process it didn't start. Boot-time orphan reaping is
  correspondingly narrow: only a process group the engine itself recorded, and only when
  it can still be proven to be the same one. *R6, R13.*
- **The Vercel preview URL comes from the `vercel` bot's PR comment, not the `vercel` CLI**
  — verified live that the CLI is never used for this in legacy, and that the GitHub
  status-check entry carries only an inspector URL, not a navigable deployment URL. *R7.*
- **Local-app stages and preview stages are independently configurable**, defaulting to
  legacy behavior (`develop` gets a local app; `review`/`rereview` get a preview) —
  `findings` can opt in but isn't on by default. *R8.*
- **Review/rereview briefs carry the full legacy REVIEW.md output contract verbatim**,
  restoring behavior that had silently dangled (the prompt referenced a `CLAUDE.md`
  section the engine never wrote). *R9, R10.*
- **Machine prerequisites are config-driven and only ever checked, never fixed.** The
  engine does not edit `/etc/hosts`, configure a port-forward, or install `nvm` versions;
  a dev command that exits before its healthcheck passes is reported with its own log
  output (fast-fail, not a 90-second stall) rather than worked around. *R11, amended.*
- **`nvm` is honored via a login-shell wrapper**, matching legacy exactly, but a missing
  Node version is reported as a prerequisite failure rather than silently installed
  (installing would mutate the user's default nvm alias, a side effect legacy itself
  flagged as unwanted). *R12.*
- **A repo with no `environments` entry renders nothing about environments at all** — not
  just an empty section, but the prompt sentence that would tell the agent to run a LIVE UI
  CHECK is omitted too. The gate is "was the section actually rendered," not a separate
  config flag, so a repo with no Vercel deployment is never told to check a URL that
  doesn't exist. *R14.*
- **The local-app state file is guarded by a dedicated, non-session lock key**
  (`local-app:<port>`) on the same shared lock the sessions use — this is what makes
  "single local-app instance" actually true under concurrent starts, and it cannot nest
  with a session lock because environment prep already runs outside one. *R15.*
- **On shutdown, sessions stop before the local app does.** Pulling the dev server out from
  under an agent still mid-run would look like an app crash rather than a clean shutdown.
  *R16.*
