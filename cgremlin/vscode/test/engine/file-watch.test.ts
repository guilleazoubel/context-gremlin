/**
 * The config watcher's foundation: a save that *replaces* the file must still be seen (spec 4.5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFileByRename } from '../../src/engine/file-watch';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('timed out waiting for a condition');
}

describe('watchFileByRename', () => {
  it('sees a save that replaces the file by rename, the way the engine writes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'core.json');
    fs.writeFileSync(target, '{}');

    let changes = 0;
    const handle = watchFileByRename(target, () => {
      changes += 1;
    });
    cleanups.push(() => handle.dispose());

    fs.writeFileSync(`${target}.tmp`, '{"me":"someone"}');
    fs.renameSync(`${target}.tmp`, target);
    await waitFor(() => changes > 0);
    expect(changes).toBeGreaterThan(0);

    const seen = changes;
    handle.dispose();
    fs.writeFileSync(`${target}.tmp`, '{"me":"else"}');
    fs.renameSync(`${target}.tmp`, target);
    await sleep(150);
    expect(changes).toBe(seen);
  });

  it('does not throw when the directory is not there', () => {
    const handle = watchFileByRename('/tmp/cgremlin-no-such-dir-8a2f/core.json', () => undefined);
    expect(() => handle.dispose()).not.toThrow();
  });
});
