import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { InventoryStore, InventoryCorruptError } from '../../src/inventory/inventory-store';
import type { Inventory } from '../../src/inventory/inventory';

function sampleInventory(): Inventory {
  return {
    scannedAt: '2026-09-04T12:00:00.000Z',
    repos: ['acme/app'],
    entries: [
      {
        repo: 'acme/app',
        number: 5,
        url: 'https://github.com/acme/app/pull/5',
        title: 't',
        author: 'bob',
        isDraft: false,
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        updatedAt: '2026-09-04T00:00:00.000Z',
        reviewDecision: '',
        isMine: false,
        teamActivity: [{ login: 'carol', kind: 'comment', at: '2026-09-04T01:00:00.000Z' }],
        ours: { status: 'reviewing', sessionId: 's-1', reviewedSha: null, newCommits: false, phase: 'reviewing' },
        seenAt: '2026-09-04T12:00:00.000Z',
      },
    ],
    errors: [],
  };
}

describe('InventoryStore', () => {
  it('save writes via tmp+rename, leaving only the final file behind in the directory', async () => {
    const fs = new InMemoryFileSystem();
    const store = new InventoryStore(fs, '/state/inventory.json');
    await store.save(sampleInventory());
    expect(await fs.exists('/state/inventory.json')).toBe(true);
    const names = await fs.readdir('/state');
    expect(names).toEqual(['inventory.json']);
  });

  it('load returns null when the file is absent', async () => {
    const fs = new InMemoryFileSystem();
    const store = new InventoryStore(fs, '/state/inventory.json');
    expect(await store.load()).toBeNull();
  });

  it('round-trips an inventory unchanged', async () => {
    const fs = new InMemoryFileSystem();
    const store = new InventoryStore(fs, '/state/inventory.json');
    const inv = sampleInventory();
    await store.save(inv);
    const loaded = await store.load();
    expect(loaded).toEqual(inv);
  });

  it('load throws InventoryCorruptError on invalid JSON', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/inventory.json', 'not json{');
    const store = new InventoryStore(fs, '/state/inventory.json');
    await expect(store.load()).rejects.toThrow(InventoryCorruptError);
  });

  it('load throws InventoryCorruptError on schema-invalid JSON', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/inventory.json', JSON.stringify({ nope: true }));
    const store = new InventoryStore(fs, '/state/inventory.json');
    await expect(store.load()).rejects.toThrow(InventoryCorruptError);
  });
});
