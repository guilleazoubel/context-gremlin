import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexRunner, UnknownAgentHandleError } from '../../src/agent/codex-runner';
import { describeAgentRunnerContract } from '../support/agent-runner-contract';

const FIXTURE = path.join(__dirname, '../fixtures/fake-codex-cli.js');
const DEFAULT_THREAD_ID = '01a06cfe-46c0-7800-99fa-83b3a2cbfc6b';

async function withArgvLog<T>(suffix: string, fn: (argvLogPath: string) => Promise<T>): Promise<T> {
  const argvLogPath = path.join(tmpdir(), `codex-runner-argv-${suffix}-${Date.now()}.json`);
  process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
  try {
    return await fn(argvLogPath);
  } finally {
    delete process.env.FAKE_CLI_ARGV_LOG;
    await rm(argvLogPath, { force: true });
  }
}

describe('CodexRunner', () => {
  it('constructs the exact first-turn argv, including sandbox/model/additionalDirs', async () => {
    await withArgvLog('first-turn', async (argvLogPath) => {
      const runner = new CodexRunner({ codexBinary: FIXTURE, sandbox: 'read-only', model: 'gpt-5-codex' });
      const handle = await runner.start({
        sessionId: 'inv-1',
        workingDirectory: process.cwd(),
        additionalDirs: ['/s/one', '/s/two'],
      });
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        'exec', '--json', '-s', 'read-only', '-m', 'gpt-5-codex',
        '--add-dir', '/s/one', '--add-dir', '/s/two', 'hello',
      ]);
    });
  });

  it('defaults to sandbox workspace-write with no extra flags, and adds skip-git-repo-check/dangerously-bypass in order before --add-dir', async () => {
    await withArgvLog('defaults', async (argvLogPath) => {
      const runner = new CodexRunner({ codexBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual(['exec', '--json', '-s', 'workspace-write', 'hello']);
    });

    await withArgvLog('opt-in-flags', async (argvLogPath) => {
      const runner = new CodexRunner({
        codexBinary: FIXTURE,
        skipGitRepoCheck: true,
        dangerouslyBypassApprovalsAndSandbox: true,
      });
      const handle = await runner.start({
        sessionId: 'inv-1',
        workingDirectory: process.cwd(),
        additionalDirs: ['/s/one'],
      });
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        'exec', '--json', '-s', 'workspace-write',
        '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
        '--add-dir', '/s/one', 'hello',
      ]);
    });
  });

  it('constructs the exact resumed-turn argv, omitting -s and --add-dir even when set', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE, sandbox: 'read-only' });
    const handle = await runner.start({
      sessionId: 'inv-1',
      workingDirectory: process.cwd(),
      additionalDirs: ['/s/one'],
    });
    await runner.sendPrompt(handle, 'first');
    expect(runner.getResumeId(handle)).toBe(DEFAULT_THREAD_ID);

    await withArgvLog('resume', async (argvLogPath) => {
      await runner.sendPrompt(handle, 'again');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual(['exec', 'resume', DEFAULT_THREAD_ID, '--json', '-c', 'sandbox_mode="read-only"', 'again']);
    });
  });

  it('includes -m on a resumed turn when a model is configured', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE, model: 'gpt-5-codex' });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'first');

    await withArgvLog('resume-model', async (argvLogPath) => {
      await runner.sendPrompt(handle, 'again');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        'exec', 'resume', DEFAULT_THREAD_ID, '--json', '-c', 'sandbox_mode="workspace-write"',
        '-m', 'gpt-5-codex', 'again',
      ]);
    });
  });

  it('seeds the resume form from ctx.resumeId on the very first sendPrompt, and getResumeId reflects the echoed id', async () => {
    await withArgvLog('seeded-resume', async (argvLogPath) => {
      const runner = new CodexRunner({ codexBinary: FIXTURE });
      const handle = await runner.start({
        sessionId: 'inv-1',
        workingDirectory: process.cwd(),
        resumeId: 'seed-thread',
      });
      expect(runner.getResumeId(handle)).toBe('seed-thread');
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual(['exec', 'resume', 'seed-thread', '--json', '-c', 'sandbox_mode="workspace-write"', 'hello']);
      // The fixture echoes the resumed id verbatim in thread.started.
      expect(runner.getResumeId(handle)).toBe('seed-thread');
    });
  });

  it('carries -c sandbox_mode="read-only" on a resumed turn when the runner is configured with sandbox read-only', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE, sandbox: 'read-only' });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    await runner.sendPrompt(handle, 'first');

    await withArgvLog('resume-readonly-mode', async (argvLogPath) => {
      await runner.sendPrompt(handle, 'again');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual(['exec', 'resume', DEFAULT_THREAD_ID, '--json', '-c', 'sandbox_mode="read-only"', 'again']);
    });
  });

  it('parses agent_message output and fires onExit exactly once, before sendPrompt resolves', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const order: string[] = [];
    runner.onOutput(handle, (chunk) => {
      if (chunk.stream === 'stdout') stdoutChunks.push(chunk.data);
      else stderrChunks.push(chunk.data);
    });
    runner.onExit(handle, (result) => {
      exits.push(result);
      order.push('exit');
    });
    await runner.sendPrompt(handle, 'hello');
    order.push('resolved');

    expect(stdoutChunks).toEqual(['echo: hello']);
    expect(stderrChunks.join('')).toContain('Reading additional input from stdin...\n');
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(order).toEqual(['exit', 'resolved']);
  });

  it('reports a nonzero exit code and forwards the error/turn.failed text on failure, with no stdout agent text', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    runner.onOutput(handle, (chunk) => {
      if (chunk.stream === 'stdout') stdoutChunks.push(chunk.data);
      else stderrChunks.push(chunk.data);
    });
    runner.onExit(handle, (result) => exits.push(result));
    await runner.sendPrompt(handle, 'FAIL_LOUDLY');

    expect(exits).toEqual([{ code: 1, signal: null }]);
    expect(stdoutChunks).toEqual([]);
    const stderrText = stderrChunks.join('');
    expect(stderrText).toContain('Model metadata for `x` not found');
    expect(stderrText).toContain('simulated failure');
  });

  it('stop() kills an in-flight process; sendPrompt resolves and a second stop() is a no-op', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    runner.onExit(handle, (result) => exits.push(result));
    const sendPromise = runner.sendPrompt(handle, 'HANG_FOREVER');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runner.stop(handle);
    await sendPromise;
    expect(exits[0].signal).toBe('SIGTERM');
    await expect(runner.stop(handle)).resolves.not.toThrow();
  });

  it('throws UnknownAgentHandleError from sendPrompt/onOutput/onExit/stop for a fabricated handle', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const fake = { id: 'nope' };
    await expect(runner.sendPrompt(fake, 'x')).rejects.toThrow(UnknownAgentHandleError);
    expect(() => runner.onOutput(fake, () => undefined)).toThrow(UnknownAgentHandleError);
    expect(() => runner.onExit(fake, () => undefined)).toThrow(UnknownAgentHandleError);
    await expect(runner.stop(fake)).rejects.toThrow(UnknownAgentHandleError);
  });

  it('does not hang when stdin is closed (spawned with stdio ignore)', async () => {
    const runner = new CodexRunner({ codexBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    runner.onExit(handle, (result) => exits.push(result));
    await runner.sendPrompt(handle, 'READ_STDIN');
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });
});

describeAgentRunnerContract('CodexRunner', {
  makeRunner: () => new CodexRunner({ codexBinary: FIXTURE }),
  makeUnspawnableRunner: () => new CodexRunner({ codexBinary: '/nonexistent/agent-binary' }),
  echoPrompt: 'hello',
  expectedEcho: (prompt) => `echo: ${prompt}`,
  hangPrompt: 'HANG_FOREVER',
  failPrompt: 'FAIL_LOUDLY',
});
