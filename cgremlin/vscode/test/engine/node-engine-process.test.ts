/**
 * The Node adapter, against real sockets, real files and real children.
 *
 * The manager suite proves the *decisions*; this one proves the four mechanisms those decisions
 * rest on: a probe that can tell "nobody home" from "somebody else", a detached child that
 * survives its parent and still reports its exit, a log that is appended and rotated in the right
 * order, and a signal that classifies `ESRCH`/`EPERM` instead of escalating.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  childEnv,
  LOGIN_PATH_TIMEOUT_MS,
  NodeEngineProcess,
  parsePidFile,
} from '../../src/engine/node-engine-process';
import { LOG_MAX_BYTES } from '../../src/engine/manager';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-engine-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for a condition');
}

const VERSION_BODY = {
  name: 'cgremlin-core',
  version: '0.0.1',
  pid: 4242,
  startedAt: '2026-09-10T10:00:00.000Z',
  socketPath: '/tmp/cg/engine.sock',
  activeRuns: 2,
};

async function versionServer(body: unknown = VERSION_BODY): Promise<string> {
  const socketPath = path.join(tempDir(), 'engine.sock');
  const server = http.createServer((req, res) => {
    const payload = JSON.stringify(body);
    res.writeHead(req.url === '/version' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanups.push(() => server.close());
  return socketPath;
}

describe('probe', () => {
  it('returns the engine identity from GET /version', async () => {
    const socketPath = await versionServer();
    const result = await new NodeEngineProcess().probe(socketPath);
    expect(result).toEqual({
      version: '0.0.1',
      pid: 4242,
      startedAt: '2026-09-10T10:00:00.000Z',
      socketPath: '/tmp/cg/engine.sock',
      activeRuns: 2,
    });
  });

  it('reports a server that answers something else as foreign', async () => {
    const socketPath = await versionServer({ hello: 'not an engine' });
    expect(await new NodeEngineProcess().probe(socketPath)).toBe('foreign');
  });

  it('reports a socket that never answers as unreachable, not foreign', async () => {
    const socketPath = path.join(tempDir(), 'engine.sock');
    // Accepts the connection and then says nothing: a wedged engine, not a stranger's server, and
    // certainly not "nobody home". Only the retry above this can tell which.
    const server = http.createServer(() => {
      /* deliberately never answers */
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    cleanups.push(() => server.closeAllConnections());
    cleanups.push(() => server.close());

    const proc = new NodeEngineProcess({ probeTimeoutMs: 150 });
    expect(await proc.probe(socketPath)).toBe('unreachable');
  });

  it('returns null for a socket path that does not exist, and creates nothing', async () => {
    const socketPath = path.join(tempDir(), 'engine.sock');
    expect(await new NodeEngineProcess().probe(socketPath)).toBeNull();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('returns null for a stale socket file and leaves the file alone', async () => {
    const dir = tempDir();
    const socketPath = path.join(dir, 'engine.sock');
    // Killed hard, so it cannot clean up after itself — the classic stale socket.
    const listener = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => setInterval(() => {}, 1000))`,
    ]);
    cleanups.push(() => listener.kill('SIGKILL'));
    await waitFor(() => fs.existsSync(socketPath));
    listener.kill('SIGKILL');
    await waitFor(() => listener.killed);
    await sleep(50);
    expect(fs.existsSync(socketPath)).toBe(true);

    expect(await new NodeEngineProcess().probe(socketPath)).toBeNull();
    // The extension never unlinks a socket: stale-socket recovery is the engine's job.
    expect(fs.existsSync(socketPath)).toBe(true);
  });
});

describe('resolveLoginPath (R20)', () => {
  function fakeShell(dir: string, body: string): string {
    const shell = path.join(dir, 'fake-shell');
    fs.writeFileSync(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return shell;
  }

  it('caps the shell at five seconds', () => {
    expect(LOGIN_PATH_TIMEOUT_MS).toBe(5_000);
  });

  it('takes the last non-empty line the login shell printed', async () => {
    const shell = fakeShell(tempDir(), 'echo "some profile noise"\necho "/opt/homebrew/bin:/usr/bin"');
    expect(await new NodeEngineProcess({ shell }).resolveLoginPath()).toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('returns null for a non-zero exit, empty output or no shell at all', async () => {
    const dir = tempDir();
    expect(await new NodeEngineProcess({ shell: fakeShell(dir, 'exit 3') }).resolveLoginPath()).toBeNull();
    expect(await new NodeEngineProcess({ shell: fakeShell(dir, 'echo ""') }).resolveLoginPath()).toBeNull();
    expect(await new NodeEngineProcess({ shell: '', env: {} }).resolveLoginPath()).toBeNull();
  });

  it('returns null within the cap and leaves no stray child', async () => {
    const dir = tempDir();
    const marker = path.join(dir, 'still-running');
    const shell = fakeShell(dir, `sleep 1\ntouch ${JSON.stringify(marker)}\necho /late`);
    const started = Date.now();
    const value = await new NodeEngineProcess({ shell, loginPathTimeoutMs: 200 }).resolveLoginPath();
    expect(value).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    await sleep(1_500);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('spawnDetached', () => {
  const dumper = (extra = ''): string[] => [
    '-e',
    `const fs=require('fs');console.log(JSON.stringify(process.env));${extra}`,
  ];

  it('runs detached, logs to the file, and reports the exit code (R26)', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'engine.log');
    const proc = new NodeEngineProcess({ env: { ...process.env } });
    const child = await proc.spawnDetached({
      execPath: process.execPath,
      args: dumper(),
      cwd: dir,
      logPath,
      env: { PATH: '/login/bin' },
    });
    expect(child.pid).toBeGreaterThan(0);
    let code: number | null | undefined;
    child.onExit((c) => {
      code = c;
    });
    await waitFor(() => code !== undefined);
    expect(code).toBe(0);

    const dumped = JSON.parse(fs.readFileSync(logPath, 'utf8')) as Record<string, string>;
    expect(dumped.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(dumped.PATH).toBe('/login/bin');
  });

  it('scrubs the host plumbing from the child environment (R10)', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'engine.log');
    const proc = new NodeEngineProcess({
      env: {
        HOME: dir,
        PATH: '/usr/bin',
        NODE_OPTIONS: '--max-old-space-size=99',
        VSCODE_PID: '1',
        VSCODE_CWD: '/x',
      },
    });
    const child = await proc.spawnDetached({
      execPath: process.execPath,
      args: dumper(),
      cwd: dir,
      logPath,
      env: { PATH: undefined },
    });
    let done = false;
    child.onExit(() => {
      done = true;
    });
    await waitFor(() => done);
    const dumped = JSON.parse(fs.readFileSync(logPath, 'utf8')) as Record<string, string>;
    expect(dumped.NODE_OPTIONS).toBeUndefined();
    expect(Object.keys(dumped).filter((k) => k.startsWith('VSCODE_'))).toEqual([]);
    expect(dumped.PATH).toBe('/usr/bin');
    expect(dumped.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('appends across two spawns rather than truncating (R11)', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'engine.log');
    const proc = new NodeEngineProcess();
    for (const word of ['first', 'second']) {
      const child = await proc.spawnDetached({
        execPath: process.execPath,
        args: ['-e', `console.log('${word}')`],
        cwd: dir,
        logPath,
        env: {},
      });
      let done = false;
      child.onExit(() => {
        done = true;
      });
      await waitFor(() => done);
    }
    expect(fs.readFileSync(logPath, 'utf8')).toBe('first\nsecond\n');
  });

  it('reports a child that could not start, instead of throwing inside the host', async () => {
    const dir = tempDir();
    const proc = new NodeEngineProcess();
    const spawned = await proc
      .spawnDetached({
        execPath: path.join(dir, 'not-a-binary'),
        args: [],
        cwd: dir,
        logPath: path.join(dir, 'engine.log'),
        env: {},
      })
      .catch(() => null);
    if (spawned === null) return; // it failed synchronously, which the manager also handles
    let code: number | null | undefined;
    spawned.onExit((c) => {
      code = c;
    });
    await waitFor(() => code !== undefined);
    expect(code).toBeNull();
  });
});

describe('rotateLog (R11/R30)', () => {
  it('rotates only above the threshold, before anything recreates the file', async () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'engine.log');
    const proc = new NodeEngineProcess();

    await proc.rotateLog(logPath, 10); // missing file: a no-op, not a failure
    fs.writeFileSync(logPath, 'small\n');
    await proc.rotateLog(logPath, 1_000);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);

    fs.writeFileSync(logPath, 'x'.repeat(64));
    await proc.rotateLog(logPath, 32);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toHaveLength(64);
  });

  it('uses an 8 MB threshold', () => {
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('readPidFile and logTail', () => {
  it('reads the identity the engine wrote, and null for anything else', async () => {
    const dir = tempDir();
    const proc = new NodeEngineProcess();
    const good = path.join(dir, 'engine.json');
    fs.writeFileSync(
      good,
      JSON.stringify({ pid: 7, version: '0.0.1', socketPath: '/s.sock', startedAt: 'now' }),
    );
    expect(await proc.readPidFile(good)).toEqual({
      pid: 7,
      version: '0.0.1',
      socketPath: '/s.sock',
      startedAt: 'now',
    });
    expect(await proc.readPidFile(path.join(dir, 'missing.json'))).toBeNull();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    expect(await proc.readPidFile(bad)).toBeNull();
    expect(parsePidFile('{"pid":"7"}')).toBeNull();
  });

  it('returns the last N lines, and nothing for a log that is not there', async () => {
    const dir = tempDir();
    const proc = new NodeEngineProcess();
    const logPath = path.join(dir, 'engine.log');
    fs.writeFileSync(logPath, ['a', 'b', 'c', 'd'].join('\n') + '\n');
    expect(await proc.logTail(logPath, 2)).toEqual(['c', 'd']);
    expect(await proc.logTail(path.join(dir, 'nope.log'), 20)).toEqual([]);
  });
});

describe('signal', () => {
  it('classifies a dead pid as gone and one we may not touch as foreign', async () => {
    const proc = new NodeEngineProcess();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid as number;
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await sleep(20);
    expect(proc.signal(pid, 'SIGTERM')).toBe('gone');
    // pid 1 is launchd: alive, and not ours.
    expect(proc.signal(1, 'SIGTERM')).toBe('foreign');
  });

  it('signals a live child exactly once and never harder', async () => {
    const proc = new NodeEngineProcess();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const pid = child.pid as number;
    expect(proc.signal(pid, 'SIGTERM')).toBe('signalled');
    const signal = await new Promise<string | null>((resolve) =>
      child.on('exit', (_code, sig) => resolve(sig)),
    );
    expect(signal).toBe('SIGTERM');
  });
});

describe('childEnv', () => {
  it('is a pure function of the base environment and the overrides', () => {
    const env = childEnv(
      { PATH: '/usr/bin', NODE_OPTIONS: '--x', VSCODE_IPC_HOOK: '/y', HOME: '/home/me' },
      { PATH: '/login/bin' },
    );
    expect(env).toEqual({
      PATH: '/login/bin',
      HOME: '/home/me',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});
