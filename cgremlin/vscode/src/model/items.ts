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
  'local_prereq_failed',
  'changes_requested',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ITEM_SOURCES = ['pr', 'session'] as const;
export type ItemSource = (typeof ITEM_SOURCES)[number];

/** `'session:<id>'` | `'pr:<owner>/<repo>#<n>'` — parsed only by the core; opaque here. */
export type ItemRef = string;

export type SessionMode = 'investigation' | 'development' | 'review';

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
  [key: string]: unknown;
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
  indicator: '' | '🔄' | '⏸️' | '✅' | '🛑' | '❗' | '👤';
  contextValue: string;
}
