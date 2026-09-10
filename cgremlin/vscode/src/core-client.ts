/**
 * The engine's HTTP API over its Unix socket.
 *
 * Pure module — Node stdlib only, no editor API (MG-B1).
 *
 * Two response conventions, deliberately:
 *  - methods that return {@link HttpResult} never throw on an HTTP status, because the UI surfaces
 *    the engine's own wording for a 4xx verbatim;
 *  - methods that return a domain value throw {@link CoreHttpError} on a non-2xx, because there is
 *    no value to hand back.
 * Both throw {@link EngineNotRunningError} when the socket is not there.
 */
import http from 'node:http';
import type {
  ArtifactListingResponse,
  AttentionListing,
  ConversationView,
  CoreConfigView,
  Inventory,
  InventoryGroups,
  ItemRef,
  SessionView,
} from './model/items';

export class EngineNotRunningError extends Error {
  constructor(readonly socketPath: string) {
    super(`cgremlin engine is not running (no engine on ${socketPath})`);
    this.name = 'EngineNotRunningError';
  }
}

/** A non-2xx answer to a request whose caller needs the value, not the status. */
export class CoreHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} failed with ${status}: ${errorTextOf(body)}`);
    this.name = 'CoreHttpError';
  }
}

export interface HttpResult {
  status: number;
  body: unknown;
}

function errorTextOf(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const value = (body as { error: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return typeof body === 'string' ? body : JSON.stringify(body ?? null);
}

const OFFLINE_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

export class CoreClient {
  constructor(private readonly socketPath: string) {}

  request(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<HttpResult>((resolve, reject) => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.byteLength);
      }
      const req = http.request({ socketPath: this.socketPath, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: parseBody(text) });
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(OFFLINE_CODES.has(err.code ?? '') ? new EngineNotRunningError(this.socketPath) : err);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Session ids and repo slugs go into the path verbatim: the engine matches raw path segments. */
  private async expect<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.request(method, path, body);
    if (result.status < 200 || result.status >= 300) {
      throw new CoreHttpError(result.status, result.body, method, path);
    }
    return result.body as T;
  }

  async config(): Promise<CoreConfigView> {
    const body = await this.expect<{ config: CoreConfigView }>('GET', '/config');
    return body.config;
  }

  prs(): Promise<{ inventory: Inventory; groups: InventoryGroups }> {
    return this.expect('GET', '/prs');
  }

  sessions(): Promise<{ sessions: SessionView[] }> {
    return this.expect('GET', '/sessions');
  }

  attention(all?: boolean): Promise<AttentionListing> {
    return this.expect('GET', all === true ? '/attention?all=1' : '/attention');
  }

  artifacts(id: string): Promise<ArtifactListingResponse> {
    return this.expect('GET', `/sessions/${id}/artifacts`);
  }

  conversation(id: string): Promise<ConversationView> {
    return this.expect('GET', `/sessions/${id}/conversation`);
  }

  async claim(id: string): Promise<void> {
    await this.expect('POST', `/sessions/${id}/conversation/claim`);
  }

  async release(id: string): Promise<void> {
    await this.expect('POST', `/sessions/${id}/conversation/release`);
  }

  startReview(repo: string, number: number): Promise<HttpResult> {
    return this.request('POST', `/prs/${repo}/${number}/review`);
  }

  approvePlan(id: string): Promise<HttpResult> {
    return this.request('POST', `/sessions/${id}/approve-plan`);
  }

  stop(id: string): Promise<HttpResult> {
    return this.request('POST', `/sessions/${id}/stop`);
  }

  retry(id: string): Promise<HttpResult> {
    return this.request('POST', `/sessions/${id}/retry`);
  }

  run(id: string, stage: string): Promise<HttpResult> {
    return this.request('POST', `/sessions/${id}/run`, { stage });
  }

  /** The generic, source-agnostic ack path — preferred over the two aliases below. */
  ack(ref: ItemRef): Promise<HttpResult> {
    return this.request('POST', '/attention/ack', { ref });
  }

  ackSession(id: string): Promise<HttpResult> {
    return this.request('POST', `/sessions/${id}/ack`);
  }

  ackPr(repo: string, number: number): Promise<HttpResult> {
    return this.request('POST', `/prs/${repo}/${number}/ack`);
  }

  scan(): Promise<HttpResult> {
    return this.request('POST', '/prs/scan');
  }

  createInvestigation(input: {
    repoUrl: string;
    ticket: string | null;
    intent: 'investigate_only' | 'development';
    driveToCompletion: boolean;
  }): Promise<HttpResult> {
    return this.request('POST', '/sessions/investigations', input);
  }

  createDevelopment(input: { repoUrl: string; ticket: string | null }): Promise<HttpResult> {
    return this.request('POST', '/sessions/developments', input);
  }

  createReviewFromUrl(prUrl: string): Promise<HttpResult> {
    return this.request('POST', '/reviews', { prUrl });
  }
}

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
