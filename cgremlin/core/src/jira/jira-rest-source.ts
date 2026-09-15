import { htmlToText } from './html-to-text';
import {
  JiraAuthError,
  JiraUnavailableError,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraRequestOptions,
  type JiraSource,
} from './jira-source';

/**
 * Ported verbatim from `bin/cgremlin:1930-1932` MINUS the two
 * instance-specific names (`acceptance_criteria`, `customfield_10016`): an
 * unknown field name makes Jira 400 the WHOLE request, so they belong in
 * `jira.extraFields` and nowhere else (U2).
 */
export const JIRA_DEFAULT_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'labels',
  'assignee',
  'reporter',
  'attachment',
  'comment',
] as const;

export interface JiraRestSourceOptions {
  /** Injectable (D7/R10) so a test can point at a stub on 127.0.0.1. */
  baseUrl: string;
  /** R37: every browse URL is built from HERE, never from `baseUrl`. */
  siteUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  /** Per HTTP request. */
  timeoutMs?: number;
  maxResults?: number;
  extraFields?: readonly string[];
  /** Injected in tests so the single 429 retry does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** The most a `Retry-After` may make one request wait before we give up instead. */
const MAX_RETRY_AFTER_MS = 5_000;

interface RawIssue {
  key: string;
  fields?: {
    summary?: string | null;
    updated?: string | null;
    status?: { name?: string; statusCategory?: { key?: string } } | null;
    assignee?: { accountId?: string; displayName?: string } | null;
  } | null;
  renderedFields?: { description?: string | null } | null;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * The abort the caller's already-fired signal stands for. `addEventListener`
 * on a signal that has ALREADY aborted never fires, so the retry after a
 * raced-out backoff has to raise this itself — and raising an `AbortError`
 * keeps it on `get`'s normal abort path (a `JiraUnavailableError` saying the
 * request was aborted), rather than inventing a second error shape.
 */
function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export class JiraRestSource implements JiraSource {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly authorization: string;
  /**
   * R32: whether this site's `/search/jql` is gone (404/410), decided ONCE
   * per scan and reused by every `search()` call the REST of that scan makes
   * — the main JQL listing AND every seeded-ticket lookup, which all share
   * the scan's one `AbortSignal` (see `JiraScanner.scan()`). Keyed on that
   * signal (rather than cached forever on the adapter) so a later, distinct
   * scan still gets its own probe — a site can come back, and a caller with
   * no signal at all (a bare `search()` in a test, say) is never cached.
   * Without this, each call re-probes `/search/jql` and pays its own 404
   * before falling back, turning one scan's fallback into N of them.
   */
  private readonly legacyOnlyForSignal = new WeakMap<AbortSignal, true>();

  constructor(private readonly opts: JiraRestSourceOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // The ONE place the token is ever read. It never reaches a URL, a log
    // line, a brief, an event frame or `jira.json` (R44, MG-5).
    this.authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;
  }

  private get fields(): string {
    return [...JIRA_DEFAULT_FIELDS, ...(this.opts.extraFields ?? [])].join(',');
  }

  private browseUrl(key: string): string {
    return `${this.opts.siteUrl.replace(/\/+$/, '')}/browse/${key}`;
  }

  /**
   * One GET, with the request-level timeout and any caller signal folded into
   * one `AbortSignal`. Returns the parsed body, or throws a `JiraAuthError` /
   * `JiraUnavailableError` — never a bare `SyntaxError` or `AbortError`.
   */
  private async get(
    pathname: string,
    query: Record<string, string | undefined>,
    opts: JiraRequestOptions | undefined,
    allowStatuses: readonly number[] = [],
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(pathname, this.opts.baseUrl.replace(/\/+$/, '') + '/');
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const attempt = async (): Promise<Response> => {
      if (opts?.signal?.aborted === true) throw abortError();
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      opts?.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        return await this.fetchImpl(url, {
          // Read-only, forever (R55, D3): there is no other method in this file.
          method: 'GET',
          headers: { authorization: this.authorization, accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
      }
    };

    let response: Response;
    try {
      response = await attempt();
      if (response.status === 429) {
        // Exactly ONE bounded retry, then give up as unavailable.
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        const waitMs = Number.isNaN(retryAfter) ? 1_000 : Math.min(retryAfter * 1_000, MAX_RETRY_AFTER_MS);
        // R34: the scan budget is ONE budget for the whole leg, and a
        // `Retry-After` backoff is wall time like any other. The sleep
        // therefore RACES the caller's signal; losing it falls straight
        // through to `attempt()`, which sees the aborted signal and takes the
        // normal abort path.
        await this.sleepOrAbort(waitMs, opts?.signal);
        response = await attempt();
      }
    } catch (err) {
      if (isAbortError(err)) {
        throw new JiraUnavailableError(`Jira request to ${pathname} was aborted (timeout ${this.timeoutMs}ms)`, {
          cause: err,
        });
      }
      throw new JiraUnavailableError(`Jira request to ${pathname} failed: ${(err as Error).message}`, { cause: err });
    }

    const raw = await response.text().catch(() => '');
    let body: unknown = null;
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        if (response.ok) {
          throw new JiraUnavailableError(`Jira returned a body that is not JSON for ${pathname}`, { cause: err });
        }
      }
    }

    if (response.ok) return { status: response.status, body };
    if (allowStatuses.includes(response.status)) return { status: response.status, body };

    const jiraSaid = firstErrorMessage(body);
    if (response.status === 401) {
      throw new JiraAuthError(
        jiraSaid ?? 'Jira rejected the credentials (401).',
        401,
      );
    }
    if (response.status === 403) {
      throw new JiraAuthError(
        jiraSaid ?? 'Jira refused the request (403): a permission error, or a CAPTCHA challenge.',
        403,
      );
    }
    throw new JiraUnavailableError(
      `Jira responded ${response.status} for ${pathname}${jiraSaid !== null ? `: ${jiraSaid}` : ''}`,
    );
  }

  /** `sleep(ms)`, except that an abort on `signal` ends the wait early. */
  private async sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) return this.sleep(ms);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      void this.sleep(ms).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  async search(jql: string, opts?: JiraRequestOptions & { maxResults?: number }): Promise<JiraIssueSummary[]> {
    const maxResults = opts?.maxResults ?? this.opts.maxResults ?? 50;
    const issues: JiraIssueSummary[] = [];

    // R32: `/search/jql` first, paging by nextPageToken. A 404 or 410 means
    // this instance has not migrated (or has un-migrated); once THAT is
    // discovered it is cached against this scan's signal, so every later
    // call this scan makes (the main JQL listing AND every seeded-ticket
    // lookup) goes straight to the legacy endpoint instead of re-probing
    // `/search/jql` and re-paying its 404.
    if (opts?.signal !== undefined && this.legacyOnlyForSignal.has(opts.signal)) {
      return this.searchLegacy(jql, maxResults, opts);
    }

    let nextPageToken: string | undefined;
    for (;;) {
      const { status, body } = await this.get(
        'rest/api/3/search/jql',
        { jql, fields: this.fields, maxResults: String(maxResults), nextPageToken },
        opts,
        [404, 410],
      );
      if (status === 404 || status === 410) {
        if (opts?.signal !== undefined) this.legacyOnlyForSignal.set(opts.signal, true);
        return this.searchLegacy(jql, maxResults, opts);
      }
      const page = body as { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean } | null;
      for (const raw of page?.issues ?? []) issues.push(this.toSummary(raw));
      if (page?.isLast === true) break;
      if (page?.nextPageToken === undefined || page.nextPageToken === '') break;
      nextPageToken = page.nextPageToken;
    }
    return issues;
  }

  /** R32: the legacy endpoint, paging by `startAt` and reading the RESPONSE's own `maxResults`. */
  private async searchLegacy(
    jql: string,
    requestedMaxResults: number,
    opts: JiraRequestOptions | undefined,
  ): Promise<JiraIssueSummary[]> {
    const issues: JiraIssueSummary[] = [];
    let startAt = 0;
    for (;;) {
      const { body } = await this.get(
        'rest/api/3/search',
        { jql, fields: this.fields, maxResults: String(requestedMaxResults), startAt: String(startAt) },
        opts,
      );
      const page = body as { issues?: RawIssue[]; startAt?: number; maxResults?: number; total?: number } | null;
      const pageIssues = page?.issues ?? [];
      for (const raw of pageIssues) issues.push(this.toSummary(raw));
      const total = page?.total ?? issues.length;
      // Jira caps maxResults server-side, so the response's value is the only
      // honest page size; the request's would skip or repeat rows.
      const pageSize = page?.maxResults ?? pageIssues.length;
      startAt += pageSize > 0 ? pageSize : pageIssues.length;
      if (pageIssues.length === 0 || issues.length >= total || startAt >= total) break;
    }
    return issues;
  }

  async issue(key: string, opts?: JiraRequestOptions): Promise<JiraIssueDetail> {
    const { body } = await this.get(
      `rest/api/3/issue/${encodeURIComponent(key)}`,
      { fields: this.fields, expand: 'renderedFields' },
      opts,
    );
    const raw = body as RawIssue | null;
    if (raw === null || typeof raw !== 'object' || typeof raw.key !== 'string') {
      throw new JiraUnavailableError(`Jira returned no issue for ${key}`);
    }
    const summary = this.toSummary(raw);
    const rendered = raw.renderedFields?.description ?? null;

    // R37: the comment endpoint, newest first. The issue payload's `comment`
    // field returns the OLDEST comments, which is the opposite of what the
    // brief and the tab want.
    const { body: commentBody } = await this.get(
      `rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { orderBy: '-created', maxResults: '5', expand: 'renderedBody' },
      opts,
    );
    const rawComments =
      (commentBody as { comments?: Array<{ author?: { displayName?: string }; created?: string; renderedBody?: string }> } | null)
        ?.comments ?? [];

    return {
      ...summary,
      descriptionText: rendered === null ? null : htmlToText(rendered, this.opts.siteUrl),
      comments: rawComments.map((c) => ({
        author: c.author?.displayName ?? 'unknown',
        at: c.created ?? '',
        bodyText: c.renderedBody === undefined ? null : htmlToText(c.renderedBody, this.opts.siteUrl),
      })),
    };
  }

  async whoami(opts?: JiraRequestOptions): Promise<{ accountId: string; emailAddress?: string; displayName: string }> {
    // The same credential check the legacy tool used (`bin/cgremlin:1894-1901`).
    const { body } = await this.get('rest/api/3/myself', {}, opts);
    const me = body as { accountId?: string; displayName?: string; emailAddress?: string } | null;
    if (me === null || typeof me.accountId !== 'string') {
      throw new JiraUnavailableError('Jira /myself returned no accountId');
    }
    return {
      accountId: me.accountId,
      displayName: me.displayName ?? me.accountId,
      ...(me.emailAddress !== undefined ? { emailAddress: me.emailAddress } : {}),
    };
  }

  private toSummary(raw: RawIssue): JiraIssueSummary {
    const fields = raw.fields ?? {};
    return {
      key: raw.key,
      summary: fields.summary ?? '',
      status: fields.status?.name ?? '',
      statusCategory: fields.status?.statusCategory?.key ?? '',
      assignee: fields.assignee?.accountId ?? null,
      assigneeName: fields.assignee?.displayName ?? null,
      updated: fields.updated ?? '',
      url: this.browseUrl(raw.key),
    };
  }
}

function firstErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const messages = (body as { errorMessages?: unknown }).errorMessages;
  if (Array.isArray(messages) && typeof messages[0] === 'string' && messages[0] !== '') return messages[0];
  return null;
}
