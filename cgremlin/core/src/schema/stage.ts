import { z } from 'zod';

export const STAGE_NAMES = ['findings', 'plan', 'develop', 'review', 'rereview'] as const;
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

export const AgentSchema = z.object({
  runner: z.enum(['claude-code', 'codex']),
  resumeId: z.string().min(1).nullable(),
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
