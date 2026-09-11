import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickPrimaryArtifact, type ArtifactListing } from '../../src/api/artifacts';
import { migrateV1ToV2, type Session, type SessionV1 } from '../../src/schema/session';

function listing(entries: Array<[name: string, mtime: string]>): ArtifactListing[] {
  return entries.map(([name, mtime]) => ({ name, mtime, size: 10 }));
}

function sessionOf(mode: 'investigation' | 'development' | 'review' | 'respond'): Session {
  if (mode === 'respond') {
    return {
      schemaVersion: 2,
      id: 'respond-1',
      mode,
      createdAt: '2026-09-01T00:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:o/r.git', worktreePath: '/w/respond-1', branch: 'me/fix' },
      lineage: { pipelineId: 'respond-1', parentSessionId: null, ticket: null },
      agent: null,
      lastRun: null,
      pr: { repo: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', headSha: 'a'.repeat(40), title: 't', author: 'me' },
      stageStatus: 'addressing',
    } as Session;
  }
  const stageStatus = mode === 'investigation' ? 'findings' : mode === 'development' ? 'active' : 'ready';
  return migrateV1ToV2({
    schemaVersion: 1,
    id: `${mode}-1`,
    mode,
    createdAt: '2026-09-01T00:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:o/r.git' },
    lineage: { pipelineId: `${mode}-1`, parentSessionId: null, ticket: null },
    stageStatus,
  } as SessionV1);
}

const T1 = '2026-09-01T00:00:00.000Z';
const T2 = '2026-09-02T00:00:00.000Z';

describe('pickPrimaryArtifact (R11)', () => {
  it('a review session with REVIEW.md picks REVIEW.md', () => {
    const l = listing([['BRIEF.md', T2], ['RE-REVIEW.md', T2], ['REVIEW.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('review'), l)).toBe('REVIEW.md');
  });

  it('a review session with only RE-REVIEW.md picks RE-REVIEW.md', () => {
    const l = listing([['BRIEF.md', T2], ['RE-REVIEW.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('review'), l)).toBe('RE-REVIEW.md');
  });

  /** R51: a respond session has one output and a fixed answer, exactly like a review session. */
  it('a respond session opens on COMMENTS.md, and on BRIEF.md while it is still triaging', () => {
    const withVerdicts = listing([['BRIEF.md', T2], ['COMMENTS.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('respond'), withVerdicts)).toBe('COMMENTS.md');
    expect(pickPrimaryArtifact(sessionOf('respond'), listing([['BRIEF.md', T1]]))).toBe('BRIEF.md');
    expect(pickPrimaryArtifact(sessionOf('respond'), listing([]))).toBeNull();
  });

  it('a review session with neither review artifact falls back to BRIEF.md', () => {
    expect(pickPrimaryArtifact(sessionOf('review'), listing([['BRIEF.md', T1]]))).toBe('BRIEF.md');
  });

  it('a review session with nothing yields null', () => {
    expect(pickPrimaryArtifact(sessionOf('review'), [])).toBeNull();
  });

  it('an investigation whose FINDINGS.md is older than PLAN.md picks PLAN.md', () => {
    const l = listing([['FINDINGS.md', T1], ['PLAN.md', T2], ['BRIEF.md', T2]]);
    expect(pickPrimaryArtifact(sessionOf('investigation'), l)).toBe('PLAN.md');
  });

  it('an investigation whose PLAN.md is older than FINDINGS.md picks FINDINGS.md', () => {
    const l = listing([['FINDINGS.md', T2], ['PLAN.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('investigation'), l)).toBe('FINDINGS.md');
  });

  it('a development session whose DEVELOPMENT.md is newest picks DEVELOPMENT.md', () => {
    const l = listing([['DEVELOPMENT.md', T2], ['PLAN.md', T1], ['FINDINGS.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('development'), l)).toBe('DEVELOPMENT.md');
  });

  it('a tie on mtime resolves by PLAN.md > DEVELOPMENT.md > FINDINGS.md, not by listing order', () => {
    const all = listing([['FINDINGS.md', T1], ['DEVELOPMENT.md', T1], ['PLAN.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('development'), all)).toBe('PLAN.md');
    const noPlan = listing([['FINDINGS.md', T1], ['DEVELOPMENT.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('development'), noPlan)).toBe('DEVELOPMENT.md');
  });

  it('a session with only AGENT_NOTE falls back to BRIEF.md when present and null when not', () => {
    const withBrief = listing([['AGENT_NOTE', T1], ['BRIEF.md', T1]]);
    expect(pickPrimaryArtifact(sessionOf('investigation'), withBrief)).toBe('BRIEF.md');
    const withoutBrief = listing([['AGENT_NOTE', T1]]);
    expect(pickPrimaryArtifact(sessionOf('investigation'), withoutBrief)).toBeNull();
  });

  it('declares no artifact allow-list of its own (there is one, reached through parseArtifactName)', () => {
    const source = readFileSync(path.join(__dirname, '../../src/api/artifacts.ts'), 'utf8');
    // The two per-mode preference orders decide which artifact is *primary*;
    // what is *listable* stays the single regex in src/api/validation.ts,
    // reached only through parseArtifactName. So this module must carry no
    // copy of that pattern, and must export no name list a caller could
    // mistake for the allow-list.
    expect(source).not.toMatch(/ARTIFACT_NAME_PATTERN/);
    expect(source).not.toMatch(/export const \w+ = \[/);
    expect(source).not.toMatch(/\.test\(/);
  });
});
