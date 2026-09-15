import { z } from 'zod';
import { SessionModeSchema, type SessionMode } from './session-mode';
import {
  INVESTIGATION_PHASES,
  DEVELOPMENT_PHASES,
  REVIEW_PHASES,
  RESPOND_PHASES,
  QA_PHASES,
} from './pipeline';
import { AgentSchema, LastRunSchema, PrSchema } from './stage';

export { SessionModeSchema };
export type { SessionMode };

const WorkspaceSchema = z.object({
  repoUrl: z.string().min(1),
  worktreePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

// V1 predates the self-review concept entirely, so its lineage keeps the
// original shape — a separate schema (rather than reusing LineageSchema)
// keeps `selfReview` out of `SessionV1`'s TS type so every v1 fixture across
// the codebase (there is no self-review pre-Phase-10) does not need to name
// a field it never had.
const V1LineageSchema = z.object({
  pipelineId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable(),
  ticket: z.string().min(1).nullable(),
});

const LineageSchema = V1LineageSchema.extend({
  // Phase 10: additive, defaulted (R45-style) — every session.json already on
  // disk predates this flag and loads as `selfReview: false`. Marks a review
  // session deliberately created on the author's own PR (bypassing OwnPrError
  // via the `selfReview` request flag), so attention/inventory can tell a
  // self-review apart from a review of a teammate's PR.
  selfReview: z.boolean().optional().default(false),
});

// ---- v1 (Phase 0) — kept so old documents on disk still parse ----
const V1Base = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: WorkspaceSchema,
  lineage: V1LineageSchema,
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

export const QA_VERDICTS = ['ready', 'not_ready', 'blocked'] as const;
export const QaVerdictSchema = z.enum(QA_VERDICTS);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

const QaStateSchema = z.object({
  /** The merge commit this session's verdict was reached against. */
  verifiedSha: z.string().min(1).nullable().default(null),
  verdict: QaVerdictSchema.nullable().default(null),
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
    lastRereviewSummary: RereviewSummarySchema.nullable().default(null),
  }),
  // R51 — the fourth variant. Additive: the union is discriminated on
  // `mode`, so every document already on disk keeps matching its own branch
  // (MG-13). The v1 union above is deliberately NOT extended.
  V2Base.extend({
    mode: z.literal('respond'),
    stageStatus: z.enum(RESPOND_PHASES),
  }),
  // R68 — the fifth variant. Additive AND defaulted for the same reason the
  // fourth was: the union is discriminated on `mode`, so every document
  // already on disk keeps matching its own branch (MG-18), and a `qa`
  // document written before the field existed cannot exist either — the
  // default is there so a hand-written or partially-patched document loads.
  V2Base.extend({
    mode: z.literal('qa'),
    stageStatus: z.enum(QA_PHASES),
    qa: QaStateSchema.default({ verifiedSha: null, verdict: null }),
  }),
]);
export type Session = z.infer<typeof SessionSchema>;
export type InvestigationSession = Extract<Session, { mode: 'investigation' }>;
export type DevelopmentSession = Extract<Session, { mode: 'development' }>;
export type ReviewSession = Extract<Session, { mode: 'review' }>;
export type RespondSession = Extract<Session, { mode: 'respond' }>;
export type QaSession = Extract<Session, { mode: 'qa' }>;

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
