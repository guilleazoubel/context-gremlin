import { describe, expect, it } from 'vitest';
import { realAdapters } from '../../src/host/serve';
import { resolveCoreConfig } from '../../src/config/core-config';
import { ClaudeCodeRunner } from '../../src/agent/claude-code-runner';
import { CodexRunner } from '../../src/agent/codex-runner';

describe('R116 — one runner per kind', () => {
  it.each(['claude-code', 'codex'] as const)('engine-wide runner %s is the same instance as runners[kind], and both kinds exist', (kind) => {
    const adapters = realAdapters(resolveCoreConfig({ me: 'me', runner: kind }, '/h'));
    expect(adapters.runnerKind).toBe(kind);
    expect(adapters.runners?.['claude-code']).toBeInstanceOf(ClaudeCodeRunner);
    expect(adapters.runners?.codex).toBeInstanceOf(CodexRunner);
    expect(adapters.runner).toBe(adapters.runners?.[kind]);
  });
});
