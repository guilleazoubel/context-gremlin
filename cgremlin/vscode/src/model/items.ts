/**
 * The wire shapes the extension consumes from the engine's Unix socket.
 *
 * These are *structural mirrors* of the core's own types, declared here on purpose: the extension
 * is a standalone package with no path dependency on `cgremlin/core`, so nothing is imported from
 * it. The integration task is what proves the mirrors match reality.
 *
 * This module is pure — it must never reach for the editor API (MG-B1).
 */

// ---------------------------------------------------------------------------
// Attention (core `src/attention/attention.ts`, `src/attention/item-ref.ts`)
// ---------------------------------------------------------------------------

/** Canonical order. The core orders `AttentionState.reasons` by this list; nothing sorts. */
export const ATTENTION_REASONS = [
  'plan_ready',
  'needs_input',
  'blocked',
  'run_failed',
  'review_ready',
  'rereview_ready',
  // R51/R63: a respond session at 'ready'. The positions of this array ARE the contract — the
  // core orders every reason list by it and the ack signature is built from that order.
  'comments_ready',
  'local_prereq_failed',
  'changes_requested',
  'review_arrived',
  'approved',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ITEM_SOURCES = ['pr', 'session'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** `'session:<id>'` | `'pr:<owner>/<repo>#<n>'` — parsed only by the core; opaque here. */
export type ItemRef = string;

/** R51: `respond` is the fourth mode — addressing the reviews on my own PR. */
export type SessionMode = 'investigation' | 'development' | 'review' | 'respond';

export interface AttentionState {
  needsAttention: boolean;
  /** The core's own answer to "does this want ME" (R22). No client re-derives it. */
  needsYou: boolean;
  reasons: AttentionReason[];
  since: string;
  signature: string;
  acked: boolean;
}

/** Every optional affordance an item may offer; all nullable, so a client feature-detects. */
export interface ItemLinks {
  sessionId: string | null;
  worktreePath: string | null;
  prRepo: string | null;
  prNumber: number | null;
  prUrl: string | null;
  ticket: string | null;
  primaryArtifact: string | null;
}

export interface Item {
  source: ItemSource;
  ref: ItemRef;
  id: string;
  title: string;
  repoOrContext: string;
  attention: AttentionState;
  links: ItemLinks;
}

/**
 * The label an item shows. A source that gave the item no title (an inventory row seen before its
 * first scan, a session whose PR has none) falls back to the id, which is never empty.
 */
export function displayTitle(item: Pick<Item, 'title' | 'id'>): string {
  return item.title === '' ? item.id : item.title;
}

export interface AttentionItem extends Item {
  mode: SessionMode | null;
  stageStatus: string | null;
  running: boolean;
  claimed: boolean;
}

export interface AttentionListing {
  evaluatedAt: string;
  items: AttentionItem[];
}

// ---------------------------------------------------------------------------
// Inventory (core `src/inventory/inventory.ts`)
// ---------------------------------------------------------------------------

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
      phase: string;
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
  reviewDecision: '' | 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED';
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

// ---------------------------------------------------------------------------
// Sessions (core `src/schema/session.ts`)
// ---------------------------------------------------------------------------

export interface HumanTurnView {
  claimedAt: string;
  expiresAt: string;
}

export interface AgentView {
  runner: 'claude-code' | 'codex';
  resumeId: string | null;
  humanTurn?: HumanTurnView | null;
}

export interface LastRunView {
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'stopped';
  error: string | null;
}

export interface PrView {
  repo: string;
  number: number;
  url: string;
  headSha: string | null;
  reviewedSha: string | null;
  title: string | null;
  author: string | null;
}

export interface SessionView {
  schemaVersion: number;
  id: string;
  createdAt: string;
  mode: SessionMode;
  stageStatus: string;
  workspace: { repoUrl: string; worktreePath?: string; branch?: string };
  lineage: { pipelineId: string; parentSessionId: string | null; ticket: string | null };
  agent: AgentView | null;
  lastRun: LastRunView | null;
  pr: PrView | null;
  /** investigation only */
  intent?: 'investigate_only' | 'development';
  driveToCompletion?: boolean;
  /** review only */
  reviewVersion?: number;
  lastRereviewSummary?: { resolved: number; total: number; newFindings: number } | null;
}

// ---------------------------------------------------------------------------
// Artifacts, conversation, config
// ---------------------------------------------------------------------------

export interface ArtifactListing {
  name: string;
  mtime: string;
  size: number;
}

export interface ArtifactListingResponse {
  artifacts: ArtifactListing[];
  primary: string | null;
}

export interface ConversationView {
  runner: 'claude-code' | 'codex' | null;
  resumeId: string | null;
  worktreePath: string | null;
  claimed: boolean;
}

/** `GET /config`, already through `redactCoreConfig` — the bypass secret never arrives here. */
export interface CoreConfigView {
  repos: string[];
  watchAuthors: string[];
  me: string;
  runner: 'claude-code' | 'codex';
  pollIntervalMs: number;
  stateDir: string;
  sessionsDir: string;
  worktreesDir: string;
  mirrorsDir: string;
  socketPath: string;
  inventoryPath: string;
  defaultBaseRef: string;
  /** Present once the core ships R20's claim TTL; the chat heartbeat reads it. */
  humanTurnTtlMs?: number;
  /**
   * Phase 15 §6: the per-repo environment blocks, keyed by `owner/repo`. The panel reads exactly
   * one thing out of them — whether a repo has a `qa.url` — because nothing else in the repo
   * knows the QA address, and a `Verify in QA` button on a repo without one can only 404.
   * **Optional**: an engine older than Phase 15 sends no `environments` at all.
   */
  environments?: Record<string, { qa?: { url?: string } | null } | null>;
  /**
   * Phase 18: `jira.qaStatuses` — the statuses that mean "this ticket is in QA". The panel reads
   * it for ONE question: does a row that cannot be verified plausibly WANT to be? **Optional**:
   * an engine with no Jira configured sends no `jira` block at all.
   */
  jira?: { qaStatuses?: string[] } | null;
  [key: string]: unknown;
}

/**
 * The repos that have a QA environment configured, as §8's gate wants them. A malformed or
 * absent block is "no QA here" rather than an error: the panel degrades to offering no verb.
 */
export function qaReposOf(config: CoreConfigView | null | undefined): string[] {
  const environments = config?.environments;
  if (environments === undefined || environments === null) return [];
  return Object.entries(environments)
    .filter(([, env]) => typeof env?.qa?.url === 'string' && env.qa.url !== '')
    .map(([slug]) => slug);
}

/**
 * Phase 18 — the statuses that mean "in QA". A missing or malformed block is an empty list
 * rather than an error: the panel then says nothing about QA, exactly as it does today.
 */
export function qaStatusesOf(config: CoreConfigView | null | undefined): string[] {
  const statuses = config?.jira?.qaStatuses;
  if (!Array.isArray(statuses)) return [];
  return statuses.filter((status): status is string => typeof status === 'string' && status !== '');
}

// ---------------------------------------------------------------------------
// Presentation (the panel's four lists)
// ---------------------------------------------------------------------------

export type ListKind = 'parking' | 'reviewing' | 'investigations' | 'devwork';

/** A ListItem IS an Item plus presentation — it adds no domain field of its own (R18). */
export interface ListItem {
  kind: ListKind;
  item: AttentionItem;
  label: string;
  description: string;
  indicator: '' | '⟳' | '◑' | '✓' | '■' | '!' | '◉';
  contextValue: string;
}
