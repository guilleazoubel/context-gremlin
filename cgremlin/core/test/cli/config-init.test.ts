import { describe, expect, it } from 'vitest';
import { configCommand } from '../../src/cli/commands/config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { CommandIO } from '../../src/cli/command-io';
import { loadCoreConfig } from '../../src/config/core-config';
import { GhCommandError, type GhRunner } from '../../src/gh/gh-runner';

const HOME = '/home/e2e';
const TARGET = `${HOME}/.cgremlin-core/core.json`;

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

class RecordingGh implements GhRunner {
  readonly calls: string[][] = [];
  constructor(private readonly reply: { stdout: string } | Error) {}
  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push(args);
    if (this.reply instanceof Error) throw this.reply;
    return { stdout: this.reply.stdout, stderr: '' };
  }
}

function testIo(fs: InMemoryFileSystem, gh?: GhRunner) {
  const stdout = makeWriter();
  const stderr = makeWriter();
  return {
    io: { stdout, stderr, home: HOME, fs, ...(gh ? { gh } : {}) } as CommandIO,
    out: stdout.text,
    err: stderr.text,
  };
}

describe('config init', () => {
  it('writes a 0600 core.json with repos: [], no derived path keys, that loadCoreConfig accepts', async () => {
    const fs = new InMemoryFileSystem();
    const { io, out } = testIo(fs);
    expect(await configCommand(['init', '--me', 'octocat'], io)).toBe(0);
    expect(out()).toContain(TARGET);

    expect(await fs.statMode(TARGET)).toBe(0o600);
    const raw = JSON.parse(await fs.readFile(TARGET)) as Record<string, unknown>;
    expect(raw.me).toBe('octocat');
    expect(raw.repos).toEqual([]);
    expect(raw.runner).toBe('claude-code');
    for (const key of ['sessionsDir', 'worktreesDir', 'mirrorsDir', 'socketPath', 'inventoryPath', 'localAppStatePath', 'attentionAcksPath', 'enginePidPath', 'engineLogPath']) {
      expect(raw[key]).toBeUndefined();
    }
    const loaded = await loadCoreConfig(fs, TARGET, HOME);
    expect(loaded.me).toBe('octocat');
    expect(loaded.repos).toEqual([]);
    expect(loaded.socketPath).toBe(`${HOME}/.cgremlin-core/engine.sock`);
  });

  it('honours --config, writing the template where the flag points', async () => {
    const fs = new InMemoryFileSystem();
    const { io } = testIo(fs);
    expect(await configCommand(['init', '--me', 'octocat'], { ...io, configPath: '/elsewhere/core.json' })).toBe(0);
    expect(await fs.exists('/elsewhere/core.json')).toBe(true);
  });

  it('resolves me from `gh api user --jq .login` when --me is absent', async () => {
    const fs = new InMemoryFileSystem();
    const gh = new RecordingGh({ stdout: 'octocat\n' });
    const { io } = testIo(fs, gh);
    expect(await configCommand(['init'], io)).toBe(0);
    expect(gh.calls).toEqual([['api', 'user', '--jq', '.login']]);
    expect((await loadCoreConfig(fs, TARGET, HOME)).me).toBe('octocat');
  });

  it('exits 2 naming --me when there is no --me and no gh to ask', async () => {
    const fs = new InMemoryFileSystem();
    const { io, err } = testIo(fs);
    expect(await configCommand(['init'], io)).toBe(2);
    expect(err()).toContain('--me');
    expect(await fs.exists(TARGET)).toBe(false);
  });

  it('exits 2 naming --me when gh cannot answer, and never invents a login', async () => {
    const fs = new InMemoryFileSystem();
    const gh = new RecordingGh(new GhCommandError(['api', 'user'], 1, 'not logged in'));
    const { io, err } = testIo(fs, gh);
    expect(await configCommand(['init'], io)).toBe(2);
    expect(err()).toContain('--me');
    expect(await fs.exists(TARGET)).toBe(false);
  });

  it('refuses to overwrite an existing file, leaving its bytes untouched, and overwrites with --force', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin-core`, { recursive: true });
    await fs.writeFile(TARGET, '{"me":"someone-else","repos":["acme/app"]}');
    const before = await fs.readFile(TARGET);

    const first = testIo(fs);
    expect(await configCommand(['init', '--me', 'octocat'], first.io)).toBe(1);
    expect(first.err()).toContain('already exists');
    expect(await fs.readFile(TARGET)).toBe(before);

    const second = testIo(fs);
    expect(await configCommand(['init', '--me', 'octocat', '--force'], second.io)).toBe(0);
    expect((await loadCoreConfig(fs, TARGET, HOME)).me).toBe('octocat');
  });

  it('still exits 2 with the unknown-subcommand message for anything else', async () => {
    const fs = new InMemoryFileSystem();
    const { io, err } = testIo(fs);
    expect(await configCommand(['nonsense'], io)).toBe(2);
    expect(err()).toContain('Unknown config subcommand: nonsense');
  });

  it('config import-legacy still reads ~/.cgremlin/config and writes under .cgremlin-core', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
    await fs.writeFile(`${HOME}/.cgremlin/config`, 'WATCH_REPOS="acme/app"\nGITHUB_ME="me-user"\n');
    const { io, out } = testIo(fs);
    expect(await configCommand(['import-legacy'], io)).toBe(0);
    expect(out()).toContain(TARGET);
    expect((await loadCoreConfig(fs, TARGET, HOME)).me).toBe('me-user');
  });
});
