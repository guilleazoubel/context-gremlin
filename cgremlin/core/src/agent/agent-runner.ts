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

/** Raw per-vendor token counts for one run (R118f). Claude's `input` excludes cache; Codex's includes it. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** D2 — one model's share of a run, as Claude's `result.modelUsage` reports it (`costUSD` → `costUsd`). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUsd: number | null;
}

/** A quota or rate-limit signal seen during a run (R118f). */
export interface LimitEvent {
  /** When the runner saw it (ISO). */
  readonly at: string;
  readonly kind: 'warning' | 'rejected';
  /** e.g. `five_hour`, `seven_day` (Claude); null when the CLI does not say. */
  readonly limitType: string | null;
  /** When the limit resets (ISO), when the CLI says. */
  readonly resetsAt: string | null;
  /** The CLI's own sentence for a text-detected limit (first line, capped, redacted). */
  readonly message: string | null;
}

export interface RunStats {
  readonly tokens: TokenUsage | null;
  /** 'result' = the CLI's final usage; 'assistant' = the per-message sum of a run that never reached its result (S2-26). */
  readonly tokensSource: 'result' | 'assistant' | null;
  /** D2 — Claude's `total_cost_usd` (an estimate on a subscription); null when not reported. */
  readonly costUsd: number | null;
  /** D2 — Claude's `modelUsage`, normalized; null when not reported or empty. */
  readonly modelUsage: Readonly<Record<string, ModelUsage>> | null;
  readonly limitEvents: readonly LimitEvent[];
  /** The model the CLI reported it ran (Claude's `system/init`); null when it did not say. */
  readonly observedModel: string | null;
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
  /**
   * R118f — what this handle's run used and hit, so far. Undefined: the adapter has nothing to report.
   * Stats are per handle and assume one prompt per handle (as the stage runner does): a second
   * prompt on the same handle sums result tokens while cost/model usage keep the latest result,
   * and the per-message fallback applies only while no result has arrived on the handle (M-1/M-2).
   */
  getRunStats?(handle: AgentHandle): RunStats | undefined;
}
