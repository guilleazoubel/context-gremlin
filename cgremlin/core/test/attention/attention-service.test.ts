import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AckStore } from '../../src/attention/ack-store';
import {
  AttentionService,
  PrSourceAdapter,
  SessionSourceAdapter,
  type AttentionItem,
  type SourceAdapter,
} from '../../src/attention/attention-service';
import { prRef, sessionRef, type ItemSource } from '../../src/attention/item-ref';
import { KeyedLock } from '../../src/api/keyed-lock';
import { mapErrorToHttp } from '../../src/api/http-errors';
import type { Inventory, InventoryEntry } from '../../src/inventory/inventory';
import type { LocalAppStatus } from '../../src/env/environment-service';
import type { Session } from '../../src/schema/session';
import type { HumanTurn } from '../../src/schema/stage';
import { createHarness, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { FakeSessionWatcher } from '../support/fake-session-watcher';

const ACKS_PATH = '/state/attention-acks.json';
const NOW = new Date('2026-09-10T12:00:00.000Z');
/** A human-turn claim that is still live at NOW, and one that ran out before it. */
const LIVE: HumanTurn = { claimedAt: '2026-09-10T11:55:00.000Z', expiresAt: '2026-09-10T12:05:00.000Z' };
const EXPIRED: HumanTurn = { claimedAt: '2026-09-10T11:00:00.000Z', expiresAt: '2026-09-10T11:10:00.000Z' };

function withClaim(session: Session, humanTurn: HumanTurn | null): Session {
  return { ...session, agent: { runner: 'claude-code', resumeId: 'resume-1', humanTurn } };
}

class LoggingLock extends KeyedLock {
  readonly calls: string[] = [];
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push(`lock.enter:${key}`);
    return super.withLock(key, fn);
  }
}

function investigation(id: string, over: Partial<Session> = {}): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    mode: 'investigation',
    stageStatus: 'findings',
    intent: 'investigate_only',
    driveToCompletion: false,
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'b' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'APP-1' },
    agent: null,
    lastRun: null,
    pr: null,
    ...over,
  } as Session;
}

function reviewSession(id: string, over: Record<string, unknown> = {}): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2026-09-01T00:00:00.000Z',
    mode: 'review',
    stageStatus: 'ready',
    reviewVersion: 1,
    lastRereviewSummary: null,
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'b' },
    lineage: { pipelineId: 'p2', parentSessionId: null, ticket: null },
    agent: null,
    lastRun: null,
    pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'sha1', reviewedSha: null, title: 'PR twelve', author: 'bob' },
    ...over,
  } as Session;
}

function entry(over: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    repo: 'acme/app',
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'PR twelve',
    author: 'bob',
    isDraft: false,
    headSha: 'sha1',
    baseRef: 'main',
    updatedAt: '2026-09-03T00:00:00.000Z',
    reviewDecision: '',
    isMine: false,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

function inventory(entries: InventoryEntry[]): Inventory {
  return { scannedAt: '2026-09-04T00:00:00.000Z', repos: ['acme/app'], entries, errors: [] };
}

function stoppedStatus(): LocalAppStatus {
  return {
    state: 'stopped',
    sessionId: null,
    url: null,
    pid: null,
    logPath: null,
    startedAt: null,
    reason: null,
    logTail: null,
  };
}

interface Fixture {
  h: PipelineHarness;
  watcher: FakeSessionWatcher;
  artifacts: Array<{ sessionId: string; name: string; mtime: string }>;
  lock: LoggingLock;
  service: AttentionService;
  acks: AckStore;
  changed: AttentionItem[];
  setInventory(inv: Inventory | null): void;
  setRunning(ids: string[]): void;
  setLocalStatus(status: LocalAppStatus): void;
}

let fx: Fixture;

async function makeFixture(extraAdapters: SourceAdapter[] = []): Promise<Fixture> {
  const lock = new LoggingLock();
  const h = createHarness({ lock });
  await h.fs.mkdir('/state', { recursive: true });
  let inv: Inventory | null = null;
  let running: string[] = [];
  let localStatus: LocalAppStatus = stoppedStatus();
  const acks = new AckStore(h.fs, ACKS_PATH);
  const watcher = new FakeSessionWatcher();
  const sessionAdapter = new SessionSourceAdapter({
    store: h.store,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    isRunning: (id) => running.includes(id),
    localStatus: async () => localStatus,
    now: () => NOW,
  });
  const prAdapter = new PrSourceAdapter({ inventory: { load: async () => inv } });
  const service = new AttentionService({
    adapters: [sessionAdapter, prAdapter, ...extraAdapters],
    acks,
    events: h.events,
    watcher,
    now: () => NOW,
  });
  const changed: AttentionItem[] = [];
  h.events.on('attention.changed', (e) => changed.push(e.item));
  const artifacts: Array<{ sessionId: string; name: string; mtime: string }> = [];
  h.events.on('artifact.changed', (e) => artifacts.push(e));
  return {
    h,
    watcher,
    artifacts,
    lock,
    service,
    acks,
    changed,
    setInventory: (next) => { inv = next; },
    setRunning: (ids) => { running = ids; },
    setLocalStatus: (status) => { localStatus = status; },
  };
}

beforeEach(async () => {
  fx = await makeFixture();
});

describe('AttentionService.list', () => {
  it('returns only needy items by default, and every evaluated item with all: true', async () => {
    await fx.h.store.save(investigation('quiet'));
    await fx.h.store.save(investigation('loud', { stageStatus: 'plan_ready' }));
    fx.setInventory(inventory([entry({ number: 7 })]));

    const needy = await fx.service.list();
    expect(needy.items.map((i) => i.ref)).toEqual(['session:loud']);
    expect(needy.evaluatedAt).toBe(NOW.toISOString());

    const all = await fx.service.list({ all: true });
    expect(all.items.map((i) => i.ref).sort()).toEqual(['pr:acme/app#7', 'session:loud', 'session:quiet']);
    const item = all.items.find((i) => i.ref === 'session:loud')!;
    expect(Object.keys(item).sort()).toEqual(
      ['attention', 'claimed', 'id', 'links', 'mode', 'ref', 'repoOrContext', 'running', 'source', 'stageStatus', 'title'].sort(),
    );
    expect(item.source).toBe('session');
    expect(item.mode).toBe('investigation');
    expect(item.stageStatus).toBe('plan_ready');
    expect(item.running).toBe(false);
    expect(item.repoOrContext).toBe('acme/app');
    // A1 placeholder: A2 wires primaryArtifact.
    expect(item.links.primaryArtifact).toBeNull();
    expect(item.links.worktreePath).toBe('/worktrees/loud');
    expect(item.links.ticket).toBe('APP-1');
  });

  // R20: `claimed` is `isClaimed`, never `humanTurn !== null`.
  it('reports claimed: true for a session whose human-turn claim is still live', async () => {
    await fx.h.store.save(withClaim(investigation('claimed-live'), LIVE));
    const all = await fx.service.list({ all: true });
    expect(all.items.find((i) => i.ref === 'session:claimed-live')!.claimed).toBe(true);
  });

  it('reports claimed: false for a session whose human-turn claim has expired', async () => {
    await fx.h.store.save(withClaim(investigation('claimed-expired'), EXPIRED));
    const all = await fx.service.list({ all: true });
    expect(all.items.find((i) => i.ref === 'session:claimed-expired')!.claimed).toBe(false);
  });

  it('reports claimed: false for a session with no claim, and for a non-session source', async () => {
    await fx.h.store.save(withClaim(investigation('claimed-none'), null));
    fx.setInventory(inventory([entry({ number: 7 })]));
    const all = await fx.service.list({ all: true });
    expect(all.items.find((i) => i.ref === 'session:claimed-none')!.claimed).toBe(false);
    expect(all.items.find((i) => i.ref === 'pr:acme/app#7')!.claimed).toBe(false);
  });

  it('emits a session that also has an inventory row exactly once, as a session, with the PR links merged', async () => {
    await fx.h.store.save(reviewSession('r1', { pr: null }));
    fx.setInventory(inventory([entry({ ours: { status: 'reviewed', sessionId: 'r1', reviewedSha: 'sha1', newCommits: false, phase: 'ready' } })]));

    const all = await fx.service.list({ all: true });
    const refs = all.items.map((i) => i.ref);
    expect(refs).toEqual([...new Set(refs)]);
    expect(refs).toEqual(['session:r1']);
    const item = all.items[0];
    expect(item.source).toBe('session');
    expect(item.links.prRepo).toBe('acme/app');
    expect(item.links.prNumber).toBe(12);
    expect(item.links.prUrl).toBe('https://github.com/acme/app/pull/12');
  });

  it('dedupes by the session\u2019s own PR when the inventory carries the same PR', async () => {
    await fx.h.store.save(reviewSession('r1'));
    fx.setInventory(inventory([entry({ ours: { status: 'none' } })]));
    const all = await fx.service.list({ all: true });
    expect(all.items.map((i) => i.ref)).toEqual(['session:r1']);
    expect(all.items[0].links.prNumber).toBe(12);
  });

  it('R22: attributes a degraded local app only to the session that owns it', async () => {
    await fx.h.store.save(investigation('owner'));
    await fx.h.store.save(investigation('sibling'));
    fx.setLocalStatus({ ...stoppedStatus(), state: 'unavailable', sessionId: 'owner', reason: 'port 8080 busy' });

    const all = await fx.service.list({ all: true });
    const byRef = new Map(all.items.map((i) => [i.ref, i]));
    expect(byRef.get('session:owner')!.attention.reasons).toEqual(['local_prereq_failed']);
    expect(byRef.get('session:sibling')!.attention.reasons).toEqual([]);
  });

  it('excludes terminal sessions', async () => {
    await fx.h.store.save(investigation('gone', { stageStatus: 'abandoned' }));
    await fx.h.store.save(reviewSession('done', { stageStatus: 'approved', pr: null }));
    await fx.h.store.save(investigation('here'));
    const all = await fx.service.list({ all: true });
    expect(all.items.map((i) => i.ref)).toEqual(['session:here']);
  });

  it('contributes no PR items when no scan has happened yet', async () => {
    fx.setInventory(null);
    await expect(fx.service.list({ all: true })).resolves.toEqual({
      evaluatedAt: NOW.toISOString(),
      items: [],
    });
  });

  it('tolerates a corrupt session.json', async () => {
    await fx.h.store.save(investigation('fine', { stageStatus: 'plan_ready' }));
    await fx.h.fs.mkdir(`${SESSIONS_DIR}/broken`, { recursive: true });
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/broken/session.json`, '{not json');
    const all = await fx.service.list({ all: true });
    expect(all.items.map((i) => i.ref)).toEqual(['session:fine']);
  });

  it('reports a live run as running', async () => {
    await fx.h.store.save(investigation('busy'));
    fx.setRunning(['busy']);
    const all = await fx.service.list({ all: true });
    expect(all.items[0].running).toBe(true);
  });

  it('reads AGENT_STATE, trimmed, and treats an unrecognized value as no state', async () => {
    await fx.h.store.save(investigation('a'));
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/AGENT_STATE`, ' needs-input \n');
    expect((await fx.service.list()).items.map((i) => i.attention.reasons)).toEqual([['needs_input']]);
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/AGENT_STATE`, 'wat');
    expect((await fx.service.list()).items).toEqual([]);
  });
});

describe('AttentionService.ack', () => {
  it('acks a session item, hides it from the listing, and re-raises on a new reason', async () => {
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    const acked = await fx.service.ack(sessionRef('a'));
    expect(acked.attention.acked).toBe(true);
    expect(acked.attention.needsAttention).toBe(false);
    expect(acked.attention.needsYou).toBe(false);
    expect((await fx.service.list()).items).toEqual([]);

    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/AGENT_STATE`, 'blocked');
    fx.changed.length = 0;
    await fx.service.refresh({ kind: 'session', id: 'a' });
    expect(fx.changed.map((i) => i.attention.reasons)).toEqual([['plan_ready', 'blocked']]);
    expect((await fx.service.list()).items).toHaveLength(1);
  });

  it('acks a PR item under its ItemRef', async () => {
    fx.setInventory(inventory([entry({ isMine: true, reviewDecision: 'CHANGES_REQUESTED' })]));
    const item = await fx.service.ack(prRef('acme/app', 12));
    expect(item.source).toBe('pr');
    expect(item.attention.acked).toBe(true);
    expect(Object.keys(await fx.acks.load())).toEqual(['pr:acme/app#12']);
    expect((await fx.service.list()).items).toEqual([]);
  });

  it('rejects a ref that names nothing with a 404-mapping error', async () => {
    fx.setInventory(inventory([entry()]));
    for (const ref of [sessionRef('nope'), prRef('acme/app', 999)]) {
      const err = await fx.service.ack(ref).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(mapErrorToHttp(err).status).toBe(404);
    }
  });
});

describe('AttentionService.refresh', () => {
  it('emits attention.changed only on a real delta', async () => {
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    await fx.service.refresh({ kind: 'session', id: 'a' });
    await fx.service.refresh({ kind: 'session', id: 'a' });
    expect(fx.changed).toHaveLength(1);
    expect(fx.changed[0].ref).toBe('session:a');
  });

  it('coalesces a burst of refreshes into one emission', async () => {
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    await Promise.all([
      fx.service.refresh({ kind: 'session', id: 'a' }),
      fx.service.refresh({ kind: 'session', id: 'a' }),
      fx.service.refresh({ kind: 'session', id: 'a' }),
      fx.service.refresh({ kind: 'session', id: 'a' }),
      fx.service.refresh({ kind: 'session', id: 'a' }),
    ]);
    expect(fx.changed).toHaveLength(1);
  });

  it('emits nothing for a session that no longer exists', async () => {
    await fx.service.refresh({ kind: 'session', id: 'ghost' });
    expect(fx.changed).toEqual([]);
  });

  it('refreshes a PR scope and every source with { kind: "all" }', async () => {
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    fx.setInventory(inventory([entry({ isMine: true, reviewDecision: 'CHANGES_REQUESTED' })]));
    await fx.service.refresh({ kind: 'all' });
    expect(fx.changed.map((i) => i.ref).sort()).toEqual(['pr:acme/app#12', 'session:a']);

    fx.changed.length = 0;
    await fx.service.refresh({ kind: 'pr', repo: 'acme/app', number: 12 });
    expect(fx.changed).toEqual([]);
  });

  it('recomputes on engine events once started, and stops on stop()', async () => {
    fx.service.start();
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    fx.h.events.emit('session.transitioned', {
      session: investigation('a', { stageStatus: 'plan_ready' }),
      from: 'planning',
      to: 'plan_ready',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fx.changed.map((i) => i.ref)).toEqual(['session:a']);

    fx.service.stop();
    fx.changed.length = 0;
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/AGENT_STATE`, 'blocked');
    fx.h.events.emit('session.transitioned', {
      session: investigation('a', { stageStatus: 'plan_ready' }),
      from: 'planning',
      to: 'plan_ready',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fx.changed).toEqual([]);
  });
});

describe('AttentionService + SessionWatcher', () => {
  it('refreshes attention on an AGENT_STATE write', async () => {
    fx.service.start();
    await fx.h.store.save(investigation('a'));
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/AGENT_STATE`, 'needs-input');
    fx.watcher.emit({ sessionId: 'a', name: 'AGENT_STATE' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fx.changed.map((i) => [i.ref, i.attention.reasons])).toEqual([['session:a', ['needs_input']]]);
    expect(fx.artifacts).toEqual([]);
  });

  it('emits artifact.changed with an ISO mtime for any other artifact, and no phantom attention delta', async () => {
    fx.service.start();
    await fx.h.store.save(investigation('a'));
    await fx.h.fs.writeFile(`${SESSIONS_DIR}/a/PLAN.md`, '# plan');
    // A first refresh records the (empty) state, so the artifact write below
    // can only emit attention.changed if it really changed something.
    await fx.service.refresh({ kind: 'session', id: 'a' });
    fx.changed.length = 0;
    fx.watcher.emit({ sessionId: 'a', name: 'PLAN.md' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fx.artifacts).toEqual([
      { sessionId: 'a', name: 'PLAN.md', mtime: NOW.toISOString() },
    ]);
    expect(new Date(fx.artifacts[0].mtime).toISOString()).toBe(fx.artifacts[0].mtime);
    expect(fx.changed).toEqual([]);
  });

  it('stops the watcher when the service stops', () => {
    fx.service.start();
    expect(fx.watcher.started).toBe(true);
    fx.service.stop();
    expect(fx.watcher.stopped).toBe(true);
    fx.watcher.emit({ sessionId: 'a', name: 'AGENT_STATE' });
    expect(fx.changed).toEqual([]);
  });
});

describe('AttentionService resilience', () => {
  const broken: SourceAdapter = {
    source: 'broken' as ItemSource,
    collect: () => Promise.reject(new Error('adapter is down')),
    collectOne: () => Promise.reject(new Error('adapter is down')),
  };

  it('lets one throwing adapter contribute nothing without failing the batch', async () => {
    const fx2 = await makeFixture([broken]);
    await fx2.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    fx2.setInventory(inventory([entry({ isMine: true, reviewDecision: 'CHANGES_REQUESTED' })]));

    const all = await fx2.service.list({ all: true });
    expect(all.items.map((i) => i.ref).sort()).toEqual(['pr:acme/app#12', 'session:a']);

    await fx2.service.refresh({ kind: 'all' });
    expect(fx2.changed.map((i) => i.ref).sort()).toEqual(['pr:acme/app#12', 'session:a']);

    // A targeted refresh whose only candidate throws is a no-op, not a throw.
    await expect(fx2.service.refresh({ kind: 'session', id: 'a' })).resolves.toBeUndefined();
  });

  it('survives an unreadable ack store and never leaks an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = createHarness();
      const service = new AttentionService({
        adapters: [broken],
        acks: {
          load: () => Promise.reject(new Error('acks unreadable')),
          put: () => Promise.resolve(),
          prune: () => Promise.resolve(),
        } as unknown as AckStore,
        events: h.events,
        now: () => NOW,
      });
      service.start();
      // The engine-event path is fire-and-forget: it must not surface here.
      h.events.emit('session.created', { session: investigation('a') });
      h.events.emit('inventory.updated', { inventory: inventory([]) });
      await expect(service.refresh({ kind: 'all' })).resolves.toBeUndefined();
      await expect(service.list()).resolves.toEqual({ evaluatedAt: NOW.toISOString(), items: [] });
      await new Promise((resolve) => setImmediate(resolve));
      service.stop();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// MG-A3 attention-never-locks-a-session
describe('MG-A3 attention-never-locks-a-session', () => {
  it('takes no session lock while listing or refreshing', async () => {
    await fx.h.store.save(investigation('a', { stageStatus: 'plan_ready' }));
    fx.setInventory(inventory([entry()]));
    fx.lock.calls.length = 0;
    await fx.service.list({ all: true });
    await fx.service.refresh({ kind: 'all' });
    await fx.service.ack(sessionRef('a'));
    expect(fx.lock.calls).toEqual([]);
  });

  it('holds no reference to the KeyedLock at all', () => {
    for (const name of ['attention.ts', 'attention-service.ts', 'ack-store.ts', 'item-ref.ts']) {
      const source = readFileSync(path.join(__dirname, '../../src/attention', name), 'utf8');
      expect(source).not.toContain('withLock');
      expect(source).not.toContain('keyed-lock');
    }
  });
});

// MG-A1 attention-is-pure-and-source-agnostic (the R18 extensibility half)
describe('R18: a third source is an adapter, not a refactor', () => {
  it('flows a stub adapter through list, refresh and ack with no service edit', async () => {
    const stub: SourceAdapter = {
      source: 'stub' as ItemSource,
      collect: async () => [collected()],
      collectOne: async (ref) => (ref === 'stub:x' ? collected() : null),
    };
    function collected() {
      return {
        ref: 'stub:x',
        id: 'x',
        title: 'a stub item',
        repoOrContext: 'PROJ',
        derived: [{ reason: 'needs_input' as const, at: '2026-09-05T00:00:00.000Z' }],
        fallbackSince: '2026-09-01T00:00:00.000Z',
        mode: null,
        stageStatus: null,
        running: false,
        claimed: false,
        links: {
          sessionId: null,
          worktreePath: null,
          prRepo: null,
          prNumber: null,
          prUrl: null,
          ticket: null,
          primaryArtifact: null,
        },
      };
    }
    const stubFx = await makeFixture([stub]);
    const listed = await stubFx.service.list();
    expect(listed.items.map((i) => i.ref)).toEqual(['stub:x']);
    expect(listed.items[0].source).toBe('stub');
    expect(listed.items[0].attention.needsYou).toBe(true);

    await stubFx.service.refresh({ kind: 'all' });
    expect(stubFx.changed.map((i) => i.ref)).toEqual(['stub:x']);

    const acked = await stubFx.service.ack('stub:x');
    expect(acked.attention.acked).toBe(true);
    expect((await stubFx.service.list()).items).toEqual([]);
  });
});
