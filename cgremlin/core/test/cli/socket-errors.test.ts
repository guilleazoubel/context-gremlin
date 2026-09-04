import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { resolveCoreConfig, writeCoreConfig } from '../../src/config/core-config';
import { defaultConfigPath, type CommandIO } from '../../src/cli/command-io';
import { prsCommand } from '../../src/cli/commands/prs';
import { reviewCommand } from '../../src/cli/commands/review';
import { sessionsCommand } from '../../src/cli/commands/sessions';
import { scanCommand } from '../../src/cli/commands/scan';

const HOME = '/home/no-host';

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

async function ioWithNoHost(): Promise<{ io: CommandIO; out: () => string; err: () => string }> {
  const fs = new InMemoryFileSystem();
  const config = resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', socketPath: '/tmp/does-not-exist-cgremlin-core-test.sock' },
    HOME,
  );
  await writeCoreConfig(fs, defaultConfigPath(HOME), config, { force: true });
  const stdout = makeWriter();
  const stderr = makeWriter();
  return { io: { stdout, stderr, home: HOME, fs }, out: stdout.text, err: stderr.text };
}

describe('socket connection failures (no engine listening)', () => {
  it('prs exits 1 with a friendly message and no stack trace', async () => {
    const { io, err } = await ioWithNoHost();
    const code = await prsCommand([], io);
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
    expect(err()).toContain('cgremlin-core serve');
    expect(err()).not.toMatch(/\n\s*at /);
  });

  it('review exits 1 with a friendly message and no stack trace', async () => {
    const { io, err } = await ioWithNoHost();
    const code = await reviewCommand(['https://github.com/acme/app/pull/1'], io);
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
    expect(err()).not.toMatch(/\n\s*at /);
  });

  it('sessions exits 1 with a friendly message and no stack trace', async () => {
    const { io, err } = await ioWithNoHost();
    const code = await sessionsCommand([], io);
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
    expect(err()).not.toMatch(/\n\s*at /);
  });

  it('scan exits 1 with a friendly message and no stack trace', async () => {
    const { io, err } = await ioWithNoHost();
    const code = await scanCommand([], io);
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
    expect(err()).not.toMatch(/\n\s*at /);
  });
});
