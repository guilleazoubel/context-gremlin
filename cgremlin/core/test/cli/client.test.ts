import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../../src/cli/client';

let dir: string;
let socketPath: string;
let server: http.Server;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-cli-client-'));
  socketPath = path.join(dir, 'x.sock');
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/echo') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(raw);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('request', () => {
  it('performs a GET and parses the JSON response', async () => {
    const res = await request(socketPath, 'GET', '/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('sends a JSON body on POST and the server echoes it back', async () => {
    const res = await request(socketPath, 'POST', '/echo', { a: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ a: 1 });
  });

  it('returns a non-2xx status with its parsed error body', async () => {
    const res = await request(socketPath, 'GET', '/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});
