import { z } from 'zod';
import { SessionModeSchema } from '../schema/session-mode';
import type { CreateWorkspaceParams } from '../workspace/workspace-manager';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const CreateWorkspaceRequestSchema = z.object({
  repoUrl: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  baseRef: z.string().min(1),
  mode: SessionModeSchema,
});

export function parseCreateWorkspaceRequest(body: unknown): CreateWorkspaceParams {
  const result = CreateWorkspaceRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid workspace creation request: ${result.error.message}`);
  }
  return result.data;
}
