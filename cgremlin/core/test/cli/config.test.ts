import { describe, expect, it } from 'vitest';
import { configCommand } from '../../src/cli/commands/config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { CommandIO } from '../../src/cli/command-io';
import { loadCoreConfig } from '../../src/config/core-config';

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
    expect(out()).toContain(`${HOME}/.cgremlin/core.json`);

    const written = await loadCoreConfig(fs, `${HOME}/.cgremlin/core.json`, HOME);
    expect(written.repos).toEqual(['acme/app', 'acme/other']);
    expect(written.watchAuthors).toEqual(['bob', 'carol']);
    expect(written.me).toBe('me-user');
    expect(written.runnerOptions.model).toBe('opus');
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
