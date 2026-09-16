/**
 * Phase 18 — "is a run in progress?" is asked in ONE place.
 *
 * The incident: an investigation's `findings` run died without recording an
 * end, so the session file kept `lastRun.outcome === 'running'` forever. The
 * attention layer already read that as `run_failed` (R22), but every write
 * path open-coded its own membership test, and the user's words were "I can't
 * do anything". A persisted `running` for a session the runner is not holding
 * is a CRASHED run, never a live one — and both layers must say so from the
 * same predicate.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRASHED_RUN_ERROR, runLiveness } from '../../src/pipeline/run-liveness';
import { deriveSessionReasons } from '../../src/attention/attention';
import { createHarness, createInvestigation, flush } from '../support/pipeline-harness';
import { RunInProgressError } from '../../src/pipeline/stage-runner';
import type { LastRun } from '../../src/schema/stage';
import type { Session } from '../../src/schema/session';

const SRC = path.resolve(__dirname, '../../src');

function run(outcome: LastRun['outcome']): LastRun {
  return {
    stage: 'findings',
    startedAt: '2026-09-16T21:11:06.000Z',
    finishedAt: outcome === 'running' ? null : '2026-09-16T21:13:00.000Z',
    exitCode: null,
    signal: null,
    outcome,
    error: null,
  };
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the ONE liveness predicate', () => {
  it('only the runner can say "live"; a persisted running record with no run is crashed', () => {
    expect(runLiveness(run('running'), true)).toBe('live');
    expect(runLiveness(run('running'), false)).toBe('crashed');
    expect(runLiveness(run('succeeded'), true)).toBe('live');
    expect(runLiveness(run('failed'), false)).toBe('idle');
    expect(runLiveness(run('stopped'), false)).toBe('idle');
    expect(runLiveness(null, false)).toBe('idle');
    expect(runLiveness(null, true)).toBe('live');
  });

  it('names the one sentence a crashed run records', () => {
    expect(CRASHED_RUN_ERROR).toBe('the engine stopped while this run was in flight');
  });

  it('exactly ONE site in src asks the runner for raw membership — every other caller asks the predicate', async () => {
    const hits: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, 'utf8');
      const count = [...text.matchAll(/activeSessionIds\(\)\.includes\(/g)].length;
      for (let i = 0; i < count; i += 1) hits.push(path.relative(SRC, file));
    }
    expect(hits).toEqual(['pipeline/pipeline-service.ts']);
  });
});

describe('the attention layer and the write paths read the same predicate', () => {
  function evidence(session: Session, running: boolean) {
    return { session, agentState: null, agentStateMtime: null, running, localApp: null } as const;
  }

  it('a crashed run raises run_failed, and the write path calls it crashed too', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    await h.store.save({ ...inv, lastRun: run('running') });
    const stale = await h.store.load(inv.id);

    expect(h.service.runLivenessOf(stale)).toBe('crashed');
    expect(deriveSessionReasons(evidence(stale, false)).map((d) => d.reason)).toContain('run_failed');
    // The wedge, gone: a claim on a crashed run is a claim on a dead session.
    await expect(h.service.claimConversation(inv.id)).resolves.toBeDefined();
  });

  it('a genuinely live run is still refused a claim, and raises no run_failed', async () => {
    const h = createHarness();
    const inv = await createInvestigation(h.service);
    const running = h.service.runFindings(inv.id);
    running.catch(() => undefined);
    await flush();

    const live = await h.store.load(inv.id);
    expect(h.service.runLivenessOf(live)).toBe('live');
    expect(deriveSessionReasons(evidence(live, true)).map((d) => d.reason)).not.toContain('run_failed');
    await expect(h.service.claimConversation(inv.id)).rejects.toBeInstanceOf(RunInProgressError);

    h.runner.emitExit(h.runner.lastHandle(), { code: 1, signal: null });
    await running.catch(() => undefined);
  });
});
