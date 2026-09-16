import type { GhRunner } from '../gh/gh-runner';
import { PR_SEARCH_FIELDS } from '../gh/pr-state';
import type { KeyedLock } from '../api/keyed-lock';
import type { WorkItem, WorkItemPr } from '../work/work-item';
import { QaTriggerStore, qaIdentityOf, type QaAttempt } from './qa-trigger-store';

export interface QaScanReport {
  scannedAt: string | null;
  /** Session ids this tick actually started. */
  started: string[];
  /** Every refusal, WITH its reason. Never an `errors` entry: a claimed session must not file an error every poll. */
  skipped: Array<{ ticket: string; why: string }>;
  errors: Array<{ ticket: string; error: string }>;
  /**
   * Configuration problems the leg can SEE but cannot fix — today, exactly
   * one: a `jira.qaStatuses` entry that Jira classifies as `Done`. The
   * default JQL is `statusCategory != Done`, so such a ticket never appears
   * in the snapshot at all and the trigger can never fire for it. It is a
   * warning, not an error: nothing is broken, the user has to widen either
   * `qaStatuses` or `jira.jql`.
   */
  warnings: string[];
}

export interface QaTriggerConfig {
  autoVerify: boolean;
  maxAutoStartsPerTick: number;
  maxAttemptsPerEntry: number;
  scanBudgetMs: number;
  /** R77 as amended: a cold record is a SEED, not an entry, unless this is on. */
  backfillOnFirstRun: boolean;
  qaStatuses: readonly string[];
}

export interface QaTriggerDeps {
  gh: GhRunner;
  store: QaTriggerStore;
  /** buildEngine's ONE shared lock — the same instance the API server and the pipeline hold. */
  lock: KeyedLock;
  /** A thunk: `workItems` is built after the scanner, and `list()` takes no session lock. */
  items: () => readonly WorkItem[] | Promise<readonly WorkItem[]>;
  /** E5: `ok:false` (a Jira outage) means this tick reads nothing, writes nothing and starts nothing. */
  jira: () => { ok: boolean; me: string | null } | Promise<{ ok: boolean; me: string | null }>;
  config: QaTriggerConfig;
  qaFor: (repoSlug: string) => { hasUrl: boolean; hasTestIdentity: boolean };
  qaHealth: (repoSlug: string) => Promise<{ ok: boolean; reason: string | null }>;
  /**
   * Phase 16 — the commit sha of the build QA is actually SERVING, or null
   * when the repo's QA will not say. Optional, and a null answer degrades the
   * whole leg to Phase 15's merge-keyed behaviour (said once per repo in the
   * log): a repo without a version endpoint must keep working, not stop.
   * Called at most once per repo per tick.
   */
  qaVersion?: (repoSlug: string) => Promise<string | null>;
  /** `git merge-base --is-ancestor` in the repo mirror — is this merge in that build? */
  isAncestor?: (repoSlug: string, sha: string, deployedSha: string) => Promise<boolean>;
  /** One line per degraded repo. Defaults to `console.warn`, which the engine log captures. */
  log?: (line: string) => void;
  sessions: {
    existingFor: (ticket: string) => Promise<{ id: string; stageStatus: string; claimed?: boolean } | null>;
    activeSessionIds: () => readonly string[];
  };
  /** R78/E7 — stop the run, then transition to `closed`, once the ticket reaches Done. */
  stopSession?: (sessionId: string) => Promise<void>;
  closeSession?: (sessionId: string) => Promise<void>;
  /** R84 — the repos that have a `qa.url`, for a ticket whose PR the engine never saw. */
  qaRepos?: () => readonly string[];
  /**
   * Phase 18 — where the rows of a `gh pr list --search` are WRITTEN: the pr-state cache, which
   * is what makes `/items` re-evaluate without any further gh call. Optional: a wiring without
   * it still searches, it just forgets what it found between ticks.
   */
  absorbPrs?: (repo: string, stdout: string) => Promise<void>;
  createSession: (ticket: string, slug: string, number: number) => Promise<{ id: string }>;
  startRun: (sessionId: string) => Promise<void>;
  now?: () => Date;
}

/**
 * Phase 18 — what ONE manual discovery did. `searched: false` is never an error: it is the
 * bound doing its job (a scan in flight, an entry already searched, no repo to search).
 */
export interface QaDiscoverResult {
  searched: boolean;
  /** The repos a `gh pr list --search` actually ran against, in order. */
  repos: string[];
  found: Array<{ repo: string; number: number }>;
  /** One sentence for the panel — why nothing ran, or that nothing was found. */
  reason: string | null;
}

/** One surviving candidate, before any network call has been made for it. */
interface Candidate {
  item: WorkItem;
  key: string;
  status: string;
  slug: string;
  prs: WorkItemPr[];
  updatedAt: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * E7(a) — the trap that makes the whole leg silently inert. The default JQL
 * is `assignee = currentUser() AND statusCategory != Done`, so a QA status
 * that Jira classifies as `Done` means the ticket never appears in the
 * snapshot at all and the trigger can never fire for it. Nothing is broken,
 * so this is a WARNING: the user has to widen `qaStatuses` or `jira.jql`.
 *
 * Shared by the leg (which puts it on `ScanReport.qa.warnings`) and by the
 * boot path (which logs it), so there is one wording.
 */
export function doneCategoryWarnings(
  qaStatuses: readonly string[],
  tickets: readonly { status: string; statusCategory: string }[],
): string[] {
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const ticket of tickets) {
    if (ticket.statusCategory !== 'Done') continue;
    if (!qaStatuses.includes(ticket.status)) continue;
    if (seen.has(ticket.status)) continue;
    seen.add(ticket.status);
    warnings.push(
      `jira.qaStatuses contains '${ticket.status}', which Jira classifies as statusCategory 'Done'. ` +
        `The default JQL excludes Done, so tickets in that status never reach the snapshot and the QA trigger can never fire for them. ` +
        `Remove it from jira.qaStatuses, or widen jira.jql.`,
    );
  }
  return warnings;
}

/**
 * R34's leg discipline, applied to the ONLY new agent-start path: it runs
 * after `inventory.updated`, is not awaited by the tick, is single-flight,
 * and is budgeted — but the budget bounds CANDIDATE SELECTION AND THE GH
 * CALLS ONLY. It never cancels a run that has started; the run's own
 * lifecycle owns that.
 *
 * Steady state costs ZERO extra calls: every gate below reads only the Jira
 * snapshot and the work items the tick already has.
 */
export class QaTriggerLeg {
  private flight: Promise<void> | null = null;
  /** Phase 16 — one `qaVersion` call per repo per TICK, cleared at the top of every scan. */
  private deployed = new Map<string, string | null>();
  /** The repos already told about, so the degradation is said once, not every tick. */
  private readonly degraded = new Set<string>();
  private report: QaScanReport = { scannedAt: null, started: [], skipped: [], errors: [], warnings: [] };

  constructor(private readonly deps: QaTriggerDeps) {}

  inFlight(): Promise<void> | null {
    return this.flight;
  }

  lastReport(): QaScanReport {
    return this.report;
  }

  run(): Promise<void> {
    if (this.flight !== null) return this.flight;
    this.flight = this.scan().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  /**
   * E3b — the candidates that survive the cheap gates, SORTED (ticket
   * `updated` desc, ties on key) and SLICED to `maxAutoStartsPerTick` before
   * a single network call is made. Six tickets entering QA on one tick
   * therefore cost one `gh pr view`, not six.
   */
  private select(items: readonly WorkItem[], jiraMe: string): { taken: Candidate[]; seed: Candidate[] } {
    const { config, qaFor } = this.deps;
    const seed: Candidate[] = [];
    for (const item of items) {
      const ticket = item.ticket;
      // E5: an absent ticket, an empty status, or a ticket that is not mine
      // is not a candidate and is not even observed.
      if (ticket === null || ticket.status === '' || ticket.assignee !== jiraMe) continue;
      if (!config.qaStatuses.includes(ticket.status)) {
        // Still observed: leaving QA must update `lastStatus` so a later
        // re-entry is a real transition.
        seed.push(this.candidateOf(item, ticket.key, ticket.status, ticket.updatedAt));
        continue;
      }
      const slugs = new Set(item.prs.map((pr) => pr.repo));
      if (item.prs.length > 0 && slugs.size > 1) {
        this.skip(ticket.key, 'item spans repos');
        seed.push(this.candidateOf(item, ticket.key, ticket.status, ticket.updatedAt));
        continue;
      }
      // R84 — a ticket whose PR was merged without a cgremlin session has no
      // PRs at all. It is still a candidate when exactly one configured repo
      // has a `qa.url`; anything ambiguous is left to the manual click.
      const qaRepos = this.deps.qaRepos?.() ?? [];
      const slug =
        item.prs[0]?.repo ??
        item.agents.find((a) => a.repo !== null)?.repo ??
        (qaRepos.length === 1 ? qaRepos[0] : null);
      if (slug === null || !qaFor(slug).hasUrl) {
        seed.push(this.candidateOf(item, ticket.key, ticket.status, ticket.updatedAt));
        continue;
      }
      seed.push({ item, key: ticket.key, status: ticket.status, slug, prs: [...item.prs], updatedAt: ticket.updatedAt });
    }
    const taken = seed
      .filter((c) => config.qaStatuses.includes(c.status) && c.slug !== '')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
    return { taken, seed };
  }

  private candidateOf(item: WorkItem, key: string, status: string, updatedAt: string): Candidate {
    return { item, key, status, slug: '', prs: [], updatedAt };
  }

  private skip(ticket: string, why: string): void {
    this.report.skipped.push({ ticket, why });
  }

  /**
   * E8 — a `verifying` session whose id is NOT in `activeSessionIds()` is a
   * session the engine died under, not coverage. Counting it would wedge the
   * ticket forever; a boot sweep moves it to `failed`, which is runnable and
   * already raises `run_failed`.
   */
  private async coverage(key: string): Promise<{ blocked: boolean; reuse: string | null }> {
    const existing = await this.deps.sessions.existingFor(key);
    if (existing === null) return { blocked: false, reuse: null };
    if (this.deps.sessions.activeSessionIds().includes(existing.id)) {
      this.skip(key, 'a qa run is already in flight');
      return { blocked: true, reuse: null };
    }
    // E8 — a `verifying` session nothing is running is a session the engine
    // died under, not coverage and not something to re-run: a boot sweep
    // moves it to `failed`, and a fresh session is the honest recovery.
    if (existing.stageStatus === 'verifying') return { blocked: false, reuse: null };
    if (existing.claimed === true) {
      this.skip(key, 'a human holds the conversation claim on the qa session');
      return { blocked: true, reuse: null };
    }
    // Phase 16 — the session is REUSED rather than blocking: a new deployed
    // build is a new question, and `runVerify` archives the previous QA.md to
    // `QA-v<n>.md` before it starts, so the earlier verdict stays readable.
    // The identity gate above is what makes this at most once per build.
    return { blocked: false, reuse: existing.id };
  }

  /**
   * E2/E9 — reserve, THEN run, under the SAME `KeyedLock` key the manual
   * route takes (`pr:<slug>#<n>`, or `ticket:<KEY>` for a PR-less item). A
   * private `qa:` namespace would be a different key, so a tick and a manual
   * POST would both pass their own lock and both create.
   *
   * The attempt record is written BEFORE the session, so a crash between the
   * reserve and `run.started` leaves a record whose `attempt` has already hit
   * the cap and the leg never auto-retries.
   */
  private async start(
    candidate: Candidate,
    ordinal: number,
    state: { tickets: Record<string, unknown> },
    reuse: string | null = null,
  ): Promise<boolean> {
    const { config, store, gh } = this.deps;
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();
    const pr = candidate.prs[0];
    const lockKey = pr === undefined ? `ticket:${candidate.key}` : `pr:${pr.repo}#${pr.number}`;

    // The merge shas — one `gh pr view` per PR on this ONE item (or R84's
    // ONE `gh pr list --search` when the engine has never seen a PR for it),
    // made only after the slice, so the per-tick ceiling is per slice, not
    // per candidate.
    const merged: Array<{ repo: string; number: number; mergeSha: string }> = [];
    if (candidate.prs.length === 0) {
      const found = await this.searchMergedPrs(candidate, ordinal);
      if (found === null) return false;
      merged.push(...found);
    }
    for (const item of candidate.prs) {
      const { stdout } = await gh.run([
        'pr', 'view', String(item.number), '--repo', item.repo, '--json', 'mergeCommit,mergedAt,state',
      ]);
      const view = JSON.parse(stdout) as { mergeCommit?: { oid: string } | null };
      const oid = view.mergeCommit?.oid ?? null;
      if (oid === null) {
        this.skip(candidate.key, `pr ${item.repo}#${item.number} has no merge commit`);
        return false;
      }
      merged.push({ repo: item.repo, number: item.number, mergeSha: oid });
    }
    // Phase 16 — merging is not deploying. When QA says which build it is
    // serving, a candidate qualifies only once EVERY merge commit is an
    // ancestor of that build; until then the ticket waits, and the record of
    // that wait is what keeps the next tick from re-asking gh.
    const deployedSha = await this.deployedSha(candidate.slug);
    if (deployedSha !== null && !(await this.inQaBuild(candidate, merged, deployedSha))) {
      await store.reserve({
        key: candidate.key,
        identity: qaIdentityOf(merged, deployedSha),
        ordinal,
        attempt: 1,
        reservedAt: nowIso,
        sessionId: null,
        outcome: 'awaiting-deploy',
      });
      this.skip(candidate.key, `the change is not in the qa build yet (${deployedSha.slice(0, 7)})`);
      return false;
    }
    const identity = qaIdentityOf(merged, deployedSha);
    const fresh = await store.load();
    if (QaTriggerStore.attemptsFor(fresh, candidate.key, identity, ordinal) >= config.maxAttemptsPerEntry) {
      this.skip(candidate.key, 'qa attempt abandoned — click Verify in QA');
      return false;
    }

    // R83 — health BEFORE the factory: no session, no worktree, no tokens
    // burned on an agent turn that can only write "blocked".
    const health = await this.deps.qaHealth(candidate.slug);
    const attempt: QaAttempt = {
      key: candidate.key,
      identity,
      ordinal,
      attempt: QaTriggerStore.attemptsFor(fresh, candidate.key, identity, ordinal) + 1,
      reservedAt: nowIso,
      sessionId: null,
      outcome: health.ok ? 'reserved' : 'unreachable',
    };
    await store.reserve(attempt);
    if (!health.ok) {
      this.skip(candidate.key, `qa unreachable — ${health.reason ?? 'unknown'}`);
      return false;
    }
    void state;

    return this.deps.lock.withLock(lockKey, async () => {
      let sessionId: string;
      try {
        sessionId =
          reuse ?? (await this.deps.createSession(candidate.key, merged[0].repo, merged[0].number)).id;
      } catch (err) {
        await store.patch(candidate.key, nowIso, { outcome: 'create-failed' });
        this.skip(candidate.key, `qa session could not be created — ${errorMessage(err)}`);
        return false;
      }
      await store.patch(candidate.key, nowIso, { sessionId, outcome: 'started' });
      try {
        await this.deps.startRun(sessionId);
      } catch (err) {
        this.skip(candidate.key, `qa run could not be started — ${errorMessage(err)}`);
        return false;
      }
      this.report.started.push(sessionId);
      return true;
    });
  }

  /**
   * R78/E7 — a ticket reaching `statusCategory: 'Done'` closes its QA
   * session; otherwise a `ready` session pins the item in `myWork` forever.
   * It goes through `stop` then a real transition, never a direct save, and
   * a CLAIMED session is left alone and reported: a claim delays our
   * housekeeping, never the truth about the ticket.
   *
   * MG-38: a session with no `lineage.ticket` is never reached from here,
   * because `existingFor` is keyed on the ticket.
   */
  /**
   * E7(a) — the trap that makes the whole leg silently inert: a QA status
   * Jira classifies as `Done` is filtered out by the default JQL, so the
   * ticket never reaches the snapshot and nothing can ever fire. Warned once
   * per STATUS, not once per ticket.
   */
  private warnAboutDoneStatuses(items: readonly WorkItem[]): void {
    this.report.warnings.push(
      ...doneCategoryWarnings(
        this.deps.config.qaStatuses,
        items.map((item) => item.ticket).filter((t): t is NonNullable<typeof t> => t !== null),
      ),
    );
  }

  private async closeDoneTickets(items: readonly WorkItem[], jiraMe: string): Promise<void> {
    if (this.deps.closeSession === undefined) return;
    for (const item of items) {
      const ticket = item.ticket;
      if (ticket === null || ticket.statusCategory !== 'Done' || ticket.assignee !== jiraMe) continue;
      const existing = await this.deps.sessions.existingFor(ticket.key);
      if (existing === null) continue;
      if (existing.claimed === true) {
        this.skip(ticket.key, 'ticket is Done but a human holds the conversation claim — left open');
        continue;
      }
      try {
        await this.deps.stopSession?.(existing.id);
        await this.deps.closeSession(existing.id);
      } catch (err) {
        this.skip(ticket.key, `could not close the qa session — ${errorMessage(err)}`);
      }
    }
  }

  /**
   * R84/E10 — ONE `gh pr list --search` for a ticket whose PRs the engine has
   * never seen. Bounded by the same once-per-`(key, identity, ordinal)`
   * attempt record as everything else, so zero matches means one search and
   * no retry until the next entry.
   */
  private async searchMergedPrs(
    candidate: Candidate,
    ordinal: number,
  ): Promise<Array<{ repo: string; number: number; mergeSha: string }> | null> {
    const merged = await this.searchRepo(candidate.key, candidate.slug, ordinal);
    if (merged.length === 0) {
      this.skip(candidate.key, `no merged pr for ${candidate.key}`);
      return null;
    }
    return merged;
  }

  /** The per-entry record that stops one `(ticket, repo, ordinal)` being searched twice. */
  private static searchIdentity(slug: string): string {
    return `search:${slug}`;
  }

  /**
   * The ONE `gh pr list --search`, shared by the automatic leg and the manual route (Phase 18).
   *
   * It writes the rows into the pr-state cache on the way past, which is what lets `/items`
   * re-evaluate the ticket with no further gh call, and it records the attempt WHATEVER it
   * found — that record is the whole bound.
   */
  private async searchRepo(
    key: string,
    slug: string,
    ordinal: number,
  ): Promise<Array<{ repo: string; number: number; mergeSha: string }>> {
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();
    const { stdout } = await this.deps.gh.run([
      'pr', 'list', '--repo', slug, '--search', key, '--state', 'merged',
      '--json', PR_SEARCH_FIELDS,
    ]);
    let rows: Array<{ number: number; mergeCommit?: { oid: string } | null }> = [];
    try {
      const parsed: unknown = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
      if (Array.isArray(parsed)) rows = parsed as typeof rows;
    } catch {
      rows = [];
    }
    const merged = rows
      .filter((row) => typeof row.mergeCommit?.oid === 'string')
      .map((row) => ({ repo: slug, number: row.number, mergeSha: row.mergeCommit!.oid }));
    if (merged.length > 0) await this.deps.absorbPrs?.(slug, stdout);
    await this.deps.store.reserve({
      key,
      identity: QaTriggerLeg.searchIdentity(slug),
      ordinal,
      attempt: 1,
      reservedAt: nowIso,
      sessionId: null,
      // Zero matches keeps the wording the leg has always recorded, so the panel's
      // abandoned-attempt token means exactly what it did before.
      outcome: merged.length === 0 ? 'create-failed' : 'reserved',
    });
    return merged;
  }

  /**
   * Phase 18 — the manual leg of R84's lookup: `POST /items/ticket/<KEY>/prs/discover`.
   *
   * A ticket in a QA status with no PR the engine has ever seen is the user's NORMAL case (his
   * teammates merge without cgremlin sessions), and the automatic leg only reaches it when
   * exactly one repo could hold it. This is the same search, asked deliberately, and bounded the
   * same three ways: once per `(ticket, repo, ordinal)`, inside the scan budget, and never while
   * a tick is in flight — a tick that has already spent its gh call must not have a second spent
   * behind its back.
   *
   * Where the ticket names no repo of its own it walks the configured QA repos IN ORDER and
   * stops at the first that answers, so the common case is still exactly one call.
   */
  async discover(key: string): Promise<QaDiscoverResult> {
    const nothing = (reason: string): QaDiscoverResult => ({ searched: false, repos: [], found: [], reason });
    if (this.flight !== null) return nothing('A QA scan is already running — try again in a moment.');
    const items = await this.deps.items();
    const item = items.find((candidate) => candidate.ticket?.key === key);
    const named =
      item?.prs[0]?.repo ?? item?.agents.find((agent) => agent.repo !== null)?.repo ?? null;
    const repos = named === null ? [...(this.deps.qaRepos?.() ?? [])] : [named];
    if (repos.length === 0) {
      return nothing('No repo is configured with a QA environment to search.');
    }
    const state = await this.deps.store.load();
    const ordinal = state.tickets[key]?.ordinal ?? 0;
    const budgetUntil = Date.now() + this.deps.config.scanBudgetMs;
    const searched: string[] = [];
    const found: Array<{ repo: string; number: number }> = [];
    for (const slug of repos) {
      if (Date.now() > budgetUntil) break;
      const already = (state.tickets[key]?.attempts ?? []).some(
        (attempt) =>
          attempt.identity === QaTriggerLeg.searchIdentity(slug) && attempt.ordinal === ordinal,
      );
      if (already) continue;
      searched.push(slug);
      const merged = await this.searchRepo(key, slug, ordinal);
      found.push(...merged.map((pr) => ({ repo: pr.repo, number: pr.number })));
      if (found.length > 0) break;
    }
    if (searched.length === 0) {
      return nothing('This ticket has already been searched for — nothing new to look up.');
    }
    return {
      searched: true,
      repos: searched,
      found,
      reason: found.length === 0 ? `No merged pull request mentions ${key}.` : null,
    };
  }

  /**
   * The build QA is serving, cached for the whole tick. `null` means this
   * repo will not say — Phase 15's merge-keyed behaviour, announced once.
   */
  private async deployedSha(slug: string): Promise<string | null> {
    const cached = this.deployed.get(slug);
    if (cached !== undefined) return cached;
    let sha: string | null = null;
    try {
      sha = (await this.deps.qaVersion?.(slug)) ?? null;
    } catch {
      sha = null;
    }
    this.deployed.set(slug, sha);
    if (sha === null && !this.degraded.has(slug)) {
      this.degraded.add(slug);
      (this.deps.log ?? ((line: string) => console.warn(line)))(
        `qa-trigger ${slug}: QA does not report a deployed version (qa.versionPath / qa.versionField) — ` +
          'verification stays keyed on the MERGE, so it can run before the change is in QA.',
      );
    }
    return sha;
  }

  /** Every merge commit an ancestor of the deployed build, through the mirror. */
  private async inQaBuild(
    candidate: Candidate,
    merged: readonly { mergeSha: string }[],
    deployedSha: string,
  ): Promise<boolean> {
    const isAncestor = this.deps.isAncestor;
    if (isAncestor === undefined) return true;
    for (const pr of merged) {
      if (!(await isAncestor(candidate.slug, pr.mergeSha, deployedSha))) return false;
    }
    return true;
  }

  private async scan(): Promise<void> {
    const { config, store, jira, now } = this.deps;
    const nowDate = (now ?? (() => new Date()))();
    this.deployed = new Map();
    this.report = { scannedAt: nowDate.toISOString(), started: [], skipped: [], errors: [], warnings: [] };

    // E3a — inert unless every precondition holds: nothing is read, nothing
    // is called. A Jira outage is E5's rule, not an error: a snapshot whose
    // kind is not `ok` is NOT a status, so `lastStatus` must not be written
    // from it, or recovery reads as `'' -> UAT` on every ticket at once.
    if (!config.autoVerify) return;
    const snapshot = await jira();
    if (!snapshot.ok || snapshot.me === null) return;

    const state = await store.load();
    const items = await this.deps.items();
    this.warnAboutDoneStatuses(items);
    await this.closeDoneTickets(items, snapshot.me);
    const { taken, seed } = this.select(items, snapshot.me);

    // E1 — a corrupt store SEEDS ONLY. Not "nothing recorded, therefore
    // everything is new": that turns a truncated write into a fleet.
    const seedOnly = !state.ok;
    // Wall-clock, not the injected clock: the budget measures how long THIS
    // scan has actually been running, and an injected `now` is a fixed
    // instant in tests.
    const budgetUntil = Date.now() + config.scanBudgetMs;
    let starts = 0;

    for (const candidate of taken) {
      if (starts >= config.maxAutoStartsPerTick) break;
      if (Date.now() > budgetUntil) break;
      const previous = state.tickets[candidate.key];
      const cold = previous === undefined || previous.lastStatus === null;
      const inQa = previous !== undefined && previous.lastStatus !== null
        && config.qaStatuses.includes(previous.lastStatus);
      if (inQa) {
        // E5 — a PRESENCE is not an entry, so the ticket is normally left
        // alone and costs nothing. Two things still make it a candidate,
        // both decided from data we already hold, so steady state is still
        // zero extra calls: this entry's attempts are not used up (the slice
        // deferred it, or `maxAttemptsPerEntry` allows another), or one of
        // its PRs has been touched since the last attempt — which is what a
        // NEW MERGE while it sits in QA looks like from here. The exact
        // identity check still happens in `start`, after the gh call.
        const attempts = previous!.attempts.filter((a) => a.ordinal === previous!.ordinal);
        // Phase 16 — when the deployed build is known, EVERY gate below is
        // asked of that build: a new build is a new identity with no attempts
        // of its own, so it re-verifies; the build we already waited on (or
        // already verified against) costs nothing and no gh call.
        const build = await this.deployedSha(candidate.slug);
        if (build !== null) {
          const onBuild = attempts.filter((a) => a.identity === qaIdentityOf([], build));
          if (onBuild.some((a) => a.outcome === 'awaiting-deploy')) continue;
          if (onBuild.length >= config.maxAttemptsPerEntry) continue;
        } else {
          const lastAt = attempts.at(-1)?.reservedAt ?? null;
          const touched = lastAt !== null && candidate.prs.some((pr) => (pr.updatedAt ?? '') > lastAt);
          if (attempts.length >= config.maxAttemptsPerEntry && !touched) continue;
        }
      }
      if (seedOnly) {
        this.skip(candidate.key, 'store unreadable — seeded, nothing started');
        continue;
      }
      if (cold && !config.backfillOnFirstRun) {
        // R77 as amended: a cold record is a SEED. The first tick after an
        // install must not become a fleet of verifications.
        await store.observe(candidate.key, candidate.status);
        this.skip(candidate.key, 'first observation — seeded, nothing started');
        continue;
      }
      if (!this.deps.qaFor(candidate.slug).hasTestIdentity) {
        this.skip(candidate.key, 'no qa test account');
        continue;
      }
      if (!candidate.prs.every((pr) => pr.state === 'merged')) {
        this.skip(candidate.key, 'pr closed without merging');
        continue;
      }
      const coverage = await this.coverage(candidate.key);
      if (coverage.blocked) continue;
      // The ordinal advances only on a real ENTRY; a ticket already in QA
      // keeps the ordinal it entered on (R80).
      const record = inQa
        ? previous!
        : await store.enterQa(candidate.key, candidate.status);
      if (await this.start(candidate, record.ordinal, state, coverage.reuse)) starts += 1;
    }

    // Everything we saw and did not take still has its status recorded, so a
    // later re-entry is a real transition — unless the store is unreadable,
    // in which case we seed exactly that and nothing else.
    for (const candidate of seed) {
      if (state.tickets[candidate.key]?.lastStatus === candidate.status) continue;
      await store.observe(candidate.key, candidate.status);
    }
  }
}
