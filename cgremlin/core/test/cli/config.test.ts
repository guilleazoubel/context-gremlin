import { describe, expect, it } from 'vitest';
import { configCommand } from '../../src/cli/commands/config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { CommandIO } from '../../src/cli/command-io';
import { loadCoreConfig } from '../../src/config/core-config';
import { JiraAuthError } from '../../src/jira/jira-source';

const HOME = '/home/e2e';
const LEGACY_TEXT =
  'WATCH_REPOS="acme/app acme/other"\n' + 'WATCH_AUTHORS="bob carol"\n' + 'GITHUB_ME="me-user"\n' + 'REVIEW_MODEL="opus"\n';

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

function testIo(fs: InMemoryFileSystem): { io: CommandIO; out: () => string; err: () => string } {
  const stdout = makeWriter();
  const stderr = makeWriter();
  return { io: { stdout, stderr, home: HOME, fs }, out: stdout.text, err: stderr.text };
}

describe('config import-legacy command', () => {
  it('imports the legacy config and writes core.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, LEGACY_TEXT);

    const { io, out } = testIo(fs);
    const code = await configCommand(['import-legacy'], io);
    expect(code).toBe(0);
    expect(out()).toContain(`${HOME}/.cgremlin-core/core.json`);

    const written = await loadCoreConfig(fs, `${HOME}/.cgremlin-core/core.json`, HOME);
    expect(written.repos).toEqual(['acme/app', 'acme/other']);
    expect(written.watchAuthors).toEqual(['bob', 'carol']);
    expect(written.me).toBe('me-user');
    expect(written.runnerOptions.model).toBe('opus');
    expect(Object.keys(written.environments)).toEqual(['acme/app']);
  });

  it('reports which repo the legacy environment settings were attached to', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, LEGACY_TEXT);

    const { io, out } = testIo(fs);
    expect(await configCommand(['import-legacy'], io)).toBe(0);
    expect(out()).toContain('acme/app');
    expect(out()).toContain('environment settings');
  });

  it('writes core.json at mode 0600', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, `${LEGACY_TEXT}VERCEL_AUTOMATION_BYPASS_SECRET="shh"\n`);

    const { io } = testIo(fs);
    expect(await configCommand(['import-legacy'], io)).toBe(0);
    expect(await fs.statMode(`${HOME}/.cgremlin-core/core.json`)).toBe(0o600);
  });

  it('refuses to overwrite an existing core.json without --force', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, LEGACY_TEXT);
    await configCommand(['import-legacy'], testIo(fs).io);

    const { io, err } = testIo(fs);
    const code = await configCommand(['import-legacy'], io);
    expect(code).toBe(1);
    expect(err()).toContain('already exists');
  });

  it('overwrites with --force', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, LEGACY_TEXT);
    await configCommand(['import-legacy'], testIo(fs).io);

    const { io, out } = testIo(fs);
    const code = await configCommand(['import-legacy', '--force'], io);
    expect(code).toBe(0);
    expect(out()).toContain('core.json');
  });

  it('exits 1 with a clear message when the legacy config is missing', async () => {
    const fs = new InMemoryFileSystem();
    const { io, err } = testIo(fs);
    const code = await configCommand(['import-legacy'], io);
    expect(code).toBe(1);
    expect(err()).toContain('Cannot read legacy config');
  });

  it('exits 2 for an unknown subcommand', async () => {
    const fs = new InMemoryFileSystem();
    const { io, err } = testIo(fs);
    const code = await configCommand(['bogus'], io);
    expect(code).toBe(2);
    expect(err()).toContain('Unknown config subcommand');
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A4 — `cgremlin-core config check-jira`.
// ---------------------------------------------------------------------------

const JIRA_CONFIG = {
  me: 'me-user',
  repos: ['acme/app'],
  jira: {
    siteUrl: 'https://aplaceformom.atlassian.net',
    email: 'guilherme.azoubel@aplaceformom.com',
    apiToken: 'atl-secret-token',
  },
};

async function writeConfig(fs: InMemoryFileSystem, raw: unknown): Promise<void> {
  await fs.mkdir(`${HOME}/.cgremlin-core`, { recursive: true });
  await fs.writeFile(`${HOME}/.cgremlin-core/core.json`, JSON.stringify(raw), { mode: 0o600 });
}

describe('config check-jira', () => {
  it('prints the display name and accountId on success and exits 0', async () => {
    const fs = new InMemoryFileSystem();
    await writeConfig(fs, JIRA_CONFIG);
    const { io, out } = testIo(fs);
    const code = await configCommand(['check-jira'], io, {
      makeJiraSource: () => ({
        search: async () => [],
        issue: async () => {
          throw new Error('unused');
        },
        whoami: async () => ({ accountId: '712020:abc', displayName: 'Guilherme Azoubel' }),
      }),
    });
    expect(code).toBe(0);
    expect(out()).toContain('Guilherme Azoubel');
    expect(out()).toContain('712020:abc');
  });

  it("prints Jira's own wording and exits 1 on an auth failure", async () => {
    const fs = new InMemoryFileSystem();
    await writeConfig(fs, JIRA_CONFIG);
    const { io, err } = testIo(fs);
    const code = await configCommand(['check-jira'], io, {
      makeJiraSource: () => ({
        search: async () => [],
        issue: async () => {
          throw new Error('unused');
        },
        whoami: async () => {
          throw new JiraAuthError('Client must be authenticated to access this resource.', 401);
        },
      }),
    });
    expect(code).toBe(1);
    expect(err()).toContain('Client must be authenticated to access this resource.');
  });

  it('says "no jira configured" and exits 0 when there is no jira block, without building a source', async () => {
    const fs = new InMemoryFileSystem();
    await writeConfig(fs, { me: 'me-user', repos: ['acme/app'] });
    const { io, out } = testIo(fs);
    let built = 0;
    const code = await configCommand(['check-jira'], io, {
      makeJiraSource: () => {
        built += 1;
        throw new Error('should not be built');
      },
    });
    expect(code).toBe(0);
    expect(out()).toContain('no jira configured');
    expect(built).toBe(0);
  });

  it('treats a jira block with no apiToken as not configured', async () => {
    const fs = new InMemoryFileSystem();
    await writeConfig(fs, { ...JIRA_CONFIG, jira: { ...JIRA_CONFIG.jira, apiToken: undefined } });
    const { io, out } = testIo(fs);
    const code = await configCommand(['check-jira'], io, {
      makeJiraSource: () => {
        throw new Error('should not be built');
      },
    });
    expect(code).toBe(0);
    expect(out()).toContain('no jira configured');
  });

  it('never prints the token', async () => {
    const fs = new InMemoryFileSystem();
    await writeConfig(fs, JIRA_CONFIG);
    const { io, out, err } = testIo(fs);
    await configCommand(['check-jira'], io, {
      makeJiraSource: () => ({
        search: async () => [],
        issue: async () => {
          throw new Error('unused');
        },
        whoami: async () => ({ accountId: '712020:abc', displayName: 'G' }),
      }),
    });
    expect(out() + err()).not.toContain('atl-secret-token');
  });
});
