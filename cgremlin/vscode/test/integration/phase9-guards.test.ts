/**
 * Phase 9's two end-to-end guards — the ones whose whole point is what a REAL engine does on a
 * REAL state dir, and which therefore cannot be asserted inside either package alone.
 *
 *  - **MG-7 / R45**: the first launch after the upgrade. `InventoryStore.load` re-parses and
 *    throws `InventoryCorruptError`, and `loadCurrentInventory` has no catch — so one required
 *    field added to `InventoryEntrySchema` 500s `GET /prs` for everybody with an inventory on
 *    disk. The core asserts the schema; this asserts the route, over the committed fixture the
 *    core's own test uses, which is also what keeps the two copies from drifting.
 *  - **MG-11 / R46**: no `jira.projectKeys`, no ticket linking at all — said once per process,
 *    not once per PR.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  coreIsBuilt,
  SKIP_REASON,
  startEngineViaManager,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

const TIMEOUT = 30_000;

/** The core's own committed pre-Phase-9 document, read across the package boundary on purpose. */
const PRE_PHASE9_INVENTORY: unknown = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../core/test/fixtures/inventory-pre-phase9.json'),
    'utf8',
  ),
);

interface PrsResponse {
  inventory: {
    entries: {
      repo: string;
      number: number;
      branch: string | null;
      ticketKeys: string[];
      reviewRequests: string[];
      humanActivity: { reviewedBy: string[]; commentedBy: string[]; lastAt: string | null };
      createdAt: string | null;
      changedFiles: number | null;
      additions: number | null;
      deletions: number | null;
      ci: string;
      labels: string[];
      reviewDecisionAt: string | null;
    }[];
  };
}

describe.skipIf(!coreIsBuilt())('MG-7: a pre-Phase-9 inventory still loads after the upgrade', () => {
  let h: CoreHarness;

  beforeAll(async () => {
    h = await startEngineViaManager({ inventory: PRE_PHASE9_INVENTORY });
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
  }, TIMEOUT);

  it('answers GET /prs 200 with every new field on its default', async () => {
    // No scan first: a scan would rewrite the file and the upgrade path is exactly the read of
    // what was already there.
    const body = (await h.client.request('GET', '/prs')) as { status: number; body: unknown };
    expect(body.status).toBe(200);
    const entry = (body.body as PrsResponse).inventory.entries[0];
    expect(entry).toMatchObject({ repo: 'acme/app', number: 5 });
    // R45: eleven fields, every one optional-with-a-default.
    expect(entry.branch).toBeNull();
    expect(entry.ticketKeys).toEqual([]);
    expect(entry.reviewRequests).toEqual([]);
    expect(entry.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
    expect(entry.createdAt).toBeNull();
    expect(entry.changedFiles).toBeNull();
    expect(entry.additions).toBeNull();
    expect(entry.deletions).toBeNull();
    expect(entry.ci).toBe('none');
    expect(entry.labels).toEqual([]);
    expect(entry.reviewDecisionAt).toBeNull();
  }, TIMEOUT);

  it('and GET /items renders that row rather than dropping it (MG-12, e2e)', async () => {
    const listing = await h.client.items();
    const item = listing.items.find((candidate) => candidate.id === 'pr:acme/app#5');
    expect(item).toBeDefined();
    // MG-12's core half: the defaults are nulls, never fabricated zeroes.
    expect(item?.prs[0]?.changedFiles).toBeNull();
    expect(item?.prs[0]?.createdAt).toBeNull();
    expect(item?.ticket).toBeNull();
  }, TIMEOUT);
});

describe.skipIf(!coreIsBuilt())('MG-11: no projectKeys, no ticket linking (R46)', () => {
  let h: CoreHarness;

  beforeAll(async () => {
    // No `jira` block at all, so `projectKeys` is the empty default.
    h = await startEngineViaManager();
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
  }, TIMEOUT);

  it('links nothing, and says so exactly once however many scans run', async () => {
    for (let scan = 0; scan < 3; scan += 1) expect((await h.client.scan()).status).toBe(200);
    const listing = await waitUntil(
      () => h.client.items(),
      (current) => current.items.length > 0,
      { timeoutMs: 20_000, what: 'the first listing' },
    );

    // PR #10's branch is `me/APP-9-ticket-linked` and the seeded investigation carries `APP-1`:
    // with linking off, neither becomes a ticket and neither merges into one.
    expect(listing.ticketSource.kind).toBe('notConfigured');
    for (const item of listing.items) expect(item.ticket).toBeNull();
    expect(listing.items.some((item) => item.id === 'pr:fake/repo#10')).toBe(true);
    expect(listing.items.some((item) => item.id.startsWith('ticket:'))).toBe(false);
    for (const item of listing.items) expect(item.prs.every((pr) => pr.repo !== '')).toBe(true);

    // Once per PROCESS — three scans over eleven PRs each is thirty-three chances to say it again.
    const said = h
      .stderr()
      .split('\n')
      .filter((line) => line.includes('ticket linking disabled: set jira.projectKeys in core.json'));
    expect(said).toHaveLength(1);
  }, TIMEOUT);
});

describe.skipIf(coreIsBuilt())('phase 9 guards: skipped', () => {
  it('says why', () => {
    expect(SKIP_REASON).toContain('not built');
  });
});
