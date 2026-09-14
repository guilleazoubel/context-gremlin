/**
 * The stop the engine is allowed to REFUSE.
 *
 * A signal is not a request: whoever sends a SIGTERM wins, whatever they are and however old
 * they are. That asymmetry is the whole bug — a window still running a pre-ordering extension
 * build restarted the engine on any build mismatch, the newer window restarted it back, and
 * nothing in between could say no. `POST /shutdown` makes stopping a question the engine answers:
 * the requester must prove its bundle is strictly NEWER than the engine's, or a person must be
 * the one asking. Everything else is refused, and the engine keeps serving.
 *
 * The ordering is deliberately the same rule the extension's own `classify()` applies to decide
 * whether it may replace an engine, so the two sides can never reach opposite conclusions about
 * the same pair of builds: a side with no build time at all orders as older than one that has it.
 */
import { z } from 'zod';
import { ValidationError } from './validation';

/** Why the stop is being asked for. `'user'` is a person, and a person is never refused. */
export type ShutdownReason = 'restart' | 'stop' | 'user';

export interface ShutdownRequest {
  /** When the requester's bundle was built (ISO), or `null` for one that was never bundled. */
  requesterBuildTime: string | null;
  /** Which bundle is asking — logged, never decisive: a content address cannot order two builds. */
  requesterBuildId: string;
  reason: ShutdownReason;
}

export type ShutdownDecision =
  | { accepted: true }
  | { accepted: false; reason: string; engineBuildTime: string | null };

/** The one sentence a refusal ever gives, so the extension can show it verbatim. */
export const ENGINE_IS_NEWER = 'engine is newer than the requester';

const ShutdownRequestSchema = z.object({
  requesterBuildTime: z.string().min(1).nullable(),
  requesterBuildId: z.string().min(1),
  reason: z.enum(['restart', 'stop', 'user']),
});

export function parseShutdownRequest(body: unknown): ShutdownRequest {
  const result = ShutdownRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid shutdown request: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Pure, and the only place the order is decided. ISO-8601 timestamps compare correctly as
 * strings, which is what the extension's `classify()` already relies on.
 */
export function decideShutdown(
  request: ShutdownRequest,
  engineBuildTime: string | null,
): ShutdownDecision {
  if (request.reason === 'user') return { accepted: true };
  const theirs = request.requesterBuildTime;
  const requesterIsNewer = theirs !== null && (engineBuildTime === null || theirs > engineBuildTime);
  if (requesterIsNewer) return { accepted: true };
  return { accepted: false, reason: ENGINE_IS_NEWER, engineBuildTime };
}

export interface ShutdownInstall {
  /** The engine's own graceful `close()` — the SAME one the SIGTERM handler calls. */
  close: () => Promise<void>;
  /** One structured line per decision, in the engine log's own shape. */
  log: (type: string, payload: Record<string, unknown>) => void;
}

/**
 * Built by `buildEngine` (which knows the engine's build time) and installed by `serve()` (which
 * owns `close()` and the log). Until it is installed the engine has nothing to shut down with,
 * and the route 404s rather than accepting a stop it cannot perform.
 */
export class ShutdownController {
  private wired: ShutdownInstall | null = null;
  private performed = false;

  constructor(private readonly engineBuildTime: string | null) {}

  install(wired: ShutdownInstall): void {
    this.wired = wired;
  }

  get installed(): boolean {
    return this.wired !== null;
  }

  /** Decides, and logs exactly one line saying who asked and what was decided. */
  decide(request: ShutdownRequest): ShutdownDecision {
    const decision = decideShutdown(request, this.engineBuildTime);
    this.wired?.log(decision.accepted ? 'shutdown.accepted' : 'shutdown.refused', {
      reason: request.reason,
      requesterBuildId: request.requesterBuildId,
      requesterBuildTime: request.requesterBuildTime,
      engineBuildTime: this.engineBuildTime,
    });
    return decision;
  }

  /**
   * Runs the graceful close, once. Called AFTER the 202 has been flushed — `close()` drops every
   * open connection, so performing it inline would cut the answer off mid-flight.
   */
  perform(): void {
    if (this.performed || this.wired === null) return;
    this.performed = true;
    const { close, log } = this.wired;
    close().catch((err) => {
      log('shutdown.error', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}
