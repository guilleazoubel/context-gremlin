import { z } from 'zod';
import { parseSession, Session, SessionMode, SessionModeSchema } from '../schema/session';

const LegacySessionSchema = z.object({
  id: z.string().min(1),
  mode: SessionModeSchema,
  project: z.string().min(1),
  created: z.string().min(1),
  stage_status: z.string().min(1).optional(),
  intent: z.enum(['investigate_only', 'development']).optional(),
  plan_review: z
    .object({ drive_to_completion: z.union([z.boolean(), z.string()]).optional() })
    .optional(),
  pr: z
    .object({
      number: z.union([z.number(), z.string()]),
      url: z.string().min(1),
      repo: z.string().min(1).optional(),
    })
    .optional(),
  reviewed_sha: z.string().min(1).optional(),
  lineage: z
    .object({
      pipeline_id: z.string().min(1).optional(),
      parent_session_id: z.string().min(1).nullable().optional(),
      ticket: z.string().min(1).nullable().optional(),
    })
    .optional(),
});

export class LegacySessionMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacySessionMigrationError';
  }
}

function defaultStageStatus(mode: SessionMode): string {
  switch (mode) {
    case 'review':
      return 'queued';
    case 'development':
      return 'active';
    case 'investigation':
      return 'findings';
    // A legacy session can never be `respond` or `qa` (the modes did not
    // exist), but the switch is exhaustive over SessionMode, so it needs the
    // arms.
    case 'respond':
      return 'triaging';
    case 'qa':
      return 'queued';
  }
}

function repoSlugFromUrl(url: string): string {
  // git@github.com:owner/name.git | https://github.com/owner/name(.git)
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : url;
}

export function migrateLegacySession(raw: unknown): Session {
  const parsedLegacy = LegacySessionSchema.safeParse(raw);
  if (!parsedLegacy.success) {
    throw new LegacySessionMigrationError(
      `Legacy session.json failed validation: ${parsedLegacy.error.message}`,
    );
  }
  const legacy = parsedLegacy.data;

  const createdAtDate = new Date(legacy.created);
  if (Number.isNaN(createdAtDate.getTime())) {
    throw new LegacySessionMigrationError(
      `Legacy session.json has an invalid 'created' timestamp: ${legacy.created}`,
    );
  }

  const drive = legacy.plan_review?.drive_to_completion;
  const driveToCompletion = drive === true || drive === 'true';
  const pr = legacy.pr
    ? {
        repo: legacy.pr.repo ?? repoSlugFromUrl(legacy.project),
        number: Number(legacy.pr.number),
        url: legacy.pr.url,
        headSha: null,
        reviewedSha: legacy.reviewed_sha ?? null,
        title: null,
        author: null,
      }
    : null;

  const base = {
    schemaVersion: 2 as const,
    id: legacy.id,
    mode: legacy.mode,
    createdAt: createdAtDate.toISOString(),
    workspace: { repoUrl: legacy.project },
    lineage: {
      pipelineId: legacy.lineage?.pipeline_id ?? legacy.id,
      parentSessionId: legacy.lineage?.parent_session_id ?? null,
      ticket: legacy.lineage?.ticket ?? null,
    },
    stageStatus: legacy.stage_status ?? defaultStageStatus(legacy.mode),
    agent: null,
    lastRun: null,
    pr,
  };
  const candidate =
    legacy.mode === 'investigation'
      ? { ...base, intent: legacy.intent ?? 'investigate_only', driveToCompletion }
      : legacy.mode === 'review'
        ? { ...base, reviewVersion: 0, lastRereviewSummary: null }
        : base;
  return parseSession(candidate);
}
