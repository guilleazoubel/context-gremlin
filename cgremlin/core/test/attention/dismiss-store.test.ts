import { beforeEach, describe, expect, it } from 'vitest';
import { DismissStore, dismissalFor } from '../../src/attention/dismiss-store';
import { prRef, sessionRef } from '../../src/attention/item-ref';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const PATH = '/state/dismissals.json';

let fs: InMemoryFileSystem;
let store: DismissStore;

beforeEach(async () => {
  fs = new InMemoryFileSystem();
  await fs.mkdir('/state', { recursive: true });
  store = new DismissStore(fs, PATH);
});

describe('DismissStore', () => {
  it('loads an empty map when the file does not exist', async () => {
    expect(await store.load()).toEqual({});
  });

  it('loads an empty map from a corrupt file rather than throwing', async () => {
    await fs.writeFile(PATH, '{not json');
    expect(await store.load()).toEqual({});
    await fs.writeFile(PATH, JSON.stringify({ 'pr:o/r#12': { nope: 1 } }));
    expect(await store.load()).toEqual({});
  });

  it('round-trips, preserves other keys, and leaves no tmp file behind', async () => {
    await store.put('pr:o/r#12', { dismissedAt: 't1', refs: [prRef('o/r', 12)] });
    await store.put('session:a', { dismissedAt: 't2', refs: [sessionRef('a')] });
    expect(await store.load()).toEqual({
      'pr:o/r#12': { dismissedAt: 't1', refs: ['pr:o/r#12'] },
      'session:a': { dismissedAt: 't2', refs: ['session:a'] },
    });
    expect((await fs.readdir('/state')).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('writes the store 0600 — it is engine state, not world-readable', async () => {
    await store.put('pr:o/r#12', { dismissedAt: 't', refs: [] });
    expect(await fs.statMode(PATH)).toBe(0o600);
  });

  it('remove drops every entry that matches by id or by ref', async () => {
    await store.put('pr:o/r#12', { dismissedAt: 't1', refs: [prRef('o/r', 12)] });
    await store.put('session:a', { dismissedAt: 't2', refs: [sessionRef('a')] });
    await store.remove(['pr:o/r#12']);
    expect(Object.keys(await store.load())).toEqual(['session:a']);
  });
});

describe('dismissalFor: a dismissal survives the item id changing shape', () => {
  const entries = { 'pr:o/r#12': { dismissedAt: 't1', refs: ['pr:o/r#12', 'session:a'] } };

  it('matches on the id', () => {
    expect(dismissalFor(entries, 'pr:o/r#12', [])?.entry.dismissedAt).toBe('t1');
  });

  it('matches when ANY stored ref is still one of the item refs, under a NEW id', () => {
    expect(dismissalFor(entries, 'ticket:HB-999', ['pr:o/r#12'])?.key).toBe('pr:o/r#12');
    expect(dismissalFor(entries, 'ticket:HB-999', ['session:a'])?.key).toBe('pr:o/r#12');
  });

  it('does not match an unrelated item', () => {
    expect(dismissalFor(entries, 'pr:o/r#13', ['pr:o/r#13'])).toBeNull();
  });
});
