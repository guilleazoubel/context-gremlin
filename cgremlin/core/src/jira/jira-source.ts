/**
 * R10 — the Jira port. THREE read methods and no fourth: nothing in this
 * codebase writes to Jira, ever (D3, R55), and a source grep for a mutating
 * HTTP method under `src/jira` must stay empty.
 *
 * R33: no HTML crosses this port. Nothing below it carries an identifier
 * ending in the four letters MG-10 greps for — the adapter flattens Jira's
 * own `renderedFields` into text with `html-to-text.ts` and returns
 * `descriptionText` / `bodyText`.
 */

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  /** The assignee's Jira **accountId**, which is what `jira.me` is compared against (R37). */
  assignee: string | null;
  /**
   * The assignee's `displayName`, which Jira returns in the very same object
   * as the accountId. It is presentation ONLY — nothing compares against it,
   * and `assignee` stays the id so R37's `jira.me` check is untouched.
   */
  assigneeName: string | null;
  updated: string;
  /** R37: always built from `jira.siteUrl`, NEVER from `baseUrl`. */
  url: string;
}

export interface JiraIssueDetail extends JiraIssueSummary {
  /** R33: plain text only. */
  descriptionText: string | null;
  comments: Array<{ author: string; at: string; bodyText: string | null }>;
}

export interface JiraRequestOptions {
  /**
   * R34: the scan leg's budget is ONE `AbortController` spanning whoami and
   * every page, so the signal has to reach each request. Additive to the
   * port's shape in spec §R10.
   */
  signal?: AbortSignal;
}

export interface JiraSource {
  search(jql: string, opts?: JiraRequestOptions & { maxResults?: number }): Promise<JiraIssueSummary[]>;
  issue(key: string, opts?: JiraRequestOptions): Promise<JiraIssueDetail>;
  whoami(opts?: JiraRequestOptions): Promise<{ accountId: string; emailAddress?: string; displayName: string }>;
}

/** 401 or 403 — the user must act, and `cgremlin-core config check-jira` is how they see Jira's own wording. */
export class JiraAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'JiraAuthError';
  }
}

/** A timeout, a 5xx, a 429 that survived its retry, or a malformed body — stale tickets plus a banner, never an empty list. */
export class JiraUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JiraUnavailableError';
  }
}

/**
 * 0c final fix — a 404 or 410 on the ISSUE endpoint: Jira has no such ticket (a branch name
 * like `fix/UTF-8-handling` that merely looks like a key, or a deleted issue). Not an outage
 * and not an auth problem, so it never blocks a run: the brief says "none linked".
 */
export class JiraNotFoundError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'JiraNotFoundError';
  }
}
