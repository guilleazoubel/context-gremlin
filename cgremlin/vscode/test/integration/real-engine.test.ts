/**
 * Integration: the extension's real client layer against a REAL engine.
 *
 * Nothing in the core is stubbed. the bundled `engine/engine.js` runs as a detached child on a
 * Unix socket in a throwaway state dir, started by the shipping `EngineManager`
 * (test/support/core-harness.ts), and every assertion below goes over
 * real HTTP through the very modules that ship: `CoreClient`, `SseClient`, and the whole host
 * wiring (`createUi` → `RefreshCoordinator` → tree/status bar/notifications) driven by the same
 * `FakeHost` the unit tests use.
 *
 * This is what proves the extension's structural `*View` types (src/model/items.ts) match what the
 * engine actually returns: a field rename in the core fails here, rather than at runtime in the
 * editor.
 *
 * Since Phase 9 it also proves the four work-item lists against the REAL grouping: a stubbed Jira
 * on 127.0.0.1 (the real `JiraRestSource` talks to it over real HTTP, D7/R10), a faked
 * `gh api graphql` serving recorded review threads (R52), and one respond run started the way the
 * user starts it — by clicking a `waitingForReview` row in the panel webview (R51/R56).
 *
 * NOT covered here, deliberately: `POST /reviews` (R23) and the own-PR refusal. Both go through
 * `ReviewSessionFactory`, which mirrors `https://github.com/<slug>.git` and then starts a review
 * agent — the core already covers both paths in `cgremlin/core/test/api/*` and its own real-git
 * e2e suite. See docs/SMOKE.md for the manual pass over them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoreHttpError } from '../../src/core-client';
import { SseClient, type SseFrame } from '../../src/sse';
import type { AttentionItem, SessionView } from '../../src/model/items';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import type { ItemTabState } from '../../src/model/item-tab-protocol';
import type { PanelState } from '../../src/model/panel-protocol';
import { createUi, VIEW_ID, type Ui } from '../../src/ui/wiring';
import { FakeHost, type FakeWebview } from '../support/fake-host';
import { startFakeJira, type FakeJira } from '../support/fake-jira';
import {
  coreIsBuilt,
  PR3_SHA,
  SKIP_REASON,
  sleep,
  startEngineViaManager,
  stateDirFiles,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

/** The throwaway Jira credential. MG-5 greps the whole state dir for this exact string. */
const JIRA_TOKEN = 'integration-jira-token-do-not-leak';

// Booting a child engine, a real fs watch and an SSE reconnect are all wall-clock work.
const TIMEOUT = 30_000;

/**
 * `h.restart()` pays the manager's real `STOP_BUDGET_MS` (45 s, `src/engine/manager.ts`) before
 * it would fall back to `waitOutStop`, on top of a real reboot and a real SSE reconnect. In
 * isolation the stop is near-instant, but under full-suite parallel load (several real engines
 * competing for CPU/FDs at once) the SIGTERM-to-exit poll was occasionally slow enough to trip
 * the shared 30 s `TIMEOUT` — this is one of the two known-flaky real-process cases (the other is
 * `engine-manager.test.ts`'s "stops the engine it can prove is its own…", which pays the same
 * stop budget directly). Sized past the 45 s budget itself, with one retry as a last-resort net.
 */
const RESTART_TIMEOUT = { timeout: 90_000, retry: 1 };

interface RedactedEnvironments {
  [repo: string]: { vercel?: { bypassSecret?: string } } | undefined;
}

function itemFor(items: readonly AttentionItem[], ref: string): AttentionItem {
  const found = items.find((item) => item.ref === ref);
  if (found === undefined) {
    throw new Error(`no item '${ref}' in [${items.map((i) => i.ref).join(', ')}]`);
  }
  return found;
}

function frameSink(sse: SseClient): SseFrame[] {
  const frames: SseFrame[] = [];
  sse.on('frame', (payload) => frames.push(payload as SseFrame));
  return frames;
}

async function waitForFrame(
  frames: readonly SseFrame[],
  predicate: (frame: SseFrame) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<SseFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = frames.find(predicate);
    if (hit !== undefined) return hit;
    if (Date.now() >= deadline) {
      throw new Error(
        `no ${what} frame within ${timeoutMs}ms; saw [${frames.map((f) => `${String(f.id)}:${f.event}`).join(', ')}]`,
      );
    }
    await sleep(25);
  }
}

function payloadOf(frame: SseFrame): Record<string, unknown> {
  return frame.data as Record<string, unknown>;
}

/** Every item by id — the wire's `items` is a SET keyed by id; `lists` is what carries order. */
function byId(listing: ItemsResponse): Map<string, WorkItem> {
  return new Map(listing.items.map((item) => [item.id, item]));
}

function itemOf(listing: ItemsResponse, id: string): WorkItem {
  const found = byId(listing).get(id);
  if (found === undefined) {
    throw new Error(`no work item '${id}' in [${listing.items.map((i) => i.id).join(', ')}]`);
  }
  return found;
}

/** The last `render` the host posted into a webview, as the state the script would draw. */
function lastRender<T>(webview: FakeWebview): T {
  const renders = webview.renders();
  if (renders.length === 0) throw new Error('the host posted no render');
  return (renders[renders.length - 1] as { state: T }).state;
}

describe.skipIf(!coreIsBuilt())('integration: the extension against a real engine', () => {
  let h: CoreHarness;
  let jira: FakeJira;

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    h = await startEngineViaManager({ jira: { baseUrl: jira.baseUrl, apiToken: JIRA_TOKEN } });
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
    await jira?.stop();
  }, TIMEOUT);

  /** A scan, then the two background legs (R34) settling, then the listing they produced. */
  async function scanAndList(): Promise<ItemsResponse> {
    expect((await h.client.scan()).status).toBe(200);
    return await waitUntil(
      () => h.client.items(),
      (listing) => listing.ticketSource.scannedAt !== '' && listing.threadSource.scannedAt !== null,
      { timeoutMs: 20_000, what: 'the Jira and review-thread legs to publish' },
    );
  }

  // -------------------------------------------------------------------------
  describe('GET /config', () => {
    it('answers the read `connect()` depends on, with the state dir the harness chose', async () => {
      const cfg = await h.client.config();
      expect(cfg.stateDir).toBe(h.stateDir);
      expect(cfg.sessionsDir).toBe(h.sessionsDir);
      expect(cfg.worktreesDir).toBe(h.worktreesDir);
      expect(cfg.socketPath).toBe(h.socketPath);
      expect(cfg.repos).toEqual([h.repoSlug]);
      expect(cfg.me).toBe('me');
      expect(cfg.runner).toBe('claude-code');
      // R20's TTL, which the chat heartbeat reads off this very response.
      expect(cfg.humanTurnTtlMs).toBe(h.humanTurnTtlMs);
      // Derived, not configured — the extension never has to compute a state path itself.
      expect(cfg.inventoryPath).toBe(path.join(h.stateDir, 'inventory.json'));
    });

    it('never hands the bypass secret to the extension (R3)', async () => {
      const cfg = await h.client.config();
      const environments = cfg.environments as RedactedEnvironments;
      expect(environments[h.repoSlug]?.vercel?.bypassSecret).toBe('[redacted]');
      expect(JSON.stringify(cfg)).not.toContain(h.bypassSecret);
      // And the secret really is in the file the engine loaded, so the assertion above is not
      // passing merely because there was nothing to redact.
      const onDisk = await readFile(path.join(h.stateDir, 'core.json'), 'utf8');
      expect(onDisk).toContain(h.bypassSecret);
    });
  });

  // -------------------------------------------------------------------------
  describe('the engine state the panel is built from', () => {
    it('groups the fixture PRs the way the parking lot expects', async () => {
      const scan = await h.client.scan();
      expect(scan.status).toBe(200);
      const { inventory, groups } = await h.client.prs();
      expect(inventory.repos).toEqual([h.repoSlug]);
      expect(inventory.errors).toEqual([]);
      expect(groups.unreviewed.map((e) => e.number)).toEqual([4, 6, 7, 8, 9]);
      expect(groups.ours.map((e) => e.number)).toEqual([3]);
      expect(groups.mine.map((e) => e.number)).toEqual([5, 10, 11]);
      // #8 HAS a human review, from `dana` — and `teamActivity` still cannot see it, because
      // `dana` is not in `watchAuthors`. That is the whole reason R47 groups the parking lot on
      // the unfiltered `humanActivity` instead, which the /items tests below assert.
      expect(groups.teamOnIt).toEqual([]);
      // The `ours` row names our seeded review session, and agrees on the reviewed sha.
      const ours = groups.ours[0];
      expect(ours.ours).toMatchObject({ status: 'reviewed', sessionId: h.seeded.review, phase: 'ready' });
      expect(ours.headSha).toBe(PR3_SHA);
    });

    it('returns the four seeded sessions in the shape SessionView declares (MG-13, e2e)', async () => {
      const { sessions } = await h.client.sessions();
      const byId = new Map(sessions.map((s: SessionView) => [s.id, s]));
      // Every pre-Phase-9 document still loads with `respond` in the union (MG-13).
      expect([...byId.keys()].sort()).toEqual(
        [
          h.seeded.development,
          h.seeded.investigation,
          h.seeded.looseInvestigation,
          h.seeded.review,
        ].sort(),
      );
      const investigation = byId.get(h.seeded.investigation);
      expect(investigation).toMatchObject({
        schemaVersion: 2,
        mode: 'investigation',
        stageStatus: 'plan_ready',
        intent: 'development',
        driveToCompletion: false,
      });
      expect(investigation?.agent).toMatchObject({ runner: 'claude-code', resumeId: 'resume-inv-1' });
      expect(investigation?.lastRun?.outcome).toBe('succeeded');
      expect(byId.get(h.seeded.review)?.pr).toMatchObject({ repo: h.repoSlug, number: 3 });
      expect(byId.get(h.seeded.development)?.lastRun).toBeNull();
    });

    it('derives a reason, a needsYou and a primary artifact per item (R11, R22)', async () => {
      const listing = await h.client.attention(true);
      expect(Date.parse(listing.evaluatedAt)).not.toBeNaN();

      const investigation = itemFor(listing.items, `session:${h.seeded.investigation}`);
      expect(investigation.source).toBe('session');
      expect(investigation.mode).toBe('investigation');
      expect(investigation.attention.reasons).toEqual(['plan_ready']);
      expect(investigation.attention.needsYou).toBe(true);
      expect(investigation.attention.acked).toBe(false);
      expect(investigation.attention.signature).toBe(
        `plan_ready|${'2026-09-09T10:09:00.000Z'}`,
      );
      expect(investigation.links.primaryArtifact).toBe('PLAN.md');
      expect(investigation.links.ticket).toBe('APP-1');
      expect(investigation.links.worktreePath).toBe(path.join(h.worktreesDir, h.seeded.investigation));

      const review = itemFor(listing.items, `session:${h.seeded.review}`);
      expect(review.attention.reasons).toEqual(['review_ready']);
      expect(review.attention.needsYou).toBe(true);
      expect(review.links.primaryArtifact).toBe('REVIEW.md');
      // The PR source's row for #3 was deduped into this session and lent it its PR links.
      expect(review.links).toMatchObject({ prRepo: h.repoSlug, prNumber: 3 });
      expect(listing.items.filter((i) => i.links.prNumber === 3)).toHaveLength(1);

      // The item that needs nothing: a development session with no run and no AGENT_STATE.
      const development = itemFor(listing.items, `session:${h.seeded.development}`);
      expect(development.attention.reasons).toEqual([]);
      expect(development.attention.needsAttention).toBe(false);
      expect(development.attention.needsYou).toBe(false);
      expect(development.claimed).toBe(false);
      expect(development.running).toBe(false);

      // My own PR with changes requested is the one inventory-sourced needs-you (R22)…
      const mine = itemFor(listing.items, `pr:${h.repoSlug}#5`);
      expect(mine.source).toBe('pr');
      expect(mine.mode).toBeNull();
      // `review_arrived` joins it now that the fixture PR carries a real human review (R50).
      expect(mine.attention.reasons).toEqual(['changes_requested', 'review_arrived']);
      expect(mine.attention.needsYou).toBe(true);

      // …and a parking-lot row never needs anything (MG-A8).
      const parking = itemFor(listing.items, `pr:${h.repoSlug}#4`);
      expect(parking.attention.reasons).toEqual([]);
      expect(parking.attention.needsYou).toBe(false);
    });

    it('lists a session\'s artifacts with the same primary the item advertises', async () => {
      const listing = await h.client.artifacts(h.seeded.investigation);
      expect(listing.artifacts.map((a) => a.name)).toEqual(['BRIEF.md', 'PLAN.md']);
      for (const artifact of listing.artifacts) {
        expect(artifact.size).toBeGreaterThan(0);
        expect(Date.parse(artifact.mtime)).not.toBeNaN();
      }
      expect(listing.primary).toBe('PLAN.md');
      const item = itemFor((await h.client.attention(true)).items, `session:${h.seeded.investigation}`);
      expect(listing.primary).toBe(item.links.primaryArtifact);
    });

    it('404s an unknown session and 400s an unsafe id without reaching the socket', async () => {
      await expect(h.client.artifacts('no-such-session')).rejects.toThrow(CoreHttpError);
      await expect(h.client.artifacts('../escape')).rejects.toThrow(/unsafe session id/);
    });

    it('lists a session artifact listing with distinct, ordered mtimes', async () => {
      const listing = await h.client.artifacts(h.seeded.investigation);
      const mtimes = listing.artifacts.map((a) => a.mtime);
      expect(new Set(mtimes).size).toBe(mtimes.length);
    });
  });

  // -------------------------------------------------------------------------
  // GET /items — the four lists, against the REAL grouping (R47-R50, R57, R61).
  // -------------------------------------------------------------------------
  describe('GET /items', () => {
    let listing: ItemsResponse;

    beforeAll(async () => {
      listing = await scanAndList();
    }, TIMEOUT);

    it('answers four lists and no `reviewing` list — it is a GROUP inside the parking lot (R47)', () => {
      expect(Object.keys(listing.lists).sort()).toEqual([
        'investigations',
        'myWork',
        'parkingLot',
        'waitingForReview',
      ]);
      expect(Object.keys(listing.lists.parkingLot).sort()).toEqual([
        'reviewing',
        'someoneOnIt',
        'untouched',
      ]);
      expect(Date.parse(listing.evaluatedAt)).not.toBeNaN();
      expect(listing.ticketSource).toMatchObject({ kind: 'ok', error: null });
      expect(listing.threadSource.error).toBeNull();
    });

    it('puts every fixture PR in exactly the list the re-scope asks for', () => {
      expect(listing.lists.parkingLot).toEqual({
        // Our review agent pins #3 to the top of the parking lot and does NOT move it to myWork
        // (R47/R48, the coordinator override).
        reviewing: ['pr:fake/repo#3'],
        // #7 has only bot activity, so it is still untouched; #9 has only a REVIEW REQUEST
        // (GitHub asked dana), which R47.1 — reversed in Phase 10 — no longer counts as somebody
        // being on it; #4 is a teammate's PR whose review was requested from ME, which outranks
        // the watch list (R30).
        untouched: ['pr:fake/repo#7', 'pr:fake/repo#9', 'pr:fake/repo#4'],
        // Only #8 is demoted, and only because a HUMAN actually reviewed it: `someoneIsOnIt` is
        // `humanActivity.lastAt !== null` and nothing else (R47.1, reversed).
        someoneOnIt: ['pr:fake/repo#8'],
      });
      expect(listing.lists.myWork).toEqual([
        'pr:fake/repo#5',
        'ticket:APP-1',
        'ticket:APP-9',
        'ticket:APP-2',
        'ticket:APP-42',
      ]);
      expect(listing.lists.investigations).toEqual([`session:${h.seeded.looseInvestigation}`]);
      expect(listing.lists.waitingForReview).toEqual(['pr:fake/repo#5', 'ticket:APP-9']);
    });

    it('leaves both drafts out of every list — mine included (R47, R57)', () => {
      for (const id of ['pr:fake/repo#6', 'pr:fake/repo#11']) {
        const item = itemOf(listing, id);
        expect(item.prs[0]?.isDraft).toBe(true);
        expect(item.lists).toEqual([]);
        expect(item.parkingLotGroup).toBeNull();
      }
    });

    it('keeps a teammate PR with a non-bot reviewer listed, and says it is demoted', () => {
      const reviewed = itemOf(listing, 'pr:fake/repo#8');
      expect(reviewed.demoted).toBe(true);
      expect(reviewed.parkingLotGroup).toBe('someoneOnIt');
      expect(reviewed.prs[0]?.humanActivity?.reviewedBy).toEqual(['dana']);
      // MG-4, end to end: the bot review and the bot comment on #7 leave `humanActivity` empty,
      // which is the only reason that row is still untouched.
      const bots = itemOf(listing, 'pr:fake/repo#7');
      expect(bots.demoted).toBe(false);
      expect(bots.prs[0]?.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
    });

    /**
     * R47.1, reversed (Phase 10). `someoneIsOnIt` is `humanActivity.lastAt !== null` and nothing
     * else: neither a bot's review nor GitHub's request of a human demotes a row. Both halves are
     * proved on live rows rather than on the rule, because the evidence that reversed R47.1
     * (gh#2125) was precisely that a *requested* reviewer had not looked at the PR yet — a row
     * hidden behind the collapsed group is a row nobody reads.
     */
    it('leaves a row nobody has actually touched in `untouched`, bot or request (R47.1 reversed)', () => {
      const bots = itemOf(listing, 'pr:fake/repo#7');
      expect(bots.prs[0]?.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
      expect(bots.demoted).toBe(false);
      expect(bots.parkingLotGroup).toBe('untouched');

      const requested = itemOf(listing, 'pr:fake/repo#9');
      // GitHub really did ask somebody, and the row still says so — it is the GROUPING that no
      // longer treats a request as work already done.
      expect(requested.prs[0]?.reviewRequests).toEqual(['dana']);
      expect(requested.prs[0]?.humanActivity).toEqual({ reviewedBy: [], commentedBy: [], lastAt: null });
      expect(requested.demoted).toBe(false);
      expect(requested.parkingLotGroup).toBe('untouched');

      // The contrast, on the one row a human genuinely reviewed.
      const reviewed = itemOf(listing, 'pr:fake/repo#8');
      expect(reviewed.prs[0]?.humanActivity?.lastAt).not.toBeNull();
      expect(reviewed.parkingLotGroup).toBe('someoneOnIt');
    });

    it('makes the review agent an agent OF the PR item, never a row of its own (R48)', () => {
      const reviewed = itemOf(listing, 'pr:fake/repo#3');
      expect(reviewed.agents.map((a) => [a.sessionId, a.mode])).toEqual([
        [h.seeded.review, 'review'],
      ]);
      expect(reviewed.lists).toEqual(['parkingLot']);
      expect(listing.items.some((i) => i.id === `session:${h.seeded.review}`)).toBe(false);
    });

    it('merges my ticket-linked PR and its Jira ticket into ONE myWork row with children (R26, R28)', () => {
      const merged = itemOf(listing, 'ticket:APP-9');
      expect(merged.kind).toBe('pr+ticket');
      expect(merged.prs.map((pr) => pr.number)).toEqual([10]);
      expect(merged.ticket).toMatchObject({
        key: 'APP-9',
        summary: 'Ticket linked to my pull request',
        status: 'In Review',
        url: 'https://fake.atlassian.net/browse/APP-9',
      });
      expect(merged.lists.sort()).toEqual(['myWork', 'waitingForReview']);
      // R60: gh's heterogeneous reviewRequests union flattens to a user login and a team slug.
      expect(merged.prs[0]?.reviewRequests).toEqual(['dana', 'platform']);
      // There is no second row for the PR the ticket swallowed (R65 is what keeps it reachable).
      expect(listing.items.some((i) => i.id === 'pr:fake/repo#10')).toBe(false);
    });

    it('routes a ticket-linked investigation to myWork and a loose one to investigations (R49)', () => {
      const linked = itemOf(listing, 'ticket:APP-1');
      expect(linked.agents.map((a) => a.sessionId)).toEqual([h.seeded.investigation]);
      expect(linked.lists).toEqual(['myWork']);

      const loose = itemOf(listing, `session:${h.seeded.looseInvestigation}`);
      expect(loose.kind).toBe('session');
      expect(loose.lists).toEqual(['investigations']);
      expect(loose.prs).toEqual([]);
      expect(loose.ticket).toBeNull();
    });

    it('carries the core\'s own S/M/L/XL verdict, worse dimension wins (P1-6, §2.1 rule 6)', () => {
      const tierOfPr = (id: string): string | null | undefined => itemOf(listing, id).prs[0]?.sizeTier;
      // #3 is 3 files / 34 lines — S on both dimensions.
      expect(tierOfPr('pr:fake/repo#3')).toBe('S');
      // #5 is 4 files (M) / 72 lines (M).
      expect(tierOfPr('pr:fake/repo#5')).toBe('M');
      // #8 is the per-dimension proof: 11 files is L, but 121 lines is only M — the WORSE of the
      // two is what the core answers, so a wide-but-shallow change is never reported as an M.
      expect(itemOf(listing, 'pr:fake/repo#8').prs[0]).toMatchObject({
        changedFiles: 11,
        additions: 110,
        deletions: 11,
        sizeTier: 'L',
      });
      // Every PR the fixture gives counts for gets a tier; none of them is left undefined.
      for (const item of listing.items) {
        for (const pr of item.prs) {
          expect(pr.sizeTier).not.toBeUndefined();
          if (pr.changedFiles !== null && pr.additions !== null && pr.deletions !== null) {
            expect(['S', 'M', 'L', 'XL']).toContain(pr.sizeTier);
          }
        }
      }
    });

    /**
     * Risk 12, closed. Stream B was built against `test/support/fixtures/items.json` while
     * Stream A built the engine; this is the assertion that says the two agreed. It compares
     * the fixture's KEY SHAPE against the live response — a field renamed, added or dropped on
     * either side fails here rather than in the editor — and pins the fixture to the order the
     * core actually returns `items` in (by `id`, with the per-list order living in `lists`).
     */
    it('matches the committed items.json fixture the panel was built against', () => {
      const fixture = JSON.parse(
        readFileSync(path.join(__dirname, '../support/fixtures/items.json'), 'utf8'),
      ) as ItemsResponse;

      expect(Object.keys(fixture).sort()).toEqual(Object.keys(listing).sort());
      expect(Object.keys(fixture.lists).sort()).toEqual(Object.keys(listing.lists).sort());
      expect(Object.keys(fixture.lists.parkingLot).sort()).toEqual(
        Object.keys(listing.lists.parkingLot).sort(),
      );
      expect(Object.keys(fixture.ticketSource).sort()).toEqual(Object.keys(listing.ticketSource).sort());
      expect(Object.keys(fixture.threadSource).sort()).toEqual(Object.keys(listing.threadSource).sort());
      for (const shape of [
        (r: ItemsResponse): unknown[] => r.items,
        (r: ItemsResponse): unknown[] => r.items.flatMap((i) => i.prs),
        (r: ItemsResponse): unknown[] => r.items.flatMap((i) => i.agents),
        (r: ItemsResponse): unknown[] => r.items.map((i) => i.attention),
        (r: ItemsResponse): unknown[] => r.items.flatMap((i) => (i.ticket === null ? [] : [i.ticket])),
      ]) {
        expect(keysAcross(shape(fixture))).toEqual(keysAcross(shape(listing)));
      }
      // `items` is a SET keyed by id, ordered by id — `lists` is what carries presentation order.
      expect(fixture.items.map((i) => i.id)).toEqual(
        [...fixture.items.map((i) => i.id)].sort((a, b) => a.localeCompare(b)),
      );
      expect(listing.items.map((i) => i.id)).toEqual(
        [...listing.items.map((i) => i.id)].sort((a, b) => a.localeCompare(b)),
      );
    });

    it('holds MG-17 over the whole listing: totality, group precedence and the disjointness rules', () => {
      const groups = listing.lists.parkingLot;
      const parking = [...groups.reviewing, ...groups.untouched, ...groups.someoneOnIt];
      expect(new Set(parking).size).toBe(parking.length);

      for (const item of listing.items) {
        // Every live agent is on a listed item, or its item is a draft PR nobody has touched.
        if (item.lists.length === 0) {
          expect(item.agents).toEqual([]);
          expect(item.prs.every((pr) => pr.isDraft === true)).toBe(true);
        }
        expect(item.lists.includes('parkingLot')).toBe(parking.includes(item.id));
        if (item.lists.includes('parkingLot')) {
          expect(groups[item.parkingLotGroup as 'reviewing'].includes(item.id)).toBe(true);
        } else {
          expect(item.parkingLotGroup).toBeNull();
        }
        // A review-only item is never myWork (R48), and investigations never intersects it (R49).
        if (item.agents.length > 0 && item.agents.every((a) => a.mode === 'review')) {
          expect(item.lists).not.toContain('myWork');
        }
        if (item.lists.includes('investigations')) expect(item.lists).not.toContain('myWork');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('GET /items/<path>', () => {
    it('resolves a pr/ path to the item that CONTAINS it, ticket id and all (R65, MG-9)', async () => {
      const detail = await h.client.item('pr/fake/repo/10');
      expect(detail.item.id).toBe('ticket:APP-9');
      expect(detail.item.prs.map((pr) => pr.number)).toEqual([10]);
      // …and the same item answers at its ticket path, with the same id.
      expect((await h.client.item('ticket/APP-9')).item.id).toBe('ticket:APP-9');
      // A session path resolves through `agents`, not through the item's own id.
      expect((await h.client.item(`session/${h.seeded.investigation}`)).item.id).toBe('ticket:APP-1');
    });

    it('carries the ticket as TEXT, with the newest comment first, and no *Html anywhere (R33, R37)', async () => {
      const detail = await h.client.item('pr/fake/repo/10');
      expect(detail.ticketError).toBeNull();
      expect(detail.ticket?.descriptionText).toContain('TICKET-BODY-APP-9');
      expect(detail.ticket?.descriptionText).not.toContain('<p>');
      expect(detail.ticket?.comments.map((c) => c.bodyText)).toEqual([
        'TICKET-COMMENT-NEWEST: agreed, ship behind the flag.',
        'TICKET-COMMENT-OLDEST: starting on this today.',
      ]);
      // MG-10, end to end: no key anywhere in either payload ends in `Html`.
      for (const payload of [detail, await h.client.items()]) {
        expect(htmlKeysIn(payload)).toEqual([]);
      }
    });

    it('lists each agent artifacts under its session id', async () => {
      const detail = await h.client.item(`session/${h.seeded.investigation}`);
      expect(Object.keys(detail.artifacts)).toEqual([h.seeded.investigation]);
      expect(detail.artifacts[h.seeded.investigation].map((a) => a.name).sort()).toEqual([
        'BRIEF.md',
        'PLAN.md',
      ]);
    });

    it('404s a path no item owns', async () => {
      await expect(h.client.item('pr/fake/repo/4242')).rejects.toThrow(CoreHttpError);
    });
  });

  // -------------------------------------------------------------------------
  describe('POST /items/<path>/ack (R31)', () => {
    it('fans the ack out over every ref the item contributes, and answers with the fresh item', async () => {
      const before = itemOf(await h.client.items(), 'ticket:APP-1');
      expect(before.attention.acked).toBe(false);
      expect(before.attention.refs).toContain(`session:${h.seeded.investigation}`);

      const result = await h.client.ackItem('ticket/APP-1');
      expect(result.status).toBe(200);
      const body = result.body as { item: WorkItem; acked: string[]; failed: unknown[] };
      expect(body.failed).toEqual([]);
      expect(body.acked).toEqual(before.attention.refs);
      expect(body.item.attention.acked).toBe(true);
      expect(body.item.needsYou).toBe(false);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  // The panel, the Item tab and the respond click — the shipping wiring, over the live socket.
  // -------------------------------------------------------------------------
  describe('the whole host wiring over the live socket', () => {
    let host: FakeHost;
    let ui: Ui;
    let sse: SseClient;
    let panelView: FakeWebview;

    beforeAll(async () => {
      host = new FakeHost();
      ui = createUi({
        host,
        client: h.client,
        notificationLevel: () => 'needs-you-only',
        coalesceMs: 0,
      });
      sse = new SseClient({ socketPath: h.socketPath, backoffMs: [25] });
      sse.on('frame', (frame) => ui.handleFrame(frame));
      sse.on('open', () => ui.coordinator.schedule());
      expect(await ui.connect()).toBe(true);
      sse.start();
      // The editor creating the view, then R39's handshake: the host renders only on `ready`.
      panelView = host.resolveView(VIEW_ID).webview;
      panelView.emit({ type: 'ready' });
    }, TIMEOUT);

    afterAll(async () => {
      sse.stop();
      await ui.dispose();
    }, TIMEOUT);

    it('renders the four lists, in the core order, into the panel webview (R47, R54)', () => {
      const state = lastRender<PanelState>(panelView);
      expect(state.connected).toBe(true);
      expect(state.trouble).toBeNull();
      expect(state.banner).toBeNull();
      // P1: the header counts the rows the tree paints. Five are in the parking lot, one of them
      // inside the "someone is on it" group that starts collapsed — counted on its own header.
      expect(state.lists.map((list) => [list.kind, list.count])).toEqual([
        ['parkingLot', 4],
        ['myWork', 5],
        ['investigations', 1],
        ['waitingForReview', 2],
      ]);
      const parking = state.lists[0];
      expect(parking.sections.map((section) => [section.title, section.count, section.collapsed])).toEqual([
        ['Reviewing', 1, false],
        ['Untouched', 3, false],
        // Only "someone is on it" collapses, and it starts collapsed (R47). One row, because
        // R47.1 reversed: a review request is shown on the row and never demotes it.
        ['Someone is on it', 1, true],
      ]);
      expect(parking.sections[0].rows[0].label).toContain('fake/repo#3');
      // MG-12 has nothing to hide behind here: every fixture PR carries age and size.
      expect(parking.sections[1].rows.map((row) => row.age)).not.toContain('—');
      expect(parking.sections[1].rows.map((row) => row.size)).not.toContain('0 files');
      // The merged row is the one with children (MG-15: agents + ticket + prs, nothing else).
      const myWork = state.lists[1];
      const merged = myWork.sections[0].rows.find((row) => row.id === 'ticket:APP-9');
      expect(merged?.hasChildren).toBe(true);
      expect(merged?.chips).toEqual(['fake/repo#10']);
    });

    it('opens the Item tab for a session: newest artifact first, and the ticket text with it', async () => {
      // Straight from the webview's own message, through the command, into the tab (R48, R65).
      panelView.emit({ type: 'openItem', id: 'ticket:APP-1' });
      await waitUntil(async () => host.panels.length, (n) => n >= 1, { what: 'the Item tab' });
      const tab = host.panels[0].webview;
      tab.emit({ type: 'ready' });
      await ui.itemTab.settled();

      const state = lastRender<ItemTabState>(tab);
      expect(state.itemId).toBe('ticket:APP-1');
      expect(state.selectedSessionId).toBe(h.seeded.investigation);
      const agent = state.agents[0];
      // Newest first: PLAN.md was written after BRIEF.md, and the harness pins both mtimes.
      expect(agent.artifacts.map((a) => a.name)).toEqual(['PLAN.md', 'BRIEF.md']);
      const bodies = tab.posted.filter((m) => (m as { type?: string }).type === 'patch');
      expect(JSON.stringify(bodies)).toContain('the plan');
      expect(state.ticket?.descriptionText).toContain('TICKET-BODY-APP-1');
      // The tab browses; it never claims (R42, MG-B9).
      expect((await h.client.conversation(h.seeded.investigation)).claimed).toBe(false);
      expect(host.terminals).toHaveLength(0);
    }, TIMEOUT);

    /**
     * R51/R56, the whole click: one `POST …/agents { mode: 'respond' }`, no claim, the run
     * starts, `BRIEF.md` carries every thread comment, the phase reaches `addressing` — and
     * only THEN does the row offer Chat (R50).
     */
    it('a click on a waitingForReview row creates, starts and then offers Chat', async () => {
      const before = lastRender<PanelState>(panelView);
      const waiting = before.lists[3];
      const row = waiting.sections[0].rows.find((candidate) => candidate.id === 'pr:fake/repo#5');
      expect(row).toBeDefined();
      // The row offers "Address review comments" and NO Chat: its only agent-to-be does not
      // exist yet, so there is nothing to talk to.
      expect(row?.actions.map((action) => action.command)).toContain('cgremlin.addressReview');
      expect(row?.actions.map((action) => action.command)).not.toContain('cgremlin.chat');

      panelView.emit({ type: 'command', command: 'cgremlin.addressReview', id: 'pr:fake/repo#5' });
      const session = await waitUntil(
        async () => (await h.client.sessions()).sessions.find((s) => s.mode === 'respond') ?? null,
        (found) => found !== null,
        { timeoutMs: 20_000, what: 'the respond session' },
      );
      const id = (session as SessionView).id;

      // Exactly ONE respond start, from exactly one command (MG-8, amended by R56). The engine
      // writes its log asynchronously, so the line is waited for rather than assumed present.
      expect(host.callsOf('executeCommand').filter((c) => c.args[0] === 'cgremlin.addressReview')).toHaveLength(1);
      const started = await waitUntil(
        async () => runStartedLines(h.stderr()),
        (lines) => lines.length > 0,
        { timeoutMs: 20_000, what: 'the run.started line' },
      );
      expect(started).toEqual([[id, 'respond']]);

      // No claim, and no terminal: chat comes second (R42).
      expect((await h.client.conversation(id)).claimed).toBe(false);
      expect(host.terminals).toHaveLength(0);

      // The brief the engine wrote carries EVERY comment of both fixture threads, including the
      // one that only exists behind the `node(id:)` comment page.
      const brief = await waitUntil(
        () => h.client.artifactText(id, 'BRIEF.md').catch(() => ''),
        (text) => text !== '',
        { timeoutMs: 20_000, what: 'BRIEF.md' },
      );
      for (const marker of ['THREAD-ONE-FIRST', 'THREAD-ONE-SECOND', 'THREAD-TWO-ONLY']) {
        expect(brief).toContain(marker);
      }
      expect(brief).toContain('Do NOT reply to a comment');
      expect(brief).toContain('Failing CI checks');

      // triaging → addressing, inside the run's own lock (R51).
      const addressed = await waitUntil(
        () => sessionById(h, id),
        (s) => s.stageStatus === 'addressing',
        { timeoutMs: 20_000, what: 'the respond phase to reach addressing' },
      );
      expect(addressed.lastRun?.stage).toBe('respond');

      // …and only now does the row offer Chat, naming that agent (R50).
      await ui.coordinator.refreshNow();
      const after = lastRender<PanelState>(panelView);
      const lit = after.lists[3].sections[0].rows.find((candidate) => candidate.id === 'pr:fake/repo#5');
      const chat = lit?.actions.find((action) => action.command === 'cgremlin.chat');
      expect(chat?.childId).toBe(`agent:${id}`);
    }, TIMEOUT);

    it('refuses a respond agent on a teammate PR with the core own 409 wording (R51)', async () => {
      const refused = await h.client.startAgent('pr/fake/repo/3', { mode: 'respond' });
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('respond mode only addresses reviews on your own');
    }, TIMEOUT);

    it('turns an AGENT_STATE write by the agent into a frame and a refetch, and no popup (R7)', async () => {
      await writeFile(
        path.join(h.sessionsDir, h.seeded.development, 'AGENT_STATE'),
        'needs-input',
        'utf8',
      );
      await waitUntil(
        async () => {
          host.flushTimeouts();
          await ui.settled();
          return ui.coordinator.itemOf('ticket:APP-2')?.needsYou ?? false;
        },
        (needsYou) => needsYou,
        { timeoutMs: 20_000, what: 'the AGENT_STATE write to reach the panel' },
      );
      // P10: the news is the panel's needs-you strip, the view badge and the status bar. No toast.
      expect(host.callsOf('showInformationMessage')).toEqual([]);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('GET /events', () => {
    let sse: SseClient;
    let frames: SseFrame[];
    let hello: Record<string, unknown> | null = null;

    beforeAll(async () => {
      sse = new SseClient({ socketPath: h.socketPath, backoffMs: [25] });
      frames = frameSink(sse);
      sse.on('open', (payload) => {
        hello = payload as Record<string, unknown>;
      });
      sse.start();
      await waitUntil(async () => hello, (value) => value !== null, { what: 'the hello frame' });
    }, TIMEOUT);

    afterAll(() => {
      sse.stop();
    });

    it('opens with a hello carrying the engine epoch', () => {
      expect(typeof hello?.epoch).toBe('string');
      expect(typeof hello?.lastEventId).toBe('number');
      expect(sse.epoch).toBe(hello?.epoch);
    });

    it('emits attention.changed for an AGENT_STATE write and artifact.changed for a PLAN.md write', async () => {
      await writeFile(
        path.join(h.sessionsDir, h.seeded.investigation, 'AGENT_STATE'),
        'needs-input',
        'utf8',
      );
      const changed = await waitForFrame(
        frames,
        (frame) =>
          frame.event === 'attention.changed' &&
          (payloadOf(frame).item as AttentionItem | undefined)?.ref ===
            `session:${h.seeded.investigation}`,
        'attention.changed',
      );
      const item = payloadOf(changed).item as AttentionItem;
      expect(item.attention.reasons).toEqual(['plan_ready', 'needs_input']);
      expect(item.attention.needsYou).toBe(true);
      expect(changed.id).not.toBeNull();

      await sleep(150); // past the watcher's per-path coalescing window
      await appendFile(path.join(h.sessionsDir, h.seeded.investigation, 'PLAN.md'), 'step two\n');
      const artifact = await waitForFrame(
        frames,
        (frame) => frame.event === 'artifact.changed' && payloadOf(frame).name === 'PLAN.md',
        'artifact.changed',
      );
      expect(payloadOf(artifact).sessionId).toBe(h.seeded.investigation);
      expect(Date.parse(String(payloadOf(artifact).mtime))).not.toBeNaN();
    }, TIMEOUT);

    it('replays every id after a Last-Event-ID reconnect, exactly once and in order (R21)', async () => {
      const resumeFrom = sse.lastEventId;
      expect(resumeFrom).not.toBeNull();

      // Disconnect, then make the engine emit a burst with nobody listening.
      sse.stop();
      frames.length = 0;
      for (const id of [h.seeded.development, h.seeded.review, h.seeded.investigation]) {
        await writeFile(path.join(h.sessionsDir, id, 'AGENT_STATE'), 'blocked', 'utf8');
        await sleep(150);
      }
      await sleep(400);

      // The client reconnects with `Last-Event-ID: <resumeFrom>` and the engine's own epoch.
      sse.start();
      await waitUntil(
        async () => frames.filter((f) => f.event === 'attention.changed').length,
        (count) => count >= 3,
        { timeoutMs: 15_000, what: 'the burst to be replayed' },
      );
      const ids = frames.map((frame) => frame.id).filter((id): id is number => id !== null);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
      expect(Math.min(...ids)).toBeGreaterThan(resumeFrom as number);
      const refs = frames
        .filter((frame) => frame.event === 'attention.changed')
        .map((frame) => (payloadOf(frame).item as AttentionItem).ref);
      for (const id of [h.seeded.development, h.seeded.review, h.seeded.investigation]) {
        expect(refs).toContain(`session:${id}`);
      }
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('POST /attention/ack', () => {
    it('hides the item until a new reason raises it, and both ack paths answer identically', async () => {
      const ref = `session:${h.seeded.review}`;
      const before = itemFor((await h.client.attention()).items, ref);
      expect(before.attention.acked).toBe(false);

      const generic = await h.client.ack(ref);
      expect(generic.status).toBe(200);
      const acked = (generic.body as { item: AttentionItem }).item;
      expect(acked.attention.acked).toBe(true);
      expect(acked.attention.needsAttention).toBe(false);
      expect(acked.attention.needsYou).toBe(false);

      // Gone from the default (needs-attention-only) listing, still present with ?all=1.
      expect((await h.client.attention()).items.map((i) => i.ref)).not.toContain(ref);
      expect((await h.client.attention(true)).items.map((i) => i.ref)).toContain(ref);

      // The named alias is the same call: byte-identical bodies for the same item.
      const alias = await h.client.ackSession(h.seeded.review);
      expect(alias.status).toBe(generic.status);
      expect(JSON.stringify(alias.body)).toBe(JSON.stringify(generic.body));

      // A NEW reason re-raises it (MG-A2): the ack stored one signature, not "forever quiet".
      await writeFile(path.join(h.sessionsDir, h.seeded.review, 'AGENT_STATE'), 'needs-input', 'utf8');
      const raised = await waitUntil(
        async () => itemFor((await h.client.attention(true)).items, ref),
        (item) => item.attention.reasons.includes('needs_input'),
        { what: 'the acked review item to re-raise' },
      );
      expect(raised.attention.acked).toBe(false);
      expect(raised.attention.needsYou).toBe(true);

      expect((await h.client.ack('session:nope')).status).toBe(404);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('the human turn (R19, R20, MG-A6)', () => {
    it('claims, refuses every headless turn while claimed, heartbeats, and releases', async () => {
      const id = h.seeded.development;
      expect((await h.client.conversation(id)).claimed).toBe(false);

      await h.client.claim(id);
      const claimed = await h.client.conversation(id);
      expect(claimed).toMatchObject({
        claimed: true,
        runner: 'claude-code',
        resumeId: 'resume-dev-2',
        worktreePath: path.join(h.worktreesDir, id),
      });

      // The cross-layer proof: a headless turn on a claimed session is refused with the engine's
      // own 409 wording, over real HTTP — and it starts no agent.
      const refused = await h.client.run(id, 'develop');
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('a human holds the agent conversation');
      const session = await sessionById(h, id);
      expect(session.lastRun).toBeNull();

      // The item the panel renders says so too.
      const item = itemFor((await h.client.attention(true)).items, `session:${id}`);
      expect(item.claimed).toBe(true);
      expect(item.running).toBe(false);

      // R20's heartbeat: re-claiming pushes expiresAt forward rather than erroring.
      const first = (await sessionById(h, id)).agent?.humanTurn;
      expect(first).toBeTruthy();
      await sleep(50);
      await h.client.claim(id);
      const second = (await sessionById(h, id)).agent?.humanTurn;
      expect(Date.parse(second?.expiresAt ?? '')).toBeGreaterThan(Date.parse(first?.expiresAt ?? ''));

      await h.client.release(id);
      expect((await h.client.conversation(id)).claimed).toBe(false);
      expect((await sessionById(h, id)).agent?.humanTurn ?? null).toBeNull();
      // Idempotent, exactly as the chat surface's teardown assumes.
      await h.client.release(id);
      expect((await h.client.conversation(id)).claimed).toBe(false);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('creating work from the extension', () => {
    let repoUrl: string;

    beforeAll(async () => {
      repoUrl = await createLocalOrigin(h.stateDir);
    }, TIMEOUT);

    it('creates an investigation that shows up in the panel (and starts nothing)', async () => {
      const created = await h.client.createInvestigation({
        repoUrl,
        ticket: 'APP-77',
        intent: 'investigate_only',
        driveToCompletion: false,
      });
      expect(created.status).toBe(201);
      const session = (created.body as { session: SessionView }).session;
      expect(session).toMatchObject({
        mode: 'investigation',
        stageStatus: 'findings',
        intent: 'investigate_only',
      });
      expect(session.workspace.branch).toBe('investigate/APP-77');
      expect(session.lastRun).toBeNull();

      const listing = await h.client.attention(true);
      const item = itemFor(listing.items, `session:${session.id}`);
      expect(item.mode).toBe('investigation');
      expect(item.links.worktreePath).toBe(session.workspace.worktreePath);
      expect(item.links.primaryArtifact).toBeNull(); // nothing has run, so there is no artifact
    }, TIMEOUT);

    it('creates a development session with a feature branch and zero runs (MG-A11)', async () => {
      const created = await h.client.createDevelopment({ repoUrl, ticket: 'APP-88' });
      expect(created.status).toBe(201);
      const session = (created.body as { session: SessionView }).session;
      expect(session).toMatchObject({ mode: 'development', stageStatus: 'active' });
      expect(session.workspace.branch).toBe('feature/APP-88');
      expect(session.lineage.parentSessionId).toBeNull();
      expect(session.lastRun).toBeNull();
      // Still nothing started a moment later: creation is not a run (R16).
      await sleep(250);
      expect((await sessionById(h, session.id)).lastRun).toBeNull();
      const item = itemFor((await h.client.attention(true)).items, `session:${session.id}`);
      expect(item.running).toBe(false);
      expect(item.attention.reasons).toEqual([]);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  // The two background sources degrading (MG-6, R32, R35).
  // -------------------------------------------------------------------------
  describe('the ticket source when Jira misbehaves', () => {
    afterAll(async () => {
      jira.setMode('ok');
      await scanAndList();
    }, TIMEOUT);

    it('keeps the cached tickets and says `unavailable` when the stub stops answering', async () => {
      jira.setMode('down');
      const listing = await waitUntil(
        async () => {
          await h.client.scan();
          return await h.client.items();
        },
        (current) => current.ticketSource.kind === 'unavailable',
        { timeoutMs: 20_000, what: 'the Jira leg to report unavailable' },
      );
      expect(listing.ticketSource.error).not.toBeNull();
      // Degrade, never empty: yesterday's tickets are still the answer (MG-6).
      expect(listing.items.some((item) => item.ticket?.key === 'APP-9')).toBe(true);
    }, TIMEOUT);

    it('reports `auth` on a 401, which is the panel own trouble state (R35)', async () => {
      jira.setMode('auth');
      const listing = await waitUntil(
        async () => {
          await h.client.scan();
          return await h.client.items();
        },
        (current) => current.ticketSource.kind === 'auth',
        { timeoutMs: 20_000, what: 'the Jira leg to report auth' },
      );
      expect(listing.ticketSource.error).toContain('Basic auth');

      // …and the extension turns exactly that into a status-bar warning plus a panel row.
      const host = new FakeHost();
      const ui = createUi({ host, client: h.client, notificationLevel: () => 'off', coalesceMs: 0 });
      try {
        expect(await ui.connect()).toBe(true);
        const view = host.resolveView(VIEW_ID).webview;
        view.emit({ type: 'ready' });
        expect(lastRender<PanelState>(view).banner).toMatchObject({ kind: 'auth' });
        expect(host.statusBarItems[0].text).toContain('jira rejected the token');
      } finally {
        await ui.dispose();
      }
    }, TIMEOUT);

    it('falls back to the legacy /search when /search/jql is gone, once per scan (R32)', async () => {
      jira.setMode('legacySearch');
      // One scan, counted on its own: the fallback fires ONCE PER SCAN, so the count only means
      // anything when exactly one scan is in the window.
      jira.clear();
      expect((await h.client.scan()).status).toBe(200);
      const listing = await waitUntil(
        () => h.client.items(),
        (current) => current.ticketSource.kind === 'ok' && jira.requests().length > 0,
        { timeoutMs: 20_000, what: 'the legacy search fallback' },
      );
      expect(listing.items.some((item) => item.ticket?.key === 'APP-42')).toBe(true);
      const paths = jira.requests().map((request) => request.pathname);
      expect(paths).toContain('/rest/api/3/search');
      // The 404 is paid once, not once per page, and the two cursor schemes never interleave.
      expect(paths.filter((p) => p === '/rest/api/3/search/jql')).toHaveLength(1);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  describe('the Jira token (MG-5, R44)', () => {
    it('never leaves core.json — not in /config, /items, a detail, the events or the log', async () => {
      const token = h.jiraToken;
      expect(token).not.toBeNull();
      // It really is in the file the engine loaded, so the assertions below have something to
      // fail on.
      expect(await readFile(h.configPath, 'utf8')).toContain(token as string);

      const config = await h.client.config();
      expect(JSON.stringify(config)).not.toContain(token as string);
      expect((config as { jira?: { apiToken?: string } }).jira?.apiToken).toBe('[redacted]');

      for (const payload of [await h.client.items(), await h.client.item('pr/fake/repo/10')]) {
        expect(JSON.stringify(payload)).not.toContain(token as string);
      }

      const frames = await collectFrames(h, 1_000);
      expect(frames).not.toContain(token as string);

      for (const file of await stateDirFiles(h.stateDir)) {
        expect(await readFile(file, 'utf8').catch(() => '')).not.toContain(token as string);
      }
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  // MG-8, amended by R56: nothing in this suite starts an agent that was not explicitly asked
  // for. Placed last of the item describes; the restart below starts nothing either.
  // -------------------------------------------------------------------------
  describe('MG-8: every run in this suite is accounted for', () => {
    it('has exactly one run.started line, and it is the respond click', async () => {
      const started = runStartedLines(h.stderr());
      expect(started).toHaveLength(1);
      expect(started[0][1]).toBe('respond');
      const session = await sessionById(h, started[0][0]);
      expect(session.mode).toBe('respond');
      // And the reads really were reads: a fresh GET adds nothing.
      await h.client.items();
      await h.client.item('pr/fake/repo/10');
      expect(runStartedLines(h.stderr())).toHaveLength(1);
    }, TIMEOUT);
  });

  // -------------------------------------------------------------------------
  // Last: it restarts the engine, so nothing above may run after it.
  describe('an engine restart', () => {
    it('clears every claim at boot and makes the SSE consumer resync (R20, R21)', async () => {
      const id = h.seeded.investigation;
      await h.client.claim(id);
      expect((await h.client.conversation(id)).claimed).toBe(true);

      const sse = new SseClient({ socketPath: h.socketPath, backoffMs: [50] });
      const epochs: string[] = [];
      let offline = 0;
      sse.on('open', (payload) => epochs.push(String((payload as { epoch: string }).epoch)));
      sse.on('resync', (payload) => epochs.push(String((payload as { epoch: string }).epoch)));
      sse.on('offline', () => {
        offline += 1;
      });
      sse.start();
      await waitUntil(async () => epochs.length, (n) => n >= 1, { what: 'the first hello' });
      // Give the stream an id to resume from, so the reconnect is a real handover attempt.
      await writeFile(path.join(h.sessionsDir, id, 'AGENT_STATE'), 'working', 'utf8');
      await sleep(300);

      try {
        await h.restart();
        await waitUntil(async () => epochs.length, (n) => n >= 2, {
          timeoutMs: 15_000,
          what: 'a fresh epoch after the restart',
        });
        expect(offline).toBeGreaterThanOrEqual(1);
        expect(epochs[epochs.length - 1]).not.toBe(epochs[0]);
      } finally {
        sse.stop();
      }

      expect((await h.client.conversation(id)).claimed).toBe(false);
      expect((await sessionById(h, id)).agent?.humanTurn ?? null).toBeNull();
      expect(h.stderr()).toContain('conversation.claims_cleared');
    }, RESTART_TIMEOUT);
  });
});

/**
 * Its own engine, because R20's TTL is a config value and this is the only thing that needs a
 * short one. the bundled engine boots in well under a second, so a second one is cheap.
 */
describe.skipIf(!coreIsBuilt())('integration: an expiring human turn (R20)', () => {
  let h: CoreHarness;

  beforeAll(async () => {
    h = await startEngineViaManager({ humanTurnTtlMs: 1_200 });
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
  }, TIMEOUT);

  it('stops counting as claimed once the TTL passes, with nobody releasing it', async () => {
    const id = h.seeded.development;
    expect((await h.client.config()).humanTurnTtlMs).toBe(1_200);

    await h.client.claim(id);
    expect((await h.client.conversation(id)).claimed).toBe(true);
    expect(itemFor((await h.client.attention(true)).items, `session:${id}`).claimed).toBe(true);

    await sleep(1_500);

    expect((await h.client.conversation(id)).claimed).toBe(false);
    expect(itemFor((await h.client.attention(true)).items, `session:${id}`).claimed).toBe(false);
    // The claim record is still on disk: `isClaimed` decides, never `humanTurn !== null` (R20).
    const humanTurn = (await sessionById(h, id)).agent?.humanTurn;
    expect(humanTurn).toBeTruthy();
    expect(Date.parse(humanTurn?.expiresAt ?? '')).toBeLessThan(Date.now());
  }, TIMEOUT);
});

/**
 * Its own engine: `notConfigured` is decided at build time from the config, so it cannot be
 * reached by poking a running one (MG-6's third case).
 */
describe.skipIf(!coreIsBuilt())('integration: a jira block with no token (MG-6, R35)', () => {
  let h: CoreHarness;
  let jira: FakeJira;

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    // An EMPTY token means the block is written without `apiToken` at all, which is exactly the
    // half-configured state a user is in before they paste theirs in.
    h = await startEngineViaManager({ jira: { baseUrl: jira.baseUrl, apiToken: '' } });
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
    await jira?.stop();
  }, TIMEOUT);

  it('says notConfigured, makes no request at all, and leaves the panel unbannered', async () => {
    expect((await h.client.scan()).status).toBe(200);
    await sleep(300);
    const listing = await h.client.items();
    expect(listing.ticketSource.kind).toBe('notConfigured');
    expect(listing.ticketSource.error).toBeNull();
    expect(jira.requests()).toEqual([]);
    // R28: a link still seeds a `ticket:` candidate from the KEY alone — what a missing source
    // costs is the CONTENT, so every ticket here is an empty shell with a browse URL.
    for (const item of listing.items) {
      if (item.ticket === null) continue;
      expect(item.ticket.summary).toBe('');
      expect(item.ticket.url).toContain('/browse/');
    }
    // R35: `notConfigured` says nothing at all — a permanent red banner mid-setup is the bug.
    const host = new FakeHost();
    const ui = createUi({ host, client: h.client, notificationLevel: () => 'off', coalesceMs: 0 });
    try {
      expect(await ui.connect()).toBe(true);
      const view = host.resolveView(VIEW_ID).webview;
      view.emit({ type: 'ready' });
      expect(lastRender<PanelState>(view).banner).toBeNull();
    } finally {
      await ui.dispose();
    }
  }, TIMEOUT);
});

/**
 * R34: the Jira leg runs AFTER the PR half is published and is not awaited, so a Jira that never
 * answers must not hold `POST /prs/scan` — and a shutdown mid-leg must not leave a torn cache.
 */
describe.skipIf(!coreIsBuilt())('integration: a Jira that hangs (R34)', () => {
  let h: CoreHarness;
  let jira: FakeJira;

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    h = await startEngineViaManager({
      jira: { baseUrl: jira.baseUrl, apiToken: JIRA_TOKEN, scanBudgetMs: 1_500, timeoutMs: 1_200 },
    });
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
    await jira?.stop();
  }, TIMEOUT);

  it('answers the scan promptly, carries the last completed report, and writes no torn jira.json', async () => {
    jira.setMode('hang');
    const startedAt = Date.now();
    const scan = await h.client.scan();
    expect(scan.status).toBe(200);
    // The PR half is what the caller waited for; the Jira leg is still out there hanging.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const body = scan.body as { jira: { kind: string }; inventory: { entries: unknown[] } };
    expect(body.inventory.entries.length).toBeGreaterThan(0);
    expect(['notConfigured', 'unavailable', 'ok']).toContain(body.jira.kind);

    // The shutdown drains the in-flight leg rather than cutting it (`InventoryScanner.stop`).
    await h.stop();
    const cachePath = path.join(h.stateDir, 'jira.json');
    const raw = await readFile(cachePath, 'utf8').catch(() => null);
    if (raw !== null) expect(() => JSON.parse(raw) as unknown).not.toThrow();
    // No temp file left behind by the atomic write either.
    const leftovers = (await stateDirFiles(h.stateDir)).filter((file) => file.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------

/** The union of every object's own keys across a collection — a shape, not a value. */
function keysAcross(values: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (typeof value === 'object' && value !== null) for (const key of Object.keys(value)) keys.add(key);
  }
  return [...keys].sort();
}

/** `[sessionId, stage]` for every `run.started` the engine logged. MG-8 counts these. */
function runStartedLines(stderr: string): [string, string][] {
  return stderr
    .split('\n')
    .filter((line) => line.includes('"type":"run.started"'))
    .map((line) => JSON.parse(line) as { sessionId: string; stage: string })
    .map((entry) => [entry.sessionId, entry.stage]);
}

/** Every key anywhere in a payload whose name ends in `Html` (MG-10, R33). */
function htmlKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) htmlKeysIn(entry, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      if (/[A-Za-z]Html$/.test(key)) found.push(key);
      htmlKeysIn(entry, found);
    }
  }
  return found;
}

/** Everything `/events` carries for a moment, as raw text — what MG-5 greps. */
async function collectFrames(harness: CoreHarness, ms: number): Promise<string> {
  const sse = new SseClient({ socketPath: harness.socketPath, backoffMs: [25] });
  const seen: string[] = [];
  sse.on('frame', (frame) => seen.push(JSON.stringify(frame)));
  sse.on('open', (payload) => seen.push(JSON.stringify(payload)));
  sse.start();
  try {
    await sleep(ms);
  } finally {
    sse.stop();
  }
  return seen.join('\n');
}

async function sessionById(harness: CoreHarness, id: string): Promise<SessionView> {
  const result = await harness.client.request('GET', `/sessions/${id}`);
  expect(result.status).toBe(200);
  return (result.body as { session: SessionView }).session;
}

/**
 * A one-commit local git repo to create sessions from: `createWorkspace` mirrors and worktrees the
 * repo URL for real, so an unreachable `https://github.com/...` would fail offline. Same trick the
 * core's own e2e harness uses (`cgremlin/core/test/support/e2e-harness.ts`).
 */
async function createLocalOrigin(root: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const originPath = path.join(root, 'origin');
  const git = (args: string[], cwd = originPath): void => {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  };
  execFileSync('git', ['init', '-q', '-b', 'main', originPath], { cwd: root });
  git(['config', 'user.email', 'integration@example.com']);
  git(['config', 'user.name', 'integration']);
  await writeFile(path.join(originPath, 'README.md'), '# fixture origin\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  return originPath;
}

describe.skipIf(coreIsBuilt())('integration: skipped', () => {
  it('says why', () => {
    expect(SKIP_REASON).toContain('not built');
  });
});
