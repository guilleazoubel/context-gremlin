import { z } from 'zod';

export const SessionModeSchema = z.enum(['review', 'investigation', 'development']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  mode: SessionModeSchema,
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
  stageStatus: z.string().min(1),
});

export type Session = z.infer<typeof SessionSchema>;

export function parseSession(data: unknown): Session {
  return SessionSchema.parse(data);
}
