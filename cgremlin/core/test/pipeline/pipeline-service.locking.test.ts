import { describe, expect, it } from 'vitest';
import { createHarness, flush } from '../support/pipeline-harness';
import { migrateV1ToV2 } from '../../src/schema/session';

function devSession(id: string) {
  return migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'development',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: `/w/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'active',
  });
}

describe('PipelineService/StageRunner shared per-session lock', () => {
  it(
    "a develop run's post-exit lastRun/agent patch and a concurrent transition to 'abandoned' never clobber each other — " +
      'the transition blocks on the shared lock until the patch commits, then applies cleanly on top of it',
    async () => {
      const h = createHarness();
      const devId = 'dev-lock-1';
      await h.store.save(devSession(devId));

      // Deterministically force the exact interleaving that produced the
      // proven clobber: hold StageRunner's post-exit patch open (its 2nd
      // save for this id — the 1st is the pre-run 'running' save) so a
      // concurrent transition either races it (pre-fix: corrupts state) or
      // blocks behind it (post-fix: correct either way).
      const originalSave = h.store.save.bind(h.store);
      let saveCallsForDev = 0;
      let releasePostExitSave: (() => void) | undefined;
      h.store.save = (session) => {
        if (session.id === devId) {
          saveCallsForDev += 1;
          if (saveCallsForDev === 2) {
            return new Promise<void>((resolve, reject) => {
              releasePostExitSave = () => originalSave(session).then(resolve, reject);
            });
          }
        }
        return originalSave(session);
      };

      const runPromise = h.service.runDevelop(devId);
      await flush();
      h.runner.emitExit(h.runner.lastHandle(), { code: 0, signal: null });
      // Let the post-exit patch's load + merge run and reach (and get held
      // at) its own store.save call.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(saveCallsForDev).toBe(2);

      let transitionResolved = false;
      const transitionPromise = h.service.transition(devId, 'abandoned').then((s) => {
        transitionResolved = true;
        return s;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Proves the fix: the transition does not race the held-open patch —
      // it queues behind the same per-session lock instead.
      expect(transitionResolved).toBe(false);

      releasePostExitSave?.();
      await runPromise;
      const transitioned = await transitionPromise;

      expect(transitioned.stageStatus).toBe('abandoned');
      const final = await h.store.load(devId);
      expect(final.stageStatus).toBe('abandoned');
      expect(final.lastRun).toMatchObject({ outcome: 'succeeded' });
    },
  );
});
