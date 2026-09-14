import { JiraAuthError, type JiraIssueSummary, type JiraSource } from './jira-source';
import type { JiraScanReport, JiraStore } from './jira-store';

export interface JiraScannerDeps {
  /** `null` means there is no `jira` block, or it carries no token — R35's `notConfigured`. */
  source: JiraSource | null;
  store: JiraStore;
  jql: string;
  /** R34 — ONE budget for the whole leg: whoami plus every page. */
  scanBudgetMs: number;
  maxResults?: number;
  /**
   * R28 — every ticket key a PR branch or a session lineage named. The ones
   * the JQL did not return are fetched individually, so a row seeded from a
   * LINK still has a summary instead of ''. Absent = no seeding at all.
   */
  seededKeys?: () => Promise<readonly string[]>;
  now?: () => Date;
}

/** The same shape `parseWorkItemId` accepts — anything else never reaches a JQL string. */
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;

/**
 * A ceiling on the extra requests one scan may make. The seeded set is
 * normally a handful of keys; a config change that suddenly widens
 * `projectKeys` must not turn one tick into a rate-limit incident.
 */
const MAX_SEEDED_FETCHES = 25;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * R12/R34/R35 — the Jira leg of the discovery tick. It is folded into the
 * existing tick rather than given a second scheduler (a second `runNow`, a
 * second `lastError`, a second thing `serve()` must start and stop), but it
 * runs AFTER `inventory.updated` is emitted, is not awaited by the tick, is
 * single-flight, and reports its failures instead of throwing them.
 */
export class JiraScanner {
  private last: JiraScanReport | null = null;
  private flight: Promise<JiraScanReport> | null = null;

  constructor(private readonly deps: JiraScannerDeps) {}

  /** The in-flight leg, for `stop()` to drain and for a tick to see it must not start a second. */
  inFlight(): Promise<void> | null {
    return this.flight === null ? null : this.flight.then(() => undefined);
  }

  /**
   * The LAST COMPLETED report — from memory, else from `jira.json` on a cold
   * start. `ScanReport.jira` carries this, which is what lets `POST /prs/scan`
   * answer at PR speed against a Jira that is timing out.
   */
  async lastReport(): Promise<JiraScanReport> {
    if (this.last !== null) return this.last;
    const cached = await this.deps.store.load();
    if (cached !== null) {
      this.last = cached;
      return cached;
    }
    return this.emptyReport(this.deps.source === null ? 'notConfigured' : 'unavailable', null);
  }

  async run(): Promise<JiraScanReport> {
    // Single flight: a tick that starts while one leg is running joins it
    // rather than opening a second conversation with Jira.
    if (this.flight !== null) return this.flight;
    this.flight = this.scan().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private emptyReport(kind: JiraScanReport['kind'], error: string | null): JiraScanReport {
    return { scannedAt: this.nowIso(), me: null, issues: [], error, kind };
  }

  /**
   * One extra request per seeded key the snapshot does not already hold,
   * inside the SAME budget as the rest of the leg (the scan's own signal is
   * passed in, so an expiring budget simply ends the loop). Every failure —
   * an unconfigured Jira, a 404 for a key someone typo'd into a branch name,
   * an aborted request — falls back to what the cache already knew and
   * otherwise leaves the summary '' rather than failing the scan.
   */
  private async fetchSeeded(
    source: JiraSource,
    held: readonly JiraIssueSummary[],
    signal: AbortSignal,
  ): Promise<JiraIssueSummary[]> {
    if (this.deps.seededKeys === undefined) return [];
    let keys: readonly string[];
    try {
      keys = await this.deps.seededKeys();
    } catch {
      return [];
    }
    const known = new Set(held.map((i) => i.key));
    const wanted = [...new Set(keys)]
      .filter((key) => TICKET_KEY.test(key) && !known.has(key))
      .slice(0, MAX_SEEDED_FETCHES);
    if (wanted.length === 0) return [];

    // The previous scan's answers: what a failed re-fetch degrades to.
    const cached = new Map(
      ((this.last ?? (await this.deps.store.load()))?.seeded ?? []).map((i) => [i.key, i] as const),
    );
    const seeded: JiraIssueSummary[] = [];
    for (const key of wanted) {
      let found: JiraIssueSummary | undefined;
      try {
        // `search` and not `issue`: the summary port already returns exactly
        // these fields in one request, where `issue()` also fetches comments
        // and rendered HTML the row will never show. The key is matched
        // against TICKET_KEY above, so nothing else can reach the JQL.
        [found] = await source.search(`key = "${key}"`, { signal, maxResults: 1 });
      } catch {
        found = undefined;
      }
      const resolved = found ?? cached.get(key);
      if (resolved !== undefined) seeded.push(resolved);
    }
    return seeded;
  }

  private async scan(): Promise<JiraScanReport> {
    const source = this.deps.source;
    if (source === null) {
      // R35: no block, or a token-less block, is "I haven't set this up" —
      // not an error, and NOT a reason to make a request or clobber a cache.
      const report = this.emptyReport('notConfigured', null);
      this.last = report;
      return report;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.scanBudgetMs);
    try {
      const me = await source.whoami({ signal: controller.signal });
      const issues = await source.search(this.deps.jql, {
        signal: controller.signal,
        ...(this.deps.maxResults !== undefined ? { maxResults: this.deps.maxResults } : {}),
      });
      const seeded = await this.fetchSeeded(source, issues, controller.signal);
      const report: JiraScanReport = {
        scannedAt: this.nowIso(),
        me: me.accountId,
        issues,
        ...(seeded.length > 0 ? { seeded } : {}),
        error: null,
        kind: 'ok',
      };
      try {
        await this.deps.store.save(report);
      } catch {
        // A cache we could not write is not a scan that failed: the issues in
        // hand are still good for this tick.
      }
      this.last = report;
      return report;
    } catch (err) {
      // Degrade, never empty (MG-6): keep the previous tickets and say why
      // they are stale. The previous `jira.json` is deliberately NOT
      // rewritten, so a restart still finds yesterday's answer.
      const previous = this.last ?? (await this.deps.store.load());
      const report: JiraScanReport = {
        scannedAt: this.nowIso(),
        me: previous?.me ?? null,
        issues: previous?.issues ?? [],
        ...(previous?.seeded !== undefined && previous.seeded.length > 0 ? { seeded: previous.seeded } : {}),
        error: errorMessage(err),
        kind: err instanceof JiraAuthError ? 'auth' : 'unavailable',
      };
      this.last = report;
      return report;
    } finally {
      clearTimeout(timer);
    }
  }
}
