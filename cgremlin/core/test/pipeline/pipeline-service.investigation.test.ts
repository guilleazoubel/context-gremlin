import { describe, expect, it } from 'vitest';
import { createHarness, createInvestigation, flush, SESSIONS_DIR, WORKTREES_DIR } from '../support/pipeline-harness';
import { UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import { PlanGateError } from '../../src/pipeline/plan-gate';
import type { Session } from '../../src/schema/session';

const APPROVED_PLAN = `## Review Status
- PM: ✅ Approved — solves exactly the ticket
- Principal Engineer: ✅ Approved — mechanism checks out
`;

const UNRESOLVED_PLAN = `## Unresolved Review Disagreement
- PM: objects to the scope of the fix

## Review Status
- PM: ❌ Changes requested
- Principal Engineer: ✅ Approved — mechanism checks out
`;

const MISSING_STATUS_PLAN = `# Plan
Some plan text with no approved Review Status block.
`;

describe('PipelineService — investigation', () => {
  it('createInvestigationSession creates the worktree on the investigate branch from the base ref, saves a v2 session at findings, and emits session.created', async () => {
    const h = createHarness();
    const created: unknown[] = [];
    h.events.on('session.created', (e) => created.push(e.session));

    const inv = await createInvestigation(h.service);

    expect(inv.schemaVersion).toBe(2);
    expect(inv.stageStatus).toBe('findings');
    expect(inv.intent).toBe('investigate_only');
    expect(inv.driveToCompletion).toBe(false);
    expect(inv.lineage.pipelineId).toBe(inv.id);
    expect(inv.workspace.branch).toBe('investigate/APP-1');
    expect(inv.workspace.worktreePath).toBe(`${WORKTREES_DIR}/${inv.id}`);

    const worktreeAddCall = h.git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(worktreeAddCall?.args).toEqual([
      'worktree', 'add', `${WORKTREES_DIR}/${inv.id}`, '-b', 'investigate/APP-1', 'origin/main',
    ]);

    expect(created).toEqual([inv]);
    expect(await h.store.load(inv.id)).toEqual(inv);
  });

  it('createInvestigationSession with ticket null derives the id/branch from "no-ticket" and renders "(no ticket)" in the findings brief', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { ticket: null });

    expect(inv.id).toContain('no-ticket');
    expect(inv.id).not.toContain('null');
    expect(inv.lineage.ticket).toBeNull();
    expect(inv.workspace.branch).toBe(`investigate/${inv.id}`);

    const p = h.service.runFindings(inv.id);
    await flush();
    const sessionDir = `${SESSIONS_DIR}/${inv.id}`;
    expect(await h.fs.readFile(`${sessionDir}/BRIEF.md`)).toContain('(no ticket)');

    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });
    await p;
  });

  it('propagates the error and saves nothing when createWorkspace rejects', async () => {
    const h = createHarness();
    h.workspace.createWorkspace = async () => {
      throw new Error('mirror unreachable');
    };
    await expect(createInvestigation(h.service)).rejects.toThrow('mirror unreachable');
    expect(await h.store.list()).toEqual([]);
  });

  it('runFindings with intent investigate_only writes a findings brief, sends the entry prompt, and stays at findings on success without a second run', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'investigate_only' });
    const sessionDir = `${SESSIONS_DIR}/${inv.id}`;

    const p = h.service.runFindings(inv.id);
    await flush();
    const handle = h.runner.lastHandle();
    expect(await h.fs.readFile(`${sessionDir}/BRIEF.md`)).toContain('FINDINGS.md');
    expect(h.runner.getPrompts(handle)).toEqual([`Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`]);

    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });
    const session = await p;

    expect(session.stageStatus).toBe('findings');
    expect(session.lastRun).toMatchObject({ outcome: 'succeeded' });
    expect(h.runner.lastHandle()).toEqual(handle); // no second handle/run
    expect(h.runner.getPrompts(handle)).toHaveLength(1);
  });

  it('runFindings with intent development chains into runPlan on the same call, continuing the same agent conversation', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development' });
    const sessionDir = `${SESSIONS_DIR}/${inv.id}`;

    const p = h.service.runFindings(inv.id);
    await flush();
    const firstHandle = h.runner.lastHandle();
    h.runner.setResumeId(firstHandle, 'claude-sess-1');
    await h.fs.writeFile(`${sessionDir}/FINDINGS.md`, '# Findings\nroot cause found');
    h.runner.emitExit(firstHandle, { code: 0, signal: null });

    await flush();
    const secondHandle = h.runner.lastHandle();
    expect(secondHandle).not.toEqual(firstHandle);
    expect(h.runner.getContext(secondHandle).resumeId).toBe('claude-sess-1');
    expect(await h.fs.readFile(`${sessionDir}/BRIEF.md`)).toContain('## Review Status');

    h.runner.emitExit(secondHandle, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('planning');
  });

  it('runFindings exit 0 without FINDINGS.md stays at findings and marks the run failed with a FINDINGS.md-specific error', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'investigate_only' });
    const p = h.service.runFindings(inv.id);
    await h.finishRun({}, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('findings');
    expect(session.lastRun).toMatchObject({ outcome: 'failed' });
    expect(session.lastRun?.error).toContain('FINDINGS.md');
  });

  it('runPlan from findings without FINDINGS.md rejects UnsupportedStageError and starts no run', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'investigate_only' });
    await expect(h.service.runPlan(inv.id)).rejects.toThrow(UnsupportedStageError);
    expect(() => h.runner.lastHandle()).toThrow();
  });

  it('runPlan approved with driveToCompletion false stops at plan_ready; promote requires approvePlan first, then creates and starts development', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development', driveToCompletion: false });
    const created: Session[] = [];
    h.events.on('session.created', (e) => created.push(e.session));

    const p1 = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null }); // findings run
    await h.finishRun({ 'PLAN.md': APPROVED_PLAN }, { code: 0, signal: null }); // plan run
    const afterPlan = await p1;
    expect(afterPlan.stageStatus).toBe('plan_ready');

    await expect(h.service.promote(inv.id)).rejects.toThrow(PlanGateError);

    const approved = await h.service.approvePlan(inv.id);
    expect(approved.stageStatus).toBe('approved');

    const promotePromise = h.service.promote(inv.id);
    await flush();
    const devHandle = h.runner.lastHandle();
    const devId = h.runner.getContext(devHandle).sessionId;
    expect(devId).not.toBe(inv.id);
    const devDir = `${SESSIONS_DIR}/${devId}`;
    expect(await h.fs.readFile(`${devDir}/BRIEF.md`)).toContain('your approved plan');
    expect(await h.fs.readFile(`${devDir}/PLAN.md`)).toBe(APPROVED_PLAN);
    expect(await h.fs.readFile(`${devDir}/FINDINGS.md`)).toBe('# Findings\nroot cause found');

    h.runner.emitExit(devHandle, { code: 0, signal: null });
    const { investigation, development } = await promotePromise;
    expect(investigation.stageStatus).toBe('promoted_to_development');
    expect(development.stageStatus).toBe('active');
    expect(development.lineage.parentSessionId).toBe(inv.id);
    expect(development.lineage.pipelineId).toBe(inv.lineage.pipelineId);
    expect(development.workspace).toEqual(inv.workspace);

    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(devId);
    expect(created[0].mode).toBe('development');
  });

  it('runPlan approved with driveToCompletion true chains straight through promotion into a running development session', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development', driveToCompletion: true });
    const invTransitions: Array<{ from: string; to: string }> = [];
    h.events.on('session.transitioned', (e) => {
      if (e.session.id === inv.id) invTransitions.push({ from: e.from, to: e.to });
    });

    const p = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null }); // findings
    await h.finishRun({ 'PLAN.md': APPROVED_PLAN }, { code: 0, signal: null }); // plan -> approved -> promote -> runDevelop starts
    await flush();
    const devHandle = h.runner.lastHandle();
    const devId = h.runner.getContext(devHandle).sessionId;
    expect(devId).not.toBe(inv.id);
    h.runner.emitExit(devHandle, { code: 0, signal: null }); // develop run
    const session = await p;
    expect(session.stageStatus).toBe('promoted_to_development');

    // drive-to-completion promotes straight from plan_ready via the schema's
    // direct edge — no synthetic 'approved' hop; the audit trail must not
    // claim a human approved a plan that was auto-promoted.
    expect(invTransitions).toEqual([
      { from: 'findings', to: 'planning' },
      { from: 'planning', to: 'plan_ready' },
      { from: 'plan_ready', to: 'promoted_to_development' },
    ]);
    expect(invTransitions.some((t) => t.to === 'approved')).toBe(false);

    const dev = await h.store.load(devId);
    expect(dev.stageStatus).toBe('active');
    expect(dev.lastRun).toMatchObject({ outcome: 'succeeded' });
  });

  it('runPlan with an Unresolved Review Disagreement section stays at planning with a needs-input error but a succeeded outcome', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development' });
    const p = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });
    await h.finishRun({ 'PLAN.md': UNRESOLVED_PLAN }, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('planning');
    expect(session.lastRun).toMatchObject({ outcome: 'succeeded' });
    expect(session.lastRun?.error).toContain('needs input');
  });

  it('runPlan exit 0 without an approved Review Status stays at planning and marks the run failed', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service, { intent: 'development' });
    const p = h.service.runFindings(inv.id);
    await h.finishRun({ 'FINDINGS.md': '# Findings\nroot cause found' }, { code: 0, signal: null });
    await h.finishRun({ 'PLAN.md': MISSING_STATUS_PLAN }, { code: 0, signal: null });
    const session = await p;
    expect(session.stageStatus).toBe('planning');
    expect(session.lastRun).toMatchObject({ outcome: 'failed' });
  });

  it('promote rejects PlanGateError for plan_ready without driveToCompletion and for planning with driveToCompletion (mutation guard)', async () => {
    const h1 = createHarness();
    const inv1 = await createInvestigation(h1.service, { driveToCompletion: false });
    await h1.store.transition(inv1.id, 'planning');
    await h1.store.transition(inv1.id, 'plan_ready');
    await expect(h1.service.promote(inv1.id)).rejects.toThrow(PlanGateError);

    const h2 = createHarness();
    const inv2 = await createInvestigation(h2.service, { driveToCompletion: true });
    await h2.store.transition(inv2.id, 'planning');
    await expect(h2.service.promote(inv2.id)).rejects.toThrow(PlanGateError);
  });

  it('runStage rejects unsupported stages, and retry re-runs the last failed stage', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);

    await expect(h.service.runStage(inv.id, 'review')).rejects.toThrow(UnsupportedStageError);
    await expect(h.service.retry(inv.id)).rejects.toThrow(UnsupportedStageError); // no lastRun yet

    const p = h.service.runFindings(inv.id);
    await flush();
    const firstHandle = h.runner.lastHandle();
    h.runner.emitExit(firstHandle, { code: 2, signal: null }); // failed run, no FINDINGS.md
    const failed = await p;
    expect(failed.lastRun).toMatchObject({ outcome: 'failed' });

    const p2 = h.service.retry(inv.id);
    await flush();
    const secondHandle = h.runner.lastHandle();
    expect(secondHandle).not.toEqual(firstHandle);
    h.runner.emitExit(secondHandle, { code: 0, signal: null });
    await p2;
  });

  it('stop(id) during a findings run marks lastRun stopped and leaves the phase unchanged', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const p = h.service.runFindings(inv.id);
    await flush();
    expect(await h.service.stop(inv.id)).toBe(true);
    h.runner.emitExit(h.runner.lastHandle(), { code: null, signal: 'SIGTERM' });
    const session = await p;
    expect(session.lastRun).toMatchObject({ outcome: 'stopped' });
    expect(session.stageStatus).toBe('findings');
  });

  it('createInvestigationSession rejects a ticket that would produce an unsafe derived id, before any git call', async () => {
    const h = createHarness();
    await expect(
      h.service.createInvestigationSession({
        repoUrl: 'git@github.com:acme/app.git',
        ticket: '../../x',
        intent: 'investigate_only',
        driveToCompletion: false,
      }),
    ).rejects.toThrow();
    expect(h.git.calls).toEqual([]);
  });

  it('rolls back the created workspace if saving the new investigation session fails', async () => {
    const h = createHarness();
    const originalSave = h.store.save.bind(h.store);
    let calls = 0;
    h.store.save = async (session) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      return originalSave(session);
    };
    let removeWorkspaceCalled = false;
    const originalRemove = h.workspace.removeWorkspace.bind(h.workspace);
    h.workspace.removeWorkspace = async (repoUrl, worktreePath, branchName) => {
      removeWorkspaceCalled = true;
      return originalRemove(repoUrl, worktreePath, branchName);
    };

    await expect(createInvestigation(h.service)).rejects.toThrow('disk full');
    expect(removeWorkspaceCalled).toBe(true);
    const worktreeRemove = h.git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(worktreeRemove).toBeDefined();
  });
});
