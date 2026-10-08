import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FeedbackLog } from '../../src/feedback/feedback-log';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';

const FEEDBACK = '/state/feedback.jsonl';
const DISMISSED_F2_ID = /^finding_dismissed:rev-1:f2:[0-9a-f]{12}$/;
const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));

function review(id: string, stageStatus: 'queued' | 'ready' = 'ready'): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus, agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 'T', author: 'bob' },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

function planReady(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'investigation', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'investigate/APP-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1', selfReview: false },
    stageStatus: 'plan_ready', agent: null, lastRun: null, pr: null, intent: 'investigate_only', driveToCompletion: false,
  };
}

function withFeedback(log?: (line: string) => void): PipelineHarness {
  return createHarness({ feedback: (fs) => new FeedbackLog(fs, FEEDBACK), ...(log ? { log } : {}) });
}

async function artifact(h: PipelineHarness, id: string, name: string, text: string): Promise<void> {
  await h.fs.mkdir(`${SESSIONS_DIR}/${id}`, { recursive: true });
  await h.fs.writeFile(`${SESSIONS_DIR}/${id}/${name}`, text);
}

describe('§20 — the engine captures dismissals and rejected verdicts', () => {
  it('releasing the conversation records each dismissed finding once, and reads no config file', async () => {
    const h = withFeedback();
    const reads: string[] = [];
    const realRead = h.fs.readFile.bind(h.fs);
    h.fs.readFile = async (p: string) => {
      reads.push(p);
      return realRead(p);
    };
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
    await h.service.releaseConversation('rev-1');
    await h.service.releaseConversation('rev-1');
    const records = await h.feedback!.list();
    expect(records.map((r) => r.kind)).toEqual(['finding_dismissed']);
    expect(records[0].id).toMatch(DISMISSED_F2_ID);
    expect(records[0].context).toMatchObject({ sessionId: 'rev-1', mode: 'review', pr: { repo: 'acme/app', number: 1 }, artifact: `${SESSIONS_DIR}/rev-1/REVIEW.md`, anchor: 'f2' });
    expect(reads.some((p) => p.endsWith('core.json') || p.endsWith('/config'))).toBe(false);
  });

  it('a review run records dismissals before the agent rewrites REVIEW.md, attributed to the run that wrote it', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1', 'queued'));
    const first = h.service.runReview('rev-1');
    await h.finishRun({ 'REVIEW.md': DISMISS_F2(REVIEW_CONTRACT_EXAMPLE) }, { code: 0, signal: null });
    await first;
    expect(await h.feedback!.list()).toEqual([]);
    const second = h.service.runReview('rev-1');
    await h.finishRun({ 'REVIEW.md': REVIEW_CONTRACT_EXAMPLE }, { code: 0, signal: null });
    await second;
    const records = await h.feedback!.list();
    expect(records).toHaveLength(1);
    expect(records[0].id).toMatch(DISMISSED_F2_ID);
    expect(records[0].producedBy).toEqual({ stage: 'review', runner: 'claude-code', model: null, effort: null });
  });

  it('a person approving a PR the review asked changes on, or dismissing a review, is recorded', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1'));
    await h.store.save(review('rev-2'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await artifact(h, 'rev-2', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await h.service.transition('rev-1', 'approved', { by: 'human' });
    await h.service.transition('rev-2', 'dismissed', { by: 'human' });
    expect((await h.feedback!.list()).map((r) => [r.kind, r.id])).toEqual([
      ['verdict_rejected', 'verdict_rejected:rev-1:REVIEW.md'],
      ['review_dismissed', 'review_dismissed:rev-2'],
    ]);
  });

  it('a person abandoning an investigation at plan_ready rejects its plan verdict', async () => {
    const h = withFeedback();
    await h.store.save(planReady('inv-1'));
    await artifact(h, 'inv-1', 'PLAN.md', '# plan');
    await h.service.transition('inv-1', 'abandoned', { by: 'human' });
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['verdict_rejected:inv-1:PLAN.md']);
  });

  it('a reconciliation dismissal records nothing — only a person’s API action is feedback', async () => {
    const h = withFeedback();
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: JSON.stringify({ ...baseView, number: 1, url: 'https://github.com/acme/app/pull/1', state: 'MERGED', mergedAt: '2026-10-09T00:00:00Z' }) });
    await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect((await h.store.load('rev-1')).stageStatus).toBe('dismissed');
    await h.store.save(review('rev-2'));
    await artifact(h, 'rev-2', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    await h.service.transition('rev-2', 'dismissed');
    expect(await h.feedback!.list()).toEqual([]);
  });

  it('a REVIEW.md past the 1 MB parse cap is read only up to the cap, with one log line', async () => {
    const logs: string[] = [];
    const h = withFeedback((line) => logs.push(line));
    await h.store.save(review('rev-1'));
    const filler = 'filler line that matches nothing\n'.repeat(40_000);
    const late = '<a id="f9"></a>\n### 9. a finding past the cap\n- **Severity:** 🔴 Critical\n- **Where:** `late.ts:1`\n- **Status:** 🔇 dismissed\n';
    const text = `${DISMISS_F2(REVIEW_CONTRACT_EXAMPLE)}\n${filler}${late}`;
    expect(text.length).toBeGreaterThan(1024 * 1024);
    await artifact(h, 'rev-1', 'REVIEW.md', text);
    await h.service.releaseConversation('rev-1');
    expect((await h.feedback!.list()).map((r) => r.context.anchor)).toEqual(['f2']);
    expect(logs).toEqual([expect.stringContaining('feedback capture for rev-1: REVIEW.md is larger than 1 MB')]);
  });

  it('a capture failure never blocks the transition it observes', async () => {
    const logs: string[] = [];
    const h = createHarness({
      log: (line) => logs.push(line),
      feedback: (fs) => {
        const log = new FeedbackLog(fs, FEEDBACK);
        log.appendOnce = async () => {
          throw new Error('disk full');
        };
        return log;
      },
    });
    await h.store.save(review('rev-1'));
    await artifact(h, 'rev-1', 'REVIEW.md', REVIEW_CONTRACT_EXAMPLE);
    const after = await h.service.transition('rev-1', 'approved', { by: 'human' });
    expect(after.stageStatus).toBe('approved');
    expect(logs).toEqual([expect.stringContaining('feedback capture for rev-1 failed: disk full')]);
  });
});
