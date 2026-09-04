import { describe, expect, it } from 'vitest';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { PR_LIST_FIELDS, type PrListItem } from '../../src/gh/pr-view';
import { DefaultPRDiscoveryStrategy } from '../../src/discovery/pr-discovery-strategy';
import type { DiscoveryConfig } from '../../src/discovery/discovery-config';
import { migrateV1ToV2, type Session } from '../../src/schema/session';

function item(overrides: Partial<PrListItem> = {}): PrListItem {
  return {
    number: 1,
    url: 'https://github.com/acme/app/pull/1',
    author: { login: 'guilleazoubel', is_bot: false },
    isDraft: false,
    reviewDecision: '',
    headRefOid: '0'.repeat(40),
    headRefName: 'feature',
    baseRefName: 'main',
    title: 'A PR',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function config(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    repos: ['acme/app'],
    watchAuthors: ['guilleazoubel'],
    me: 'guilleazoubel',
    pollIntervalMs: 60_000,
    prListLimit: 50,
    ...overrides,
  };
}

function prOf(repo: string, number: number) {
  return {
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    headSha: null,
    reviewedSha: null,
    title: null,
    author: null,
  };
}

function reviewSession(id: string, repo: string, number: number): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'review',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'queued',
  });
  return { ...v2, pr: prOf(repo, number) };
}

function developmentSession(id: string, repo: string, number: number): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1,
    id,
    mode: 'development',
    createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'active',
  });
  return { ...v2, pr: prOf(repo, number) };
}

describe('DefaultPRDiscoveryStrategy', () => {
  it('runs the pinned pr list argv per repo, in config order', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: '[]' });
    gh.queueResponse({ stdout: '[]' });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    await strategy.poll(config({ repos: ['acme/app', 'acme/other'], prListLimit: 25 }), { existingSessions: [] });
    expect(gh.calls).toEqual([
      ['pr', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', '25', '--json', PR_LIST_FIELDS],
      ['pr', 'list', '--repo', 'acme/other', '--state', 'open', '--limit', '25', '--json', PR_LIST_FIELDS],
    ]);
  });

  it('drops APPROVED but keeps every other reviewDecision', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({
      stdout: JSON.stringify([
        item({ number: 1, reviewDecision: 'APPROVED' }),
        item({ number: 2, reviewDecision: '' }),
        item({ number: 3, reviewDecision: 'REVIEW_REQUIRED' }),
        item({ number: 4, reviewDecision: 'CHANGES_REQUESTED' }),
      ]),
    });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config(), { existingSessions: [] });
    expect(candidates.map((c) => c.number)).toEqual([2, 3, 4]);
  });

  it('matches the author allowlist case-insensitively and drops an unlisted author', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({
      stdout: JSON.stringify([
        item({ number: 1, author: { login: 'GuilleAzoubel', is_bot: false } }),
        item({ number: 2, author: { login: 'someone-else', is_bot: false } }),
      ]),
    });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config({ watchAuthors: ['guilleazoubel'] }), { existingSessions: [] });
    expect(candidates.map((c) => c.number)).toEqual([1]);
  });

  it("marks own PRs kind:'own' even when draft, drops another author's draft, keeps another author's non-draft as kind:'review'", async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({
      stdout: JSON.stringify([
        item({ number: 1, author: { login: 'guilleazoubel', is_bot: false }, isDraft: true }),
        item({ number: 2, author: { login: 'teammate', is_bot: false }, isDraft: true }),
        item({ number: 3, author: { login: 'teammate', is_bot: false }, isDraft: false }),
      ]),
    });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(
      config({ watchAuthors: ['guilleazoubel', 'teammate'], me: 'guilleazoubel' }),
      { existingSessions: [] },
    );
    expect(candidates).toEqual([
      expect.objectContaining({ number: 1, kind: 'own' }),
      expect.objectContaining({ number: 3, kind: 'review' }),
    ]);
  });

  it('drops a bot-authored PR even when its login is allowlisted', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({
      stdout: JSON.stringify([item({ number: 1, author: { login: 'dependabot', is_bot: true } })]),
    });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config({ watchAuthors: ['dependabot'] }), { existingSessions: [] });
    expect(candidates).toEqual([]);
  });

  it('dedups against a review session with matching repo+number, but not a different repo or a development session', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({
      stdout: JSON.stringify([item({ number: 1 }), item({ number: 2 }), item({ number: 3 })]),
    });
    const existingSessions = [
      reviewSession('pr-app-1-a', 'acme/app', 1),
      reviewSession('pr-other-2-a', 'acme/other-repo', 2),
      developmentSession('dev-1', 'acme/app', 3),
    ];
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config({ repos: ['acme/app'] }), { existingSessions });
    expect(candidates.map((c) => c.number)).toEqual([2, 3]);
  });

  it('does not dedup based on an id prefix that looks like a review session — mode is the only source of truth', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: JSON.stringify([item({ number: 7 })]) });
    const idLikeReview = developmentSession('pr-acme-app-7-20260904', 'acme/app', 7);
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config({ repos: ['acme/app'] }), { existingSessions: [idLikeReview] });
    expect(candidates.map((c) => c.number)).toEqual([7]);
  });

  it('records a per-repo gh failure in lastErrors while still returning candidates from healthy repos, and clears lastErrors on the next successful poll', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse(new Error('gh: repo not found'));
    gh.queueResponse({ stdout: JSON.stringify([item({ number: 9 })]) });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config({ repos: ['acme/broken', 'acme/app'] }), { existingSessions: [] });
    expect(candidates.map((c) => c.number)).toEqual([9]);
    expect(strategy.lastErrors).toEqual([{ repo: 'acme/broken', error: 'gh: repo not found' }]);

    gh.queueResponse({ stdout: '[]' });
    gh.queueResponse({ stdout: '[]' });
    await strategy.poll(config({ repos: ['acme/broken', 'acme/app'] }), { existingSessions: [] });
    expect(strategy.lastErrors).toEqual([]);
  });

  it('returns [] with no errors when a repo has no open PRs', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: '[]' });
    const strategy = new DefaultPRDiscoveryStrategy(gh);
    const candidates = await strategy.poll(config(), { existingSessions: [] });
    expect(candidates).toEqual([]);
    expect(strategy.lastErrors).toEqual([]);
  });
});
