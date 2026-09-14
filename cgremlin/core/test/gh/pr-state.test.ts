/**
 * The pr-state leg: what happened to a PR the open-PR inventory no longer has.
 *
 * The live case this is pinned on: `aplaceformom/grace#2180`, merged
 * 2026-09-11, title `feat(HB-1489): add web-content read endpoint to the
 * Grace backend`. It is absent from `gh pr list --state open`, so before this
 * leg the panel had NOTHING that said merged — and nothing that kept its
 * ticket either, because the inventory row that carried `ticketKeys` left
 * with the PR.
 */
import { describe, expect, it } from 'vitest';
import {
  PR_STATE_FIELDS,
  PrStateResolver,
  PrStateStore,
  isLandedState,
  prStateKey,
  type PrStateCache,
} from '../../src/gh/pr-state';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGhRunner } from '../support/fake-gh-runner';

const NOW = (): Date => new Date('2026-09-14T09:00:00.000Z');
const REPO = 'aplaceformom/grace';
const TITLE = 'feat(HB-1489): add web-content read endpoint to the Grace backend';

function mergedView(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: 'MERGED',
    mergedAt: '2026-09-11T13:34:00Z',
    closedAt: '2026-09-11T13:34:00Z',
    title: TITLE,
    url: `https://github.com/${REPO}/pull/2180`,
    headRefName: 'HB-1489-web-content-read',
    ...over,
  });
}

function resolverOn(gh: FakeGhRunner, fs = new InMemoryFileSystem()) {
  return {
    fs,
    resolver: new PrStateResolver({
      gh,
      store: new PrStateStore(fs, '/state/pr-states.json'),
      projectKeys: ['HB'],
      now: NOW,
    }),
  };
}

describe('PrStateResolver', () => {
  it('asks gh read-only for exactly the pinned projection and maps MERGED to `merged`', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView() });
    const { resolver } = resolverOn(gh);

    await resolver.run([{ repo: REPO, number: 2180 }]);

    expect(gh.calls).toEqual([
      ['pr', 'view', '2180', '--repo', REPO, '--json', PR_STATE_FIELDS],
    ]);
    const entry = (await resolver.cached())[prStateKey(REPO, 2180)];
    expect(entry.state).toBe('merged');
    expect(entry.mergedAt).toBe('2026-09-11T13:34:00Z');
    expect(entry.title).toBe(TITLE);
    expect(entry.checkedAt).toBe('2026-09-14T09:00:00.000Z');
  });

  it('parses the ticket keys out of the branch and the title at fetch time — the merged PR keeps its link', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView() });
    const { resolver } = resolverOn(gh);
    await resolver.run([{ repo: REPO, number: 2180 }]);
    expect((await resolver.cached())[prStateKey(REPO, 2180)].ticketKeys).toEqual(['HB-1489']);
  });

  it('a title alone is enough — the branch may be long deleted', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView({ headRefName: 'tmp/whatever' }) });
    const { resolver } = resolverOn(gh);
    await resolver.run([{ repo: REPO, number: 2180 }]);
    expect((await resolver.cached())[prStateKey(REPO, 2180)].ticketKeys).toEqual(['HB-1489']);
  });

  it('a landed state is FINAL: the second scan makes no call at all', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView() });
    const { resolver } = resolverOn(gh);
    await resolver.run([{ repo: REPO, number: 2180 }]);
    await resolver.run([{ repo: REPO, number: 2180 }]);
    expect(gh.calls.length).toBe(1);
    expect(resolver.lastReport().fetched).toBe(0);
  });

  it('CLOSED maps to `closed`, and an open PR outside the scanned repos maps to `open`', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView({ state: 'CLOSED', mergedAt: null }) });
    gh.queueResponse({ stdout: mergedView({ state: 'OPEN', mergedAt: null, closedAt: null }) });
    const { resolver } = resolverOn(gh);
    await resolver.run([
      { repo: REPO, number: 1 },
      { repo: REPO, number: 2 },
    ]);
    const cache = await resolver.cached();
    expect(cache[prStateKey(REPO, 1)].state).toBe('closed');
    expect(cache[prStateKey(REPO, 2)].state).toBe('open');
  });

  it('is single-flight, and a gh failure leaves the previous cache intact and reports the error', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView() });
    const { resolver } = resolverOn(gh);
    await resolver.run([{ repo: REPO, number: 2180 }]);

    gh.queueResponse(new Error('gh exploded'));
    await resolver.run([{ repo: REPO, number: 77 }]);
    expect(resolver.lastReport().error).toBe('gh exploded');
    expect((await resolver.cached())[prStateKey(REPO, 2180)].state).toBe('merged');
  });

  it('a second run() while one is in flight joins it rather than starting a second', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: mergedView() });
    const { resolver } = resolverOn(gh);
    const a = resolver.run([{ repo: REPO, number: 2180 }]);
    const b = resolver.run([{ repo: REPO, number: 2180 }]);
    expect(b).toBe(a);
    await a;
    expect(gh.calls.length).toBe(1);
  });
});

describe('PrStateStore', () => {
  it('writes 0600 through a tmp file and a rename, so the store is never briefly world-readable', async () => {
    const fs = new InMemoryFileSystem();
    const store = new PrStateStore(fs, '/state/pr-states.json');
    const cache: PrStateCache = {
      [prStateKey(REPO, 2180)]: {
        state: 'merged',
        title: TITLE,
        url: null,
        mergedAt: '2026-09-11T13:34:00Z',
        closedAt: null,
        branch: 'HB-1489-web-content-read',
        ticketKeys: ['HB-1489'],
        checkedAt: '2026-09-14T09:00:00.000Z',
      },
    };
    await store.save(cache);
    expect(await store.load()).toEqual(cache);
    expect(await fs.statMode('/state/pr-states.json')).toBe(0o600);
  });

  it('a malformed file is "nothing cached", never a read that throws', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/pr-states.json', 'not json');
    expect(await new PrStateStore(fs, '/state/pr-states.json').load()).toEqual({});
  });
});

describe('isLandedState', () => {
  it('is true for merged and closed, and false for everything else INCLUDING unknown', () => {
    expect(isLandedState('merged')).toBe(true);
    expect(isLandedState('closed')).toBe(true);
    expect(isLandedState('open')).toBe(false);
    expect(isLandedState('draft')).toBe(false);
    // The one that matters: a PR the leg has not resolved yet must behave
    // exactly as it did before this field existed.
    expect(isLandedState(null)).toBe(false);
    expect(isLandedState(undefined)).toBe(false);
  });
});
