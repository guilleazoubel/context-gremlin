import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import { InvalidSessionIdError } from '../../src/engine/session-store';
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
    expect(dev.lineage).toEqual({ pipelineId: dev.id, parentSessionId: null, ticket: 'ABC-1' });
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
