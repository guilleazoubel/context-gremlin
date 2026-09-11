import { z } from 'zod';
import type { PrInfo } from '../schema/stage';

export const PR_LIST_FIELDS =
  'number,url,author,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,title,updatedAt';
// R53: the inventory query widens by eight fields so a parking-lot row can
// show age, size, CI, labels and who has been asked to review — still ONE
// `gh pr list` per repo on the happy path. `body` is fetched for ticket-key
// extraction and thrown away (R8). PR_LIST_FIELDS is deliberately untouched.
export const PR_INVENTORY_EXTRA_FIELDS =
  'createdAt,changedFiles,additions,deletions,reviewRequests,statusCheckRollup,labels,body';
export const PR_INVENTORY_FIELDS = `${PR_LIST_FIELDS},latestReviews,reviews,comments,${PR_INVENTORY_EXTRA_FIELDS}`;
// R67: when the one call trips GitHub's GraphQL node limit the scan is split
// in two — the cheap scalars, then the expensive connections — joined on
// `number`. Tried once per repo per scan.
export const PR_INVENTORY_FIELDS_SCALARS =
  `${PR_LIST_FIELDS},createdAt,changedFiles,additions,deletions,labels,reviewRequests,body`;
export const PR_INVENTORY_FIELDS_CONNECTIONS = 'number,latestReviews,reviews,comments,statusCheckRollup';
export const PR_COMMENTS_FIELDS = 'comments';
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
  // R29/R53: every one of these is named EXPLICITLY, because this schema is
  // not `.passthrough()` — an unnamed field is silently stripped before
  // `buildEntries` ever sees it.
  body: z.string().optional(),
  createdAt: z.string().optional(),
  changedFiles: z.number().int().optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  labels: z.array(z.object({ name: z.string() }).passthrough()).catch([]).optional(),
  // R60: gh emits a heterogeneous array of users ({ login }) and teams
  // ({ name, slug }). `z.array(z.object({ login }))` would throw on the first
  // team-requested PR.
  reviewRequests: z
    .array(
      z.union([
        z.object({ login: z.string() }),
        z.object({ name: z.string().optional(), slug: z.string() }),
      ]),
    )
    .catch([])
    .optional(),
});
export type PrListItem = z.infer<typeof PrListItemSchema>;

/** R60: a user contributes its `login`, a team its `slug`. */
export function flattenReviewRequests(
  requests: PrListItem['reviewRequests'],
): string[] {
  if (requests === undefined) return [];
  return requests.map((r) => ('login' in r ? r.login : r.slug));
}

/** R53: labels arrive as objects; the entry stores the names. */
export function flattenLabels(labels: PrListItem['labels']): string[] {
  if (labels === undefined) return [];
  return labels.map((l) => l.name);
}

export const PrListSchema = z.array(PrListItemSchema);

// U1: gh may or may not emit `is_bot` on a review/comment author. Named as
// optional so it survives parsing when it is there (R53).
export const ActivityAuthorSchema = z.object({ login: z.string(), is_bot: z.boolean().optional() });

export const PrReviewSchema = z
  .object({
    author: ActivityAuthorSchema,
    state: z.string(),
    submittedAt: z.string(),
  })
  .passthrough();
export type PrReview = z.infer<typeof PrReviewSchema>;

export const PrCommentSchema = z
  .object({
    author: ActivityAuthorSchema,
    createdAt: z.string(),
  })
  .passthrough();
export type PrComment = z.infer<typeof PrCommentSchema>;

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

export const PrInventoryItemSchema = PrListItemSchema.extend({
  latestReviews: z.array(PrReviewSchema).nullable().default([]),
  reviews: z.array(PrReviewSchema).nullable().default([]),
  comments: z.array(PrCommentSchema).nullable().default([]),
  // R59: the rollup is a heterogeneous union and nothing here proves what
  // `gh pr list` (as opposed to `gh pr view`) emits for it — U6. A parse
  // failure is `[]`, hence `ci: 'none'`, never an InventoryCorruptError.
  statusCheckRollup: z.array(StatusCheckSchema).catch([]).optional(),
});
// The schema stays nullable so it can parse gh's raw JSON (which may omit
// these keys or emit an explicit null), but parsePrInventoryList always
// normalizes them to [] before returning — this narrowed type lets callers
// use these arrays directly, without repeating that normalization.
export type PrInventoryItem = Omit<
  z.infer<typeof PrInventoryItemSchema>,
  'latestReviews' | 'reviews' | 'comments'
> & {
  latestReviews: PrReview[];
  reviews: PrReview[];
  comments: PrComment[];
};

export const PrInventoryListSchema = z.array(PrInventoryItemSchema);

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

export function parsePrInventoryList(stdout: string): PrInventoryItem[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  const parsed = PrInventoryListSchema.parse(JSON.parse(trimmed));
  return parsed.map((item) => ({
    ...item,
    latestReviews: item.latestReviews ?? [],
    reviews: item.reviews ?? [],
    comments: item.comments ?? [],
  }));
}

export function parsePrView(stdout: string): PrView {
  const parsed = PrViewSchema.parse(JSON.parse(stdout));
  return { ...parsed, statusCheckRollup: parsed.statusCheckRollup ?? [] };
}

const PrCommentsEnvelopeSchema = z.object({
  comments: z.array(z.object({ author: z.object({ login: z.string() }), body: z.string() }).passthrough()),
});

export function parsePrComments(stdout: string): { author: { login: string }; body: string }[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  return PrCommentsEnvelopeSchema.parse(JSON.parse(trimmed)).comments;
}
