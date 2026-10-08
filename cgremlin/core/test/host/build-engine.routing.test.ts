import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig } from '../../src/config/core-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import type { SessionContext } from '../../src/agent/agent-runner';
import type { StageRunner } from '../../src/pipeline/stage-runner';
import { STAGE_NAMES } from '../../src/schema/stage';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function engineWith(routing: unknown, runnerOptions?: { model?: string }) {
  const fs = new InMemoryFileSystem();
  const runner = new FakeAgentRunner();
  const warnings: string[] = [];
  const config = resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', sessionsDir: '/sessions', worktreesDir: '/worktrees', mirrorsDir: '/mirrors', routing, ...(runnerOptions !== undefined ? { runnerOptions } : {}) },
    '/home/e2e',
  );
  const adapters: EngineAdapters = {
    fs, git: new FakeGitRunner(fs), gh: new FakeGhRunner(), runner, runnerKind: 'claude-code',
    clock: new FakeClock(), now: () => new Date('2026-10-08T12:00:00.000Z'),
  };
  const engine = buildEngine(config, adapters, { warn: (line) => warnings.push(line) });
  return { engine, runner, warnings };
}

/** Runs a findings stage through the built engine and returns the context its agent was started with. */
async function findingsContext(engine: ReturnType<typeof buildEngine>, runner: FakeAgentRunner): Promise<SessionContext> {
  const session = await engine.pipeline.createInvestigationSession({
    repoUrl: '/origin/acme-app', ticket: 'APP-1', intent: 'investigate_only', driveToCompletion: false,
  });
  const run = engine.pipeline.runFindings(session.id);
  await flush();
  await flush();
  const ctx = runner.getContext(runner.lastHandle());
  runner.emitExit(runner.lastHandle(), { code: 1, signal: null });
  await run;
  return ctx;
}

describe('buildEngine routes stages from core.json (R116)', () => {
  it('a routed stage reaches the runner with its model and effort', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'claude-code', model: 'opus', effort: 'high' } });
    expect(warnings).toEqual([]);
    expect(await findingsContext(engine, runner)).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('D3 — a bad entry does not stop the engine: it is logged by name and that stage runs on the legacy runner', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'claude-code', efort: 'high' } });
    expect(warnings).toEqual([expect.stringContaining('routing.findings')]);
    const ctx = await findingsContext(engine, runner);
    expect('effort' in ctx).toBe(false);
    expect('model' in ctx).toBe(false);
  });

  it('D1 — codex named as a primary runner is logged and ignored', async () => {
    const { engine, runner, warnings } = engineWith({ findings: { runner: 'codex', effort: 'high' } });
    expect(warnings).toEqual([expect.stringMatching(/routing\.findings: .*codex/)]);
    expect('effort' in (await findingsContext(engine, runner))).toBe(false);
  });

  it('R116 — routing absent and runnerOptions.model set: every stage\'s agent context gets that model and no effort', async () => {
    const { engine, runner } = engineWith(undefined, { model: 'opus' });
    const session = await engine.pipeline.createInvestigationSession({
      repoUrl: '/origin/acme-app', ticket: 'APP-1', intent: 'investigate_only', driveToCompletion: false,
    });
    // The engine does not expose its StageRunner; every stage's run funnels through it, so drive it directly.
    const stageRunner = (engine.pipeline as unknown as { deps: { stageRunner: StageRunner } }).deps.stageRunner;
    const handles = new Set<string>();
    for (const stage of STAGE_NAMES) {
      const run = stageRunner.run({ sessionId: session.id, stage, brief: null, prompt: 'go' });
      await flush();
      await flush();
      const handle = runner.lastHandle();
      handles.add(handle.id);
      const ctx = runner.getContext(handle);
      expect(ctx.model, `${stage} model`).toBe('opus');
      expect('effort' in ctx && ctx.effort != null, `${stage} effort`).toBe(false);
      runner.emitExit(handle, { code: 1, signal: null });
      await run;
    }
    expect(handles.size).toBe(STAGE_NAMES.length);
  });
});
