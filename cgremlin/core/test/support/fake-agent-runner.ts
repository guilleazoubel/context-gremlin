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
  resumeId?: string;
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
  private lastHandleId: string | null = null;

  async start(ctx: SessionContext): Promise<AgentHandle> {
    const id = `fake-agent-${this.nextId++}`;
    this.handles.set(id, {
      ctx,
      outputCallbacks: [],
      exitCallbacks: [],
      prompts: [],
      stopped: false,
      resumeId: ctx.resumeId,
    });
    this.lastHandleId = id;
    return { id };
  }

  lastHandle(): AgentHandle {
    if (this.lastHandleId === null) {
      throw new Error('FakeAgentRunner: no handle has been started yet');
    }
    return { id: this.lastHandleId };
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

  getResumeId(handle: AgentHandle): string | undefined {
    return this.requireState(handle).resumeId;
  }

  setResumeId(handle: AgentHandle, id: string): void {
    this.requireState(handle).resumeId = id;
  }

  private requireState(handle: AgentHandle): FakeAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
