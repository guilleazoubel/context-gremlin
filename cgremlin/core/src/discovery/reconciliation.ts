import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { CandidatePR, PRDiscoveryStrategy } from './pr-discovery-strategy';
import type { ReviewSessionFactory } from '../pipeline/review-session-factory';
import type { PipelineService } from '../pipeline/pipeline-service';
import type { DiscoveryConfig } from './discovery-config';
import type { ReviewSession, Session } from '../schema/session';
import { canTransition, type DevelopmentPhase, type ReviewPhase } from '../schema/pipeline';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';

export type ReconcileAction =
  | { type: 'transition'; sessionId: string; to: string; reason: string }
  | { type: 'rereview'; sessionId: string; reason: string }
  | { type: 'create-review'; candidate: CandidatePR }
  | { type: 'ignore-own'; candidate: CandidatePR };

export interface SkippedTransition {
  sessionId: string;
  to: string;
  why: string;
}

export interface PlanReconciliationInput {
  review: ReviewSession;
  view: ReturnType<typeof mapPrView>;
  source: Session | null;
}

export interface PlanReconciliationResult {
  actions: ReconcileAction[];
  skipped: SkippedTransition[];
}

const APPROVE_ELIGIBLE_REVIEW_PHASES: readonly ReviewPhase[] = ['queued', 'ready', 'changes_requested', 'failed'];
const REREVIEW_ELIGIBLE_REVIEW_PHASES: readonly ReviewPhase[] = ['ready', 'changes_requested'];
const MERGE_ELIGIBLE_DEVELOPMENT_PHASES: readonly DevelopmentPhase[] = ['pr_opened', 'superseded'];

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
  const { review, view, source } = input;
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
    actions.push({ type: 'rereview', sessionId: review.id, reason: 'new commits pushed since last review' });
  }

  return { actions, skipped };
}

export interface ReconciliationTickDeps {
  gh: GhRunner;
  store: SessionStore;
  strategy: PRDiscoveryStrategy;
  factory: ReviewSessionFactory;
  pipeline: PipelineService;
  events: EngineEvents;
  config: DiscoveryConfig;
}

export interface TickReport {
  reconciled: number;
  actions: ReconcileAction[];
  skipped: SkippedTransition[];
  created: string[];
  ignoredOwn: number;
  errors: { where: string; error: string }[];
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReconciliationTick {
  constructor(private readonly deps: ReconciliationTickDeps) {}

  async run(): Promise<TickReport> {
    const report: TickReport = {
      reconciled: 0,
      actions: [],
      skipped: [],
      created: [],
      ignoredOwn: 0,
      errors: [],
    };

    const sessions = await this.deps.store.list();
    const reviewSessions = sessions.filter(
      (s): s is ReviewSession =>
        s.mode === 'review' && !TERMINAL_PHASES_BY_MODE.review.has(s.stageStatus) && s.pr !== null,
    );

    for (const review of reviewSessions) {
      try {
        const pr = review.pr;
        if (!pr) continue;
        const { stdout } = await this.deps.gh.run([
          'pr', 'view', String(pr.number), '--repo', pr.repo, '--json', PR_VIEW_FIELDS,
        ]);
        const view = mapPrView(pr.repo, parsePrView(stdout));
        const source = sessions.find((s) => s.id === review.lineage.parentSessionId) ?? null;

        const { actions, skipped } = planReconciliation({ review, view, source });
        report.actions.push(...actions);
        report.skipped.push(...skipped);
        report.reconciled += 1;

        for (const action of actions) {
          if (action.type === 'transition') {
            await this.deps.pipeline.transition(action.sessionId, action.to);
          } else if (action.type === 'rereview') {
            let rereviewError: unknown;
            void this.deps.pipeline.runRereview(action.sessionId).catch((err) => {
              rereviewError = err;
            });
            await flush();
            if (rereviewError !== undefined) {
              report.errors.push({ where: review.id, error: errorMessage(rereviewError) });
            }
          }
        }
      } catch (err) {
        report.errors.push({ where: review.id, error: errorMessage(err) });
      }
    }

    try {
      const existingSessions = await this.deps.store.list();
      const candidates = await this.deps.strategy.poll(this.deps.config, { existingSessions });
      for (const { repo, error } of this.deps.strategy.lastErrors) {
        report.errors.push({ where: repo, error });
      }
      for (const candidate of candidates) {
        if (candidate.kind === 'own') {
          report.ignoredOwn += 1;
          continue;
        }
        try {
          const created = await this.deps.factory.createFromCandidate(candidate);
          report.created.push(created.id);
        } catch (err) {
          report.errors.push({
            where: `${candidate.repo}#${candidate.number}`,
            error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      report.errors.push({ where: 'strategy.poll', error: errorMessage(err) });
    }

    return report;
  }
}
