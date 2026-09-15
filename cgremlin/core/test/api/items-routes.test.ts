import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { AckStore } from '../../src/attention/ack-store';
import { DismissStore } from '../../src/attention/dismiss-store';
import { AttentionService, PrSourceAdapter, SessionSourceAdapter } from '../../src/attention/attention-service';
import { WorkItemService } from '../../src/work/work-item-service';
import { createInventoryHarness, type InventoryHarness } from '../support/inventory-harness';
import { RespondSessionFactory } from '../../src/pipeline/respond-session-factory';
import { QaSessionFactory } from '../../src/pipeline/qa-session-factory';
import { FIXED_NOW, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { JiraIssueDetail } from '../../src/jira/jira-source';
import type { PrStateCache } from '../../src/gh/pr-state';
import { PR_STATE_ENTRY_DEFAULTS } from '../support/pr-state-entry';
import type { Session } from '../../src/schema/session';

const NOW = new Date('2026-09-10T12:00:00.000Z');

let dir: string;
let socketPath: string;
let server: http.Server;
let ih: InventoryHarness;
let runStarts: string[];
let agentStarts: number;
let jira: JiraScanReport;
let ticketDetailCalls: string[];
let ticketDetailAnswer: { ticket: JiraIssueDetail | null; ticketError: string | null };
let threadReport: { scannedAt: string | null; error: string | null; fetched: number };
let prStates: PrStateCache;

function prFixture(number: number, author: string, overrides: Record<string, unknown> = {}) {
  return {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    author: { login: author },
    isDraft: false,
    reviewDecision: '',
    headRefOid: 'a'.repeat(40),
    headRefName: `feature/HB-62${number}-x`,
    baseRefName: 'main',
    title: `PR #${number}`,
    updatedAt: '2026-09-04T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    latestReviews: [],
    reviews: [],
    comments: [],
    ...overrides,
  };
}

/** Route bodies are asserted field-by-field; typing them structurally here would just restate the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(opts: { withWorkItems?: boolean } = {}): Promise<void> {
  ih = createInventoryHarness({ watchAuthors: ['bob'], projectKeys: ['HB'] });
  runStarts = [];
  agentStarts = 0;
  ih.h.events.on('run.started', (e) => runStarts.push(e.stage));
  const realStart = ih.h.runner.start.bind(ih.h.runner);
  ih.h.runner.start = async (ctx) => {
    agentStarts += 1;
    return realStart(ctx);
  };

  await ih.h.fs.mkdir('/state', { recursive: true });
  const attention = new AttentionService({
    adapters: [
      new SessionSourceAdapter({ store: ih.h.store, fs: ih.h.fs, sessionsDir: SESSIONS_DIR, isRunning: () => false }),
      new PrSourceAdapter({ inventory: ih.inventoryStore }),
    ],
    acks: new AckStore(ih.h.fs, '/state/attention-acks.json'),
    events: ih.h.events,
    now: () => NOW,
  });
  const workItems = new WorkItemService({
    attention,
    inventory: ih.inventoryStore,
    jira: { lastReport: async () => jira },
    threads: { lastReport: () => threadReport },
    events: ih.h.events,
    dismissals: new DismissStore(ih.h.fs, '/state/dismissals.json'),
    prStates: { cached: async () => prStates },
    now: () => NOW,
    config: { me: 'me-user', watchAuthors: ['bob'], showAllRepoPrs: false, projectKeys: ['HB'] },
  });
  server = createApiServer({
    sessionStore: ih.h.store,
    workspaceManager: ih.h.workspace,
    pipeline: ih.h.service,
    fs: ih.h.fs,
    sessionsDir: SESSIONS_DIR,
    events: ih.h.events,
    lock: ih.h.lock,
    now: FIXED_NOW,
    attention,
    inventory: {
      scanner: ih.scanner,
      scheduler: ih.scheduler,
      factory: ih.factory,
      inventoryStore: ih.inventoryStore,
      config: { me: ih.config.me },
    },
    ticketDetail: {
      detail: async (key: string) => {
        ticketDetailCalls.push(key);
        return ticketDetailAnswer;
      },
    },
    respondFactory: new RespondSessionFactory({
      gh: ih.gh,
      store: ih.h.store,
      workspace: ih.h.workspace,
      events: ih.h.events,
      worktreesDir: WORKTREES_DIR,
      me: 'me-user',
    }),
    qaFactory: new QaSessionFactory({
      gh: ih.gh,
      store: ih.h.store,
      workspace: ih.h.workspace,
      events: ih.h.events,
      worktreesDir: WORKTREES_DIR,
      defaultBaseRef: 'origin/main',
    }),
    ...(opts.withWorkItems === false ? {} : { workItems }),
  });
  socketPath = path.join(dir, `items-${Math.random().toString(36).slice(2)}.sock`);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

async function scan(items: unknown[]): Promise<void> {
  ih.gh.queueResponse({ stdout: JSON.stringify(items) });
  await ih.scanner.run();
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-items-'));
  jira = { scannedAt: '2026-09-10T00:00:00.000Z', me: '712020:me', issues: [], error: null, kind: 'ok' };
  ticketDetailCalls = [];
  ticketDetailAnswer = { ticket: null, ticketError: null };
  threadReport = { scannedAt: null, error: null, fetched: 0 };
  prStates = {};
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('GET /items (R35, R47)', () => {
  it('returns the FOUR list keys, with parkingLot an object of three ordered id arrays and no top-level reviewing', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('GET', '/items');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.lists).sort()).toEqual([
      'investigations',
      'myWork',
      'parkingLot',
      'waitingForReview',
    ]);
    expect(res.body).not.toHaveProperty('reviewing');
    expect(res.body.lists).not.toHaveProperty('reviewing');
    expect(Object.keys(res.body.lists.parkingLot).sort()).toEqual(['reviewing', 'someoneOnIt', 'untouched']);
    expect(res.body.lists.parkingLot.untouched).toEqual(['pr:acme/app#10']);
  });

  it('every id in lists.parkingLot matches that item parkingLotGroup exactly', async () => {
    await start();
    await scan([prFixture(10, 'bob'), prFixture(11, 'bob', { reviews: [{ author: { login: 'jane' }, state: 'COMMENTED', submittedAt: '2026-09-05T00:00:00Z' }] })]);
    const res = await request('GET', '/items');
    for (const [group, ids] of Object.entries(res.body.lists.parkingLot) as Array<[string, string[]]>) {
      for (const id of ids) {
        expect(res.body.items.find((i: { id: string }) => i.id === id).parkingLotGroup).toBe(group);
      }
    }
  });

  it('ticketSource.kind is the four-value union, with no configured/ok booleans', async () => {
    await start();
    await scan([]);
    const res = await request('GET', '/items');
    expect(res.body.ticketSource.kind).toBe('ok');
    expect(res.body.ticketSource).not.toHaveProperty('configured');
    expect(res.body.threadSource).toEqual({ error: null, scannedAt: null });
  });

  it('?list= accepts exactly the four and 400s on reviewing', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    for (const list of ['parkingLot', 'myWork', 'investigations', 'waitingForReview']) {
      expect((await request('GET', `/items?list=${list}`)).status).toBe(200);
    }
    const bad = await request('GET', '/items?list=reviewing');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('reviewing');
  });

  it('404s cleanly when the work-item layer is not wired', async () => {
    await start({ withWorkItems: false });
    const res = await request('GET', '/items');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('items not configured');
  });
});

describe('GET /items/<path> (R25, R36, R65)', () => {
  it('resolves a pr path and returns the item, the ticket and per-agent artifacts', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('GET', '/items/pr/acme/app/10');
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe('pr:acme/app#10');
    expect(res.body.ticket).toBeNull();
    expect(res.body.artifacts).toEqual({});
  });

  it('MG-9/R65: an item whose id is ticket:HB-627 is reachable at /items/pr/acme/app/10, and the body id comes back ticket:HB-627', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-6210',
          summary: 'Do the thing',
          status: 'In Progress',
          statusCategory: 'indeterminate',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-6210',
        },
      ],
    };
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('GET', '/items/pr/acme/app/10');
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe('ticket:HB-6210');
    // and the same item is reachable by its ticket path
    expect((await request('GET', '/items/ticket/HB-6210')).body.item.id).toBe('ticket:HB-6210');
  });

  it('resolves a session path to the item whose agents contain it, validated by the session-id regex', async () => {
    await start();
    await scan([]);
    const created = await ih.h.service.createInvestigationSession({
      repoUrl: 'git@github.com:acme/app.git',
      ticket: null,
      intent: 'investigate_only',
      driveToCompletion: false,
    });
    const res = await request('GET', `/items/session/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(`session:${created.id}`);
    expect(Object.keys(res.body.artifacts)).toEqual([created.id]);

    expect((await request('GET', '/items/session/..%2Fetc')).status).toBe(400);
  });

  it('404s on a path that names nothing', async () => {
    await start();
    await scan([]);
    expect((await request('GET', '/items/pr/acme/app/999')).status).toBe(404);
  });

  it('with Jira returning 500 the route still answers 200, with ticket null and ticketError set', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-6210',
          summary: 'Do the thing',
          status: 'In Progress',
          statusCategory: 'indeterminate',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-6210',
        },
      ],
    };
    ticketDetailAnswer = { ticket: null, ticketError: 'Jira responded 500 for /issue/HB-6210' };
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('GET', '/items/ticket/HB-6210');
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeNull();
    expect(res.body.ticketError).toContain('500');
  });

  it('R33/MG-10: a ticket whose description is <b>bold</b> comes back as TEXT, with no *Html field', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-6210',
          summary: 'Do the thing',
          status: 'In Progress',
          statusCategory: 'indeterminate',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-6210',
        },
      ],
    };
    ticketDetailAnswer = {
      ticket: {
        key: 'HB-6210',
        summary: 'Do the thing',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        assignee: '712020:me',
        assigneeName: null,
        updated: '2026-09-09T00:00:00.000Z',
        url: 'https://example.atlassian.net/browse/HB-6210',
        descriptionText: 'bold',
        comments: [],
      },
      ticketError: null,
    };
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('GET', '/items/ticket/HB-6210');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('<b>');
    expect(raw).not.toContain('Html');
    expect(res.body.ticket.descriptionText).toBe('bold');
  });
});

describe('POST /items/<path>/ack (R31)', () => {
  it('fans out to every ref and returns { item, acked, failed }', async () => {
    await start();
    await scan([prFixture(11, 'me-user', { reviewDecision: 'CHANGES_REQUESTED', reviews: [{ author: { login: 'jane' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-05T00:00:00Z' }] })]);
    const before = await request('GET', '/items/pr/acme/app/11');
    expect(before.body.item.attention.refs).toEqual(['pr:acme/app#11']);
    expect(before.body.item.attention.acked).toBe(false);

    const res = await request('POST', '/items/pr/acme/app/11/ack');
    expect(res.status).toBe(200);
    expect(res.body.acked).toEqual(['pr:acme/app#11']);
    expect(res.body.failed).toEqual([]);
    expect(res.body.item.attention.acked).toBe(true);
  });

  it('acks EVERY ref, not only the first', async () => {
    await start();
    await scan([prFixture(11, 'me-user', { reviewDecision: 'CHANGES_REQUESTED', reviews: [{ author: { login: 'jane' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-09-05T00:00:00Z' }] })]);
    const created = await ih.h.service.createDevelopmentSession({
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'HB-6211',
    });
    const listed = await request('GET', '/items/pr/acme/app/11');
    // the dev session joins the PR's item via its ticket key
    const res = await request('POST', '/items/pr/acme/app/11/ack');
    expect(res.status).toBe(200);
    expect(res.body.acked).toEqual(listed.body.item.attention.refs);
    expect(res.body.acked.length).toBeGreaterThanOrEqual(1);
    expect(created.id).toBeTruthy();
  });
});

describe('POST /items/<path>/agents (MG-8, R15)', () => {
  it('MG-8: every GET records ZERO agent starts and zero run.started', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    await request('GET', '/items');
    await request('GET', '/items/pr/acme/app/10');
    expect(agentStarts).toBe(0);
    expect(runStarts).toEqual([]);
  });

  it('MG-8: mode review records exactly ONE start', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    ih.gh.queueResponse({
      stdout: JSON.stringify({
        number: 10,
        title: 'PR #10',
        author: { login: 'bob' },
        headRefName: 'feature/HB-6210-x',
        headRefOid: 'a'.repeat(40),
        baseRefName: 'main',
        url: 'https://github.com/acme/app/pull/10',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
        mergedAt: null,
        closedAt: null,
        latestReviews: [],
        statusCheckRollup: [],
      }),
    });
    const res = await request('POST', '/items/pr/acme/app/10/agents', { mode: 'review' });
    expect(res.status).toBe(202);
    expect(res.body.created).toBe(true);
    expect(agentStarts).toBe(1);
    expect(runStarts).toEqual(['review']);
  });

  it('mode review on MY OWN PR is a 409 with the engine own OwnPrError wording', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    const res = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'review' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('own');
  });

  it('Phase 10: mode review with selfReview:true on MY OWN PR creates a review session instead of 409', async () => {
    await start();
    await scan([prFixture(12, 'me-user')]);
    ih.gh.queueResponse({
      stdout: JSON.stringify({
        number: 12,
        title: 'PR #12',
        author: { login: 'me-user' },
        headRefName: 'feature/HB-6212-x',
        headRefOid: 'a'.repeat(40),
        baseRefName: 'main',
        url: 'https://github.com/acme/app/pull/12',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: '',
        mergedAt: null,
        closedAt: null,
        latestReviews: [],
        statusCheckRollup: [],
      }),
    });
    const res = await request('POST', '/items/pr/acme/app/12/agents', { mode: 'review', selfReview: true });
    expect(res.status).toBe(202);
    expect(res.body.created).toBe(true);
    expect(res.body.session.lineage.selfReview).toBe(true);
    expect(agentStarts).toBe(1);
    expect(runStarts).toEqual(['review']);
  });

  it('Phase 10: mode review WITHOUT selfReview on MY OWN PR still 409s (every other path keeps OwnPrError)', async () => {
    await start();
    await scan([prFixture(13, 'me-user')]);
    const res = await request('POST', '/items/pr/acme/app/13/agents', { mode: 'review', selfReview: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('own');
  });

  it('mode review on a ticket-only item is a 400', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-900',
          summary: 'ticket only',
          status: 'To Do',
          statusCategory: 'new',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-900',
        },
      ],
    };
    await start();
    await scan([]);
    const res = await request('POST', '/items/ticket/HB-900/agents', { mode: 'review' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('pull request');
  });

  it('mode development on a ticket-only item WITHOUT repoUrl is a 400 naming repoUrl', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-900',
          summary: 'ticket only',
          status: 'To Do',
          statusCategory: 'new',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-900',
        },
      ],
    };
    await start();
    await scan([]);
    const res = await request('POST', '/items/ticket/HB-900/agents', { mode: 'development' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('repoUrl');

    const ok = await request('POST', '/items/ticket/HB-900/agents', {
      mode: 'development',
      repoUrl: 'git@github.com:acme/app.git',
    });
    expect(ok.status).toBe(202);
    expect(ok.body.session.lineage.ticket).toBe('HB-900');
    expect(agentStarts).toBe(1);
  });

  it('an unknown mode is a 400', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    expect((await request('POST', '/items/pr/acme/app/10/agents', { mode: 'nope' })).status).toBe(400);
  });
});

describe('MG-9: no raw id ever reaches a request path', () => {
  it('a source grep over src/api/server.ts finds no /items/${ interpolation', () => {
    const source = readFileSync(path.join(__dirname, '../../src/api/server.ts'), 'utf8');
    expect(source).not.toContain('/items/${');
  });
});

describe('threadSource on GET /items (R52, MG-6 shape)', () => {
  it('carries the leg report, and a non-null error never empties a list', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    const before = await request('GET', '/items');
    expect(before.body.threadSource).toEqual({ error: null, scannedAt: null });
    expect(before.body.lists.parkingLot.untouched.length).toBe(1);

    threadReport = { scannedAt: '2026-09-10T00:00:00.000Z', error: 'gh exploded', fetched: 0 };
    const after = await request('GET', '/items');
    expect(after.body.threadSource).toEqual({ error: 'gh exploded', scannedAt: '2026-09-10T00:00:00.000Z' });
    expect(after.body.lists.parkingLot.untouched.length).toBe(1);
  });
});

describe('POST /items/pr/:o/:r/:n/agents { mode: respond } (R51, R56, MG-8 amended)', () => {
  function prViewJson(author: string) {
    return JSON.stringify({
      number: 11,
      title: 'PR #11',
      author: { login: author },
      headRefName: 'feature/HB-6211-x',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      url: 'https://github.com/acme/app/pull/11',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      mergedAt: null,
      closedAt: null,
      latestReviews: [],
      statusCheckRollup: [],
    });
  }

  it('R56: the click CREATES the session and STARTS the respond run in the same request, answering 202', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const res = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    expect(res.status).toBe(202);
    expect(res.body.created).toBe(true);
    expect(res.body.started).toBe(true);
    expect(res.body.session.mode).toBe('respond');
    expect(res.body.session.stageStatus).toBe('addressing');
    // R61: the PR is mine and its branch names HB-6211, so the item has
    // already merged into its ticket — the route resolved the pr/ path to
    // the CONTAINING item (R65), which is the whole point.
    expect(res.body.item.id).toBe('ticket:HB-6211');
    expect(agentStarts).toBe(1);
    expect(runStarts).toEqual(['respond']);
    // the brief is NOT empty — the whole point of creating and starting together
    const brief = await ih.h.fs.readFile(`${SESSIONS_DIR}/${res.body.session.id}/BRIEF.md`);
    expect(brief).toContain('# RESPOND — acme/app#11');
  });

  it('named: "the respond click records one run start and zero claim attempts"', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const claims: string[] = [];
    const realClaim = ih.h.service.claimConversation.bind(ih.h.service);
    ih.h.service.claimConversation = async (id: string) => {
      claims.push(id);
      return realClaim(id);
    };
    await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    expect(runStarts).toEqual(['respond']);
    expect(claims).toEqual([]);
  });

  it("R51: a second POST never creates a second session and RESTARTS the run", async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const first = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    await ih.h.finishRun({}, { code: 0, signal: null });
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const second = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    expect(second.status).toBe(202);
    expect(second.body.created).toBe(false);
    expect(second.body.started).toBe(true);
    expect(second.body.session.id).toBe(first.body.session.id);
    expect((await ih.h.store.list()).filter((s) => s.mode === 'respond').length).toBe(1);
  });

  it('R51: with the session CLAIMED it is { created: false, started: false } with a reason', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const first = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    await ih.h.finishRun({}, { code: 0, signal: null });
    await ih.h.service.claimConversation(first.body.session.id);
    const second = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, started: false });
    expect(second.body.reason).toContain('claim');
  });

  it('R51: a second POST while the run is IN FLIGHT refuses to restart — two agents must never write one COMMENTS.md', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    const second = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, started: false });
    expect(second.body.reason).toContain('in flight');
    expect(runStarts).toEqual(['respond']);
  });

  it("mode respond on somebody else's PR is a 409 naming NotMyPrError's wording", async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    ih.gh.queueResponse({ stdout: prViewJson('bob') });
    const res = await request('POST', '/items/pr/acme/app/10/agents', { mode: 'respond' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not yours');
    expect(agentStarts).toBe(0);
  });

  it('mode respond on a ticket-only item is a 400', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-900',
          summary: 'ticket only',
          status: 'To Do',
          statusCategory: 'new',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-900',
        },
      ],
    };
    await start();
    await scan([]);
    const res = await request('POST', '/items/ticket/HB-900/agents', { mode: 'respond' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('pull request');
  });

  it('R56: POST /sessions/:id/run { stage: respond } validates', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: prViewJson('me-user') });
    const created = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'respond' });
    const res = await request('POST', `/sessions/${created.body.session.id}/run`, { stage: 'respond' });
    expect(res.status).not.toBe(400);
  });
});

describe('POST /items/<path>/dismiss and /undismiss', () => {
  it('dismiss is 200 { item }, drops the item from the lists, and keeps it in items', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    const res = await request('POST', '/items/pr/acme/app/10/dismiss');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['item']);
    expect(res.body.item).toMatchObject({ id: 'pr:acme/app#10', dismissed: true, dismissedAt: NOW.toISOString() });

    const listed = await request('GET', '/items');
    expect(listed.body.lists.parkingLot.untouched).toEqual([]);
    expect(listed.body.items.map((i: Json) => i.id)).toEqual(['pr:acme/app#10']);
    expect(listed.body.dismissed).toEqual(['pr:acme/app#10']);
  });

  it('both routes are idempotent and undismiss puts the item back', async () => {
    await start();
    await scan([prFixture(10, 'bob')]);
    await request('POST', '/items/pr/acme/app/10/dismiss');
    expect((await request('POST', '/items/pr/acme/app/10/dismiss')).status).toBe(200);
    const un = await request('POST', '/items/pr/acme/app/10/undismiss');
    expect(un.status).toBe(200);
    expect(un.body.item).toMatchObject({ dismissed: false, dismissedAt: null });
    expect((await request('POST', '/items/pr/acme/app/10/undismiss')).status).toBe(200);
    const listed = await request('GET', '/items');
    expect(listed.body.lists.parkingLot.untouched).toEqual(['pr:acme/app#10']);
    expect(listed.body.dismissed).toEqual([]);
  });

  it('every path shape is accepted and an unknown item is 404', async () => {
    jira = {
      ...jira,
      issues: [
        {
          key: 'HB-900',
          summary: 'ticket only',
          status: 'To Do',
          statusCategory: 'new',
          assignee: '712020:me',
          assigneeName: null,
          updated: '2026-09-09T00:00:00.000Z',
          url: 'https://example.atlassian.net/browse/HB-900',
        },
      ],
    };
    await start();
    await scan([]);
    expect((await request('POST', '/items/ticket/HB-900/dismiss')).status).toBe(200);
    expect((await request('POST', '/items/ticket/HB-900/undismiss')).status).toBe(200);
    expect((await request('POST', '/items/pr/acme/app/404/dismiss')).status).toBe(404);
    expect((await request('POST', '/items/session/nope/undismiss')).status).toBe(404);
  });
});

/**
 * Phase 14 — a session stays ADDRESSABLE once it is terminal.
 *
 * The live case: `pr-grace-frontend-2061-20260915-160008` is `dismissed`, its
 * PR merged and therefore left the open-PR inventory, and nothing else
 * references it — so it is in no list, `groupWorkItems` never makes an item
 * for it, and `GET /items/session/<id>` answered
 * `{"error":"No work item found for …"}`. The user could not open the only
 * artifact the session had.
 */
describe('GET /items/session/:id resolves for ANY session the store knows', () => {
  const MERGED_SESSION_ID = 'pr-app-2061-20260915-160008';

  function terminalReviewSession(): Session {
    return {
      schemaVersion: 2,
      id: MERGED_SESSION_ID,
      mode: 'review',
      createdAt: '2026-09-15T16:00:08.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git' },
      lineage: { pipelineId: MERGED_SESSION_ID, parentSessionId: null, ticket: null, selfReview: false },
      agent: null,
      lastRun: null,
      pr: {
        repo: 'acme/app',
        number: 2061,
        url: 'https://github.com/acme/app/pull/2061',
        headSha: 'b'.repeat(40),
        reviewedSha: null,
        title: 'feat(HB-6210): the landed change',
        author: 'bob',
      },
      stageStatus: 'dismissed',
      reviewVersion: 0,
      lastRereviewSummary: null,
    } as unknown as Session;
  }

  it('resolves the terminal review on a merged PR, with its agent, its PR state and its artifacts', async () => {
    prStates = {
      'acme/app#2061': {
        ...PR_STATE_ENTRY_DEFAULTS,
        author: 'bob',
        createdAt: '2026-09-09T08:00:00Z',
        state: 'merged',
        title: 'feat(HB-6210): the landed change',
        url: 'https://github.com/acme/app/pull/2061',
        mergedAt: '2026-09-15T14:28:21Z',
        closedAt: '2026-09-15T14:28:21Z',
        branch: 'feature/HB-6210-x',
        ticketKeys: ['HB-6210'],
        checkedAt: '2026-09-15T16:10:00.000Z',
      },
    };
    await start();
    // The PR merged, so it is NOT in the open-PR inventory.
    await scan([]);
    const session = terminalReviewSession();
    await ih.h.store.save(session);
    await ih.h.fs.mkdir(`${SESSIONS_DIR}/${session.id}`, { recursive: true });
    await ih.h.fs.writeFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`, '# REVIEW — PR #2061\n');

    const res = await request('GET', `/items/session/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.item.agents.map((a: Json) => a.sessionId)).toEqual([session.id]);
    expect(res.body.item.agents[0]).toMatchObject({ mode: 'review', phase: 'dismissed' });
    expect(res.body.item.prs).toHaveLength(1);
    expect(res.body.item.prs[0]).toMatchObject({ repo: 'acme/app', number: 2061, state: 'merged' });
    // It belongs to no list — that is the point, and it is NOT a 404.
    expect(res.body.item.lists).toEqual([]);
    expect(res.body.artifacts[session.id].map((a: Json) => a.name)).toContain('BRIEF.md');
  });

  it('the lists themselves are unchanged — the terminal session is in none of them', async () => {
    await start();
    await scan([]);
    await ih.h.store.save(terminalReviewSession());
    const res = await request('GET', '/items');
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: Json) => i.agents.some((a: Json) => a.sessionId === MERGED_SESSION_ID))).toBeUndefined();
  });

  it('an unknown session id still 404s', async () => {
    await start();
    await scan([]);
    const res = await request('GET', '/items/session/never-existed-20260915-000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No work item found');
  });
});

describe("POST /items/<path>/agents { mode: 'qa' } (§3)", () => {
  const MERGE_SHA = 'abc1234def567890abc1234def567890abc12345';

  function mergedPrViewJson(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      number: 11,
      title: 'PR #11',
      author: { login: 'me-user' },
      headRefName: 'feature/HB-6211-x',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      url: 'https://github.com/acme/app/pull/11',
      state: 'MERGED',
      isDraft: false,
      reviewDecision: 'APPROVED',
      mergedAt: '2026-09-09T00:00:00.000Z',
      closedAt: '2026-09-09T00:00:00.000Z',
      latestReviews: [],
      statusCheckRollup: [],
      mergeCommit: { oid: MERGE_SHA },
      files: [{ path: 'src/a.tsx' }],
      ...over,
    });
  }

  it('creates AND starts the verification, exactly like respond', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: mergedPrViewJson() });
    const res = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ created: true, started: true });
    expect(res.body.session.mode).toBe('qa');
    expect(res.body.session.stageStatus).toBe('verifying');
    expect(runStarts).toEqual(['verify']);
    const brief = await ih.h.fs.readFile(`${SESSIONS_DIR}/${res.body.session.id}/BRIEF.md`);
    expect(brief).toContain('# QA VERIFICATION — HB-6211');
  });

  it("start:false creates the session, writes BRIEF.md and starts NO run (MG-26)", async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: mergedPrViewJson() });
    const res = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa', start: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: true, started: false });
    expect(res.body.session.stageStatus).toBe('queued');
    expect(runStarts).toEqual([]);
    expect(agentStarts).toBe(0);
    expect(await ih.h.fs.readFile(`${SESSIONS_DIR}/${res.body.session.id}/BRIEF.md`)).toContain('# QA VERIFICATION');
  });

  it('a second POST never creates a second session and re-runs instead', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: mergedPrViewJson() });
    const first = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    await ih.h.finishRun({ 'QA.md': '## QA Verdict\n- Verdict: ✅ Ready to deploy\n' }, { code: 0, signal: null });
    const second = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    expect(second.body).toMatchObject({ created: false, started: true });
    expect(second.body.session.id).toBe(first.body.session.id);
    expect((await ih.h.store.list()).filter((s) => s.mode === 'qa').length).toBe(1);
  });

  it('a run in flight and a live claim each refuse with a reason, never a second session', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: mergedPrViewJson() });
    await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    const inFlight = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    expect(inFlight.status).toBe(200);
    expect(inFlight.body).toMatchObject({ created: false, started: false });
    expect(inFlight.body.reason).toContain('in flight');

    await ih.h.finishRun({ 'QA.md': '## QA Verdict\n- Verdict: ✅ Ready to deploy\n' }, { code: 0, signal: null });
    await ih.h.service.claimConversation(inFlight.body.session.id);
    const claimed = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    expect(claimed.body).toMatchObject({ created: false, started: false });
    expect(claimed.body.reason).toContain('claim');
  });

  it('R70: an UNMERGED PR is refused, and nothing is created', async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    ih.gh.queueResponse({ stdout: mergedPrViewJson({ state: 'OPEN', mergeCommit: null }) });
    const res = await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not merged');
    expect((await ih.h.store.list()).filter((s) => s.mode === 'qa').length).toBe(0);
  });

  it("mode 'qa' is accepted by the request validator; a bogus mode is still a 400", async () => {
    await start();
    await scan([prFixture(11, 'me-user')]);
    expect((await request('POST', '/items/pr/acme/app/11/agents', { mode: 'nope' })).status).toBe(400);
    expect((await request('POST', '/items/pr/acme/app/11/agents', { mode: 'qa', start: 'yes' })).status).toBe(400);
  });
});
