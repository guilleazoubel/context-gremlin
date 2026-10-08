import type { Effort } from '../config/routing';

export interface AgentHandle {
  readonly id: string;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly workingDirectory: string;
  /** Extra directories the agent may read/write (e.g. the session dir holding BRIEF.md). */
  readonly additionalDirs?: readonly string[];
  /** Adapter-specific conversation id to continue from (Claude: `--resume`). */
  readonly resumeId?: string;
  /** R116 — the model for THIS run (`--model` / `-m`); overrides the runner's constructor default. */
  readonly model?: string;
  /** R116 — the effort for THIS run (Claude `--effort`, Codex `-c model_reasoning_effort`). Absent: the CLI's own default. */
  readonly effort?: Effort;
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
  /** The id a later `start({ resumeId })` should pass to continue this conversation, if the adapter has one. */
  getResumeId?(handle: AgentHandle): string | undefined;
  /**
   * The OS pid currently backing this handle, if any. `undefined` means
   * either the adapter has no such concept, or — just as validly — the
   * child process simply hasn't been spawned yet (between `start()` and the
   * first `sendPrompt()`, or after it has already exited and been cleared).
   * Callers MUST NOT read `undefined` as "dead": it proves nothing either way.
   */
  getPid?(handle: AgentHandle): number | undefined;
}
