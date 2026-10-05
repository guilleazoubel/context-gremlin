import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { JiraAuthError, JiraNotFoundError, type JiraIssueDetail, type JiraIssueSummary, type JiraSource } from './jira-source';

/** R35 — four kinds, not two booleans. `kind !== 'notConfigured'` is the same answer `configured` used to give. */
export type TicketSourceKind = 'notConfigured' | 'auth' | 'unavailable' | 'ok';

export interface JiraScanReport {
  scannedAt: string;
  /** R37 — the accountId from `whoami()`, resolved once per scan. `myWork` compares against it. */
  me: string | null;
  issues: JiraIssueSummary[];
  /**
   * R28 — the summaries of keys the JQL never returned, fetched one by one
   * because a PR or a session named them. Present only when there are any,
   * so a report with nothing seeded keeps the shape it always had. They are
   * NOT candidates of their own: `groupWorkItems` iterates `issues` to make
   * ticket items and reads these only to describe a row that already exists.
   */
  seeded?: JiraIssueSummary[];
  error: string | null;
  kind: TicketSourceKind;
}

const JiraIssueSummarySchema = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string(),
  assignee: z.string().nullable(),
  // Defaulted, not required: a `jira.json` written before this field existed
  // must still parse, or an upgrade silently discards the cache.
  assigneeName: z.string().nullable().default(null),
  updated: z.string(),
  url: z.string(),
});

const JiraScanReportSchema = z.object({
  scannedAt: z.string(),
  me: z.string().nullable(),
  issues: z.array(JiraIssueSummarySchema),
  seeded: z.array(JiraIssueSummarySchema).optional(),
  error: z.string().nullable(),
  kind: z.enum(['notConfigured', 'auth', 'unavailable', 'ok']),
});

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * `<stateDir>/jira.json`, written tmp-then-rename exactly like
 * `InventoryStore` (`inventory-store.ts:26-32`). Unlike the inventory, a
 * corrupt or unreadable cache is NOT an error: the whole point of the cache
 * is that an unreachable Jira degrades to stale tickets plus a banner, so a
 * bad file degrades the same way rather than 500ing a read.
 *
 * MG-5: the report carries issue content and an accountId. It never carries
 * the API token or an Authorization header, because nothing puts them here.
 */
export class JiraStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  async save(report: JiraScanReport): Promise<void> {
    const validated = JiraScanReportSchema.parse(report);
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, this.path);
  }

  async load(): Promise<JiraScanReport | null> {
    if (!(await this.fs.exists(this.path))) return null;
    try {
      return JiraScanReportSchema.parse(JSON.parse(await this.fs.readFile(this.path)));
    } catch {
      return null;
    }
  }
}

/**
 * R36 — the ticket DETAIL cache, 60 s TTL keyed on the ticket's `updated` in
 * the current scan snapshot. Opening the same tab twice in a minute is one
 * network call; a ticket edited in Jira between two scans invalidates
 * immediately rather than waiting out the TTL.
 *
 * `item.changed` deliberately does NOT refetch: a work item changes for many
 * reasons (an agent's phase, a PR update) and refetching the ticket on each
 * would turn one busy pipeline into a Jira rate-limit incident. The tab
 * re-renders from the cached detail.
 */
export const TICKET_DETAIL_TTL_MS = 60_000;

interface DetailEntry {
  at: number;
  /** The `updated` this detail was fetched at, or null when the snapshot did not carry the ticket. */
  updatedAt: string | null;
  detail: JiraIssueDetail;
}

export interface TicketDetailResult {
  ticket: JiraIssueDetail | null;
  ticketError: string | null;
  /**
   * 0c — WHY `ticket` is null, so a brief can say so instead of going silent: `auth` for a
   * JiraAuthError, `unavailable` for a JiraUnavailableError or anything else thrown,
   * `not_configured` when there is no source at all. Null whenever `ticket` is set.
   */
  ticketErrorKind: 'auth' | 'unavailable' | 'not_configured' | null;
  /**
   * 0c final fix — set (true) only when Jira answered 404/410 for the issue: there is no such
   * ticket. `ticketErrorKind` stays `unavailable` (its union is unchanged) so every existing
   * reader is unaffected; the engine's brief state reads this flag and says "none linked".
   */
  ticketNotFound?: true;
}

export class TicketDetailCache {
  private readonly entries = new Map<string, DetailEntry>();

  constructor(
    private readonly deps: {
      source: JiraSource | null;
      snapshot(): Promise<JiraScanReport>;
      now?: () => Date;
      ttlMs?: number;
    },
  ) {}

  /** Test seam: how many times the underlying source was actually asked. */
  fetches = 0;

  async detail(key: string): Promise<TicketDetailResult> {
    if (this.deps.source === null) return { ticket: null, ticketError: null, ticketErrorKind: 'not_configured' };
    const nowMs = (this.deps.now ?? (() => new Date()))().getTime();
    const ttl = this.deps.ttlMs ?? TICKET_DETAIL_TTL_MS;
    const snapshot = await this.deps.snapshot().catch(() => null);
    const updatedAt = snapshot?.issues.find((i) => i.key === key)?.updated ?? null;

    const cached = this.entries.get(key);
    if (cached !== undefined && nowMs - cached.at < ttl && cached.updatedAt === updatedAt) {
      return { ticket: cached.detail, ticketError: null, ticketErrorKind: null };
    }
    try {
      this.fetches += 1;
      const detail = await this.deps.source.issue(key);
      this.entries.set(key, { at: nowMs, updatedAt, detail });
      return { ticket: detail, ticketError: null, ticketErrorKind: null };
    } catch (err) {
      // The route never 5xxs because Jira is down: the tab renders the item
      // with `ticket: null` and says why.
      return {
        ticket: null,
        ticketError: err instanceof Error ? err.message : String(err),
        // JiraUnavailableError and any unexpected throw are both "Jira did not answer usefully".
        ticketErrorKind: err instanceof JiraAuthError ? 'auth' : 'unavailable',
        // Not cached either: a ticket created a minute later must load.
        ...(err instanceof JiraNotFoundError ? { ticketNotFound: true as const } : {}),
      };
    }
  }
}
