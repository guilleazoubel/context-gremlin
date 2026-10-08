import type { LimitEvent, ModelUsage, TokenUsage } from './agent-runner';
import { redactSecrets } from '../config/core-config';

const MESSAGE_CAP = 200;
const LIMIT_TEXT = /usage limit|rate limit|hit your limit|too many requests|\b429\b/i;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Claude `usage` (on `result` and on each `assistant` message). Null when it carries neither an input nor an output count. */
export function tokensFromClaudeUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cache_read_input_tokens) ?? 0,
    cacheWrite: num(u.cache_creation_input_tokens) ?? 0,
  };
}

/** Codex `turn.completed.usage`; its `input_tokens` already includes `cached_input_tokens`. */
export function tokensFromCodexUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: num(u.cached_input_tokens) ?? 0,
    cacheWrite: num(u.cache_write_input_tokens) ?? 0,
  };
}

export function addTokens(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** D2 — Claude `result.modelUsage` (CLI 2.1.294 shape), normalized. `{}` (an error result) is null. */
export function modelUsageFromClaude(raw: unknown): Record<string, ModelUsage> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, ModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out[model] = {
      inputTokens: num(v.inputTokens) ?? 0,
      outputTokens: num(v.outputTokens) ?? 0,
      cacheReadInputTokens: num(v.cacheReadInputTokens) ?? 0,
      cacheCreationInputTokens: num(v.cacheCreationInputTokens) ?? 0,
      webSearchRequests: num(v.webSearchRequests) ?? 0,
      costUsd: num(v.costUSD),
    };
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** D2 — Claude `result.total_cost_usd`. */
export function costFromClaude(value: unknown): number | null {
  return num(value);
}

/** Claude `rate_limit_event.rate_limit_info`: `allowed` is no event; `allowed_warning` and `rejected` are. */
export function limitEventFromClaude(info: unknown, at: Date): LimitEvent | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Record<string, unknown>;
  const kind = i.status === 'allowed_warning' ? 'warning' : i.status === 'rejected' ? 'rejected' : null;
  if (kind === null) return null;
  const resetsAt = num(i.resetsAt);
  return {
    at: at.toISOString(),
    kind,
    limitType: typeof i.rateLimitType === 'string' ? i.rateLimitType : null,
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
    message: null,
  };
}

/** A failure sentence that says a quota or rate limit stopped the run (Codex has no structured event). */
export function limitEventFromMessage(message: string, at: Date): LimitEvent | null {
  if (!LIMIT_TEXT.test(message)) return null;
  const line = redactSecrets(message.split('\n')[0].trim());
  return {
    at: at.toISOString(),
    kind: 'rejected',
    limitType: null,
    resetsAt: null,
    message: line.length > MESSAGE_CAP ? `${line.slice(0, MESSAGE_CAP)}…` : line,
  };
}
