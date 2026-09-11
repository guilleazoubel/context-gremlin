import type { AttentionItem } from '../attention/attention-service';
import type { EngineEvents } from '../engine/events';
import type { Inventory } from '../inventory/inventory';
import type { JiraScanReport, TicketSourceKind } from '../jira/jira-store';
import { groupWorkItems, workListsOf, type WorkItem, type WorkLists } from './work-item';
import type { WorkItemId } from './work-item-id';

export interface WorkItemServiceDeps {
  /**
   * R1/R27: the ONLY way this service learns anything about a session. It
   * reads no session document, no AGENT_STATE file and no artifact mtime of
   * its own — which is what makes MG-1 (zero `lock.enter` on a full
   * `GET /items`) hold by construction rather than by care. The DoD grep
   * over `src/work` is what keeps it that way.
   */
  attention: { list(opts: { all?: boolean; dedupe?: boolean }): Promise<{ evaluatedAt: string; items: AttentionItem[] }> };
  inventory: { load(): Promise<Inventory | null> };
  jira: { lastReport(): Promise<JiraScanReport> };
  /** R52 — filled in by the review-thread leg; `{ error: null }` until it has run. */
  threads?: { lastReport(): { scannedAt: string | null; error: string | null; fetched: number } };
  events: EngineEvents;
  config: {
    me: string;
    watchAuthors: readonly string[];
    showAllRepoPrs: boolean;
    projectKeys: readonly string[];
    botLogins?: readonly string[];
    jiraSiteUrl?: string;
  };
}

export interface WorkItemListing {
  evaluatedAt: string;
  lists: WorkLists;
  items: WorkItem[];
  ticketSource: { kind: TicketSourceKind; error: string | null; scannedAt: string };
  threadSource: { error: string | null; scannedAt: string | null };
}

/**
 * What a delta is measured on — the state a client renders. Deliberately NOT
 * the whole item: `item.changed` carries `{ id, kind, changedFields? }` and
 * nothing else, because `EVENT_RING_CAPACITY` is 256 and 256 buffered
 * `WorkItem`s (each with its PRs, ticket, agents and reasons) is resident
 * memory paid for frames nobody will read (R41).
 */
function deltaFieldsOf(item: WorkItem): Record<string, string> {
  return {
    kind: item.kind,
    lists: item.lists.join(','),
    parkingLotGroup: String(item.parkingLotGroup),
    demoted: String(item.demoted),
    title: item.title,
    needsYou: String(item.needsYou),
    attention: `${item.attention.reasons.join(',')}|${item.attention.since}|${item.attention.acked}`,
    agents: JSON.stringify(
      item.agents.map((a) => [a.sessionId, a.mode, a.phase, a.running, a.needsYou, a.claimed]),
    ),
    prs: JSON.stringify(item.prs.map((p) => [p.repo, p.number, p.updatedAt, p.reviewDecision, p.ci, p.isDraft])),
    ticket: JSON.stringify(item.ticket === null ? null : [item.ticket.key, item.ticket.status, item.ticket.updatedAt]),
  };
}

export class WorkItemService {
  private readonly lastDelta = new Map<WorkItemId, Record<string, string>>();
  private unsubscribers: Array<() => void> = [];
  private scheduled: Promise<void> | null = null;

  constructor(private readonly deps: WorkItemServiceDeps) {}

  async list(): Promise<WorkItemListing> {
    const [attention, inventory, jira] = await Promise.all([
      // R27: the PRE-dedupe list, so a work item can see whether the PR is a
      // draft, who requested review, and whether a human has reviewed it.
      this.deps.attention.list({ all: true, dedupe: false }),
      this.deps.inventory.load().catch(() => null),
      this.deps.jira.lastReport(),
    ]);
    const items = groupWorkItems({
      items: attention.items,
      inventory,
      jira,
      me: this.deps.config.me,
      watchAuthors: this.deps.config.watchAuthors,
      showAllRepoPrs: this.deps.config.showAllRepoPrs,
      projectKeys: this.deps.config.projectKeys,
      ...(this.deps.config.botLogins !== undefined ? { botLogins: this.deps.config.botLogins } : {}),
      ...(this.deps.config.jiraSiteUrl !== undefined ? { jiraSiteUrl: this.deps.config.jiraSiteUrl } : {}),
    });
    const threads = this.deps.threads?.lastReport() ?? { scannedAt: null, error: null, fetched: 0 };
    return {
      evaluatedAt: attention.evaluatedAt,
      lists: workListsOf(items),
      items,
      ticketSource: { kind: jira.kind, error: jira.error, scannedAt: jira.scannedAt },
      threadSource: { error: threads.error, scannedAt: threads.scannedAt },
    };
  }

  /** By the item's OWN id. Path-shaped lookups (R65) resolve through `list()` in the API layer. */
  async get(id: WorkItemId): Promise<WorkItem | null> {
    return (await this.list()).items.find((item) => item.id === id) ?? null;
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const schedule = (): void => this.schedule();
    this.unsubscribers = [
      this.deps.events.on('attention.changed', schedule),
      this.deps.events.on('inventory.updated', schedule),
    ];
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  /** Test seam: resolves once any scheduled recompute has finished. */
  async whenIdle(): Promise<void> {
    while (this.scheduled !== null) await this.scheduled;
  }

  /**
   * A burst of `attention.changed` for one item coalesces into ONE
   * `item.changed`: the recompute is scheduled on a microtask, and anything
   * arriving while it runs schedules exactly one more pass.
   */
  private schedule(): void {
    if (this.scheduled !== null) return;
    this.scheduled = Promise.resolve()
      .then(async () => {
        this.scheduled = null;
        await this.recompute();
      })
      .catch(() => {
        // Every caller is an engine event, so a rejection here would be an
        // unhandled rejection and nothing would be better off. The next
        // event recomputes from scratch.
        this.scheduled = null;
      });
  }

  private async recompute(): Promise<void> {
    const { items } = await this.list();
    const seen = new Set<WorkItemId>();
    for (const item of items) {
      seen.add(item.id);
      const next = deltaFieldsOf(item);
      const previous = this.lastDelta.get(item.id);
      this.lastDelta.set(item.id, next);
      if (previous === undefined) {
        this.deps.events.emit('item.changed', { id: item.id, kind: item.kind });
        continue;
      }
      const changedFields = Object.keys(next).filter((key) => next[key] !== previous[key]);
      if (changedFields.length === 0) continue;
      this.deps.events.emit('item.changed', { id: item.id, kind: item.kind, changedFields });
    }
    // Forget what is gone, so a later re-appearance is a delta again.
    for (const id of [...this.lastDelta.keys()]) {
      if (!seen.has(id)) this.lastDelta.delete(id);
    }
  }
}
