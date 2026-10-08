import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig } from '../../src/config/core-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import type { SessionContext } from '../../src/agent/agent-runner';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function engineWith(routing: unknown) {
  const fs = new InMemoryFileSystem();
  const runner = new FakeAgentRunner();
  const warnings: string[] = [];
  const config = resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', sessionsDir: '/sessions', worktreesDir: '/worktrees', mirrorsDir: '/mirrors', routing },
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
});
