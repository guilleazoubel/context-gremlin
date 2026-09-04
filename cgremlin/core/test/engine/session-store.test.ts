import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import {
  SessionStore,
  SessionNotFoundError,
  SessionCorruptError,
  InvalidSessionIdError,
} from '../../src/engine/session-store';
import { migrateV1ToV2, type Session, type SessionV1 } from '../../src/schema/session';
import { IllegalTransitionError } from '../../src/schema/pipeline';

function makeSession(overrides: Record<string, unknown> = {}): Session {
  const v1 = {
    schemaVersion: 1,
    id: 'inv-test-1',
    mode: 'investigation',
    createdAt: '2026-08-28T10:00:00.000Z',
    workspace: { repoUrl: 'git@example.com:x/y.git' },
    lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
    stageStatus: 'findings',
    ...overrides,
  } as SessionV1;
  return migrateV1ToV2(v1);
}

describe('SessionStore', () => {
  it('round-trips a session through save and load', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    const session = makeSession();
    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded).toEqual(session);
  });

  it('save() of a v1 document persists a v2 document on disk', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    const v1: SessionV1 = {
      schemaVersion: 1,
      id: 'inv-v1-persist',
      mode: 'investigation',
      createdAt: '2026-08-28T10:00:00.000Z',
      workspace: { repoUrl: 'git@example.com:x/y.git' },
      lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
      stageStatus: 'findings',
    };
    await store.save(v1 as unknown as Session);
    const raw = await fs.readFile('/sessions/inv-v1-persist/session.json');
    const onDisk = JSON.parse(raw);
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.intent).toBe('investigate_only');
    expect(onDisk.driveToCompletion).toBe(false);
  });

  it('load throws SessionNotFoundError for an unknown id', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('nope')).rejects.toThrow(SessionNotFoundError);
  });

  it('load throws SessionCorruptError for invalid JSON on disk', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/sessions/bad', { recursive: true });
    await fs.writeFile('/sessions/bad/session.json', '{not json');
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('bad')).rejects.toThrow(SessionCorruptError);
  });

  it('load throws SessionCorruptError for JSON that fails schema validation', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/sessions/bad2', { recursive: true });
    await fs.writeFile('/sessions/bad2/session.json', JSON.stringify({ mode: 'investigation' }));
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('bad2')).rejects.toThrow(SessionCorruptError);
  });

  it('list returns an empty array when the sessions directory does not exist yet', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    expect(await store.list()).toEqual([]);
  });

  it('list returns every saved session', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-a' }));
    await store.save(makeSession({ id: 'inv-b' }));
    const sessions = await store.list();
    expect(sessions.map((s) => s.id).sort()).toEqual(['inv-a', 'inv-b']);
  });

  it('transition applies a legal phase change and persists it', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-c', stageStatus: 'findings' }));
    const updated = await store.transition('inv-c', 'planning');
    expect(updated.stageStatus).toBe('planning');
    const reloaded = await store.load('inv-c');
    expect(reloaded.stageStatus).toBe('planning');
  });

  it('transition rejects an illegal phase change and leaves the persisted session unchanged', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-d', stageStatus: 'findings' }));
    await expect(store.transition('inv-d', 'approved')).rejects.toThrow(IllegalTransitionError);
    const reloaded = await store.load('inv-d');
    expect(reloaded.stageStatus).toBe('findings');
  });

  it('list skips a stray entry that is not a session directory', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-a' }));
    await fs.writeFile('/sessions/.dashboard_server.py', '# not a session');
    const sessions = await store.list();
    expect(sessions.map((s) => s.id)).toEqual(['inv-a']);
  });

  it('list skips a corrupt sibling session and still returns healthy ones', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-a' }));
    await fs.mkdir('/sessions/inv-broken', { recursive: true });
    await fs.writeFile('/sessions/inv-broken/session.json', '{not json');
    const sessions = await store.list();
    expect(sessions.map((s) => s.id)).toEqual(['inv-a']);
  });

  it('list returns sessions sorted by id', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-b' }));
    await store.save(makeSession({ id: 'inv-a' }));
    const sessions = await store.list();
    expect(sessions.map((s) => s.id)).toEqual(['inv-a', 'inv-b']);
  });

  it('save rejects a session id containing a path separator', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await expect(store.save(makeSession({ id: '../escaped' }))).rejects.toThrow(
      InvalidSessionIdError,
    );
  });

  it('load rejects an id that is a path-traversal attempt', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('../../etc/passwd')).rejects.toThrow(InvalidSessionIdError);
  });

  it('constructor rejects a relative sessionsDir', () => {
    const fs = new InMemoryFileSystem();
    expect(() => new SessionStore(fs, 'sessions')).toThrow();
  });
});
