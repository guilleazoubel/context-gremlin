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
import { parseChanges, type SessionChanges } from './model/changes';
import type { ItemDetailResponse, ItemsResponse } from './model/work-items';
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
    super(`${method} ${path} failed with ${status}: ${engineErrorText(body)}`);
    this.name = 'CoreHttpError';
  }
}

export interface HttpResult {
  status: number;
  body: unknown;
}

/**
 * The engine's own wording for a failure. Its 4xx messages are already written for humans
 * (`README.md:194-212`), so every surface shows this verbatim rather than inventing its own.
 */
export function engineErrorText(body: unknown): string {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const value = (body as { error: unknown }).error;
    if (typeof value === 'string') return value;
  }
  return typeof body === 'string' ? body : JSON.stringify(body ?? null);
}

const OFFLINE_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

/** A path parameter that cannot be spliced into a request path. Never reaches the socket. */
export class InvalidPathParamError extends Error {
  constructor(kind: string, value: unknown) {
    super(`Refusing to address the engine with an unsafe ${kind}: ${JSON.stringify(value)}`);
    this.name = 'InvalidPathParamError';
  }
}

/**
 * One path segment, verbatim. The engine matches raw path segments, but it re-parses the request
 * target with `new URL(...)` first — so a `?` or `#` inside an id would silently truncate the path
 * and address a *different* route. `\w` covers `[A-Za-z0-9_]`; `.`, `:`, `@` and `-` are the only
 * other characters a core-derived session id can carry (ids are built from a repo slug and a ticket,
 * and the ticket allow-list is `/^[A-Za-z0-9._-]+$/`), and `:` is explicitly legal in a session id.
 */
const SAFE_SEGMENT = /^[\w.:@-]+$/;

export function assertSessionId(id: string): string {
  if (typeof id !== 'string' || !SAFE_SEGMENT.test(id) || id === '.' || id === '..') {
    throw new InvalidPathParamError('session id', id);
  }
  return id;
}

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

export function assertRepoSlug(repo: string): string {
  if (typeof repo !== 'string' || !REPO_SLUG.test(repo) || repo.includes('..')) {
    throw new InvalidPathParamError('repo slug', repo);
  }
  return repo;
}

export function assertPrNumber(number: number): string {
  if (!Number.isInteger(number) || number <= 0) {
    throw new InvalidPathParamError('PR number', number);
  }
  return String(number);
}

/**
 * One `/items` route path, already segmented (R14): `ticket/<KEY>`, `pr/<owner>/<repo>/<n>` or
 * `session/<id>`. The extension builds these with `itemPathOf`, never by interpolating a raw id
 * — an id carries `/` and `#`, which a path cannot (MG-9).
 */
const ITEM_PATH =
  /^(?:ticket\/[A-Za-z0-9._-]+|pr\/[\w.-]+\/[\w.-]+\/\d+|session\/[\w.:@-]+)$/;

export function assertItemPath(path: string): string {
  if (typeof path !== 'string' || !ITEM_PATH.test(path) || path.includes('..')) {
    throw new InvalidPathParamError('item path', path);
  }
  return path;
}

/** `parseArtifactName` (`src/api/validation.ts:101-102`), mirrored. */
const ARTIFACT_NAME = /^[A-Za-z0-9._-]+$/;

export function assertArtifactName(name: string): string {
  if (typeof name !== 'string' || !ARTIFACT_NAME.test(name) || name === '.' || name === '..') {
    throw new InvalidPathParamError('artifact name', name);
  }
  return name;
}

/**
 * Where the engine's socket is. A function is resolved on **every** request, which is what lets a
 * settings change take effect without rebuilding the client layer — and therefore without tearing
 * down the tree, the status bar and every outstanding chat claim (R7).
 */
export type SocketPathSource = string | (() => string);

export function resolveSocketPath(source: SocketPathSource): string {
  return typeof source === 'function' ? source() : source;
}

export class CoreClient {
  constructor(private readonly socketPath: SocketPathSource) {}

  // Every id-bearing method is `async` on purpose: its path-parameter check must surface as a
  // *rejected promise*, not a synchronous throw, so one call site can handle both failure modes.

  /**
   * A response body as **text**, exactly as the engine sent it. Everything else goes through
   * {@link CoreClient.request}, which parses JSON; an artifact must not, because it is a
   * document (`server.ts:280` answers `text/plain`) and JSON-parsing then re-serialising one
   * that happens to look like JSON would silently reorder its keys and eat its whitespace.
   */
  requestText(method: string, path: string): Promise<{ status: number; text: string }> {
    const socketPath = resolveSocketPath(this.socketPath);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path, method, headers: { Accept: 'text/plain, application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(OFFLINE_CODES.has(err.code ?? '') ? new EngineNotRunningError(socketPath) : err);
      });
      req.end();
    });
  }

  request(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    // Resolved per request, never captured in the constructor (R7).
    const socketPath = resolveSocketPath(this.socketPath);
    return new Promise<HttpResult>((resolve, reject) => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.byteLength);
      }
      const req = http.request({ socketPath, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: parseBody(text) });
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(OFFLINE_CODES.has(err.code ?? '') ? new EngineNotRunningError(socketPath) : err);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

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

  /** R24: the one read a refresh makes. Four lists, one round trip. */
  items(): Promise<ItemsResponse> {
    return this.expect('GET', '/items');
  }

  /** R65: the path addresses the item that *contains* it, which may answer with a ticket id. */
  async item(path: string): Promise<ItemDetailResponse> {
    return await this.expect('GET', `/items/${assertItemPath(path)}`);
  }

  /** R15/R56. `{ mode: 'respond' }` creates AND starts, in this one request. */
  async startAgent(
    path: string,
    body: {
      mode: string;
      repoUrl?: string;
      intent?: string;
      driveToCompletion?: boolean;
      /** A review of MY OWN change (the forward-only ladder's last stage) — the core would
       *  otherwise answer 409 `OwnPrError`. */
      selfReview?: boolean;
      /**
       * Phase 15 §3: `false` creates the QA session and writes its `BRIEF.md` WITHOUT running it
       * (R73) — the chat-only entry. Absent means the engine's own default, which is `true`.
       */
      start?: boolean;
    },
  ): Promise<HttpResult> {
    return await this.request('POST', `/items/${assertItemPath(path)}/agents`, body);
  }

  /**
   * Phase 18 — "find the PRs of this ticket". ONE `gh pr list --search` engine-side, written
   * into the pr-state cache, with the refreshed item in the answer. Addressed by the TICKET
   * because the whole point is that there is no PR to address it by.
   */
  async discoverPrs(ticketKey: string): Promise<HttpResult> {
    return await this.request('POST', `/items/${assertItemPath(`ticket/${ticketKey}`)}/prs/discover`);
  }

  /** R31: one request; the core fans out over every ref the item contributes. */
  async ackItem(path: string): Promise<HttpResult> {
    return await this.request('POST', `/items/${assertItemPath(path)}/ack`);
  }

  /**
   * Item 2: put this item aside, or take it back. The core owns the flag — it persists it, it
   * drops the item from every list, and it undismisses on its own the moment the item needs you.
   * Both answer `200 { item }`; the panel re-reads `/items` rather than trusting the echo.
   */
  async dismissItem(path: string): Promise<HttpResult> {
    return await this.request('POST', `/items/${assertItemPath(path)}/dismiss`);
  }

  async undismissItem(path: string): Promise<HttpResult> {
    return await this.request('POST', `/items/${assertItemPath(path)}/undismiss`);
  }

  /**
   * The artifact body, which the host relays over `postMessage` — never a file URI (R19).
   * Returned as the bytes the engine sent: an artifact that parses as JSON is still a document.
   */
  async artifactText(id: string, name: string): Promise<string> {
    const path = `/sessions/${assertSessionId(id)}/artifacts/${assertArtifactName(name)}`;
    const result = await this.requestText('GET', path);
    if (result.status < 200 || result.status >= 300) {
      throw new CoreHttpError(result.status, parseBody(result.text), 'GET', path);
    }
    return result.text;
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

  async artifacts(id: string): Promise<ArtifactListingResponse> {
    return await this.expect('GET', `/sessions/${assertSessionId(id)}/artifacts`);
  }

  /**
   * "Changes so far" for one session (§4, amended). Answers `null` rather than throwing on a
   * non-2xx: an engine older than Phase 10 does not serve this route at all, and a 404 there must
   * paint a `—` in one expanded row — never replace the lists with engine trouble.
   */
  async changes(id: string): Promise<SessionChanges | null> {
    const result = await this.request('GET', `/sessions/${assertSessionId(id)}/changes`);
    if (result.status < 200 || result.status >= 300) return null;
    return parseChanges(result.body);
  }

  async conversation(id: string): Promise<ConversationView> {
    return await this.expect('GET', `/sessions/${assertSessionId(id)}/conversation`);
  }

  async claim(id: string): Promise<void> {
    await this.expect('POST', `/sessions/${assertSessionId(id)}/conversation/claim`);
  }

  /**
   * Defect 3 — the release as a RESULT, for the command that offers it beside a refusal: there
   * the engine's wording is the thing being shown, so a throw would be the wrong shape.
   */
  async releaseConversation(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/conversation/release`);
  }

  /** The same route, as a throw — the terminal's close path wants the failure, not a result. */
  async release(id: string): Promise<void> {
    const path = `/sessions/${assertSessionId(id)}/conversation/release`;
    const result = await this.request('POST', path);
    if (result.status < 200 || result.status >= 300) {
      throw new CoreHttpError(result.status, result.body, 'POST', path);
    }
  }

  async startReview(repo: string, number: number): Promise<HttpResult> {
    return await this.request('POST', `/prs/${assertRepoSlug(repo)}/${assertPrNumber(number)}/review`);
  }

  async approvePlan(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/approve-plan`);
  }

  /**
   * Phase 21 — the second half of the handoff, and the reason the first half was worth nothing on
   * its own. `POST /sessions/:id/promote` creates the CHILD development session: same workspace,
   * `lineage.parentSessionId` set to this investigation, FINDINGS.md and PLAN.md copied across,
   * and the develop turn started. It is refused while a human turn is claimed (R19) — the refusal
   * is the engine's to make and its sentence is the one the panel surfaces.
   */
  async promote(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/promote`);
  }

  async stop(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/stop`);
  }

  async retry(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/retry`);
  }

  async run(id: string, stage: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/run`, { stage });
  }

  /** The generic, source-agnostic ack path — preferred over the two aliases below. */
  ack(ref: ItemRef): Promise<HttpResult> {
    return this.request('POST', '/attention/ack', { ref });
  }

  async ackSession(id: string): Promise<HttpResult> {
    return await this.request('POST', `/sessions/${assertSessionId(id)}/ack`);
  }

  async ackPr(repo: string, number: number): Promise<HttpResult> {
    return await this.request('POST', `/prs/${assertRepoSlug(repo)}/${assertPrNumber(number)}/ack`);
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
