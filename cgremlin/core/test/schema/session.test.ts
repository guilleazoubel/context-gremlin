import { describe, expect, it } from 'vitest';
import { migrateV1ToV2, parseSession } from '../../src/schema/session';

const validSession = {
  schemaVersion: 1 as const,
  id: 'inv-grace-frontend-20260828-101500',
  mode: 'investigation' as const,
  createdAt: '2026-08-28T10:15:00.000Z',
  workspace: {
    repoUrl: 'git@github.com:aplaceformom/grace-frontend.git',
  },
  lineage: {
    pipelineId: 'pl-HB-1234-20260828',
    parentSessionId: null,
    ticket: 'HB-1234',
  },
  stageStatus: 'findings',
};

describe('SessionSchema', () => {
  it('accepts a valid session', () => {
    expect(() => parseSession(validSession)).not.toThrow();
  });

  it('rejects an invalid mode', () => {
    const invalid = { ...validSession, mode: 'bogus' };
    expect(() => parseSession(invalid)).toThrow();
  });

  it('rejects a session with an empty lineage.pipelineId', () => {
    const invalid = {
      ...validSession,
      lineage: { ...validSession.lineage, pipelineId: '' },
    };
    expect(() => parseSession(invalid)).toThrow();
  });

  it('rejects a stageStatus that is not valid for the session mode', () => {
    const invalid = { ...validSession, stageStatus: 'merged' }; // 'merged' is a development phase, not investigation
    expect(() => parseSession(invalid)).toThrow();
  });

  it('exposes the parsed session mode via parseSession', () => {
    const parsed = parseSession(validSession);
    expect(parsed.mode).toBe('investigation');
  });
});

const v1Investigation = {
  schemaVersion: 1 as const,
  id: 'inv-1',
  mode: 'investigation' as const,
  createdAt: '2026-09-04T10:00:00.000Z',
  workspace: { repoUrl: 'git@github.com:acme/app.git' },
  lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'APP-1' },
  stageStatus: 'findings' as const,
};

describe('schema v2', () => {
  it('parseSession upgrades a v1 investigation document to v2 with defaults', () => {
    const s = parseSession(v1Investigation);
    expect(s.schemaVersion).toBe(2);
    expect(s.agent).toBeNull();
    expect(s.lastRun).toBeNull();
    expect(s.pr).toBeNull();
    if (s.mode !== 'investigation') throw new Error('mode changed');
    expect(s.intent).toBe('investigate_only');
    expect(s.driveToCompletion).toBe(false);
  });

  it('parseSession upgrades a v1 review document with reviewVersion 0', () => {
    const s = parseSession({ ...v1Investigation, id: 'r1', mode: 'review', stageStatus: 'queued' });
    if (s.mode !== 'review') throw new Error('mode changed');
    expect(s.reviewVersion).toBe(0);
  });

  it('migrateV1ToV2 is idempotent through parseSession (v2 in, same v2 out)', () => {
    const once = parseSession(v1Investigation);
    expect(parseSession(once)).toEqual(once);
  });

  it('accepts a full v2 document with agent, lastRun and pr populated', () => {
    const s = parseSession({
      ...migrateV1ToV2(v1Investigation),
      agent: { runner: 'claude-code', resumeId: 'abc' },
      lastRun: {
        stage: 'findings', startedAt: '2026-09-04T10:00:00.000Z', finishedAt: null,
        exitCode: null, signal: null, outcome: 'running', error: null,
      },
      pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12',
            headSha: null, reviewedSha: null, title: null, author: null },
    });
    expect(s.agent?.resumeId).toBe('abc');
    expect(s.lastRun?.outcome).toBe('running');
    expect(s.pr?.number).toBe(12);
  });

  it('rejects an unknown schemaVersion', () => {
    expect(() => parseSession({ ...v1Investigation, schemaVersion: 3 })).toThrow();
  });

  it('rejects a v2 review document whose stageStatus is not a review phase', () => {
    expect(() =>
      parseSession({ ...migrateV1ToV2({ ...v1Investigation, mode: 'review', stageStatus: 'queued' }), stageStatus: 'planning' }),
    ).toThrow();
  });
});
