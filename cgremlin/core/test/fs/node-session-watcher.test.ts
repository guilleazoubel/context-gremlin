import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSessionWatcher } from '../../src/fs/node-session-watcher';
import type { SessionWatchEvent } from '../../src/fs/session-watcher';
import { FakeSessionWatcher } from '../support/fake-session-watcher';

let dir: string;
let watcher: NodeSessionWatcher | null;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-watch-'));
  watcher = null;
});

afterEach(async () => {
  watcher?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('NodeSessionWatcher', () => {
  it('reports a two-segment artifact write and discards everything else', async () => {
    const seen: SessionWatchEvent[] = [];
    watcher = new NodeSessionWatcher(dir);
    watcher.start((e) => seen.push(e));
    await mkdir(path.join(dir, 's1', 'logs'), { recursive: true });
    await writeFile(path.join(dir, 's1', 'AGENT_STATE'), 'needs-input');
    await waitFor(() => seen.length > 0, 'the AGENT_STATE event');
    expect(seen).toEqual([{ sessionId: 's1', name: 'AGENT_STATE' }]);

    seen.length = 0;
    await writeFile(path.join(dir, 's1', 'logs', 'dev-server.log'), 'x');
    await writeFile(path.join(dir, 's1', 'session.json'), '{}');
    await writeFile(path.join(dir, 's1', 'session.json.abc.tmp'), '{}');
    await writeFile(path.join(dir, 'stray'), 'x');
    await writeFile(path.join(dir, 's1', 'PLAN.md'), '# plan');
    await waitFor(() => seen.length > 0, 'the PLAN.md event');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual([{ sessionId: 's1', name: 'PLAN.md' }]);
  });

  it('coalesces two rapid writes to the same file into one event', async () => {
    const seen: SessionWatchEvent[] = [];
    watcher = new NodeSessionWatcher(dir);
    watcher.start((e) => seen.push(e));
    await mkdir(path.join(dir, 's1'), { recursive: true });
    await writeFile(path.join(dir, 's1', 'AGENT_STATE'), 'working');
    await writeFile(path.join(dir, 's1', 'AGENT_STATE'), 'needs-input');
    await waitFor(() => seen.length > 0, 'the coalesced event');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen).toEqual([{ sessionId: 's1', name: 'AGENT_STATE' }]);
  });

  it('stop() twice does not throw', () => {
    watcher = new NodeSessionWatcher(dir);
    watcher.start(() => undefined);
    watcher.stop();
    expect(() => watcher!.stop()).not.toThrow();
  });

  it('falls back to polling when recursive watch is unavailable', async () => {
    const seen: SessionWatchEvent[] = [];
    watcher = new NodeSessionWatcher(dir, {
      pollIntervalMs: 20,
      watchFactory: () => {
        throw Object.assign(new Error('not supported'), { code: 'ENOSYS' });
      },
    });
    await mkdir(path.join(dir, 's1'), { recursive: true });
    watcher.start((e) => seen.push(e));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await writeFile(path.join(dir, 's1', 'AGENT_STATE'), 'blocked');
    await waitFor(() => seen.length > 0, 'the polled event');
    expect(seen[0]).toEqual({ sessionId: 's1', name: 'AGENT_STATE' });
    seen.length = 0;
    await writeFile(path.join(dir, 's1', 'session.json'), '{}');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen).toEqual([]);
  });

  it('a missing sessions dir neither throws nor reports', async () => {
    watcher = new NodeSessionWatcher(path.join(dir, 'nope'), { pollIntervalMs: 20 });
    const seen: SessionWatchEvent[] = [];
    expect(() => watcher!.start((e) => seen.push(e))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual([]);
  });
});

describe('FakeSessionWatcher', () => {
  it('delivers an emitted event and rejects a second start as a programming error', () => {
    const fake = new FakeSessionWatcher();
    const seen: SessionWatchEvent[] = [];
    fake.start((e) => seen.push(e));
    fake.emit({ sessionId: 's1', name: 'AGENT_STATE' });
    expect(seen).toEqual([{ sessionId: 's1', name: 'AGENT_STATE' }]);
    expect(() => fake.start(() => undefined)).toThrow(/twice/);
    fake.stop();
    fake.emit({ sessionId: 's1', name: 'AGENT_STATE' });
    expect(seen).toHaveLength(1);
  });
});
