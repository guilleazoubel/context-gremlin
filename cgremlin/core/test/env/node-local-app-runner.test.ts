import { describe, expect, it, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NodeLocalAppRunner } from '../../src/env/node-local-app-runner';
import type { LocalAppProcess } from '../../src/env/local-app-runner';

const FIXTURE = join(__dirname, '../fixtures/local-app/fixture-server.js');
const NVM_SH = join(homedir(), '.nvm', 'nvm.sh');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const address = srv.address();
      srv.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('failed to bind an ephemeral port'));
        }
      });
    });
    srv.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return await predicate();
}

describe.skipIf(process.platform === 'win32')('NodeLocalAppRunner (real subprocess)', () => {
  const runner = new NodeLocalAppRunner();
  const tmpDir = mkdtempSync(join(tmpdir(), 'cgremlin-local-app-'));
  const started: LocalAppProcess[] = [];
  const startedPorts: number[] = [];

  afterEach(async () => {
    while (started.length > 0) {
      const proc = started.pop()!;
      const port = startedPorts.pop()!;
      await runner.stop(proc, { port });
      expect(await runner.portListenerPid(port)).toBeNull();
    }
  });

  it('start returns a pid, writes a log file, and captures the server stdout', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'start.log');
    const proc = await runner.start({
      cwd: tmpDir,
      command: `env FIXTURE_PORT=${port} node ${FIXTURE}`,
      logPath,
    });
    started.push(proc);
    startedPorts.push(port);
    expect(proc.pid).toBeGreaterThan(0);
    expect(await waitUntil(async () => existsSync(logPath), 2000)).toBe(true);
    expect(await waitUntil(async () => readFileSync(logPath, 'utf8').includes('listening'), 2000)).toBe(true);
  });

  it('healthcheck resolves ok once the fixture server is up', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'health-ok.log');
    const proc = await runner.start({ cwd: tmpDir, command: `env FIXTURE_PORT=${port} node ${FIXTURE}`, logPath });
    started.push(proc);
    startedPorts.push(port);
    const result = await runner.healthcheck(`http://127.0.0.1:${port}`, {
      timeoutMs: 5000,
      intervalMs: 100,
      insecureTls: false,
    });
    expect(result).toEqual({ ok: true, status: 200, reason: null, exited: false });
  });

  it('healthcheck rejects a non-2xx response as unhealthy (F2)', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'health-500.log');
    const proc = await runner.start({
      cwd: tmpDir,
      command: `env FIXTURE_PORT=${port} FIXTURE_STATUS=500 node ${FIXTURE}`,
      logPath,
    });
    started.push(proc);
    startedPorts.push(port);
    await waitUntil(async () => (await runner.portListenerPid(port)) !== null, 2000);
    const result = await runner.healthcheck(`http://127.0.0.1:${port}`, {
      timeoutMs: 600,
      intervalMs: 100,
      insecureTls: false,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('500');
  });

  it('healthcheck against a closed port times out', async () => {
    const port = await getFreePort();
    const start = Date.now();
    const result = await runner.healthcheck(`http://127.0.0.1:${port}`, {
      timeoutMs: 600,
      intervalMs: 100,
      insecureTls: false,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.exited).toBe(false);
    expect(result.reason).not.toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(550);
  });

  it('healthcheck ends immediately when the process has already exited (R11 fast-fail)', async () => {
    const start = Date.now();
    const proc: LocalAppProcess = { pid: 999999, pgid: 999999, startedAt: new Date().toISOString() };
    const result = await runner.healthcheck('http://127.0.0.1:1', {
      timeoutMs: 10_000,
      intervalMs: 100,
      insecureTls: false,
      proc,
    });
    expect(result).toEqual({ ok: false, status: null, reason: expect.any(String), exited: true });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('portListenerPid is non-null while the server is up and null after stop', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'listener.log');
    const proc = await runner.start({ cwd: tmpDir, command: `env FIXTURE_PORT=${port} node ${FIXTURE}`, logPath });
    await waitUntil(async () => (await runner.portListenerPid(port)) !== null, 2000);
    expect(await runner.portListenerPid(port)).not.toBeNull();
    await runner.stop(proc, { port });
    expect(await runner.portListenerPid(port)).toBeNull();
  });

  it('the port listener leads the same process group as the returned pgid', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'pgid.log');
    const proc = await runner.start({ cwd: tmpDir, command: `env FIXTURE_PORT=${port} node ${FIXTURE}`, logPath });
    started.push(proc);
    startedPorts.push(port);
    await waitUntil(async () => (await runner.portListenerPid(port)) !== null, 2000);
    const listenerPid = await runner.portListenerPid(port);
    expect(listenerPid).not.toBeNull();
    const listenerPgid = await runner.pgidOf(listenerPid!);
    expect(listenerPgid).toBe(proc.pgid);
  });

  it('stop kills the whole group and frees the port, including a spawned child', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'stop.log');
    const pidFile = join(tmpDir, 'child.pid');
    const proc = await runner.start({
      cwd: tmpDir,
      command: `env FIXTURE_PORT=${port} FIXTURE_SPAWN_CHILD=1 FIXTURE_CHILD_PID_FILE=${pidFile} node ${FIXTURE}`,
      logPath,
    });
    await waitUntil(async () => existsSync(pidFile), 2000);
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(() => process.kill(childPid, 0)).not.toThrow();

    await runner.stop(proc, { port });

    expect(() => process.kill(childPid, 0)).toThrow();
    expect(await runner.portListenerPid(port)).toBeNull();
  });

  it('stop on an already-dead process resolves without throwing', async () => {
    const proc: LocalAppProcess = { pid: 999998, pgid: 999998, startedAt: new Date().toISOString() };
    await expect(runner.stop(proc, { port: await getFreePort() })).resolves.toBeUndefined();
  });

  it('exec runs a command and reports its exit code without rejecting', async () => {
    const ok = await runner.exec('echo hi', { cwd: tmpDir });
    expect(ok).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });

    const failed = await runner.exec("sh -c 'exit 3'", { cwd: tmpDir });
    expect(failed.code).toBe(3);
  });

  it('exec runs an env-prefixed inline command (no `env` wrapper) without exit 127 (F1)', async () => {
    const result = await runner.exec('PORT=8080 node -e "process.exit(0)"', { cwd: tmpDir });
    expect(result.code).toBe(0);
  });

  it('exec passes through a non-zero exit code from an env-prefixed command (F1)', async () => {
    const result = await runner.exec('PORT=8080 node -e "process.exit(3)"', { cwd: tmpDir });
    expect(result.code).toBe(3);
  });

  it('start with an env-prefixed command (no `env` wrapper) becomes healthy and stop frees the port and kills the group (F1)', async () => {
    const port = await getFreePort();
    const logPath = join(tmpDir, 'env-prefixed-start.log');
    const proc = await runner.start({
      cwd: tmpDir,
      command: `FIXTURE_PORT=${port} node ${FIXTURE}`,
      logPath,
    });
    started.push(proc);
    startedPorts.push(port);
    const result = await runner.healthcheck(`http://127.0.0.1:${port}`, {
      timeoutMs: 5000,
      intervalMs: 100,
      insecureTls: false,
    });
    expect(result).toEqual({ ok: true, status: 200, reason: null, exited: false });

    await runner.stop(proc, { port });
    started.pop();
    startedPorts.pop();
    expect(await runner.portListenerPid(port)).toBeNull();
  });

  it('exec with logPath appends both streams to the log', async () => {
    const logPath = join(tmpDir, 'exec.log');
    writeFileSync(logPath, '');
    await runner.exec("sh -c 'echo out; echo err 1>&2'", { cwd: tmpDir, logPath });
    const contents = readFileSync(logPath, 'utf8');
    expect(contents).toContain('out');
    expect(contents).toContain('err');
  });

  it.skipIf(!existsSync(NVM_SH))(
    'exec maps a bad nodeVersion to exit 78 via the nvm wrapper (EX_CONFIG)',
    async () => {
      const result = await runner.exec('true', { cwd: tmpDir, nodeVersion: 'definitely-not-a-version' });
      expect(result.code).toBe(78);
    },
  );

  it('tailLog / headLog read the edges of a log file and empty string when absent', async () => {
    const logPath = join(tmpDir, 'lines.log');
    writeFileSync(logPath, 'one\ntwo\nthree\nfour\nfive\n');
    expect(await runner.tailLog(join(tmpDir, 'missing.log'), 5)).toBe('');
    expect(await runner.tailLog(logPath, 2)).toBe('four\nfive');
    expect(await runner.headLog(logPath, 2)).toBe('one\ntwo');
  });
});
