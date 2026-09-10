import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { PipelineService } from '../pipeline/pipeline-service';
import type { ReviewSession, Session } from '../schema/session';
import { canTransition, type DevelopmentPhase, type ReviewPhase } from '../schema/pipeline';
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

function canApplyTransition(mode: 'review' | 'development', from: string, to: string): boolean {
  return mode === 'review'
    ? canTransition('review', from as ReviewPhase, to as ReviewPhase)
    : canTransition('development', from as DevelopmentPhase, to as DevelopmentPhase);
}

function proposeTransition(
  actions: ReconcileAction[],
  skipped: SkippedTransition[],
  mode: 'review' | 'development',
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
    proposeTransition(actions, skipped, 'review', review.id, review.stageStatus, 'dismissed', 'PR merged');
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
    proposeTransition(actions, skipped, 'review', review.id, review.stageStatus, 'dismissed', 'PR closed without merging');
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

    return report;
  }
}
