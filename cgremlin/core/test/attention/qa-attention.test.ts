import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REASONS,
  NEEDS_YOU_REASONS,
  deriveSessionReasons,
  type SessionEvidence,
} from '../../src/attention/attention';
import { SessionSchema, type Session } from '../../src/schema/session';

function qaSession(stageStatus: string, finishedAt: string | null = '2026-09-15T11:00:00.000Z'): Session {
  return SessionSchema.parse({
    schemaVersion: 2,
    id: 'qa-1',
    mode: 'qa',
    createdAt: '2026-09-15T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git' },
    lineage: { pipelineId: 'qa-1', parentSessionId: null, ticket: 'HB-1' },
    agent: null,
    lastRun:
      finishedAt === null
        ? null
        : {
            stage: 'verify',
            startedAt: '2026-09-15T10:30:00.000Z',
            finishedAt,
            exitCode: 0,
            signal: null,
            outcome: 'succeeded',
            error: null,
          },
    pr: null,
    stageStatus,
  });
}

function evidence(session: Session): SessionEvidence {
  return { session, agentState: null, agentStateMtime: null, running: false, localApp: null };
}

describe('MG-19 — qa_not_ready is APPENDED last', () => {
  it('the ack signature array is asserted element-for-element', () => {
    expect([...ATTENTION_REASONS]).toEqual([
      'plan_ready',
      'needs_input',
      'blocked',
      'run_failed',
      'review_ready',
      'rereview_ready',
      'comments_ready',
      'local_prereq_failed',
      'changes_requested',
      'review_arrived',
      'approved',
      'qa_not_ready',
    ]);
    expect(ATTENTION_REASONS[11]).toBe('qa_not_ready');
  });

  it('it interrupts — a not-ready verdict is the top of my work', () => {
    expect(NEEDS_YOU_REASONS).toContain('qa_not_ready');
  });
});

describe('the deriver clause', () => {
  it("a qa session at not_ready raises qa_not_ready, timed at the run's finish", () => {
    const derived = deriveSessionReasons(evidence(qaSession('not_ready')));
    expect(derived).toContainEqual({ reason: 'qa_not_ready', at: '2026-09-15T11:00:00.000Z' });
  });

  it('a ready verdict is quiet', () => {
    expect(deriveSessionReasons(evidence(qaSession('ready')))).toEqual([]);
  });

  it.each(['queued', 'verifying', 'closed', 'abandoned'] as const)('%s raises nothing', (phase) => {
    expect(deriveSessionReasons(evidence(qaSession(phase))).map((d) => d.reason)).not.toContain('qa_not_ready');
  });

  it('a failed run is already covered by run_failed, and does not double up', () => {
    const session = qaSession('failed');
    const failed = { ...session, lastRun: { ...session.lastRun!, outcome: 'failed' as const } };
    const reasons = deriveSessionReasons(evidence(failed)).map((d) => d.reason);
    expect(reasons).toContain('run_failed');
    expect(reasons).not.toContain('qa_not_ready');
  });
});
