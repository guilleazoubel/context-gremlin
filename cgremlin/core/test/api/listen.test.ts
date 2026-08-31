import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listenOnSocket, SocketInUseError } from '../../src/api/listen';

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

  it('restricts the socket file permissions to 0o600 after listening', async () => {
    const socketPath = path.join(dir, 'perms.sock');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSocket(server, socketPath);
    const stats = await stat(socketPath);
    expect(stats.mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('throws SocketInUseError instead of hijacking a socket a live server is already using', async () => {
    const socketPath = path.join(dir, 'live.sock');
    const serverA = http.createServer((_req, res) => res.end('a'));
    await listenOnSocket(serverA, socketPath);

    const serverB = http.createServer((_req, res) => res.end('b'));
    await expect(listenOnSocket(serverB, socketPath)).rejects.toThrow(SocketInUseError);

    await new Promise<void>((resolve) => serverA.close(() => resolve()));
  });
});
