import { z } from 'zod';
import { parseSession, Session, SessionMode, SessionModeSchema } from '../schema/session';

const LegacySessionSchema = z.object({
  id: z.string().min(1),
  mode: SessionModeSchema,
  project: z.string().min(1),
  created: z.string().min(1),
  stage_status: z.string().min(1).optional(),
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
  }
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

  const candidate = {
    schemaVersion: 1 as const,
    id: legacy.id,
    mode: legacy.mode,
    createdAt: createdAtDate.toISOString(),
    workspace: {
      repoUrl: legacy.project,
    },
    lineage: {
      pipelineId: legacy.lineage?.pipeline_id ?? legacy.id,
      parentSessionId: legacy.lineage?.parent_session_id ?? null,
      ticket: legacy.lineage?.ticket ?? null,
    },
    stageStatus: legacy.stage_status ?? defaultStageStatus(legacy.mode),
  };

  return parseSession(candidate);
}
