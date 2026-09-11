import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { InventoryScanner, type InventoryScannerDeps } from '../../src/inventory/inventory-scanner';
import { InventoryStore } from '../../src/inventory/inventory-store';
import { buildEntries } from '../../src/inventory/inventory';
import { parsePrInventoryList } from '../../src/gh/pr-view';
import { PR_INVENTORY_FIELDS, PR_INVENTORY_FIELDS_SCALARS, PR_INVENTORY_FIELDS_CONNECTIONS } from '../../src/gh/pr-view';
import { GhCommandError } from '../../src/gh/gh-runner';
import { SessionStore } from '../../src/engine/session-store';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { Inventory } from '../../src/inventory/inventory';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { ReviewThreadCache, ThreadScanCandidate } from '../../src/gh/review-threads';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const fullListJson = readFileSync(path.join(fixturesDir, 'pr-list-full.json'), 'utf8');
const baseView = JSON.parse(readFileSync(path.join(fixturesDir, 'pr-view-open-approved.json'), 'utf8'));

const REPO = 'aplaceformom/grace-frontend';

function scannerConfig(overrides: Partial<InventoryScannerDeps['config']> = {}): InventoryScannerDeps['config'] {
  return { repos: [REPO], me: 'me-user', watchAuthors: [], prListLimit: 50, ...overrides };
}

function buildScanner(config: InventoryScannerDeps['config'] = scannerConfig()) {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const lock = new KeyedLock();
  const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
  const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
  const scanner = new InventoryScanner({
    gh,
    store: h.store,
    inventoryStore,
    reconciler: { reconcile: () => reconciliationTick.run() },
    events: h.events,
    config,
    now: FIXED_NOW,
  });
  return { h, gh, lock, inventoryStore, scanner };
}

function reviewSession(overrides: {
  id?: string;
  repo?: string;
  number?: number;
  reviewedSha?: string | null;
} = {}): ReviewSession {
  const id = overrides.id ?? 'pr-app-2010-x';
  const repo = overrides.repo ?? REPO;
  const number = overrides.number ?? 2010;
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git`, worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'ready',
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

function viewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...baseView, ...overrides });
}

function inventoryItem(number: number, repo: string) {
  return {
    number, url: `https://github.com/${repo}/pull/${number}`, author: { login: 'bob' },
    isDraft: false, reviewDecision: '', headRefOid: 'a'.repeat(40), headRefName: 'feature',
    baseRefName: 'main', title: 't', updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [], reviews: [], comments: [],
  };
}

describe('InventoryScanner', () => {
  it('pins the gh pr list argv per repo using PR_INVENTORY_FIELDS', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    expect(gh.calls).toEqual([
      ['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50', '--json', PR_INVENTORY_FIELDS],
    ]);
  });

  it('mutation guard: a scan over 6 unreviewed PRs with no existing sessions creates zero sessions and starts zero runs', async () => {
    const { h, gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.entries.length).toBe(6);
    expect(await h.store.list()).toEqual([]);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('persists inventory.json equal to the report, and emits inventory.updated exactly once with the same inventory', async () => {
    const { h, gh, scanner, inventoryStore } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    const emitted: Inventory[] = [];
    h.events.on('inventory.updated', (e) => emitted.push(e.inventory));
    const report = await scanner.run();
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toEqual(report.inventory);
    const loaded = await inventoryStore.load();
    expect(loaded).toEqual(report.inventory);
  });

  it('keeps the lastReport getter in sync with the most recent run', async () => {
    const { gh, scanner } = buildScanner();
    expect(scanner.lastReport).toBeNull();
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(scanner.lastReport).toEqual(report);
  });

  it('isolates a per-repo gh failure into inventory.errors without failing the whole scan', async () => {
    const { gh, scanner } = buildScanner(scannerConfig({ repos: ['acme/broken', REPO] }));
    gh.queueResponse(new Error('gh: rate limited'));
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.errors).toEqual([
      { repo: 'acme/broken', error: expect.stringContaining('rate limited') },
    ]);
    expect(report.inventory.entries.length).toBe(6);
    expect(report.inventory.repos).toEqual(['acme/broken', REPO]);
  });

  it('starts a rereview for a ready session with a new head sha, via the reconciler (existing behavior preserved)', async () => {
    const { h, gh, scanner } = buildScanner();
    const review = reviewSession({ reviewedSha: 'a'.repeat(40) });
    await h.store.save(review);
    await h.workspace.createWorkspace({
      repoUrl: `https://github.com/${REPO}.git`,
      worktreePath: `${WORKTREES_DIR}/${review.id}`,
      branchName: 'pr-2010',
      baseRef: 'origin/pr/2010',
      mode: 'review',
    });
    const newSha = 'c'.repeat(40);
    gh.queueResponse({
      stdout: viewJson({
        number: 2010, url: `https://github.com/${REPO}/pull/2010`, headRefOid: newSha, reviewDecision: '',
      }),
    });
    gh.queueResponse({ stdout: fullListJson });
    h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // runRereview's rev-parse HEAD

    const report = await scanner.run();

    expect(report.reconciliation.actions).toContainEqual(
      expect.objectContaining({ type: 'rereview', sessionId: review.id }),
    );
    expect((await h.store.load(review.id)).stageStatus).toBe('reviewing');

    // F5/M2: the scan's own store.list() must happen AFTER reconcile, so
    // this SAME tick's inventory reflects the fresh 'reviewing' phase — not
    // the stale 'ready' snapshot taken before the rereview transitioned it.
    const entry2010 = report.inventory.entries.find((e) => e.number === 2010);
    expect(entry2010?.ours.status).toBe('reviewing');
  });

  it('never throws when the fresh store.list() call rejects; the error lands in inventory.errors', async () => {
    class FailingStore extends SessionStore {
      list(): Promise<Session[]> {
        return Promise.reject(new Error('disk error'));
      }
    }
    const h = createHarness();
    const failingStore = new FailingStore(h.fs, SESSIONS_DIR);
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: failingStore, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    gh.queueResponse({ stdout: fullListJson });
    const scanner = new InventoryScanner({
      gh,
      store: failingStore,
      inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig(),
      now: FIXED_NOW,
    });

    const report = await scanner.run();

    expect(report.inventory.errors.some((e) => e.error.includes('disk error'))).toBe(true);
    expect(report.reconciliation.errors.some((e) => e.error.includes('disk error'))).toBe(true);
  });

  it('F1: a per-repo gh failure carries forward that repo\'s previous entries (with their old seenAt), not dropping them', async () => {
    const REPO2 = 'acme/other';
    let call = 0;
    const now = () => (call++ === 0 ? new Date('2026-09-04T18:00:00.000Z') : new Date('2026-09-04T19:00:00.000Z'));
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    const scanner = new InventoryScanner({
      gh, store: h.store, inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig({ repos: [REPO, REPO2] }),
      now,
    });

    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse({ stdout: JSON.stringify([inventoryItem(99, REPO2)]) });
    const report1 = await scanner.run();
    const first99 = report1.inventory.entries.find((e) => e.number === 99);
    expect(first99?.seenAt).toBe('2026-09-04T18:00:00.000Z');

    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse(new Error('gh: rate limited'));
    const report2 = await scanner.run();

    expect(report2.inventory.errors).toEqual([{ repo: REPO2, error: expect.stringContaining('rate limited') }]);
    const carried99 = report2.inventory.entries.find((e) => e.number === 99 && e.repo === REPO2);
    expect(carried99?.seenAt).toBe('2026-09-04T18:00:00.000Z'); // preserved, not overwritten
    const repoEntry = report2.inventory.entries.find((e) => e.repo === REPO && e.number === 1974);
    expect(repoEntry?.seenAt).toBe('2026-09-04T19:00:00.000Z'); // the healthy repo still gets the new timestamp
  });

  it('F3: never throws when inventoryStore.save rejects; the error lands in inventory.errors and inventory.updated still fires', async () => {
    class FailingInventoryStore extends InventoryStore {
      save(): Promise<void> {
        return Promise.reject(new Error('disk full'));
      }
    }
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const failingInventoryStore = new FailingInventoryStore(h.fs, '/state/inventory.json');
    gh.queueResponse({ stdout: fullListJson });
    const scanner = new InventoryScanner({
      gh, store: h.store, inventoryStore: failingInventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events, config: scannerConfig(), now: FIXED_NOW,
    });
    const emitted: Inventory[] = [];
    h.events.on('inventory.updated', (e) => emitted.push(e.inventory));

    const report = await scanner.run();

    expect(report.inventory.errors.some((e) => e.repo === '*' && e.error.includes('disk full'))).toBe(true);
    expect(emitted.length).toBe(1);
    expect(scanner.lastReport).toEqual(report);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A1 — R67: gh pr list can trip GitHub's GraphQL node limit.
// ---------------------------------------------------------------------------

describe('InventoryScanner: the node-limit fallback (R67)', () => {
  const scalarsJson = JSON.stringify([
    {
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      author: { login: 'bob' },
      isDraft: false,
      reviewDecision: '',
      headRefOid: 'a'.repeat(40),
      headRefName: 'feature/HB-7-x',
      baseRefName: 'main',
      title: 't',
      updatedAt: '2026-09-04T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00Z',
      changedFiles: 3,
      additions: 10,
      deletions: 1,
      labels: [{ name: 'bug' }],
      reviewRequests: [{ login: 'jane' }],
      body: 'nothing here',
    },
  ]);
  const connectionsJson = JSON.stringify([
    {
      number: 7,
      latestReviews: [],
      reviews: [{ author: { login: 'carol' }, state: 'COMMENTED', submittedAt: '2026-09-02T00:00:00Z' }],
      comments: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
  ]);

  it('issues exactly one gh pr list call on the happy path', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list').length).toBe(1);
  });

  it('a MAX_NODE_LIMIT_EXCEEDED stderr makes it issue exactly the two partitioned calls, joined on number', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'GraphQL: MAX_NODE_LIMIT_EXCEEDED something'));
    gh.queueResponse({ stdout: scalarsJson });
    gh.queueResponse({ stdout: connectionsJson });
    const report = await scanner.run();

    const listCalls = gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list');
    expect(listCalls.length).toBe(3);
    expect(listCalls[1][listCalls[1].indexOf('--json') + 1]).toBe(PR_INVENTORY_FIELDS_SCALARS);
    expect(listCalls[2][listCalls[2].indexOf('--json') + 1]).toBe(PR_INVENTORY_FIELDS_CONNECTIONS);

    expect(report.inventory.errors).toEqual([]);
    const [entry] = report.inventory.entries;
    expect(entry.number).toBe(7);
    expect(entry.changedFiles).toBe(3);
    expect(entry.ci).toBe('success');
    expect(entry.humanActivity.reviewedBy).toEqual(['carol']);
    expect(entry.reviewRequests).toEqual(['jane']);
    expect(entry.ticketKeys).toEqual([]);
  });

  it('a second limit error on the partitioned call falls back to the previous scan, and never issues a fourth call', async () => {
    const { gh, scanner, inventoryStore } = buildScanner();
    const previous: Inventory = {
      scannedAt: '2026-09-03T00:00:00.000Z',
      repos: [REPO],
      entries: [
        {
          repo: REPO,
          number: 99,
          url: `https://github.com/${REPO}/pull/99`,
          title: 'yesterday',
          author: 'bob',
          isDraft: false,
          headSha: 'a'.repeat(40),
          baseRef: 'main',
          updatedAt: '2026-09-03T00:00:00.000Z',
          reviewDecision: '',
          isMine: false,
          teamActivity: [],
          ours: { status: 'none' },
          seenAt: '2026-09-03T00:00:00.000Z',
          branch: null,
          ticketKeys: [],
          reviewRequests: [],
          humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null },
          createdAt: null,
          changedFiles: null,
          additions: null,
          deletions: null,
          ci: 'none',
          labels: [],
          reviewDecisionAt: null,
        },
      ],
      errors: [],
    };
    await inventoryStore.save(previous);
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'GraphQL: MAX_NODE_LIMIT_EXCEEDED'));
    gh.queueResponse({ stdout: scalarsJson });
    gh.queueResponse(new GhCommandError(['pr', 'list'], 1, 'exceeds the maximum node limit'));
    const report = await scanner.run();

    expect(gh.calls.filter((c) => c[0] === 'pr' && c[1] === 'list').length).toBe(3);
    expect(report.inventory.entries.map((e) => e.number)).toEqual([99]);
    expect(report.inventory.errors.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A2 — the recorded `gh pr list` sample that closes U1 and U6.
//
// Recorded 2026-09-10 by hand:
//   gh pr list --repo aplaceformom/grace-frontend --state open --limit 30 \
//     --json <PR_INVENTORY_FIELDS>
// Three PRs kept verbatim except that every `body` (the PR's and each
// review's/comment's) is truncated — nothing structural is redacted.
//
// THE ANSWER TO U1: an activity author on `gh pr list --json reviews,comments`
// carries ONLY `login`. `is_bot` appears on the PR-level `author` object and
// NOWHERE else. So R5's clause (a) never fires on this data and the
// `[bot]`-suffix + `botLogins` fallback is the only thing that works —
// which matters, because the bots on these PRs (`vercel`, `github-actions`,
// `gitstream-cm`, `apfm-sonar`) carry no `[bot]` suffix either.
//
// THE ANSWER TO U6: `statusCheckRollup` on `gh pr list` is the SAME
// CheckRun/StatusContext union `gh pr view` emits (plus a `startedAt` the
// schema strips), so R59's `.catch([])` was NOT load-bearing for the shape —
// it stays as the cheap insurance it was meant to be. `reviewRequests`,
// however, came back as TEAMS (`{ __typename, name, slug }`) on every single
// PR: R60's union IS load-bearing, and `z.array(z.object({ login }))` would
// have thrown on the first row. A 32-PR repo did not trip the node limit at
// `--limit 100` (R67's fallback stays untested against real data — smoke).
// ---------------------------------------------------------------------------

describe('the recorded gh pr list sample (A2: U1, U6, R59, R60)', () => {
  const sampleJson = readFileSync(path.join(fixturesDir, 'pr-list-with-bot-reviews.json'), 'utf8');

  it('U1: no activity author in the real sample carries is_bot', () => {
    const raw = JSON.parse(sampleJson) as Array<{
      author: Record<string, unknown>;
      reviews: Array<{ author: Record<string, unknown> }>;
      comments: Array<{ author: Record<string, unknown> }>;
    }>;
    expect(raw.length).toBeGreaterThan(0);
    // the PR-level author does carry it...
    expect(raw.every((pr) => 'is_bot' in pr.author)).toBe(true);
    // ...and no review or comment author does.
    const activityAuthors = raw.flatMap((pr) => [...pr.reviews, ...pr.comments].map((a) => a.author));
    expect(activityAuthors.length).toBeGreaterThan(0);
    expect(activityAuthors.some((a) => 'is_bot' in a)).toBe(false);
  });

  it('the widened field set parses, and the suffix/list bot rule carries the whole load', () => {
    const items = parsePrInventoryList(sampleJson);
    expect(items.map((i) => i.number)).toEqual([2046, 2043, 1974]);
    const entries = buildEntries(REPO, items, [], { me: 'me-user', watchAuthors: [], projectKeys: [] }, FIXED_NOW().toISOString());

    // 2046: reviewed by its own author plus `gitstream-cm`, commented on by
    // `vercel`, `github-actions` and `apfm-sonar`. The two default-list bots
    // are excluded; the author is excluded; the two bots this repo runs that
    // are NOT in the default list are (correctly, per the data) counted as
    // humans until `config.botLogins` names them.
    const e2046 = entries[0];
    expect(e2046.author).toBe('dbeacham-afpm');
    expect(e2046.humanActivity.reviewedBy).toEqual(['gitstream-cm']);
    expect(e2046.humanActivity.commentedBy).toEqual(['apfm-sonar']);
    expect(e2046.humanActivity.lastAt).not.toBeNull();

    // With those two named in botLogins the PR has no human on it at all —
    // which is what R5's config list exists for.
    const [quiet] = buildEntries(
      REPO,
      [items[0]],
      [],
      { me: 'me-user', watchAuthors: [], projectKeys: [], botLogins: ['gitstream-cm', 'apfm-sonar'] },
      FIXED_NOW().toISOString(),
    );
    expect(quiet.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
  });

  it('U6/R59: the real statusCheckRollup parses into the union and collapses to the right ci', () => {
    const items = parsePrInventoryList(sampleJson);
    expect(items.every((i) => (i.statusCheckRollup ?? []).length > 0)).toBe(true);
    const entries = buildEntries(REPO, items, [], { me: 'me-user', watchAuthors: [] }, FIXED_NOW().toISOString());
    expect(entries.map((e) => e.ci)).toEqual(['success', 'success', 'success']);
  });

  it('R60: reviewRequests came back as TEAMS on every PR and flattens to slugs', () => {
    const raw = JSON.parse(sampleJson) as Array<{ reviewRequests: Array<Record<string, unknown>> }>;
    const shapes = new Set(raw.flatMap((pr) => pr.reviewRequests.map((r) => Object.keys(r).sort().join(','))));
    expect([...shapes]).toEqual(['__typename,name,slug']);
    const entries = buildEntries(
      REPO,
      parsePrInventoryList(sampleJson),
      [],
      { me: 'me-user', watchAuthors: [] },
      FIXED_NOW().toISOString(),
    );
    expect(entries[0].reviewRequests).toEqual([
      'aplaceformom/grace-b2b',
      'aplaceformom/grace-b2c',
      'aplaceformom/grace-data',
    ]);
  });

  it('R53: age, size and labels come through verbatim', () => {
    const entries = buildEntries(
      REPO,
      parsePrInventoryList(sampleJson),
      [],
      { me: 'me-user', watchAuthors: [] },
      FIXED_NOW().toISOString(),
    );
    expect(entries[0].createdAt).toBe('2026-09-10T18:57:44Z');
    expect(entries[0].changedFiles).toBe(26);
    expect(entries[0].labels).toEqual(['missing-tests', '20 min review']);
    expect(entries[2].isDraft).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A5 — the Jira leg is folded into the tick, AFTER the PR half
// is published, on its own budget, and never blocks POST /prs/scan (R34).
// ---------------------------------------------------------------------------

describe('InventoryScanner: the Jira leg (R34, R12)', () => {
  function fakeJiraLeg(behaviour: { hang?: boolean; report?: JiraScanReport } = {}) {
    let flight: Promise<void> | null = null;
    let release: (() => void) | null = null;
    const runs: number[] = [];
    const last: JiraScanReport = behaviour.report ?? {
      scannedAt: '2026-09-09T00:00:00.000Z',
      me: '712020:me',
      issues: [],
      error: null,
      kind: 'ok',
    };
    return {
      runs,
      releaseLeg: () => release?.(),
      leg: {
        run: async (): Promise<JiraScanReport> => {
          runs.push(Date.now());
          if (behaviour.hang === true) {
            if (flight === null) {
              flight = new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            await flight;
          }
          return last;
        },
        inFlight: () => flight,
        lastReport: async () => last,
      },
    };
  }

  function buildWithJira(leg: ReturnType<typeof fakeJiraLeg>['leg'], events: string[]) {
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    h.events.on('inventory.updated', () => events.push('inventory.updated'));
    const scanner = new InventoryScanner({
      gh,
      store: h.store,
      inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig(),
      now: FIXED_NOW,
      jira: leg,
    });
    return { h, gh, scanner };
  }

  it('emits inventory.updated BEFORE the Jira leg starts', async () => {
    const order: string[] = [];
    const { leg } = fakeJiraLeg();
    const wrapped = {
      ...leg,
      run: async () => {
        order.push('jira.leg');
        return leg.run();
      },
    };
    const { gh, scanner } = buildWithJira(wrapped, order);
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    await scanner.stop();
    expect(order).toEqual(['inventory.updated', 'jira.leg']);
  });

  it('run() resolves without awaiting the leg, so a hung Jira cannot delay POST /prs/scan', async () => {
    const fake = fakeJiraLeg({ hang: true });
    const { gh, scanner } = buildWithJira(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.entries.length).toBeGreaterThan(0);
    expect(fake.leg.inFlight()).not.toBeNull();
    fake.releaseLeg();
    await scanner.stop();
  });

  it('ScanReport.jira is the LAST COMPLETED report — the cache on a cold start', async () => {
    const cached: JiraScanReport = {
      scannedAt: '2026-09-09T00:00:00.000Z',
      me: '712020:me',
      issues: [
        {
          key: 'HB-627',
          summary: 's',
          status: 'In Progress',
          statusCategory: 'indeterminate',
          assignee: '712020:me',
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-627',
        },
      ],
      error: null,
      kind: 'ok',
    };
    const fake = fakeJiraLeg({ hang: true, report: cached });
    const { gh, scanner } = buildWithJira(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.jira.issues.map((i) => i.key)).toEqual(['HB-627']);
    fake.releaseLeg();
    await scanner.stop();
  });

  it('a tick starting during an in-flight leg starts NO second leg, and stop() awaits the one in flight', async () => {
    const fake = fakeJiraLeg({ hang: true });
    const { gh, scanner } = buildWithJira(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    await scanner.run();
    expect(fake.runs.length).toBe(1);

    let drained = false;
    const stopping = scanner.stop().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    fake.releaseLeg();
    await stopping;
    expect(drained).toBe(true);
  });

  it('a jira failure never affects the PR entries', async () => {
    const leg = {
      run: async (): Promise<JiraScanReport> => {
        throw new Error('jira exploded');
      },
      inFlight: () => null,
      lastReport: async (): Promise<JiraScanReport> => ({
        scannedAt: '2026-09-09T00:00:00.000Z',
        me: null,
        issues: [],
        error: 'stale',
        kind: 'unavailable',
      }),
    };
    const { gh, scanner } = buildWithJira(leg, []);
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.inventory.entries.length).toBeGreaterThan(0);
    expect(report.jira.kind).toBe('unavailable');
    await scanner.stop();
  });

  it('with no jira leg wired at all the report still carries a notConfigured jira block', async () => {
    const { gh, scanner } = buildScanner();
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    expect(report.jira).toEqual({ scannedAt: expect.any(String), me: null, issues: [], error: null, kind: 'notConfigured' });
    await scanner.stop();
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A8 — the review-thread leg, on R34's discipline.
// ---------------------------------------------------------------------------

describe('InventoryScanner: the review-thread leg (R52, R34 applied)', () => {
  function fakeThreadLeg(behaviour: { hang?: boolean; cache?: ReviewThreadCache } = {}) {
    let flight: Promise<void> | null = null;
    let release: (() => void) | null = null;
    const runs: ThreadScanCandidate[][] = [];
    return {
      runs,
      releaseLeg: () => release?.(),
      leg: {
        run: async (candidates: readonly ThreadScanCandidate[]): Promise<void> => {
          runs.push([...candidates]);
          if (behaviour.hang === true) {
            flight ??= new Promise<void>((resolve) => {
              release = resolve;
            });
            await flight;
          }
        },
        inFlight: () => flight,
        lastReport: () => ({ scannedAt: '2026-09-10T00:00:00.000Z', error: null, fetched: 0 }),
        cached: async () => behaviour.cache ?? {},
      },
    };
  }

  function buildWithThreads(leg: ReturnType<typeof fakeThreadLeg>['leg'], order: string[]) {
    const h = createHarness();
    const gh = new FakeGhRunner();
    const lock = new KeyedLock();
    const reconciliationTick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock });
    const inventoryStore = new InventoryStore(h.fs, '/state/inventory.json');
    h.events.on('inventory.updated', () => order.push('inventory.updated'));
    const scanner = new InventoryScanner({
      gh,
      store: h.store,
      inventoryStore,
      reconciler: { reconcile: () => reconciliationTick.run() },
      events: h.events,
      config: scannerConfig(),
      now: FIXED_NOW,
      threads: leg,
    });
    return { h, gh, scanner };
  }

  it('the leg runs AFTER inventory.updated and is not awaited by run()', async () => {
    const order: string[] = [];
    const fake = fakeThreadLeg({ hang: true });
    const wrapped = {
      ...fake.leg,
      run: async (c: readonly ThreadScanCandidate[]) => {
        order.push('threads.leg');
        return fake.leg.run(c);
      },
    };
    const { gh, scanner } = buildWithThreads(wrapped, order);
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    expect(order).toEqual(['inventory.updated', 'threads.leg']);
    expect(fake.leg.inFlight()).not.toBeNull();
    fake.releaseLeg();
    await scanner.stop();
  });

  it('stop() drains the in-flight thread leg', async () => {
    const fake = fakeThreadLeg({ hang: true });
    const { gh, scanner } = buildWithThreads(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    let drained = false;
    const stopping = scanner.stop().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);
    fake.releaseLeg();
    await stopping;
    expect(drained).toBe(true);
  });

  it('a tick during an in-flight leg starts no second one', async () => {
    const fake = fakeThreadLeg({ hang: true });
    const { gh, scanner } = buildWithThreads(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    await scanner.run();
    expect(fake.runs.length).toBe(1);
    fake.releaseLeg();
    await scanner.stop();
  });

  it("the leg's candidates carry the R52 policy inputs", async () => {
    const fake = fakeThreadLeg();
    const { gh, scanner } = buildWithThreads(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    await scanner.run();
    await scanner.stop();
    const [candidates] = fake.runs;
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual(['hasHumanActivity', 'isDraft', 'isMine', 'number', 'repo', 'updatedAt']);
    }
  });

  it('the cached threads reach humanActivity on the NEXT scan, and ScanReport carries threads', async () => {
    const cache: ReviewThreadCache = {
      [`${REPO}#2010`]: {
        updatedAt: 'x',
        threads: [
          {
            id: 't1',
            isResolved: false,
            isOutdated: false,
            path: 'a.ts',
            line: 1,
            truncated: false,
            comments: [
              { author: 'a-real-human', body: 'b', createdAt: '2026-09-09T00:00:00Z', url: 'u' },
            ],
          },
        ],
      },
    };
    const fake = fakeThreadLeg({ cache });
    const { gh, scanner } = buildWithThreads(fake.leg, []);
    gh.queueResponse({ stdout: fullListJson });
    const report = await scanner.run();
    await scanner.stop();
    const entry = report.inventory.entries.find((e) => e.number === 2010)!;
    expect(entry.humanActivity.commentedBy).toContain('a-real-human');
    expect(report.threads).toEqual({ scannedAt: '2026-09-10T00:00:00.000Z', error: null, fetched: 0 });
  });
});
