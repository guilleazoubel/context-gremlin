import type { Session } from '../schema/session';
import type { StageName, RunOutcome } from '../schema/stage';
import type { AgentOutput } from '../agent/agent-runner';
import type { Inventory } from '../inventory/inventory';
import type { AttentionItem } from '../attention/attention-service';

export interface EngineEventMap {
  'session.created': { session: Session };
  'session.transitioned': { session: Session; from: string; to: string };
  'run.started': { session: Session; stage: StageName };
  'run.output': { sessionId: string; stage: StageName; chunk: AgentOutput };
  'run.finished': { session: Session; stage: StageName; outcome: RunOutcome };
  'inventory.updated': { inventory: Inventory };
  /**
   * Emitted by AttentionService when a recompute produces a state a client
   * has not seen yet. In-process only, like every other engine event.
   */
  'attention.changed': { item: AttentionItem };
  /**
   * R16/R41 — one work item's state moved. Registered HERE and in
   * ENGINE_EVENT_TYPES below; an event added to only the first is silently
   * never carried by `/events`. The payload is MINIMAL on purpose: the
   * event ring buffers 256 frames, and 256 whole `WorkItem`s would be
   * resident memory paid for frames nobody reads. It is a HINT — the client
   * refetches `GET /items` (or `GET /items/<path>` for an open tab) and
   * renders from that, so two engines' answers can never disagree.
   * `changedFields` is advisory: nothing may branch on its ABSENCE into a
   * different correctness path.
   */
  'item.changed': { id: string; kind: string; changedFields?: string[] };
  /**
   * A session artifact changed on disk, reported by the SessionWatcher — the
   * agent writes its artifacts directly, inside its turn, with no engine
   * involvement (R7), so the watch is the only thing that can see it.
   */
  'artifact.changed': { sessionId: string; name: string; mtime: string };
}

/**
 * Every EngineEventMap key, exactly once — what the event ring subscribes to
 * at engine build time. A new event must be added here too, or `/events`
 * silently never carries it.
 */
export const ENGINE_EVENT_TYPES = [
  'session.created',
  'session.transitioned',
  'run.started',
  'run.output',
  'run.finished',
  'inventory.updated',
  'attention.changed',
  'artifact.changed',
  'item.changed',
] as const satisfies readonly (keyof EngineEventMap)[];

type Listener<K extends keyof EngineEventMap> = (payload: EngineEventMap[K]) => void;

export class EngineEvents {
  private readonly listeners = new Map<keyof EngineEventMap, Set<Listener<never>>>();

  on<K extends keyof EngineEventMap>(type: K, cb: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener<never>>();
    set.add(cb as Listener<never>);
    this.listeners.set(type, set);
    return () => { set.delete(cb as Listener<never>); };
  }

  emit<K extends keyof EngineEventMap>(type: K, payload: EngineEventMap[K]): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      try {
        (cb as Listener<K>)(payload);
      } catch {
        // A misbehaving subscriber must not break the engine or its other subscribers.
      }
    }
  }
}
