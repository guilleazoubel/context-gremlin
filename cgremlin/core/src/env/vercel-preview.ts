import { z } from 'zod';

export interface VercelPreviewProject {
  name: string;
  projectId: string;
  rootDirectory: string | null;
  inspectorUrl: string;
  previewUrl: string | null;
  nextCommitStatus: string;
}

const VercelPreviewProjectSchema = z
  .object({
    name: z.string(),
    projectId: z.string(),
    rootDirectory: z.string().nullable(),
    inspectorUrl: z.string(),
    previewUrl: z.string().nullable(),
    nextCommitStatus: z.string(),
  })
  .passthrough();

export const VercelCommentPayloadSchema = z.object({
  isMonorepo: z.boolean(),
  type: z.string(),
  projects: z.array(VercelPreviewProjectSchema),
});

const MARKER_PATTERN = /^\[vc\]: #[^:]+:(\S+)/m;

function decodeOne(body: string): VercelPreviewProject[] | null {
  const match = body.match(MARKER_PATTERN);
  if (!match) return null;
  const raw = match[1];
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  let json: string;
  try {
    json = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = VercelCommentPayloadSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data.projects;
}

export function parseVercelPreviewComment(bodies: readonly string[]): VercelPreviewProject[] {
  for (const body of bodies) {
    const decoded = decodeOne(body);
    if (decoded !== null) return decoded;
  }
  return [];
}

export function pickPreviewProject(
  projects: readonly VercelPreviewProject[],
  name: string,
): VercelPreviewProject | null {
  return projects.find((p) => p.name === name) ?? null;
}

export function previewUrlWithBypass(host: string, secret: string): string {
  return `https://${host}/?x-vercel-protection-bypass=${encodeURIComponent(secret)}&x-vercel-set-bypass-cookie=true`;
}
