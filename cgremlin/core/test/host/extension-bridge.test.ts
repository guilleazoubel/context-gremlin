import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadResolvedConfig, ENGINE_VERSION as BRIDGE_VERSION } from '../../src/host/extension-bridge';
import { loadCoreConfig } from '../../src/config/core-config';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { ConfigError } from '../../src/discovery/discovery-config';
import { ENGINE_VERSION } from '../../src/version';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-bridge-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extension-bridge', () => {
  it('re-exports ENGINE_VERSION', () => {
    expect(BRIDGE_VERSION).toBe(ENGINE_VERSION);
  });

  it('returns paths identical to the loader itself — it derives nothing of its own', async () => {
    const configPath = path.join(dir, 'core.json');
    await writeFile(configPath, JSON.stringify({ me: 'octocat', repos: ['acme/app'], stateDir: dir }), { mode: 0o600 });
    const paths = await loadResolvedConfig(configPath, dir);
    const config = await loadCoreConfig(new NodeFileSystem(), configPath, dir);
    expect(paths).toEqual({
      configPath,
      stateDir: config.stateDir,
      socketPath: config.socketPath,
      sessionsDir: config.sessionsDir,
      worktreesDir: config.worktreesDir,
      enginePidPath: config.enginePidPath,
      engineLogPath: config.engineLogPath,
      repos: config.repos,
      me: config.me,
    });
  });

  it('rejects a missing file with the engine\'s own wording', async () => {
    const missing = path.join(dir, 'nope.json');
    await expect(loadResolvedConfig(missing, dir)).rejects.toThrow(`No config file found at '${missing}'`);
  });

  it('rejects an invalid file with the ConfigError text', async () => {
    const configPath = path.join(dir, 'core.json');
    await writeFile(configPath, JSON.stringify({ repos: ['acme/app'] }), { mode: 0o600 });
    await expect(loadResolvedConfig(configPath, dir)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadResolvedConfig(configPath, dir)).rejects.toThrow(/failed validation/);
  });

  it('goes through loadCoreConfig, not resolveCoreConfig: a 0644 file with a secret still demands chmod 600', async () => {
    const configPath = path.join(dir, 'core.json');
    await writeFile(
      configPath,
      JSON.stringify({
        me: 'octocat',
        repos: ['acme/app'],
        stateDir: dir,
        environments: { 'acme/app': { vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: 'shh' } } },
      }),
    );
    await chmod(configPath, 0o644);
    await expect(loadResolvedConfig(configPath, dir)).rejects.toThrow(`chmod 600 '${configPath}'`);
  });
});
