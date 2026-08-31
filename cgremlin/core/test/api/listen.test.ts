import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { listenOnSocket } from '../../src/api/listen';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-listen-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listenOnSocket', () => {
  it('listens on a fresh socket path', async () => {
    const socketPath = path.join(dir, 'fresh.sock');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSocket(server, socketPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('removes a stale socket file left over from an unclean shutdown before listening', async () => {
    const socketPath = path.join(dir, 'stale.sock');
    await writeFile(socketPath, '');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSocket(server, socketPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
