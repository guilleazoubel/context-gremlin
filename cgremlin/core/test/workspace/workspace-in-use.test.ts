import { describe, expect, it } from 'vitest';
import { migrateV1ToV2, type Session } from '../../src/schema/session';
import type { DevelopmentPhase, InvestigationPhase, ReviewPhase } from '../../src/schema/pipeline';
import {
  assertWorktreeNotInUse,
  findSessionsUsingWorktree,
  TERMINAL_PHASES_BY_MODE,
  WorkspaceInUseError,
} from '../../src/workspace/workspace-in-use';

function baseSession(id: string, worktreePath: string | undefined) {
  return {
    schemaVersion: 1 as const,
    id,
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', ...(worktreePath ? { worktreePath } : {}) },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
  };
}

function investigationSession(id: string, stageStatus: InvestigationPhase, worktreePath?: string): Session {
  return migrateV1ToV2({ ...baseSession(id, worktreePath), mode: 'investigation', stageStatus });
}

function developmentSession(id: string, stageStatus: DevelopmentPhase, worktreePath?: string): Session {
  return migrateV1ToV2({ ...baseSession(id, worktreePath), mode: 'development', stageStatus });
}

function reviewSession(id: string, stageStatus: ReviewPhase, worktreePath?: string): Session {
  return migrateV1ToV2({ ...baseSession(id, worktreePath), mode: 'review', stageStatus });
}

const wt = '/worktrees/app-1';

describe('TERMINAL_PHASES_BY_MODE', () => {
  it('has the exact per-mode terminal phases (approved is terminal for review, not investigation)', () => {
    expect(TERMINAL_PHASES_BY_MODE.investigation).toEqual(new Set(['promoted_to_development', 'abandoned']));
    expect(TERMINAL_PHASES_BY_MODE.development).toEqual(new Set(['merged', 'abandoned']));
    expect(TERMINAL_PHASES_BY_MODE.review).toEqual(new Set(['approved', 'dismissed']));
  });
});

describe('findSessionsUsingWorktree', () => {
  it('an active development session sharing the worktree blocks removal', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    expect(findSessionsUsingWorktree([dev], wt)).toEqual([dev]);
  });

  it('a promoted_to_development investigation does not block (it is terminal for investigation)', () => {
    const inv = investigationSession('inv-1', 'promoted_to_development', wt);
    expect(findSessionsUsingWorktree([inv], wt)).toEqual([]);
  });

  it('an approved investigation DOES block — an approved investigation still owns its worktree until promoted', () => {
    const inv = investigationSession('inv-1', 'approved', wt);
    expect(findSessionsUsingWorktree([inv], wt)).toEqual([inv]);
  });

  it('an approved review does not block (approved is terminal for review)', () => {
    const rev = reviewSession('rev-1', 'approved', wt);
    expect(findSessionsUsingWorktree([rev], wt)).toEqual([]);
  });

  it('excludeSessionId excludes the caller\'s own session even though it is non-terminal', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    expect(findSessionsUsingWorktree([dev], wt, 'dev-1')).toEqual([]);
  });

  it('ignores sessions pointed at a different worktree', () => {
    const dev = developmentSession('dev-1', 'active', '/worktrees/other');
    expect(findSessionsUsingWorktree([dev], wt)).toEqual([]);
  });

  it('ignores sessions with no worktreePath at all', () => {
    const inv = investigationSession('inv-1', 'findings', undefined);
    expect(findSessionsUsingWorktree([inv], wt)).toEqual([]);
  });

  it('returns every non-terminal, non-excluded session sharing the worktree, across modes', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    const inv = investigationSession('inv-2', 'planning', wt);
    const rev = reviewSession('rev-3', 'reviewing', wt);
    const done = reviewSession('rev-4', 'dismissed', wt);
    expect(findSessionsUsingWorktree([dev, inv, rev, done], wt)).toEqual([dev, inv, rev]);
  });

  it('normalizes worktree paths before comparing, so a trailing slash still matches', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    expect(findSessionsUsingWorktree([dev], `${wt}/`)).toEqual([dev]);
  });
});

describe('assertWorktreeNotInUse', () => {
  it('throws WorkspaceInUseError naming the blocking ids', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    const inv = investigationSession('inv-2', 'approved', wt);
    expect(() => assertWorktreeNotInUse([dev, inv], wt)).toThrow(WorkspaceInUseError);
    try {
      assertWorktreeNotInUse([dev, inv], wt);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceInUseError);
      expect((err as Error).message).toContain('dev-1');
      expect((err as Error).message).toContain('inv-2');
    }
  });

  it('does not throw when the only blocking session is the caller itself', () => {
    const dev = developmentSession('dev-1', 'active', wt);
    expect(() => assertWorktreeNotInUse([dev], wt, 'dev-1')).not.toThrow();
  });

  it('does not throw when nothing shares the worktree', () => {
    expect(() => assertWorktreeNotInUse([], wt)).not.toThrow();
  });
});
