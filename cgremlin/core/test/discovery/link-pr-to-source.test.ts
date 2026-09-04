import { describe, expect, it } from 'vitest';
import { linkPrToSource } from '../../src/discovery/link-pr-to-source';
import { migrateV1ToV2, type ReviewSession, type Session } from '../../src/schema/session';
import type { DevelopmentPhase, InvestigationPhase } from '../../src/schema/pipeline';

function pr(repo: string, number: number) {
  return {
    repo, number, url: `https://github.com/${repo}/pull/${number}`,
    headSha: null, reviewedSha: null, title: null, author: null,
  };
}

function review(id: string, repo: string, number: number, ticket: string | null = null): ReviewSession {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket }, stageStatus: 'queued',
  }) as ReviewSession;
  return { ...v2, pr: pr(repo, number) };
}

function reviewWithNullPr(id: string, ticket: string | null = null): ReviewSession {
  return migrateV1ToV2({
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket }, stageStatus: 'queued',
  }) as ReviewSession;
}

function development(
  id: string,
  stageStatus: DevelopmentPhase,
  overrides: { pr?: { repo: string; number: number } | null; ticket?: string | null; createdAt?: string } = {},
): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'development', createdAt: overrides.createdAt ?? '2026-09-04T09:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: overrides.ticket ?? null }, stageStatus,
  });
  return { ...v2, pr: overrides.pr ? pr(overrides.pr.repo, overrides.pr.number) : null };
}

function investigation(
  id: string,
  stageStatus: InvestigationPhase,
  overrides: { pr?: { repo: string; number: number } | null; ticket?: string | null; createdAt?: string } = {},
): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'investigation', createdAt: overrides.createdAt ?? '2026-09-04T09:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: overrides.ticket ?? null }, stageStatus,
  });
  return { ...v2, pr: overrides.pr ? pr(overrides.pr.repo, overrides.pr.number) : null };
}

describe('linkPrToSource', () => {
  it('pass-1 matches a source by pr.repo + pr.number', () => {
    const source = development('dev-1', 'active', { pr: { repo: 'acme/app', number: 5 } });
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const result = linkPrToSource(rev, [source]);
    expect(result.source).toEqual(source);
    expect(result.linked.lineage).toEqual({
      pipelineId: source.lineage.pipelineId, parentSessionId: source.id, ticket: null,
    });
    expect(result.supersede).toBe(false);
  });

  it('the same PR number in a different repo is not a pass-1 match', () => {
    const source = development('dev-1', 'active', { pr: { repo: 'acme/other', number: 5 } });
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const result = linkPrToSource(rev, [source]);
    expect(result.source).toBeNull();
  });

  it('falls back to pass-2 ticket match when pass-1 finds nothing', () => {
    const source = development('dev-1', 'active', { ticket: 'APP-1' });
    const rev = review('pr-app-5-x', 'acme/app', 5, 'APP-1');
    const result = linkPrToSource(rev, [source]);
    expect(result.source).toEqual(source);
    expect(result.linked.lineage.parentSessionId).toBe('dev-1');
  });

  it('never falls back to pass-2 when the review itself has no ticket, even if a candidate has one', () => {
    const source = development('dev-1', 'active', { ticket: 'APP-9' });
    const rev = review('pr-app-5-x', 'acme/app', 5, null);
    const result = linkPrToSource(rev, [source]);
    expect(result.source).toBeNull();
  });

  it('skips terminal sources: development@merged, development@abandoned, investigation@promoted_to_development', () => {
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const mergedSource = development('dev-1', 'merged', { pr: { repo: 'acme/app', number: 5 } });
    const abandonedDev = development('dev-2', 'abandoned', { pr: { repo: 'acme/app', number: 5 } });
    const promotedInv = investigation('inv-1', 'promoted_to_development', { pr: { repo: 'acme/app', number: 5 } });
    const result = linkPrToSource(rev, [mergedSource, abandonedDev, promotedInv]);
    expect(result.source).toBeNull();
  });

  it('picks the most recently created session when multiple candidates match', () => {
    const older = development('dev-old', 'active', {
      pr: { repo: 'acme/app', number: 5 }, createdAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = development('dev-new', 'active', {
      pr: { repo: 'acme/app', number: 5 }, createdAt: '2026-09-03T00:00:00.000Z',
    });
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const result = linkPrToSource(rev, [older, newer]);
    expect(result.source?.id).toBe('dev-new');
  });

  it('supersede is true only for a development source at pr_opened', () => {
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const prOpened = development('dev-1', 'pr_opened', { pr: { repo: 'acme/app', number: 5 } });
    expect(linkPrToSource(rev, [prOpened]).supersede).toBe(true);
  });

  it('supersede is false for a development source at active', () => {
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const active = development('dev-1', 'active', { pr: { repo: 'acme/app', number: 5 } });
    expect(linkPrToSource(rev, [active]).supersede).toBe(false);
  });

  it('supersede is false for an investigation source, regardless of phase', () => {
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const inv = investigation('inv-1', 'approved', { pr: { repo: 'acme/app', number: 5 } });
    expect(linkPrToSource(rev, [inv]).supersede).toBe(false);
  });

  it('no match leaves the review unchanged: source null, linked identical, supersede false', () => {
    const rev = review('pr-app-5-x', 'acme/app', 5);
    const result = linkPrToSource(rev, []);
    expect(result).toEqual({ source: null, linked: rev, supersede: false });
    expect(result.linked).toBe(rev);
  });

  it('does not throw when review.pr is null — returns no match instead', () => {
    const rev = reviewWithNullPr('pr-x');
    const source = development('dev-1', 'active', { pr: { repo: 'acme/app', number: 5 } });
    expect(() => linkPrToSource(rev, [source])).not.toThrow();
    expect(linkPrToSource(rev, [source])).toEqual({ source: null, linked: rev, supersede: false });
  });
});
