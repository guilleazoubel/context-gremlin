import path from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner, UnknownAgentHandleError, claudeEnv } from '../../src/agent/claude-code-runner';
import { describeAgentRunnerContract } from '../support/agent-runner-contract';

const FIXTURE = path.join(__dirname, '../fixtures/fake-claude-cli.js');

const STREAM_JSON = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/claude-stream-json-tool-activity.json'), 'utf8'),
) as { records: Array<{ message: { content: Array<Record<string, never>> } }> };

function partAt(index: number): Record<string, never> {
  return STREAM_JSON.records[index].message.content[0];
}
function fixtureText(): string {
  return (partAt(0) as unknown as { text: string }).text;
}
function fixtureWriteBody(): string {
  return (partAt(3) as unknown as { input: { content: string } }).input.content;
}

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

  // Defect 2 — the `result` event was parsed ONLY to harvest `session_id`;
  // `is_error` and the `result` text were dropped on the floor, so the one
  // sentence explaining why the turn died never left the runner at all.
  it('forwards the result event’s error text, and still harvests the session id', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const chunks: string[] = [];
    runner.onOutput(handle, (chunk) => chunks.push(chunk.data));
    await runner.sendPrompt(handle, 'RESULT_ERROR');
    expect(chunks.join('')).toContain(
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    expect(runner.getClaudeSessionId(handle)).toBe('fresh-session-1');
  });

  // Defect 5 — the pane was blank while the agent worked: only `type: 'text'` parts were
  // forwarded, so every read, edit, command and test run — all of them `tool_use`/`tool_result`
  // parts — was dropped. A working agent and a wedged one looked identical.
  it('forwards each real tool call and its capped result as one work-log line', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const chunks: string[] = [];
    runner.onOutput(handle, (chunk) => {
      if (chunk.stream === 'stdout') chunks.push(chunk.data);
    });
    await runner.sendPrompt(handle, 'TOOL_ACTIVITY');
    // Each forwarded part is its own chunk — the pane appends chunk by chunk, so a work line
    // never runs into the prose line before it.
    const log = chunks.join('');
    expect(chunks.some((chunk) => chunk.startsWith('Ran: cd /Users/'))).toBe(true);
    expect(log).toMatch(/^ {2}-> Bash ok, \d+ lines$/m);
    expect(log).toMatch(/^ {5}\.\.\. \d+ lines omitted \.\.\.$/m);
    expect(log).toMatch(/^Wrote \/Users\/.*PLAN\.md$/m);
    expect(log).toMatch(/^Delegated to general-purpose: PM review of PLAN\.md$/m);
    // The prose parts still flow — this ADDS to them.
    expect(log).toContain(fixtureText());
    // A Write's input is the whole new file. Not one word of it may reach a watcher.
    expect(log).not.toContain(fixtureWriteBody().slice(0, 40));
  });

  it('forwards no result text when the turn ended fine', async () => {
    const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
    const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
    const chunks: string[] = [];
    runner.onOutput(handle, (chunk) => chunks.push(chunk.data));
    await runner.sendPrompt(handle, 'hello');
    expect(chunks).toEqual(['echo: hello']);
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

  it('spawns the CLI detached into its own process group, so a terminal signal to this process does not also hit the agent child', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-pgrp-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    const pgrpLogPath = `${argvLogPath}.pgrp`;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 'inv-1', workingDirectory: process.cwd() });
      await runner.sendPrompt(handle, 'hello');
      const childPgid = (await readFile(pgrpLogPath, 'utf8')).trim();
      const ownPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim();
      expect(childPgid).not.toBe(ownPgid);
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
      await rm(pgrpLogPath, { force: true });
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

  it('passes --add-dir per additional directory and seeds --resume from ctx.resumeId, in a pinned argv order', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-adddir-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, model: 'opus' });
      const handle = await runner.start({
        sessionId: 's1',
        workingDirectory: tmpdir(),
        additionalDirs: ['/sessions/s1', '/extra'],
        resumeId: 'seed-123',
      });
      await runner.sendPrompt(handle, 'hello');
      const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
      expect(argv).toEqual([
        '-p', 'hello',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        '--add-dir', '/sessions/s1',
        '--add-dir', '/extra',
        '--model', 'opus',
        '--resume', 'seed-123',
      ]);
      // the fixture echoes `resumed:<id>` as the new session id
      expect(runner.getResumeId(handle)).toBe('resumed:seed-123');
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('R116 — per-run model and effort from the context override the constructor model, in a pinned argv order', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-effort-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE, model: 'sonnet' });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir(), resumeId: 'seed-1', model: 'opus', effort: 'high' });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).toEqual([
        '-p', 'hello',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        '--model', 'opus',
        '--effort', 'high',
        '--resume', 'seed-1',
      ]);
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('R116 — passes no --effort when the context names none', async () => {
    const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-noeffort-${Date.now()}.json`);
    process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir() });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(argvLogPath, 'utf8'))).not.toContain('--effort');
    } finally {
      delete process.env.FAKE_CLI_ARGV_LOG;
      await rm(argvLogPath, { force: true });
    }
  });

  it('R116 — an inherited CLAUDE_CODE_EFFORT_LEVEL never reaches the CLI, and the engine’s own env is left as it was', async () => {
    const envLogPath = path.join(tmpdir(), `claude-code-runner-env-${Date.now()}.json`);
    const before = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
    process.env.FAKE_CLI_ENV_LOG = envLogPath;
    try {
      const runner = new ClaudeCodeRunner({ claudeBinary: FIXTURE });
      const handle = await runner.start({ sessionId: 's1', workingDirectory: tmpdir(), effort: 'medium' });
      await runner.sendPrompt(handle, 'hello');
      expect(JSON.parse(await readFile(envLogPath, 'utf8'))).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: null, PATH_SET: true });
      expect(process.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
    } finally {
      delete process.env.FAKE_CLI_ENV_LOG;
      if (before === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
      else process.env.CLAUDE_CODE_EFFORT_LEVEL = before;
      await rm(envLogPath, { force: true });
    }
  });

  it('claudeEnv drops only CLAUDE_CODE_EFFORT_LEVEL and never mutates its input', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_EFFORT_LEVEL: 'high', HOME: '/h' };
    expect(claudeEnv(base)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(base.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });
});

describeAgentRunnerContract('ClaudeCodeRunner', {
  makeRunner: () => new ClaudeCodeRunner({ claudeBinary: FIXTURE }),
  makeUnspawnableRunner: () => new ClaudeCodeRunner({ claudeBinary: '/nonexistent/agent-binary' }),
  echoPrompt: 'hello',
  expectedEcho: (prompt) => `echo: ${prompt}`,
  hangPrompt: 'HANG_FOREVER',
  failPrompt: 'FAIL_LOUDLY',
});
