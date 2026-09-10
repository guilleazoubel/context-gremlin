import { beforeEach, describe, expect, it } from 'vitest';
import { AckStore } from '../../src/attention/ack-store';
import { prRef, sessionRef } from '../../src/attention/item-ref';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const PATH = '/state/attention-acks.json';

let fs: InMemoryFileSystem;
let store: AckStore;

beforeEach(async () => {
  fs = new InMemoryFileSystem();
  await fs.mkdir('/state', { recursive: true });
  store = new AckStore(fs, PATH);
});

describe('AckStore', () => {
  it('loads an empty map when the file does not exist', async () => {
    expect(await store.load()).toEqual({});
  });

  it('loads an empty map from a corrupt file rather than throwing', async () => {
    await fs.writeFile(PATH, '{not json');
    expect(await store.load()).toEqual({});
    await fs.writeFile(PATH, JSON.stringify({ 'session:a': { nope: 1 } }));
    expect(await store.load()).toEqual({});
  });

  it('round-trips, preserves other keys, and leaves no tmp file behind', async () => {
    await store.put(sessionRef('a'), { signature: 'needs_input|t1', ackedAt: 't2' });
    await store.put(prRef('o/r', 12), { signature: 'changes_requested|t3', ackedAt: 't4' });
    expect(await store.load()).toEqual({
      'session:a': { signature: 'needs_input|t1', ackedAt: 't2' },
      'pr:o/r#12': { signature: 'changes_requested|t3', ackedAt: 't4' },
    });
    const leftovers = (await fs.readdir('/state')).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('stores a PR ack under exactly prRef — there is no separate prAckKey', async () => {
    await store.put(prRef('o/r', 12), { signature: 's', ackedAt: 't' });
    expect(Object.keys(await store.load())).toEqual(['pr:o/r#12']);
  });

  it('prunes acks for items that no longer exist', async () => {
    await store.put(sessionRef('a'), { signature: 's1', ackedAt: 't1' });
    await store.put(prRef('o/r', 1), { signature: 's2', ackedAt: 't2' });
    await store.prune([sessionRef('a')]);
    expect(await store.load()).toEqual({ 'session:a': { signature: 's1', ackedAt: 't1' } });
  });
});
