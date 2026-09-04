import { z } from 'zod';
import type { PrInfo } from '../schema/stage';

export const PR_LIST_FIELDS =
  'number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt';
export const PR_VIEW_FIELDS =
  'number,title,author,headRefName,headRefOid,baseRefName,url,state,isDraft,reviewDecision,mergedAt,closedAt,latestReviews,statusCheckRollup';

export const ReviewDecisionSchema = z.enum(['', 'REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED']);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const PrListItemSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  author: z.object({
    login: z.string(),
    is_bot: z.boolean().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  }),
  isDraft: z.boolean(),
  reviewDecision: ReviewDecisionSchema,
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  headRefName: z.string(),
  baseRefName: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type PrListItem = z.infer<typeof PrListItemSchema>;

export const PrListSchema = z.array(PrListItemSchema);

export const CheckRunSchema = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  completedAt: z.string().nullable().optional(),
  detailsUrl: z.string().optional(),
  workflowName: z.string().optional(),
});

export const StatusContextSchema = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullable().optional(),
});

export const StatusCheckSchema = z.discriminatedUnion('__typename', [CheckRunSchema, StatusContextSchema]);
export type StatusCheck = z.infer<typeof StatusCheckSchema>;

export const PrViewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.object({
    login: z.string(),
    is_bot: z.boolean().optional(),
  }),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  baseRefName: z.string(),
  url: z.string().url(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  reviewDecision: ReviewDecisionSchema,
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  latestReviews: z.array(
    z
      .object({
        author: z.object({ login: z.string() }),
        state: z.string(),
        submittedAt: z.string(),
      })
      .passthrough(),
  ),
  statusCheckRollup: z.array(StatusCheckSchema).nullable().default([]),
});
export type PrView = z.infer<typeof PrViewSchema>;

export type CiStatus = 'success' | 'pending' | 'failure' | 'none';

const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILURE_STATES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

export function ciStatus(checks: readonly StatusCheck[]): CiStatus {
  if (checks.length === 0) return 'none';
  let pending = false;
  for (const check of checks) {
    if (check.__typename === 'CheckRun') {
      if (check.conclusion !== null && FAILURE_CONCLUSIONS.has(check.conclusion)) return 'failure';
      if (check.status !== 'COMPLETED') pending = true;
    } else {
      if (FAILURE_STATES.has(check.state)) return 'failure';
      if (PENDING_STATES.has(check.state)) pending = true;
    }
  }
  return pending ? 'pending' : 'success';
}

export function mapPrView(
  slug: string,
  view: PrView,
): {
  pr: PrInfo;
  state: PrView['state'];
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  ci: CiStatus;
  headRefName: string;
} {
  const checks = view.statusCheckRollup ?? [];
  return {
    pr: {
      repo: slug,
      number: view.number,
      url: view.url,
      headSha: view.headRefOid,
      reviewedSha: null,
      title: view.title,
      author: view.author.login,
    },
    state: view.state,
    isDraft: view.isDraft,
    reviewDecision: view.reviewDecision,
    ci: ciStatus(checks),
    headRefName: view.headRefName,
  };
}

export function parsePrList(stdout: string): PrListItem[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  return PrListSchema.parse(JSON.parse(trimmed));
}

export function parsePrView(stdout: string): PrView {
  const parsed = PrViewSchema.parse(JSON.parse(stdout));
  return { ...parsed, statusCheckRollup: parsed.statusCheckRollup ?? [] };
}
