/**
 * A stubbed Atlassian Cloud v3 instance, on `127.0.0.1:0`.
 *
 * D7/R10 is why this can exist at all: `jira.baseUrl` is injectable, so the REAL `JiraRestSource`
 * inside the REAL engine talks to this over real HTTP — no seam inside the core is stubbed, and
 * the shapes below are the ones U2 named (the `/search/jql` cursor scheme, the `/search` legacy
 * one behind a 404, `renderedFields` on the issue, `orderBy=-created` on the comments).
 *
 * The token is checked, never echoed: a request with the wrong credential is a 401, which is how
 * MG-6's `kind: 'auth'` case is driven without editing the engine's config.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

const FIXTURES = path.join(__dirname, 'fake-jira');

/**
 * - `ok` answers from the fixtures.
 * - `auth` answers 401 to everything (MG-6).
 * - `down` destroys the socket, the closest thing to "the stub is gone" that keeps the port (MG-6).
 * - `hang` accepts the request and never answers, so the scan budget is what ends it (R34).
 * - `legacySearch` 404s `/search/jql`, which is what makes the adapter fall back to `/search` (R32).
 */
export type FakeJiraMode = 'ok' | 'auth' | 'down' | 'hang' | 'legacySearch';

export interface FakeJiraRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
}

export interface FakeJira {
  baseUrl: string;
  /** Every request that reached the stub, in order. */
  requests(): readonly FakeJiraRequest[];
  clear(): void;
  setMode(mode: FakeJiraMode): void;
  stop(): Promise<void>;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

export interface StartFakeJiraOptions {
  /** The credential the stub accepts. Anything else is a 401. */
  apiToken: string;
  email?: string;
  mode?: FakeJiraMode;
}

export async function startFakeJira(opts: StartFakeJiraOptions): Promise<FakeJira> {
  const email = opts.email ?? 'integration@example.com';
  const expected = `Basic ${Buffer.from(`${email}:${opts.apiToken}`).toString('base64')}`;
  const seen: FakeJiraRequest[] = [];
  let mode: FakeJiraMode = opts.mode ?? 'ok';
  /** Held open on purpose in `hang` mode; destroyed on stop so the server can close. */
  const hung = new Set<http.ServerResponse>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://jira.invalid');
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    seen.push({ method: req.method ?? 'GET', pathname: url.pathname, query });

    if (mode === 'down') {
      req.socket.destroy();
      return;
    }
    if (mode === 'hang') {
      hung.add(res);
      res.on('close', () => hung.delete(res));
      return;
    }

    const send = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    };

    if (mode === 'auth' || req.headers.authorization !== expected) {
      send(401, { errorMessages: ['Basic auth with password is not allowed on this instance'], errors: {} });
      return;
    }
    // R55's posture, enforced by the stub as well as by the adapter's one GET.
    if (req.method !== 'GET') {
      send(405, { errorMessages: [`the stub is read-only; ${req.method ?? '?'} is refused`], errors: {} });
      return;
    }

    if (url.pathname === '/rest/api/3/myself') {
      send(200, fixture('myself.json'));
      return;
    }

    if (url.pathname === '/rest/api/3/search/jql') {
      if (mode === 'legacySearch') {
        send(404, { errorMessages: ['This endpoint has been removed'], errors: {} });
        return;
      }
      const token = url.searchParams.get('nextPageToken');
      send(200, fixture(token === 'page-two' ? 'search-jql-page2.json' : 'search-jql-page1.json'));
      return;
    }

    if (url.pathname === '/rest/api/3/search') {
      send(200, fixture('search-legacy.json'));
      return;
    }

    const comments = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(url.pathname);
    if (comments !== null) {
      send(200, readIssueFixture(`comments-${decodeURIComponent(comments[1])}.json`));
      return;
    }

    const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
    if (issue !== null) {
      const body = readIssueFixture(`issue-${decodeURIComponent(issue[1])}.json`);
      if (body === null) {
        send(404, { errorMessages: [`Issue does not exist: ${decodeURIComponent(issue[1])}`], errors: {} });
        return;
      }
      send(200, body);
      return;
    }

    send(404, { errorMessages: [`no stub route for ${url.pathname}`], errors: {} });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => seen,
    clear: () => {
      seen.length = 0;
    },
    setMode: (next) => {
      mode = next;
    },
    stop: async () => {
      for (const res of hung) res.destroy();
      hung.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** `null` when the fixture is simply not there — a Jira key the stub does not know. */
function readIssueFixture(name: string): unknown {
  try {
    return fixture(name);
  } catch {
    return null;
  }
}
