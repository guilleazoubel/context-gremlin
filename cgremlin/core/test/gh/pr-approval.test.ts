import { describe, expect, it } from 'vitest';
import { migrateV1ToV2, type ReviewSession, type Session, type SessionV1 } from '../../src/schema/session';
import { resolveApprovalTarget } from '../../src/gh/pr-approval';

/**
 * The human's approval, and ONLY on the pull request the session is about.
 *
 * `gh pr review --repo X <n>` reaches every pull request the token can see,
 * which is why Phase 20 bakes the target into the post helpers rather than
 * passing it. The same rule holds here: the engine route takes a SESSION id
 * and nothing else, and the repo and the number are read out of the session
 * document the engine itself wrote. This resolver is that read, and it
 * refuses every attempt to name a different pull request.
 */
function reviewSession(overrides: Partial<ReviewSession> = {}): ReviewSession {
  const v1: SessionV1 = {
    schemaVersion: 1,
    id: 'pr-app-42-a',
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/worktrees/pr-app-42-a' },
    lineage: { pipelineId: 'pr-app-42-a', parentSessionId: null, ticket: null },
    stageStatus: 'ready',
  };
  const base = migrateV1ToV2(v1) as ReviewSession;
  return {
    ...base,
    pr: {
      repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42',
      headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob',
    },
    ...overrides,
  };
}

describe('the approval target comes from the session, never from the request', () => {
  it('a reviewed session resolves to its own pull request', () => {
    const result = resolveApprovalTarget(reviewSession(), undefined);
    expect(result).toEqual({ ok: true, target: { repoSlug: 'acme/app', prNumber: 42 } });
  });

  it.each([
    [{ repo: 'acme/other' }],
    [{ repository: 'acme/other' }],
    [{ prNumber: 99 }],
    [{ pull_number: 99 }],
    [{ number: 99 }],
    [{ repo: 'acme/other', prNumber: 99 }],
  ])('refuses a body naming another pull request: %o', (body) => {
    const result = resolveApprovalTarget(reviewSession(), body);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe('retargeted');
    expect(result.ok === false && result.message).toContain('acme/app#42');
  });

  it('accepts a body that names the session’s own pull request', () => {
    const result = resolveApprovalTarget(reviewSession(), { repo: 'acme/app', prNumber: 42 });
    expect(result).toEqual({ ok: true, target: { repoSlug: 'acme/app', prNumber: 42 } });
  });

  it('refuses a session that is not a review', () => {
    const investigation: Session = migrateV1ToV2({
      schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git' },
      lineage: { pipelineId: 'inv-1', parentSessionId: null, ticket: null },
      stageStatus: 'findings',
    });
    const result = resolveApprovalTarget(investigation, undefined);
    expect(result.ok === false && result.kind).toBe('not-a-review');
  });

  it('refuses a review session with no pull request on it', () => {
    const result = resolveApprovalTarget(reviewSession({ pr: null }), undefined);
    expect(result.ok === false && result.kind).toBe('no-pr');
  });

  it.each(['queued', 'reviewing', 'failed', 'dismissed'] as const)(
    'refuses a review that has not produced a review yet (%s)',
    (stageStatus) => {
      const result = resolveApprovalTarget(reviewSession({ stageStatus }), undefined);
      expect(result.ok === false && result.kind).toBe('not-reviewed');
    },
  );
});
