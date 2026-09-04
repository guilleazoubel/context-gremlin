import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveCommand } from '../../src/cli/commands/serve';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { resolveCoreConfig, writeCoreConfig } from '../../src/config/core-config';
import { defaultConfigPath, type CommandIO } from '../../src/cli/command-io';

const HOME = '/home/cli-serve-test';

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-cli-serve-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function testIo(socketPath: string): Promise<{ io: CommandIO; out: () => string; err: () => string }> {
  // serveCommand always uses realAdapters (a real NodeFileSystem for the
  // engine itself), so every path here must be real and writable — only
  // the *config file's own* fs (io.fs, used solely to load core.json) is faked.
  const fs = new InMemoryFileSystem();
  const config = resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      socketPath,
      sessionsDir: path.join(dir, 'sessions'),
      worktreesDir: path.join(dir, 'worktrees'),
      mirrorsDir: path.join(dir, 'mirrors'),
      inventoryPath: path.join(dir, 'inventory.json'),
    },
    HOME,
  );
  await writeCoreConfig(fs, defaultConfigPath(HOME), config, { force: true });
  const stdout = makeWriter();
  const stderr = makeWriter();
  return { io: { stdout, stderr, home: HOME, fs }, out: stdout.text, err: stderr.text };
}

describe('serve command', () => {
  it('exits 1 with a clear message when another process already owns the socket', async () => {
    const socketPath = path.join(dir, 'engine.sock');
    const blocker = http.createServer((_req, res) => res.end('x'));
    await new Promise<void>((resolve) => blocker.listen(socketPath, resolve));
    try {
      const { io, err } = await testIo(socketPath);
      const code = await serveCommand([], io);
      expect(code).toBe(1);
      expect(err()).toContain(socketPath);
      expect(err()).not.toMatch(/\n\s*at /);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('logs engine events to stderr, not stdout, and exits 0 on a clean signal-triggered shutdown', async () => {
    const socketPath = path.join(dir, 'engine.sock');
    const before = process.listenerCount('SIGINT');
    const { io, out, err } = await testIo(socketPath);

    const commandPromise = serveCommand([], io);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it start listening
    process.emit('SIGINT');
    const code = await commandPromise;

    expect(code).toBe(0);
    expect(out()).toBe('');
    expect(err().length).toBeGreaterThan(0);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
