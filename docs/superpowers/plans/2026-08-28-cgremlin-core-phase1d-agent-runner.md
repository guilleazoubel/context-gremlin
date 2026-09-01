# cgremlin/core Phase 1d: AgentRunner Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the `AgentRunner` interface — the abstraction the pipeline orchestration (Phase 3) will use to drive Claude Code / Codex CLI sessions — and ship a fully controllable fake implementation. This is deliberately the smallest of the four Phase 1 sub-plans: per the rebuild spec's roadmap, Phase 1 ships the interface with a fake/stub only; the real `ClaudeCodeRunner`/`CodexRunner` adapters (shelling out to the actual CLIs) are Phase 2's job, built against this same interface.

**Architecture:** One interface (`AgentRunner`) with four supporting types (`SessionContext`, `AgentHandle`, `AgentOutput`, `AgentExitResult`), matching the design spec's section 5 exactly. One implementation for this phase: `FakeAgentRunner`, an in-memory, fully-controllable test double — it records every prompt sent, and exposes `emitOutput`/`emitExit` methods so a caller (a future orchestration test, or this phase's own tests) can simulate an agent producing output and exiting without spawning any real process. This mirrors the `SessionFileSystem`/`InMemoryFileSystem` and `GitRunner`/`FakeGitRunner` pattern already established in Phases 1a/1b, except there is no real adapter yet in this phase — only the interface and the fake.

**Tech Stack:** TypeScript, vitest. No new dependencies, no I/O of any kind (the fake is pure in-memory state).

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (section 5 "Agent-Runner Abstraction")

## Global Constraints

- This phase does not implement `ClaudeCodeRunner` or `CodexRunner` — those are explicitly out of scope, deferred to Phase 2 per the spec's roadmap.
- `FakeAgentRunner` performs no real I/O, spawns no subprocess, and touches no filesystem — it is pure in-memory state, fully synchronous except where the `AgentRunner` interface itself requires `Promise`-returning methods.
- `FakeAgentRunner` lives under `test/support/` (a test double, not shipped in `dist/`), matching the placement of `InMemoryFileSystem` and `FakeGitRunner`. The `AgentRunner` interface and its supporting types live under `src/agent/`.
- Package manager pnpm (v10.10.0), Node 24. Run all commands from `cgremlin/core/`.
- TDD: the task writes the failing test before the implementation.

---

### Task 1: `AgentRunner` interface and `FakeAgentRunner`

**Files:**
- Create: `cgremlin/core/src/agent/agent-runner.ts`
- Create: `cgremlin/core/test/support/fake-agent-runner.ts`
- Test: `cgremlin/core/test/agent/fake-agent-runner.test.ts`

**Interfaces:**
- Produces (from `src/agent/agent-runner.ts`):
  - `interface AgentHandle { readonly id: string }`
  - `interface SessionContext { readonly sessionId: string; readonly workingDirectory: string }`
  - `interface AgentOutput { readonly stream: 'stdout' | 'stderr'; readonly data: string }`
  - `interface AgentExitResult { readonly code: number | null; readonly signal: string | null }`
  - `interface AgentRunner { start(ctx: SessionContext): Promise<AgentHandle>; sendPrompt(handle: AgentHandle, prompt: string): Promise<void>; onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void; onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void; stop(handle: AgentHandle): Promise<void> }`
- Produces (from `test/support/fake-agent-runner.ts`):
  - `class UnknownAgentHandleError extends Error`
  - `class FakeAgentRunner implements AgentRunner` — plus test-control methods not on the interface: `emitOutput(handle, chunk)`, `emitExit(handle, result)`, `getPrompts(handle): readonly string[]`, `isStopped(handle): boolean`, `getContext(handle): SessionContext`.
  This is the complete Phase 1d deliverable — Phase 2's real adapters, and any future orchestration-layer tests, will implement/consume `AgentRunner` and use `FakeAgentRunner` respectively.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/agent/fake-agent-runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeAgentRunner, UnknownAgentHandleError } from '../support/fake-agent-runner';
import type { SessionContext } from '../../src/agent/agent-runner';

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'inv-test-1',
    workingDirectory: '/work/inv-test-1',
    ...overrides,
  };
}

describe('FakeAgentRunner', () => {
  it('start() returns a handle with a unique id per call', async () => {
    const runner = new FakeAgentRunner();
    const a = await runner.start(makeContext());
    const b = await runner.start(makeContext());
    expect(a.id).not.toBe(b.id);
  });

  it('sendPrompt() records the prompt for later inspection', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    await runner.sendPrompt(handle, 'investigate the bug');
    expect(runner.getPrompts(handle)).toEqual(['investigate the bug']);
  });

  it('records multiple prompts in order', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    await runner.sendPrompt(handle, 'first');
    await runner.sendPrompt(handle, 'second');
    expect(runner.getPrompts(handle)).toEqual(['first', 'second']);
  });

  it('onOutput() callback fires with the emitted chunk', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const received: unknown[] = [];
    runner.onOutput(handle, (chunk) => received.push(chunk));
    runner.emitOutput(handle, { stream: 'stdout', data: 'hello' });
    expect(received).toEqual([{ stream: 'stdout', data: 'hello' }]);
  });

  it('supports multiple onOutput listeners, all of which fire', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const a: unknown[] = [];
    const b: unknown[] = [];
    runner.onOutput(handle, (chunk) => a.push(chunk));
    runner.onOutput(handle, (chunk) => b.push(chunk));
    runner.emitOutput(handle, { stream: 'stderr', data: 'oops' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('onExit() callback fires with the emitted result', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const received: unknown[] = [];
    runner.onExit(handle, (result) => received.push(result));
    runner.emitExit(handle, { code: 0, signal: null });
    expect(received).toEqual([{ code: 0, signal: null }]);
  });

  it('stop() marks the handle as stopped', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    expect(runner.isStopped(handle)).toBe(false);
    await runner.stop(handle);
    expect(runner.isStopped(handle)).toBe(true);
  });

  it('two started handles have independent state', async () => {
    const runner = new FakeAgentRunner();
    const a = await runner.start(makeContext({ sessionId: 'inv-a' }));
    const b = await runner.start(makeContext({ sessionId: 'inv-b' }));
    await runner.sendPrompt(a, 'only for a');
    expect(runner.getPrompts(a)).toEqual(['only for a']);
    expect(runner.getPrompts(b)).toEqual([]);
    expect(runner.getContext(a).sessionId).toBe('inv-a');
    expect(runner.getContext(b).sessionId).toBe('inv-b');
  });

  it('throws UnknownAgentHandleError for a handle from another runner instance', async () => {
    const runnerA = new FakeAgentRunner();
    const runnerB = new FakeAgentRunner();
    const handle = await runnerA.start(makeContext());
    await expect(runnerB.sendPrompt(handle, 'x')).rejects.toThrow(UnknownAgentHandleError);
  });

  it('throws UnknownAgentHandleError for a fabricated or unknown handle', async () => {
    const runner = new FakeAgentRunner();
    await expect(runner.sendPrompt({ id: 'does-not-exist' }, 'x')).rejects.toThrow(
      UnknownAgentHandleError,
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- agent/fake-agent-runner`
Expected: FAIL — cannot find module `../../src/agent/agent-runner` (and `../support/fake-agent-runner`).

- [ ] **Step 3: Implement**

`cgremlin/core/src/agent/agent-runner.ts`:
```ts
export interface AgentHandle {
  readonly id: string;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly workingDirectory: string;
}

export interface AgentOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly data: string;
}

export interface AgentExitResult {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface AgentRunner {
  start(ctx: SessionContext): Promise<AgentHandle>;
  sendPrompt(handle: AgentHandle, prompt: string): Promise<void>;
  onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void;
  onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void;
  stop(handle: AgentHandle): Promise<void>;
}
```

`cgremlin/core/test/support/fake-agent-runner.ts`:
```ts
import type {
  AgentExitResult,
  AgentHandle,
  AgentOutput,
  AgentRunner,
  SessionContext,
} from '../../src/agent/agent-runner';

interface FakeAgentState {
  ctx: SessionContext;
  outputCallbacks: Array<(chunk: AgentOutput) => void>;
  exitCallbacks: Array<(result: AgentExitResult) => void>;
  prompts: string[];
  stopped: boolean;
}

export class UnknownAgentHandleError extends Error {
  constructor(id: string) {
    super(`Unknown agent handle: '${id}'`);
    this.name = 'UnknownAgentHandleError';
  }
}

export class FakeAgentRunner implements AgentRunner {
  private nextId = 1;
  private readonly handles = new Map<string, FakeAgentState>();

  async start(ctx: SessionContext): Promise<AgentHandle> {
    const id = `fake-agent-${this.nextId++}`;
    this.handles.set(id, {
      ctx,
      outputCallbacks: [],
      exitCallbacks: [],
      prompts: [],
      stopped: false,
    });
    return { id };
  }

  async sendPrompt(handle: AgentHandle, prompt: string): Promise<void> {
    this.requireState(handle).prompts.push(prompt);
  }

  onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void {
    this.requireState(handle).outputCallbacks.push(callback);
  }

  onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void {
    this.requireState(handle).exitCallbacks.push(callback);
  }

  async stop(handle: AgentHandle): Promise<void> {
    this.requireState(handle).stopped = true;
  }

  emitOutput(handle: AgentHandle, chunk: AgentOutput): void {
    for (const callback of this.requireState(handle).outputCallbacks) {
      callback(chunk);
    }
  }

  emitExit(handle: AgentHandle, result: AgentExitResult): void {
    for (const callback of this.requireState(handle).exitCallbacks) {
      callback(result);
    }
  }

  getPrompts(handle: AgentHandle): readonly string[] {
    return this.requireState(handle).prompts;
  }

  isStopped(handle: AgentHandle): boolean {
    return this.requireState(handle).stopped;
  }

  getContext(handle: AgentHandle): SessionContext {
    return this.requireState(handle).ctx;
  }

  private requireState(handle: AgentHandle): FakeAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- agent/fake-agent-runner`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/agent/agent-runner.ts cgremlin/core/test/support/fake-agent-runner.ts \
  cgremlin/core/test/agent/fake-agent-runner.test.ts
git commit -m "feat(cgremlin-core): add AgentRunner interface and FakeAgentRunner"
```

---

## Definition of Done for Phase 1d

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally.
- `AgentRunner` and its 4 supporting types, plus `FakeAgentRunner` and `UnknownAgentHandleError`, all exist, are fully tested, and export exactly the interfaces listed above.
- No real subprocess is spawned anywhere in this phase — `grep -rn "child_process" cgremlin/core/src/agent cgremlin/core/test/support/fake-agent-runner.ts cgremlin/core/test/agent` returns nothing.
- This closes out the "Engine core" roadmap item (Phase 1a Session Store + Phase 1b Workspace Isolation + Phase 1c API Server + Phase 1d AgentRunner interface) — Phase 2 (real Claude Code / Codex CLI adapters) is the next roadmap item.
