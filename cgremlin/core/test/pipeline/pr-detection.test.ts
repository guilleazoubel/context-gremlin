import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { GhCommandError } from '../../src/gh/gh-runner';
import { PR_LIST_FIELDS, PR_VIEW_FIELDS } from '../../src/gh/pr-view';
import { detectDevelopmentPr } from '../../src/pipeline/pr-detection';

const DIR = '/sessions/dev-1';
const BRANCH = 'feature/ABC-1';
const SHA = 'b'.repeat(40);
const baseView = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gh/pr-view-open-approved.json'), 'utf8'));

function viewJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...baseView, number: 7, url: 'https://github.com/o/r/pull/7', headRefName: BRANCH, headRefOid: SHA,
    author: { login: 'Me', is_bot: false }, state: 'OPEN', isDraft: true, mergedAt: null, closedAt: null, ...overrides,
  });
}

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 9, url: 'https://github.com/o/r/pull/9', author: { login: 'me' }, isDraft: true, reviewDecision: '',
    headRefOid: SHA, headRefName: BRANCH, baseRefName: 'main', title: 'ABC-1 thing', updatedAt: '2026-10-08T12:00:00Z',
    ...overrides,
  };
}

const LIST_CALL = ['pr', 'list', '--repo', 'o/r', '--head', BRANCH, '--state', 'open', '--json', PR_LIST_FIELDS, '--limit', '5'];

async function setup(prUrl?: string) {
  const fs = new InMemoryFileSystem();
  await fs.mkdir(DIR, { recursive: true });
  if (prUrl !== undefined) await fs.writeFile(`${DIR}/PR_URL`, prUrl);
  const gh = new FakeGhRunner();
  const detect = () => detectDevelopmentPr({ gh, fs, sessionDir: DIR, repoSlug: 'o/r', branch: BRANCH, me: 'me' });
  return { gh, detect };
}

describe('detectDevelopmentPr (R91)', () => {
  it('adopts the PR the agent recorded once gh confirms it is OPEN, in this repo, on this branch, by me (any case)', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7\n');
    gh.queueResponse({ stdout: viewJson() });
    expect(await detect()).toEqual({
      found: true, via: 'PR_URL', isDraft: true,
      pr: { repo: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', headSha: SHA, reviewedSha: null, title: baseView.title, author: 'Me' },
    });
    expect(gh.calls).toEqual([['pr', 'view', '7', '--repo', 'o/r', '--json', PR_VIEW_FIELDS]]);
  });

  it('a stale PR_URL (another branch) is ignored and gh pr list --head decides', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ headRefName: 'feature/OLD-9' }) });
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list', isDraft: true, pr: { number: 9, url: 'https://github.com/o/r/pull/9', headSha: SHA, author: 'me' } });
    expect(gh.calls[1]).toEqual(LIST_CALL);
  });

  it('a PR_URL whose PR is closed is not adopted, and nothing open on the branch means nothing found', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ state: 'CLOSED', closedAt: '2026-10-07T00:00:00Z' }) });
    gh.queueResponse({ stdout: '[]' });
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('is CLOSED');
      expect(result.why).toContain(`no open PR by me has head ${BRANCH}`);
    }
  });

  it('M4 — a same-branch PR by another author is not adopted, by either path', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse({ stdout: viewJson({ author: { login: 'teammate', is_bot: false } }) });
    gh.queueResponse({ stdout: JSON.stringify([listItem({ author: { login: 'teammate' } })]) });
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL #7 is by teammate, not me');
      expect(result.why).toContain(`no open PR by me has head ${BRANCH}`);
    }
  });

  it('a PR_URL naming another repo is never even looked up', async () => {
    const { gh, detect } = await setup('https://github.com/evil/r/pull/7');
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list' });
    expect(gh.calls).toEqual([LIST_CALL]);
  });

  it('a PR_URL that is not a pull request URL falls back to the list', async () => {
    const { gh, detect } = await setup('see https://example.com for the PR');
    gh.queueResponse({ stdout: JSON.stringify([listItem()]) });
    expect(await detect()).toMatchObject({ found: true, via: 'gh pr list' });
  });

  it('two open PRs by me on the branch: not guessing', async () => {
    const { gh, detect } = await setup();
    gh.queueResponse({ stdout: JSON.stringify([listItem(), listItem({ number: 10, url: 'https://github.com/o/r/pull/10' })]) });
    const result = await detect();
    expect(result).toMatchObject({ found: false });
    if (!result.found) expect(result.why).toContain('not guessing');
  });

  it('a list item on a different head is ignored', async () => {
    const { gh, detect } = await setup();
    gh.queueResponse({ stdout: JSON.stringify([listItem({ headRefName: 'feature/ABC-10' })]) });
    expect((await detect()).found).toBe(false);
  });

  it('gh missing or unauthenticated is a reason, never a throw', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    gh.queueResponse(new GhCommandError(['pr', 'view'], null, 'spawn gh ENOENT'));
    gh.queueResponse(new GhCommandError(['pr', 'list'], 4, 'gh auth login required'));
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL unusable');
      expect(result.why).toContain('gh pr list failed');
    }
  });

  it('the reason survives a real gh error: its stderr, not the long --json argument list, reaches the line', async () => {
    const { gh, detect } = await setup('https://github.com/o/r/pull/7');
    const viewArgs = ['pr', 'view', '7', '--repo', 'o/r', '--json', PR_VIEW_FIELDS];
    gh.queueResponse(new GhCommandError(viewArgs, 1, 'HTTP 401: Bad credentials\n(https://api.github.com/graphql)'));
    gh.queueResponse(new GhCommandError(LIST_CALL, 4, '\nTo get started with GitHub CLI, please run:  gh auth login'));
    const result = await detect();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL unusable: gh pr view exited with code 1: HTTP 401: Bad credentials');
      expect(result.why).toContain('gh pr list failed: gh pr list exited with code 4: To get started with GitHub CLI');
      expect(result.why).not.toContain(PR_VIEW_FIELDS);
      expect(result.why).not.toContain('\n');
    }
  });

  it('only ever reads: every gh call is pr view or pr list', async () => {
    const scenarios: Array<{ prUrl?: string; responses: string[] }> = [
      { prUrl: 'https://github.com/o/r/pull/7', responses: [viewJson()] },
      { prUrl: 'https://github.com/o/r/pull/7', responses: [viewJson({ state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z' }), '[]'] },
      { responses: [JSON.stringify([listItem()])] },
    ];
    for (const s of scenarios) {
      const { gh, detect } = await setup(s.prUrl);
      for (const stdout of s.responses) gh.queueResponse({ stdout });
      const result = await detect();
      // `attempts`, not `calls`: a refused mutation never reaches `calls`, and detection turns
      // every gh error into a note, so only the attempt log can see one.
      expect(gh.attempts.length).toBeGreaterThan(0);
      for (const attempt of gh.attempts) expect([['pr', 'view'], ['pr', 'list']]).toContainEqual(attempt.slice(0, 2));
      if (!result.found) expect(result.why).not.toContain('Refusing mutating');
    }
  });

  it('a 1 MB owner segment in PR_URL is capped in the reason, never echoed whole', async () => {
    const { gh, detect } = await setup(`https://github.com/${'a'.repeat(1_000_000)}/r/pull/7`);
    gh.queueResponse({ stdout: '[]' });
    const result = await detect();
    expect(gh.attempts).toEqual([LIST_CALL]);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.why).toContain('PR_URL names aaaa');
      expect(result.why).toContain(`no open PR by me has head ${BRANCH}`);
      expect(result.why.length).toBeLessThan(400);
    }
  });
});
