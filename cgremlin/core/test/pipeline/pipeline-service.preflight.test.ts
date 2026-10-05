import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, type HarnessOptions, type PipelineHarness } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import type { PipelineServiceDeps } from '../../src/pipeline/pipeline-service';
import type { TicketBriefState } from '../../src/pipeline/prompts';
import { migrateV1ToV2, type QaSession, type RespondSession, type Session } from '../../src/schema/session';

type Tickets = NonNullable<PipelineServiceDeps['tickets']>;

const NOT_LOADED_AUTH: TicketBriefState = { kind: 'not_loaded', key: 'HB-627', reason: 'auth' };
const GH_DOWN = async () => ({ ok: false as const, detail: 'You are not logged into any GitHub hosts.' });

function tickets(state: TicketBriefState): Tickets {
  return { briefState: async () => state, linking: 'configured' };
}

function reviewSession(ticket: string | null, stageStatus: 'queued' | 'ready'): Session {
  const id = 'pr-app-12-x';
  const review = migrateV1ToV2({
    schemaVersion: 1 as const,
    id,
    mode: 'review' as const,
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-12' },
    lineage: { pipelineId: id, parentSessionId: null, ticket },
    stageStatus,
  });
  if (review.mode !== 'review') throw new Error('mode changed');
  review.pr = { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'aaa', reviewedSha: 'aaa', title: 'T', author: 'bob' };
  return review;
}

function respondSession(ticket: string | null): RespondSession {
  return {
    schemaVersion: 2, id: 'respond-app-12', mode: 'respond', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/respond-app-12`, branch: 'feature/HB-627-x' },
    lineage: { pipelineId: 'respond-app-12', parentSessionId: null, ticket },
    agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'a'.repeat(40), reviewedSha: null, title: 'P', author: 'me' },
    stageStatus: 'triaging',
  } as RespondSession;
}

function qaSession(ticket: string | null): QaSession {
  return {
    schemaVersion: 2, id: 'qa-app-HB-627', mode: 'qa', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: `${WORKTREES_DIR}/qa-app-HB-627`, branch: 'qa/HB-627-abc1234' },
    lineage: { pipelineId: 'qa-app-HB-627', parentSessionId: null, ticket, selfReview: false },
    agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'a'.repeat(40), reviewedSha: null, title: 'PR twelve', author: 'me-user' },
    stageStatus: 'queued', qa: { verifiedSha: null, verdict: null },
  } as QaSession;
}

function queueRereviewGit(h: PipelineHarness): void {
  h.git.queueResponse({ stdout: 'aaa', stderr: '' }); // rev-parse HEAD
  h.git.queueResponse({ stdout: '', stderr: '' }); // fetch
  h.git.queueResponse({ stdout: 'bbb', stderr: '' }); // rev-parse FETCH_HEAD
  h.git.queueResponse({ stdout: '', stderr: '' }); // reset --hard
  h.git.queueResponse({ stdout: 'abc1234 fix', stderr: '' }); // log
  h.git.queueResponse({ stdout: ' 1 file changed', stderr: '' }); // diff --stat
}

interface Case {
  name: 'runReview' | 'runRereview' | 'runRespond' | 'runVerify';
  session: (ticket: string | null) => Session;
  /** Anything the method needs queued before it is called (the rereview git work). */
  prime?: (h: PipelineHarness) => void;
}

const CASES: Case[] = [
  { name: 'runReview', session: (t) => reviewSession(t, 'queued') },
  { name: 'runRereview', session: (t) => reviewSession(t, 'ready'), prime: queueRereviewGit },
  { name: 'runRespond', session: respondSession },
  { name: 'runVerify', session: qaSession },
];

async function setup(c: Case, ticket: string | null, opts: HarnessOptions) {
  const h = createHarness(opts);
  const session = c.session(ticket);
  await h.store.save(session);
  c.prime?.(h);
  const run = vi.spyOn(h.stageRunner, 'run');
  const dir = `${SESSIONS_DIR}/${session.id}`;
  return { h, session, run, dir };
}

describe.each(CASES)('0c preflight — $name', (c) => {
  it('(i) a linked ticket that cannot be loaded: no agent, needs-input, a Jira note', async () => {
    const { h, session, run, dir } = await setup(c, 'HB-627', { tickets: tickets(NOT_LOADED_AUTH) });
    const returned = await h.service[c.name](session.id);
    expect(returned.id).toBe(session.id);
    expect(run).not.toHaveBeenCalled();
    expect(await h.fs.readFile(`${dir}/AGENT_STATE`)).toBe('needs-input');
    const note = await h.fs.readFile(`${dir}/AGENT_NOTE`);
    expect(note).toContain('Jira HB-');
    expect(note).toContain('auth error');
    // Nothing moved: the phase is what it was, and no brief was written.
    expect((await h.store.load(session.id)).stageStatus).toBe(session.stageStatus);
    expect(await h.fs.exists(`${dir}/BRIEF.md`)).toBe(false);
  });

  it('(ii) the same with skipJiraCheck: the agent runs once and the brief says SKIPPED by the user', async () => {
    const { h, session, run, dir } = await setup(c, 'HB-627', { tickets: tickets(NOT_LOADED_AUTH) });
    void h.service[c.name](session.id, { skipJiraCheck: true }).catch(() => undefined);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const brief = await h.fs.readFile(`${dir}/BRIEF.md`);
    expect(brief).toContain('HB-627: SKIPPED by the user');
    expect(brief).not.toContain('HB-627: NOT LOADED');
    expect(await h.fs.readFile(`${dir}/AGENT_STATE`)).toBe('working');
  });

  it('(iii) gh failing blocks even with skipJiraCheck', async () => {
    const { h, session, run, dir } = await setup(c, 'HB-627', { tickets: tickets(NOT_LOADED_AUTH), ghAuthOk: GH_DOWN });
    await h.service[c.name](session.id, { skipJiraCheck: true });
    expect(run).not.toHaveBeenCalled();
    expect(await h.fs.readFile(`${dir}/AGENT_STATE`)).toBe('needs-input');
    expect(await h.fs.readFile(`${dir}/AGENT_NOTE`)).toContain('GitHub is not usable');
  });

  it('(iv) no ticket + gh ok: runs, and the brief says none linked', async () => {
    const { h, session, run, dir } = await setup(c, null, { tickets: tickets(NOT_LOADED_AUTH) });
    void h.service[c.name](session.id).catch(() => undefined);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await h.fs.readFile(`${dir}/BRIEF.md`)).toContain('## Ticket — none linked');
  });

  it('runStage passes the override through', async () => {
    const stage = { runReview: 'review', runRereview: 'rereview', runRespond: 'respond', runVerify: 'verify' } as const;
    const { h, session, run, dir } = await setup(c, 'HB-627', { tickets: tickets(NOT_LOADED_AUTH) });
    void h.service.runStage(session.id, stage[c.name], { skipJiraCheck: true }).catch(() => undefined);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await h.fs.readFile(`${dir}/BRIEF.md`)).toContain('SKIPPED by the user');
  });
});

describe('0c preflight — details', () => {
  it('a blocked rereview does no git work and writes no RE-REVIEW.md', async () => {
    const h = createHarness({ tickets: tickets(NOT_LOADED_AUTH) });
    const session = reviewSession('HB-627', 'ready');
    await h.store.save(session);
    const gitCalls = vi.spyOn(h.git, 'run');
    await h.service.runRereview(session.id);
    expect(gitCalls).not.toHaveBeenCalled();
    expect(await h.fs.exists(`${SESSIONS_DIR}/${session.id}/RE-REVIEW.md`)).toBe(false);
  });

  it('(v) the automatic re-review (ReconciliationTick -> runRereview) is blocked exactly like (i)', async () => {
    const h = createHarness({ tickets: tickets(NOT_LOADED_AUTH) });
    const gh = new FakeGhRunner();
    const id = 'pr-app-5-x';
    const v2 = migrateV1ToV2({
      schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}` },
      lineage: { pipelineId: id, parentSessionId: null, ticket: 'HB-627' },
      stageStatus: 'ready',
    });
    if (v2.mode !== 'review') throw new Error('mode changed');
    await h.store.save({
      ...v2,
      pr: { repo: 'acme/app', number: 5, url: 'https://github.com/acme/app/pull/5', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob' },
    });
    const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));
    gh.queueResponse({ stdout: JSON.stringify({ ...baseView, state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', headRefOid: 'c'.repeat(40) }) });
    const run = vi.spyOn(h.stageRunner, 'run');

    const tick = new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock });
    const report = await tick.run();

    expect(report.actions).toEqual([{ type: 'rereview', sessionId: id, reason: expect.any(String) }]);
    expect(report.errors).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(await h.fs.readFile(`${SESSIONS_DIR}/${id}/AGENT_STATE`)).toBe('needs-input');
    const note = await h.fs.readFile(`${SESSIONS_DIR}/${id}/AGENT_NOTE`);
    expect(note).toContain('Jira HB-');
    expect(note).toContain('auth error');
    expect((await h.store.load(id)).stageStatus).toBe('ready');
  });

  it('a block while a run is live refuses as RunInProgress and leaves that run\'s state alone', async () => {
    const h = createHarness({ tickets: tickets({ kind: 'loaded', ticket: { key: 'HB-627', summary: 's', status: 'UAT', url: 'u', descriptionText: 'd', comments: [] } }) });
    const session = reviewSession('HB-627', 'queued');
    await h.store.save(session);
    void h.service.runReview(session.id).catch(() => undefined);
    await flush();
    const dir = `${SESSIONS_DIR}/${session.id}`;
    expect(await h.fs.readFile(`${dir}/AGENT_STATE`)).toBe('working');

    const blocked = createHarnessSharing(h, tickets(NOT_LOADED_AUTH));
    await expect(blocked.runReview(session.id)).rejects.toMatchObject({ name: 'RunInProgressError' });
    expect(await h.fs.readFile(`${dir}/AGENT_STATE`)).toBe('working');
  });

  it('a repeated block does not rewrite an identical needs-input (no mtime churn on every tick)', async () => {
    const h = createHarness({ tickets: tickets(NOT_LOADED_AUTH) });
    const session = reviewSession('HB-627', 'queued');
    await h.store.save(session);
    await h.service.runReview(session.id);
    const writes = vi.spyOn(h.fs, 'writeFile');
    await h.service.runReview(session.id);
    expect(writes).not.toHaveBeenCalled();
  });

  it('the review sentinel: a ticket the stub fails for never leaks anything but the reason', async () => {
    const SENTINEL = 'SENTINEL-TOKEN-123';
    const h = createHarness({
      tickets: tickets(NOT_LOADED_AUTH),
      ghAuthOk: async () => ({ ok: false, detail: `token ghp_${'A'.repeat(36)} for ${SENTINEL}\n${SENTINEL}` }),
    });
    const session = reviewSession('HB-627', 'queued');
    await h.store.save(session);
    await h.service.runReview(session.id, { skipJiraCheck: true });
    const note = await h.fs.readFile(`${SESSIONS_DIR}/${session.id}/AGENT_NOTE`);
    expect(note).not.toContain('ghp_');
    expect(note.split('\n')).toHaveLength(1);
  });
});

/** A second PipelineService over the SAME harness parts (store, fs, runner, lock), with a different tickets port. */
function createHarnessSharing(h: PipelineHarness, t: Tickets) {
  // Reaching into the harness's own service is the least invasive way to share
  // every collaborator: the deps object is private, so rebuild from the parts.
  const Ctor = h.service.constructor as new (deps: PipelineServiceDeps) => PipelineHarness['service'];
  return new Ctor({
    store: h.store,
    workspace: h.workspace,
    stageRunner: h.stageRunner,
    fs: h.fs,
    git: h.git,
    events: h.events,
    config: { sessionsDir: SESSIONS_DIR, worktreesDir: WORKTREES_DIR, defaultBaseRef: 'origin/main', runnerKind: 'claude-code', humanTurnTtlMs: 600_000 },
    lock: h.lock,
    tickets: t,
    ghAuthOk: async () => ({ ok: true }),
  });
}
