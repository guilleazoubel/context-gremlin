import type { Session } from '../schema/session';
import type { InventoryEntry } from '../inventory/inventory';

/**
 * The pure attention model (R18). This module knows nothing about the
 * filesystem, the engine, or the clock: every timestamp arrives as evidence
 * and every source-specific read lives in its own `derive*Reasons` below.
 * `evaluateAttention` itself is source-agnostic — ordering, the canonical
 * signature and the acknowledgement comparison, and nothing else — so a
 * future Jira/Slack source adds a deriver and touches it not at all.
 */
export const ATTENTION_REASONS = [
  'plan_ready',            // investigation is at plan_ready — a human must approve
  'needs_input',           // AGENT_STATE === 'needs-input'
  'blocked',               // AGENT_STATE === 'blocked'
  'run_failed',            // lastRun.outcome === 'failed', OR 'running' with nothing running (engine died, R22)
  'review_ready',          // review session at 'ready' — REVIEW.md is waiting to be read
  'rereview_ready',        // review session at 'ready' with a lastRereviewSummary
  'local_prereq_failed',   // this session's local app degraded to 'unavailable'
  'changes_requested',     // my own PR has CHANGES_REQUESTED or fresh team activity
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * The subset that interrupts. Everything else is badge-only. Lives HERE and
 * nowhere else — every client consumes `AttentionState.needsYou` and carries
 * no copy of this list (R22).
 */
export const NEEDS_YOU_REASONS: readonly AttentionReason[] = [
  'plan_ready',
  'needs_input',
  'blocked',
  'run_failed',
  'review_ready',
  'rereview_ready',
  'changes_requested',
];

export interface AttentionState {
  needsAttention: boolean;
  /**
   * R22: at least one reason is in NEEDS_YOU_REASONS and the item is not
   * acked. The core's answer to "does this want ME", so no client re-derives
   * it. Always false when needsAttention is false.
   */
  needsYou: boolean;
  reasons: AttentionReason[];
  /** ISO. */
  since: string;
  /**
   * THE canonical signature, defined once: `reasons.join(',') + '|' + since`,
   * with `reasons` already in ATTENTION_REASONS order. No sort, anywhere.
   * This is also what an acknowledgement stores (R10).
   */
  signature: string;
  acked: boolean;
}

/** A reason plus the timestamp that justifies it — what every deriver returns. */
export interface DerivedReason {
  reason: AttentionReason;
  at: string | null;
}

/** The later of two ISO timestamps; ISO-8601 UTC sorts lexicographically. */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** THE shared, source-agnostic evaluator (R18): ordering, signature, ack. Pure; no clock. */
export function evaluateAttention(input: {
  derived: readonly DerivedReason[];
  fallbackSince: string;
  ack: { signature: string; ackedAt: string } | null;
}): AttentionState {
  const reasons: AttentionReason[] = [];
  let at: string | null = null;
  // Ordered by walking ATTENTION_REASONS, which is also what dedupes: no sort.
  for (const reason of ATTENTION_REASONS) {
    let fired = false;
    for (const candidate of input.derived) {
      if (candidate.reason !== reason) continue;
      fired = true;
      at = laterOf(at, candidate.at);
    }
    if (fired) reasons.push(reason);
  }
  const since = at ?? input.fallbackSince;
  const signature = `${reasons.join(',')}|${since}`;
  const acked = input.ack !== null && input.ack.signature === signature;
  const needsAttention = reasons.length > 0 && !acked;
  const needsYou = needsAttention && reasons.some((r) => NEEDS_YOU_REASONS.includes(r));
  return { needsAttention, needsYou, reasons, since, signature, acked };
}

export interface SessionEvidence {
  session: Session;
  agentState: 'working' | 'ready' | 'needs-input' | 'blocked' | null;
  /** ISO; null when AGENT_STATE is absent (or its mtime is unavailable). */
  agentStateMtime: string | null;
  /** From PipelineService.activeSessionIds(). */
  running: boolean;
  /**
   * ONLY this session's own local app: the adapter passes null unless the
   * global app's `status.sessionId === session.id` — the same W8 ownership
   * rule as `src/api/server.ts:305-318` (R22), without which one degraded
   * app raises `local_prereq_failed` on every session.
   */
  localApp: { state: 'running' | 'stopped' | 'unavailable'; reason: string | null } | null;
}

export function deriveSessionReasons(ev: SessionEvidence): DerivedReason[] {
  const derived: DerivedReason[] = [];
  const s = ev.session;
  const lastRun = s.lastRun;
  if (s.mode === 'investigation' && s.stageStatus === 'plan_ready') {
    derived.push({ reason: 'plan_ready', at: lastRun?.finishedAt ?? null });
  }
  // R6: AGENT_STATE is authoritative even while a run is live. Core has ONE
  // state file, written by the agent only deliberately at a gate, so a
  // mid-run 'needs-input' is a statement rather than stale activity — this
  // deliberately diverges from the legacy precedence recorded in
  // docs/superpowers/plans/2026-07-09-status-panel-attention-work-sessions.md:17.
  // Liveness is reported separately, as `running` on the item.
  if (ev.agentState === 'needs-input') {
    derived.push({ reason: 'needs_input', at: ev.agentStateMtime });
  }
  if (ev.agentState === 'blocked') {
    derived.push({ reason: 'blocked', at: ev.agentStateMtime });
  }
  // R22: an on-disk 'running' record with nothing actually running means the
  // host died mid-run — a failure, not a silence. Such a record has no
  // finishedAt by construction, so startedAt is its only timestamp.
  if (lastRun !== null && !ev.running && (lastRun.outcome === 'failed' || lastRun.outcome === 'running')) {
    derived.push({
      reason: 'run_failed',
      at: lastRun.outcome === 'running' ? lastRun.startedAt : lastRun.finishedAt,
    });
  }
  if (s.mode === 'review' && s.stageStatus === 'ready') {
    derived.push({ reason: 'review_ready', at: lastRun?.finishedAt ?? null });
    if (s.lastRereviewSummary !== null) {
      derived.push({ reason: 'rereview_ready', at: lastRun?.finishedAt ?? null });
    }
  }
  if (ev.localApp?.state === 'unavailable') {
    derived.push({ reason: 'local_prereq_failed', at: null });
  }
  return derived;
}

/**
 * The one inventory-only reason: my own PR that people are waiting on me
 * about. No parking-lot entry ever needs attention — that would fight R5's
 * "nothing auto-reviews" (MG-A8).
 */
export function derivePrReasons(entry: InventoryEntry): DerivedReason[] {
  if (!entry.isMine) return [];
  if (entry.reviewDecision !== 'CHANGES_REQUESTED' && entry.teamActivity.length === 0) return [];
  return [{ reason: 'changes_requested', at: entry.updatedAt }];
}
