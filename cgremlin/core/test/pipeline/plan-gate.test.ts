import { describe, expect, it } from 'vitest';
import { canPromote, assertCanPromote, PlanGateError } from '../../src/pipeline/plan-gate';
import { migrateV1ToV2 } from '../../src/schema/session';

function inv(stageStatus: string, driveToCompletion = false) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'i', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u' }, lineage: { pipelineId: 'p', parentSessionId: null, ticket: null },
    stageStatus: stageStatus as never,
  });
  return { ...s, driveToCompletion } as typeof s;
}

describe('plan gate (legacy develop_start rule)', () => {
  it('allows approved regardless of drive flag', () => {
    expect(canPromote(inv('approved'))).toBe(true);
    expect(canPromote(inv('approved', true))).toBe(true);
  });
  it('allows plan_ready only with driveToCompletion', () => {
    expect(canPromote(inv('plan_ready', true))).toBe(true);
    expect(canPromote(inv('plan_ready', false))).toBe(false);
  });
  it('rejects every earlier phase even with driveToCompletion', () => {
    for (const p of ['findings', 'planning']) {
      expect(canPromote(inv(p, true))).toBe(false);
    }
  });
  it('rejects non-investigation sessions', () => {
    const dev = { ...inv('approved'), mode: 'development', stageStatus: 'active' } as never;
    expect(canPromote(dev)).toBe(false);
    expect(() => assertCanPromote(dev)).toThrow(PlanGateError);
  });
});
