/**
 * Integration: the engine dies with a run in flight, and the session does not stay wedged.
 *
 * The incident (`inv-…-20260916-211103`): a `findings` run started, the process died two minutes
 * later without recording an end, and the session file kept `lastRun.outcome: 'running'` forever.
 * Every action then answered `already has a stage run in progress` — Chat included — and the
 * user's words were "I can't do anything".
 *
 * So this drives the REAL engine: a real run, a real agent process that hangs, a real SIGKILL of
 * the engine under it (the only death that leaves no end record), and a real restart. What it
 * asserts is the whole of Phase 18 — the residue is there, the boot sweep heals it to `failed`
 * with the sentence, it says so exactly once, and the session is claimable again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  coreIsBuilt,
  startEngineViaManager,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

const TIMEOUT = 90_000;
const CRASHED = 'the engine stopped while this run was in flight';

describe.skipIf(!coreIsBuilt())('integration: a run the engine died under', () => {
  let h: CoreHarness;
  let sessionId: string;

  async function onDisk(): Promise<Record<string, never> & { lastRun: { outcome: string; error: string | null } }> {
    const file = path.join(h.sessionsDir, sessionId, 'session.json');
    return JSON.parse(await readFile(file, 'utf8')) as never;
  }

  beforeAll(async () => {
    // The agent hangs, so the run is genuinely in flight when the engine dies. Bounded: the
    // SIGKILL below orphans it, and this is what reaps it well inside the suite.
    h = await startEngineViaManager({ agentHangsForSeconds: 25 });
    sessionId = h.seeded.looseInvestigation;
  }, TIMEOUT);

  afterAll(async () => {
    await h.cleanup();
  }, TIMEOUT);

  it(
    'leaves a `running` record behind, then heals it to failed on the next boot and lets the user back in',
    async () => {
      expect((await h.client.run(sessionId, 'findings')).status).toBe(202);
      await waitUntil(
        async () => (await onDisk()).lastRun?.outcome,
        (outcome) => outcome === 'running',
        { what: 'the run to be recorded as running' },
      );

      // The death the incident had: no shutdown, no exit record, no end.
      const enginePid = (JSON.parse(await readFile(h.enginePidPath, 'utf8')) as { pid: number }).pid;
      process.kill(enginePid, 'SIGKILL');
      await waitUntil(
        async () => {
          try {
            process.kill(enginePid, 0);
            return false;
          } catch {
            return true;
          }
        },
        (gone) => gone,
        { what: 'the engine to be gone' },
      );

      // The residue, exactly as the user found it.
      expect((await onDisk()).lastRun.outcome).toBe('running');

      const revived = await h.manager.ensureRunning('user');
      expect(revived.kind).toBe('running');

      const healed = await onDisk();
      expect(healed.lastRun.outcome).toBe('failed');
      expect(healed.lastRun.error).toBe(CRASHED);

      // Said once, and named.
      const swept = [...h.stderr().matchAll(/run\.stale_run_failed/g)];
      expect(swept).toHaveLength(1);
      expect(h.stderr()).toContain(sessionId);

      // And the way out is open: the claim Chat needs no longer 409s.
      await expect(h.client.claim(sessionId)).resolves.toBeUndefined();
      const item = (await h.client.items()).items.find((i) =>
        i.agents.some((a) => a.sessionId === sessionId),
      );
      expect(item?.agents.find((a) => a.sessionId === sessionId)?.runFailed).toBe(true);
    },
    TIMEOUT,
  );
});
