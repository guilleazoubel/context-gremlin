/**
 * The config watcher's foundation: a save that *replaces* the file must still be seen (spec 4.5).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needsRecheck, watchFileByRename } from '../../src/engine/file-watch';

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

/**
 * Which events reach the callback. The callback is a *re-check*, not a change notification — so
 * an event that does not say which file it was about is routed through (the surface answers with
 * a digest), and only an event that names some *other* file is dropped.
 */
describe('needsRecheck', () => {
  it('routes an event that names the watched file', () => {
    expect(needsRecheck('core.json', 'core.json', 'state')).toBe(true);
  });

  it('routes an event with no filename rather than guessing it was a change', () => {
    expect(needsRecheck(null, 'core.json', 'state')).toBe(true);
    expect(needsRecheck(undefined, 'core.json', 'state')).toBe(true);
  });

  it('routes the directory-level event macOS names after the directory itself', () => {
    expect(needsRecheck('state', 'core.json', 'state')).toBe(true);
  });

  it('drops an event that names another file in the same directory', () => {
    expect(needsRecheck('inventory.json', 'core.json', 'state')).toBe(false);
    expect(needsRecheck('engine.log', 'core.json', 'state')).toBe(false);
    expect(needsRecheck('core.json.tmp', 'core.json', 'state')).toBe(false);
  });
});

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

  /**
   * The OS fact this whole watcher is written against, pinned so it cannot be forgotten again:
   * on macOS a `chmod` of the watched file IS an event for it, mode change or not. The callback
   * is therefore a *re-check*, never a change notification — the surface that owns it answers
   * "did the bytes change?" with a digest — and this test is what stops anyone reading it as one.
   */
  it('fires on a chmod of the watched file, even when the mode is unchanged', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-chmod-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'core.json');
    fs.writeFileSync(target, '{"me":"someone"}', { mode: 0o600 });

    let events = 0;
    const handle = watchFileByRename(target, () => {
      events += 1;
    });
    cleanups.push(() => handle.dispose());

    // The very same call `ui/engine.ts` makes, with the mode the file already has.
    fs.chmodSync(target, 0o600);
    await waitFor(() => events > 0);
    expect(events).toBeGreaterThan(0);
  });

  it('never fires for a sibling in the same directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watch-sibling-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'core.json');
    fs.writeFileSync(target, '{}');

    let events = 0;
    const handle = watchFileByRename(target, () => {
      events += 1;
    });
    cleanups.push(() => handle.dispose());

    // macOS delivers events with a lag, and the write that created the file above is one of
    // them: let the directory go quiet and start counting from there.
    await sleep(250);
    events = 0;

    // What the engine writes into its own state dir all day long, which is very often the
    // directory `core.json` sits in.
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(dir, 'inventory.json'), `{"n":${i}}`);
      fs.writeFileSync(path.join(dir, 'engine.log'), 'a line\n');
    }
    await sleep(200);
    // Nothing named some other entry may reach the callback. (That the target's own events DO
    // reach it is the first case in this file; asserting it again here would only add a wait
    // this assertion does not need.)
    expect(events).toBe(0);
  });

  it('does not throw when the directory is not there', () => {
    const handle = watchFileByRename('/tmp/cgremlin-no-such-dir-8a2f/core.json', () => undefined);
    expect(() => handle.dispose()).not.toThrow();
  });
});
