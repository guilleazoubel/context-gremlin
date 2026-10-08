import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { InvalidSessionIdError } from '../../src/engine/session-store';
import { GhCommandError } from '../../src/gh/gh-runner';
import { UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import type { GhRunner } from '../../src/gh/gh-runner';
import { PR_LIST_FIELDS } from '../../src/gh/pr-view';
import type { CreateWorkspaceParams } from '../../src/workspace/workspace-manager';
import type { Session } from '../../src/schema/session';

const APPROVED_PLAN = `## Review Status
- PM: ✅ Approved — solves exactly the ticket
- Principal Engineer: ✅ Approved — mechanism checks out
`;

const DEV_INPUT = { repoUrl: 'https://github.com/o/r.git', ticket: 'ABC-1' };

function recordCreateWorkspace(h: ReturnType<typeof createHarness>): CreateWorkspaceParams[] {
  const calls: CreateWorkspaceParams[] = [];
  const real = h.workspace.createWorkspace.bind(h.workspace);
  h.workspace.createWorkspace = async (params: CreateWorkspaceParams) => {
    calls.push(params);
    return real(params);
  };
  return calls;
}

describe('PipelineService — createDevelopmentSession (R16)', () => {
  it('creates a self-rooted development session at active on feature/<ticket>, and emits session.created once', async () => {
    const h = createHarness();
    const created: Session[] = [];
    h.events.on('session.created', (e) => created.push(e.session));

    const dev = await h.service.createDevelopmentSession(DEV_INPUT);

    expect(dev.id).toMatch(/^dev-o-r-ABC-1-\d{8}-\d{6}$/);
    expect(dev.mode).toBe('development');
    expect(dev.stageStatus).toBe('active');
    expect(dev.schemaVersion).toBe(2);
    expect(dev.agent).toBeNull();
    expect(dev.lastRun).toBeNull();
    expect(dev.pr).toBeNull();
    expect(dev.lineage).toEqual({ pipelineId: dev.id, parentSessionId: null, ticket: 'ABC-1', selfReview: false });
    expect(dev.workspace.branch).toBe('feature/ABC-1');
    expect(dev.workspace.worktreePath).toBe(`${WORKTREES_DIR}/${dev.id}`);
    expect(dev.workspace.repoUrl).toBe(DEV_INPUT.repoUrl);

    expect(created).toEqual([dev]);
    expect(await h.store.load(dev.id)).toEqual(dev);
  });

  it('with ticket null branches on feature/<id>', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession({ ...DEV_INPUT, ticket: null });
    expect(dev.id).toContain('no-ticket');
    expect(dev.lineage.ticket).toBeNull();
    expect(dev.workspace.branch).toBe(`feature/${dev.id}`);
  });

  it('creates the worktree in development mode, so the worktree denies gh pr review but allows git push', async () => {
    const h = createHarness();
    const calls = recordCreateWorkspace(h);

    const dev = await h.service.createDevelopmentSession(DEV_INPUT);

    expect(calls).toEqual([
      {
        repoUrl: DEV_INPUT.repoUrl,
        worktreePath: `${WORKTREES_DIR}/${dev.id}`,
        branchName: 'feature/ABC-1',
        baseRef: 'origin/main',
        mode: 'development',
      },
    ]);

    const settings = JSON.parse(
      await h.fs.readFile(`${WORKTREES_DIR}/${dev.id}/.claude/settings.local.json`),
    ) as { permissions: { deny?: string[]; allow?: string[] } };
    expect(settings.permissions.deny).toContain('Bash(gh pr review:*)');
    expect(settings.permissions.deny).not.toContain('Bash(git push:*)');
    expect(settings.permissions.deny).not.toContain('Bash(gh pr create:*)');
  });

  it('defaults baseRef to config.defaultBaseRef and forwards an explicit one', async () => {
    const h = createHarness();
    const calls = recordCreateWorkspace(h);
    await h.service.createDevelopmentSession(DEV_INPUT);
    expect(calls[0].baseRef).toBe('origin/main');
    await h.service.createDevelopmentSession({ ...DEV_INPUT, ticket: 'ABC-2', baseRef: 'origin/release' });
    expect(calls[1].baseRef).toBe('origin/release');
  });

  it.each(['a/b', '..', 'x..y'])('rejects a ticket that would smuggle a path (%s) before touching git', async (ticket) => {
    const h = createHarness();
    await expect(h.service.createDevelopmentSession({ ...DEV_INPUT, ticket })).rejects.toBeInstanceOf(
      InvalidSessionIdError,
    );
    expect(h.git.calls).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  it('rolls the workspace back and rethrows the original error when store.save fails', async () => {
    const h = createHarness();
    const removals: Array<[string, string, string]> = [];
    h.workspace.removeWorkspace = async (repoUrl: string, worktreePath: string, branchName: string) => {
      removals.push([repoUrl, worktreePath, branchName]);
    };
    h.store.save = async () => {
      throw new Error('disk full');
    };

    await expect(h.service.createDevelopmentSession(DEV_INPUT)).rejects.toThrow('disk full');
    expect(removals).toHaveLength(1);
    expect(removals[0][0]).toBe(DEV_INPUT.repoUrl);
    expect(removals[0][1]).toMatch(new RegExp(`^${WORKTREES_DIR}/dev-o-r-ABC-1-`));
    expect(removals[0][2]).toBe('feature/ABC-1');
  });

  it('MG-A11 direct-dev-session-starts-nothing', async () => {
    const h = createHarness();
    const runEvents: string[] = [];
    h.events.on('run.started', () => runEvents.push('run.started'));
    h.events.on('run.finished', () => runEvents.push('run.finished'));

    const dev = await h.service.createDevelopmentSession(DEV_INPUT);

    // Nothing was started: no agent handle exists at all.
    expect(() => h.runner.lastHandle()).toThrow();
    expect(runEvents).toEqual([]);

    // The explicit run is what starts the single agent turn, and it hits the
    // PLAN GATE because this session has no PLAN.md.
    const p = h.service.runStage(dev.id, 'develop');
    await flush();
    expect(h.runner.lastHandle().id).toBe('fake-agent-1');
    const brief = await h.fs.readFile(`${SESSIONS_DIR}/${dev.id}/BRIEF.md`);
    expect(brief).toContain('**PLAN GATE — pause.**');
    expect(brief).not.toContain('No plan re-gate');

    await h.finishRun({ 'DEVELOPMENT.md': '# Development plan\n' }, { code: 0, signal: null });
    await p;
    expect(runEvents).toEqual(['run.started', 'run.finished']);
  });

  it('MG-A11 (regression half): promote() still auto-starts runDevelop', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development', driveToCompletion: false });
    const p = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause' }, { code: 0, signal: null });
    await h.finishRun({ 'PLAN.md': APPROVED_PLAN }, { code: 0, signal: null });
    await p;
    await h.service.approvePlan(inv.id);

    const promotePromise = h.service.promote(inv.id);
    await flush();
    const devHandle = h.runner.lastHandle();
    const devId = h.runner.getContext(devHandle).sessionId;
    expect(devId).not.toBe(inv.id);

    h.runner.emitExit(devHandle, { code: 0, signal: null });
    const { development } = await promotePromise;
    expect(development.id).toBe(devId);
    expect(development.lastRun?.stage).toBe('develop');
  });
});

describe('R91 — a develop run records its draft PR', () => {
  const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));
  const prView = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ...baseView, number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'feature/ABC-1', author: { login: 'me', is_bot: false },
      state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null, ...overrides,
    });

  async function runDevelopWith(h: ReturnType<typeof createHarness>, id: string, files: Record<string, string>, code = 0) {
    const p = h.service.runDevelop(id);
    await h.finishRun(files, { code, signal: null });
    return p;
  }

  /** Every save of `id` that carries a PR: adoption must be exactly one, already complete. */
  function countPrSaves(h: ReturnType<typeof createHarness>, id: string): Session[] {
    const saved: Session[] = [];
    const real = h.store.save.bind(h.store);
    h.store.save = async (session: Session) => {
      if (session.id === id && session.pr !== null) saved.push(session);
      return real(session);
    };
    return saved;
  }

  const NOT_DRAFT_NOTE = 'PR #7 is open for review, not a draft — opening a PR for review needs your approval (R112)';
  const tickOf = (h: ReturnType<typeof createHarness>, gh: GhRunner) =>
    new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock });

  it('records the draft PR and moves active -> pr_opened in one save', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const transitions: string[] = [];
    h.events.on('session.transitioned', (e) => transitions.push(`${e.from}->${e.to}`));
    const prSaves = countPrSaves(h, dev.id);
    gh.queueResponse({ stdout: prView() });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7\n' });
    expect(prSaves).toEqual([after]);
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.pr).toMatchObject({ repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', reviewedSha: null, author: 'me' });
    expect(transitions).toEqual(['active->pr_opened']);
    expect(await h.store.load(dev.id)).toEqual(after);
  });

  it('a failed develop run that already opened its PR still records it', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView() });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' }, 1);
    expect(after.lastRun?.outcome).toBe('failed');
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.pr?.number).toBe(7);
  });

  it('regression pin: without gh wired the session stays active with no PR (today)', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
  });

  it('gh missing: stays active with no PR, the run is not failed, and one log line says why', async () => {
    const gh = new FakeGhRunner();
    const logs: string[] = [];
    const h = createHarness({ gh, log: (line) => logs.push(line) });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse(new GhCommandError(['pr', 'list'], null, 'spawn gh ENOENT'));
    const after = await runDevelopWith(h, dev.id, {});
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
    expect(after.lastRun).toMatchObject({ outcome: 'succeeded', error: null });
    expect(logs).toEqual([expect.stringContaining(`PR detection for ${dev.id}: none adopted`)]);
  });

  it('a stale PR_URL pointing at a closed PR leaves the session active', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView({ state: 'CLOSED', closedAt: '2026-10-07T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('active');
    expect(after.pr).toBeNull();
  });

  it('a PR opened for review (not a draft) is recorded, and lastRun says it needed approval', async () => {
    const gh = new FakeGhRunner();
    const logs: string[] = [];
    const h = createHarness({ gh, log: (line) => logs.push(line) });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const prSaves = countPrSaves(h, dev.id);
    gh.queueResponse({ stdout: prView({ isDraft: false }) });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.lastRun?.error).toBe(NOT_DRAFT_NOTE);
    expect(after.pr?.openedForReview).toBe(true);
    // I2 — the flag, the PR and the transition are ONE save, not a save and a later patch.
    expect(prSaves).toEqual([after]);
    expect(logs).toEqual([expect.stringContaining(NOT_DRAFT_NOTE)]);
  });

  it('I2 — tick adoption of a non-draft PR with no run at all: flagged on the PR and logged, no run invented', async () => {
    const gh = new FakeGhRunner();
    const logs: string[] = [];
    const h = createHarness({ gh, log: (line) => logs.push(line) });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.fs.writeFile(`${SESSIONS_DIR}/${dev.id}/PR_URL`, 'https://github.com/o/r/pull/7');
    const prSaves = countPrSaves(h, dev.id);
    gh.queueResponse({ stdout: prView({ isDraft: false }) });
    const report = await tickOf(h, gh).run();
    expect(report.errors).toEqual([]);
    const after = await h.store.load(dev.id);
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.lastRun).toBeNull();
    expect(after.pr?.openedForReview).toBe(true);
    expect(prSaves).toEqual([after]);
    expect(logs).toEqual([expect.stringContaining(NOT_DRAFT_NOTE)]);
  });

  it('I2 — tick adoption leaves an older, unrelated lastRun exactly as it was; the flag is on the PR', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const older = {
      stage: 'develop' as const, startedAt: '2026-09-01T10:00:00.000Z', finishedAt: '2026-09-01T10:30:00.000Z',
      exitCode: 0, signal: null, outcome: 'succeeded' as const, error: null,
    };
    await h.store.save({ ...(await h.store.load(dev.id)), lastRun: older });
    await h.fs.writeFile(`${SESSIONS_DIR}/${dev.id}/PR_URL`, 'https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: prView({ isDraft: false }) });
    await tickOf(h, gh).run();
    const after = await h.store.load(dev.id);
    expect(after.stageStatus).toBe('pr_opened');
    expect(after.lastRun).toEqual(older);
    expect(after.pr?.openedForReview).toBe(true);
  });

  it('I2 — a run started right after a non-draft adoption does not lose the flag', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.fs.writeFile(`${SESSIONS_DIR}/${dev.id}/PR_URL`, 'https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: prView({ isDraft: false }) });
    await tickOf(h, gh).run();
    const again = await runDevelopWith(h, dev.id, {});
    expect(again.stageStatus).toBe('pr_opened');
    expect(again.lastRun).toMatchObject({ stage: 'develop', outcome: 'succeeded' });
    expect(again.pr?.openedForReview).toBe(true);
    expect((await h.store.load(dev.id)).pr?.openedForReview).toBe(true);
  });

  it('a draft adoption carries no flag', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView() });
    const after = await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(after.pr?.openedForReview).toBeUndefined();
    expect(after.lastRun?.error).toBeNull();
  });

  it('I3 — the same tick miss is logged once, a changed reason again, and every develop run still logs its own', async () => {
    const gh = new FakeGhRunner();
    const logs: string[] = [];
    const h = createHarness({ gh, log: (line) => logs.push(line) });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const misses = () => logs.filter((line) => line.startsWith(`PR detection for ${dev.id}: none adopted`));
    for (let i = 0; i < 3; i += 1) {
      gh.queueResponse({ stdout: '[]' });
      await tickOf(h, gh).run();
    }
    expect(gh.attempts).toHaveLength(3);
    expect(misses()).toHaveLength(1);
    const two = [
      { number: 9, url: 'https://github.com/o/r/pull/9', author: { login: 'me' }, isDraft: true, reviewDecision: '',
        headRefOid: 'b'.repeat(40), headRefName: 'feature/ABC-1', baseRefName: 'main', title: 't', updatedAt: '2026-10-08T12:00:00Z' },
      { number: 10, url: 'https://github.com/o/r/pull/10', author: { login: 'me' }, isDraft: true, reviewDecision: '',
        headRefOid: 'c'.repeat(40), headRefName: 'feature/ABC-1', baseRefName: 'main', title: 't', updatedAt: '2026-10-08T12:00:00Z' },
    ];
    gh.queueResponse({ stdout: JSON.stringify(two) });
    await tickOf(h, gh).run();
    gh.queueResponse({ stdout: JSON.stringify(two) });
    await tickOf(h, gh).run();
    expect(misses()).toHaveLength(2);
    expect(misses()[1]).toContain('not guessing');
    gh.queueResponse({ stdout: '[]' });
    await runDevelopWith(h, dev.id, {});
    gh.queueResponse({ stdout: '[]' });
    await runDevelopWith(h, dev.id, {});
    expect(misses()).toHaveLength(4);
  });

  it('M1 — a run that starts while detection is out does not get the PR saved under it', async () => {
    let started: Promise<Session> | null = null;
    let devId = '';
    // eslint-disable-next-line prefer-const -- assigned after the gh that closes over it
    let wired: ReturnType<typeof createHarness>;
    const listOne = JSON.stringify([{
      number: 9, url: 'https://github.com/o/r/pull/9', author: { login: 'me' }, isDraft: true, reviewDecision: '',
      headRefOid: 'b'.repeat(40), headRefName: 'feature/ABC-1', baseRefName: 'main', title: 't', updatedAt: '2026-10-08T12:00:00Z',
    }]);
    const gh: GhRunner = {
      run: async (args) => {
        expect(args.slice(0, 2)).toEqual(['pr', 'list']);
        if (started === null) {
          // The window between the unlocked detection and the locked save: a develop run starts.
          started = wired.service.runDevelop(devId);
          await flush();
        }
        return { stdout: listOne, stderr: '' };
      },
    };
    wired = createHarness({ gh, log: () => undefined });
    const dev = await wired.service.createDevelopmentSession(DEV_INPUT);
    devId = dev.id;
    const during = await wired.service.adoptDevelopmentPr(dev.id);
    expect(started).not.toBeNull();
    expect(wired.service.runLivenessOf(await wired.store.load(dev.id))).toBe('live');
    expect(during.stageStatus).toBe('active');
    expect(during.pr).toBeNull();
    // The run's own post-run detection adopts it once the run is over.
    wired.runner.emitExit(wired.runner.lastHandle(), { code: 0, signal: null });
    expect((await started!).stageStatus).toBe('pr_opened');
  });

  it('M4 — with gh wired, a session that already has a PR or has no branch costs no adoption gh call', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const withPr = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.store.save({
      ...(await h.store.load(withPr.id)),
      pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', headSha: null, reviewedSha: null, title: null, author: 'me' },
    });
    const noBranch = await h.service.createDevelopmentSession({ ...DEV_INPUT, ticket: 'ABC-2' });
    const loaded = await h.store.load(noBranch.id);
    await h.store.save({ ...loaded, workspace: { repoUrl: loaded.workspace.repoUrl } });
    await h.service.adoptDevelopmentPr(withPr.id);
    await h.service.adoptDevelopmentPr(noBranch.id);
    expect(gh.attempts).toEqual([]);
    // The tick: the PR-bearing leg views the recorded PR; the adoption leg asks nothing.
    gh.queueResponse({ stdout: prView() });
    await tickOf(h, gh).run();
    expect(gh.attempts.map((a) => a.slice(0, 2))).toEqual([['pr', 'view']]);
    expect(gh.attempts.flat()).not.toContain(PR_LIST_FIELDS);
    expect((await h.store.load(noBranch.id)).stageStatus).toBe('active');
  });

  it('S2-15 — runDevelop is refused from superseded', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.service.transition(dev.id, 'pr_opened');
    await h.service.transition(dev.id, 'superseded');
    await expect(h.service.runDevelop(dev.id)).rejects.toBeInstanceOf(UnsupportedStageError);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('runDevelop runs again from pr_opened (a fix round) and does not look the PR up again', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    gh.queueResponse({ stdout: prView() });
    await runDevelopWith(h, dev.id, { PR_URL: 'https://github.com/o/r/pull/7' });
    expect(gh.calls).toHaveLength(1);
    const again = await runDevelopWith(h, dev.id, {});
    expect(again.stageStatus).toBe('pr_opened');
    expect(again.lastRun?.outcome).toBe('succeeded');
    expect(gh.calls).toHaveLength(1);
  });

  it('regression pin: runDevelop is refused once the session is merged', async () => {
    const h = createHarness();
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    await h.service.transition(dev.id, 'merged');
    await expect(h.service.runDevelop(dev.id)).rejects.toBeInstanceOf(UnsupportedStageError);
  });

  it('I1 — a PR opened before an engine restart is adopted on the next tick', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    // The engine died mid-run: the file still says `running`, nothing holds the run, and the
    // agent had already written PR_URL.
    await h.store.save({
      ...(await h.store.load(dev.id)),
      lastRun: { stage: 'develop', startedAt: '2026-09-04T11:00:00.000Z', finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null },
    });
    await h.fs.writeFile(`${SESSIONS_DIR}/${dev.id}/PR_URL`, 'https://github.com/o/r/pull/7\n');
    expect((await h.service.failStaleRuns()).sessionIds).toEqual([dev.id]);
    gh.queueResponse({ stdout: prView() });
    const report = await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect(report.errors).toEqual([]);
    expect(report.actions).toContainEqual({ type: 'transition', sessionId: dev.id, to: 'pr_opened', reason: 'PR detected' });
    expect((await h.store.load(dev.id)).stageStatus).toBe('pr_opened');
  });

  it('I1 — the tick leaves a session with a live run alone', async () => {
    const gh = new FakeGhRunner();
    const h = createHarness({ gh, log: () => undefined });
    const dev = await h.service.createDevelopmentSession(DEV_INPUT);
    const run = h.service.runDevelop(dev.id);
    await flush();
    await new ReconciliationTick({ gh, store: h.store, pipeline: h.service, events: h.events, lock: h.lock }).run();
    expect(gh.calls).toEqual([]);
    gh.queueResponse({ stdout: '[]' });
    h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
    expect((await run).stageStatus).toBe('active');
  });
});
