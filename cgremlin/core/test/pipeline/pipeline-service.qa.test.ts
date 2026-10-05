import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import type { QaSession } from '../../src/schema/session';

/** 0c — the linked ticket loads, so the run passes the shared preflight's Jira half. */
const LOADED_TICKETS = {
  briefState: async (key: string) => ({
    kind: 'loaded' as const,
    ticket: { key, summary: 's', status: 'UAT', url: `https://jira.invalid/browse/${key}`, descriptionText: 'd', comments: [] },
  }),
  linking: 'configured' as const,
};

const WORKTREE = `${WORKTREES_DIR}/qa-app-HB-627`;
const CLEAN = { code: 0, signal: null } as const;

function qaMd(verdict: string): string {
  return `# QA Verification: HB-627 — thing\n**Verdict:** ${verdict}\n\n## QA Verdict\n- Verdict: ${verdict}\n- Blocking problems: 0\n`;
}

function qaSession(over: Partial<QaSession> = {}): QaSession {
  return {
    schemaVersion: 2,
    id: 'qa-app-HB-627',
    mode: 'qa',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: WORKTREE, branch: 'qa/HB-627-abc1234' },
    lineage: { pipelineId: 'qa-app-HB-627', parentSessionId: null, ticket: 'HB-627', selfReview: false },
    agent: null,
    lastRun: null,
    pr: {
      repo: 'acme/app',
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
      headSha: 'a'.repeat(40),
      reviewedSha: null,
      title: 'PR twelve',
      author: 'me-user',
    },
    stageStatus: 'queued',
    qa: { verifiedSha: null, verdict: null },
    ...over,
  } as QaSession;
}

async function seed(over: Partial<QaSession> = {}) {
  const h = createHarness({ tickets: LOADED_TICKETS });
  const session = qaSession(over);
  await h.store.save(session);
  return { h, session };
}

describe('PipelineService.runVerify', () => {
  it('refuses a non-qa session', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession({ repoUrl: 'https://github.com/o/r.git', ticket: 'ABC-1' });
    await expect(h.service.runVerify(dev.id)).rejects.toThrow('cannot run verify');
  });

  it('refuses a claimed session with HumanTurnInProgressError, before any environment work', async () => {
    const { h, session } = await seed();
    await h.store.save({
      ...session,
      agent: {
        runner: 'claude-code',
        resumeId: 'r',
        humanTurn: { claimedAt: FIXED_NOW().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' },
      },
    });
    await expect(h.service.runVerify(session.id)).rejects.toMatchObject({ name: 'HumanTurnInProgressError' });
  });

  it.each(['closed', 'abandoned', 'verifying'] as const)('refuses the non-runnable phase %s', async (stageStatus) => {
    const { h, session } = await seed({ stageStatus });
    await expect(h.service.runVerify(session.id)).rejects.toThrow('cannot run verify');
  });

  it('moves queued -> verifying in preRun and writes the brief and the prompt', async () => {
    const { h, session } = await seed();
    const run = h.service.runVerify(session.id);
    await flush();
    expect((await h.store.load(session.id)).stageStatus).toBe('verifying');
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`);
    expect(brief).toContain('# QA VERIFICATION — HB-627');
    expect(h.runner.getPrompts(h.runner.lastHandle()).join('\n')).toContain('/cgremlin:qa-verify');
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy — all good') }, CLEAN);
    await run;
  });

  it('a ready verdict lands the phase, the verdict and the verified sha in ONE save', async () => {
    const { h, session } = await seed();
    const saves: string[] = [];
    const originalSave = h.store.save.bind(h.store);
    h.store.save = async (s) => {
      if (s.id === session.id && s.mode === 'qa' && s.stageStatus === 'ready') {
        saves.push(`${s.stageStatus}:${s.qa.verdict}:${s.qa.verifiedSha ?? 'null'}`);
      }
      return originalSave(s);
    };
    const run = h.service.runVerify(session.id);
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy — all good') }, CLEAN);
    const after = await run;
    expect(after.stageStatus).toBe('ready');
    expect(after.mode === 'qa' && after.qa).toEqual({ verifiedSha: 'a'.repeat(40), verdict: 'ready' });
    expect(saves).toEqual([`ready:ready:${'a'.repeat(40)}`]);
  });

  it('R79 — a 🚧 Blocked report lands phase not_ready with verdict blocked', async () => {
    const { h, session } = await seed();
    const run = h.service.runVerify(session.id);
    await h.finishRun({ 'QA.md': qaMd('🚧 Blocked — QA unreachable') }, CLEAN);
    const after = await run;
    expect(after.stageStatus).toBe('not_ready');
    expect(after.mode === 'qa' && after.qa.verdict).toBe('blocked');
  });

  it('a run that leaves no parsable verdict fails the session', async () => {
    const { h, session } = await seed();
    const run = h.service.runVerify(session.id);
    await h.finishRun({ 'QA.md': '# QA\nnothing\n' }, CLEAN);
    expect((await run).stageStatus).toBe('failed');
  });

  it('a re-verification archives the previous QA.md to QA-v1.md', async () => {
    const { h, session } = await seed({ stageStatus: 'not_ready' });
    await h.fs.writeFile(`${SESSIONS_DIR}/${session.id}/QA.md`, qaMd('❌ Not ready'));
    const run = h.service.runVerify(session.id);
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy') }, CLEAN);
    await run;
    expect(await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/QA-v1.md`)).toContain('❌ Not ready');
  });
});

describe('PipelineService.prepareQaSession (R73)', () => {
  it('writes BRIEF.md and starts NO run, leaving the phase at queued', async () => {
    const { h, session } = await seed();
    const after = await h.service.prepareQaSession(session.id);
    expect(after.stageStatus).toBe('queued');
    expect(after.lastRun).toBe(null);
    expect(after.agent).toBe(null);
    // No agent was ever started — the fake has no handle to hand back.
    expect(() => h.runner.lastHandle()).toThrow('no handle has been started');
    expect(await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`)).toContain('# QA VERIFICATION — HB-627');
  });

  it('recomposes BRIEF.md on a second call', async () => {
    const { h, session } = await seed();
    await h.service.prepareQaSession(session.id);
    await h.fs.writeFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`, 'stale');
    await h.service.prepareQaSession(session.id);
    expect(await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`)).toContain('# QA VERIFICATION');
  });

  it('is refused while a run is in flight', async () => {
    const { h, session } = await seed();
    const run = h.service.runVerify(session.id);
    await flush();
    await expect(h.service.prepareQaSession(session.id)).rejects.toMatchObject({ name: 'RunInProgressError' });
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy') }, CLEAN);
    await run;
  });

  it('refuses a non-qa session', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession({ repoUrl: 'https://github.com/o/r.git', ticket: 'ABC-1' });
    await expect(h.service.prepareQaSession(dev.id)).rejects.toThrow('is not a qa session');
  });
});

describe('E8 — the boot sweep', () => {
  it('moves a verifying session the engine died under to failed, which is runnable', async () => {
    const { h, session } = await seed({ stageStatus: 'verifying' });
    const swept = await h.service.failStaleRuns();
    expect(swept).toEqual({ count: 1, sessionIds: [session.id] });
    expect((await h.store.load(session.id)).stageStatus).toBe('failed');
    // and it can be started again straight away
    const run = h.service.runVerify(session.id);
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy') }, CLEAN);
    expect((await run).stageStatus).toBe('ready');
  });

  it('leaves a verifying session whose run IS live alone', async () => {
    const { h, session } = await seed();
    const run = h.service.runVerify(session.id);
    await flush();
    expect(await h.service.failStaleRuns()).toEqual({ count: 0, sessionIds: [] });
    expect((await h.store.load(session.id)).stageStatus).toBe('verifying');
    await h.finishRun({ 'QA.md': qaMd('✅ Ready to deploy') }, CLEAN);
    await run;
  });

  it('touches no other mode or phase', async () => {
    const { h } = await seed({ stageStatus: 'ready' });
    expect(await h.service.failStaleRuns()).toEqual({ count: 0, sessionIds: [] });
  });
});
