import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { PipelineService } from '../pipeline/pipeline-service';
import type { InvestigationSession, RespondSession, ReviewSession, Session } from '../schema/session';
import type { SessionMode } from '../schema/session-mode';
import {
  canTransition,
  type DevelopmentPhase,
  type InvestigationPhase,
  type QaPhase,
  type RespondPhase,
  type ReviewPhase,
} from '../schema/pipeline';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { awaitRunStart } from '../pipeline/run-start';
import { HumanTurnInProgressError, isClaimed } from '../pipeline/pipeline-service';
import type { KeyedLock } from '../api/keyed-lock';

export type ReconcileAction =
  | { type: 'transition'; sessionId: string; to: string; reason: string }
  | { type: 'rereview'; sessionId: string; reason: string };

export interface SkippedTransition {
  sessionId: string;
  to: string;
  why: string;
}

export interface PlanReconciliationInput {
  review: ReviewSession;
  view: ReturnType<typeof mapPrView>;
  source: Session | null;
  /**
   * A clock ARGUMENT, not a clock — the function stays pure. Needed only to
   * decide whether the review's human-turn claim is still live (R20).
   */
  now: Date;
}

export interface PlanReconciliationResult {
  actions: ReconcileAction[];
  skipped: SkippedTransition[];
}

const APPROVE_ELIGIBLE_REVIEW_PHASES: readonly ReviewPhase[] = ['queued', 'ready', 'changes_requested', 'failed'];
const REREVIEW_ELIGIBLE_REVIEW_PHASES: readonly ReviewPhase[] = ['ready', 'changes_requested'];
// Phase 3a never records pr_opened (no code path sets it yet), so a
// development source can still be sitting at 'active' when its PR merges —
// 'active' must be merge-eligible too, or that session is stranded forever.
const MERGE_ELIGIBLE_DEVELOPMENT_PHASES: readonly DevelopmentPhase[] = ['active', 'pr_opened', 'superseded'];
/** One string for both claim-skip sites (planning and the apply loop), so the two cannot drift. */
const CLAIMED_SKIP_REASON = 'conversation claimed by a human turn';

/**
 * Phase 14 — the deliberate start.
 *
 * A review (or a respond) that was IN FLIGHT when its PR landed is ended by
 * that landing: the work it was doing is over. A review the user started ON
 * PURPOSE **after** the PR had already merged — to READ a landed change — is
 * not. Both look identical to the MERGED/CLOSED branches below, and the only
 * thing that tells them apart is WHEN the session was created relative to
 * when the PR landed.
 *
 * The live case: `pr-grace-frontend-2061-20260915-160008`, created at 16:00
 * on `aplaceformom/grace-frontend#2061`, which merged at 14:28 the same day.
 * The first tick dismissed it and stopped its run, and all the user ever got
 * was the BRIEF.
 *
 * THE RULE, stated once: a `review` or `respond` session whose `createdAt` is
 * strictly AFTER the PR's landing timestamp (`mergedAt` for a merge,
 * `closedAt` for a close) is never ended by that landing — it is reported as
 * `skipped` instead, and its run is left running. An unknown or unparseable
 * landing timestamp keeps the old behaviour: we only decline to end a session
 * when we can actually prove it started later.
 */
function landedAtOf(view: ReturnType<typeof mapPrView>): string | null {
  if (view.state === 'MERGED') return view.mergedAt ?? view.closedAt;
  if (view.state === 'CLOSED') return view.closedAt;
  return null;
}

function startedAfterLanding(session: Session, view: ReturnType<typeof mapPrView>): boolean {
  const landedAt = landedAtOf(view);
  if (landedAt === null) return false;
  const landed = Date.parse(landedAt);
  const created = Date.parse(session.createdAt);
  if (Number.isNaN(landed) || Number.isNaN(created)) return false;
  return created > landed;
}

/** One sentence for both legs (review and respond), so the two reasons cannot drift. */
function deliberateStartSkip(session: Session, to: string, reason: string): SkippedTransition {
  return {
    sessionId: session.id,
    to,
    why: `${reason} before this ${session.mode} was started — started deliberately on a landed PR, left at '${session.stageStatus}'`,
  };
}

function canApplyTransition(mode: SessionMode, from: string, to: string): boolean {
  switch (mode) {
    case 'review':
      return canTransition('review', from as ReviewPhase, to as ReviewPhase);
    case 'development':
      return canTransition('development', from as DevelopmentPhase, to as DevelopmentPhase);
    case 'respond':
      return canTransition('respond', from as RespondPhase, to as RespondPhase);
    case 'investigation':
      return canTransition('investigation', from as InvestigationPhase, to as InvestigationPhase);
    case 'qa':
      return canTransition('qa', from as QaPhase, to as QaPhase);
  }
}

function proposeTransition(
  actions: ReconcileAction[],
  skipped: SkippedTransition[],
  mode: SessionMode,
  sessionId: string,
  from: string,
  to: string,
  reason: string,
): void {
  if (canApplyTransition(mode, from, to)) {
    actions.push({ type: 'transition', sessionId, to, reason });
  } else {
    skipped.push({ sessionId, to, why: `illegal ${mode} transition from '${from}' to '${to}'` });
  }
}

export function planReconciliation(input: PlanReconciliationInput): PlanReconciliationResult {
  const { review, view, source, now } = input;
  const actions: ReconcileAction[] = [];
  const skipped: SkippedTransition[] = [];

  if (view.state === 'MERGED') {
    if (startedAfterLanding(review, view)) {
      skipped.push(deliberateStartSkip(review, 'dismissed', 'PR merged'));
    } else {
      proposeTransition(actions, skipped, 'review', review.id, review.stageStatus, 'dismissed', 'PR merged');
    }
    if (
      source &&
      source.mode === 'development' &&
      MERGE_ELIGIBLE_DEVELOPMENT_PHASES.includes(source.stageStatus)
    ) {
      proposeTransition(actions, skipped, 'development', source.id, source.stageStatus, 'merged', 'PR merged');
    }
    return { actions, skipped };
  }

  if (view.state === 'CLOSED') {
    if (startedAfterLanding(review, view)) {
      skipped.push(deliberateStartSkip(review, 'dismissed', 'PR closed without merging'));
    } else {
      proposeTransition(actions, skipped, 'review', review.id, review.stageStatus, 'dismissed', 'PR closed without merging');
    }
    if (
      source &&
      source.mode === 'development' &&
      !TERMINAL_PHASES_BY_MODE.development.has(source.stageStatus)
    ) {
      proposeTransition(actions, skipped, 'development', source.id, source.stageStatus, 'abandoned', 'PR closed without merging');
    }
    return { actions, skipped };
  }

  // view.state === 'OPEN'
  if (view.reviewDecision === 'APPROVED' && APPROVE_ELIGIBLE_REVIEW_PHASES.includes(review.stageStatus)) {
    proposeTransition(actions, skipped, 'review', review.id, review.stageStatus, 'approved', 'GitHub review approved');
    return { actions, skipped };
  }

  if (
    view.pr.headSha !== review.pr?.reviewedSha &&
    REREVIEW_ELIGIBLE_REVIEW_PHASES.includes(review.stageStatus)
  ) {
    // R20: a human holding the conversation SKIPS the re-review — it never
    // errors. Returning the action anyway would make PipelineService refuse
    // it (HumanTurnInProgressError), and the apply loop's catch would file a
    // report.errors entry every pollIntervalMs for as long as the human keeps
    // the conversation open. Merge/close transitions above are deliberately
    // NOT guarded: a claim delays a re-review, never the truth about the PR.
    if (isClaimed(review, now)) {
      skipped.push({ sessionId: review.id, to: 'reviewing', why: CLAIMED_SKIP_REASON });
    } else {
      actions.push({ type: 'rereview', sessionId: review.id, reason: 'rereview started — outcome reported on the session' });
    }
  }

  return { actions, skipped };
}

/** A session that owns a PR without being a review of it: `respond` and `investigation` (R51). */
export type PrBearingSession = RespondSession | InvestigationSession;

export interface PlanPrSessionReconciliationInput {
  session: PrBearingSession;
  view: ReturnType<typeof mapPrView>;
}

/**
 * The other half of "merging ended this".
 *
 * `planReconciliation` only ever sees a session that is a REVIEW or the
 * review's lineage parent. A `respond` session is neither: it is created
 * standalone (`parentSessionId: null`), so when its PR merged nothing in
 * this module ever looked at it, and the stale session kept the whole work
 * item reading as live work — the live case
 * `respond-grace-2180-20260911-040030`, still at `addressing` on a PR merged
 * three days earlier.
 *
 * An `investigation` is deliberately LEFT ALONE and reported as skipped: an
 * investigation is a question, and a merge answers the change, not the
 * question. Its two terminal phases both mean something else
 * (`promoted_to_development` is a lineage act; `abandoned` says the question
 * was dropped), so ending it on a merge would be inventing a verdict.
 */
export function planPrSessionReconciliation(
  input: PlanPrSessionReconciliationInput,
): PlanReconciliationResult {
  const { session, view } = input;
  const actions: ReconcileAction[] = [];
  const skipped: SkippedTransition[] = [];
  if (view.state !== 'MERGED' && view.state !== 'CLOSED') return { actions, skipped };

  const reason = view.state === 'MERGED' ? 'PR merged' : 'PR closed without merging';
  if (session.mode === 'investigation') {
    skipped.push({
      sessionId: session.id,
      to: 'none',
      why: `${reason}, but an investigation is not ended by its PR — left at '${session.stageStatus}'`,
    });
    return { actions, skipped };
  }
  // R51's own terminals: a merge CLOSES the respond session (every comment it
  // was answering went in with the merge); a close without a merge abandons
  // it, exactly as it does the development session that opened the PR.
  const to = view.state === 'MERGED' ? 'closed' : 'abandoned';
  // The deliberate start applies to a respond exactly as it does to a review.
  if (startedAfterLanding(session, view)) {
    skipped.push(deliberateStartSkip(session, to, reason));
    return { actions, skipped };
  }
  proposeTransition(actions, skipped, 'respond', session.id, session.stageStatus, to, reason);
  return { actions, skipped };
}

export interface ReconciliationTickDeps {
  gh: GhRunner;
  store: SessionStore;
  pipeline: PipelineService;
  events: EngineEvents;
  lock: KeyedLock;
  /** Injected for the human-turn claim's TTL comparison (R20); defaults to the real clock. */
  now?: () => Date;
}

export interface TickReport {
  reconciled: number;
  actions: ReconcileAction[];
  skipped: SkippedTransition[];
  errors: { where: string; error: string }[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Only reconciles review sessions that already exist (rereview on new sha,
// approve, dismiss on merge/close). Discovering brand-new candidate PRs and
// auto-starting their review is retired (Phase 4 — see InventoryScanner):
// no code path here creates a session or starts a review for a PR the
// engine doesn't already have a session for.
export class ReconciliationTick {
  private readonly now: () => Date;

  constructor(private readonly deps: ReconciliationTickDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async run(): Promise<TickReport> {
    const report: TickReport = {
      reconciled: 0,
      actions: [],
      skipped: [],
      errors: [],
    };

    let sessions: Session[] = [];
    try {
      sessions = await this.deps.store.list();
    } catch (err) {
      report.errors.push({ where: 'store.list', error: errorMessage(err) });
    }
    const reviewSessions = sessions.filter(
      (s): s is ReviewSession =>
        s.mode === 'review' && !TERMINAL_PHASES_BY_MODE.review.has(s.stageStatus) && s.pr !== null,
    );

    for (const review of reviewSessions) {
      try {
        // Step 1, locked: read fresh + fetch the gh view + decide what to do.
        // An API request may have already acted on this session while it sat
        // in our snapshot from above, so this must plan off the current
        // truth, not the stale copy — the lock is shared with the API server
        // (and with PipelineService, which now does its own per-session
        // locking around every session write — see pipeline-service.ts) for
        // exactly this reason. This lock is released before Step 2 runs the
        // decided actions: those go through PipelineService methods that
        // acquire the SAME per-session lock themselves, and KeyedLock is not
        // re-entrant — nesting a second acquisition for this id inside this
        // one would deadlock.
        const planned = await this.deps.lock.withLock(review.id, async () => {
          const fresh = await this.deps.store.load(review.id);
          if (fresh.mode !== 'review' || TERMINAL_PHASES_BY_MODE.review.has(fresh.stageStatus) || !fresh.pr) {
            return null;
          }
          const pr = fresh.pr;
          const { stdout } = await this.deps.gh.run([
            'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', PR_VIEW_FIELDS,
          ]);
          const view = mapPrView(pr.repo, parsePrView(stdout));
          const source = sessions.find((s) => s.id === fresh.lineage.parentSessionId) ?? null;
          const { actions, skipped } = planReconciliation({ review: fresh, view, source, now: this.now() });
          return { fresh, source, actions, skipped };
        });
        if (planned === null) continue;
        const { fresh, source, actions, skipped } = planned;
        report.actions.push(...actions);
        report.skipped.push(...skipped);
        report.reconciled += 1;

        // Step 2, unlocked: apply the decided actions. Each of these
        // PipelineService calls acquires the per-session lock itself and
        // re-validates against fresh state before writing, so a concurrent
        // API action landing in this window is handled safely (the stale
        // plan's action simply fails/no-ops instead of corrupting anything),
        // never silently clobbered.
        for (const action of actions) {
          if (action.type === 'transition') {
            const targetMode = action.sessionId === fresh.id ? 'review' : source?.mode;
            if (targetMode && TERMINAL_PHASES_BY_MODE[targetMode].has(action.to)) {
              // Don't leave an agent running against a session about to
              // become terminal (its worktree may be reclaimed) — stop() is
              // a harmless no-op if nothing is actually running.
              await this.deps.pipeline.stop(action.sessionId);
            }
            await this.deps.pipeline.transition(action.sessionId, action.to);
          } else if (action.type === 'rereview') {
            try {
              await awaitRunStart(this.deps.events, action.sessionId, this.deps.pipeline.runRereview(action.sessionId));
            } catch (err) {
              // A claim that raced in between planning (unclaimed, so the
              // action was produced) and this unlocked apply is the same
              // situation planReconciliation skips — so it is a `skipped`
              // entry here too, never a report.errors one, or the tick would
              // file an error every pollIntervalMs for as long as the human
              // keeps the conversation open. Every OTHER failure is still an
              // error.
              if (err instanceof HumanTurnInProgressError) {
                report.skipped.push({ sessionId: action.sessionId, to: 'reviewing', why: CLAIMED_SKIP_REASON });
              } else {
                report.errors.push({ where: review.id, error: errorMessage(err) });
              }
            }
          }
        }
      } catch (err) {
        report.errors.push({ where: review.id, error: errorMessage(err) });
      }
    }

    await this.runPrBearingSessions(sessions, report);
    return report;
  }

  /**
   * The `respond`/`investigation` leg, on the review loop's discipline
   * exactly: one `gh pr view` per non-terminal PR-bearing session, planned
   * under the per-session lock against freshly loaded state, applied
   * unlocked through `PipelineService` (which takes the same lock itself —
   * KeyedLock is not re-entrant).
   */
  private async runPrBearingSessions(sessions: readonly Session[], report: TickReport): Promise<void> {
    const candidates = sessions.filter(
      (s): s is PrBearingSession =>
        (s.mode === 'respond' || s.mode === 'investigation') &&
        !TERMINAL_PHASES_BY_MODE[s.mode].has(s.stageStatus) &&
        s.pr !== null,
    );

    for (const candidate of candidates) {
      try {
        const planned = await this.deps.lock.withLock(candidate.id, async () => {
          const fresh = await this.deps.store.load(candidate.id);
          if (
            (fresh.mode !== 'respond' && fresh.mode !== 'investigation') ||
            TERMINAL_PHASES_BY_MODE[fresh.mode].has(fresh.stageStatus) ||
            fresh.pr === null
          ) {
            return null;
          }
          const pr = fresh.pr;
          const { stdout } = await this.deps.gh.run([
            'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', PR_VIEW_FIELDS,
          ]);
          const view = mapPrView(pr.repo, parsePrView(stdout));
          return { mode: fresh.mode, ...planPrSessionReconciliation({ session: fresh, view }) };
        });
        if (planned === null) continue;
        report.actions.push(...planned.actions);
        report.skipped.push(...planned.skipped);
        report.reconciled += 1;

        for (const action of planned.actions) {
          if (action.type !== 'transition') continue;
          if (TERMINAL_PHASES_BY_MODE[planned.mode].has(action.to)) {
            // Same reason as above: never leave an agent running against a
            // session whose worktree is about to be reclaimable.
            await this.deps.pipeline.stop(action.sessionId);
          }
          await this.deps.pipeline.transition(action.sessionId, action.to);
        }
      } catch (err) {
        report.errors.push({ where: candidate.id, error: errorMessage(err) });
      }
    }
  }
}
