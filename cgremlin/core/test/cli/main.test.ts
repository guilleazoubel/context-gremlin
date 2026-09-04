import { describe, expect, it } from 'vitest';
import { main, USAGE } from '../../src/cli/main';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { CommandIO } from '../../src/cli/command-io';

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
});
