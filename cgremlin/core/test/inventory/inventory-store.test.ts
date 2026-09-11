import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { InventoryStore, InventoryCorruptError } from '../../src/inventory/inventory-store';
import type { Inventory } from '../../src/inventory/inventory';
import type { SessionFileSystem } from '../../src/fs/session-file-system';

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
        branch: 'feature/x',
        ticketKeys: [],
        reviewRequests: [],
        humanActivity: { reviewedBy: [], commentedBy: ['carol'], lastAt: '2026-09-04T01:00:00.000Z' },
        createdAt: '2026-09-01T00:00:00.000Z',
        changedFiles: 2,
        additions: 3,
        deletions: 4,
        ci: 'success',
        labels: [],
        reviewDecisionAt: null,
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

  it('F5/M4: save writes to a .tmp path then renames it onto the final path (spied), leaving no .tmp file behind', async () => {
    const inner = new InMemoryFileSystem();
    const renameCalls: Array<{ from: string; to: string }> = [];
    const spied: SessionFileSystem = {
      ...inner,
      readFile: (p) => inner.readFile(p),
      writeFile: (p, c, o) => inner.writeFile(p, c, o),
      statMode: (p) => inner.statMode(p),
      statMtimeMs: (p) => inner.statMtimeMs(p),
      remove: (p) => inner.remove(p),
      rename: (from, to) => {
        renameCalls.push({ from, to });
        return inner.rename(from, to);
      },
      readdir: (p) => inner.readdir(p),
      mkdir: (p, o) => inner.mkdir(p, o),
      exists: (p) => inner.exists(p),
    };
    const store = new InventoryStore(spied, '/state/inventory.json');
    await store.save(sampleInventory());

    expect(renameCalls.length).toBe(1);
    expect(renameCalls[0].to).toBe('/state/inventory.json');
    expect(renameCalls[0].from).toMatch(/^\/state\/inventory\.json\..+\.tmp$/);
    expect(renameCalls[0].from).not.toBe(renameCalls[0].to);
    const names = await inner.readdir('/state');
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
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

describe('InventoryStore: the pre-Phase-9 document still loads (MG-7 / R45)', () => {
  it('loads a fixture with none of the eleven Phase 9 fields, and every one takes its default', async () => {
    const raw = readFileSync(path.join(__dirname, '../fixtures/inventory-pre-phase9.json'), 'utf8');
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/inventory.json', raw);
    const store = new InventoryStore(fs, '/state/inventory.json');
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    const [entry] = loaded!.entries;
    expect(entry.branch).toBeNull();
    expect(entry.ticketKeys).toEqual([]);
    expect(entry.reviewRequests).toEqual([]);
    expect(entry.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
    // never 0 — an unknown age or size is null, so the panel can render '—'
    expect(entry.createdAt).toBeNull();
    expect(entry.changedFiles).toBeNull();
    expect(entry.additions).toBeNull();
    expect(entry.deletions).toBeNull();
    expect(entry.ci).toBe('none');
    expect(entry.labels).toEqual([]);
    expect(entry.reviewDecisionAt).toBeNull();
  });
});
