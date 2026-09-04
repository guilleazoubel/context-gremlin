# cgremlin/core Phase 2b: CodexRunner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `CodexRunner`, the second real `AgentRunner` adapter, shelling out to the `codex` CLI with the same contract `ClaudeCodeRunner` satisfies, and add a shared adapter contract test suite that runs against both adapters' fixture CLIs so the engine can treat them interchangeably (spec §5).

**Architecture:** `CodexRunner implements AgentRunner` by spawning `codex exec --json …` per `sendPrompt()` (first turn) or `codex exec resume <thread_id> --json …` (later turns), parsing NDJSON stdout line by line keyed on the event `type` (never on line position), forwarding `item.completed` agent messages as stdout output and error events as stderr output, capturing `thread.started.thread_id` as the resume id, and firing `onExit` with the OS exit code/signal. The working directory is the spawn `cwd` (not `-C`), because `exec resume` accepts no `-C`, `--sandbox` or `--add-dir`. Tested against a controllable fixture standing in for the `codex` binary, exactly like Phase 2a's `fake-claude-cli.js`. A new `test/support/agent-runner-contract.ts` defines the behavioral contract once and both `claude-code-runner.test.ts` and `codex-runner.test.ts` run it.

**Tech Stack:** TypeScript, `node:child_process`, vitest. No new dependency.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` §5 (Agent-Runner Abstraction, the `CodexRunner` half and the "contract tests run the same suite against both adapters" requirement).

## Verified Ground Truth (captured live 2026-09-04, codex-cli 0.149.1, raw captures in the supervisor's scratchpad `codex-grounding/`; re-verify before deviating)

- `codex exec --json -s read-only "<prompt>"` streams NDJSON to stdout. Observed event sequence on success:
  ```
  {"type":"thread.started","thread_id":"01a06cfe-46c0-7800-99fa-83b3a2cbfc6b"}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}
  {"type":"turn.completed","usage":{"input_tokens":12886,"cached_input_tokens":4480,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":11}}
  ```
  Exit code 0. `thread.started` was always the first line; `turn.started` is NOT always the second (a warning `item.completed` with `item.type: "error"` preceded it in the failure run) — key off `type`, never line position.
- Failure (`-m definitely-not-a-model`): exit code 1; events `thread.started`, `item.completed` (`item.type:"error"`, `item.message`), `turn.started`, `{"type":"error","message":"<JSON-encoded string>"}`, `{"type":"turn.failed","error":{"message":"<JSON-encoded string>"}}`. No `turn.completed` on failure. `error.message` is a JSON string that itself encodes an object — forward it as text, do not double-parse for the contract.
- Resume: `codex exec resume <thread_id> --json "<prompt>"` works and echoes the same `thread_id` in `thread.started`. `--json resume <id> …` also works; this plan uses the `resume <id> --json` form. `exec resume` accepts `-m`, `--json`, `-o`, `--skip-git-repo-check`, `--dangerously-bypass-approvals-and-sandbox` but NOT `-s/--sandbox`, `--add-dir`, or `-C`.
- `-s/--sandbox` values: `read-only | workspace-write | danger-full-access`. `exec` has no `--ask-for-approval`; approval posture is "never" by default; `--approve-for-me` and `--dangerously-bypass-approvals-and-sandbox` exist.
- `-C <dir>` and `--add-dir <dir>` combine on a first-turn `exec`; this plan never uses `-C` (spawn cwd instead) so first and resumed turns behave identically with respect to the working directory.
- stderr on a plain `exec` always contains `Reading additional input from stdin...` even with stdin closed; the process does NOT hang with stdin `ignore`d (run5: exit 0, ~5 s). Non-JSON mode prints only the final text to stdout and everything else to stderr.
- `-o/--output-last-message <file>` writes the raw final text (not JSON). Not used by this adapter.
- Token usage appears only in `turn.completed.usage` (no total, no cost).

## Global Constraints

- Node 24, pnpm 10.10.0, commands from `cgremlin/core/`; `pnpm test && pnpm typecheck && pnpm lint` green at every commit.
- Tests must not spawn the real `codex` binary, make network calls, or need credentials — a fixture script stands in for the binary (same approach as `test/fixtures/fake-claude-cli.js`).
- `AgentRunner`, `SessionContext`, `AgentHandle`, `AgentOutput`, `AgentExitResult` (Phase 1d + 3a additions `additionalDirs`, `resumeId`, optional `getResumeId`) are consumed unmodified.
- stdin is always `'ignore'` (Phase 2a lesson: an open stdin pipe hangs forever).
- Never pass `--dangerously-bypass-approvals-and-sandbox` by default; it is an explicit opt-in option.
- Branch `phase2b-codex-runner` off `mission-control-pr-orchestrator`; the supervisor merges.

## File Structure

- `test/fixtures/fake-codex-cli.js` — controllable stand-in for `codex` (executable; add to eslint `ignores` like the claude fixture)
- `src/agent/codex-runner.ts` — `CodexRunner`, `CodexRunnerOptions`
- `test/agent/codex-runner.test.ts` — adapter-specific tests (argv pinning, event parsing, resume form)
- `test/support/agent-runner-contract.ts` — `describeAgentRunnerContract(name, makeRunner, fixtureBehaviors)` shared suite
- `test/agent/claude-code-runner.test.ts` (modify — also runs the contract suite)

---

### Task 1: `CodexRunner` backed by a controllable CLI fixture

**Files:**
- Create: `test/fixtures/fake-codex-cli.js`, `src/agent/codex-runner.ts`
- Test: `test/agent/codex-runner.test.ts`
- Modify: `eslint.config.js` (add the fixture path to `ignores`, next to the claude fixture)

**Interfaces:**
```ts
export interface CodexRunnerOptions {
  readonly codexBinary?: string;                                  // default 'codex'
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; // default 'workspace-write'
  readonly model?: string;
  readonly skipGitRepoCheck?: boolean;                            // default false (worktrees are git repos)
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;        // default false; explicit opt-in
}
export class CodexRunner implements AgentRunner {
  constructor(options?: CodexRunnerOptions)
  start(ctx: SessionContext): Promise<AgentHandle>     // seeds threadId from ctx.resumeId
  sendPrompt(handle, prompt): Promise<void>            // resolves after process close; onExit fires before resolve
  onOutput / onExit / stop(handle)                     // stop = SIGTERM on the in-flight child
  getResumeId(handle): string | undefined              // thread_id captured from thread.started
  getCodexThreadId(handle): string | undefined         // alias, mirrors ClaudeCodeRunner.getClaudeSessionId
}
```
  Argv construction (pinned by exact-argv tests):
  - First turn (no thread id): `exec --json -s <sandbox> [-m <model>] [--skip-git-repo-check] [--dangerously-bypass-approvals-and-sandbox] [--add-dir <d>]… <prompt>`
  - Resumed turn (thread id known): `exec resume <threadId> --json [-m <model>] [--skip-git-repo-check] [--dangerously-bypass-approvals-and-sandbox] <prompt>` — NO `-s`, NO `--add-dir` (the CLI rejects them on resume; the first turn already established them for the thread).
  - `spawn(codexBinary, args, { cwd: ctx.workingDirectory, stdio: ['ignore','pipe','pipe'] })`.
  Event handling (by `type`):
  - `thread.started` → `threadId = thread_id`.
  - `item.completed` with `item.type === 'agent_message'` → `onOutput({ stream:'stdout', data: item.text })`; with `item.type === 'error'` → `onOutput({ stream:'stderr', data: item.message })`.
  - `error` → `onOutput({ stream:'stderr', data: message })`; `turn.failed` → `onOutput({ stream:'stderr', data: error.message })`.
  - `turn.started`, `turn.completed` and unknown types → ignored (usage is not part of the runner contract).
  - Non-JSON stdout lines → forwarded raw as stdout (same as the claude adapter).
  - stderr chunks → `onOutput({ stream:'stderr', data })` verbatim (this includes the benign "Reading additional input from stdin..." line — do not filter it; the engine ignores stderr content).
  - `close` → flush a partial trailing line, fire `onExit({ code, signal })` once, resolve.

- [ ] **Step 1: Write the fixture and the failing tests**

`test/fixtures/fake-codex-cli.js` (test infrastructure, mirrors the real shapes above verbatim):
```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_ARGV_LOG) fs.writeFileSync(process.env.FAKE_CLI_ARGV_LOG, JSON.stringify(args));

// The prompt is always the last positional argument (both `exec …` and `exec resume <id> …`).
const prompt = args[args.length - 1] ?? '';
const resumeIdx = args.indexOf('resume');
const threadId = resumeIdx >= 0 ? args[resumeIdx + 1] : '01a06cfe-46c0-7800-99fa-83b3a2cbfc6b';

process.stderr.write('Reading additional input from stdin...\n');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

emit({ type: 'thread.started', thread_id: threadId });
if (prompt === 'HANG_FOREVER') {
  setInterval(() => {}, 1000);
} else if (prompt === 'FAIL_LOUDLY') {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' } });
  emit({ type: 'turn.started' });
  const inner = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'simulated failure' } });
  emit({ type: 'error', message: inner });
  emit({ type: 'turn.failed', error: { message: inner } });
  process.exitCode = 1;
} else {
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `echo: ${prompt}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 12886, cached_input_tokens: 4480, cache_write_input_tokens: 0, output_tokens: 19, reasoning_output_tokens: 11 } });
}
```
`chmod +x` it and add it to `eslint.config.js` `ignores`.

`test/agent/codex-runner.test.ts` — copy the structure of `test/agent/claude-code-runner.test.ts` (fixture path resolution, `FAKE_CLI_ARGV_LOG` handling with `tmpdir()`, `Promise`-based collection of outputs/exits). Tests:
1. **first-turn argv pinned**: options `{ sandbox: 'read-only', model: 'gpt-5-codex' }`, ctx `{ additionalDirs: ['/s/one','/s/two'] }`, prompt `'hello'` → argv exactly `['exec','--json','-s','read-only','-m','gpt-5-codex','--add-dir','/s/one','--add-dir','/s/two','hello']`.
2. **defaults**: no options, no additionalDirs → `['exec','--json','-s','workspace-write','hello']`; `skipGitRepoCheck: true` and `dangerouslyBypassApprovalsAndSandbox: true` add `--skip-git-repo-check` and `--dangerously-bypass-approvals-and-sandbox` in that order after `-m` (if any) and before `--add-dir`.
3. **resume argv pinned**: after one successful turn (thread id captured), a second `sendPrompt('again')` with the same handle → `['exec','resume','01a06cfe-46c0-7800-99fa-83b3a2cbfc6b','--json','again']` even though `additionalDirs` and a non-default sandbox were set (proves they are omitted on resume). With `model` set → `['exec','resume',id,'--json','-m',model,'again']`.
4. **seeded resume**: `start({ …, resumeId: 'seed-thread' })` then `sendPrompt` → first argv is the `resume seed-thread` form; `getResumeId` returns `'seed-thread'` (fixture echoes it).
5. **output parsing**: stdout outputs equal `['echo: hello']`; stderr outputs include `'Reading additional input from stdin...\n'`; exit `{ code: 0, signal: null }`; `onExit` fired exactly once and before `sendPrompt` resolved (record order).
6. **failure parsing**: prompt `FAIL_LOUDLY` → exit `{ code: 1, signal: null }`; stderr outputs contain the warning item message and the `error`/`turn.failed` messages (as text containing `simulated failure`); no stdout agent text.
7. **stop kills**: prompt `HANG_FOREVER`, then `stop(handle)` → exit signal `'SIGTERM'` (or code `null`), `sendPrompt` resolves; a second `stop` is a no-op.
8. **unknown handle** → `UnknownAgentHandleError` for sendPrompt/onOutput/onExit/stop.
9. **stdin closed**: spawn options use `stdio[0] === 'ignore'` — assert indirectly: the `HANG_FOREVER` fixture only hangs because of its interval, and a variant prompt `'READ_STDIN'` (add to the fixture: `process.stdin.on('end', () => process.exit(0)); process.stdin.resume();` — exits 0 immediately when stdin is closed) completes with exit 0 within the test timeout. This is the Phase 2a hang regression test in adapter #2.

- [ ] **Step 2: RED** — `pnpm vitest run test/agent/codex-runner.test.ts`: module not found.
- [ ] **Step 3: Implement** `src/agent/codex-runner.ts`, modeled on `src/agent/claude-code-runner.ts` (same state map, same line-buffering, same `close`/`error` handling, `stop` kills the current child). Reuse `UnknownAgentHandleError` by importing it from `./claude-code-runner` or move it to `./agent-runner-errors.ts` and re-export from both (prefer the move; keep the claude export path working).
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): add CodexRunner, the second real AgentRunner adapter, with a fixture CLI mirroring real codex exec --json output"`

---

### Task 2: Shared `AgentRunner` contract suite run against both adapters

**Files:**
- Create: `test/support/agent-runner-contract.ts`
- Modify: `test/agent/claude-code-runner.test.ts`, `test/agent/codex-runner.test.ts`

**Interfaces:**
```ts
export interface ContractFixture {
  makeRunner(): AgentRunner;             // fresh adapter bound to the fixture binary
  echoPrompt: string;                    // a prompt the fixture echoes
  expectedEcho: (prompt: string) => string;  // e.g. p => `echo: ${p}`
  hangPrompt: string;                    // fixture never exits
  failPrompt: string;                    // fixture exits non-zero
}
export function describeAgentRunnerContract(name: string, fixture: ContractFixture): void
```
  The suite (each an `it` inside `describe(`AgentRunner contract: ${name}`)`):
  1. start returns distinct handle ids for two starts.
  2. sendPrompt forwards the echoed text via onOutput stdout and resolves.
  3. onExit fires exactly once per sendPrompt, with `code 0` on success, and BEFORE sendPrompt resolves.
  4. failPrompt → onExit code non-zero (or signal), sendPrompt still resolves (never rejects on non-zero exit).
  5. hangPrompt + stop → sendPrompt resolves; exit carries a signal or null code; isRunning-equivalent: a second sendPrompt on the same handle works afterwards.
  6. Multiple onOutput/onExit listeners all fire.
  7. getResumeId is defined after a successful turn, and `start({ resumeId })` seeds it (getResumeId returns the seed before any prompt).
  8. stdin is not left open: a `READ_STDIN`-style prompt (both fixtures implement it) exits 0.
  9. Unknown handle → throws (any Error whose name ends with `UnknownAgentHandleError`).

- [ ] **Step 1: Write the failing contract file and wire both test files** to call `describeAgentRunnerContract('ClaudeCodeRunner', …)` / `('CodexRunner', …)`. Add the `READ_STDIN` behavior to `fake-claude-cli.js` too (same three lines).
- [ ] **Step 2: RED** — at least the resume-seed and READ_STDIN cases should fail or be missing on one side until wired; if everything passes immediately, mutate one adapter (e.g. drop the `onExit` call) to prove the suite catches it, then restore, and record that in the report.
- [ ] **Step 3: Implement** anything the contract exposes as inconsistent between adapters (fix the adapter, never weaken the contract).
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "test(cgremlin-core): shared AgentRunner contract suite run against ClaudeCodeRunner and CodexRunner fixtures"`

---

## Definition of Done

- `pnpm test && pnpm typecheck && pnpm lint` green from `cgremlin/core/`.
- `CodexRunner` exists with the options and argv forms pinned above; resume form omits `-s`/`--add-dir`; stdin is `'ignore'`; `onExit` fires once before `sendPrompt` resolves.
- Both adapters pass the shared contract suite; the executor reports one mutation per adapter that the contract suite catches.
- No test spawns the real `codex` or `claude` binary.
- Live smoke (supervisor-run, manual, before merge): `CodexRunner` against the real `codex` with sandbox `read-only`, prompt "reply with exactly the word PONG", in a scratch git dir — asserts stdout output `PONG`, exit 0, `getResumeId()` a UUID; then a second `sendPrompt` on the same handle resumes and echoes the same thread id.
- Not in this plan: wiring `CodexRunner` into `PipelineService`/API as a selectable runner (Phase 4/6 config decision); Codex-specific prompt tuning; token-usage reporting.
