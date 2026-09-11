import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_THREADS_QUERY,
  ReviewThreadScanner,
  ReviewThreadStore,
  fetchReviewThreads,
  threadCacheKey,
  type ThreadScanCandidate,
} from '../../src/gh/review-threads';
import type { GhRunner } from '../../src/gh/gh-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8');

const RECORDED = 'review-threads-recorded';

/**
 * MG-14 / R55: the fake THROWS on anything that could write to GitHub. The
 * suite being green is the guard — the shared `FakeGhRunner` cannot be used
 * here because it rejects `-f`/`-F`, which every `gh api graphql` call needs.
 */
const MUTATING_PR_VERBS = ['comment', 'review', 'merge', 'edit', 'close', 'ready', 'review-request'];

class FakeGraphqlRunner implements GhRunner {
  readonly calls: string[][] = [];
  private readonly responses: Array<string | Error>;

  constructor(responses: Array<string | Error> = []) {
    this.responses = [...responses];
  }

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (args.some((a) => a.includes('mutation'))) {
      throw new Error(`Refusing a GraphQL mutation: gh ${args.join(' ')}`);
    }
    if (args[0] === 'pr' && MUTATING_PR_VERBS.includes(args[1] ?? '')) {
      throw new Error(`Refusing a mutating gh verb: gh ${args.join(' ')}`);
    }
    if (args.some((a) => a === '-X' || a === '--method')) {
      throw new Error(`Refusing an explicit HTTP method: gh ${args.join(' ')}`);
    }
    this.calls.push(args);
    const next = this.responses.shift();
    if (next === undefined) return { stdout: fixture('review-threads-empty'), stderr: '' };
    if (next instanceof Error) throw next;
    return { stdout: next, stderr: '' };
  }
}

const argValue = (args: string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

describe('the recorded reviewThreads fixture (U5)', () => {
  const recordedPath = path.join(fixturesDir, `${RECORDED}.json`);

  // The plan's escape hatch: if nobody could reach a PR of their own with
  // review comments, the fixture is skipped with a message naming what was
  // looked for, and U5 stays open. It was reachable (aplaceformom/
  // grace-frontend#2037, recorded 2026-09-10), so this runs.
  const describeOrSkip = existsSync(recordedPath) ? describe : describe.skip;

  describeOrSkip('parsed against a real response', () => {
    it('parses the real payload: two threads, two comments each, one bot and one human', async () => {
      const gh = new FakeGraphqlRunner([fixture(RECORDED)]);
      const threads = await fetchReviewThreads(gh, 'aplaceformom/grace-frontend', 2037);
      expect(threads.length).toBe(2);
      expect(threads.every((t) => t.comments.length === 2)).toBe(true);
      expect(threads[0].isResolved).toBe(true);
      expect(threads[0].isOutdated).toBe(true);
      expect(threads[0].path).toContain('format-publication.ts');
      // THE ANSWER TO U5: `line` really is null on an outdated thread, so a
      // non-nullable parse would have thrown on the very first real PR.
      expect(threads[0].line).toBeNull();
      expect(threads[0].truncated).toBe(false);
      const authors = new Set(threads.flatMap((t) => t.comments.map((c) => c.author)));
      expect(authors).toEqual(new Set(['gitstream-cm', 'guilleazoubel']));
    });
  });
});

describe('fetchReviewThreads: the argv and the pagination', () => {
  it('hands the runner `api graphql` with the query, owner, repo and number, and NO cursor on page one', async () => {
    const gh = new FakeGraphqlRunner([fixture('review-threads-empty')]);
    await fetchReviewThreads(gh, 'acme/app', 12);
    const [args] = gh.calls;
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(argValue(args, 'query')).toBe(REVIEW_THREADS_QUERY);
    expect(argValue(args, 'owner')).toBe('acme');
    expect(argValue(args, 'repo')).toBe('app');
    expect(argValue(args, 'number')).toBe('12');
    expect(args.some((a) => a.startsWith('cursor='))).toBe(false);
  });

  it('follows thread pagination via pageInfo.hasNextPage/endCursor, with `cursor` present only on page two', async () => {
    const gh = new FakeGraphqlRunner([fixture('review-threads-page1'), fixture('review-threads-page2')]);
    const threads = await fetchReviewThreads(gh, 'acme/app', 12);
    expect(threads.length).toBe(2);
    expect(gh.calls.length).toBe(2);
    expect(gh.calls[0].some((a) => a.startsWith('cursor='))).toBe(false);
    expect(argValue(gh.calls[1], 'cursor')).toBe('CURSOR_PAGE2');
  });

  it('follows a thread whose comments page reports hasNextPage', async () => {
    const extraComments = JSON.stringify({
      data: {
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                author: { login: 'jane' },
                body: 'a later reply',
                createdAt: '2026-09-10T00:00:00Z',
                url: 'https://github.com/acme/app/pull/12#discussion_r999',
              },
            ],
          },
        },
      },
    });
    const gh = new FakeGraphqlRunner([fixture('review-threads-comments-page2'), extraComments]);
    const threads = await fetchReviewThreads(gh, 'acme/app', 12);
    expect(threads.length).toBe(1);
    expect(threads[0].comments.map((c) => c.author)).toContain('jane');
    expect(threads[0].truncated).toBe(false);
    expect(gh.calls.length).toBe(2);
  });

  it('a thread still truncated at the cap comes back truncated: true rather than silently short', async () => {
    const alwaysMore = JSON.stringify({
      data: {
        node: {
          comments: {
            pageInfo: { hasNextPage: true, endCursor: 'MORE' },
            nodes: [{ author: { login: 'jane' }, body: 'x', createdAt: '2026-09-10T00:00:00Z', url: 'u' }],
          },
        },
      },
    });
    const gh = new FakeGraphqlRunner([
      fixture('review-threads-comments-page2'),
      ...Array.from({ length: 10 }, () => alwaysMore),
    ]);
    const threads = await fetchReviewThreads(gh, 'acme/app', 12);
    expect(threads[0].truncated).toBe(true);
  });
});

describe('MG-14 / R55: nothing here can write to GitHub', () => {
  it('MG-14: the source carries no GraphQL-mutation literal at all', () => {
    const source = readFileSync(path.join(__dirname, '../../src/gh/review-threads.ts'), 'utf8');
    expect(source).not.toContain('mutation');
  });

  it('the fake throws on every mutating verb, and the suite is green anyway', async () => {
    const gh = new FakeGraphqlRunner();
    await expect(gh.run(['pr', 'comment', '12'])).rejects.toThrow('Refusing a mutating gh verb');
    await expect(gh.run(['api', 'graphql', '-f', 'query=mutation{addComment}'])).rejects.toThrow(
      'Refusing a GraphQL mutation',
    );
    await expect(gh.run(['api', '-X', 'POST', '/repos'])).rejects.toThrow('Refusing an explicit HTTP method');
  });
});

describe('ReviewThreadStore', () => {
  it('round-trips tmp-then-rename and leaves no .tmp behind', async () => {
    const fs = new InMemoryFileSystem();
    const store = new ReviewThreadStore(fs, '/state/review-threads.json');
    await store.save({ 'acme/app#12': { updatedAt: 't', threads: [] } });
    expect(await store.load()).toEqual({ 'acme/app#12': { updatedAt: 't', threads: [] } });
    expect((await fs.readdir('/state')).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('an absent or corrupt cache loads as {}, never as a failure', async () => {
    const fs = new InMemoryFileSystem();
    const store = new ReviewThreadStore(fs, '/state/review-threads.json');
    expect(await store.load()).toEqual({});
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/review-threads.json', 'not json{');
    expect(await store.load()).toEqual({});
  });
});

describe('ReviewThreadScanner: the fetch policy and the cache (MG-16)', () => {
  function candidate(over: Partial<ThreadScanCandidate> & { number: number }): ThreadScanCandidate {
    return {
      repo: 'acme/app',
      updatedAt: '2026-09-04T00:00:00.000Z',
      isMine: false,
      isDraft: false,
      hasHumanActivity: false,
      ...over,
    };
  }

  function sixtyPrs(): ThreadScanCandidate[] {
    return Array.from({ length: 60 }, (_, i) =>
      candidate({
        number: i + 1,
        // 10 of mine, 25 teammates already reviewed by a human, 20 untouched,
        // 5 drafts.
        isMine: i < 10,
        hasHumanActivity: i >= 10 && i < 35,
        isDraft: i >= 55,
      }),
    );
  }

  it('one tick over a 60-PR fixture fetches ONLY my open non-draft PRs and untouched parking-lot candidates', async () => {
    const gh = new FakeGraphqlRunner();
    const store = new ReviewThreadStore(new InMemoryFileSystem(), '/state/review-threads.json');
    const scanner = new ReviewThreadScanner({ gh, store, scanBudgetMs: 20_000, now: () => new Date(0) });
    await scanner.run(sixtyPrs());

    const fetchedNumbers = gh.calls.map((args) => Number(argValue(args, 'number')));
    // 1..10 are mine; 36..55 are the untouched teammates'; 11..35 already
    // have human activity and 56..60 are drafts.
    expect(fetchedNumbers).toEqual([
      ...Array.from({ length: 10 }, (_, i) => i + 1),
      ...Array.from({ length: 20 }, (_, i) => i + 36),
    ]);
    expect(scanner.lastReport().fetched).toBe(30);
    expect(scanner.lastReport().error).toBeNull();
  });

  it('a second tick with unchanged updatedAt invokes gh api graphql ZERO times', async () => {
    const gh = new FakeGraphqlRunner();
    const store = new ReviewThreadStore(new InMemoryFileSystem(), '/state/review-threads.json');
    const scanner = new ReviewThreadScanner({ gh, store, scanBudgetMs: 20_000, now: () => new Date(0) });
    await scanner.run(sixtyPrs());
    const after = gh.calls.length;
    await scanner.run(sixtyPrs());
    expect(gh.calls.length).toBe(after);
    expect(scanner.lastReport().fetched).toBe(0);
  });

  it('a changed updatedAt refetches that PR and nothing else', async () => {
    const gh = new FakeGraphqlRunner();
    const store = new ReviewThreadStore(new InMemoryFileSystem(), '/state/review-threads.json');
    const scanner = new ReviewThreadScanner({ gh, store, scanBudgetMs: 20_000, now: () => new Date(0) });
    await scanner.run([candidate({ number: 1, isMine: true }), candidate({ number: 2, isMine: true })]);
    gh.calls.length = 0;
    await scanner.run([
      candidate({ number: 1, isMine: true, updatedAt: '2026-09-05T00:00:00.000Z' }),
      candidate({ number: 2, isMine: true }),
    ]);
    expect(gh.calls.map((a) => argValue(a, 'number'))).toEqual(['1']);
  });

  it('a failing gh call leaves the PREVIOUS cache intact and sets the report error', async () => {
    const fs = new InMemoryFileSystem();
    const store = new ReviewThreadStore(fs, '/state/review-threads.json');
    const good = new ReviewThreadScanner({ gh: new FakeGraphqlRunner([fixture(RECORDED)]), store, scanBudgetMs: 20_000 });
    await good.run([candidate({ number: 1, isMine: true })]);
    const onDisk = await fs.readFile('/state/review-threads.json');

    const bad = new ReviewThreadScanner({
      gh: new FakeGraphqlRunner([new Error('gh exploded')]),
      store,
      scanBudgetMs: 20_000,
    });
    await bad.run([candidate({ number: 2, isMine: true })]);
    expect(bad.lastReport().error).toContain('gh exploded');
    expect(await fs.readFile('/state/review-threads.json')).toBe(onDisk);
  });

  it('is single-flight, and a budget expiry is recorded as an error rather than thrown', async () => {
    let release: (() => void) | undefined;
    const gh: GhRunner = {
      run: async () =>
        new Promise((resolve) => {
          release = (): void => resolve({ stdout: fixture('review-threads-empty'), stderr: '' });
        }),
    };
    const store = new ReviewThreadStore(new InMemoryFileSystem(), '/state/review-threads.json');
    const scanner = new ReviewThreadScanner({ gh, store, scanBudgetMs: 20 });
    const a = scanner.run([candidate({ number: 1, isMine: true }), candidate({ number: 2, isMine: true })]);
    const b = scanner.run([candidate({ number: 1, isMine: true })]);
    expect(scanner.inFlight()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    release?.();
    await Promise.all([a, b]);
    expect(scanner.lastReport().error).toContain('budget');
    expect(scanner.inFlight()).toBeNull();
  });

  it('threadCacheKey is "<repo>#<n>"', () => {
    expect(threadCacheKey('acme/app', 12)).toBe('acme/app#12');
  });
});
