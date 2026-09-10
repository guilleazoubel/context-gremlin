import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/version';

const CORE_ROOT = path.join(__dirname, '../..');
const ENGINE_DIR = path.join(CORE_ROOT, '../vscode/engine');
const ENGINE_JS = path.join(ENGINE_DIR, 'engine.js');
const BRIDGE_JS = path.join(ENGINE_DIR, 'bridge.js');

function esbuildAvailable(): boolean {
  try {
    require.resolve('esbuild');
    return true;
  } catch {
    return false;
  }
}

const available = esbuildAvailable();
const describeBundle = available ? describe : describe.skip;
if (!available) {
  console.warn('skipping the engine bundle smoke test: esbuild is not installed (run `pnpm install` in cgremlin/core)');
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeBundle('the esbuild bundles (R8, R24, R28)', () => {
  let dir: string;

  beforeAll(() => {
    const res = spawnSync('pnpm', ['run', 'build:engine'], { cwd: CORE_ROOT, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`build:engine failed: ${res.stdout}${res.stderr}`);
  }, 120_000);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-bundle-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits both bundles where the extension expects them', () => {
    expect(existsSync(ENGINE_JS)).toBe(true);
    expect(existsSync(BRIDGE_JS)).toBe(true);
  });

  it('inlines zod, so the packaged artifact needs no node_modules', () => {
    for (const file of [ENGINE_JS, BRIDGE_JS]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain("require('zod')");
      expect(source).not.toContain('require("zod")');
    }
  });

  it('carries an inline sourcemap and emits no external .map (R28)', () => {
    for (const file of [ENGINE_JS, BRIDGE_JS]) {
      expect(readFileSync(file, 'utf8')).toContain('//# sourceMappingURL=data:application/json;base64,');
    }
    expect(readdirSync(ENGINE_DIR).filter((n) => n.endsWith('.map'))).toEqual([]);
  });

  it('runs: `node engine.js --help` prints the USAGE banner and exits 0', () => {
    const res = spawnSync(process.execPath, [ENGINE_JS, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: cgremlin-core <command> [options]');
  });

  it('bridge.js exports the same ENGINE_VERSION the engine reports', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require(BRIDGE_JS) as { ENGINE_VERSION: string };
    expect(bridge.ENGINE_VERSION).toBe(ENGINE_VERSION);
  });

  it('scrubs the editor variables out of its own environment (R24)', () => {
    const res = spawnSync(process.execPath, [ENGINE_JS], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CGREMLIN_ENGINE_PRINT_ENV: '1',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--max-old-space-size=99',
        VSCODE_PID: '1',
        VSCODE_CWD: '/x',
      },
    });
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(report.electronRunAsNode ?? undefined).toBeUndefined();
    expect(report.nodeOptions ?? undefined).toBeUndefined();
    expect(report.vscodeKeys).toEqual([]);
    expect(String(report.nodeVersion)).toMatch(/^v\d+\./);
  });

  it('boots a real engine on a temp socket and answers GET /version', async () => {
    const configPath = path.join(dir, 'core.json');
    await writeFile(configPath, JSON.stringify({ me: 'me-user', repos: [], stateDir: dir }), { mode: 0o600 });
    const child = spawn(process.execPath, [ENGINE_JS, 'serve', '--config', configPath], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, HOME: dir },
    });
    try {
      const socketPath = path.join(dir, 'engine.sock');
      const deadline = Date.now() + 15_000;
      let body: Record<string, unknown> | null = null;
      for (;;) {
        try {
          const res = await requestOn(socketPath, '/version');
          if (res.status === 200) {
            body = res.body as Record<string, unknown>;
            break;
          }
        } catch {
          // not up yet
        }
        if (Date.now() >= deadline) break;
        await sleep(50);
      }
      expect(body).not.toBeNull();
      expect(body!.version).toBe(ENGINE_VERSION);
      expect(body!.name).toBe('cgremlin-core');
      expect(body!.pid).toBe(child.pid);
      expect(body!.activeRuns).toBe(0);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }, 30_000);
});
