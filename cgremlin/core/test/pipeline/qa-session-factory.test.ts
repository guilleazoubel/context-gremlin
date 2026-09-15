import { describe, expect, it } from 'vitest';
import { PrNotMergedError, PR_QA_VIEW_FIELDS, QaSessionFactory } from '../../src/pipeline/qa-session-factory';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { createHarness, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';

const REPO = 'acme/app';
const MERGE_SHA = 'abc1234def567890abc1234def567890abc12345';

function prViewJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    title: 'PR twelve',
    author: { login: 'alice' },
    headRefName: 'feature/HB-627-x',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    url: `https://github.com/${REPO}/pull/12`,
    state: 'MERGED',
    isDraft: false,
    reviewDecision: 'APPROVED',
    mergedAt: '2026-09-14T09:00:00.000Z',
    closedAt: '2026-09-14T09:00:00.000Z',
    latestReviews: [],
    statusCheckRollup: [],
    mergeCommit: { oid: MERGE_SHA },
    files: [{ path: 'src/a.tsx', additions: 10, deletions: 1 }],
    ...over,
  });
}

function makeFactory() {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const createCalls: Array<Record<string, unknown>> = [];
  const workspace = {
    ...h.workspace,
    createWorkspace: async (params: Record<string, unknown>) => {
      createCalls.push(params);
      return h.workspace.createWorkspace(params as never);
    },
  } as unknown as typeof h.workspace;
  const factory = new QaSessionFactory({
    gh,
    store: h.store,
    workspace,
    events: h.events,
    worktreesDir: WORKTREES_DIR,
    defaultBaseRef: 'origin/main',
    now: FIXED_NOW,
    newId: (t, s) => `qa-${s.split('/')[1]}-${t}`,
  });
  return { h, gh, factory, createCalls };
}

describe('QaSessionFactory', () => {
  it('asks gh for the merge commit and the file list', async () => {
    const { gh, factory } = makeFactory();
    gh.queueResponse({ stdout: prViewJson() });
    await factory.createFromMergedPr('HB-627', REPO, 12);
    expect(gh.calls[0]).toEqual(['pr', 'view', '12', '--repo', REPO, '--json', PR_QA_VIEW_FIELDS]);
    expect(PR_QA_VIEW_FIELDS).toContain('mergeCommit');
    expect(PR_QA_VIEW_FIELDS).toContain('files');
  });

  it('checks out the MERGE COMMIT on a qa/<TICKET>-<sha7> branch, under the qa guard', async () => {
    const { gh, factory, createCalls } = makeFactory();
    gh.queueResponse({ stdout: prViewJson() });
    const session = await factory.createFromMergedPr('HB-627', REPO, 12);
    expect(createCalls[0]).toMatchObject({
      baseRef: MERGE_SHA,
      branchName: 'qa/HB-627-abc1234',
      mode: 'qa',
      worktreePath: `${WORKTREES_DIR}/qa-app-HB-627`,
    });
    expect(session.stageStatus).toBe('queued');
    expect(session.qa).toEqual({ verifiedSha: null, verdict: null });
    expect(session.lineage.ticket).toBe('HB-627');
    expect(session.pr?.headSha).toBe(MERGE_SHA);
  });

  it('refuses an unmerged PR BEFORE creating any workspace', async () => {
    const { gh, factory, createCalls, h } = makeFactory();
    gh.queueResponse({ stdout: prViewJson({ state: 'OPEN', mergeCommit: null, mergedAt: null }) });
    await expect(factory.createFromMergedPr('HB-627', REPO, 12)).rejects.toThrow(PrNotMergedError);
    expect(createCalls).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  it('refuses a closed-not-merged PR the same way', async () => {
    const { gh, factory } = makeFactory();
    gh.queueResponse({ stdout: prViewJson({ state: 'CLOSED', mergeCommit: null }) });
    await expect(factory.createFromMergedPr('HB-627', REPO, 12)).rejects.toThrow('is CLOSED, not merged');
  });

  it('existingFor finds a live QA session for the ticket and ignores a terminal one', async () => {
    const { gh, factory } = makeFactory();
    gh.queueResponse({ stdout: prViewJson() });
    const session = await factory.createFromMergedPr('HB-627', REPO, 12);
    expect((await factory.existingFor('HB-627'))?.id).toBe(session.id);
    expect(await factory.existingFor('HB-999')).toBe(null);
  });

  it('a closed QA session no longer counts as live', async () => {
    const { gh, factory, h } = makeFactory();
    gh.queueResponse({ stdout: prViewJson() });
    const session = await factory.createFromMergedPr('HB-627', REPO, 12);
    await h.store.save({ ...session, stageStatus: 'closed' });
    expect(await factory.existingFor('HB-627')).toBe(null);
  });
});
