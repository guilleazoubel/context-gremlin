import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeGitRunner } from '../support/fake-git-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { EngineEvents } from '../../src/engine/events';
import { PR_VIEW_FIELDS } from '../../src/gh/pr-view';
import { InvalidPrUrlError } from '../../src/gh/pr-url';
import { ReviewSessionFactory, type ReviewSessionFactoryDeps } from '../../src/pipeline/review-session-factory';
import { migrateV1ToV2, type Session } from '../../src/schema/session';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

const PR_URL = 'https://github.com/aplaceformom/grace-frontend/pull/1614';
const FIXED_NOW = new Date('2026-09-04T12:34:56.000Z');

function harness(overrides: Partial<ReviewSessionFactoryDeps> = {}) {
  const gh = new FakeGhRunner();
  const git = new FakeGitRunner();
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, '/sessions');
  const workspace = new WorkspaceManager(git, fs, '/mirrors');
  const events = new EngineEvents();
  const factory = new ReviewSessionFactory({
    gh, store, workspace, events, sessionsDir: '/sessions', worktreesDir: '/worktrees',
    now: () => FIXED_NOW,
    ...overrides,
  });
  return { gh, git, fs, store, workspace, events, factory };
}

function prOf(repo: string, number: number) {
  return {
    repo, number, url: `https://github.com/${repo}/pull/${number}`,
    headSha: null, reviewedSha: null, title: null, author: null,
  };
}

function developmentSession(id: string, repo: string, number: number, createdAt = '2026-09-01T00:00:00.000Z'): Session {
  const v2 = migrateV1ToV2({
    schemaVersion: 1, id, mode: 'development', createdAt,
    workspace: { repoUrl: 'git@github.com:aplaceformom/grace-frontend.git' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'pr_opened',
  });
  return { ...v2, pr: prOf(repo, number) };
}

describe('ReviewSessionFactory.createFromPrUrl', () => {
  it('runs gh pr view before any git operation', async () => {
    const order: string[] = [];
    const { gh, git, factory } = harness();
    const realGhRun = gh.run.bind(gh);
    gh.run = async (args: string[]) => { order.push('gh'); return realGhRun(args); };
    const realGitRun = git.run.bind(git);
    git.run = async (args: string[], opts: { cwd: string }) => { order.push('git'); return realGitRun(args, opts); };
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });

    await factory.createFromPrUrl(PR_URL);

    expect(order[0]).toBe('gh');
    expect(order.filter((o) => o === 'gh').length).toBe(1);
    expect(order.slice(1).every((o) => o === 'git')).toBe(true);
  });

  it('calls gh pr view with the pinned argv', async () => {
    const { gh, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    await factory.createFromPrUrl(PR_URL);
    expect(gh.calls).toEqual([
      ['pr', 'view', '1614', '--repo', 'aplaceformom/grace-frontend', '--json', PR_VIEW_FIELDS],
    ]);
  });

  it('creates the worktree at worktreesDir/<id> on branch pr-<n> from origin/pr/<n>', async () => {
    const { gh, git, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    const session = await factory.createFromPrUrl(PR_URL);
    expect(session.workspace.worktreePath).toBe(`/worktrees/${session.id}`);
    expect(session.workspace.branch).toBe('pr-1614');
    const worktreeAddCall = git.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(worktreeAddCall?.args).toEqual([
      'worktree', 'add', `/worktrees/${session.id}`, '-b', 'pr-1614', 'origin/pr/1614',
    ]);
  });

  it('builds the review session fields from the mapped PR view, self-rooted, with no existing sessions', async () => {
    const { gh, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    const session = await factory.createFromPrUrl(PR_URL);

    expect(session.schemaVersion).toBe(2);
    expect(session.mode).toBe('review');
    expect(session.stageStatus).toBe('queued');
    expect(session.reviewVersion).toBe(0);
    expect(session.agent).toBeNull();
    expect(session.lastRun).toBeNull();
    expect(session.createdAt).toBe(FIXED_NOW.toISOString());
    expect(session.id).toMatch(/^pr-grace-frontend-1614-\d{8}-\d{6}$/);
    expect(session.lineage).toEqual({ pipelineId: session.id, parentSessionId: null, ticket: null });
    expect(session.pr).toEqual({
      repo: 'aplaceformom/grace-frontend',
      number: 1614,
      url: 'https://github.com/aplaceformom/grace-frontend/pull/1614',
      headSha: 'bec43cdfd87c5daf537e3564907966ef97a25dd1',
      reviewedSha: null,
      title: 'fix(upstash): pass through backend status in process-notification-event [GRAC-1069]',
      author: 'pureawesome',
    });
    expect(session.workspace.repoUrl).toBe('https://github.com/aplaceformom/grace-frontend.git');
  });

  it('links to a development source at pr_opened, supersedes it, and inherits pipelineId/ticket', async () => {
    const { gh, store, factory } = harness();
    const source = developmentSession('dev-1', 'aplaceformom/grace-frontend', 1614);
    await store.save(source);
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });

    const session = await factory.createFromPrUrl(PR_URL);

    expect(session.lineage).toEqual({ pipelineId: 'dev-1', parentSessionId: 'dev-1', ticket: 'APP-1' });
    const reloadedSource = await store.load('dev-1');
    expect(reloadedSource.mode).toBe('development');
    expect(reloadedSource.stageStatus).toBe('superseded');
  });

  it('leaves lineage self-rooted and does not transition anything when there is no matching source', async () => {
    const { gh, store, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    const session = await factory.createFromPrUrl(PR_URL);
    expect(session.lineage).toEqual({ pipelineId: session.id, parentSessionId: null, ticket: null });
    expect(await store.list()).toEqual([session]);
  });

  it('extracts the ticket key from the PR head branch name, legacy-style', async () => {
    const { gh, factory } = harness();
    const raw = JSON.parse(fixture('pr-view-open-approved.json'));
    raw.headRefName = 'feature/APP-1-x';
    gh.queueResponse({ stdout: JSON.stringify(raw) });
    const session = await factory.createFromPrUrl(PR_URL);
    expect(session.lineage.ticket).toBe('APP-1');
  });

  it('saves nothing and transitions nothing when createWorkspace fails', async () => {
    const { gh, git, store, factory } = harness();
    const source = developmentSession('dev-1', 'aplaceformom/grace-frontend', 1614);
    await store.save(source);
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    git.queueResponse(new Error('clone failed: repository not found'));

    await expect(factory.createFromPrUrl(PR_URL)).rejects.toThrow('clone failed');

    const sessions = await store.list();
    expect(sessions).toEqual([source]);
    expect(sessions[0].stageStatus).toBe('pr_opened');
  });

  it('rejects an invalid PR URL without calling gh', async () => {
    const { gh, factory } = harness();
    await expect(factory.createFromPrUrl('https://not-github.com/a/b/pull/1')).rejects.toBeInstanceOf(
      InvalidPrUrlError,
    );
    expect(gh.calls).toEqual([]);
  });

  it('emits session.created with the linked session', async () => {
    const { gh, events, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    let emitted: Session | undefined;
    events.on('session.created', (payload) => { emitted = payload.session; });
    const session = await factory.createFromPrUrl(PR_URL);
    expect(emitted).toEqual(session);
  });
});

describe('ReviewSessionFactory.createFromCandidate', () => {
  it('skips parsePrUrl and uses the candidate repo/number directly', async () => {
    const { gh, factory } = harness();
    gh.queueResponse({ stdout: fixture('pr-view-open-approved.json') });
    const session = await factory.createFromCandidate({
      kind: 'review', repo: 'aplaceformom/grace-frontend', number: 1614,
      url: PR_URL, author: 'pureawesome', isDraft: false, reviewDecision: 'APPROVED',
      headSha: 'bec43cdfd87c5daf537e3564907966ef97a25dd1', title: 'x',
    });
    expect(gh.calls).toEqual([
      ['pr', 'view', '1614', '--repo', 'aplaceformom/grace-frontend', '--json', PR_VIEW_FIELDS],
    ]);
    expect(session.pr?.number).toBe(1614);
  });
});
