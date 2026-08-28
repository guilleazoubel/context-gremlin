import { z } from 'zod';
import { SessionModeSchema, type SessionMode } from './session-mode';
import { INVESTIGATION_PHASES, DEVELOPMENT_PHASES, REVIEW_PHASES } from './pipeline';

export { SessionModeSchema };
export type { SessionMode };

const SessionBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: z.object({
    repoUrl: z.string().min(1),
    worktreePath: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  lineage: z.object({
    pipelineId: z.string().min(1),
    parentSessionId: z.string().min(1).nullable(),
    ticket: z.string().min(1).nullable(),
  }),
});

export const SessionSchema = z.discriminatedUnion('mode', [
  SessionBaseSchema.extend({
    mode: z.literal('investigation'),
    stageStatus: z.enum(INVESTIGATION_PHASES),
  }),
  SessionBaseSchema.extend({
    mode: z.literal('development'),
    stageStatus: z.enum(DEVELOPMENT_PHASES),
  }),
  SessionBaseSchema.extend({
    mode: z.literal('review'),
    stageStatus: z.enum(REVIEW_PHASES),
  }),
]);

export type Session = z.infer<typeof SessionSchema>;

export function parseSession(data: unknown): Session {
  return SessionSchema.parse(data);
}
