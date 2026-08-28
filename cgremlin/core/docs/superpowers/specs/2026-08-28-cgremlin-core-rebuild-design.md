# cgremlin/core Rebuild — Design

Date: 2026-08-28
Status: draft, pending user review
Origin: mapped from the existing `context-gremlin` POC (`bin/cgremlin`, a ~15,000-line
bash script with an embedded ~5,200-line Python dashboard server)

## 0. Why this document exists

`context-gremlin` (cgremlin) is a working proof of concept for a very specific way of
working with Claude Code: isolated per-task workspaces, an investigate → plan → develop →
review pipeline with human approval gates, an automatic PR-review daemon, and a live
dashboard ("mission control") showing it all. It works, but it is one 15,000-line bash
script with an embedded Python heredoc, macOS-only or via osascript/iTerm2/Zellij, with
no test suite and no separation between "the engine" (session state, isolation, pipeline
rules) and "the shell" (CLI parsing, terminal spawning, dashboard HTTP handling).

This document specs a ground-up rebuild — living at `cgremlin/core/` in this same repo —
that keeps the exact same way of working, makes it deterministic and testable, and
separates concerns cleanly enough that the UI can be replaced later (a "plugin style" UI,
editor-integrated or otherwise) without touching the underlying engine.

**Location note**: the rebuild lives under `cgremlin/` at the repo root (sibling to
`bin/`), with `cgremlin/core/` as this engine's home and room for future sibling folders
(e.g. `cgremlin/ui/`) as the project grows. It stays inside the `context-gremlin` repo for
now; if it's ever split out, `cgremlin/` is designed to be extractable into its own repo
(e.g. via `git subtree split`) without restructuring.

## 1. Goals & Non-Goals

**Goals**

- Fully local. No hosted backend, no deployment step, ever. Assumes the user already has
  an authenticated agent CLI (Claude Code and/or Codex CLI) on their machine.
- Preserve today's way of working exactly: isolated per-task workspaces; investigate →
  plan (with PM + Principal Engineer approval) → human-approve → develop → review →
  re-review; run the app locally; run tests locally; a live status view of everything in
  flight.
- Pluggable agent runner: Claude Code and Codex CLI are both first-class, swappable
  implementations of one interface. Adding a third agent CLI later should not require
  touching the engine.
- Deterministic, testable core. The state machine, isolation logic, and pipeline rules
  must be unit-testable without spawning a real agent process or a real terminal.
- A real API boundary between the engine and any UI. The phase-1 UI is disposable by
  design — the real UI will be reinvented later in a "plugin style" (e.g. editor-embedded)
  and must be buildable against this API without engine changes.
- The automatic PR-review discovery logic (which PRs get picked up, by whom, filtered how)
  is an isolated, configurable component from day one, so its policy can change without
  touching orchestration.

**Non-goals (for this rebuild)**

- No hosted or multi-user/team-shared component.
- No new agent capabilities beyond what cgremlin already orchestrates (no scope creep
  into new review dimensions, new agent types, etc. — this is a re-platforming, not a
  feature rebuild).
- No commitment to a specific next-generation UI. Phase 1 ships a thin local web
  dashboard for validation; anything "plugin style" is deliberately deferred and out of
  scope for the phases in this document.
- No cross-platform UI work in phase 1 (dashboard is a browser page, which is already
  cross-platform; the *engine* is written to be cross-platform-ready, but Windows/Linux
  validation is deferred).

## 2. High-Level Architecture

Three layers, each independently testable, each replaceable without touching the others:

```
┌─────────────────────────────────────────────────────────┐
│ Frontends (thin clients)                                 │
│  - CLI (cgremlin command)                                │
│  - Phase-1 local web dashboard (Node server + static UI) │
│  - (future) plugin-style UI — not built in these phases  │
└───────────────────────────┬───────────────────────────────┘
                             │ local JSON API (Unix socket / localhost)
┌───────────────────────────▼───────────────────────────────┐
│ Engine (daemon)                                            │
│  - Session & pipeline state machine                        │
│  - Workspace isolation (git worktrees)                     │
│  - PR-discovery strategy (pluggable, configurable)         │
│  - Plan-approval gate enforcement                          │
│  - Review/re-review orchestration (invocation + bookkeeping)│
│  - Environment/config validation                           │
└───────────────────────────┬───────────────────────────────┘
                             │ Agent-runner interface
┌───────────────────────────▼───────────────────────────────┐
│ Agent-runner adapters                                      │
│  - Claude Code adapter                                     │
│  - Codex CLI adapter                                       │
└─────────────────────────────────────────────────────────────┘
```

The engine never shells out to `claude` or `codex` directly, never spawns a terminal, and
never knows about HTML or the dashboard. Frontends never touch `session.json` files or git
directly — everything goes through the engine's API, which removes today's "two UIs
independently read the same file and can race" hazard.

## 3. Session & Pipeline State Model

Formalizes what's implicit today into an explicit, typed, versioned state machine — the
single highest-value piece of "making this deterministic."

- **Session**: `{ id, mode: 'review' | 'investigation' | 'development', lineage, createdAt,
  workspace, stageStatus, schemaVersion }`. `mode` is the *only* source of truth (today's
  ambiguity between `mode` field and directory-name prefix like `pr-*`/`inv-*`/`dev-*` is
  resolved by making mode canonical from day one, with a migration script for any old
  cgremlin sessions someone wants to import).
- **Pipeline state machine**, one explicit transition table per mode, not scattered `if`
  checks:
  - investigation: `findings → planning → plan_ready → approved → promoted_to_development`
  - development: `active → pr_opened → superseded (by review session) → merged | abandoned`
  - review: `queued → reviewing → ready → approved | changes_requested | dismissed`
  - Illegal transitions are rejected by the engine at the API layer, not just
    discouraged by CLI flag ordering (today, e.g., nothing stops `--develop` from being
    called before plan approval except a bash `if` a caller could bypass).
- **Persistence**: still flat JSON files under `~/.cgremlin/sessions/<id>/`, but every
  read/write goes through the engine. The file format is schema-versioned so future
  migrations are explicit and testable.

## 4. Workspace Isolation

Switch from today's shallow-clone-per-session to **git worktrees off one local bare/mirror
clone per repo**. Rationale: worktrees share the object store (cheap to create, cheap to
discard), are the standard tool for exactly this "many isolated working copies of one repo"
use case, and avoid re-fetching the whole repo per session. Each session gets its own
worktree + branch; teardown is `git worktree remove`. Permission guards
(`.claude/settings.local.json`-equivalent allow/deny lists per mode) are generated from a
typed config object instead of hand-written JSON blobs scattered through source, so the
"what can the investigation agent run vs. the review agent" policy lives in one reviewable
place.

## 5. Agent-Runner Abstraction

One interface, two implementations:

```ts
interface AgentRunner {
  start(ctx: SessionContext): Promise<AgentHandle>
  sendPrompt(handle: AgentHandle, prompt: string): Promise<void>
  onOutput(handle: AgentHandle, cb: (chunk: Output) => void): void
  onExit(handle: AgentHandle, cb: (result: ExitResult) => void): void
  stop(handle: AgentHandle): Promise<void>
}
```

- `ClaudeCodeRunner` — shells out to `claude`, mirrors today's headless invocation
  contract (permission-guard file, `-p` prompt, output-file conventions).
- `CodexRunner` — shells out to `codex`, same contract, different CLI flags/output shape
  underneath.
- The engine's pipeline logic (plan-approval gate, review orchestration) only ever calls
  the `AgentRunner` interface, so it is agent-CLI-agnostic. Contract tests run the same
  test suite against both adapters (using recorded/mocked transcripts, not live CLIs) to
  guarantee they satisfy the same behavioral contract.

## 6. PR-Discovery Strategy (Isolated, Configurable)

Today's `watch_daemon_loop` (poll `gh pr list`, filter by `WATCH_AUTHORS`, review-decision
state, bot denylist) becomes its own module behind an interface:

```ts
interface PRDiscoveryStrategy {
  poll(config: DiscoveryConfig): Promise<CandidatePR[]>
}
```

The default implementation reproduces today's policy (author allowlist, exclude
`reviewDecision === 'APPROVED'`, exclude self/bot reviews) but lives in one file with its
own unit tests and its own config schema, entirely separate from session orchestration.
This is deliberately over-separated relative to how small the current logic is, because
this is exactly the piece the user expects to iterate on independently (different repos,
different filtering rules, different trigger conditions) without risking the orchestration
engine.

## 7. Review & Plan-Approval Pipeline Orchestration

Preserves today's architecture: cgremlin/core does **not** reimplement the
reader→reviewer→verifier fan-out (that continues to live in an external Claude Code skill
invoked headlessly) — it owns the invocation contract and the state bookkeeping around it.

- **Invocation contract**: the engine builds prompt/guard-file/output-path once per
  `AgentRunner`, so a Codex-CLI-driven review and a Claude-Code-driven review both produce
  the same `REVIEW.md` contract despite different underlying CLIs.
- **Plan-approval gate**: `develop()` is only callable when
  `pipeline.phase === 'approved'`, or when `driveToCompletion === true` and
  `phase >= 'plan_ready'`. This single rule, enforced once in the engine, replaces today's
  duplicated checks across CLI dispatch and dashboard button logic.
- **Re-review**: same archive-and-diff mechanics as today (`REVIEW.md` → `REVIEW-vN.md`,
  diff-aware prompt) but the engine computes version bookkeeping deterministically and
  hands the adapter a fully-formed prompt, rather than building it via inline bash string
  interpolation.

## 8. Environment & Local Testing Tooling

Preserves the "way of working" exactly — run the app locally, run tests locally, three
browser-test flows (headless review with Vercel bypass, headless local dev with Clerk test
user, visible interactive demo) — but environment config (local URL, bypass secret, Clerk
test credentials, Vercel scope/project, dev command) moves into a typed, validated
per-repo config file, replacing today's ad hoc `~/.cgremlin/config` KEY=value parsing. The
actual browser driving continues to delegate to chrome-devtools MCP / Playwright,
unchanged — this section is about config discoverability and validation, not replacing the
browser tooling.

## 9. UI Layer (Phase 1, Deliberately Disposable)

Phase 1 ships exactly one frontend: a small local web dashboard (Node/Express or Fastify
server + static frontend) replacing the ~5,200-line embedded Python heredoc, talking to the
engine over the same API any future frontend would use — no back-door access. Real-time
updates via Server-Sent Events (the engine pushes state-change events) instead of
polling-every-2-seconds. Feature parity target: sessions list, PLAN/REVIEW tabs, the
approve-for-development button, terminal/log viewing.

This UI is explicitly a placeholder. The real UI — "reinvented for the plugin style" — is
out of scope for these phases; the API boundary defined here is the contract that future UI
must be buildable against without engine changes.

The TUI (Zellij/iTerm2-based mission control) is **deprioritized past these phases**
entirely — it is the piece most entangled with macOS-specific terminal spawning, and the
dashboard replaces its function for now.

## 10. Testing & Determinism Strategy

- **Engine core** (state machine, transitions, isolation logic): pure unit tests. Fake
  `AgentRunner` and a fake filesystem/git layer are injected in tests — no real subprocess,
  no real git repo required for these tests.
- **Agent-runner adapters**: contract tests against recorded/mocked CLI transcripts (no
  live Claude/Codex session needed for CI), plus a manual smoke-test checklist for the real
  CLIs before release.
- **PR-discovery strategy**: unit tests against mocked `gh` API responses.
- **API layer**: integration tests against the real local API server, operating on a temp
  sessions directory.
- **Dashboard frontend**: component tests plus one end-to-end smoke test (create session →
  approve plan → see state reflected).
- **CI**: unit/integration/contract tiers run on every change since everything is local;
  live-CLI smoke tests stay manual/pre-release only (they require real authenticated CLI
  sessions).
- **TDD**: every phase below is implemented test-first — the state machine and isolation
  logic in particular should have their contract defined by tests before implementation.

## 11. Phased Roadmap

Each phase is independently implementable and gets its own implementation plan
(via the writing-plans process) when its turn comes.

- **Phase 0 — Scaffolding**: `cgremlin/core/` folder inside this repo, TypeScript project,
  lint/test/CI wiring, typed session-state schema, migration script stub for importing
  existing `~/.cgremlin/sessions/*/session.json` files.
- **Phase 1 — Engine core**: state machine (section 3), worktree-based isolation
  (section 4), local API server (Unix socket/localhost JSON), `AgentRunner` interface with
  a fake/stub implementation only — fully unit/integration tested, no real CLI integration
  yet.
- **Phase 2 — Agent-runner adapters**: real `ClaudeCodeRunner`, then `CodexRunner`, against
  the interface from Phase 1; contract tests for both.
- **Phase 3 — Pipelines**: investigate → plan → approve → develop gate (section 7),
  review/re-review orchestration, PR-discovery strategy (section 6), PR-linking/lineage —
  built on Phases 1–2.
- **Phase 4 — Dashboard (phase-1 UI)**: Node server + static frontend (section 9), SSE-based
  live updates, feature parity with today's dashboard views.
- **Phase 5 — Environment tooling**: typed config (section 8), the three browser-test
  flows, wired into the Phase 3 pipelines.
- **Phase 6 — Parity hardening + cutover**: run cgremlin (old, `bin/cgremlin`) and
  cgremlin/core (new) side by side, migrate real sessions, retire `bin/cgremlin`.
- **Phase 7+ (deferred, not speced in this document)**: TUI revisit, plugin-style UI
  design and build, cross-platform (Windows/Linux) validation, possible extraction of
  `cgremlin/` into its own repo.

## 12. Open Questions / Decisions Deferred On Purpose

- Exact API transport (Unix domain socket vs. localhost TCP vs. named pipe for Windows)
  is a Phase 1 implementation detail, not decided here.
- Exact plugin-style UI target (VS Code, another editor, a standalone app) is explicitly
  deferred past Phase 6 — this document only guarantees the API boundary that any of those
  would build against.
- Whether existing `context-gremlin` sessions get migrated automatically or the cutover
  starts fresh is a Phase 6 decision, informed by how the parity hardening period goes.
- Whether/when `cgremlin/` gets split into its own repo is deferred to whenever that's
  actually needed — the folder structure is chosen so that move is mechanical when it
  happens.
