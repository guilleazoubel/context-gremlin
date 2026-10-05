import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import type { RespondSession, Session } from '../../src/schema/session';
import type { StageName } from '../../src/schema/stage';

/** 0c — the linked ticket loads, so the run passes the shared preflight's Jira half. */
const LOADED_TICKETS = {
  briefState: async (key: string) => ({
    kind: 'loaded' as const,
    ticket: { key, summary: 's', status: 'UAT', url: `https://jira.invalid/browse/${key}`, descriptionText: 'd', comments: [] },
  }),
  linking: 'configured' as const,
};

const WORKTREE = `${WORKTREES_DIR}/respond-app-12`;

function respondSession(over: Partial<RespondSession> = {}): RespondSession {
  return {
    schemaVersion: 2,
    id: 'respond-app-12',
    mode: 'respond',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: WORKTREE, branch: 'feature/HB-627-x' },
    lineage: { pipelineId: 'respond-app-12', parentSessionId: null, ticket: 'HB-627' },
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
    stageStatus: 'triaging',
    ...over,
  } as RespondSession;
}

async function seed(over: Partial<RespondSession> = {}) {
  const h = createHarness({ tickets: LOADED_TICKETS });
  const session = respondSession(over);
  await h.store.save(session);
  return { h, session };
}

describe('PipelineService.runRespond (R56)', () => {
  it('refuses a non-respond session with UnsupportedStageError', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession({ repoUrl: 'https://github.com/o/r.git', ticket: 'ABC-1' });
    await expect(h.service.runRespond(dev.id)).rejects.toThrow('cannot run respond');
  });

  it('refuses a claimed session with HumanTurnInProgressError', async () => {
    const { h, session } = await seed();
    await h.store.save({
      ...session,
      agent: {
        runner: 'claude-code',
        resumeId: 'r',
        humanTurn: { claimedAt: FIXED_NOW().toISOString(), expiresAt: '2999-01-01T00:00:00.000Z' },
      },
    });
    await expect(h.service.runRespond(session.id)).rejects.toMatchObject({ name: 'HumanTurnInProgressError' });
  });

  it('refuses a phase outside RESPOND_RUNNABLE_FROM, checked on the FRESH in-lock load', async () => {
    const { h, session } = await seed({ stageStatus: 'closed' });
    await expect(h.service.runRespond(session.id)).rejects.toThrow('cannot run respond');

    // the race the fresh load closes: the phase moves between the pre-lock
    // read and the run, and the run must still refuse.
    const { h: h2, session: s2 } = await seed();
    const originalLoad = h2.store.load.bind(h2.store);
    let first = true;
    h2.store.load = async (id: string) => {
      const loaded = await originalLoad(id);
      if (first && id === s2.id) {
        first = false;
        await h2.store.save({ ...(loaded as RespondSession), stageStatus: 'abandoned' });
      }
      return loaded;
    };
    await expect(h2.service.runRespond(s2.id)).rejects.toThrow('cannot run respond');
  });

  it('composes the respond brief, runs the `respond` stage and transitions triaging -> addressing', async () => {
    const { h, session } = await seed();
    const stages: StageName[] = [];
    h.events.on('run.started', (e) => stages.push(e.stage));
    const finished: StageName[] = [];
    h.events.on('run.finished', (e) => finished.push(e.stage));

    const running = h.service.runRespond(session.id);
    await h.finishRun({ 'COMMENTS.md': '# COMMENTS' }, { code: 0, signal: null });
    const after = (await running) as Session;

    expect(stages).toEqual(['respond']);
    expect(finished).toEqual(['respond']);
    expect(after.stageStatus).toBe('addressing');
    expect(after.lastRun?.stage).toBe('respond');
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`);
    expect(brief).toContain('# RESPOND — acme/app#12');
    expect(brief).toContain('COMMENTS.md');
  });

  it('re-running from `addressing` does not transition back', async () => {
    const { h, session } = await seed({ stageStatus: 'addressing' });
    const running = h.service.runRespond(session.id);
    await h.finishRun({}, { code: 0, signal: null });
    const after = (await running) as Session;
    expect(after.stageStatus).toBe('addressing');
  });

  it('runStage dispatches the respond stage', async () => {
    const { h, session } = await seed();
    const running = h.service.runStage(session.id, 'respond');
    await h.finishRun({}, { code: 0, signal: null });
    await running;
    expect((await h.store.load(session.id)).lastRun?.stage).toBe('respond');
  });

  it('the respond context reaches the brief when the host supplies one', async () => {
    const h = createHarness({
      tickets: LOADED_TICKETS,
      respondContext: async () => ({
        threads: [
          {
            id: 'T1',
            isResolved: false,
            isOutdated: false,
            path: 'a.ts',
            line: 4,
            truncated: false,
            comments: [
              { author: 'jane', body: 'please fix the guard', createdAt: '2026-09-09T00:00:00Z', url: 'u1' },
            ],
          },
        ],
        reviews: [{ author: 'jane', state: 'CHANGES_REQUESTED', body: 'see inline', submittedAt: '2026-09-09T00:00:00Z' }],
        reviewDecision: 'CHANGES_REQUESTED',
        failingChecks: [{ name: 'build', detailsUrl: 'https://ci/build' }],
        changedFiles: 3,
        additions: 10,
        deletions: 2,
      }),
    });
    const session = respondSession();
    await h.store.save(session);
    const running = h.service.runRespond(session.id);
    await flush();
    await h.finishRun({}, { code: 0, signal: null });
    await running;
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`);
    expect(brief).toContain('please fix the guard');
    expect(brief).toContain('CHANGES_REQUESTED');
    expect(brief).toContain('build — https://ci/build');
    expect(brief).toContain('3 files changed, +10/−2');
  });
});
