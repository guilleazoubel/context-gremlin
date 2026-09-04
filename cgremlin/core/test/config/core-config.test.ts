import { describe, expect, it } from 'vitest';
import {
  importLegacyConfig,
  loadCoreConfig,
  resolveCoreConfig,
  writeCoreConfig,
} from '../../src/config/core-config';
import { ConfigError } from '../../src/discovery/discovery-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const HOME = '/Users/e2e';

describe('resolveCoreConfig', () => {
  it('applies defaults and derives paths under stateDir', () => {
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    expect(cfg.watchAuthors).toEqual([]);
    expect(cfg.runner).toBe('claude-code');
    expect(cfg.runnerOptions).toEqual({});
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.prListLimit).toBe(50);
    expect(cfg.reviewSkillCommand).toBe('/APFM:apfm-review');
    expect(cfg.includeLiveUiCheck).toBe(true);
    expect(cfg.defaultBaseRef).toBe('origin/main');
    expect(cfg.stateDir).toBe(`${HOME}/.cgremlin`);
    expect(cfg.sessionsDir).toBe(`${HOME}/.cgremlin/sessions`);
    expect(cfg.worktreesDir).toBe(`${HOME}/.cgremlin/worktrees`);
    expect(cfg.mirrorsDir).toBe(`${HOME}/.cgremlin/mirrors`);
    expect(cfg.socketPath).toBe(`${HOME}/.cgremlin/engine.sock`);
    expect(cfg.inventoryPath).toBe(`${HOME}/.cgremlin/inventory.json`);
  });

  it('expands a leading ~ in stateDir against the given home', () => {
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me', stateDir: '~/custom-state' }, HOME);
    expect(cfg.stateDir).toBe(`${HOME}/custom-state`);
    expect(cfg.sessionsDir).toBe(`${HOME}/custom-state/sessions`);
  });

  it('keeps explicit derived-path overrides instead of deriving them from stateDir', () => {
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me', sessionsDir: '/custom/sessions' }, HOME);
    expect(cfg.sessionsDir).toBe('/custom/sessions');
    expect(cfg.worktreesDir).toBe(`${HOME}/.cgremlin/worktrees`);
  });

  it('rejects a repo slug without an owner/name shape', () => {
    expect(() => resolveCoreConfig({ repos: ['not-a-slug'], me: 'me' }, HOME)).toThrow();
  });
});

describe('importLegacyConfig', () => {
  const LEGACY_TEXT =
    'WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"\n' +
    'WATCH_AUTHORS="a b guilleazoubel"\n' +
    'GITHUB_ME="guilleazoubel"\n' +
    '# comment\n' +
    'REVIEW_MODEL="opus"';

  it('imports repos/watchAuthors/me and maps REVIEW_MODEL to runnerOptions.model', () => {
    expect(importLegacyConfig(LEGACY_TEXT)).toEqual({
      repos: ['aplaceformom/grace-frontend', 'aplaceformom/grace'],
      watchAuthors: ['a', 'b', 'guilleazoubel'],
      me: 'guilleazoubel',
      runnerOptions: { model: 'opus' },
    });
  });

  it('imports with an empty runnerOptions when REVIEW_MODEL is absent', () => {
    const text = 'WATCH_REPOS="a/b"\nGITHUB_ME="me"\n';
    expect(importLegacyConfig(text)).toEqual({
      repos: ['a/b'],
      watchAuthors: [],
      me: 'me',
      runnerOptions: {},
    });
  });
});

describe('writeCoreConfig / loadCoreConfig', () => {
  it('round-trips a written config through load', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const loaded = await loadCoreConfig(fs, '/state/core.json', HOME);
    expect(loaded).toEqual(cfg);
  });

  it('refuses to overwrite an existing config without force', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    await expect(writeCoreConfig(fs, '/state/core.json', cfg, { force: false })).rejects.toThrow(ConfigError);
  });

  it('overwrites an existing config with force', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const cfg2 = resolveCoreConfig({ repos: ['acme/app2'], me: 'me' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg2, { force: true });
    const loaded = await loadCoreConfig(fs, '/state/core.json', HOME);
    expect(loaded.repos).toEqual(['acme/app2']);
  });

  it('throws ConfigError naming the path when the file is missing', async () => {
    const fs = new InMemoryFileSystem();
    await expect(loadCoreConfig(fs, '/state/missing.json', HOME)).rejects.toThrow(ConfigError);
    await expect(loadCoreConfig(fs, '/state/missing.json', HOME)).rejects.toThrow('/state/missing.json');
  });

  it('throws ConfigError for invalid JSON on disk', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', '{not json');
    await expect(loadCoreConfig(fs, '/state/core.json', HOME)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for a schema-invalid config on disk', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', JSON.stringify({ repos: [], me: 'me' }));
    await expect(loadCoreConfig(fs, '/state/core.json', HOME)).rejects.toThrow(ConfigError);
  });
});
