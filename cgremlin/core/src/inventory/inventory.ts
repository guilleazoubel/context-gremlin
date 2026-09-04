import { z } from 'zod';
import { ReviewDecisionSchema, type PrInventoryItem, type ReviewDecision } from '../gh/pr-view';
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
});

export const InventorySchema: z.ZodType<Inventory> = z.object({
  scannedAt: z.string(),
  repos: z.array(z.string()),
  entries: z.array(InventoryEntrySchema),
  errors: z.array(z.object({ repo: z.string(), error: z.string() })),
});
