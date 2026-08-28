import { describe, expect, it } from 'vitest';
import { parseSession, SessionSchema } from '../../src/schema/session';

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
  stageStatus: 'active',
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

  it('exposes the parsed session mode via SessionSchema.parse', () => {
    const parsed = SessionSchema.parse(validSession);
    expect(parsed.mode).toBe('investigation');
  });
});
