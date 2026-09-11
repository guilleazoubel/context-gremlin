import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JiraRestSource } from '../../src/jira/jira-rest-source';
import { JiraAuthError, JiraUnavailableError } from '../../src/jira/jira-source';

const fixturesDir = path.join(__dirname, '../fixtures/jira');
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');

const SITE_URL = 'https://aplaceformom.atlassian.net';
const EMAIL = 'guilherme.azoubel@aplaceformom.com';
const TOKEN = 'atl-secret-token';

const DEFAULT_FIELDS = 'summary,description,issuetype,status,priority,labels,assignee,reporter,attachment,comment';

interface Recorded {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
}

type Responder = (req: Recorded, res: ServerResponse) => void;

class Stub {
  readonly requests: Recorded[] = [];
  private server: Server | null = null;
  baseUrl = '';
  responder: Responder = (_req, res) => {
    res.writeHead(404).end('{}');
  };

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
      };
      this.requests.push(recorded);
      this.responder(recorded, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  json(res: ServerResponse, body: string, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  }
}

let stub: Stub;

beforeEach(async () => {
  stub = new Stub();
  await stub.start();
});

afterEach(async () => {
  await stub.stop();
});

function source(overrides: Partial<ConstructorParameters<typeof JiraRestSource>[0]> = {}): JiraRestSource {
  return new JiraRestSource({
    baseUrl: stub.baseUrl,
    siteUrl: SITE_URL,
    email: EMAIL,
    apiToken: TOKEN,
    timeoutMs: 2_000,
    sleep: async () => {},
    ...overrides,
  });
}

describe('JiraRestSource: the request it makes', () => {
  it('sends Basic auth built from email:token, asks for JSON, and sends the JQL and field list verbatim', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('search-jql-page2'));
    await source().search('assignee = currentUser() ORDER BY updated DESC');

    const [req] = stub.requests;
    expect(req.method).toBe('GET');
    expect(req.pathname).toBe('/rest/api/3/search/jql');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`);
    expect(req.headers.accept).toBe('application/json');
    expect(req.query.get('jql')).toBe('assignee = currentUser() ORDER BY updated DESC');
    expect(req.query.get('fields')).toBe(DEFAULT_FIELDS);
  });

  it('appends jira.extraFields and never sends acceptance_criteria or customfield_10016 by default', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('search-jql-page2'));
    await source({ extraFields: ['customfield_10016'] }).search('x');
    const fields = stub.requests[0].query.get('fields') ?? '';
    expect(fields).toBe(`${DEFAULT_FIELDS},customfield_10016`);

    stub.requests.length = 0;
    await source().search('x');
    const plain = stub.requests[0].query.get('fields') ?? '';
    expect(plain).not.toContain('acceptance_criteria');
    expect(plain).not.toContain('customfield_10016');
  });

  it('asks for expand=renderedFields on the issue call only', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.pathname.endsWith('/comment') ? fixture('issue-comments') : fixture('issue'));
    await source().issue('HB-627');
    const issueReq = stub.requests.find((r) => r.pathname === '/rest/api/3/issue/HB-627')!;
    expect(issueReq.query.get('expand')).toBe('renderedFields');
    expect(issueReq.query.get('fields')).toBe(DEFAULT_FIELDS);
  });
});

describe('JiraRestSource: R37 — url comes from siteUrl, never baseUrl', () => {
  it('builds every browse URL from siteUrl while baseUrl points at the stub', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('search-jql-page2'));
    const issues = await source().search('x');
    expect(stub.baseUrl).not.toBe(SITE_URL);
    expect(issues[0].url).toBe(`${SITE_URL}/browse/GRAC-12`);
    expect(JSON.stringify(issues)).not.toContain('127.0.0.1');
  });

  it('the issue detail url comes from siteUrl too', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.pathname.endsWith('/comment') ? fixture('issue-comments') : fixture('issue'));
    const detail = await source().issue('HB-627');
    expect(detail.url).toBe(`${SITE_URL}/browse/HB-627`);
  });
});

describe('JiraRestSource: R37 — comments come from the comment endpoint, newest first', () => {
  it('fetches /issue/{key}/comment with orderBy=-created and maxResults=5 and returns bodyText', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.pathname.endsWith('/comment') ? fixture('issue-comments') : fixture('issue'));
    const detail = await source().issue('HB-627');

    const commentReq = stub.requests.find((r) => r.pathname === '/rest/api/3/issue/HB-627/comment')!;
    expect(commentReq.query.get('orderBy')).toBe('-created');
    expect(commentReq.query.get('maxResults')).toBe('5');
    expect(commentReq.query.get('expand')).toBe('renderedBody');

    expect(detail.comments.map((c) => c.author)).toEqual(['Someone Else', 'Guilherme Azoubel']);
    expect(detail.comments[0].bodyText).toBe('Newest comment, with a link (https://example.com).');
  });

  it('R33/MG-10: the description arrives as TEXT and no *Html field exists on the result', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.pathname.endsWith('/comment') ? fixture('issue-comments') : fixture('issue'));
    const detail = await source().issue('HB-627');
    expect(detail.descriptionText).toBe(
      'The parking lot must show bold open PRs only.\n\n- no drafts\n- no mine',
    );
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('<b>');
    expect(Object.keys(detail).some((k) => k.endsWith('Html'))).toBe(false);
  });
});

describe('JiraRestSource: R32 — both pagination shapes, one fallback per scan', () => {
  it('/search/jql pages by nextPageToken and stops on isLast', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.query.get('nextPageToken') === 'PAGE2TOKEN' ? fixture('search-jql-page2') : fixture('search-jql-page1'));
    const issues = await source().search('x');
    expect(issues.map((i) => i.key)).toEqual(['HB-627', 'HB-628', 'GRAC-12']);
    expect(stub.requests.map((r) => r.pathname)).toEqual(['/rest/api/3/search/jql', '/rest/api/3/search/jql']);
    expect(stub.requests[0].query.get('nextPageToken')).toBeNull();
    expect(stub.requests[1].query.get('nextPageToken')).toBe('PAGE2TOKEN');
  });

  it('/search pages by startAt, reading the RESPONSE maxResults, and stops at total', async () => {
    stub.responder = (req, res) => {
      if (req.pathname === '/rest/api/3/search/jql') return stub.json(res, '{}', 404);
      return stub.json(res, req.query.get('startAt') === '2' ? fixture('search-legacy-page2') : fixture('search-legacy-page1'));
    };
    // maxResults is requested as 50 but the fixture's response caps it at 2 —
    // paging must follow the RESPONSE's value, not the request's.
    const issues = await source({ maxResults: 50 }).search('x');
    expect(issues.map((i) => i.key)).toEqual(['HB-627', 'HB-628', 'GRAC-12']);
    const legacy = stub.requests.filter((r) => r.pathname === '/rest/api/3/search');
    expect(legacy.map((r) => r.query.get('startAt'))).toEqual(['0', '2']);
  });

  it('a 404 on /search/jql falls back ONCE PER SCAN, not once per page', async () => {
    stub.responder = (req, res) => {
      if (req.pathname === '/rest/api/3/search/jql') return stub.json(res, '{}', 404);
      return stub.json(res, req.query.get('startAt') === '2' ? fixture('search-legacy-page2') : fixture('search-legacy-page1'));
    };
    await source().search('x');
    // one 404 probe + two legacy pages = three requests, never four.
    expect(stub.requests.length).toBe(3);
    expect(stub.requests.filter((r) => r.pathname === '/rest/api/3/search/jql').length).toBe(1);
  });

  it('a 410 triggers the same fallback, and the flag does not persist across scans', async () => {
    let jqlHits = 0;
    stub.responder = (req, res) => {
      if (req.pathname === '/rest/api/3/search/jql') {
        jqlHits += 1;
        return stub.json(res, '{}', 410);
      }
      return stub.json(res, req.query.get('startAt') === '2' ? fixture('search-legacy-page2') : fixture('search-legacy-page1'));
    };
    const src = source();
    await src.search('x');
    await src.search('x');
    expect(jqlHits).toBe(2);
  });
});

describe('JiraRestSource: failures', () => {
  it('401 becomes a JiraAuthError quoting Jira own errorMessages[0]', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('error-401'), 401);
    await expect(source().search('x')).rejects.toThrow(JiraAuthError);
    await expect(source().search('x')).rejects.toThrow('Client must be authenticated to access this resource.');
  });

  it('403 becomes a JiraAuthError naming permission or captcha', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('error-403'), 403);
    const err = await source()
      .search('x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraAuthError);
    expect((err as Error).message.toLowerCase()).toMatch(/permission|captcha/);
  });

  it('429 with Retry-After is retried EXACTLY once and then gives up as unavailable', async () => {
    let hits = 0;
    stub.responder = (_req, res) => {
      hits += 1;
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }).end('{}');
    };
    await expect(source().search('x')).rejects.toThrow(JiraUnavailableError);
    expect(hits).toBe(2);
  });

  it('a 429 whose retry succeeds returns the result', async () => {
    let hits = 0;
    stub.responder = (_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' }).end('{}');
        return;
      }
      stub.json(res, fixture('search-jql-page2'));
    };
    const issues = await source().search('x');
    expect(issues.map((i) => i.key)).toEqual(['GRAC-12']);
    expect(hits).toBe(2);
  });

  it('a timeoutMs expiry aborts the request and becomes JiraUnavailableError', async () => {
    stub.responder = () => {
      /* never answers */
    };
    const err = await source({ timeoutMs: 40 })
      .search('x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraUnavailableError);
  });

  it('a caller-supplied AbortSignal aborts the request too', async () => {
    stub.responder = () => {
      /* never answers */
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(source().search('x', { signal: controller.signal })).rejects.toThrow(JiraUnavailableError);
  });

  it('a malformed body becomes JiraUnavailableError, never a raw SyntaxError', async () => {
    stub.responder = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('not json{');
    const err = await source()
      .search('x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraUnavailableError);
    expect((err as Error).name).not.toBe('SyntaxError');
  });

  it('a 500 becomes JiraUnavailableError', async () => {
    stub.responder = (_req, res) => stub.json(res, '{}', 500);
    await expect(source().search('x')).rejects.toThrow(JiraUnavailableError);
  });
});

describe('JiraRestSource: whoami', () => {
  it('returns accountId, displayName and emailAddress from /myself', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('myself'));
    const me = await source().whoami();
    expect(stub.requests[0].pathname).toBe('/rest/api/3/myself');
    expect(me.accountId).toBe('712020:f0acd024-8d3a-4b87-9d4b-768ee3eb3f74');
    expect(me.displayName).toBe('Guilherme Azoubel');
    expect(me.emailAddress).toBe('guilherme.azoubel@aplaceformom.com');
  });

  it('throws JiraAuthError on a 401', async () => {
    stub.responder = (_req, res) => stub.json(res, fixture('error-401'), 401);
    await expect(source().whoami()).rejects.toThrow(JiraAuthError);
  });
});

describe('JiraRestSource: the summary mapping', () => {
  it('maps status, statusCategory, assignee accountId and updated', async () => {
    stub.responder = (req, res) =>
      stub.json(res, req.query.get('nextPageToken') === 'PAGE2TOKEN' ? fixture('search-jql-page2') : fixture('search-jql-page1'));
    const [first, second] = await source().search('x');
    expect(first).toEqual({
      key: 'HB-627',
      summary: 'Parking lot should not show drafts',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      assignee: '712020:f0acd024-8d3a-4b87-9d4b-768ee3eb3f74',
      updated: '2026-09-09T10:00:00.000+0000',
      url: `${SITE_URL}/browse/HB-627`,
    });
    expect(second.assignee).toBeNull();
  });
});
