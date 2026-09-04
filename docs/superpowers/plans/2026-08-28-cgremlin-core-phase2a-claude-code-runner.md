# cgremlin/core Phase 2a: ClaudeCodeRunner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `ClaudeCodeRunner` — the first real `AgentRunner` adapter, shelling out to the actual `claude` CLI. This is Phase 2's `ClaudeCodeRunner` half only; `CodexRunner` is explicitly deferred to a follow-up phase (Phase 2b) because `codex` CLI authentication is currently broken on the development machine ("refresh token already used") and its real JSONL output shape could not be empirically verified — shipping an unverified guess at that schema risks the same class of silent defect the Phase 1b/1c final reviews caught (a test suite that "proves" behavior it never actually exercised against reality).

**Architecture:** `ClaudeCodeRunner implements AgentRunner` (Phase 1d's interface, unmodified) by spawning the real `claude` CLI per `sendPrompt()` call: `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode <mode> [--resume <sessionId>]`, parsing its NDJSON stdout line-by-line, forwarding `assistant` message text as `onOutput` chunks, capturing the final `result` event's `session_id` for the next call's `--resume`, and firing `onExit` with the real OS-level exit code/signal. `stop()` kills the in-flight child process (`SIGTERM`). Tested against a small, controllable fixture script standing in for the real `claude` binary — real `child_process.spawn`, real stdout/stderr streams, real exit codes, but no live network call, no API cost, no credential dependency (the same "test the real plumbing, not the real network" split used for `NodeGitRunner`, except here even the "real" binary itself is substituted, since — unlike `git` — invoking the real `claude` CLI costs real money and requires live auth on every test run).

**Tech Stack:** TypeScript, `node:child_process` (spawn), vitest. No new dependency.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (section 5 "Agent-Runner Abstraction" — the `ClaudeCodeRunner` half)

## Verified Ground Truth (empirically confirmed on this machine before writing this plan — do not deviate from these without re-verifying)

- `claude -p "<prompt>" --output-format json --permission-mode bypassPermissions` returns a single JSON object on stdout at process exit, including `session_id` (a UUID string) and `result` (the final text).
- `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions [--resume <id>]` streams newline-delimited JSON (NDJSON) objects to stdout as the run progresses. Confirmed event shapes relevant to this adapter:
  - `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}], ...}, ...}` — assistant response text, may appear multiple times.
  - `{"type":"result","session_id":"<uuid>","is_error":false,"result":"...", ...}` — exactly one, at the end of a successful run; carries the session id to pass to `--resume` on the next call.
  - Other event types (`system`/`hook_started`/`hook_response`/`init`, `rate_limit_event`) also appear but are not needed for this adapter's contract and are ignored.
- `--resume <session-id>` on a subsequent invocation correctly continues the same conversation and returns the *same* `session_id` in its `result` event (confirmed: two invocations, second with `--resume <id-from-first>`, both returned the identical `session_id`).
- `claude`'s own process exit code/signal (not any field inside the JSON) is the authoritative source for `AgentExitResult` — the interface only asks for the OS-level exit code/signal, not a semantic "did the agent's task succeed" judgment (that belongs to a later phase reading `REVIEW.md`/`FINDINGS.md`, not this adapter).

## Global Constraints

- `CodexRunner` is explicitly out of scope for this plan — do not implement it here.
- `ClaudeCodeRunner` must not make any real network call, spawn the real `claude` binary, or require live credentials during automated tests — tests substitute a controllable fixture script for the binary.
- Reuses Phase 1d's `AgentRunner`/`SessionContext`/`AgentHandle`/`AgentOutput`/`AgentExitResult` exactly, unmodified.
- Package manager pnpm (v10.10.0), Node 24. Run all commands from `cgremlin/core/`.
- TDD: the task writes the failing test before the implementation.

---

### Task 1: `ClaudeCodeRunner`, backed by a controllable CLI fixture

**Files:**
- Create: `cgremlin/core/test/fixtures/fake-claude-cli.js` (executable; stands in for the real `claude` binary in tests)
- Create: `cgremlin/core/src/agent/claude-code-runner.ts`
- Test: `cgremlin/core/test/agent/claude-code-runner.test.ts`
- Modify: `cgremlin/core/eslint.config.js` (add the fixture to `ignores` — it's a plain Node script, not part of the TS pipeline, and would otherwise fail `no-undef` on bare `process`/`console` globals, the same class of issue `eslint.config.js` itself hit in Phase 0)

**Interfaces:**
- Consumes: `AgentRunner`, `SessionContext`, `AgentHandle`, `AgentOutput`, `AgentExitResult` from `../agent-runner` (Phase 1d, unmodified).
- Produces:
  - `class UnknownAgentHandleError extends Error` (local to this module — a distinct class from `test/support/fake-agent-runner.ts`'s error of the same name; both satisfy the same "throw on an unrecognized handle" contract for their respective implementations without needing a cross-module shared type).
  - `interface ClaudeCodeRunnerOptions { readonly claudeBinary?: string; readonly permissionMode?: string; readonly model?: string }`
  - `class ClaudeCodeRunner implements AgentRunner` — plus one introspection method beyond the interface: `getClaudeSessionId(handle: AgentHandle): string | undefined` (useful now for testing, and later for persisting the resumable session id onto a session record).

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/fixtures/fake-claude-cli.js` (this file is test infrastructure, not itself under TDD — write it first since the test in Step 1 depends on it existing and behaving correctly):
```js
#!/usr/bin/env node
// A controllable stand-in for the real `claude` binary, used to test
// ClaudeCodeRunner's real subprocess spawning/parsing logic without
// making real, paid, network-dependent Claude API calls. Mirrors the
// exact NDJSON shapes verified against the real CLI (see the plan's
// "Verified Ground Truth" section).
'use strict';

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const prompt = args[args.indexOf('-p') + 1] ?? '';
const resumeId = argValue('--resume');
const sessionId = resumeId ? `resumed:${resumeId}` : 'fresh-session-1';

if (prompt === 'HANG_FOREVER') {
  // Never exits on its own; only terminated by a signal from the caller
  // under test, used to verify stop() actually kills the process.
  setInterval(() => {}, 1000);
} else if (prompt === 'FAIL_LOUDLY') {
  process.stderr.write('simulated failure on stderr\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `echo: ${prompt}` }] },
    }) + '\n',
  );
  process.stdout.write(
    JSON.stringify({ type: 'result', session_id: sessionId, is_error: false }) + '\n',
  );
}
```

`cgremlin/core/test/agent/claude-code-runner.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner, UnknownAgentHandleError } from '../../src/agent/claude-code-runner';

const FIXTURE = path.join(__dirname, '../fixtures/fake-claude-cli.js');

describe('ClaudeCodeRunner', () => {
  it('spawns the CLI and delivers assistant text via onOutput', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const chunks: string[] = [];
    runner.onOutput(handle, (chunk) => {
      if (chunk.stream === 'stdout') chunks.push(chunk.data);
    });
    await runner.sendPrompt(handle, 'hello');
    expect(chunks).toContain('echo: hello');
  });

  it('fires onExit with the real process exit code on success', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    runner.onExit(handle, (result) => exits.push(result));
    await runner.sendPrompt(handle, 'hello');
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it('reports a nonzero exit code and forwards stderr on failure', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const stderrChunks: string[] = [];
    const exits: Array<{ code: number | null }> = [];
    runner.onOutput(handle, (chunk) => {
      if (chunk.stream === 'stderr') stderrChunks.push(chunk.data);
    });
    runner.onExit(handle, (result) => exits.push(result));
    await runner.sendPrompt(handle, 'FAIL_LOUDLY');
    expect(exits[0].code).toBe(1);
    expect(stderrChunks.join('')).toContain('simulated failure');
  });

  it('resumes the previous session id on a second sendPrompt call', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'first');
    expect(runner.getClaudeSessionId(handle)).toBe('fresh-session-1');
    await runner.sendPrompt(handle, 'second');
    expect(runner.getClaudeSessionId(handle)).toBe('resumed:fresh-session-1');
  });

  it('stop() kills an in-flight process', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    runner.onExit(handle, (result) => exits.push(result));
    const sendPromise = runner.sendPrompt(handle, 'HANG_FOREVER');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stop(handle);
    await sendPromise;
    expect(exits[0].signal).toBe('SIGTERM');
  });

  it('throws UnknownAgentHandleError for a fabricated handle', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    await expect(runner.sendPrompt({ id: 'nope' }, 'x')).rejects.toThrow(UnknownAgentHandleError);
  });
});
```

- [ ] **Step 2: Make the fixture executable, then run the test and confirm it fails**

Run:
```bash
chmod +x cgremlin/core/test/fixtures/fake-claude-cli.js
cd cgremlin/core && pnpm test -- agent/claude-code-runner
```
Expected: FAIL — cannot find module `../../src/agent/claude-code-runner`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/agent/claude-code-runner.ts`:
```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentExitResult,
  AgentHandle,
  AgentOutput,
  AgentRunner,
  SessionContext,
} from './agent-runner';

interface ClaudeAgentState {
  ctx: SessionContext;
  outputCallbacks: Array<(chunk: AgentOutput) => void>;
  exitCallbacks: Array<(result: AgentExitResult) => void>;
  claudeSessionId?: string;
  currentProcess?: ChildProcessWithoutNullStreams;
}

export class UnknownAgentHandleError extends Error {
  constructor(id: string) {
    super(`Unknown agent handle: '${id}'`);
    this.name = 'UnknownAgentHandleError';
  }
}

export interface ClaudeCodeRunnerOptions {
  readonly claudeBinary?: string;
  readonly permissionMode?: string;
  readonly model?: string;
}

export class ClaudeCodeRunner implements AgentRunner {
  private nextId = 1;
  private readonly handles = new Map<string, ClaudeAgentState>();
  private readonly claudeBinary: string;
  private readonly permissionMode: string;
  private readonly model: string | undefined;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.claudeBinary = options.claudeBinary ?? 'claude';
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.model = options.model;
  }

  async start(ctx: SessionContext): Promise<AgentHandle> {
    const id = `claude-agent-${this.nextId++}`;
    this.handles.set(id, { ctx, outputCallbacks: [], exitCallbacks: [] });
    return { id };
  }

  async sendPrompt(handle: AgentHandle, prompt: string): Promise<void> {
    const state = this.requireState(handle);
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.permissionMode,
    ];
    if (this.model) {
      args.push('--model', this.model);
    }
    if (state.claudeSessionId) {
      args.push('--resume', state.claudeSessionId);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, args, { cwd: state.ctx.workingDirectory });
      state.currentProcess = child;

      let buffer = '';
      child.stdout.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) {
            this.handleLine(state, line);
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        for (const callback of state.outputCallbacks) {
          callback({ stream: 'stderr', data: data.toString('utf8') });
        }
      });

      child.on('error', reject);

      child.on('exit', (code, signal) => {
        state.currentProcess = undefined;
        for (const callback of state.exitCallbacks) {
          callback({ code, signal });
        }
        resolve();
      });
    });
  }

  private handleLine(state: ClaudeAgentState, line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON output on stdout is unexpected with --output-format
      // stream-json; forward it raw rather than silently dropping it.
      for (const callback of state.outputCallbacks) {
        callback({ stream: 'stdout', data: line });
      }
      return;
    }
    if (!event || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;

    if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
      const message = record.message as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') {
            for (const callback of state.outputCallbacks) {
              callback({ stream: 'stdout', data: text });
            }
          }
        }
      }
    }

    if (record.type === 'result' && typeof record.session_id === 'string') {
      state.claudeSessionId = record.session_id;
    }
  }

  onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void {
    this.requireState(handle).outputCallbacks.push(callback);
  }

  onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void {
    this.requireState(handle).exitCallbacks.push(callback);
  }

  async stop(handle: AgentHandle): Promise<void> {
    this.requireState(handle).currentProcess?.kill();
  }

  getClaudeSessionId(handle: AgentHandle): string | undefined {
    return this.requireState(handle).claudeSessionId;
  }

  private requireState(handle: AgentHandle): ClaudeAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
```

Add `'test/fixtures/fake-claude-cli.js'` to the `ignores` array in `cgremlin/core/eslint.config.js` (alongside the existing `'dist/**'`, `'node_modules/**'`, `'eslint.config.js'` entries) — it's a plain Node script using bare `process`/global references outside the TS/lint pipeline, the same reasoning that put `eslint.config.js` itself in that list during Phase 0.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- agent/claude-code-runner`
Expected: PASS — all 6 tests green, using real `child_process.spawn` against the fixture script (no real `claude` invocation, no network, no cost).

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. If `pnpm typecheck` errors on the plain-JS fixture file being swept up by `tsconfig.typecheck.json`'s `"test"` include glob, add `"test/fixtures/**"` to that config's `exclude` array as a follow-up fix within this same step — this is expected friction from adding the first non-TypeScript file under `test/`, not a design error to escalate.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/test/fixtures/fake-claude-cli.js cgremlin/core/src/agent/claude-code-runner.ts \
  cgremlin/core/test/agent/claude-code-runner.test.ts cgremlin/core/eslint.config.js
# If Step 5 required a tsconfig.typecheck.json fix, include it too:
git add cgremlin/core/tsconfig.typecheck.json 2>/dev/null || true
git commit -m "feat(cgremlin-core): add ClaudeCodeRunner, the first real AgentRunner adapter"
```

---

## Definition of Done for Phase 2a

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally.
- `ClaudeCodeRunner` exists, is fully tested against a real (fixture-substituted) subprocess — not an in-memory fake bypassing `child_process` — and exports exactly the interface listed above.
- No test in this plan makes a real network call, spawns the real `claude` binary, or depends on live credentials.
- `CodexRunner` remains unimplemented — tracked as Phase 2b, blocked on fixing `codex` CLI authentication on the development machine.
