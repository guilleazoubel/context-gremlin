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
      schemaVersion: 2,
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

  it('defaults lastRereviewSummary to null for a migrated review-mode legacy session', () => {
    const legacyReview = {
      ...legacyInvestigationSession,
      id: 'pr-grace-frontend-42-20260710-143000',
      mode: 'review',
      stage_status: 'queued',
    };
    const migrated = migrateLegacySession(legacyReview);
    if (migrated.mode !== 'review') throw new Error('mode changed');
    expect(migrated.lastRereviewSummary).toBeNull();
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

  it('maps plan_review.drive_to_completion (string "true"), intent, pr and reviewed_sha into v2 fields', () => {
    const s = migrateLegacySession({
      id: 'inv-app-APP-1-20260901',
      mode: 'investigation',
      project: 'git@github.com:acme/app.git',
      created: '2026-09-01T10:00:00Z',
      stage_status: 'findings',
      intent: 'development',
      plan_review: { drive_to_completion: 'true' },
    });
    expect(s.schemaVersion).toBe(2);
    if (s.mode !== 'investigation') throw new Error('mode changed');
    expect(s.intent).toBe('development');
    expect(s.driveToCompletion).toBe(true);

    const r = migrateLegacySession({
      id: 'pr-app-12-20260901',
      mode: 'review',
      project: 'git@github.com:acme/app.git',
      created: '2026-09-01T10:00:00Z',
      stage_status: 'queued',
      pr: { number: 12, url: 'https://github.com/acme/app/pull/12', repo: 'acme/app' },
      reviewed_sha: 'deadbeef',
    });
    expect(r.pr).toEqual({
      repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12',
      headSha: null, reviewedSha: 'deadbeef', title: null, author: null,
    });
  });
});
