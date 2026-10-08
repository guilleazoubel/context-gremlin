import { createHash } from 'node:crypto';
import type { Session } from '../schema/session';
import type { StageName } from '../schema/stage';
import type { RunRecord } from '../pipeline/run-records';
import { redactSecrets } from '../config/core-config';
import type { FeedbackRecord } from './feedback-log';
import { parseReviewFindings, parseReviewVerdict, type ReviewVerdict } from './review-findings';

/** Feedback text is data an agent wrote: one line, redacted, capped. */
export const FEEDBACK_TEXT_CAP = 300;

export interface CaptureContext {
  session: Session;
  sessionDir: string;
  /** ISO time of the observation. */
  at: string;
  producedBy: FeedbackRecord['producedBy'];
}

const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: '✅ Approve',
  request_changes: '🔄 Request changes',
  comment: '💬 Comment',
};

/** The Status SAYS resolved (`✅ resolved`) — `unresolved` / `open (not resolved)` are still open. */
const RESOLVED = /^\W*resolved\b/iu;

function clean(text: string): string {
  const oneLine = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return oneLine.length > FEEDBACK_TEXT_CAP ? `${oneLine.slice(0, FEEDBACK_TEXT_CAP)}…` : oneLine;
}

/**
 * I4 / S2-27 — 12 hex of sha256 over the normalized title and location: what makes a finding
 * the same finding when a fresh review restarts its anchors at f1.
 */
export function findingKey(title: string | null, where: string | null): string {
  const norm = (value: string | null): string => (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(`${norm(title)}\n${norm(where)}`).digest('hex').slice(0, 12);
}

function contextOf(ctx: CaptureContext, artifact: string, anchor: string | null): FeedbackRecord['context'] {
  const s = ctx.session;
  return {
    sessionId: s.id,
    mode: s.mode,
    stage: ctx.producedBy?.stage ?? null,
    ticket: s.lineage.ticket,
    pr: s.pr === null ? null : { repo: s.pr.repo, number: s.pr.number },
    artifact,
    anchor,
  };
}

/** The newest run of one of `stages` in a session's runs.jsonl: who produced the artifact. */
export function producedByFrom(runs: readonly RunRecord[], stages: readonly StageName[]): FeedbackRecord['producedBy'] {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (stages.includes(run.stage)) return { stage: run.stage, runner: run.runner, model: run.model, effort: run.effort };
  }
  return null;
}

/** §20 — one record per finding marked dismissed; the id makes each finding count once (S2-27). */
export function dismissalRecords(ctx: CaptureContext, reviewText: string): FeedbackRecord[] {
  const artifact = `${ctx.sessionDir}/REVIEW.md`;
  return parseReviewFindings(reviewText)
    .filter((f) => f.dismissed)
    .map((f) => {
      const where = f.severity === null ? '' : ` (${f.severity}${f.where === null ? '' : `, ${f.where}`})`;
      return {
        v: 1 as const,
        id: `finding_dismissed:${ctx.session.id}:${f.anchor}:${findingKey(f.title, f.where)}`,
        at: ctx.at,
        source: 'auto' as const,
        kind: 'finding_dismissed' as const,
        text: clean(`Dismissed finding ${f.number}${where}: ${f.title ?? '(untitled)'}`),
        context: contextOf(ctx, artifact, f.anchor),
        producedBy: ctx.producedBy,
        detail: {
          number: f.number,
          severity: f.severity === null ? null : clean(f.severity),
          where: f.where === null ? null : clean(f.where),
          title: f.title === null ? null : clean(f.title),
        },
      };
    });
}

/**
 * §20 / S2-18 — a PERSON's API action against an engine verdict. Only called for transitions
 * marked `by: 'human'`; the reconciliation tick's transitions never reach here. Today only
 * `/approve-pr` exercises this from the extension; the rest fire from raw API calls (S2-28).
 */
export function humanTransitionRecords(
  ctx: CaptureContext,
  from: string,
  to: string,
  texts: { review: string | null; plan: string | null },
): FeedbackRecord[] {
  const s = ctx.session;
  const out: FeedbackRecord[] = [];
  if (s.mode === 'review' && texts.review !== null) {
    const verdict = parseReviewVerdict(texts.review);
    const open = parseReviewFindings(texts.review).filter((f) => !f.dismissed && !RESOLVED.test(f.status ?? '')).length;
    const findingsText = `${open} open finding${open === 1 ? '' : 's'}`;
    const artifact = `${ctx.sessionDir}/REVIEW.md`;
    if (to === 'approved' && verdict === 'request_changes') {
      out.push({
        v: 1, id: `verdict_rejected:${s.id}:REVIEW.md`, at: ctx.at, source: 'auto', kind: 'verdict_rejected',
        text: clean(`Approved the PR although the review said ${VERDICT_LABEL[verdict]} (${findingsText})`),
        context: contextOf(ctx, artifact, null), producedBy: ctx.producedBy,
        detail: { verdict, action: 'approved', openFindings: open, from },
      });
    }
    if (to === 'dismissed') {
      out.push({
        v: 1, id: `review_dismissed:${s.id}`, at: ctx.at, source: 'auto', kind: 'review_dismissed',
        text: clean(`Dismissed the review (verdict ${verdict === null ? 'none' : VERDICT_LABEL[verdict]}, ${findingsText})`),
        context: contextOf(ctx, artifact, null), producedBy: ctx.producedBy,
        detail: { verdict, action: 'dismissed', openFindings: open, from },
      });
    }
  }
  if (s.mode === 'investigation' && from === 'plan_ready' && to === 'abandoned' && texts.plan !== null) {
    out.push({
      v: 1, id: `verdict_rejected:${s.id}:PLAN.md`, at: ctx.at, source: 'auto', kind: 'verdict_rejected',
      text: 'Abandoned the investigation at plan_ready: the plan the PM and Principal Engineer reviewers approved was not taken',
      context: contextOf(ctx, `${ctx.sessionDir}/PLAN.md`, null), producedBy: ctx.producedBy,
      detail: { verdict: 'approved', action: 'abandoned', from },
    });
  }
  return out;
}
