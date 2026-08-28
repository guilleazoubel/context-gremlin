import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { testFileSystemContract } from '../support/file-system-contract';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-fs-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

testFileSystemContract(
  'NodeFileSystem',
  () => new NodeFileSystem(),
  (...segments) => path.join(dir, ...segments),
);
