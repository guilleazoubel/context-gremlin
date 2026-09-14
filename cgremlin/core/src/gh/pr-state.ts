import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { GhRunner } from './gh-runner';
import { extractTicketKeys } from './ticket-keys';

/**
 * What a PR IS, as opposed to what a review of it decided.
 *
 * The defect this exists for: `InventoryScanner` lists `--state open` only,
 * so a merged PR simply LEAVES the inventory. Everything downstream then saw
 * a `WorkItemPr` built from a session's links alone — every field null — and
 * nothing anywhere said "merged". The panel kept offering `Start review` on
 * a PR that had landed three days earlier.
 *
 * `draft` is an inventory-only state: draftness comes from the open-PR list,
 * never from this leg (a draft PR is by definition still open, so it is in
 * the inventory and never reaches the resolver).
 */
export const PR_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

/**
 * MERGED and CLOSED are FINAL. That is the whole cost control: a PR cached in
 * one of these states is never fetched again, so the steady-state cost of
 * this leg is one `gh pr view` per PR, once, ever.
 */
export function isLandedState(state: PrState | null | undefined): boolean {
  return state === 'merged' || state === 'closed';
}

/** The read-only projection, pinned here so the resolver and its tests cannot drift. */
export const PR_STATE_FIELDS = 'state,mergedAt,closedAt,title,url,headRefName';

const PrStateViewSchema = z.object({
  state: z.string(),
  mergedAt: z.string().nullable().optional(),
  closedAt: z.string().nullable().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  headRefName: z.string().optional(),
});

export interface PrStateEntry {
  state: PrState;
  title: string | null;
  url: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  branch: string | null;
  /**
   * The ticket keys parsed from the PR's BRANCH and TITLE at fetch time —
   * R4's order, minus the body the projection does not fetch. This is the
   * PRIMARY surviving PR→ticket link once the PR has merged: the inventory
   * row that carried `ticketKeys` left with the PR, so without this the
   * merged PR and its ticket render as two unrelated rows — or, once the
   * PR's session has also ended, as a PR row with no ticket at all (R28: an
   * item's id must not flip when its PR leaves the inventory).
   *
   * `feat(HB-1489): add web-content read endpoint to the Grace backend`
   * yields `['HB-1489']`, which is the whole live case.
   */
  ticketKeys: string[];
  checkedAt: string;
}

export type PrStateCache = Record<string, PrStateEntry>;

export function prStateKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

const PrStateEntrySchema = z.object({
  state: z.enum(PR_STATES),
  title: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  mergedAt: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  ticketKeys: z.array(z.string()).default([]),
  checkedAt: z.string(),
});

const PrStateCacheSchema = z.record(z.string(), PrStateEntrySchema);

/** Engine state, never world-readable — the same posture as `attention-acks.json`. */
const PR_STATES_FILE_MODE = 0o600;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** `<stateDir>/pr-states.json`, on `DismissStore`'s shape exactly: tmp-then-rename, 0600, and a malformed file is "nothing cached" rather than a read that throws. */
export class PrStateStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  async load(): Promise<PrStateCache> {
    if (!(await this.fs.exists(this.path))) return {};
    try {
      return PrStateCacheSchema.parse(JSON.parse(await this.fs.readFile(this.path)));
    } catch {
      return {};
    }
  }

  async save(cache: PrStateCache): Promise<void> {
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    // Mode is set on the tmp file before the rename, so the store is never
    // briefly world-readable.
    await this.fs.writeFile(tmpPath, JSON.stringify(cache, null, 2), { mode: PR_STATES_FILE_MODE });
    await this.fs.rename(tmpPath, this.path);
  }
}

/** One PR a session or a lineage names that the open-PR inventory does not have. */
export interface PrStateCandidate {
  repo: string;
  number: number;
}

export interface PrStateScanReport {
  scannedAt: string | null;
  error: string | null;
  fetched: number;
}

export interface PrStateResolverDeps {
  gh: GhRunner;
  store: PrStateStore;
  /** R46 — what a title-derived ticket key is filtered against. Empty disables the linking half entirely. */
  projectKeys?: readonly string[];
  scanBudgetMs?: number;
  now?: () => Date;
}

/** No knob for this one: it is a handful of `gh pr view`s that each terminate on their own. */
const DEFAULT_PR_STATE_BUDGET_MS = 10_000;

/**
 * R34's leg discipline, applied verbatim to a third leg rather than
 * reinvented: it runs AFTER `inventory.updated` is emitted, is not awaited by
 * the tick, is single-flight, is budgeted, records an expiry as an `error`
 * rather than throwing, and leaves the PREVIOUS cache intact on failure. The
 * scan is therefore NEVER blocked by it, and the cache it fills is read by
 * `groupWorkItems` on the next `list()`.
 */
export class PrStateResolver {
  private cache: PrStateCache | null = null;
  private flight: Promise<void> | null = null;
  private report: PrStateScanReport = { scannedAt: null, error: null, fetched: 0 };

  constructor(private readonly deps: PrStateResolverDeps) {}

  inFlight(): Promise<void> | null {
    return this.flight;
  }

  lastReport(): PrStateScanReport {
    return this.report;
  }

  async cached(): Promise<PrStateCache> {
    this.cache ??= await this.deps.store.load();
    return this.cache;
  }

  /** At most ONE `gh pr view` per unknown PR per scan, and none at all for a PR already known to have landed. */
  static needsFetch(previous: PrStateCache, candidate: PrStateCandidate): boolean {
    return !isLandedState(previous[prStateKey(candidate.repo, candidate.number)]?.state);
  }

  run(candidates: readonly PrStateCandidate[]): Promise<void> {
    if (this.flight !== null) return this.flight;
    this.flight = this.scan(candidates).finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async scan(candidates: readonly PrStateCandidate[]): Promise<void> {
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.scanBudgetMs ?? DEFAULT_PR_STATE_BUDGET_MS);
    const previous = await this.cached();
    const next: PrStateCache = { ...previous };
    let fetched = 0;
    let error: string | null = null;
    try {
      for (const candidate of candidates) {
        if (controller.signal.aborted) throw new Error('pr-state scan exceeded its budget');
        if (!PrStateResolver.needsFetch(previous, candidate)) continue;
        const { stdout } = await this.deps.gh.run([
          'pr', 'view', String(candidate.number), '--repo', candidate.repo, '--json', PR_STATE_FIELDS,
        ]);
        next[prStateKey(candidate.repo, candidate.number)] = this.entryOf(stdout, nowIso);
        fetched += 1;
      }
      await this.deps.store.save(next);
      this.cache = next;
    } catch (err) {
      // The previous cache survives untouched.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    this.report = { scannedAt: nowIso, error, fetched };
  }

  private entryOf(stdout: string, checkedAt: string): PrStateEntry {
    const view = PrStateViewSchema.parse(JSON.parse(stdout.trim() === '' ? '{}' : stdout));
    const title = view.title ?? null;
    const branch = view.headRefName ?? null;
    const keys: string[] = [];
    // R4's order — branch, then title — so a merged PR's keys are derived the
    // same way the inventory derived them while the PR was open. The body is
    // not in the projection and is not worth a second call.
    for (const text of [branch ?? '', title ?? '']) {
      for (const key of extractTicketKeys(text, this.deps.projectKeys ?? [])) {
        if (!keys.includes(key)) keys.push(key);
      }
    }
    return {
      state: view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open',
      title,
      url: view.url ?? null,
      mergedAt: view.mergedAt ?? null,
      closedAt: view.closedAt ?? null,
      branch,
      ticketKeys: keys,
      checkedAt,
    };
  }
}
