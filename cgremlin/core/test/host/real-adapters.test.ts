import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realAdapters } from '../../src/host/serve';
import { resolveCoreConfig } from '../../src/config/core-config';
import { ClaudeCodeRunner } from '../../src/agent/claude-code-runner';
import { CodexRunner } from '../../src/agent/codex-runner';
import type { AgentRunner } from '../../src/agent/agent-runner';

describe('R116 — one runner per kind', () => {
  it.each(['claude-code', 'codex'] as const)('engine-wide runner %s is the same instance as runners[kind], and both kinds exist', (kind) => {
    const adapters = realAdapters(resolveCoreConfig({ me: 'me', runner: kind }, '/h'));
    expect(adapters.runnerKind).toBe(kind);
    expect(adapters.runners?.['claude-code']).toBeInstanceOf(ClaudeCodeRunner);
    expect(adapters.runners?.codex).toBeInstanceOf(CodexRunner);
    expect(adapters.runner).toBe(adapters.runners?.[kind]);
  });
});

describe('R116 / S2-5 — the engine-wide runnerOptions.model reaches only the engine-wide runner', () => {
  const FIXTURES = path.join(__dirname, '../fixtures');
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), 'real-adapters-bin-'));
    await symlink(path.join(FIXTURES, 'fake-claude-cli.js'), path.join(binDir, 'claude'));
    await symlink(path.join(FIXTURES, 'fake-codex-cli.js'), path.join(binDir, 'codex'));
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    delete process.env.FAKE_CLI_ARGV_LOG;
    await rm(binDir, { recursive: true, force: true });
  });

  function runnerOf(adapters: ReturnType<typeof realAdapters>, kind: 'claude-code' | 'codex'): AgentRunner {
    const runner = adapters.runners?.[kind];
    if (runner === undefined) throw new Error(`no ${kind} runner`);
    return runner;
  }

  /** Runs one prompt through `runner` (spawning the fake CLI found on PATH) and returns its argv. */
  async function argvOf(runner: AgentRunner): Promise<string[]> {
    const log = path.join(binDir, `argv-${Math.random().toString(36).slice(2)}.json`);
    process.env.FAKE_CLI_ARGV_LOG = log;
    const handle = await runner.start({ sessionId: 's', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'hello');
    return JSON.parse(await readFile(log, 'utf8')) as string[];
  }

  it('engine-wide runner claude-code: Claude gets --model, Codex gets no -m', async () => {
    const adapters = realAdapters(resolveCoreConfig({ me: 'me', runner: 'claude-code', runnerOptions: { model: 'claude-engine-model' } }, '/h'));
    const claudeArgv = await argvOf(runnerOf(adapters, 'claude-code'));
    const codexArgv = await argvOf(runnerOf(adapters, 'codex'));
    expect(claudeArgv).toContain('--model');
    expect(claudeArgv[claudeArgv.indexOf('--model') + 1]).toBe('claude-engine-model');
    expect(codexArgv).not.toContain('-m');
    expect(codexArgv).not.toContain('claude-engine-model');
  });

  it('engine-wide runner codex: Codex gets -m, Claude gets no --model', async () => {
    const adapters = realAdapters(resolveCoreConfig({ me: 'me', runner: 'codex', runnerOptions: { model: 'gpt-engine-model' } }, '/h'));
    const codexArgv = await argvOf(runnerOf(adapters, 'codex'));
    const claudeArgv = await argvOf(runnerOf(adapters, 'claude-code'));
    expect(codexArgv).toContain('-m');
    expect(codexArgv[codexArgv.indexOf('-m') + 1]).toBe('gpt-engine-model');
    expect(claudeArgv).not.toContain('--model');
    expect(claudeArgv).not.toContain('gpt-engine-model');
  });
});
