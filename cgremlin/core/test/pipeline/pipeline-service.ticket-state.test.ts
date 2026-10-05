import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import type { PipelineServiceDeps } from '../../src/pipeline/pipeline-service';
import type { TicketBriefState } from '../../src/pipeline/prompts';
import { migrateV1ToV2, type QaSession, type RespondSession } from '../../src/schema/session';

type Tickets = NonNullable<PipelineServiceDeps['tickets']>;

const TICKET = {
  key: 'HB-627',
  summary: 'Do the thing',
  status: 'UAT',
  url: 'https://jira.invalid/browse/HB-627',
  descriptionText: 'AC1: the block renders.',
  comments: [],
};

const NOT_LOADED_AUTH: TicketBriefState = { kind: 'not_loaded', key: 'HB-627', reason: 'auth' };

/** Tickets double that records every key the engine asks for. */
function spy(state: TicketBriefState, linking: Tickets['linking'] = 'configured'): { deps: Tickets; keys: string[] } {
  const keys: string[] = [];
  return { deps: { briefState: async (k) => { keys.push(k); return state; }, linking }, keys };
}

const brief = (h: PipelineHarness, id: string): Promise<string> => h.fs.readFile(`${SESSIONS_DIR}/${id}/BRIEF.md`);

function reviewSession(ticket: string | null): ReturnType<typeof migrateV1ToV2> {
  const id = 'pr-app-12-x';
  const review = migrateV1ToV2({
    schemaVersion: 1 as const,
    id,
    mode: 'review' as const,
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'pr-12' },
    lineage: { pipelineId: id, parentSessionId: null, ticket },
    stageStatus: 'queued' as const,
  });
  if (review.mode !== 'review') throw new Error('mode changed');
  review.pr = { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'aaa', reviewedSha: null, title: 'T', author: 'bob' };
  return review;
}

describe('0c — every run method hands its brief the ticket state (via the public API)', () => {
  it('findings: asks for the session ticket and renders the failure reason', async () => {
    const t = spy(NOT_LOADED_AUTH);
    const h = createHarness({ tickets: t.deps });
    const inv = await createInvestigation(h.service, { ticket: 'HB-627' });
    void h.service.runFindings(inv.id).catch(() => undefined);
    await flush();
    expect(t.keys).toEqual(['HB-627']);
    expect(await brief(h, inv.id)).toContain('## Ticket — HB-627: NOT LOADED (auth error)');
  });

  it('findings with no ticket: none, carrying the linking state (configured and disabled)', async () => {
    for (const [linking, text] of [['configured', '## Ticket — none linked'], ['disabled', 'Jira linking is not configured']] as const) {
      const t = spy(NOT_LOADED_AUTH, linking);
      const h = createHarness({ tickets: t.deps });
      const inv = await createInvestigation(h.service, { ticket: null });
      void h.service.runFindings(inv.id).catch(() => undefined);
      await flush();
      expect(t.keys).toEqual([]);
      expect(await brief(h, inv.id)).toContain(text);
    }
  });

  it('with no tickets dep: a named ticket is NOT LOADED (not configured)', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { ticket: 'HB-627' });
    void h.service.runFindings(inv.id).catch(() => undefined);
    await flush();
    expect(await brief(h, inv.id)).toContain('## Ticket — HB-627: NOT LOADED (not configured)');
  });

  it('develop: asks for the session ticket', async () => {
    const t = spy({ kind: 'loaded', ticket: TICKET });
    const h = createHarness({ tickets: t.deps });
    const dev = await h.service.createDevelopmentSession({ repoUrl: 'https://github.com/o/r.git', ticket: 'HB-627' });
    void h.service.runStage(dev.id, 'develop').catch(() => undefined);
    await flush();
    expect(t.keys).toEqual(['HB-627']);
    expect(await brief(h, dev.id)).toContain('AC1: the block renders.');
  });

  it('review: asks for session.lineage.ticket, and says so when there is none', async () => {
    const t = spy(NOT_LOADED_AUTH);
    const h = createHarness({ tickets: t.deps });
    const review = reviewSession('HB-627');
    await h.store.save(review);
    void h.service.runReview(review.id).catch(() => undefined);
    await flush();
    expect(t.keys).toEqual(['HB-627']);
    expect(await brief(h, review.id)).toContain('## Ticket — HB-627: NOT LOADED (auth error)');

    const none = createHarness({ tickets: spy(NOT_LOADED_AUTH, 'disabled').deps });
    const bare = reviewSession(null);
    await none.store.save(bare);
    void none.service.runReview(bare.id).catch(() => undefined);
    await flush();
    expect(await brief(none, bare.id)).toContain('Jira linking is not configured');
  });

  it('respond: asks for the session ticket, inside the untrusted-pr-data section', async () => {
    const t = spy({ kind: 'loaded', ticket: TICKET });
    const h = createHarness({ tickets: t.deps });
    const session = {
      schemaVersion: 2, id: 'respond-app-12', mode: 'respond', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/respond-app-12`, branch: 'feature/HB-627-x' },
      lineage: { pipelineId: 'respond-app-12', parentSessionId: null, ticket: 'HB-627' },
      agent: null, lastRun: null,
      pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'a'.repeat(40), reviewedSha: null, title: 'P', author: 'me' },
      stageStatus: 'triaging',
    } as RespondSession;
    await h.store.save(session);
    void h.service.runRespond(session.id).catch(() => undefined);
    await flush();
    expect(t.keys).toEqual(['HB-627']);
    const text = await brief(h, session.id);
    expect(text.indexOf('## Ticket HB-627')).toBeGreaterThan(text.indexOf('<untrusted-pr-data>'));
  });

  it('qa: asks for the session ticket and renders the loaded ticket', async () => {
    const t = spy({ kind: 'loaded', ticket: TICKET });
    const h = createHarness({ tickets: t.deps });
    const session = {
      schemaVersion: 2, id: 'qa-app-HB-627', mode: 'qa', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/qa-app-HB-627`, branch: 'qa/HB-627-abc1234' },
      lineage: { pipelineId: 'qa-app-HB-627', parentSessionId: null, ticket: 'HB-627', selfReview: false },
      agent: null, lastRun: null,
      pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'a'.repeat(40), reviewedSha: null, title: 'PR twelve', author: 'me-user' },
      stageStatus: 'queued', qa: { verifiedSha: null, verdict: null },
    } as QaSession;
    await h.store.save(session);
    await h.service.prepareQaSession(session.id);
    await flush();
    expect(t.keys).toEqual(['HB-627']);
    const text = await brief(h, session.id);
    expect(text).toContain('## Ticket HB-627 — Do the thing');
    expect(text).toContain('AC1: the block renders.');
  });
});
