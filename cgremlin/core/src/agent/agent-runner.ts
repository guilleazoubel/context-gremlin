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
