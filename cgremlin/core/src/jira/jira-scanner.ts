import { JiraAuthError, type JiraSource } from './jira-source';
import type { JiraScanReport, JiraStore } from './jira-store';

export interface JiraScannerDeps {
  /** `null` means there is no `jira` block, or it carries no token — R35's `notConfigured`. */
  source: JiraSource | null;
  store: JiraStore;
  jql: string;
  /** R34 — ONE budget for the whole leg: whoami plus every page. */
  scanBudgetMs: number;
  maxResults?: number;
  now?: () => Date;
}

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
      const report: JiraScanReport = {
        scannedAt: this.nowIso(),
        me: me.accountId,
        issues,
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
