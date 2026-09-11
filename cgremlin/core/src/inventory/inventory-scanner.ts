import type { GhRunner } from '../gh/gh-runner';
import {
  PR_INVENTORY_FIELDS,
  PR_INVENTORY_FIELDS_CONNECTIONS,
  PR_INVENTORY_FIELDS_SCALARS,
  parsePrInventoryList,
  type PrInventoryItem,
} from '../gh/pr-view';
import { GhCommandError } from '../gh/gh-runner';
import type { SessionStore } from '../engine/session-store';
import type { InventoryStore } from './inventory-store';
import type { EngineEvents } from '../engine/events';
import type { TickReport } from '../discovery/reconciliation';
import type { Tickable } from '../discovery/scheduler';
import { buildEntries, groupInventory, type Inventory, type InventoryEntry, type InventoryGroups } from './inventory';
import type { Session } from '../schema/session';
import type { JiraScanReport } from '../jira/jira-store';

export interface InventoryScannerDeps {
  gh: GhRunner;
  store: SessionStore;
  inventoryStore: InventoryStore;
  reconciler: { reconcile(): Promise<TickReport> };
  events: EngineEvents;
  config: {
    repos: string[];
    me: string;
    watchAuthors: string[];
    prListLimit: number;
    botLogins?: readonly string[];
    projectKeys?: readonly string[];
  };
  now?: () => Date;
  /**
   * R12/R34 — the Jira leg. Optional, because an engine with no `jira` block
   * has no leg at all. It runs AFTER `inventory.updated` is emitted, is not
   * awaited, and is single-flight; `lastReport()` is what `ScanReport.jira`
   * carries, so `POST /prs/scan` answers at PR speed whatever Jira is doing.
   */
  jira?: {
    run(): Promise<JiraScanReport>;
    inFlight(): Promise<void> | null;
    lastReport(): Promise<JiraScanReport>;
  };
}

export interface ScanReport {
  inventory: Inventory;
  groups: InventoryGroups;
  reconciliation: TickReport;
  jira: JiraScanReport;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * R67 — GitHub's GraphQL node limit is a HARD error, not a truncation: the
 * whole `gh pr list` fails and the repo returns nothing. The exact wording is
 * instance- and version-dependent (part of U6), so both forms are matched.
 */
function isNodeLimitError(err: unknown): boolean {
  if (!(err instanceof GhCommandError)) return false;
  const stderr = err.stderr.toLowerCase();
  return stderr.includes('max_node_limit_exceeded') || stderr.includes('exceeds the maximum node limit');
}

export class InventoryScanner implements Tickable<ScanReport> {
  private _lastReport: ScanReport | null = null;

  constructor(private readonly deps: InventoryScannerDeps) {}

  get lastReport(): ScanReport | null {
    return this._lastReport;
  }

  async run(): Promise<ScanReport> {
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();

    const reconciliation = await this.deps.reconciler.reconcile();

    const errors: { repo: string; error: string }[] = [];
    let sessions: readonly Session[] = [];
    try {
      sessions = await this.deps.store.list();
    } catch (err) {
      errors.push({ repo: '*', error: `store.list failed: ${errorMessage(err)}` });
    }

    // On a per-repo failure, fall back to that repo's entries from the last
    // completed scan (in memory, or on disk if this process hasn't scanned
    // yet) instead of dropping the repo's PRs entirely for one bad tick — a
    // transient gh failure must not make PRs vanish from the inventory or
    // 404 an in-flight POST .../review. Loaded at most once per run().
    let fallbackInventory: Inventory | null = this._lastReport?.inventory ?? null;

    const listArgs = (repo: string, fields: string): string[] => [
      'pr', 'list',
      '--repo', repo,
      '--state', 'open',
      '--limit', String(this.deps.config.prListLimit),
      '--json', fields,
    ];

    const entries: InventoryEntry[] = [];
    for (const repo of this.deps.config.repos) {
      try {
        let items: PrInventoryItem[];
        try {
          const { stdout } = await this.deps.gh.run(listArgs(repo, PR_INVENTORY_FIELDS));
          items = parsePrInventoryList(stdout);
        } catch (err) {
          if (!isNodeLimitError(err)) throw err;
          // R67: one retry, per repo and per scan, with the fields
          // partitioned across two calls and joined on `number`. If call B
          // also trips the limit the error propagates and the repo falls back
          // to the previous scan's entries, below.
          const [scalars, connections] = [
            await this.deps.gh.run(listArgs(repo, PR_INVENTORY_FIELDS_SCALARS)),
            await this.deps.gh.run(listArgs(repo, PR_INVENTORY_FIELDS_CONNECTIONS)),
          ];
          const byNumber = new Map<number, Record<string, unknown>>();
          for (const raw of JSON.parse(connections.stdout.trim() === '' ? '[]' : connections.stdout) as Record<
            string,
            unknown
          >[]) {
            byNumber.set(raw.number as number, raw);
          }
          const merged = (
            JSON.parse(scalars.stdout.trim() === '' ? '[]' : scalars.stdout) as Record<string, unknown>[]
          ).map((raw) => ({ ...raw, ...(byNumber.get(raw.number as number) ?? {}) }));
          items = parsePrInventoryList(JSON.stringify(merged));
        }
        entries.push(...buildEntries(repo, items, sessions, this.deps.config, nowIso));
      } catch (err) {
        errors.push({ repo, error: errorMessage(err) });
        if (fallbackInventory === null) {
          fallbackInventory = await this.deps.inventoryStore.load();
        }
        entries.push(...(fallbackInventory?.entries.filter((e) => e.repo === repo) ?? []));
      }
    }

    const inventory: Inventory = {
      scannedAt: nowIso,
      repos: [...this.deps.config.repos],
      entries,
      errors,
    };
    const groups = groupInventory(inventory);

    try {
      await this.deps.inventoryStore.save(inventory);
    } catch (err) {
      inventory.errors.push({ repo: '*', error: `inventoryStore.save failed: ${errorMessage(err)}` });
    }

    const jira: JiraScanReport = (await this.deps.jira?.lastReport()) ?? {
      scannedAt: nowIso,
      me: null,
      issues: [],
      error: null,
      kind: 'notConfigured',
    };

    const report: ScanReport = { inventory, groups, reconciliation, jira };
    this._lastReport = report;
    this.deps.events.emit('inventory.updated', { inventory });

    // R34: the leg starts only AFTER the PR half is published, and `run()`
    // does not await it — with it inline, a Jira that hangs for
    // timeoutMs x pages also stalls the panel's only fresh data and a
    // user-initiated rescan. Single-flight, and its failures are reported on
    // the next tick's report rather than thrown into this one.
    if (this.deps.jira !== undefined && this.deps.jira.inFlight() === null) {
      void this.deps.jira.run().catch(() => undefined);
    }
    return report;
  }

  /** Drains the in-flight Jira leg, so a shutdown never leaves a half-written cache. */
  async stop(): Promise<void> {
    await this.deps.jira?.inFlight()?.catch(() => undefined);
  }
}
