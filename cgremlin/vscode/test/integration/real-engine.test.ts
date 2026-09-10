/**
 * Integration: the extension's real client layer against a REAL engine.
 *
 * Nothing in the core is stubbed. `cgremlin-core serve` runs as a child process on a Unix socket
 * in a throwaway state dir (test/support/core-harness.ts), and every assertion below goes over
 * real HTTP through the very modules that ship: `CoreClient`, `SseClient`, and the whole host
 * wiring (`createUi` → `RefreshCoordinator` → tree/status bar/notifications) driven by the same
 * `FakeHost` the unit tests use.
 *
 * This is what proves the extension's structural `*View` types (src/model/items.ts) match what the
 * engine actually returns: a field rename in the core fails here, rather than at runtime in the
 * editor.
 *
 * NOT covered here, deliberately: `POST /reviews` (R23) and the own-PR refusal. Both go through
 * `ReviewSessionFactory`, which mirrors `https://github.com/<slug>.git` and then starts a review
 * agent — that needs a git remote and a real `gh`, and the core already covers both paths in
 * `cgremlin/core/test/api/*` and its own real-git e2e suite. See docs/SMOKE.md steps 8 and 9 for
 * the manual pass over them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoreHttpError } from '../../src/core-client';
import { SseClient, type SseFrame } from '../../src/sse';
import { buildLists, LIST_ORDER } from '../../src/model/view-model';
import type { AttentionItem, SessionView } from '../../src/model/items';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from '../support/fake-host';
import {
  coreIsBuilt,
  PR3_SHA,
  SKIP_REASON,
  sleep,
  startEngine,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

// Booting a child engine, a real fs watch and an SSE reconnect are all wall-clock work.
const TIMEOUT = 30_000;

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

describe.skipIf(!coreIsBuilt())('integration: the extension against a real engine', () => {
  let h: CoreHarness;

  beforeAll(async () => {
    h = await startEngine();
  }, TIMEOUT);

  afterAll(async () => {
    await h?.cleanup();
  }, TIMEOUT);

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
      expect(groups.unreviewed.map((e) => e.number)).toEqual([4]);
      expect(groups.ours.map((e) => e.number)).toEqual([3]);
      expect(groups.mine.map((e) => e.number)).toEqual([5]);
      expect(groups.teamOnIt).toEqual([]);
      // The `ours` row names our seeded review session, and agrees on the reviewed sha.
      const ours = groups.ours[0];
      expect(ours.ours).toMatchObject({ status: 'reviewed', sessionId: h.seeded.review, phase: 'ready' });
      expect(ours.headSha).toBe(PR3_SHA);
    });

    it('returns the three seeded sessions in the shape SessionView declares', async () => {
      const { sessions } = await h.client.sessions();
      const byId = new Map(sessions.map((s: SessionView) => [s.id, s]));
      expect([...byId.keys()].sort()).toEqual(
        [h.seeded.development, h.seeded.investigation, h.seeded.review].sort(),
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
      expect(mine.attention.reasons).toEqual(['changes_requested']);
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

    it('builds four populated lists from the live responses (MG-B6 shape)', async () => {
      const [{ groups }, { sessions }, listing] = await Promise.all([
        h.client.prs(),
        h.client.sessions(),
        h.client.attention(true),
      ]);
      const lists = buildLists({ items: listing.items, groups, sessions });
      expect(Object.keys(lists).sort()).toEqual(LIST_ORDER.map((d) => d.kind).sort());
      expect(lists.parking.map((row) => row.item.ref)).toEqual([`pr:${h.repoSlug}#4`]);
      expect(lists.reviewing.map((row) => row.item.ref)).toEqual([`session:${h.seeded.review}`]);
      expect(lists.investigations.map((row) => row.item.ref)).toContain(
        `session:${h.seeded.investigation}`,
      );
      expect(lists.devwork.map((row) => row.item.ref)).toEqual([
        `session:${h.seeded.development}`,
        `pr:${h.repoSlug}#5`,
      ]);
      expect(lists.reviewing[0].indicator).toBe('✅');
      expect(lists.reviewing[0].description).toContain('ready');
    });
  });

  // -------------------------------------------------------------------------
  describe('the whole host wiring over the live socket', () => {
    let host: FakeHost;
    let ui: Ui;
    let sse: SseClient;

    beforeAll(async () => {
      host = new FakeHost();
      ui = createUi({
        host,
        client: h.client,
        notificationLevel: () => 'all',
        configPath: () => path.join(h.stateDir, 'core.json'),
        coalesceMs: 0,
      });
      sse = new SseClient({ socketPath: h.socketPath, backoffMs: [25] });
      sse.on('frame', () => ui.coordinator.schedule());
      sse.on('open', () => ui.coordinator.schedule());
      expect(await ui.connect()).toBe(true);
      sse.start();
    }, TIMEOUT);

    afterAll(async () => {
      sse.stop();
      await ui.dispose();
    }, TIMEOUT);

    it('populates the tree and the status bar from the engine', () => {
      const roots = ui.tree.getChildren();
      expect(roots.map((node) => (node.kind === 'root' ? node.list : 'row'))).toEqual([
        'parking',
        'reviewing',
        'investigations',
        'devwork',
      ]);
      for (const root of roots) {
        if (root.kind !== 'root') continue;
        expect(root.count, `${root.list} should not be empty`).toBeGreaterThan(0);
      }
      // Three needs-you items: the plan_ready investigation, the ready review, and my own PR.
      expect(host.statusBarItems[0].text).toContain('3 need you');
      expect(host.statusBarItems[0].text).toContain('no repo open');
    });

    it(
      'turns an AGENT_STATE write by the agent into a frame, a refetch and one popup (R7, MG-B2)',
      async () => {
        const before = host.callsOf('showInformationMessage').length;
        await writeFile(
          path.join(h.sessionsDir, h.seeded.development, 'AGENT_STATE'),
          'needs-input',
          'utf8',
        );
        // The engine's fs watch → AttentionService → the event ring → our SSE consumer →
        // coordinator.schedule(); the fake host holds the coalescing timer until we release it.
        await waitUntil(
          async () => {
            host.flushTimeouts();
            await ui.settled();
            return ui.coordinator.items();
          },
          (items) =>
            items.find((i) => i.ref === `session:${h.seeded.development}`)?.attention.reasons.includes(
              'needs_input',
            ) === true,
          { timeoutMs: 15_000, what: 'the development item to report needs_input' },
        );

        const devRow = ui.tree
          .getChildren(ui.tree.getChildren().find((n) => n.kind === 'root' && n.list === 'devwork'))
          .flatMap((node) => (node.kind === 'row' ? [node.row] : []))
          .find((row) => row.item.ref === `session:${h.seeded.development}`);
        expect(devRow?.indicator).toBe('⏸️');
        expect(host.statusBarItems[0].text).toContain('4 need you');

        const popups = host.callsOf('showInformationMessage').slice(before);
        expect(popups.length).toBeGreaterThanOrEqual(1);
        // The popup names the item by its display title (the ticket, here) and its reasons.
        expect(popups.some((call) => String(call.args[0]) === 'APP-2 — needs_input')).toBe(true);
        expect(popups[0].args[2]).toEqual(['Open', 'Ack']);
      },
      TIMEOUT,
    );
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

      const [{ groups }, { sessions }, listing] = await Promise.all([
        h.client.prs(),
        h.client.sessions(),
        h.client.attention(true),
      ]);
      const item = itemFor(listing.items, `session:${session.id}`);
      expect(item.mode).toBe('investigation');
      expect(item.links.worktreePath).toBe(session.workspace.worktreePath);
      expect(item.links.primaryArtifact).toBeNull(); // nothing has run, so there is no artifact
      const lists = buildLists({ items: listing.items, groups, sessions });
      expect(lists.investigations.map((row) => row.item.ref)).toContain(`session:${session.id}`);
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
    }, TIMEOUT);
  });
});

/**
 * Its own engine, because R20's TTL is a config value and this is the only thing that needs a
 * short one. `cgremlin-core serve` boots in well under a second, so a second one is cheap.
 */
describe.skipIf(!coreIsBuilt())('integration: an expiring human turn (R20)', () => {
  let h: CoreHarness;

  beforeAll(async () => {
    h = await startEngine({ humanTurnTtlMs: 1_200 });
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

// ---------------------------------------------------------------------------

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
