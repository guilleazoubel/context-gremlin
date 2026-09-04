import { describe, expect, it } from 'vitest';
import { main, USAGE } from '../../src/cli/main';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { CommandIO } from '../../src/cli/command-io';
import { resolveCoreConfig, writeCoreConfig } from '../../src/config/core-config';

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

function testIo(): { io: CommandIO; out: () => string; err: () => string } {
  const stdout = makeWriter();
  const stderr = makeWriter();
  return { io: { stdout, stderr, home: '/home/e2e', fs: new InMemoryFileSystem() }, out: stdout.text, err: stderr.text };
}

describe('main', () => {
  it('an unknown command prints usage to stderr and exits 2', async () => {
    const { io, err } = testIo();
    const code = await main(['bogus'], io);
    expect(code).toBe(2);
    expect(err()).toBe(USAGE);
  });

  it('no command at all prints usage to stderr and exits 2', async () => {
    const { io, err } = testIo();
    const code = await main([], io);
    expect(code).toBe(2);
    expect(err()).toBe(USAGE);
  });

  it('--help prints usage to stdout and exits 0', async () => {
    const { io, out } = testIo();
    const code = await main(['--help'], io);
    expect(code).toBe(0);
    expect(out()).toBe(USAGE);
  });

  it('--config <path> is parsed and used to locate core.json for any command', async () => {
    const { io, err } = testIo();
    const config = resolveCoreConfig(
      { repos: ['acme/app'], me: 'me', socketPath: '/tmp/does-not-exist-cgremlin-core-main-test.sock' },
      io.home,
    );
    await writeCoreConfig(io.fs, '/tmp/other.json', config, { force: true });

    const code = await main(['prs', '--config', '/tmp/other.json'], io);
    // Nothing is listening on the socket, so if --config were NOT honored
    // (falling back to the default, nonexistent core.json), the error would
    // be "No config file found" instead — this proves the file at the
    // --config path was actually located and loaded.
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
  });

  it('--config=<path> (equals form) is also parsed', async () => {
    const { io, err } = testIo();
    const config = resolveCoreConfig(
      { repos: ['acme/app'], me: 'me', socketPath: '/tmp/does-not-exist-cgremlin-core-main-test.sock' },
      io.home,
    );
    await writeCoreConfig(io.fs, '/tmp/other.json', config, { force: true });

    const code = await main(['prs', '--config=/tmp/other.json'], io);
    expect(code).toBe(1);
    expect(err()).toContain('engine is not running');
  });
});
