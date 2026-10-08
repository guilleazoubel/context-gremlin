import { describe, expect, it } from 'vitest';
import {
  addTokens,
  costFromClaude,
  limitEventFromClaude,
  limitEventFromMessage,
  modelUsageFromClaude,
  tokensFromClaudeUsage,
  tokensFromCodexUsage,
} from '../../src/agent/run-stats';

const AT = new Date('2026-10-08T12:00:00.000Z');

describe('run stats parsers', () => {
  it('reads Claude usage, cache counters included', () => {
    expect(tokensFromClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 })).toEqual({
      input: 10, output: 5, cacheRead: 100, cacheWrite: 7,
    });
    expect(tokensFromClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null })).toEqual({
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
    });
    expect(tokensFromClaudeUsage(undefined)).toBeNull();
    expect(tokensFromClaudeUsage({ server_tool_use: {} })).toBeNull();
  });

  it('reads Codex turn.completed.usage', () => {
    expect(tokensFromCodexUsage({ input_tokens: 12886, cached_input_tokens: 4480, cache_write_input_tokens: 0, output_tokens: 19, reasoning_output_tokens: 11 })).toEqual({
      input: 12886, output: 19, cacheRead: 4480, cacheWrite: 0,
    });
    expect(tokensFromCodexUsage('nope')).toBeNull();
  });

  it('adds token counts', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    expect(addTokens(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
    expect(addTokens(null, a)).toEqual(a);
    expect(addTokens(a, null)).toEqual(a);
    expect(addTokens(null, null)).toBeNull();
  });

  it('D2 — reads Claude modelUsage per model and total_cost_usd; an empty modelUsage is null', () => {
    expect(
      modelUsageFromClaude({
        'claude-opus-5-5': {
          inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800,
          webSearchRequests: 0, costUSD: 0.42, contextWindow: 200000, maxOutputTokens: 64000,
        },
        'claude-haiku-5': { inputTokens: 10, outputTokens: 2 },
      }),
    ).toEqual({
      'claude-opus-5-5': { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 5000, cacheCreationInputTokens: 800, webSearchRequests: 0, costUsd: 0.42 },
      'claude-haiku-5': { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUsd: null },
    });
    expect(modelUsageFromClaude({})).toBeNull();
    expect(modelUsageFromClaude(undefined)).toBeNull();
    expect(costFromClaude(0.42)).toBe(0.42);
    expect(costFromClaude('0.42')).toBeNull();
  });

  it('Claude rate_limit_event: allowed is no event; allowed_warning is a warning; rejected is rejected', () => {
    expect(limitEventFromClaude({ status: 'allowed', rateLimitType: 'five_hour' }, AT)).toBeNull();
    expect(limitEventFromClaude({ status: 'allowed_warning', resetsAt: 1791460800, rateLimitType: 'five_hour', utilization: 0.91 }, AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'warning', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null,
    });
    expect(limitEventFromClaude({ status: 'rejected' }, AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null, message: null,
    });
    expect(limitEventFromClaude(null, AT)).toBeNull();
  });

  it('I-1 — a rejected limit covered by extra usage (overage allowed) is a warning; overage rejected or absent stays rejected', () => {
    const base = { status: 'rejected', resetsAt: 1791460800, rateLimitType: 'five_hour' };
    const warning = { at: '2026-10-08T12:00:00.000Z', kind: 'warning', limitType: 'five_hour', resetsAt: '2026-10-08T12:00:00.000Z', message: null };
    const rejected = { ...warning, kind: 'rejected' };
    expect(limitEventFromClaude({ ...base, overageStatus: 'allowed' }, AT)).toEqual(warning);
    expect(limitEventFromClaude({ ...base, overageStatus: 'allowed_warning' }, AT)).toEqual(warning);
    expect(limitEventFromClaude({ ...base, isUsingOverage: true }, AT)).toEqual(warning);
    expect(limitEventFromClaude({ ...base, overageStatus: 'rejected' }, AT)).toEqual(rejected);
    expect(limitEventFromClaude({ ...base, overageStatus: 'rejected', isUsingOverage: false }, AT)).toEqual(rejected);
    expect(limitEventFromClaude(base, AT)).toEqual(rejected);
  });

  it('M-5 — an out-of-range resetsAt never throws; it is reported as unknown', () => {
    expect(() => limitEventFromClaude({ status: 'rejected', resetsAt: 1e15 }, AT)).not.toThrow();
    expect(limitEventFromClaude({ status: 'rejected', resetsAt: 1e15 }, AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null, message: null,
    });
  });

  it('a limit message is a rejected event with its first line, capped; anything else is not', () => {
    expect(limitEventFromMessage("You've hit your usage limit. Try again in 2 hours.\nmore", AT)).toEqual({
      at: '2026-10-08T12:00:00.000Z', kind: 'rejected', limitType: null, resetsAt: null,
      message: "You've hit your usage limit. Try again in 2 hours.",
    });
    expect(limitEventFromMessage('429 Too Many Requests', AT)?.kind).toBe('rejected');
    expect(limitEventFromMessage(`rate limit ${'x'.repeat(400)}`, AT)?.message?.length).toBe(201);
    expect(limitEventFromMessage('Failed to authenticate: OAuth session expired', AT)).toBeNull();
  });
});
