import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { AckStore } from '../../src/attention/ack-store';
import { AttentionService, PrSourceAdapter, SessionSourceAdapter } from '../../src/attention/attention-service';
import { WorkItemService } from '../../src/work/work-item-service';
import { createInventoryHarness, type InventoryHarness } from '../support/inventory-harness';
import { SESSIONS_DIR } from '../support/pipeline-harness';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { JiraIssueDetail } from '../../src/jira/jira-source';

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
