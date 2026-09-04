import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEntries, groupInventory, type Inventory, type InventoryEntry } from '../../src/inventory/inventory';
import { parsePrInventoryList, type PrInventoryItem } from '../../src/gh/pr-view';
import { migrateV1ToV2, type ReviewSession } from '../../src/schema/session';
import type { ReviewPhase } from '../../src/schema/pipeline';

const NOW = '2026-09-04T18:00:00.000Z';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const fullListJson = readFileSync(path.join(fixturesDir, 'pr-list-full.json'), 'utf8');

function review(login: string, state: string, submittedAt: string) {
  return { author: { login }, state, submittedAt };
}

function comment(login: string, createdAt: string) {
  return { author: { login }, createdAt };
}

function prItem(overrides: Partial<PrInventoryItem> & { number: number }): PrInventoryItem {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    author: { login: 'author-x' },
    isDraft: false,
    reviewDecision: '',
    headRefOid: 'a'.repeat(40),
    headRefName: 'feature',
    baseRefName: 'main',
    title: 't',
    updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [],
    reviews: [],
    comments: [],
    ...overrides,
  };
}

function reviewSession(overrides: {
  stageStatus?: ReviewPhase;
  reviewedSha?: string | null;
  id?: string;
  repo?: string;
  number?: number;
} = {}): ReviewSession {
  const id = overrides.id ?? 'rev-1';
  const repo = overrides.repo ?? 'acme/app';
  const number = overrides.number ?? 5;
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: overrides.stageStatus ?? 'ready',
  }) as ReviewSession;
  return {
    ...v2,
    pr: {
      repo,
      number,
      url: `https://github.com/${repo}/pull/${number}`,
      headSha: 'a'.repeat(40),
      reviewedSha: overrides.reviewedSha === undefined ? 'a'.repeat(40) : overrides.reviewedSha,
      title: 't',
      author: 'bob',
    },
  };
}

function baseEntry(number: number): InventoryEntry {
  return {
    repo: 'acme/app',
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: 't',
    author: 'bob',
    isDraft: false,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    updatedAt: '2026-09-04T00:00:00.000Z',
    reviewDecision: '',
    isMine: false,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: NOW,
  };
}

describe('buildEntries', () => {
  it('isMine is case-insensitive', () => {
    const item = prItem({ number: 1, author: { login: 'Alice' } });
    const [entry] = buildEntries('acme/app', [item], [], { me: 'alice', watchAuthors: [] }, NOW);
    expect(entry.isMine).toBe(true);
  });

  it('fixture-driven: a vercel comment does not count while a watched teammate\'s COMMENTED review does', () => {
    const items = parsePrInventoryList(fullListJson);
    const pr2010 = items.find((i) => i.number === 2010);
    expect(pr2010).toBeDefined();
    const [entry] = buildEntries(
      'aplaceformom/grace-frontend',
      [pr2010!],
      [],
      { me: 'someone-else', watchAuthors: ['mattsmith-apfm'] },
      NOW,
    );
    expect(entry.teamActivity.some((a) => a.login === 'vercel')).toBe(false);
    const reviewActivity = entry.teamActivity.filter((a) => a.kind === 'review');
    expect(reviewActivity.length).toBeGreaterThan(0);
    expect(reviewActivity.every((a) => a.login === 'mattsmith-apfm')).toBe(true);
    expect(reviewActivity.some((a) => a.state === 'COMMENTED')).toBe(true);
  });

  it("me's own review and comment do not count as team activity, case-insensitively", () => {
    const item = prItem({
      number: 2,
      reviews: [review('Bob', 'COMMENTED', '2026-09-01T00:00:00Z')],
      comments: [comment('bob', '2026-09-02T00:00:00Z')],
    });
    const [entry] = buildEntries('acme/app', [item], [], { me: 'Bob', watchAuthors: ['bob'] }, NOW);
    expect(entry.teamActivity).toEqual([]);
  });

  it('teamActivity is sorted by at ascending across reviews and comments', () => {
    const item = prItem({
      number: 3,
      reviews: [review('carol', 'APPROVED', '2026-09-03T00:00:00Z')],
      comments: [comment('carol', '2026-09-01T00:00:00Z'), comment('dave', '2026-09-02T00:00:00Z')],
    });
    const [entry] = buildEntries(
      'acme/app', [item], [], { me: 'me-user', watchAuthors: ['carol', 'dave'] }, NOW,
    );
    expect(entry.teamActivity.map((a) => a.at)).toEqual([
      '2026-09-01T00:00:00Z',
      '2026-09-02T00:00:00Z',
      '2026-09-03T00:00:00Z',
    ]);
  });

  it('ours is reviewing for a queued or reviewing non-terminal session', () => {
    for (const stageStatus of ['queued', 'reviewing'] as const) {
      const item = prItem({ number: 5 });
      const session = reviewSession({ stageStatus, number: 5, reviewedSha: null });
      const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
      expect(entry.ours.status).toBe('reviewing');
    }
  });

  it('ours is reviewed with newCommits true when the reviewed sha differs from the current head sha', () => {
    const item = prItem({ number: 5, headRefOid: 'c'.repeat(40) });
    const session = reviewSession({ stageStatus: 'ready', number: 5, reviewedSha: 'a'.repeat(40) });
    const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours).toEqual({
      status: 'reviewed',
      sessionId: session.id,
      reviewedSha: 'a'.repeat(40),
      newCommits: true,
      phase: 'ready',
    });
  });

  it('ours newCommits is false when the reviewed sha matches the current head sha', () => {
    const item = prItem({ number: 5, headRefOid: 'a'.repeat(40) });
    const session = reviewSession({ stageStatus: 'ready', number: 5, reviewedSha: 'a'.repeat(40) });
    const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours.status).toBe('reviewed');
    expect(entry.ours.status !== 'none' && entry.ours.newCommits).toBe(false);
  });

  it('ours newCommits is false when reviewedSha is null (never actually reviewed yet)', () => {
    const item = prItem({ number: 5 });
    const session = reviewSession({ stageStatus: 'queued', number: 5, reviewedSha: null });
    const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours.status !== 'none' && entry.ours.newCommits).toBe(false);
  });

  it('ours is none when no session matches this repo/number', () => {
    const item = prItem({ number: 5 });
    const [entry] = buildEntries('acme/app', [item], [], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours).toEqual({ status: 'none' });
  });

  it('a dismissed (terminal) session does not count as ours', () => {
    const item = prItem({ number: 5 });
    const session = reviewSession({ stageStatus: 'dismissed', number: 5 });
    const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours).toEqual({ status: 'none' });
  });

  it('drafts are included with the flag set, not dropped', () => {
    const item = prItem({ number: 6, isDraft: true });
    const [entry] = buildEntries('acme/app', [item], [], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.isDraft).toBe(true);
  });
});

describe('groupInventory', () => {
  it('partitions entries: every non-mine entry lands in exactly one of unreviewed/teamOnIt/ours; mine entries land only in mine', () => {
    const entries: InventoryEntry[] = [
      { ...baseEntry(1), isMine: true },
      {
        ...baseEntry(2),
        isMine: false,
        ours: { status: 'reviewing', sessionId: 's', reviewedSha: null, newCommits: false, phase: 'reviewing' },
      },
      { ...baseEntry(3), isMine: false, teamActivity: [{ login: 'x', kind: 'comment', at: NOW }] },
      { ...baseEntry(4), isMine: false },
    ];
    const inv: Inventory = { scannedAt: NOW, repos: ['acme/app'], entries, errors: [] };
    const groups = groupInventory(inv);

    expect(groups.mine.map((e) => e.number)).toEqual([1]);
    expect(groups.ours.map((e) => e.number)).toEqual([2]);
    expect(groups.teamOnIt.map((e) => e.number)).toEqual([3]);
    expect(groups.unreviewed.map((e) => e.number)).toEqual([4]);

    const nonMine = entries.filter((e) => !e.isMine);
    const partitioned = [...groups.unreviewed, ...groups.teamOnIt, ...groups.ours];
    expect(partitioned.length).toBe(nonMine.length);
    expect(new Set(partitioned.map((e) => e.number))).toEqual(new Set(nonMine.map((e) => e.number)));
  });
});
