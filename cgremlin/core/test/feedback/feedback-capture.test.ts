import { describe, expect, it } from 'vitest';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import {
  dismissalRecords,
  findingKey,
  humanTransitionRecords,
  producedByFrom,
  type CaptureContext,
} from '../../src/feedback/feedback-capture';
import type { RunRecord } from '../../src/pipeline/run-records';
import type { Session } from '../../src/schema/session';

const AT = '2026-10-08T12:00:00.000Z';
const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const DISMISS_F1 = (text: string): string => text.replace(/(<a id="f1"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');

const review: Session = {
  schemaVersion: 2, id: 'rev-1', mode: 'review', createdAt: AT,
  workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/w/rev-1', branch: 'pr-1' },
  lineage: { pipelineId: 'rev-1', parentSessionId: null, ticket: 'APP-1', selfReview: false },
  stageStatus: 'ready', agent: null, lastRun: null,
  pr: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1', headSha: null, reviewedSha: null, title: 'T', author: 'bob' },
  reviewVersion: 0, lastRereviewSummary: null,
};
const investigation: Session = {
  schemaVersion: 2, id: 'inv-1', mode: 'investigation', createdAt: AT,
  workspace: { repoUrl: 'git@github.com:acme/app.git' },
  lineage: { pipelineId: 'inv-1', parentSessionId: null, ticket: 'APP-1', selfReview: false },
  stageStatus: 'plan_ready', agent: null, lastRun: null, pr: null, intent: 'investigate_only', driveToCompletion: false,
};
const BY = { stage: 'review' as const, runner: 'claude-code' as const, model: 'opus', effort: 'high' as const };
const ctx = (session: Session): CaptureContext => ({ session, sessionDir: `/sessions/${session.id}`, at: AT, producedBy: BY });

describe('feedback capture rules (§20)', () => {
  it('one record per dismissed finding, keyed by session, anchor and the finding itself', () => {
    const records = dismissalRecords(ctx(review), DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
    expect(records).toEqual([
      {
        v: 1, id: `finding_dismissed:rev-1:f2:${findingKey('<plain-English title>', 'ui/list.tsx:40')}`, at: AT, source: 'auto', kind: 'finding_dismissed',
        text: 'Dismissed finding 2 (🔧 Maintainability, ui/list.tsx:40): <plain-English title>',
        context: {
          sessionId: 'rev-1', mode: 'review', stage: 'review', ticket: 'APP-1', pr: { repo: 'acme/app', number: 1 },
          artifact: '/sessions/rev-1/REVIEW.md', anchor: 'f2',
        },
        producedBy: BY,
        detail: { number: 2, severity: '🔧 Maintainability', where: 'ui/list.tsx:40', title: '<plain-English title>' },
      },
    ]);
    expect(records[0].id).toMatch(/^finding_dismissed:rev-1:f2:[0-9a-f]{12}$/);
    expect(dismissalRecords(ctx(review), REVIEW_CONTRACT_EXAMPLE)).toEqual([]);
  });

  it('I4 — a review that restarts its anchors does not swallow a different dismissed finding', () => {
    const first = DISMISS_F1(REVIEW_CONTRACT_EXAMPLE);
    const rerun = DISMISS_F1(REVIEW_CONTRACT_EXAMPLE.replace('### 1. <plain-English title of the problem>', '### 1. a different problem'));
    const [a] = dismissalRecords(ctx(review), first);
    const [b] = dismissalRecords(ctx(review), rerun);
    const [again] = dismissalRecords(ctx(review), first);
    expect(a.context.anchor).toBe('f1');
    expect(b.context.anchor).toBe('f1');
    expect(a.id).not.toBe(b.id);
    expect(again.id).toBe(a.id);
    expect(findingKey('  Same  Title ', 'a.ts:1')).toBe(findingKey('same title', 'a.ts:1'));
  });

  it('feedback text is one line, redacted and capped', () => {
    const nasty = DISMISS_F2(
      REVIEW_CONTRACT_EXAMPLE.replace('### 2. <plain-English title>', `### 2. leaks Authorization: Bearer abcdefghijklmnop and ${'x'.repeat(400)}`),
    );
    const [record] = dismissalRecords(ctx(review), nasty);
    expect(record.text).not.toContain('abcdefghijklmnop');
    expect(record.text).toContain('<redacted>');
    expect(record.text).not.toContain('\n');
    expect(record.text.length).toBeLessThanOrEqual(301);
    expect(String(record.detail.title)).not.toContain('abcdefghijklmnop');
  });

  it('approving a PR the review asked changes on is a rejected verdict; approving an approved one is not', () => {
    const rejected = humanTransitionRecords(ctx(review), 'ready', 'approved', { review: REVIEW_CONTRACT_EXAMPLE, plan: null });
    expect(rejected.map((r) => [r.kind, r.id, r.detail])).toEqual([
      ['verdict_rejected', 'verdict_rejected:rev-1:REVIEW.md', { verdict: 'request_changes', action: 'approved', openFindings: 4, from: 'ready' }],
    ]);
    const approve = REVIEW_CONTRACT_EXAMPLE.replace('**Verdict:** 🔄 Request changes', '**Verdict:** ✅ Approve');
    expect(humanTransitionRecords(ctx(review), 'ready', 'approved', { review: approve, plan: null })).toEqual([]);
  });

  it('a person dismissing a review with a REVIEW.md is review_dismissed; with none it is nothing', () => {
    expect(humanTransitionRecords(ctx(review), 'ready', 'dismissed', { review: REVIEW_CONTRACT_EXAMPLE, plan: null }).map((r) => r.id)).toEqual([
      'review_dismissed:rev-1',
    ]);
    expect(humanTransitionRecords(ctx(review), 'ready', 'dismissed', { review: null, plan: null })).toEqual([]);
  });

  it('abandoning an investigation at plan_ready with a PLAN.md rejects the plan verdict; from planning it does not', () => {
    expect(humanTransitionRecords(ctx(investigation), 'plan_ready', 'abandoned', { review: null, plan: '# plan' }).map((r) => r.id)).toEqual([
      'verdict_rejected:inv-1:PLAN.md',
    ]);
    expect(humanTransitionRecords(ctx(investigation), 'planning', 'abandoned', { review: null, plan: '# plan' })).toEqual([]);
    expect(humanTransitionRecords(ctx(investigation), 'plan_ready', 'abandoned', { review: null, plan: null })).toEqual([]);
  });

  it('producedByFrom picks the newest run of the given stages', () => {
    const run = (stage: RunRecord['stage'], model: string): RunRecord => ({
      v: 1, sessionId: 'rev-1', stage, runner: 'claude-code', model, effort: null, routeSource: 'legacy', fresh: false, resumed: false,
      startedAt: AT, finishedAt: AT, tokens: null, tokensSource: null, costUsd: null, modelUsage: null, limitEvents: [],
      outcome: 'succeeded', stopReason: null, error: null, interrupted: false,
    });
    expect(producedByFrom([run('review', 'a'), run('rereview', 'b'), run('respond', 'c')], ['review', 'rereview'])).toEqual({
      stage: 'rereview', runner: 'claude-code', model: 'b', effort: null,
    });
    expect(producedByFrom([run('respond', 'c')], ['review'])).toBeNull();
  });
});
