import { describe, expect, it } from 'vitest';
import { applyTransition } from '../../src/engine/session-transition';
import type { Session } from '../../src/schema/session';
import { IllegalTransitionError } from '../../src/schema/pipeline';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id: 'inv-test-1',
    mode: 'investigation',
    createdAt: '2026-08-28T10:00:00.000Z',
    workspace: { repoUrl: 'git@example.com:x/y.git' },
    lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
    stageStatus: 'findings',
    ...overrides,
  } as Session;
}

describe('applyTransition', () => {
  it('returns a new session with the updated stageStatus on a legal transition', () => {
    const session = makeSession({ stageStatus: 'findings' });
    const updated = applyTransition(session, 'planning');
    expect(updated.stageStatus).toBe('planning');
    expect(updated).not.toBe(session);
    expect(session.stageStatus).toBe('findings');
  });

  it('throws IllegalTransitionError on an illegal transition', () => {
    const session = makeSession({ stageStatus: 'findings' });
    expect(() => applyTransition(session, 'approved')).toThrow(IllegalTransitionError);
  });

  it('works for development-mode sessions using development phases', () => {
    const session = makeSession({ mode: 'development', stageStatus: 'active' });
    const updated = applyTransition(session, 'pr_opened');
    expect(updated.stageStatus).toBe('pr_opened');
  });

  it('works for review-mode sessions using review phases', () => {
    const session = makeSession({ mode: 'review', stageStatus: 'queued' });
    const updated = applyTransition(session, 'reviewing');
    expect(updated.stageStatus).toBe('reviewing');
  });
});
