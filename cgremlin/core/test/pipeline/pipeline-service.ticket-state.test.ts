import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import type { PipelineService, PipelineServiceDeps } from '../../src/pipeline/pipeline-service';
import type { TicketBriefState } from '../../src/pipeline/prompts';
import type { QaSession } from '../../src/schema/session';

type Tickets = NonNullable<PipelineServiceDeps['tickets']>;

/** `ticketState` is private; Task 3 makes it observable in every brief. Until then it is reached directly. */
function ticketState(service: PipelineService, key: string | null): Promise<TicketBriefState> {
  return (service as unknown as { ticketState(k: string | null): Promise<TicketBriefState> }).ticketState(key);
}

const TICKET = {
  key: 'HB-627',
  summary: 'Do the thing',
  status: 'UAT',
  url: 'https://jira.invalid/browse/HB-627',
  descriptionText: 'AC1: the block renders.',
  comments: [],
};

function tickets(state: TicketBriefState, linking: Tickets['linking'] = 'configured'): Tickets {
  return { briefState: async () => state, linking };
}

describe('0c — PipelineService.ticketState', () => {
  it('no key is none, carrying the engine\'s linking state', async () => {
    const configured = createHarness({ tickets: tickets({ kind: 'loaded', ticket: TICKET }, 'configured') });
    expect(await ticketState(configured.service, null)).toEqual({ kind: 'none', linking: 'configured' });
    const disabled = createHarness({ tickets: tickets({ kind: 'loaded', ticket: TICKET }, 'disabled') });
    expect(await ticketState(disabled.service, null)).toEqual({ kind: 'none', linking: 'disabled' });
  });

  it('a key returns briefState verbatim — including the failure reason', async () => {
    for (const reason of ['auth', 'unavailable', 'not_configured'] as const) {
      const state: TicketBriefState = { kind: 'not_loaded', key: 'HB-627', reason };
      const h = createHarness({ tickets: tickets(state) });
      expect(await ticketState(h.service, 'HB-627')).toEqual(state);
    }
    const h = createHarness({ tickets: tickets({ kind: 'loaded', ticket: TICKET }) });
    expect(await ticketState(h.service, 'HB-627')).toEqual({ kind: 'loaded', ticket: TICKET });
  });

  it('with no tickets dep: no key is none/disabled; a key is not_loaded/not_configured', async () => {
    const h = createHarness();
    expect(await ticketState(h.service, null)).toEqual({ kind: 'none', linking: 'disabled' });
    expect(await ticketState(h.service, 'HB-627')).toEqual({ kind: 'not_loaded', key: 'HB-627', reason: 'not_configured' });
  });

  it('a loaded state still renders the ticket into the brief (call sites unchanged until Task 3)', async () => {
    const h = createHarness({ tickets: tickets({ kind: 'loaded', ticket: TICKET }) });
    const session = {
      schemaVersion: 2,
      id: 'qa-app-HB-627',
      mode: 'qa',
      createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/qa-app-HB-627`, branch: 'qa/HB-627-abc1234' },
      lineage: { pipelineId: 'qa-app-HB-627', parentSessionId: null, ticket: 'HB-627', selfReview: false },
      agent: null,
      lastRun: null,
      pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'a'.repeat(40), reviewedSha: null, title: 'PR twelve', author: 'me-user' },
      stageStatus: 'queued',
      qa: { verifiedSha: null, verdict: null },
    } as QaSession;
    await h.store.save(session);
    await h.service.prepareQaSession(session.id);
    await flush();
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/BRIEF.md`);
    expect(brief).toContain('## Ticket HB-627 — Do the thing');
    expect(brief).toContain('AC1: the block renders.');
  });
});
