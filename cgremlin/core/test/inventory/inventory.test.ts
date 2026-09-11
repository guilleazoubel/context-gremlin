import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEntries, groupInventory, type Inventory, type InventoryEntry } from '../../src/inventory/inventory';
import { parsePrInventoryList, type PrInventoryItem } from '../../src/gh/pr-view';
import { migrateV1ToV2, type ReviewSession } from '../../src/schema/session';
import type { ReviewPhase } from '../../src/schema/pipeline';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';

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
    ...PHASE9_ENTRY_DEFAULTS,
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

  it('fixture-driven: a vercel comment and the PR author\'s own reviews do not count, while a different watched teammate\'s review does', () => {
    const items = parsePrInventoryList(fullListJson);
    const pr2010 = items.find((i) => i.number === 2010);
    expect(pr2010).toBeDefined();
    expect(pr2010!.author.login).toBe('mattsmith-apfm'); // the PR's own author
    const [entry] = buildEntries(
      'aplaceformom/grace-frontend',
      [pr2010!],
      [],
      // Watch BOTH the author (mattsmith-apfm, who also reviews their own PR
      // in this real data) and a genuine teammate (austinbrownapfm, who
      // approved it) — proves self-activity is excluded even though watched.
      { me: 'someone-else', watchAuthors: ['mattsmith-apfm', 'austinbrownapfm'] },
      NOW,
    );
    expect(entry.teamActivity.some((a) => a.login === 'vercel')).toBe(false);
    expect(entry.teamActivity.some((a) => a.login === 'mattsmith-apfm')).toBe(false);
    const reviewActivity = entry.teamActivity.filter((a) => a.kind === 'review');
    expect(reviewActivity.length).toBeGreaterThan(0);
    expect(reviewActivity.every((a) => a.login === 'austinbrownapfm')).toBe(true);
    expect(reviewActivity.some((a) => a.state === 'APPROVED')).toBe(true);
  });

  it('F2: the PR author\'s own comments do not count as team activity even when the author is a watched login (fixture #2019)', () => {
    const items = parsePrInventoryList(fullListJson);
    const pr2019 = items.find((i) => i.number === 2019);
    expect(pr2019).toBeDefined();
    expect(pr2019!.author.login).toBe('austinbrownapfm');
    const [entry] = buildEntries(
      'aplaceformom/grace-frontend',
      [pr2019!],
      [],
      { me: 'someone-else', watchAuthors: ['austinbrownapfm'] },
      NOW,
    );
    expect(entry.teamActivity).toEqual([]);
    const groups = groupInventory({ scannedAt: NOW, repos: ['aplaceformom/grace-frontend'], entries: [entry], errors: [] });
    expect(groups.unreviewed).toEqual([entry]);
  });

  it('a comment from a different watched teammate on that same PR still counts', () => {
    const items = parsePrInventoryList(fullListJson);
    const pr2019 = items.find((i) => i.number === 2019)!;
    const withTeammateComment: PrInventoryItem = {
      ...pr2019,
      comments: [...pr2019.comments, { author: { login: 'carol' }, createdAt: '2026-09-05T00:00:00.000Z' }],
    };
    const [entry] = buildEntries(
      'aplaceformom/grace-frontend',
      [withTeammateComment],
      [],
      { me: 'someone-else', watchAuthors: ['austinbrownapfm', 'carol'] },
      NOW,
    );
    expect(entry.teamActivity).toEqual([
      { login: 'carol', kind: 'comment', at: '2026-09-05T00:00:00.000Z' },
    ]);
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

  it('ours is failed (not reviewed) for a failed review session', () => {
    const item = prItem({ number: 5 });
    const session = reviewSession({ stageStatus: 'failed', number: 5 });
    const [entry] = buildEntries('acme/app', [item], [session], { me: 'me-user', watchAuthors: [] }, NOW);
    expect(entry.ours.status).toBe('failed');
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
      {
        ...baseEntry(5),
        isMine: false,
        ours: { status: 'failed', sessionId: 's2', reviewedSha: null, newCommits: false, phase: 'failed' },
      },
    ];
    const inv: Inventory = { scannedAt: NOW, repos: ['acme/app'], entries, errors: [] };
    const groups = groupInventory(inv);

    expect(groups.mine.map((e) => e.number)).toEqual([1]);
    expect(groups.ours.map((e) => e.number)).toEqual([2, 5]);
    expect(groups.teamOnIt.map((e) => e.number)).toEqual([3]);
    expect(groups.unreviewed.map((e) => e.number)).toEqual([4]);

    const nonMine = entries.filter((e) => !e.isMine);
    const partitioned = [...groups.unreviewed, ...groups.teamOnIt, ...groups.ours];
    expect(partitioned.length).toBe(nonMine.length);
    expect(new Set(partitioned.map((e) => e.number))).toEqual(new Set(nonMine.map((e) => e.number)));
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A1 — humanActivity, branch, ticketKeys, reviewRequests and the
// age/size/CI/labels fields (R47, R53, R58, R59, R60).
// ---------------------------------------------------------------------------

const PHASE9_CFG = { me: 'me-user', watchAuthors: [] as string[], projectKeys: ['HB', 'GRAC'] };

describe('buildEntries: humanActivity (MG-3, R6 as amended by R47)', () => {
  it('a PR reviewed and commented only by bots has no human activity', () => {
    const item = prItem({
      number: 10,
      reviews: [review('dependabot[bot]', 'COMMENTED', '2026-09-01T00:00:00Z')],
      comments: [comment('github-actions', '2026-09-02T00:00:00Z')],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
  });

  it('one comment by a non-watched human sets lastAt and lists that login, while teamActivity stays empty', () => {
    const item = prItem({ number: 11, comments: [comment('stranger', '2026-09-03T00:00:00Z')] });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity.commentedBy).toEqual(['stranger']);
    expect(entry.humanActivity.lastAt).toBe('2026-09-03T00:00:00Z');
    expect(entry.teamActivity).toEqual([]);
  });

  it("a comment by the PR's own author alone does not count", () => {
    const item = prItem({ number: 12, author: { login: 'author-x' }, comments: [comment('author-x', '2026-09-03T00:00:00Z')] });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
  });

  it('a review by me does count — if I reviewed it, a human is on it', () => {
    const item = prItem({ number: 13, reviews: [review('me-user', 'APPROVED', '2026-09-04T00:00:00Z')] });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity.reviewedBy).toEqual(['me-user']);
    expect(entry.humanActivity.lastAt).toBe('2026-09-04T00:00:00Z');
  });

  it('lastAt is the newest of the counted timestamps and logins are deduped', () => {
    const item = prItem({
      number: 14,
      reviews: [review('carol', 'COMMENTED', '2026-09-01T00:00:00Z'), review('carol', 'APPROVED', '2026-09-05T00:00:00Z')],
      comments: [comment('dave', '2026-09-03T00:00:00Z')],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity.reviewedBy).toEqual(['carol']);
    expect(entry.humanActivity.commentedBy).toEqual(['dave']);
    expect(entry.humanActivity.lastAt).toBe('2026-09-05T00:00:00Z');
  });

  it('is_bot: true on an activity author is honoured (U1)', () => {
    const item = prItem({
      number: 15,
      reviews: [{ author: { login: 'friendly-helper', is_bot: true }, state: 'COMMENTED', submittedAt: '2026-09-01T00:00:00Z' }],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.humanActivity.reviewedBy).toEqual([]);
  });

  it('config botLogins add to the default bot list', () => {
    const item = prItem({ number: 16, comments: [comment('acme-ci', '2026-09-01T00:00:00Z')] });
    const [entry] = buildEntries('acme/app', [item], [], { ...PHASE9_CFG, botLogins: ['acme-ci'] }, NOW);
    expect(entry.humanActivity.lastAt).toBeNull();
  });
});

describe('buildEntries: branch, ticketKeys and reviewRequests (R29, R30, R60)', () => {
  it('branch is headRefName', () => {
    const [entry] = buildEntries('acme/app', [prItem({ number: 20, headRefName: 'feature/HB-1-x' })], [], PHASE9_CFG, NOW);
    expect(entry.branch).toBe('feature/HB-1-x');
  });

  it('ticketKeys come from branch, then title, then body, deduped in that order', () => {
    const item = prItem({ number: 21, headRefName: 'feature/HB-627-x', title: 'GRAC-12 and HB-627', body: 'also HB-900' });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.ticketKeys).toEqual(['HB-627', 'GRAC-12', 'HB-900']);
  });

  it('R29: a key that appears ONLY in the body is still found (body is named on PrListItemSchema)', () => {
    const parsed = parsePrInventoryList(
      JSON.stringify([
        {
          number: 22,
          url: 'https://github.com/acme/app/pull/22',
          author: { login: 'bob' },
          isDraft: false,
          reviewDecision: '',
          headRefOid: 'a'.repeat(40),
          headRefName: 'no-key-here',
          baseRefName: 'main',
          title: 'no key here either',
          updatedAt: '2026-09-04T00:00:00.000Z',
          body: 'fixes HB-4242 as discussed',
        },
      ]),
    );
    expect(parsed[0].body).toBe('fixes HB-4242 as discussed');
    const [entry] = buildEntries('acme/app', parsed, [], PHASE9_CFG, NOW);
    expect(entry.ticketKeys).toEqual(['HB-4242']);
  });

  it('R46: with projectKeys empty nothing links', () => {
    const item = prItem({ number: 23, headRefName: 'feature/HB-627-x' });
    const [entry] = buildEntries('acme/app', [item], [], { me: 'me-user', watchAuthors: [], projectKeys: [] }, NOW);
    expect(entry.ticketKeys).toEqual([]);
  });

  it('R60: reviewRequests mixing users and teams flattens to logins and team slugs', () => {
    const item = prItem({ number: 24, reviewRequests: [{ login: 'jane' }, { name: 'Web', slug: 'web' }] });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.reviewRequests).toEqual(['jane', 'web']);
  });

  it('R8: body is never a field of the persisted InventoryEntry', () => {
    const item = prItem({ number: 25, body: 'secret body text' });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(Object.keys(entry)).not.toContain('body');
    expect(JSON.stringify(entry)).not.toContain('secret body text');
  });
});

describe('buildEntries: the R53 age/size/CI/labels fields', () => {
  it('createdAt, changedFiles, additions, deletions and labels are carried through verbatim', () => {
    const item = prItem({
      number: 30,
      createdAt: '2026-08-01T00:00:00Z',
      changedFiles: 7,
      additions: 120,
      deletions: 3,
      labels: [{ name: 'bug' }, { name: 'p1' }],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.createdAt).toBe('2026-08-01T00:00:00Z');
    expect(entry.changedFiles).toBe(7);
    expect(entry.additions).toBe(120);
    expect(entry.deletions).toBe(3);
    expect(entry.labels).toEqual(['bug', 'p1']);
  });

  it('statusCheckRollup is collapsed to ci by the existing ciStatus()', () => {
    const failing = prItem({
      number: 31,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    expect(buildEntries('acme/app', [failing], [], PHASE9_CFG, NOW)[0].ci).toBe('failure');
    const empty = prItem({ number: 32, statusCheckRollup: [] });
    expect(buildEntries('acme/app', [empty], [], PHASE9_CFG, NOW)[0].ci).toBe('none');
  });

  it('a gh payload missing all eight new fields still parses and every field takes its default', () => {
    const parsed = parsePrInventoryList(
      JSON.stringify([
        {
          number: 33,
          url: 'https://github.com/acme/app/pull/33',
          author: { login: 'bob' },
          isDraft: false,
          reviewDecision: '',
          headRefOid: 'a'.repeat(40),
          headRefName: 'x',
          baseRefName: 'main',
          title: 't',
          updatedAt: '2026-09-04T00:00:00.000Z',
        },
      ]),
    );
    const [entry] = buildEntries('acme/app', parsed, [], PHASE9_CFG, NOW);
    expect(entry.createdAt).toBeNull();
    expect(entry.changedFiles).toBeNull();
    expect(entry.additions).toBeNull();
    expect(entry.deletions).toBeNull();
    expect(entry.labels).toEqual([]);
    expect(entry.reviewRequests).toEqual([]);
    expect(entry.ci).toBe('none');
    expect(entry.reviewDecisionAt).toBeNull();
  });

  it('R59: a malformed statusCheckRollup yields ci none and never throws', () => {
    const parsed = parsePrInventoryList(
      JSON.stringify([
        {
          number: 34,
          url: 'https://github.com/acme/app/pull/34',
          author: { login: 'bob' },
          isDraft: false,
          reviewDecision: '',
          headRefOid: 'a'.repeat(40),
          headRefName: 'x',
          baseRefName: 'main',
          title: 't',
          updatedAt: '2026-09-04T00:00:00.000Z',
          statusCheckRollup: [{ __typename: 'SomethingElse', weird: true }],
        },
      ]),
    );
    const [entry] = buildEntries('acme/app', parsed, [], PHASE9_CFG, NOW);
    expect(entry.ci).toBe('none');
  });

  it('R60: a malformed reviewRequests array yields [] and never throws', () => {
    const parsed = parsePrInventoryList(
      JSON.stringify([
        {
          number: 35,
          url: 'https://github.com/acme/app/pull/35',
          author: { login: 'bob' },
          isDraft: false,
          reviewDecision: '',
          headRefOid: 'a'.repeat(40),
          headRefName: 'x',
          baseRefName: 'main',
          title: 't',
          updatedAt: '2026-09-04T00:00:00.000Z',
          reviewRequests: [{ unexpected: 1 }],
        },
      ]),
    );
    const [entry] = buildEntries('acme/app', parsed, [], PHASE9_CFG, NOW);
    expect(entry.reviewRequests).toEqual([]);
  });
});

describe('buildEntries: reviewDecisionAt (R58)', () => {
  it('is the submittedAt of the newest review whose state matches the current reviewDecision', () => {
    const item = prItem({
      number: 40,
      reviewDecision: 'APPROVED',
      reviews: [
        review('carol', 'APPROVED', '2026-09-01T00:00:00Z'),
        review('dave', 'APPROVED', '2026-09-04T00:00:00Z'),
        review('erin', 'COMMENTED', '2026-09-05T00:00:00Z'),
      ],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.reviewDecisionAt).toBe('2026-09-04T00:00:00Z');
  });

  it('on a mixed PR it is the newer CHANGES_REQUESTED review, not the older APPROVED one', () => {
    const item = prItem({
      number: 41,
      reviewDecision: 'CHANGES_REQUESTED',
      reviews: [
        review('carol', 'APPROVED', '2026-09-01T00:00:00Z'),
        review('dave', 'CHANGES_REQUESTED', '2026-09-04T00:00:00Z'),
      ],
    });
    const [entry] = buildEntries('acme/app', [item], [], PHASE9_CFG, NOW);
    expect(entry.reviewDecisionAt).toBe('2026-09-04T00:00:00Z');
  });

  it('is null when the decision is empty or REVIEW_REQUIRED, or when no review matches', () => {
    for (const decision of ['', 'REVIEW_REQUIRED'] as const) {
      const item = prItem({ number: 42, reviewDecision: decision, reviews: [review('carol', 'APPROVED', '2026-09-01T00:00:00Z')] });
      expect(buildEntries('acme/app', [item], [], PHASE9_CFG, NOW)[0].reviewDecisionAt).toBeNull();
    }
    const noMatch = prItem({ number: 43, reviewDecision: 'APPROVED', reviews: [review('carol', 'COMMENTED', '2026-09-01T00:00:00Z')] });
    expect(buildEntries('acme/app', [noMatch], [], PHASE9_CFG, NOW)[0].reviewDecisionAt).toBeNull();
  });

  it('a push with no new review does not change it', () => {
    const before = prItem({
      number: 44,
      reviewDecision: 'APPROVED',
      reviews: [review('carol', 'APPROVED', '2026-09-01T00:00:00Z')],
    });
    const after = { ...before, updatedAt: '2026-09-09T00:00:00Z', headRefOid: 'b'.repeat(40) };
    const a = buildEntries('acme/app', [before], [], PHASE9_CFG, NOW)[0];
    const b = buildEntries('acme/app', [after], [], PHASE9_CFG, NOW)[0];
    expect(b.reviewDecisionAt).toBe(a.reviewDecisionAt);
  });
});

describe('buildEntries: the THREAD half of humanActivity (MG-3, R52)', () => {
  const threads = (comments: Array<{ login: string; at: string }>) =>
    new Map([[`acme/app#70`, comments]]);

  it('a non-bot, non-author thread reply sets lastAt and lists that login', () => {
    const item = prItem({ number: 70 });
    const [entry] = buildEntries(
      'acme/app',
      [item],
      [],
      { ...PHASE9_CFG, threadComments: threads([{ login: 'jane', at: '2026-09-06T00:00:00Z' }]) },
      NOW,
    );
    expect(entry.humanActivity.commentedBy).toEqual(['jane']);
    expect(entry.humanActivity.lastAt).toBe('2026-09-06T00:00:00Z');
  });

  it('a BOT thread reply does not', () => {
    const item = prItem({ number: 70 });
    const [entry] = buildEntries(
      'acme/app',
      [item],
      [],
      { ...PHASE9_CFG, threadComments: threads([{ login: 'github-actions', at: '2026-09-06T00:00:00Z' }]) },
      NOW,
    );
    expect(entry.humanActivity.lastAt).toBeNull();
  });

  it("the PR author's own thread reply does not", () => {
    const item = prItem({ number: 70, author: { login: 'author-x' } });
    const [entry] = buildEntries(
      'acme/app',
      [item],
      [],
      { ...PHASE9_CFG, threadComments: threads([{ login: 'author-x', at: '2026-09-06T00:00:00Z' }]) },
      NOW,
    );
    expect(entry.humanActivity.lastAt).toBeNull();
  });
});
