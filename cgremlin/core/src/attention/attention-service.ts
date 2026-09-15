import type { SessionStore } from '../engine/session-store';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { EngineEvents } from '../engine/events';
import type { Inventory } from '../inventory/inventory';
import type { LocalAppStatus } from '../env/environment-service';
import type { SessionWatchEvent, SessionWatcher } from '../fs/session-watcher';
import type { Session, SessionMode } from '../schema/session';
import { repoSlugFromUrl } from '../gh/repo-slug';
import { isClaimed } from '../pipeline/pipeline-service';
import { pickPrimaryArtifact } from '../api/artifacts';
import { parseArtifactName } from '../api/validation';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import {
  deriveSessionReasons,
  derivePrReasons,
  evaluateAttention,
  type AttentionState,
  type DerivedReason,
} from './attention';
import { AckStore } from './ack-store';
import { prRef, sessionRef, type ItemRef, type ItemSource } from './item-ref';

/** 404 for a ref that names nothing — the one new error class this task adds. */
export class ItemNotFoundError extends Error {
  constructor(ref: ItemRef) {
    super(`No item found for ref '${ref}'`);
    this.name = 'ItemNotFoundError';
  }
}

/**
 * Every optional affordance an item may offer. ALL fields nullable, so a new
 * source fills in what it has and a client feature-detects rather than
 * switching on `source` (R18).
 */
export interface ItemLinks {
  sessionId: string | null;
  worktreePath: string | null;
  prRepo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** session.lineage.ticket — the Jira join key. */
  ticket: string | null;
  /**
   * Populated by SessionSourceAdapter via `pickPrimaryArtifact` (R11), so a
   * row can be opened from `/attention` alone. Null for a source with no
   * artifacts, and for a session that has not written one yet.
   */
  primaryArtifact: string | null;
}

/** The generic item every source produces (R18). */
export interface Item {
  source: ItemSource;
  ref: ItemRef;
  /** The source-local id: a session id, 'owner/name#12', a ticket key… */
  id: string;
  title: string;
  /** 'owner/name' for pr/session; a project key or channel later. */
  repoOrContext: string;
  attention: AttentionState;
  links: ItemLinks;
}

export interface AttentionItem extends Item {
  /** null for a non-session source. */
  mode: SessionMode | null;
  stageStatus: string | null;
  running: boolean;
  /**
   * humanTurn !== null AND not expired (R12 as amended by R20) — decided by
   * `isClaimed`, the one definition of "claimed". Always false for a source
   * that has no claim concept.
   */
  claimed: boolean;
}

/** What an adapter collects: everything but the evaluated attention state. */
export interface CollectedItem {
  ref: ItemRef;
  id: string;
  title: string;
  repoOrContext: string;
  derived: DerivedReason[];
  fallbackSince: string;
  mode: SessionMode | null;
  stageStatus: string | null;
  running: boolean;
  claimed: boolean;
  links: ItemLinks;
}

/** One per ItemSource. Adding Jira/Slack = adding an adapter to the array. */
export interface SourceAdapter {
  readonly source: ItemSource;
  collect(): Promise<CollectedItem[]>;
  /** Recompute exactly one item, for a targeted refresh. `null` when it no longer exists. */
  collectOne(ref: ItemRef): Promise<CollectedItem | null>;
  /**
   * Phase 14 — `collectOne`, except a TERMINAL item still resolves. Attention
   * is about live work, so `collectOne` drops a finished session on purpose;
   * ADDRESSABILITY is a different question, and `GET /items/session/:id` must
   * answer it for any session the store knows. A source with no notion of
   * "terminal" simply omits this and gets `collectOne`.
   */
  collectAny?(ref: ItemRef): Promise<CollectedItem | null>;
  /**
   * Optional: the on-disk ISO mtime of one of this source's artifacts, or
   * null when this source has no such artifact (or cannot tell). Feeds
   * `artifact.changed`; a source with no artifacts simply omits it.
   */
  artifactMtime?(e: SessionWatchEvent): Promise<string | null>;
}

function emptyLinks(): ItemLinks {
  return {
    sessionId: null,
    worktreePath: null,
    prRepo: null,
    prNumber: null,
    prUrl: null,
    ticket: null,
    primaryArtifact: null,
  };
}

const AGENT_STATES = ['working', 'ready', 'needs-input', 'blocked'] as const;
type AgentState = (typeof AGENT_STATES)[number];

function isTerminal(session: Session): boolean {
  return TERMINAL_PHASES_BY_MODE[session.mode].has(session.stageStatus);
}

export interface SessionSourceAdapterDeps {
  store: SessionStore;
  fs: SessionFileSystem;
  sessionsDir: string;
  isRunning(id: string): boolean;
  /** The GLOBAL local-app status; attributed to its owner only (R22). */
  localStatus?: () => Promise<LocalAppStatus>;
  now?: () => Date;
}

export class SessionSourceAdapter implements SourceAdapter {
  readonly source: ItemSource = 'session';

  constructor(private readonly deps: SessionSourceAdapterDeps) {}

  async collect(): Promise<CollectedItem[]> {
    // SessionStore.list() skips a corrupt session rather than throwing, and
    // save() is tmp-then-rename, so this unlocked read can never see a torn
    // document (MG-A3: no session lock is taken anywhere in this module).
    const sessions = await this.deps.store.list();
    const status = await this.localAppStatus();
    const items: CollectedItem[] = [];
    for (const session of sessions) {
      if (isTerminal(session)) continue;
      items.push(await this.itemFor(session, status));
    }
    return items;
  }

  async collectOne(ref: ItemRef): Promise<CollectedItem | null> {
    return this.collectRef(ref, { includeTerminal: false });
  }

  /** Phase 14: the same read, minus the "live work only" filter. */
  async collectAny(ref: ItemRef): Promise<CollectedItem | null> {
    return this.collectRef(ref, { includeTerminal: true });
  }

  private async collectRef(ref: ItemRef, opts: { includeTerminal: boolean }): Promise<CollectedItem | null> {
    if (!ref.startsWith('session:')) return null;
    const id = ref.slice('session:'.length);
    if (id.length === 0) return null;
    let session: Session;
    try {
      session = await this.deps.store.load(id);
    } catch {
      return null; // unknown, invalid or corrupt: it has no attention state
    }
    if (!opts.includeTerminal && isTerminal(session)) return null;
    return this.itemFor(session, await this.localAppStatus());
  }

  private async localAppStatus(): Promise<LocalAppStatus | null> {
    if (!this.deps.localStatus) return null;
    return this.deps.localStatus();
  }

  private async itemFor(session: Session, status: LocalAppStatus | null): Promise<CollectedItem> {
    const agentState = await this.readAgentState(session.id);
    const derived = deriveSessionReasons({
      session,
      agentState,
      agentStateMtime: await this.agentStateMtime(session.id),
      running: this.deps.isRunning(session.id),
      // W8/R22: only the owner sees the app at all.
      localApp:
        status !== null && status.sessionId === session.id
          ? { state: status.state, reason: status.reason }
          : null,
    });
    const pr = session.pr;
    return {
      ref: sessionRef(session.id),
      id: session.id,
      title: pr?.title ?? session.lineage.ticket ?? session.id,
      repoOrContext: pr?.repo ?? repoSlugFromUrl(session.workspace.repoUrl),
      derived,
      fallbackSince: session.createdAt,
      mode: session.mode,
      stageStatus: session.stageStatus,
      running: this.deps.isRunning(session.id),
      // R20: a claim counts only while it is unexpired, and `isClaimed` is
      // the one place that decides that — never `humanTurn !== null` here.
      claimed: isClaimed(session, this.deps.now ? this.deps.now() : new Date()),
      links: {
        ...emptyLinks(),
        sessionId: session.id,
        worktreePath: session.workspace.worktreePath ?? null,
        prRepo: pr?.repo ?? null,
        prNumber: pr?.number ?? null,
        prUrl: pr?.url ?? null,
        ticket: session.lineage.ticket,
        primaryArtifact: await this.primaryArtifactFor(session),
      },
    };
  }

  /** The ISO mtime of one of this session's artifacts, when the port can tell. */
  async artifactMtime(e: SessionWatchEvent): Promise<string | null> {
    return this.mtimeOf(`${this.deps.sessionsDir}/${e.sessionId}/${e.name}`);
  }

  /** Trimmed; an unrecognized (or absent) value is no state, never a throw. */
  private async readAgentState(id: string): Promise<AgentState | null> {
    const path = `${this.deps.sessionsDir}/${id}/AGENT_STATE`;
    let raw: string;
    try {
      if (!(await this.deps.fs.exists(path))) return null;
      raw = await this.deps.fs.readFile(path);
    } catch {
      return null;
    }
    const value = raw.trim();
    return (AGENT_STATES as readonly string[]).includes(value) ? (value as AgentState) : null;
  }

  private async agentStateMtime(id: string): Promise<string | null> {
    return this.mtimeOf(`${this.deps.sessionsDir}/${id}/AGENT_STATE`);
  }

  private async mtimeOf(path: string): Promise<string | null> {
    try {
      const ms = await this.deps.fs.statMtimeMs(path);
      return ms === null ? null : new Date(ms).toISOString();
    } catch {
      return null; // attention is best-effort: an unreadable path has no mtime
    }
  }

  /**
   * R11: the core chooses the artifact a row opens. Deliberately a private
   * listing rather than a call into `handleArtifactList` — that one takes the
   * per-session lock and reads every file to report a size, and attention
   * must never lock a session (MG-A3). `parseArtifactName` stays the one
   * allow-list.
   */
  private async primaryArtifactFor(session: Session): Promise<string | null> {
    const sessionDir = `${this.deps.sessionsDir}/${session.id}`;
    let names: string[];
    try {
      names = await this.deps.fs.readdir(sessionDir);
    } catch {
      return null; // nothing has run yet: no artifacts, not an error
    }
    // Unsorted on purpose: `pickPrimaryArtifact` ranks by its own preference
    // order and by mtime, so readdir order cannot change the answer — and the
    // DoD pins this directory as sort-free.
    const listing: Array<{ name: string; mtime: string }> = [];
    for (const name of names) {
      try {
        parseArtifactName(name);
      } catch {
        continue;
      }
      const mtime = await this.mtimeOf(`${sessionDir}/${name}`);
      if (mtime === null) continue;
      listing.push({ name, mtime });
    }
    return pickPrimaryArtifact(session, listing);
  }
}

export interface PrSourceAdapterDeps {
  inventory: { load(): Promise<Inventory | null> };
}

export class PrSourceAdapter implements SourceAdapter {
  readonly source: ItemSource = 'pr';

  constructor(private readonly deps: PrSourceAdapterDeps) {}

  async collect(): Promise<CollectedItem[]> {
    const inventory = await this.deps.inventory.load();
    // No scan yet: contribute nothing rather than throwing.
    if (inventory === null) return [];
    return inventory.entries.map((entry) => ({
      ref: prRef(entry.repo, entry.number),
      id: `${entry.repo}#${entry.number}`,
      title: entry.title,
      repoOrContext: entry.repo,
      derived: derivePrReasons(entry),
      fallbackSince: entry.seenAt,
      mode: null,
      stageStatus: null,
      running: false,
      claimed: false,
      links: {
        ...emptyLinks(),
        sessionId: entry.ours.status === 'none' ? null : entry.ours.sessionId,
        prRepo: entry.repo,
        prNumber: entry.number,
        prUrl: entry.url,
      },
    }));
  }

  async collectOne(ref: ItemRef): Promise<CollectedItem | null> {
    const all = await this.collect();
    return all.find((item) => item.ref === ref) ?? null;
  }
}

/**
 * The one refresh scope shape. A scope names WHAT changed, not which adapter:
 * the service maps a scope to the adapters that can answer it.
 */
export type RefreshScope =
  | { kind: 'all' }
  | { kind: 'session'; id: string }
  | { kind: 'pr'; repo: string; number: number };

export interface AttentionServiceDeps {
  adapters: readonly SourceAdapter[];
  acks: AckStore;
  events: EngineEvents;
  /**
   * The session-directory watch (R7). The agent writes AGENT_STATE and its
   * artifacts directly, inside its turn, with no engine involvement — without
   * this an agent asking a question would be invisible until the turn exits.
   */
  watcher?: SessionWatcher;
  now?: () => Date;
}

/** What a delta is measured on: the state a client renders, links excluded. */
function deltaKeyOf(item: AttentionItem): string {
  return JSON.stringify([
    item.attention.signature,
    item.attention.needsAttention,
    item.attention.needsYou,
    item.attention.acked,
    item.mode,
    item.stageStatus,
    item.running,
    item.claimed,
    item.title,
  ]);
}

export class AttentionService {
  private readonly lastDelta = new Map<ItemRef, string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly trailing = new Set<string>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: AttentionServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Attention is a best-effort read over state other components own: one
   * broken source (or an unreadable ack file) must degrade to "that source
   * has nothing to say" rather than blank the whole panel or reject a
   * fire-and-forget refresh. There is no logger in these deps, so the failure
   * is swallowed deliberately — the next refresh retries from scratch.
   */
  private async loadAcks(): Promise<Record<ItemRef, { signature: string; ackedAt: string }>> {
    try {
      return await this.deps.acks.load();
    } catch {
      return {};
    }
  }

  private async collectFrom(adapter: SourceAdapter): Promise<CollectedItem[]> {
    try {
      return await adapter.collect();
    } catch {
      return [];
    }
  }

  private async collectOneFrom(adapter: SourceAdapter, ref: ItemRef): Promise<CollectedItem | null> {
    try {
      return await adapter.collectOne(ref);
    } catch {
      return null;
    }
  }

  /**
   * R27 — `dedupe` defaults to TRUE, so `/attention` and every existing
   * caller are unchanged byte-for-byte. `WorkItemService` passes
   * `dedupe: false` and gets the PRE-DEDUPE items: both the session item and
   * the `source: 'pr'` item for a PR under review. `dedupe()` drops the PR
   * item and keeps only three of its link fields, so a deduped list cannot
   * tell a work item whether the PR is a draft, who requested review, or
   * whether a human has reviewed it — and re-reading the inventory inside
   * `src/work/` would be a second copy of the attention rule, which R1
   * exists to forbid.
   */
  async list(opts: { all?: boolean; dedupe?: boolean } = {}): Promise<{ evaluatedAt: string; items: AttentionItem[] }> {
    const acks = await this.loadAcks();
    const collected: Array<{ source: ItemSource; item: CollectedItem }> = [];
    for (const adapter of this.deps.adapters) {
      for (const item of await this.collectFrom(adapter)) {
        collected.push({ source: adapter.source, item });
      }
    }
    const kept = opts.dedupe === false ? collected : dedupe(collected);
    const items = kept.map(({ source, item }) => this.evaluate(source, item, acks));
    return {
      evaluatedAt: this.now().toISOString(),
      items: opts.all ? items : items.filter((item) => item.attention.needsAttention),
    };
  }

  /**
   * Phase 14 — exactly one evaluated item for a ref, TERMINAL INCLUDED, and
   * `null` when no source knows it. This is what keeps `WorkItemService` the
   * only thing that never reads a session document (R1/R27): the work layer
   * asks attention for the session, it does not go and load one.
   */
  async itemFor(ref: ItemRef): Promise<AttentionItem | null> {
    const acks = await this.loadAcks();
    for (const adapter of this.deps.adapters) {
      let collected: CollectedItem | null = null;
      try {
        collected = adapter.collectAny ? await adapter.collectAny(ref) : await adapter.collectOne(ref);
      } catch {
        collected = null;
      }
      if (collected === null) continue;
      return this.evaluate(adapter.source, collected, acks);
    }
    return null;
  }

  /** The ONE ack path; 404 when the ref names nothing. */
  async ack(ref: ItemRef): Promise<AttentionItem> {
    for (const adapter of this.deps.adapters) {
      const collected = await this.collectOneFrom(adapter, ref);
      if (collected === null) continue;
      const unacked = this.evaluate(adapter.source, collected, {});
      await this.deps.acks.put(ref, {
        signature: unacked.attention.signature,
        ackedAt: this.now().toISOString(),
      });
      const acked = this.evaluate(adapter.source, collected, await this.loadAcks());
      // Remember what the ack made true, so the next refresh only reports a
      // real change rather than the ack itself.
      this.lastDelta.set(ref, deltaKeyOf(acked));
      return acked;
    }
    throw new ItemNotFoundError(ref);
  }

  /**
   * Recompute a scope and emit `attention.changed` on a real delta.
   *
   * Bursts are coalesced rather than timed: a refresh arriving while one for
   * the same scope is in flight joins it and schedules exactly one trailing
   * recompute, so a write that landed after the in-flight read started is
   * never lost and five refreshes in a burst still emit at most once.
   */
  async refresh(scope: RefreshScope): Promise<void> {
    const key = JSON.stringify(scope);
    const running = this.inflight.get(key);
    if (running) {
      this.trailing.add(key);
      return running;
    }
    const run = (async () => {
      try {
        await this.recompute(scope);
        while (this.trailing.delete(key)) {
          await this.recompute(scope);
        }
      } catch {
        // Every caller is fire-and-forget (`void this.refresh(...)` from an
        // engine event or the watch), so a rejection here would surface as an
        // unhandled rejection and nothing would be better off. A recompute
        // that failed simply leaves the last known state in place.
      } finally {
        this.trailing.delete(key);
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  /** Subscribes to the engine events, and to the session watch, that can change an item's attention. */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    const events = this.deps.events;
    const bySession = (id: string): void => {
      void this.refresh({ kind: 'session', id });
    };
    this.unsubscribers = [
      events.on('session.created', (e) => bySession(e.session.id)),
      events.on('session.transitioned', (e) => bySession(e.session.id)),
      events.on('run.started', (e) => bySession(e.session.id)),
      events.on('run.finished', (e) => bySession(e.session.id)),
      // The only scope that recomputes every source.
      events.on('inventory.updated', () => {
        void this.refresh({ kind: 'all' });
      }),
    ];
    this.deps.watcher?.start((e) => {
      void this.onWatchEvent(e);
    });
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.deps.watcher?.stop();
  }

  /**
   * An AGENT_STATE write is an attention change and nothing else; any other
   * artifact is an `artifact.changed` plus a refresh, since a PLAN.md write
   * may well change nothing attention-wise and the no-delta check makes that
   * free.
   */
  private async onWatchEvent(e: SessionWatchEvent): Promise<void> {
    if (e.name === 'AGENT_STATE') {
      await this.refresh({ kind: 'session', id: e.sessionId });
      return;
    }
    this.deps.events.emit('artifact.changed', {
      sessionId: e.sessionId,
      name: e.name,
      mtime: await this.artifactMtime(e),
    });
    await this.refresh({ kind: 'session', id: e.sessionId });
  }

  /**
   * The file's own mtime once `statMtimeMs` exists on the port (A2); until
   * then the observation time, which is the best available answer and keeps
   * this task independent of that one.
   */
  private async artifactMtime(e: SessionWatchEvent): Promise<string> {
    for (const adapter of this.deps.adapters) {
      try {
        const mtime = await adapter.artifactMtime?.(e);
        if (mtime !== null && mtime !== undefined) return mtime;
      } catch {
        // Ask the next source; the observation time is the fallback.
      }
    }
    return this.now().toISOString();
  }

  private async recompute(scope: RefreshScope): Promise<void> {
    const acks = await this.loadAcks();
    if (scope.kind === 'all') {
      const collected: Array<{ source: ItemSource; item: CollectedItem }> = [];
      for (const adapter of this.deps.adapters) {
        for (const item of await this.collectFrom(adapter)) {
          collected.push({ source: adapter.source, item });
        }
      }
      for (const { source, item } of dedupe(collected)) {
        this.emitOnDelta(this.evaluate(source, item, acks));
      }
      return;
    }
    const ref = scope.kind === 'session' ? sessionRef(scope.id) : prRef(scope.repo, scope.number);
    for (const adapter of this.deps.adapters) {
      const collected = await this.collectOneFrom(adapter, ref);
      if (collected === null) continue;
      this.emitOnDelta(this.evaluate(adapter.source, collected, acks));
      return;
    }
    // The item is gone: forget it, so a later re-appearance is a delta again.
    this.lastDelta.delete(ref);
  }

  private emitOnDelta(item: AttentionItem): void {
    const key = deltaKeyOf(item);
    if (this.lastDelta.get(item.ref) === key) return;
    this.lastDelta.set(item.ref, key);
    this.deps.events.emit('attention.changed', { item });
  }

  private evaluate(
    source: ItemSource,
    collected: CollectedItem,
    acks: Record<ItemRef, { signature: string; ackedAt: string }>,
  ): AttentionItem {
    return {
      source,
      ref: collected.ref,
      id: collected.id,
      title: collected.title,
      repoOrContext: collected.repoOrContext,
      attention: evaluateAttention({
        derived: collected.derived,
        fallbackSince: collected.fallbackSince,
        ack: acks[collected.ref] ?? null,
      }),
      links: collected.links,
      mode: collected.mode,
      stageStatus: collected.stageStatus,
      running: collected.running,
      claimed: collected.claimed,
    };
  }
}

/**
 * An item present in both sources (a review session whose PR is also an
 * inventory row) is emitted once, as the non-PR source, with the PR's link
 * fields merged in — matched either by the session's own PR or by the
 * inventory row naming that session. Deduped here rather than inside an
 * adapter, so no adapter needs to know another exists.
 */
function dedupe(
  collected: ReadonlyArray<{ source: ItemSource; item: CollectedItem }>,
): Array<{ source: ItemSource; item: CollectedItem }> {
  const kept: Array<{ source: ItemSource; item: CollectedItem }> = [];
  const others = collected.filter((c) => c.source !== 'pr');
  for (const candidate of collected) {
    if (candidate.source === 'pr') {
      const host = others.find(
        (c) =>
          (c.item.links.prRepo === candidate.item.links.prRepo &&
            c.item.links.prNumber === candidate.item.links.prNumber) ||
          (candidate.item.links.sessionId !== null &&
            c.item.links.sessionId === candidate.item.links.sessionId),
      );
      if (host) {
        host.item.links.prRepo ??= candidate.item.links.prRepo;
        host.item.links.prNumber ??= candidate.item.links.prNumber;
        host.item.links.prUrl ??= candidate.item.links.prUrl;
        continue;
      }
    }
    kept.push(candidate);
  }
  return kept;
}
