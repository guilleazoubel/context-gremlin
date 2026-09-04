import type { Session } from '../schema/session';
import type { StageName, RunOutcome } from '../schema/stage';
import type { AgentOutput } from '../agent/agent-runner';

export interface EngineEventMap {
  'session.created': { session: Session };
  'session.transitioned': { session: Session; from: string; to: string };
  'run.started': { session: Session; stage: StageName };
  'run.output': { sessionId: string; stage: StageName; chunk: AgentOutput };
  'run.finished': { session: Session; stage: StageName; outcome: RunOutcome };
}

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
