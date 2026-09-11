import { z } from 'zod';

/**
 * R56 — THREE contracts in one array: `StageNameSchema` validates
 * `POST /sessions/:id/run`, it is the persisted `LastRunSchema.stage` type,
 * and it is the payload type of `run.started`/`run.finished`. A session
 * whose stage is not named here cannot be started, cannot record its run and
 * cannot emit an event. The fourth mode's stage is APPENDED, so no existing
 * persisted `lastRun.stage` value shifts meaning.
 */
export const STAGE_NAMES = ['findings', 'plan', 'develop', 'review', 'rereview', 'respond'] as const;
export const StageNameSchema = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageNameSchema>;

export const RUN_OUTCOMES = ['running', 'succeeded', 'failed', 'stopped'] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const LastRunSchema = z.object({
  stage: StageNameSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outcome: RunOutcomeSchema,
  error: z.string().nullable(),
});
export type LastRun = z.infer<typeof LastRunSchema>;

/**
 * A human's claim on the session's agent conversation (R20) — a TTL'd record,
 * never a boolean: an extension that crashes (or a machine that reboots) must
 * not wedge the session's pipeline forever. `expiresAt` is
 * `claimedAt + CoreConfig.humanTurnTtlMs`; whether a claim is LIVE is decided
 * in exactly one place, `isClaimed` (src/pipeline/pipeline-service.ts).
 */
export const HumanTurnSchema = z.object({
  claimedAt: z.string().min(1), // ISO
  expiresAt: z.string().min(1), // ISO
});
export type HumanTurn = z.infer<typeof HumanTurnSchema>;

export const AgentSchema = z.object({
  runner: z.enum(['claude-code', 'codex']),
  resumeId: z.string().min(1).nullable(),
  // Additive AND defaulted: every session.json already on disk (whose agent
  // record predates the claim) must keep loading, as `humanTurn: null`.
  humanTurn: HumanTurnSchema.nullable().default(null),
});
export type AgentInfo = z.infer<typeof AgentSchema>;

export const PrSchema = z.object({
  repo: z.string().min(1), // "owner/name"
  number: z.number().int().positive(),
  url: z.string().min(1),
  headSha: z.string().min(1).nullable(),
  reviewedSha: z.string().min(1).nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
});
export type PrInfo = z.infer<typeof PrSchema>;
