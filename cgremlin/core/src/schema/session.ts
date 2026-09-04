import { z } from 'zod';
import { SessionModeSchema, type SessionMode } from './session-mode';
import { INVESTIGATION_PHASES, DEVELOPMENT_PHASES, REVIEW_PHASES } from './pipeline';
import { AgentSchema, LastRunSchema, PrSchema } from './stage';

export { SessionModeSchema };
export type { SessionMode };

const WorkspaceSchema = z.object({
  repoUrl: z.string().min(1),
  worktreePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

const LineageSchema = z.object({
  pipelineId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable(),
  ticket: z.string().min(1).nullable(),
});

// ---- v1 (Phase 0) — kept so old documents on disk still parse ----
const V1Base = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: WorkspaceSchema,
  lineage: LineageSchema,
});
export const SessionV1Schema = z.discriminatedUnion('mode', [
  V1Base.extend({ mode: z.literal('investigation'), stageStatus: z.enum(INVESTIGATION_PHASES) }),
  V1Base.extend({ mode: z.literal('development'), stageStatus: z.enum(DEVELOPMENT_PHASES) }),
  V1Base.extend({ mode: z.literal('review'), stageStatus: z.enum(REVIEW_PHASES) }),
]);
export type SessionV1 = z.infer<typeof SessionV1Schema>;

// ---- v2 (Phase 3a) ----
const V2Base = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: WorkspaceSchema,
  lineage: LineageSchema,
  agent: AgentSchema.nullable(),
  lastRun: LastRunSchema.nullable(),
  pr: PrSchema.nullable(),
});

export const IntentSchema = z.enum(['investigate_only', 'development']);
export type Intent = z.infer<typeof IntentSchema>;

const RereviewSummarySchema = z.object({
  resolved: z.number().int(),
  total: z.number().int(),
  newFindings: z.number().int(),
});

export const SessionSchema = z.discriminatedUnion('mode', [
  V2Base.extend({
    mode: z.literal('investigation'),
    stageStatus: z.enum(INVESTIGATION_PHASES),
    intent: IntentSchema,
    driveToCompletion: z.boolean(),
  }),
  V2Base.extend({
    mode: z.literal('development'),
    stageStatus: z.enum(DEVELOPMENT_PHASES),
  }),
  V2Base.extend({
    mode: z.literal('review'),
    stageStatus: z.enum(REVIEW_PHASES),
    reviewVersion: z.number().int().nonnegative(),
    lastRereviewSummary: RereviewSummarySchema.nullable(),
  }),
]);
export type Session = z.infer<typeof SessionSchema>;
export type InvestigationSession = Extract<Session, { mode: 'investigation' }>;
export type DevelopmentSession = Extract<Session, { mode: 'development' }>;
export type ReviewSession = Extract<Session, { mode: 'review' }>;

export function migrateV1ToV2(v1: SessionV1): Session {
  const base = {
    ...v1,
    schemaVersion: 2 as const,
    agent: null,
    lastRun: null,
    pr: null,
  };
  switch (v1.mode) {
    case 'investigation':
      return SessionSchema.parse({ ...base, intent: 'investigate_only', driveToCompletion: false });
    case 'development':
      return SessionSchema.parse(base);
    case 'review':
      return SessionSchema.parse({ ...base, reviewVersion: 0, lastRereviewSummary: null });
  }
}

export function parseSession(data: unknown): Session {
  const version =
    data && typeof data === 'object' ? (data as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === 1) {
    return migrateV1ToV2(SessionV1Schema.parse(data));
  }
  return SessionSchema.parse(data);
}
