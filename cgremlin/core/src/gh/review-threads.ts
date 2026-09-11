import type { SessionFileSystem } from '../fs/session-file-system';
import type { GhRunner } from './gh-runner';

/**
 * R52 — the engine's FIRST GraphQL call. It goes through the existing
 * `GhRunner` (`gh api graphql`), so there is no new port, no new process
 * spawner and no new fake.
 *
 * R55: this file is read-only forever — every query here is a `query`, never
 * the other GraphQL operation kind, and MG-14's source grep is what keeps it
 * that way. The legacy `--reply-comment`/`--resolve-comment`/`--push-fix`
 * verbs are deliberately not ported.
 */
export interface ReviewThreadComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** True when the thread still had more comments after the cap — marked, never silently short. */
  truncated: boolean;
  comments: ReviewThreadComment[];
}

/**
 * The legacy query (`bin/cgremlin:14776-14787`) widened from
 * `comments(first:1)` to `comments(first:100)` ON PURPOSE: the truncation is
 * exactly why the old brief had to reconcile replies by hand.
 */
export const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line
          comments(first:100){
            pageInfo{ hasNextPage }
            nodes{ author{ login } body createdAt url }
          }
        }
      }
    }
  }
}`;

/** Follows one thread's comments past the first page, addressed by its node id. */
export const THREAD_COMMENTS_QUERY = `query($id:ID!,$cursor:String){
  node(id:$id){
    ... on PullRequestReviewThread {
      comments(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ author{ login } body createdAt url }
      }
    }
  }
}`;

/** Page caps, so a pathological PR cannot spin forever against the rate limit. */
export const MAX_THREAD_PAGES = 5;
export const MAX_COMMENT_PAGES = 5;

interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  createdAt?: string;
  url?: string;
}

interface RawThread {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawComment[] };
}

function mapComment(raw: RawComment): ReviewThreadComment {
  return {
    author: raw.author?.login ?? 'unknown',
    body: raw.body ?? '',
    createdAt: raw.createdAt ?? '',
    url: raw.url ?? '',
  };
}

export interface FetchReviewThreadsOptions {
  signal?: AbortSignal;
}

/**
 * `repo` is `owner/name`. Returns every thread on the PR, each carrying every
 * comment the caps allow, oldest-first within the thread.
 */
export async function fetchReviewThreads(
  gh: GhRunner,
  repo: string,
  number: number,
  opts: FetchReviewThreadsOptions = {},
): Promise<ReviewThread[]> {
  const [owner, name] = repo.split('/');
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    if (opts.signal?.aborted === true) throw new Error('review-thread fetch aborted');
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${name}`,
      '-F',
      `number=${number}`,
      // `cursor` is present ONLY from page two, so the first request is the
      // plain unpaged one GitHub expects.
      ...(cursor === null ? [] : ['-F', `cursor=${cursor}`]),
    ];
    const { stdout } = await gh.run(args);
    const parsed = JSON.parse(stdout.trim() === '' ? '{}' : stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawThread[] };
          } | null;
        } | null;
      };
    };
    const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
    for (const raw of connection?.nodes ?? []) {
      threads.push(await hydrate(gh, raw, opts));
    }
    if (connection?.pageInfo?.hasNextPage !== true) return threads;
    const next = connection.pageInfo.endCursor ?? null;
    if (next === null) return threads;
    cursor = next;
  }
  return threads;
}

async function hydrate(gh: GhRunner, raw: RawThread, opts: FetchReviewThreadsOptions): Promise<ReviewThread> {
  const comments = (raw.comments?.nodes ?? []).map(mapComment);
  let truncated = false;
  if (raw.comments?.pageInfo?.hasNextPage === true && raw.id !== undefined) {
    let cursor: string | null = null;
    let page = 0;
    for (; page < MAX_COMMENT_PAGES; page += 1) {
      if (opts.signal?.aborted === true) throw new Error('review-thread fetch aborted');
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${THREAD_COMMENTS_QUERY}`,
        '-F',
        `id=${raw.id}`,
        ...(cursor === null ? [] : ['-F', `cursor=${cursor}`]),
      ];
      const { stdout } = await gh.run(args);
      const parsed = JSON.parse(stdout.trim() === '' ? '{}' : stdout) as {
        data?: { node?: { comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawComment[] } } | null };
      };
      const connection = parsed.data?.node?.comments;
      for (const c of connection?.nodes ?? []) {
        if (!comments.some((existing) => existing.url === c.url && existing.createdAt === c.createdAt)) {
          comments.push(mapComment(c));
        }
      }
      if (connection?.pageInfo?.hasNextPage !== true) break;
      cursor = connection.pageInfo.endCursor ?? null;
      if (cursor === null) break;
    }
    // Still more after the cap: SAY so rather than come back silently short.
    if (page >= MAX_COMMENT_PAGES) truncated = true;
  }
  return {
    id: raw.id ?? '',
    isResolved: raw.isResolved ?? false,
    isOutdated: raw.isOutdated ?? false,
    path: raw.path ?? null,
    line: raw.line ?? null,
    truncated,
    comments,
  };
}

// ---------------------------------------------------------------------------
// The cache. `<stateDir>/review-threads.json`, keyed "<repo>#<n>" with the
// PR's `updatedAt` recorded beside the threads: a PR whose `updatedAt` is
// unchanged since the cached entry is NEVER refetched, and that is the whole
// cost control (R52, MG-16).
// ---------------------------------------------------------------------------

export interface ReviewThreadCacheEntry {
  updatedAt: string;
  threads: ReviewThread[];
}

export type ReviewThreadCache = Record<string, ReviewThreadCacheEntry>;

export const threadCacheKey = (repo: string, number: number): string => `${repo}#${number}`;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export class ReviewThreadStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  async save(cache: ReviewThreadCache): Promise<void> {
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(cache, null, 2));
    await this.fs.rename(tmpPath, this.path);
  }

  async load(): Promise<ReviewThreadCache> {
    if (!(await this.fs.exists(this.path))) return {};
    try {
      const parsed: unknown = JSON.parse(await this.fs.readFile(this.path));
      return parsed !== null && typeof parsed === 'object' ? (parsed as ReviewThreadCache) : {};
    } catch {
      // A corrupt cache degrades to "nothing cached", never to a failed scan.
      return {};
    }
  }
}

export interface ThreadScanReport {
  scannedAt: string | null;
  error: string | null;
  fetched: number;
}

/** The minimum of an inventory row this leg needs; keeps it free of the inventory module. */
export interface ThreadScanCandidate {
  repo: string;
  number: number;
  updatedAt: string;
  isMine: boolean;
  isDraft: boolean;
  /** True when reviews + conversation comments ALREADY prove a human is on it. */
  hasHumanActivity: boolean;
}

export interface ReviewThreadScannerDeps {
  gh: GhRunner;
  store: ReviewThreadStore;
  scanBudgetMs: number;
  now?: () => Date;
}

/**
 * R34's leg discipline, applied verbatim to a second leg rather than
 * reinvented: it runs after `inventory.updated` is emitted, is not awaited by
 * the tick, is single-flight, is aborted by one `AbortController` at
 * `reviewThreads.scanBudgetMs`, records an expiry as an `error` rather than
 * throwing, and leaves the PREVIOUS cache intact on failure.
 */
export class ReviewThreadScanner {
  private cache: ReviewThreadCache | null = null;
  private flight: Promise<void> | null = null;
  private report: ThreadScanReport = { scannedAt: null, error: null, fetched: 0 };

  constructor(private readonly deps: ReviewThreadScannerDeps) {}

  inFlight(): Promise<void> | null {
    return this.flight;
  }

  lastReport(): ThreadScanReport {
    return this.report;
  }

  /** The cached threads, for `buildEntries` to fold into `humanActivity` on the NEXT tick. */
  async cached(): Promise<ReviewThreadCache> {
    this.cache ??= await this.deps.store.load();
    return this.cache;
  }

  /**
   * R52's fetch policy, decided because "threads for all 58 PRs every tick"
   * is the cost risk: only MY open non-draft PRs (they feed
   * `waitingForReview` and the respond brief) and a parking-lot candidate
   * whose `humanActivity` is EMPTY from reviews and comments alone — the only
   * case where a thread comment could change the answer. A PR that already
   * has human activity needs no thread call to stay demoted.
   */
  static needsFetch(candidate: ThreadScanCandidate): boolean {
    if (candidate.isDraft) return false;
    if (candidate.isMine) return true;
    return !candidate.hasHumanActivity;
  }

  run(candidates: readonly ThreadScanCandidate[]): Promise<void> {
    if (this.flight !== null) return this.flight;
    this.flight = this.scan(candidates).finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async scan(candidates: readonly ThreadScanCandidate[]): Promise<void> {
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.scanBudgetMs);
    const previous = await this.cached();
    const next: ReviewThreadCache = { ...previous };
    let fetched = 0;
    let error: string | null = null;
    try {
      for (const candidate of candidates) {
        if (controller.signal.aborted) throw new Error('review-thread scan exceeded its budget');
        if (!ReviewThreadScanner.needsFetch(candidate)) continue;
        const key = threadCacheKey(candidate.repo, candidate.number);
        // The whole cost control: an unchanged `updatedAt` is never refetched.
        if (previous[key]?.updatedAt === candidate.updatedAt) continue;
        const threads = await fetchReviewThreads(this.deps.gh, candidate.repo, candidate.number, {
          signal: controller.signal,
        });
        next[key] = { updatedAt: candidate.updatedAt, threads };
        fetched += 1;
      }
      await this.deps.store.save(next);
      this.cache = next;
    } catch (err) {
      // The previous cache survives untouched (MG-6's shape).
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    this.report = { scannedAt: nowIso, error, fetched };
  }
}
