import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '../../src/host/serve';
import type { EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { SocketInUseError } from '../../src/api/listen';
import { ENGINE_VERSION } from '../../src/version';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';

function requestOn(socketPath: string, urlPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-identity-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function testConfig(over: Record<string, unknown> = {}): CoreConfig {
  return resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      sessionsDir: '/sessions',
      worktreesDir: '/worktrees',
      mirrorsDir: '/mirrors',
      // stateDir is the test's REAL temp dir: the lock write bypasses the
      // in-memory adapter by design (R22).
      stateDir: dir,
      ...over,
    },
    '/home/e2e',
  );
}

function testAdapters(overrides: Partial<EngineAdapters> = {}): EngineAdapters {
  return {
    fs: new InMemoryFileSystem(),
    git: new FakeGitRunner(),
    gh: new FakeGhRunner(),
    runner: new FakeAgentRunner(),
    runnerKind: 'claude-code',
    clock: new FakeClock(),
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  };
}

/** A pid that has provably exited — spawned and awaited, so `process.kill(pid, 0)` gives ESRCH. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return pid;
}

describe('the engine.json lock (R22)', () => {
  it('creates engine.json 0600 with exactly { pid, version, buildId, socketPath, startedAt }, matching GET /version', async () => {
    const config = testConfig();
    const handle = await serve(config, testAdapters(), { log: () => {} });
    try {
      const lockPath = config.enginePidPath!;
      expect(existsSync(lockPath)).toBe(true);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(['buildId', 'pid', 'socketPath', 'startedAt', 'version']);
      expect(record.pid).toBe(process.pid);
      expect(record.version).toBe(ENGINE_VERSION);
      expect(record.socketPath).toBe(config.socketPath);

      const body = (await requestOn(config.socketPath!, '/version')).body as Record<string, unknown>;
      expect(record.pid).toBe(body.pid);
      expect(record.version).toBe(body.version);
      // MG-C5: the lock and the probe agree about the *build*, not only the version string.
      expect(record.buildId).toBe(body.buildId);
      expect(record.startedAt).toBe(body.startedAt);
      expect(record.socketPath).toBe(body.socketPath);
    } finally {
      await handle.close();
    }
  });

  it('takes the lock BEFORE it listens: a failed listenOnSocket removes the file the same call created', async () => {
    const config = testConfig();
    // A live listener on the socket path and NO engine.json: the lock is
    // taken, then the listen fails.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(config.socketPath!, () => resolve()));
    try {
      await expect(serve(config, testAdapters(), { log: () => {} })).rejects.toBeInstanceOf(SocketInUseError);
      expect(existsSync(config.enginePidPath!)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('refuses a second serve() against the same stateDir and leaves the first engine untouched', async () => {
    const config = testConfig();
    const handle = await serve(config, testAdapters(), { log: () => {} });
    try {
      const before = readFileSync(config.enginePidPath!);
      const second = testConfig({ socketPath: path.join(dir, 'other.sock') });
      await expect(serve(second, testAdapters(), { log: () => {} })).rejects.toBeInstanceOf(SocketInUseError);
      expect(readFileSync(config.enginePidPath!).equals(before)).toBe(true);
      expect((await requestOn(config.socketPath!, '/version')).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('takes over an engine.json naming a dead pid whose socket does not answer, replacing it wholesale', async () => {
    const config = testConfig();
    await writeFile(
      config.enginePidPath!,
      JSON.stringify({ pid: await deadPid(), version: '0.0.0', socketPath: config.socketPath, startedAt: 'old', junk: 1 }),
      { mode: 0o600 },
    );
    const handle = await serve(config, testAdapters(), { log: () => {} });
    try {
      const record = JSON.parse(await readFile(config.enginePidPath!, 'utf8')) as Record<string, unknown>;
      expect(record.pid).toBe(process.pid);
      expect(record.version).toBe(ENGINE_VERSION);
      expect(record.junk).toBeUndefined();
      expect(record.startedAt).not.toBe('old');
    } finally {
      await handle.close();
    }
  });

  /** A lock naming a pid that is alive (this very process) whose socket is dead. */
  async function lockOnLivePidWithDeadSocket(config: CoreConfig): Promise<void> {
    await writeFile(
      config.enginePidPath!,
      JSON.stringify({ pid: process.pid, version: ENGINE_VERSION, socketPath: '/nope.sock', startedAt: 'x' }),
      { mode: 0o600 },
    );
  }

  it('refuses a lock whose pid is alive AND is a cgremlin engine still booting (its socket is not up yet)', async () => {
    const config = testConfig();
    await lockOnLivePidWithDeadSocket(config);
    await expect(
      serve(config, testAdapters(), {
        log: () => {},
        readProcessCommand: async () => '/usr/local/bin/node /opt/cg/bin/cgremlin-core serve --config /x/core.json',
      }),
    ).rejects.toBeInstanceOf(SocketInUseError);
  });

  it("names the lock owner's own recorded socketPath when it refuses, not ours", async () => {
    const config = testConfig();
    await lockOnLivePidWithDeadSocket(config);
    await expect(
      serve(config, testAdapters(), {
        log: () => {},
        readProcessCommand: async () => 'node /opt/cg/engine/engine.js serve --config /x/core.json',
      }),
    ).rejects.toThrow(/'\/nope\.sock'/);
  });

  it('takes over a lock whose pid the OS reused for an unrelated process', async () => {
    const config = testConfig();
    await lockOnLivePidWithDeadSocket(config);
    const handle = await serve(config, testAdapters(), { log: () => {}, readProcessCommand: async () => '-zsh' });
    try {
      const record = JSON.parse(await readFile(config.enginePidPath!, 'utf8')) as Record<string, unknown>;
      expect(record.pid).toBe(process.pid);
      expect(record.socketPath).toBe(config.socketPath);
      expect((await requestOn(config.socketPath!, '/version')).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('refuses, naming the lock path, when ps cannot say what the recorded pid is', async () => {
    const config = testConfig();
    await lockOnLivePidWithDeadSocket(config);
    await expect(
      serve(config, testAdapters(), { log: () => {}, readProcessCommand: async () => null }),
    ).rejects.toThrow(config.enginePidPath!);
  });

  it('close() removes engine.json, and still removes it when a pipeline.stop() inside close() throws', async () => {
    const config = testConfig();
    const handle = await serve(config, testAdapters(), { log: () => {} });
    expect(existsSync(config.enginePidPath!)).toBe(true);
    vi.spyOn(handle.engine.pipeline, 'activeSessionIds').mockReturnValue(['boom-1']);
    vi.spyOn(handle.engine.pipeline, 'stop').mockRejectedValue(new Error('stop failed'));
    await expect(handle.close()).rejects.toThrow('stop failed');
    expect(existsSync(config.enginePidPath!)).toBe(false);
    expect(existsSync(config.socketPath!)).toBe(false);
  });

  it('a SIGTERM-driven close() removes engine.json too', async () => {
    const config = testConfig();
    const handle = await serve(config, testAdapters(), { log: () => {}, signals: [] });
    handle.onSignal('SIGTERM');
    await handle.close();
    expect(existsSync(config.enginePidPath!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MG-C1, the two-`serve`-process half (R22). Two real engines started with no
// delay against one stateDir: exactly one comes up, the loser exits 1 with
// listen.ts's SocketInUseError wording, and the winner is intact afterwards.
// ---------------------------------------------------------------------------

const CORE_ROOT = path.join(__dirname, '../..');
const CLI_ENTRY = path.join(CORE_ROOT, 'dist/cli/main.js');
const BIN = path.join(CORE_ROOT, 'bin/cgremlin-core');

/** Newest mtime under `dir`, so a stale `dist` is rebuilt instead of racing yesterday's engine. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function buildDistOnce(): void {
  if (existsSync(CLI_ENTRY) && statSync(CLI_ENTRY).mtimeMs >= newestMtime(path.join(CORE_ROOT, 'src'))) return;
  // `dist` is gitignored, so a clean checkout has none. Compile with the
  // devDependency's own tsc rather than shelling out to a package manager.
  const tsc = require.resolve('typescript/lib/tsc.js');
  const res = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: CORE_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`tsc failed: ${res.stdout}${res.stderr}`);
}

interface RaceEntrant {
  code: number | null;
  stderr: string;
}

function runServe(home: string, configPath: string): { done: Promise<RaceEntrant>; kill: () => void } {
  const child = spawn(process.execPath, [BIN, 'serve', '--config', configPath], {
    cwd: home,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HOME: home },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<RaceEntrant>((resolve) => {
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  return { done, kill: () => child.kill('SIGTERM') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVersion(socketPath: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await requestOn(socketPath, '/version');
      if (res.status === 200) return res.body as Record<string, unknown>;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) return null;
    await sleep(50);
  }
}

describe('MG-C1: two serve processes racing for one stateDir', () => {
  it('leaves exactly one engine, the loser exiting 1 with the SocketInUseError wording', async () => {
    buildDistOnce();
    for (let round = 0; round < 5; round += 1) {
      const home = await mkdtemp(path.join(tmpdir(), `cgremlin-core-race-${round}-`));
      const configPath = path.join(home, 'core.json');
      await writeFile(configPath, JSON.stringify({ me: 'me-user', repos: [], stateDir: home }), { mode: 0o600 });
      const a = runServe(home, configPath);
      const b = runServe(home, configPath);
      try {
        const loser = await Promise.race([a.done, b.done]);
        expect(loser.code).toBe(1);
        expect(loser.stderr).toContain('Another process is already listening on');

        const body = await waitForVersion(path.join(home, 'engine.sock'), 10_000);
        expect(body).not.toBeNull();
        const record = JSON.parse(await readFile(path.join(home, 'engine.json'), 'utf8')) as Record<string, unknown>;
        expect(record.pid).toBe(body!.pid);
      } finally {
        a.kill();
        b.kill();
        await Promise.all([a.done, b.done]);
        await rm(home, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
