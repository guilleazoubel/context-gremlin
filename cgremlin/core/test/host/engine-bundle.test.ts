import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../src/version';
import { createHash } from 'node:crypto';

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

  /**
   * The cross-package guard the same-version upgrade needed: the version string stayed `0.0.1`
   * across two phases, so a stale engine and a fresh extension agreed about everything the
   * handshake asked. `bridge.js` now also carries a content address of the engine bundle beside
   * it, and the engine reports that same address on `GET /version`.
   */
  it('bridge.js carries a build id that is neither dev nor the version', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require(BRIDGE_JS) as { ENGINE_BUILD_ID: string };
    expect(bridge.ENGINE_BUILD_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(bridge.ENGINE_BUILD_ID).not.toBe('dev');
    expect(bridge.ENGINE_BUILD_ID).not.toBe(ENGINE_VERSION);
  });

  /** The half that ORDERS two builds — without it neither window can tell whose bundle is newer. */
  it('bridge.js carries an ISO build time', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bridge = require(BRIDGE_JS) as { ENGINE_BUILD_TIME: string | null };
    expect(typeof bridge.ENGINE_BUILD_TIME).toBe('string');
    expect(new Date(bridge.ENGINE_BUILD_TIME!).toISOString()).toBe(bridge.ENGINE_BUILD_TIME);
  });

  it('rebuilding the same sources produces the same build id, and a changed engine a new one', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const before = (require(BRIDGE_JS) as { ENGINE_BUILD_ID: string }).ENGINE_BUILD_ID;
    const rebuild = spawnSync(process.execPath, ['scripts/build-engine.mjs'], { cwd: CORE_ROOT, encoding: 'utf8' });
    expect(rebuild.status).toBe(0);
    const after = JSON.parse(
      spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(BRIDGE_JS)}).ENGINE_BUILD_ID))`], {
        encoding: 'utf8',
      }).stdout,
    ) as string;
    expect(after).toBe(before);
    // And it really is a content address: a different engine bundle hashes differently.
    const engine = readFileSync(ENGINE_JS);
    const other = createHash('sha256').update(Buffer.concat([engine, Buffer.from('x')])).digest('hex').slice(0, 16);
    expect(other).not.toBe(after);
  }, 120_000);

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
      // Freshly, not from the module cache: a case above rebuilds both bundles, and a cached
      // bridge would be compared against an engine.js built seconds later.
      delete require.cache[require.resolve(BRIDGE_JS)];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bridge = require(BRIDGE_JS) as { ENGINE_BUILD_ID: string; ENGINE_BUILD_TIME: string };
      // The handshake, end to end: the engine reports the very id the bridge beside it exports.
      expect(body!.buildId).toBe(bridge.ENGINE_BUILD_ID);
      expect(body!.buildTime).toBe(bridge.ENGINE_BUILD_TIME);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }, 30_000);
});
