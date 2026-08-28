import { describe, expect, it } from 'vitest';
import {
  LegacySessionMigrationError,
  migrateLegacySession,
} from '../../src/migrate/legacy-session-migrator';

const legacyInvestigationSession = {
  id: 'inv-grace-frontend-20260710-143000',
  mode: 'investigation',
  project: 'git@github.com:aplaceformom/grace-frontend.git',
  created: '2026-07-10T14:30:00Z',
  stage_status: 'findings',
  lineage: {
    pipeline_id: 'pl-HB-1234-20260710',
    parent_session_id: null,
    ticket: 'HB-1234',
  },
};

describe('migrateLegacySession', () => {
  it('maps a legacy investigation session.json to the new Session shape', () => {
    const migrated = migrateLegacySession(legacyInvestigationSession);
    expect(migrated).toMatchObject({
      schemaVersion: 1,
      id: 'inv-grace-frontend-20260710-143000',
      mode: 'investigation',
      workspace: { repoUrl: 'git@github.com:aplaceformom/grace-frontend.git' },
      lineage: {
        pipelineId: 'pl-HB-1234-20260710',
        parentSessionId: null,
        ticket: 'HB-1234',
      },
      stageStatus: 'findings',
    });
  });

  it('defaults lineage to session-id-derived values when legacy lineage is missing', () => {
    const { lineage: _lineage, ...withoutLineage } = legacyInvestigationSession;
    const migrated = migrateLegacySession(withoutLineage);
    expect(migrated.lineage.pipelineId).toBe(legacyInvestigationSession.id);
    expect(migrated.lineage.parentSessionId).toBeNull();
    expect(migrated.lineage.ticket).toBeNull();
  });

  it('throws LegacySessionMigrationError when a required field is missing', () => {
    const { id: _id, ...withoutId } = legacyInvestigationSession;
    expect(() => migrateLegacySession(withoutId)).toThrow(LegacySessionMigrationError);
  });

  it('throws LegacySessionMigrationError on an invalid created timestamp', () => {
    const invalid = { ...legacyInvestigationSession, created: 'not-a-date' };
    expect(() => migrateLegacySession(invalid)).toThrow(LegacySessionMigrationError);
  });

  it('defaults stageStatus to "findings" for an investigation-mode legacy session with no stage_status', () => {
    const { stage_status: _stage_status, ...withoutStatus } = legacyInvestigationSession;
    const migrated = migrateLegacySession(withoutStatus);
    expect(migrated.stageStatus).toBe('findings');
  });

  it('defaults stageStatus to "active" for a development-mode legacy session with no stage_status', () => {
    const legacyDev = {
      ...legacyInvestigationSession,
      id: 'dev-grace-frontend-HB-1234-20260710-143000',
      mode: 'development',
    };
    const { stage_status: _stage_status, ...withoutStatus } = legacyDev;
    const migrated = migrateLegacySession(withoutStatus);
    expect(migrated.stageStatus).toBe('active');
  });

  it('defaults stageStatus to "queued" for a review-mode legacy session with no stage_status', () => {
    const legacyReview = {
      ...legacyInvestigationSession,
      id: 'pr-grace-frontend-42-20260710-143000',
      mode: 'review',
    };
    const { stage_status: _stage_status, ...withoutStatus } = legacyReview;
    const migrated = migrateLegacySession(withoutStatus);
    expect(migrated.stageStatus).toBe('queued');
  });

  it('preserves an explicit legacy stage_status value instead of resurrecting a terminal session as active', () => {
    const legacyMergedDev = {
      ...legacyInvestigationSession,
      id: 'dev-grace-frontend-HB-1234-20260710-143000',
      mode: 'development',
      stage_status: 'merged',
    };
    const migrated = migrateLegacySession(legacyMergedDev);
    expect(migrated.stageStatus).toBe('merged');
  });
});
