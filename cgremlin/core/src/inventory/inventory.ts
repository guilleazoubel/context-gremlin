import { z } from 'zod';
import {
  ReviewDecisionSchema,
  ciStatus,
  flattenLabels,
  flattenReviewRequests,
  type CiStatus,
  type PrInventoryItem,
  type ReviewDecision,
} from '../gh/pr-view';
import { isBotLogin } from '../work/bot-login';
import { extractTicketKeys } from '../gh/ticket-keys';
import type { Session, ReviewSession } from '../schema/session';
import { REVIEW_PHASES, type ReviewPhase } from '../schema/pipeline';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';

export interface TeamActivity {
  login: string;
  kind: 'review' | 'comment';
  state?: string;
  at: string;
}

export type OursStatus =
  | { status: 'none' }
  | {
      status: 'reviewing' | 'reviewed' | 'failed';
      sessionId: string;
      reviewedSha: string | null;
      newCommits: boolean;
      phase: ReviewPhase;
    };

/**
 * R47 (superseding R6's `humanReviewed`/`reviewers` pair — neither name
 * exists anywhere): who is already on this PR. Distinct non-bot, non-author
 * logins; `lastAt` is the newest of their timestamps, or null when nobody is
 * on it. `me` is NOT excluded — if I reviewed it, a human is on it.
 */
export interface HumanActivity {
  reviewedBy: string[];
  commentedBy: string[];
  lastAt: string | null;
}

export interface InventoryEntry {
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  updatedAt: string;
  reviewDecision: ReviewDecision;
  isMine: boolean;
  teamActivity: TeamActivity[];
  ours: OursStatus;
  seenAt: string;
  // ---- Phase 9 (R45: every one optional-with-a-default on the schema) ----
  branch: string | null;
  ticketKeys: string[];
  reviewRequests: string[];
  humanActivity: HumanActivity;
  createdAt: string | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  ci: CiStatus;
  labels: string[];
  /** R58: the timestamp `approved`/`changes_requested` are pinned to. */
  reviewDecisionAt: string | null;
}

export interface Inventory {
  scannedAt: string;
  repos: string[];
  entries: InventoryEntry[];
  errors: { repo: string; error: string }[];
}

export interface InventoryGroups {
  unreviewed: InventoryEntry[];
  teamOnIt: InventoryEntry[];
  ours: InventoryEntry[];
  mine: InventoryEntry[];
}

export interface InventoryConfig {
  me: string;
  watchAuthors: readonly string[];
  /** R5 — added to, never replacing, `DEFAULT_BOT_LOGINS`. */
  botLogins?: readonly string[];
  /** R46 — empty (or absent) disables ticket linking entirely. */
  projectKeys?: readonly string[];
  /**
   * R52 — review-thread replies, keyed `"<repo>#<n>"`, from the PREVIOUS
   * tick's cache. They count towards `humanActivity` alongside reviews and
   * conversation comments; the leg that refreshes them runs AFTER this scan
   * publishes (R34), so this is deliberately one tick behind.
   */
  threadComments?: ReadonlyMap<string, ReadonlyArray<{ login: string; at: string }>>;
}

function buildTeamActivity(
  item: PrInventoryItem,
  watchSet: ReadonlySet<string>,
  meLower: string,
): TeamActivity[] {
  const authorLower = item.author.login.toLowerCase();
  const activity: TeamActivity[] = [];
  for (const review of item.reviews) {
    const loginLower = review.author.login.toLowerCase();
    if (watchSet.has(loginLower) && loginLower !== meLower && loginLower !== authorLower) {
      activity.push({ login: review.author.login, kind: 'review', state: review.state, at: review.submittedAt });
    }
  }
  for (const comment of item.comments) {
    const loginLower = comment.author.login.toLowerCase();
    if (watchSet.has(loginLower) && loginLower !== meLower && loginLower !== authorLower) {
      activity.push({ login: comment.author.login, kind: 'comment', at: comment.createdAt });
    }
  }
  return activity.sort((a, b) => a.at.localeCompare(b.at));
}

function buildOursStatus(repo: string, number: number, headSha: string, sessions: readonly Session[]): OursStatus {
  const session = sessions.find(
    (s): s is ReviewSession =>
      s.mode === 'review' &&
      !TERMINAL_PHASES_BY_MODE.review.has(s.stageStatus) &&
      s.pr !== null &&
      s.pr.repo === repo &&
      s.pr.number === number,
  );
  if (!session) {
    return { status: 'none' };
  }
  const phase = session.stageStatus;
  const status =
    phase === 'queued' || phase === 'reviewing' ? 'reviewing' : phase === 'failed' ? 'failed' : 'reviewed';
  const reviewedSha = session.pr?.reviewedSha ?? null;
  const newCommits = reviewedSha !== null && reviewedSha !== headSha;
  return { status, sessionId: session.id, reviewedSha, newCommits, phase };
}

/**
 * R6 as amended by R47/R52 — computed at scan time from the RAW, unfiltered
 * reviews and comments (never from `teamActivity`, which is watch-filtered
 * and would call a non-watched human's review "no review"). A1 leaves the
 * field additive so A8 only widens the inputs with review-thread replies.
 */
function buildHumanActivity(
  item: PrInventoryItem,
  authorLower: string,
  botLogins: readonly string[],
  threadComments: ReadonlyArray<{ login: string; at: string }>,
): HumanActivity {
  const reviewedBy: string[] = [];
  const commentedBy: string[] = [];
  let lastAt: string | null = null;
  const note = (login: string, isBot: boolean | undefined, at: string, into: string[]): void => {
    if (login.toLowerCase() === authorLower) return;
    if (isBotLogin(login, { isBot, extra: botLogins })) return;
    if (!into.includes(login)) into.push(login);
    if (lastAt === null || at > lastAt) lastAt = at;
  };
  for (const r of item.reviews) note(r.author.login, r.author.is_bot, r.submittedAt, reviewedBy);
  for (const c of item.comments) note(c.author.login, c.author.is_bot, c.createdAt, commentedBy);
  // R52: a review-thread reply is a human on the PR exactly like a
  // conversation comment, and it is the only signal the two `gh pr list`
  // arrays cannot see.
  for (const t of threadComments) note(t.login, undefined, t.at, commentedBy);
  return { reviewedBy, commentedBy, lastAt };
}

/**
 * R58 — the `submittedAt` of the NEWEST review whose `state` matches the
 * entry's CURRENT `reviewDecision`, and null when none matches. Taking the
 * latest APPROVED review regardless of the decision gets a mixed PR (an
 * older APPROVED beside a newer CHANGES_REQUESTED) wrong.
 */
function reviewDecisionAtOf(item: PrInventoryItem): string | null {
  if (item.reviewDecision !== 'APPROVED' && item.reviewDecision !== 'CHANGES_REQUESTED') return null;
  let at: string | null = null;
  for (const r of item.reviews) {
    if (r.state !== item.reviewDecision) continue;
    if (at === null || r.submittedAt > at) at = r.submittedAt;
  }
  return at;
}

/** R4: branch, then title, then body, keeping every distinct match in that order. */
function ticketKeysOf(item: PrInventoryItem, projectKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const text of [item.headRefName, item.title, item.body ?? '']) {
    for (const key of extractTicketKeys(text, projectKeys)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

export function buildEntries(
  repo: string,
  items: readonly PrInventoryItem[],
  sessions: readonly Session[],
  cfg: InventoryConfig,
  now: string,
): InventoryEntry[] {
  const watchSet = new Set(cfg.watchAuthors.map((login) => login.toLowerCase()));
  const meLower = cfg.me.toLowerCase();
  return items.map((item) => ({
    repo,
    number: item.number,
    url: item.url,
    title: item.title,
    author: item.author.login,
    isDraft: item.isDraft,
    headSha: item.headRefOid,
    baseRef: item.baseRefName,
    updatedAt: item.updatedAt,
    reviewDecision: item.reviewDecision,
    isMine: item.author.login.toLowerCase() === meLower,
    teamActivity: buildTeamActivity(item, watchSet, meLower),
    ours: buildOursStatus(repo, item.number, item.headRefOid, sessions),
    seenAt: now,
    branch: item.headRefName,
    ticketKeys: ticketKeysOf(item, cfg.projectKeys ?? []),
    reviewRequests: flattenReviewRequests(item.reviewRequests),
    humanActivity: buildHumanActivity(
      item,
      item.author.login.toLowerCase(),
      cfg.botLogins ?? [],
      cfg.threadComments?.get(`${repo}#${item.number}`) ?? [],
    ),
    createdAt: item.createdAt ?? null,
    changedFiles: item.changedFiles ?? null,
    additions: item.additions ?? null,
    deletions: item.deletions ?? null,
    // R53: no new CI logic — the EXISTING ciStatus() collapses the rollup.
    ci: ciStatus(item.statusCheckRollup ?? []),
    labels: flattenLabels(item.labels),
    reviewDecisionAt: reviewDecisionAtOf(item),
  }));
}

export function groupInventory(inv: Inventory): InventoryGroups {
  const groups: InventoryGroups = { unreviewed: [], teamOnIt: [], ours: [], mine: [] };
  for (const entry of inv.entries) {
    if (entry.isMine) {
      groups.mine.push(entry);
    } else if (entry.ours.status !== 'none') {
      groups.ours.push(entry);
    } else if (entry.teamActivity.length > 0) {
      groups.teamOnIt.push(entry);
    } else {
      groups.unreviewed.push(entry);
    }
  }
  return groups;
}

const TeamActivitySchema = z.object({
  login: z.string(),
  kind: z.enum(['review', 'comment']),
  state: z.string().optional(),
  at: z.string(),
});

const OursStatusSchema = z.union([
  z.object({ status: z.literal('none') }),
  z.object({
    status: z.enum(['reviewing', 'reviewed', 'failed']),
    sessionId: z.string(),
    reviewedSha: z.string().nullable(),
    newCommits: z.boolean(),
    phase: z.enum(REVIEW_PHASES),
  }),
]);

const InventoryEntrySchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  headSha: z.string(),
  baseRef: z.string(),
  updatedAt: z.string(),
  reviewDecision: ReviewDecisionSchema,
  isMine: z.boolean(),
  teamActivity: z.array(TeamActivitySchema),
  ours: OursStatusSchema,
  seenAt: z.string(),
  // R9/R45: EVERY field Phase 9 adds is optional-with-a-default. A required
  // one would 500 GET /prs on the first launch after an upgrade, because
  // InventoryStore.load throws InventoryCorruptError and loadCurrentInventory
  // has no catch. The numbers default to null, never 0 — an unknown size is
  // rendered '—', not '0 files' (MG-12).
  branch: z.string().nullable().default(null),
  ticketKeys: z.array(z.string()).default([]),
  reviewRequests: z.array(z.string()).default([]),
  humanActivity: z
    .object({
      reviewedBy: z.array(z.string()).default([]),
      commentedBy: z.array(z.string()).default([]),
      lastAt: z.string().nullable().default(null),
    })
    .default({ reviewedBy: [], commentedBy: [], lastAt: null }),
  createdAt: z.string().nullable().default(null),
  changedFiles: z.number().int().nullable().default(null),
  additions: z.number().int().nullable().default(null),
  deletions: z.number().int().nullable().default(null),
  ci: z.enum(['success', 'pending', 'failure', 'none']).default('none'),
  labels: z.array(z.string()).default([]),
  reviewDecisionAt: z.string().nullable().default(null),
});

export const InventorySchema = z.object({
  scannedAt: z.string(),
  repos: z.array(z.string()),
  entries: z.array(InventoryEntrySchema),
  errors: z.array(z.object({ repo: z.string(), error: z.string() })),
});

// The `z.ZodType<Inventory>` annotation this schema used to carry is gone:
// the schema's INPUT type is now deliberately looser than `Inventory` (every
// Phase 9 field is optional-with-a-default — R45), which that annotation
// forbids. These two assertions keep the OUTPUT pinned to `Inventory` in
// both directions, which is what the annotation was actually buying.
type _InventoryOutIsInventory = z.infer<typeof InventorySchema> extends Inventory ? true : never;
type _InventoryIsInventoryOut = Inventory extends z.infer<typeof InventorySchema> ? true : never;
const _inventorySchemaOutMatches: _InventoryOutIsInventory = true;
const _inventorySchemaInMatches: _InventoryIsInventoryOut = true;
void _inventorySchemaOutMatches;
void _inventorySchemaInMatches;
