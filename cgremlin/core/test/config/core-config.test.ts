import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_MODE,
  hasAnySecret,
  importLegacyConfig,
  loadCoreConfig,
  redactBypassUrls,
  redactCoreConfig,
  RepoEnvironmentSchema,
  resolveCoreConfig,
  writeCoreConfig,
} from '../../src/config/core-config';
import { ConfigError } from '../../src/discovery/discovery-config';
import { NodeFileSystem } from '../../src/fs/node-file-system';
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

  it('expands a leading ~ in every explicit path field, not just stateDir', () => {
    const cfg = resolveCoreConfig(
      {
        repos: ['acme/app'],
        me: 'me',
        sessionsDir: '~/custom-sessions',
        worktreesDir: '~/custom-worktrees',
        mirrorsDir: '~/custom-mirrors',
        socketPath: '~/custom.sock',
        inventoryPath: '~/custom-inventory.json',
      },
      HOME,
    );
    expect(cfg.sessionsDir).toBe(`${HOME}/custom-sessions`);
    expect(cfg.worktreesDir).toBe(`${HOME}/custom-worktrees`);
    expect(cfg.mirrorsDir).toBe(`${HOME}/custom-mirrors`);
    expect(cfg.socketPath).toBe(`${HOME}/custom.sock`);
    expect(cfg.inventoryPath).toBe(`${HOME}/custom-inventory.json`);
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
    const { environments, ...rest } = importLegacyConfig(LEGACY_TEXT);
    expect(rest).toEqual({
      repos: ['aplaceformom/grace-frontend', 'aplaceformom/grace'],
      watchAuthors: ['a', 'b', 'guilleazoubel'],
      me: 'guilleazoubel',
      runnerOptions: { model: 'opus' },
    });
    expect(Object.keys(environments)).toEqual(['aplaceformom/grace-frontend']);
  });

  it('imports with an empty runnerOptions when REVIEW_MODEL is absent', () => {
    const text = 'WATCH_REPOS="a/b"\nGITHUB_ME="me"\n';
    const { environments, ...rest } = importLegacyConfig(text);
    expect(rest).toEqual({
      repos: ['a/b'],
      watchAuthors: [],
      me: 'me',
      runnerOptions: {},
    });
    expect(Object.keys(environments)).toEqual(['a/b']);
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

  it('persists only stateDir and explicit overrides, never the derived paths', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const raw = JSON.parse(await fs.readFile('/state/core.json')) as Record<string, unknown>;
    expect(raw.sessionsDir).toBeUndefined();
    expect(raw.worktreesDir).toBeUndefined();
    expect(raw.mirrorsDir).toBeUndefined();
    expect(raw.socketPath).toBeUndefined();
    expect(raw.inventoryPath).toBeUndefined();
    expect(raw.stateDir).toBe(cfg.stateDir);
  });

  it('keeps an explicit derived-path override when persisting', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me', sessionsDir: '/custom/sessions' }, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const raw = JSON.parse(await fs.readFile('/state/core.json')) as Record<string, unknown>;
    expect(raw.sessionsDir).toBe('/custom/sessions');
  });

  it('writes via tmp+rename rather than directly to the target path', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    const originalRename = fs.rename.bind(fs);
    let renamedFrom: string | undefined;
    fs.rename = async (from, to) => {
      renamedFrom = from;
      return originalRename(from, to);
    };
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    expect(renamedFrom).toMatch(/\.tmp$/);
    expect(await fs.exists('/state/core.json')).toBe(true);
  });
});

describe('environments schema', () => {
  const BASE = { repos: ['acme/app'], me: 'me' };

  it('defaults environments to {} when the key is absent, leaving every other field unchanged', () => {
    const cfg = resolveCoreConfig(BASE, HOME);
    expect(cfg.environments).toEqual({});
  });

  it('a core.json with no environments key loads with environments === {} and is otherwise identical', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', JSON.stringify({ repos: ['acme/app'], me: 'me' }));
    const loaded = await loadCoreConfig(fs, '/state/core.json', HOME);
    expect(loaded.environments).toEqual({});
    expect(loaded.repos).toEqual(['acme/app']);
    expect(loaded.me).toBe('me');
    expect(loaded.runner).toBe('claude-code');
    expect(loaded.pollIntervalMs).toBe(60_000);
    expect(loaded.sessionsDir).toBe(`${HOME}/.cgremlin/sessions`);
    expect(loaded.inventoryPath).toBe(`${HOME}/.cgremlin/inventory.json`);
  });

  it('applies every RepoEnvironment default', () => {
    const env = RepoEnvironmentSchema.parse({
      localApp: { url: 'https://local.example.com' },
      vercel: { scope: 's', project: 'p', previewProject: 'p' },
      clerk: {},
    });
    expect(env.previewStages).toEqual(['review', 'rereview']);
    expect(env.localApp?.stages).toEqual(['develop']);
    expect(env.localApp?.port).toBe(8080);
    expect(env.localApp?.devCommand).toBe('pnpm dev');
    expect(env.localApp?.installCommand).toBe('pnpm install');
    expect(env.localApp?.healthTimeoutMs).toBe(90_000);
    expect(env.localApp?.healthIntervalMs).toBe(2_000);
    expect(env.localApp?.insecureTls).toBe(true);
    expect(env.localApp?.postInstallNonEmptyDirs).toEqual([]);
    expect(env.localApp?.prereqs).toEqual({ hostsEntries: [], requiredFiles: [], requiredEnv: [] });
    expect(env.vercel?.envFile).toBe('.env.local');
    expect(env.clerk?.testEmailTemplate).toBe('uicheck-{key}+clerk_test@example.com');
    expect(env.clerk?.verificationCode).toBe('424242');
  });

  it('rejects an environments key that is not an owner/name slug', () => {
    expect(() =>
      resolveCoreConfig({ ...BASE, environments: { 'not-a-slug': { previewStages: [] } } }, HOME),
    ).toThrow();
  });

  it('rejects a localApp.url that is not a URL', () => {
    expect(() =>
      resolveCoreConfig({ ...BASE, environments: { 'acme/app': { localApp: { url: 'not a url' } } } }, HOME),
    ).toThrow();
  });

  it('rejects localApp.port 0 and 70000', () => {
    const withPort = (port: number) => ({
      ...BASE,
      environments: { 'acme/app': { localApp: { url: 'https://x.example.com', port } } },
    });
    expect(() => resolveCoreConfig(withPort(0), HOME)).toThrow();
    expect(() => resolveCoreConfig(withPort(70_000), HOME)).toThrow();
  });

  it('derives localAppStatePath under stateDir and omits it when persisting the default', async () => {
    const cfg = resolveCoreConfig(BASE, HOME);
    expect(cfg.localAppStatePath).toBe(`${HOME}/.cgremlin/local-app.json`);
    const fs = new InMemoryFileSystem();
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const raw = JSON.parse(await fs.readFile('/state/core.json')) as Record<string, unknown>;
    expect(raw.localAppStatePath).toBeUndefined();
  });

  it('keeps and expands an explicit localAppStatePath override', async () => {
    const cfg = resolveCoreConfig({ ...BASE, localAppStatePath: '~/custom-local-app.json' }, HOME);
    expect(cfg.localAppStatePath).toBe(`${HOME}/custom-local-app.json`);
    const fs = new InMemoryFileSystem();
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const raw = JSON.parse(await fs.readFile('/state/core.json')) as Record<string, unknown>;
    expect(raw.localAppStatePath).toBe(`${HOME}/custom-local-app.json`);
  });
});

const SECRET_CONFIG_INPUT = {
  repos: ['acme/app'],
  me: 'me',
  environments: {
    'acme/app': {
      localApp: { url: 'https://local.example.com' },
      vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: 'super-secret' },
    },
  },
};

describe('MG-8 config-file-is-0600', () => {
  it('writeCoreConfig writes a config holding a bypassSecret at mode 0600', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig(SECRET_CONFIG_INPUT, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    expect(await fs.statMode('/state/core.json')).toBe(CONFIG_FILE_MODE);
    expect(CONFIG_FILE_MODE).toBe(0o600);
  });

  it('a 0600 config holding a secret round-trips through loadCoreConfig', async () => {
    const fs = new InMemoryFileSystem();
    const cfg = resolveCoreConfig(SECRET_CONFIG_INPUT, HOME);
    await writeCoreConfig(fs, '/state/core.json', cfg, { force: false });
    const loaded = await loadCoreConfig(fs, '/state/core.json', HOME);
    expect(loaded.environments['acme/app'].vercel?.bypassSecret).toBe('super-secret');
  });

  it('loadCoreConfig throws ConfigError naming the path for a 0644 file holding a secret', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', JSON.stringify(SECRET_CONFIG_INPUT), { mode: 0o644 });
    await expect(loadCoreConfig(fs, '/state/core.json', HOME)).rejects.toThrow(ConfigError);
    await expect(loadCoreConfig(fs, '/state/core.json', HOME)).rejects.toThrow('/state/core.json');
    await expect(loadCoreConfig(fs, '/state/core.json', HOME)).rejects.toThrow('chmod 600');
  });

  it('loads the same 0644 file fine when it holds no secret', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    const noSecret = {
      ...SECRET_CONFIG_INPUT,
      environments: { 'acme/app': { vercel: { scope: 's', project: 'p', previewProject: 'p' } } },
    };
    await fs.writeFile('/state/core.json', JSON.stringify(noSecret), { mode: 0o644 });
    const loaded = await loadCoreConfig(fs, '/state/core.json', HOME);
    expect(loaded.environments['acme/app'].vercel?.bypassSecret).toBeUndefined();
  });

  it('hasAnySecret is true only when some environment carries a bypassSecret', () => {
    expect(hasAnySecret(resolveCoreConfig(SECRET_CONFIG_INPUT, HOME))).toBe(true);
    expect(hasAnySecret(resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME))).toBe(false);
  });
});

describe('MG-8 config-file-is-0600 (real filesystem)', () => {
  let dir: string;
  let fsys: NodeFileSystem;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-config-test-'));
    fsys = new NodeFileSystem();
    configPath = path.join(dir, 'core.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writeCoreConfig writes a config holding a bypassSecret at real mode 0600 and it round-trips through loadCoreConfig', async () => {
    const cfg = resolveCoreConfig(SECRET_CONFIG_INPUT, HOME);
    await writeCoreConfig(fsys, configPath, cfg, { force: false });
    expect(await fsys.statMode(configPath)).toBe(0o600);
    const loaded = await loadCoreConfig(fsys, configPath, HOME);
    expect(loaded.environments['acme/app'].vercel?.bypassSecret).toBe('super-secret');
  });

  it('overwriting an existing 0644 file via writeCoreConfig with force ends at real mode 0600', async () => {
    const cfg = resolveCoreConfig(SECRET_CONFIG_INPUT, HOME);
    await fsys.mkdir(dir, { recursive: true });
    await fsys.writeFile(configPath, JSON.stringify({ repos: ['acme/app'], me: 'me' }), { mode: 0o644 });
    expect(await fsys.statMode(configPath)).toBe(0o644);
    await writeCoreConfig(fsys, configPath, cfg, { force: true });
    expect(await fsys.statMode(configPath)).toBe(0o600);
  });

  it('loadCoreConfig rejects a real 0644 file holding a secret with a ConfigError naming the path', async () => {
    await fsys.mkdir(dir, { recursive: true });
    await fsys.writeFile(configPath, JSON.stringify(SECRET_CONFIG_INPUT), { mode: 0o644 });
    await expect(loadCoreConfig(fsys, configPath, HOME)).rejects.toThrow(ConfigError);
    await expect(loadCoreConfig(fsys, configPath, HOME)).rejects.toThrow(configPath);
  });
});

describe('redactCoreConfig', () => {
  it('replaces every bypassSecret with [redacted]', () => {
    const cfg = resolveCoreConfig(
      {
        repos: ['acme/app', 'acme/two'],
        me: 'me',
        environments: {
          'acme/app': { vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: 'a1' } },
          'acme/two': { vercel: { scope: 's', project: 'q', previewProject: 'q', bypassSecret: 'b2' } },
        },
      },
      HOME,
    );
    const redacted = redactCoreConfig(cfg);
    expect(redacted.environments['acme/app'].vercel?.bypassSecret).toBe('[redacted]');
    expect(redacted.environments['acme/two'].vercel?.bypassSecret).toBe('[redacted]');
    expect(JSON.stringify(redacted)).not.toContain('a1');
    expect(JSON.stringify(redacted)).not.toContain('b2');
  });

  it('deep-clones, so mutating the result never touches the input', () => {
    const cfg = resolveCoreConfig(SECRET_CONFIG_INPUT, HOME);
    const redacted = redactCoreConfig(cfg);
    expect(cfg.environments['acme/app'].vercel?.bypassSecret).toBe('super-secret');
    redacted.repos.push('acme/injected');
    redacted.environments['acme/app'].localApp!.port = 1;
    expect(cfg.repos).toEqual(['acme/app']);
    expect(cfg.environments['acme/app'].localApp?.port).toBe(8080);
  });

  it('leaves a config with no secrets structurally equal', () => {
    const cfg = resolveCoreConfig({ repos: ['acme/app'], me: 'me' }, HOME);
    expect(redactCoreConfig(cfg)).toEqual(cfg);
  });
});

describe('redactBypassUrls', () => {
  it('replaces the secret value while leaving the trailing param intact', () => {
    expect(
      redactBypassUrls('https://h/?x-vercel-protection-bypass=abc123&x-vercel-set-bypass-cookie=true'),
    ).toBe('https://h/?x-vercel-protection-bypass=<redacted>&x-vercel-set-bypass-cookie=true');
  });

  it('replaces every occurrence in a multi-line chunk', () => {
    const text = 'one https://a/?x-vercel-protection-bypass=s1\ntwo https://b/?x-vercel-protection-bypass=s2\n';
    const out = redactBypassUrls(text);
    expect(out).toBe(
      'one https://a/?x-vercel-protection-bypass=<redacted>\ntwo https://b/?x-vercel-protection-bypass=<redacted>\n',
    );
    expect(out).not.toContain('s1');
    expect(out).not.toContain('s2');
  });

  it('stops at whitespace', () => {
    expect(redactBypassUrls('x-vercel-protection-bypass=abc def')).toBe(
      'x-vercel-protection-bypass=<redacted> def',
    );
  });

  it('W1 redacts the curl request-header form', () => {
    expect(redactBypassUrls('curl -H "x-vercel-protection-bypass: SENTINEL" https://h/')).toBe(
      'curl -H "x-vercel-protection-bypass: <redacted>" https://h/',
    );
  });

  it('W1 redacts the JSON header form', () => {
    const out = redactBypassUrls('{"headers":{"x-vercel-protection-bypass":"SENTINEL"}}');
    expect(out).toBe('{"headers":{"x-vercel-protection-bypass":"<redacted>"}}');
    expect(out).not.toContain('SENTINEL');
  });

  it('W1 redacts the header form with no space after the colon and an unquoted value', () => {
    expect(redactBypassUrls('x-vercel-protection-bypass:SENTINEL\n')).toBe(
      'x-vercel-protection-bypass:<redacted>\n',
    );
  });

  it('W1 redaction is idempotent across all three forms', () => {
    const text =
      'https://h/?x-vercel-protection-bypass=S\ncurl -H "x-vercel-protection-bypass: S"\n{"x-vercel-protection-bypass":"S"}\n';
    const once = redactBypassUrls(text);
    expect(redactBypassUrls(once)).toBe(once);
    expect(once).not.toMatch(/bypass["']?\s*[:=]\s*["']?S\b/);
  });

  it('leaves text with no match byte-identical', () => {
    const text = 'nothing to see here\nhttps://example.com/?q=1\n';
    expect(redactBypassUrls(text)).toBe(text);
  });
});

describe('importLegacyConfig environments', () => {
  it('attaches the legacy local/vercel settings to the first WATCH_REPOS slug with all legacy defaults', () => {
    const text =
      'WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"\n' +
      'GITHUB_ME="guilleazoubel"\n' +
      'VERCEL_AUTOMATION_BYPASS_SECRET="abc"\n';
    const imported = importLegacyConfig(text);
    expect(Object.keys(imported.environments)).toEqual(['aplaceformom/grace-frontend']);
    const env = imported.environments['aplaceformom/grace-frontend'];
    expect(env.vercel).toEqual({
      scope: 'grace-0118bc61',
      project: 'grace-frontend-dev',
      previewProject: 'grace-frontend-dev',
      envFile: '.env.local',
      bypassSecret: 'abc',
    });
    expect(env.localApp?.url).toBe('https://local.findcare.dev.aplaceformom.com');
    expect(env.localApp?.port).toBe(8080);
    expect(env.localApp?.devCommand).toBe('pnpm dev');
    expect(env.localApp?.nodeVersion).toBe('24');
    expect(env.localApp?.postInstallNonEmptyDirs).toEqual([]);
    expect(env.localApp?.stages).toEqual(['develop']);
    expect(env.localApp?.prereqs).toEqual({
      hostsEntries: ['local.findcare.dev.aplaceformom.com'],
      requiredFiles: ['/Library/LaunchDaemons/com.grace.portforward.plist', '~/.nvm/nvm.sh'],
      requiredEnv: ['NODE_AUTH_TOKEN'],
    });
    expect(imported.environments['aplaceformom/grace']).toBeUndefined();
  });

  it('honours explicit legacy overrides over the defaults', () => {
    const text =
      'WATCH_REPOS="a/b"\n' +
      'GITHUB_ME="me"\n' +
      'LOCAL_URL="https://other.example.com"\n' +
      'LOCAL_PORT="9090"\n' +
      'LOCAL_DEV_CMD="pnpm start"\n' +
      'LOCAL_NODE_VERSION="22"\n' +
      'VERCEL_SCOPE="scope-x"\n' +
      'VERCEL_PROJECT="proj-x"\n';
    const env = importLegacyConfig(text).environments['a/b'];
    expect(env.localApp?.url).toBe('https://other.example.com');
    expect(env.localApp?.port).toBe(9090);
    expect(env.localApp?.devCommand).toBe('pnpm start');
    expect(env.localApp?.nodeVersion).toBe('22');
    expect(env.vercel).toMatchObject({ scope: 'scope-x', project: 'proj-x', previewProject: 'proj-x' });
    expect(env.vercel?.bypassSecret).toBeUndefined();
  });

  it('still rejects a legacy config with no WATCH_REPOS (unchanged behaviour)', () => {
    expect(() => importLegacyConfig('GITHUB_ME="me"\n')).toThrow(ConfigError);
  });
});
