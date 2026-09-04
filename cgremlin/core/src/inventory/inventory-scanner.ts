import type { GhRunner } from '../gh/gh-runner';
import { PR_INVENTORY_FIELDS, parsePrInventoryList } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { InventoryStore } from './inventory-store';
import type { EngineEvents } from '../engine/events';
import type { TickReport } from '../discovery/reconciliation';
import type { Tickable } from '../discovery/scheduler';
import { buildEntries, groupInventory, type Inventory, type InventoryEntry, type InventoryGroups } from './inventory';
import type { Session } from '../schema/session';

export interface InventoryScannerDeps {
  gh: GhRunner;
  store: SessionStore;
  inventoryStore: InventoryStore;
  reconciler: { reconcile(): Promise<TickReport> };
  events: EngineEvents;
  config: { repos: string[]; me: string; watchAuthors: string[]; prListLimit: number };
  now?: () => Date;
}

export interface ScanReport {
  inventory: Inventory;
  groups: InventoryGroups;
  reconciliation: TickReport;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

    const entries: InventoryEntry[] = [];
    for (const repo of this.deps.config.repos) {
      try {
        const { stdout } = await this.deps.gh.run([
          'pr', 'list',
          '--repo', repo,
          '--state', 'open',
          '--limit', String(this.deps.config.prListLimit),
          '--json', PR_INVENTORY_FIELDS,
        ]);
        const items = parsePrInventoryList(stdout);
        entries.push(...buildEntries(repo, items, sessions, this.deps.config, nowIso));
      } catch (err) {
        errors.push({ repo, error: errorMessage(err) });
      }
    }

    const inventory: Inventory = {
      scannedAt: nowIso,
      repos: [...this.deps.config.repos],
      entries,
      errors,
    };
    const groups = groupInventory(inventory);

    await this.deps.inventoryStore.save(inventory);

    const report: ScanReport = { inventory, groups, reconciliation };
    this._lastReport = report;
    this.deps.events.emit('inventory.updated', { inventory });
    return report;
  }
}
