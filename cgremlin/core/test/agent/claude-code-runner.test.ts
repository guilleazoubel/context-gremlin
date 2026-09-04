import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  it('constructs the exact expected CLI arguments, including model and permission mode', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({
        claudeBinary: FIXTURE,
        model: 'claude-sonnet-5',
        permissionMode: 'acceptEdits',
      });
      const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        '-p',
        'hello',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'claude-sonnet-5',
      ]);
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('includes --resume with the previously captured session id on the second call', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-resume-${Date.now()}.json`);
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'first');
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      await runner.sendPrompt(handle, 'second');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        '-p',
        'second',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--resume',
        'fresh-session-1',
      ]);
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });
});
