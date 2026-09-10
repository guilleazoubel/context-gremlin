import { z } from 'zod';
import { SessionModeSchema } from '../schema/session-mode';
import type { CreateWorkspaceParams } from '../workspace/workspace-manager';
import type { CreateDevelopmentInput, CreateInvestigationInput } from '../pipeline/pipeline-service';
import { StageNameSchema, type StageName } from '../schema/stage';

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

const RemoveWorkspaceRequestSchema = z.object({
  repoUrl: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
});

export interface RemoveWorkspaceParams {
  repoUrl: string;
  worktreePath: string;
  branchName: string;
}

export function parseRemoveWorkspaceRequest(body: unknown): RemoveWorkspaceParams {
  const result = RemoveWorkspaceRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid workspace removal request: ${result.error.message}`);
  }
  return result.data;
}

const CreateInvestigationRequestSchema = z.object({
  repoUrl: z.string().min(1),
  // Feeds directly into the derived session id (and worktree path), so it
  // must be safe as a single path-segment component: no '/', no '..', etc.
  ticket: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).nullable(),
  intent: z.enum(['investigate_only', 'development']),
  driveToCompletion: z.boolean(),
  baseRef: z.string().min(1).optional(),
});

export function parseCreateInvestigationRequest(body: unknown): CreateInvestigationInput {
  const result = CreateInvestigationRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid investigation creation request: ${result.error.message}`);
  }
  return result.data;
}

const CreateDevelopmentRequestSchema = z.object({
  repoUrl: z.string().min(1),
  // The SAME ticket rule as the investigation request above, so the two
  // creation paths can never disagree about what a safe ticket is.
  ticket: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/).nullable(),
  baseRef: z.string().min(1).optional(),
});

export function parseCreateDevelopmentRequest(body: unknown): CreateDevelopmentInput {
  const result = CreateDevelopmentRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid development creation request: ${result.error.message}`);
  }
  return result.data;
}

const RunStageRequestSchema = z.object({
  stage: StageNameSchema,
});

export function parseRunStageRequest(body: unknown): { stage: StageName } {
  const result = RunStageRequestSchema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(`Invalid run-stage request: ${result.error.message}`);
  }
  return result.data;
}

// Every readable artifact name, pinned exactly: fixed-name .md files, the
// versioned review archive, the two AGENT_* status files, and the two
// single-line marker files. Anything else — including path-traversal
// attempts — is rejected; this is the only thing standing between the
// artifact-read route and the filesystem.
const ARTIFACT_NAME_PATTERN =
  /^(?:FINDINGS|PLAN|DEVELOPMENT|REVIEW|RE-REVIEW|BRIEF|REVIEW-v\d+)\.md$|^AGENT_(?:NOTE|STATE)$|^rereview_summary$|^PR_URL$/;

export function parseArtifactName(name: string): string {
  if (!ARTIFACT_NAME_PATTERN.test(name)) {
    throw new ValidationError(`Invalid artifact name: '${name}'`);
  }
  return name;
}
