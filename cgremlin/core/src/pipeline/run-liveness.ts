import type { LastRun } from '../schema/stage';

/**
 * THE ONE sentence a crashed run records. The engine died (or the agent did)
 * with the run still in flight, so nothing ever wrote an end — this is what
 * the reconciliation puts in its place.
 */
export const CRASHED_RUN_ERROR = 'the engine stopped while this run was in flight';

/**
 * - `live`    — the StageRunner is holding a run for this session RIGHT NOW.
 * - `crashed` — the session file still says `running` and the runner is not
 *               holding it: the process died mid-run. NEVER live.
 * - `idle`    — nothing in flight and nothing to heal.
 */
export type RunLiveness = 'live' | 'crashed' | 'idle';

/**
 * THE ONE predicate every layer asks — the attention model (R22's
 * `run_failed`) and every write path that refuses "a run is already in
 * progress". They used to open-code the same membership test seven times and
 * could therefore disagree; the live wedge was exactly that disagreement.
 *
 * `active` MUST come from `StageRunner.activeSessionIds()` — the only thing
 * that knows what is actually running. A persisted `lastRun.outcome` is
 * evidence of a run that STARTED, never of one still going.
 */
export function runLiveness(lastRun: LastRun | null, active: boolean): RunLiveness {
  if (active) return 'live';
  return lastRun !== null && lastRun.outcome === 'running' ? 'crashed' : 'idle';
}

/** `runLiveness(...) === 'live'` — the question every refusal asks. */
export function isRunLive(lastRun: LastRun | null, active: boolean): boolean {
  return runLiveness(lastRun, active) === 'live';
}

/** `runLiveness(...) === 'crashed'` — the contradiction the heal fixes. */
export function isCrashedRun(lastRun: LastRun | null, active: boolean): boolean {
  return runLiveness(lastRun, active) === 'crashed';
}
