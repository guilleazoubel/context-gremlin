// Locking invariant (replaces the old F5/F6 "known gap" note — this used to
// be accepted debt; a proven session-store clobber promoted it to a fix):
// before `run.started` fires, the caller — an API route handler, or this
// file's own `runStageLocked` — holds the per-session KeyedLock, so pre-run
// work must NOT try to acquire it too (KeyedLock is not re-entrant; nesting
// `lock.withLock` for the same id deadlocks). After `run.started`, the
// caller has released that lock, so EVERY subsequent write to that
// session — StageRunner's post-exit lastRun/agent patch, this file's
// evaluate -> transition -> pr/reviewVersion/lastRereviewSummary patches,
// and any chained stage's own pre-run work — must acquire the lock itself
// before reading-then-saving. Methods below that read-then-save without
// going through `transition`/`patchLastRun`/`runStageLocked` are the ones
// still doing a single, atomic, brand-new-id-only write (nothing else can
// reference that id yet) — those don't need the lock.
import { assertSafeSessionId, InvalidSessionIdError, type SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { StageRunner } from './stage-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { GitRunner } from '../git/git-runner';
import type { EngineEvents } from '../engine/events';
import type { DevelopmentSession, InvestigationSession, Session } from '../schema/session';
import type { RespondPhase, ReviewPhase } from '../schema/pipeline';
import type { LastRun, StageName } from '../schema/stage';
import { KeyedLock } from '../api/keyed-lock';
import { awaitRunStart } from './run-start';
import {
  EMPTY_ENVIRONMENT,
  renderDevelopBrief,
  renderFindingsBrief,
  renderRespondBrief,
  type RespondBriefContext,
  type TicketBriefContext,
  renderPlanBrief,
  renderRereviewBrief,
  renderRereviewPrompt,
  renderReviewBrief,
  renderReviewPrompt,
  STAGE_ENTRY_PROMPT,
  type EnvironmentBriefContext,
} from './prompts';
import { ABORTED_REASON, EnvironmentAbortedError, type EnvironmentService } from '../env/environment-service';
import { evaluateFindings, evaluatePlan, evaluateRereview, evaluateReview, nextReviewVersion, readNonEmpty } from './artifacts';
import { assertCanPromote } from './plan-gate';
import { RunInProgressError, WorkspaceMissingError, type StageRunResult } from './stage-runner';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { repoSlugFromUrl } from '../gh/repo-slug';

export interface PipelineConfig {
  sessionsDir: string; // absolute
  worktreesDir: string; // absolute; worktree = `${worktreesDir}/${sessionId}`
  defaultBaseRef: string; // e.g. 'origin/main'
  reviewSkillCommand?: string;
  includeLiveUiCheck?: boolean;
  /** The runner a claim on a never-run session records, so `claude --resume` knows what it is resuming (R20). */
  runnerKind: 'claude-code' | 'codex';
  /** How long a human-turn claim stays live: `expiresAt = claimedAt + this` (R20). */
  humanTurnTtlMs: number;
}

export interface PipelineServiceDeps {
  store: SessionStore;
  workspace: WorkspaceManager;
  stageRunner: StageRunner;
  fs: SessionFileSystem;
  git: GitRunner;
  events: EngineEvents;
  config: PipelineConfig;
  now?: () => Date;
  newId?: (prefix: string, repoSlug: string, key: string) => string;
  /** Shared with StageRunner (and the API server) — see the locking invariant above. Required (not optional): a wiring that forgets to share it is a bug, not a degraded-but-working mode. */
  lock: KeyedLock;
  /** Optional: a wiring with no local-app adapter has no environment at all, and every stage then behaves exactly as it did before Phase 5 (R14). */
  environment?: EnvironmentService;
  /**
   * R18 — the ticket text a brief carries, fetched by the ENGINE (never by
   * the agent, and never a credential). Optional: with no Jira configured
   * the `## Ticket` section renders '' and the briefs read exactly as they
   * did before Phase 9.
   */
  tickets?: { forBrief(key: string): Promise<TicketBriefContext | null> };
  /**
   * R50/R52 — the review threads, review summaries, CI and diff summary the
   * respond brief carries, gathered by the host (which owns the thread cache
   * and the inventory). Absent means an empty brief body, exactly as an
   * absent `tickets` means no `## Ticket` block.
   */
  respondContext?: (
    session: Session,
  ) => Promise<Omit<RespondBriefContext, 'sessionDir' | 'prRepo' | 'prNumber' | 'ticketContext'>>;
}

/** What `prepareEnvironment` hands back: the brief context, whether THIS call started the app, and the teardown that undoes both. */
interface PreparedEnvironment {
  ctx: EnvironmentBriefContext;
  startedHere: boolean;
  teardown: () => Promise<void>;
}

export interface CreateInvestigationInput {
  repoUrl: string;
  ticket: string | null;
  intent: 'investigate_only' | 'development';
  driveToCompletion: boolean;
  baseRef?: string;
}

export interface CreateDevelopmentInput {
  repoUrl: string;
  ticket: string | null;
  baseRef?: string;
}

/** The heading `renderUiCheckProtocol` emits — the R14 gate reads it back out of the rendered brief. */
const LIVE_UI_CHECK_HEADING = '## LIVE UI CHECK';

export class UnsupportedStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedStageError';
  }
}

/** A human holds this session's agent conversation right now — no headless stage may run (R9, R19). Maps to 409. */
export class HumanTurnInProgressError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}': a human holds the agent conversation; release it before running a stage`);
    this.name = 'HumanTurnInProgressError';
  }
}

/**
 * The ONE definition of "claimed" (R20): a claim is present AND has not
 * expired. Every caller — both refusal sites, `conversation`,
 * `AttentionItem.claimed`, the `sessions` table, the reconciliation tick —
 * goes through this, so an orphaned claim can never wedge a session: it
 * simply stops being a claim once `expiresAt` passes.
 */
export function isClaimed(session: Session, now: Date): boolean {
  const humanTurn = session.agent?.humanTurn;
  if (humanTurn == null) return false;
  return new Date(humanTurn.expiresAt).getTime() > now.getTime();
}

export class PipelineService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string, repoSlug: string, key: string) => string;
  private readonly lock: KeyedLock;

  constructor(private readonly deps: PipelineServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix, slug, key) => `${prefix}-${slug.replace('/', '-')}-${key}-${stamp(this.now())}`);
    this.lock = deps.lock;
  }

  /**
   * R18 — the gated ticket context. A fetch failure is not a run failure:
   * the brief simply renders without the `## Ticket` block, exactly as it
   * does with no Jira configured.
   */
  private async ticketContext(key: string | null): Promise<TicketBriefContext | null> {
    if (key === null || this.deps.tickets === undefined) return null;
    return this.deps.tickets.forBrief(key).catch(() => null);
  }

  private sessionDir(id: string): string {
    return `${this.deps.config.sessionsDir}/${id}`;
  }

  /** The unlocked, single-operation core of `transition` — only call this from inside a callback already running under `this.lock` for `id`. */
  private async transitionUnlocked(id: string, to: string): Promise<Session> {
    const before = await this.deps.store.load(id);
    const after = await this.deps.store.transition(id, to);
    // R20: a session that just became terminal has no conversation left to
    // protect (and its worktree may be reclaimed), so the claim goes in the
    // same locked write — one of the four paths that keep an orphaned claim
    // from wedging a session. Transitions themselves are never refused for a
    // claim: a claim delays a re-review, never the truth about the PR.
    const cleared = await this.clearHumanTurnIfTerminal(after);
    this.deps.events.emit('session.transitioned', { session: cleared, from: before.stageStatus, to });
    return cleared;
  }

  /** Only call from inside a callback already running under `this.lock` for `session.id`. */
  private async clearHumanTurnIfTerminal(session: Session): Promise<Session> {
    if (session.agent?.humanTurn == null) return session;
    if (!TERMINAL_PHASES_BY_MODE[session.mode].has(session.stageStatus)) return session;
    const cleared: Session = { ...session, agent: { ...session.agent, humanTurn: null } };
    await this.deps.store.save(cleared);
    return cleared;
  }

  /**
   * Authoritative. Runs under the per-session lock, on a fresh load, on the
   * write path — which is why it may also REAP an expired claim (R20) rather
   * than merely ignore it. Never nests `lock.withLock`: it is already inside
   * the caller's, per the invariant above.
   */
  private async assertNoHumanTurn(fresh: Session): Promise<Session> {
    if (fresh.agent?.humanTurn == null) return fresh;
    if (isClaimed(fresh, this.now())) throw new HumanTurnInProgressError(fresh.id);
    const reaped: Session = { ...fresh, agent: { ...fresh.agent, humanTurn: null } };
    await this.deps.store.save(reaped);
    return reaped;
  }

  async transition(id: string, to: string): Promise<Session> {
    return this.lock.withLock(id, () => this.transitionUnlocked(id, to));
  }

  private async patchLastRun(id: string, patch: Partial<LastRun>): Promise<Session> {
    return this.lock.withLock(id, async () => {
      const s = await this.deps.store.load(id);
      if (!s.lastRun) return s;
      const updated = { ...s, lastRun: { ...s.lastRun, ...patch } };
      await this.deps.store.save(updated);
      return updated;
    });
  }

  /**
   * Runs one stage under the shared per-session lock up through `run.started`
   * — `preRun` (if given) does whatever pre-run mutation the caller used to
   * do unlocked (e.g. a pre-run transition), then the stage run is started
   * and the lock is released the instant `run.started` fires, exactly
   * mirroring what an API route handler does. The stage run itself
   * (including StageRunner's own now-locked post-exit patch) then continues
   * and is awaited OUTSIDE the lock, so it never blocks a concurrent action
   * on this session beyond the pre-run window.
   */
  private async runStageLocked(
    id: string,
    stage: StageName,
    brief: string | null,
    prompt: string,
    preRun?: () => Promise<void>,
  ): Promise<StageRunResult> {
    let start!: Promise<StageRunResult>;
    await this.lock.withLock(id, async () => {
      if (preRun) await preRun();
      start = this.deps.stageRunner.run({ sessionId: id, stage, brief, prompt });
      await awaitRunStart(this.deps.events, id, start);
    });
    return start;
  }

  /**
   * Prepares the stage's environment — R4 AMENDED. Runs BEFORE
   * `runStageLocked`, so it holds NO session lock and writes NO session state
   * (no store.save, no transition, no session artifact other than the 0600
   * `.bypass-secret` file): starting a dev server can take up to
   * `healthTimeoutMs` plus a cold setup, and holding the per-session lock for
   * that long would block `stop` and every other action on the session.
   * The brief is rendered from the returned context, which is why
   * `runStageLocked` still takes a plain `brief: string | null`.
   */
  private async prepareEnvironment(id: string, stage: StageName, session: Session): Promise<PreparedEnvironment> {
    const environment = this.deps.environment;
    if (!environment) {
      return { ctx: { ...EMPTY_ENVIRONMENT }, startedHere: false, teardown: async () => undefined };
    }
    const repoUrl = session.workspace.repoUrl;
    const sessionDir = this.sessionDir(id);
    let startedHere = false;
    // Idempotent: a chained stage (e.g. runFindings -> runPlan -> promote ->
    // runDevelop) tears this down BEFORE chaining, in addition to its own
    // outer `finally` — so teardown must be safe to call twice. Guarded so
    // the second call is a no-op rather than clearing an already-cleared
    // secret or stopping an app some OTHER stage has since started.
    let tornDown = false;
    const teardown = async (): Promise<void> => {
      if (tornDown) return;
      tornDown = true;
      // Never throws: a teardown failure must not mask the stage's own error
      // and must not fail an otherwise successful run. Takes no session lock.
      try {
        await environment.clearBypassSecret(sessionDir);
      } catch {
        // best effort
      }
      if (startedHere) {
        try {
          await environment.stop(id);
        } catch {
          // best effort
        }
      }
    };
    try {
      if (environment.wantsLocalApp(repoUrl, stage)) {
        // A failed start degrades (R5): `start` reports it as 'unavailable'
        // rather than throwing, and the brief says so.
        const status = await environment.start(session);
        // W4: an aborted start means the engine is shutting down — degrading
        // here would run the stage's agent against an engine that is already
        // gone, so the stage does not start at all.
        if (status.state === 'unavailable' && status.reason === ABORTED_REASON) {
          throw new EnvironmentAbortedError(id);
        }
        startedHere = status.state === 'running';
      }
      // The context is read AFTER the start, so the brief reflects what
      // actually came up (or why it did not), and resolves the preview URL.
      const ctx = await environment.briefContext(session, stage);
      if (ctx.bypassSecretPath !== null) {
        await environment.writeBypassSecret(sessionDir, repoUrl);
      }
      return { ctx, startedHere, teardown };
    } catch (err) {
      // Something unexpected blew up after we may already have started the
      // app — do not leave it (or the secret file) behind.
      await teardown();
      throw err;
    }
  }

  repoSlug(repoUrl: string): string {
    return repoSlugFromUrl(repoUrl);
  }

  async createInvestigationSession(input: CreateInvestigationInput): Promise<InvestigationSession> {
    const slug = repoSlugFromUrl(input.repoUrl);
    const id = this.newId('inv', slug, input.ticket ?? 'no-ticket');
    // Validate the derived id BEFORE touching git or the filesystem: the
    // ticket (and, in principle, the repo slug) feed directly into it, and
    // an id containing '/' or '..' would let the worktree land outside
    // worktreesDir. assertSafeSessionId only rejects '..' as the WHOLE id;
    // also reject it as a substring, since a hyphen-joined id can still
    // smuggle a bare '..' path segment via an embedded '/'.
    assertSafeSessionId(id);
    if (id.includes('..')) {
      throw new InvalidSessionIdError(id);
    }
    const branch = `investigate/${input.ticket ?? id}`;
    const worktreePath = `${this.deps.config.worktreesDir}/${id}`;

    await this.deps.workspace.createWorkspace({
      repoUrl: input.repoUrl,
      worktreePath,
      branchName: branch,
      baseRef: input.baseRef ?? this.deps.config.defaultBaseRef,
      mode: 'investigation',
    });

    const session: InvestigationSession = {
      schemaVersion: 2,
      id,
      mode: 'investigation',
      createdAt: this.now().toISOString(),
      workspace: { repoUrl: input.repoUrl, worktreePath, branch },
      lineage: { pipelineId: id, parentSessionId: null, ticket: input.ticket, selfReview: false },
      stageStatus: 'findings',
      agent: null,
      lastRun: null,
      pr: null,
      intent: input.intent,
      driveToCompletion: input.driveToCompletion,
    };
    try {
      await this.deps.store.save(session);
    } catch (err) {
      // Roll back the workspace we just created so a retry with the same
      // ticket doesn't fail with "a branch already exists", and so we don't
      // leave an orphaned worktree/mirror branch behind. Swallow a rollback
      // failure rather than let it mask the original error.
      await this.deps.workspace.removeWorkspace(input.repoUrl, worktreePath, branch).catch(() => undefined);
      throw err;
    }
    this.deps.events.emit('session.created', { session });
    return session;
  }

  /**
   * R16: a development session with no investigation upstream of it. Mirrors
   * `createInvestigationSession` — derived id, safety checks, worktree,
   * save-with-rollback, `session.created` — and, exactly like it, starts
   * nothing: the caller issues `POST /sessions/:id/run {stage:'develop'}`
   * when it wants the develop turn (MG-A11). `promote()` is still the path
   * that auto-starts one.
   */
  async createDevelopmentSession(input: CreateDevelopmentInput): Promise<DevelopmentSession> {
    const slug = repoSlugFromUrl(input.repoUrl);
    const id = this.newId('dev', slug, input.ticket ?? 'no-ticket');
    // Same reasoning as createInvestigationSession: the ticket feeds the id
    // which feeds the worktree path, so validate the derived id BEFORE
    // touching git or the filesystem, and reject '..' as a substring too.
    assertSafeSessionId(id);
    if (id.includes('..')) {
      throw new InvalidSessionIdError(id);
    }
    // Legacy development naming (`bin/cgremlin:14293`), with the id as the
    // fallback exactly as investigation's `investigate/${ticket ?? id}` does.
    const branch = `feature/${input.ticket ?? id}`;
    const worktreePath = `${this.deps.config.worktreesDir}/${id}`;

    await this.deps.workspace.createWorkspace({
      repoUrl: input.repoUrl,
      worktreePath,
      branchName: branch,
      baseRef: input.baseRef ?? this.deps.config.defaultBaseRef,
      // Selects the development permission guard: `gh pr review|comment|
      // merge|close` denied, `git push`/`gh pr create` allowed.
      mode: 'development',
    });

    const session: DevelopmentSession = {
      schemaVersion: 2,
      id,
      mode: 'development',
      createdAt: this.now().toISOString(),
      workspace: { repoUrl: input.repoUrl, worktreePath, branch },
      // Self-rooted, unlike promote()'s child session.
      lineage: { pipelineId: id, parentSessionId: null, ticket: input.ticket, selfReview: false },
      stageStatus: 'active',
      agent: null,
      lastRun: null,
      pr: null,
    };
    try {
      await this.deps.store.save(session);
    } catch (err) {
      // Roll the workspace back so a retry with the same ticket doesn't fail
      // on an existing branch, and swallow a rollback failure rather than let
      // it mask the original error — verbatim as createInvestigationSession.
      await this.deps.workspace.removeWorkspace(input.repoUrl, worktreePath, branch).catch(() => undefined);
      throw err;
    }
    this.deps.events.emit('session.created', { session });
    return session;
  }

  async runFindings(id: string): Promise<Session> {
    // Only the mode is checked here (immutable for a given id, so reading it
    // stale is harmless and it's needed to safely access .intent below) —
    // the actual eligibility check (stageStatus) is race-sensitive and must
    // run on a FRESH load inside the lock; see the invariant comment above.
    const session = await this.deps.store.load(id);
    if (session.mode !== 'investigation') {
      throw new UnsupportedStageError(`Session '${id}' cannot run findings (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — on the snapshot the mode check just read,
    // with no second load and no lock, so a refusal costs no environment
    // setup and no git work in the worktree the human is talking about. It is
    // a fast path, never a substitute for the authoritative locked check
    // below: it takes no lock, so it can be stale, and it does not reap.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    const sessionDir = this.sessionDir(id);
    const prep = await this.prepareEnvironment(id, 'findings', session);
    const brief = renderFindingsBrief({
      sessionDir,
      ticket: session.lineage.ticket,
      intent: session.intent,
      env: prep.ctx,
      ticketContext: await this.ticketContext(session.lineage.ticket),
    });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    try {
      const result = await this.runStageLocked(id, 'findings', brief, prompt, async () => {
        const fresh = await this.deps.store.load(id);
        // Authoritative (R9/R19): first statement after the fresh load, so a
        // claimed session is refused as claimed rather than as ineligible.
        // The reaped copy is deliberately not rebound — nothing below reads
        // `agent`, and every write from here re-loads under this same lock.
        await this.assertNoHumanTurn(fresh);
        if (fresh.mode !== 'investigation' || fresh.stageStatus !== 'findings') {
          throw new UnsupportedStageError(`Session '${id}' cannot run findings (mode=${fresh.mode}, stage=${fresh.stageStatus})`);
        }
      });
      if (result.outcome !== 'succeeded') return result.session;

      const { hasFindings } = await evaluateFindings(this.deps.fs, sessionDir);
      if (!hasFindings) {
        return await this.patchLastRun(id, {
          outcome: 'failed',
          error: 'run succeeded but FINDINGS.md is missing or empty',
        });
      }
      if (session.intent === 'development') {
        // Tear down BEFORE chaining into runPlan (which may itself chain into
        // promote -> runDevelop): a repo can configure the SAME port for both
        // the 'findings' and 'develop' stages, and the nested stage's own
        // `environment.start()` must not find this stage's app still up.
        // The outer `finally` below still runs too (idempotent — see teardown).
        await prep.teardown();
        return await this.runPlan(id);
      }
      return result.session;
    } finally {
      await prep.teardown();
    }
  }

  async runPlan(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'investigation') {
      throw new UnsupportedStageError(`Session '${id}' cannot run plan (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    const sessionDir = this.sessionDir(id);
    const brief = renderPlanBrief({ sessionDir, ticket: session.lineage.ticket, driveToCompletion: session.driveToCompletion });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    // The stageStatus/FINDINGS.md eligibility check is race-sensitive and
    // must run on a FRESH load inside the lock, not the snapshot above.
    const result = await this.runStageLocked(id, 'plan', brief, prompt, async () => {
      const fresh = await this.deps.store.load(id);
      // Authoritative (R9/R19) — see runFindings.
      await this.assertNoHumanTurn(fresh);
      if (fresh.mode !== 'investigation') {
        throw new UnsupportedStageError(`Session '${id}' cannot run plan (mode=${fresh.mode})`);
      }
      if (fresh.stageStatus === 'findings') {
        const { hasFindings } = await evaluateFindings(this.deps.fs, sessionDir);
        if (!hasFindings) {
          throw new UnsupportedStageError(`Session '${id}': FINDINGS.md missing`);
        }
        await this.transitionUnlocked(id, 'planning');
      } else if (fresh.stageStatus !== 'planning') {
        throw new UnsupportedStageError(`Session '${id}' cannot run plan from stage '${fresh.stageStatus}'`);
      }
    });
    if (result.outcome !== 'succeeded') return result.session;

    const { reviewStatus } = await evaluatePlan(this.deps.fs, sessionDir);
    if (reviewStatus === 'approved') {
      const transitioned = await this.transition(id, 'plan_ready');
      if (session.driveToCompletion) {
        const { investigation } = await this.promote(id);
        return investigation;
      }
      return transitioned;
    }
    if (reviewStatus === 'unresolved') {
      return await this.patchLastRun(id, { error: 'unresolved review disagreement — needs input' });
    }
    // 'missing': the agent exited 0 but never produced an approved Review Status block.
    return await this.patchLastRun(id, {
      outcome: 'failed',
      error: 'run succeeded but PLAN.md has no approved Review Status',
    });
  }

  async approvePlan(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'investigation' || session.stageStatus !== 'plan_ready') {
      throw new UnsupportedStageError(
        `Session '${id}' cannot approve plan (mode=${session.mode}, stage=${session.stageStatus})`,
      );
    }
    return await this.transition(id, 'approved');
  }

  async promote(id: string): Promise<{ investigation: Session; development: Session }> {
    const snapshot = await this.deps.store.load(id);
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(snapshot, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    // Promoting is a write the human's conversation is about, and no stage's
    // own check can protect it: the terminal transition below would itself
    // CLEAR the claim (clearHumanTurnIfTerminal) and the development session
    // it creates is unclaimed. So the authoritative check lives here, on a
    // fresh load under this session's own lock — a claim landing after the
    // advisory snapshot is still refused. It cannot live inside `transition`:
    // transitions must stay un-refusable so the reconciliation tick's
    // merge/close still applies (and clears the claim) while claimed (R20).
    const { investigation, devId } = await this.lock.withLock(id, async () => {
      const fresh = await this.deps.store.load(id);
      await this.assertNoHumanTurn(fresh);
      assertCanPromote(fresh);
      // Legal from either 'approved' (a human approved it) or 'plan_ready'
      // (drive-to-completion) directly — the schema has both edges so this
      // never has to synthesize an 'approved' step nobody actually took.
      // `transitionUnlocked`, not `transition`: we already hold this
      // session's lock and KeyedLock is not re-entrant.
      const promoted = await this.transitionUnlocked(id, 'promoted_to_development');

      const slug = repoSlugFromUrl(fresh.workspace.repoUrl);
      // The development session is a brand-new id nothing else can reference
      // yet, so its own writes need no lock of their own (see the invariant
      // above); doing them here keeps the whole promotion atomic against any
      // concurrent action on the investigation.
      const newDevId = this.newId('dev', slug, fresh.lineage.ticket ?? fresh.id);
      const newDevelopment: Session = {
        schemaVersion: 2,
        id: newDevId,
        mode: 'development',
        createdAt: this.now().toISOString(),
        workspace: fresh.workspace,
        lineage: { pipelineId: fresh.lineage.pipelineId, parentSessionId: fresh.id, ticket: fresh.lineage.ticket, selfReview: false },
        stageStatus: 'active',
        agent: null,
        lastRun: null,
        pr: null,
      };
      await this.deps.store.save(newDevelopment);

      const invDir = this.sessionDir(id);
      const devDir = this.sessionDir(newDevId);
      for (const name of ['FINDINGS.md', 'PLAN.md']) {
        const src = `${invDir}/${name}`;
        if (await this.deps.fs.exists(src)) {
          await this.deps.fs.writeFile(`${devDir}/${name}`, await this.deps.fs.readFile(src));
        }
      }

      this.deps.events.emit('session.created', { session: newDevelopment });
      return { investigation: promoted, devId: newDevId };
    });

    // OUTSIDE the lock: runDevelop takes the development session's own lock,
    // but it also awaits a whole agent turn, and holding the investigation's
    // lock for that long would block every other action on it.
    await this.runDevelop(devId);
    const finalDevelopment = await this.deps.store.load(devId);
    return { investigation, development: finalDevelopment };
  }

  async runDevelop(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'development') {
      throw new UnsupportedStageError(`Session '${id}' cannot run develop (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    const sessionDir = this.sessionDir(id);
    const hasPlan = await this.deps.fs.exists(`${sessionDir}/PLAN.md`);
    const prep = await this.prepareEnvironment(id, 'develop', session);
    const brief = renderDevelopBrief({
      sessionDir,
      ticket: session.lineage.ticket,
      hasPlan,
      env: prep.ctx,
      ticketContext: await this.ticketContext(session.lineage.ticket),
    });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    try {
      // No transition on success: PR detection (which drives active -> pr_opened) is Phase 3b.
      // The stageStatus check is race-sensitive and must run on a FRESH load
      // inside the lock — starting on a session a human just abandoned is
      // exactly the hole this closes.
      const result = await this.runStageLocked(id, 'develop', brief, prompt, async () => {
        const fresh = await this.deps.store.load(id);
        // Authoritative (R9/R19) — see runFindings.
        await this.assertNoHumanTurn(fresh);
        if (fresh.mode !== 'development' || fresh.stageStatus !== 'active') {
          throw new UnsupportedStageError(`Session '${id}' cannot run develop (mode=${fresh.mode}, stage=${fresh.stageStatus})`);
        }
      });
      return result.session;
    } finally {
      await prep.teardown();
    }
  }

  /**
   * R56 — written in the shape of `runDevelop`, verbatim where it can be.
   * The phase check is race-sensitive and runs on a FRESH load inside the
   * lock, which is the race the comment above exists to close: checking it
   * only on the pre-lock load lets a run start on a session a human just
   * abandoned.
   */
  async runRespond(id: string): Promise<Session> {
    // Declared beside REVIEW_RUNNABLE_FROM / REREVIEW_RUNNABLE_FROM and
    // checked on the FRESH in-lock load, exactly as they are. `closed` and
    // `abandoned` are not runnable.
    const RESPOND_RUNNABLE_FROM: readonly RespondPhase[] = ['triaging', 'addressing', 'ready'];
    const session = await this.deps.store.load(id);
    if (session.mode !== 'respond') {
      throw new UnsupportedStageError(`Session '${id}' cannot run respond (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    const sessionDir = this.sessionDir(id);
    const prep = await this.prepareEnvironment(id, 'respond', session);
    const brief = renderRespondBrief({
      sessionDir,
      prRepo: session.pr?.repo ?? '',
      prNumber: session.pr?.number ?? 0,
      ticketContext: await this.ticketContext(session.lineage.ticket),
      // R50's gate returns '' for a context with NOTHING in it. A real run
      // still needs the reconcile-first instruction, the COMMENTS.md shape
      // and the out-of-scope line, so the no-context case passes an empty
      // `reviewDecision` rather than a null one: the brief renders its
      // skeleton with no threads listed instead of coming out blank.
      ...((await this.deps.respondContext?.(session)) ?? {
        threads: [],
        reviews: [],
        reviewDecision: '',
        failingChecks: [],
        changedFiles: null,
        additions: null,
        deletions: null,
      }),
    });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    try {
      const result = await this.runStageLocked(id, 'respond', brief, prompt, async () => {
        const fresh = await this.deps.store.load(id);
        // Authoritative (R9/R19) — see runFindings.
        await this.assertNoHumanTurn(fresh);
        if (fresh.mode !== 'respond' || !RESPOND_RUNNABLE_FROM.includes(fresh.stageStatus)) {
          throw new UnsupportedStageError(
            `Session '${id}' cannot run respond (mode=${fresh.mode}, stage=${fresh.stageStatus})`,
          );
        }
        if (!fresh.workspace.worktreePath) {
          throw new WorkspaceMissingError(id);
        }
        if (fresh.stageStatus === 'triaging') {
          await this.transitionUnlocked(id, 'addressing');
        }
      });
      return result.session;
    } finally {
      await prep.teardown();
    }
  }

  async runReview(id: string): Promise<Session> {
    // Only the mode is checked here (immutable) — the actual eligibility
    // check (stageStatus/pr/worktree) is race-sensitive and must run on a
    // FRESH load inside the lock; see the invariant comment above.
    const session = await this.deps.store.load(id);
    if (session.mode !== 'review') {
      throw new UnsupportedStageError(`Session '${id}' cannot run review (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }

    const sessionDir = this.sessionDir(id);
    const prep = await this.prepareEnvironment(id, 'review', session);
    // A review session with no pr is rejected by the locked preRun below
    // before this brief is ever written, so the fallback number is dead.
    const brief = renderReviewBrief({
      sessionDir,
      prNumber: session.pr?.number ?? 0,
      env: prep.ctx,
      selfReview: session.lineage.selfReview,
    });
    const prompt = renderReviewPrompt({
      sessionDir,
      reviewSkillCommand: this.deps.config.reviewSkillCommand,
      includeLiveUiCheck: this.deps.config.includeLiveUiCheck,
      // R14: the gate is whether the section really made it into BRIEF.md,
      // not a separate config flag.
      uiCheckRendered: brief.includes(LIVE_UI_CHECK_HEADING),
    });
    try {
      const REVIEW_RUNNABLE_FROM: readonly ReviewPhase[] = ['queued', 'changes_requested', 'ready', 'failed'];
      // Only mark the session 'failed' in the catch below if OUR preRun
      // actually committed the reviewing transition — a lost-race rejection
      // (someone else already moved this session on) must never mask itself
      // as this session's own failure while a DIFFERENT run may be live.
      let preRunCommitted = false;
      let result: StageRunResult;
      try {
        result = await this.runStageLocked(id, 'review', brief, prompt, async () => {
          const fresh = await this.deps.store.load(id);
          // Authoritative (R9/R19) — see runFindings.
          await this.assertNoHumanTurn(fresh);
          if (fresh.mode !== 'review' || !REVIEW_RUNNABLE_FROM.includes(fresh.stageStatus)) {
            throw new UnsupportedStageError(`Session '${id}' cannot run review (mode=${fresh.mode}, stage=${fresh.stageStatus})`);
          }
          if (!fresh.pr) {
            throw new UnsupportedStageError(`Session '${id}': review session has no pr`);
          }
          if (!fresh.workspace.worktreePath) {
            throw new WorkspaceMissingError(id);
          }
          await this.transitionUnlocked(id, 'reviewing');
          preRunCommitted = true;
        });
      } catch (err) {
        if (preRunCommitted) {
          await this.transition(id, 'failed');
        }
        throw err;
      }

      // evaluateReview already treats a non-clean exit (including a stopped
      // run's signal) as 'failed' — no separate stopped-run special case needed.
      const outcome = await evaluateReview(result.exit, this.deps.fs, sessionDir);
      return await this.lock.withLock(id, async () => {
        const before = await this.deps.store.load(id);
        const to = outcome === 'ready' ? 'ready' : 'failed';
        let after = await this.deps.store.transition(id, to);
        this.deps.events.emit('session.transitioned', { session: after, from: before.stageStatus, to });
        if (outcome === 'ready' && after.mode === 'review' && after.pr) {
          after = { ...after, pr: { ...after.pr, reviewedSha: after.pr.headSha } };
          await this.deps.store.save(after);
        }
        return after;
      });
    } finally {
      // OUTSIDE the preRunCommitted try/catch (R4 AMENDED) and holding no
      // session lock, so it can neither deadlock against the transition
      // block above nor mask the lost-race classification.
      await prep.teardown();
    }
  }

  async runRereview(id: string): Promise<Session> {
    // Only the mode is checked here (immutable) — the actual eligibility
    // check (stageStatus/pr) is race-sensitive and must run on a FRESH load
    // inside the lock; see the invariant comment above. pr/worktreePath are
    // still read from this snapshot for the git operations below, since
    // those values don't change over a review session's lifetime once set.
    const session = await this.deps.store.load(id);
    if (session.mode !== 'review') {
      throw new UnsupportedStageError(`Session '${id}' cannot run rereview (mode=${session.mode})`);
    }
    // R19, advisory and UNLOCKED — see runFindings for why both sites exist.
    if (isClaimed(session, this.now())) {
      throw new HumanTurnInProgressError(id);
    }
    if (!session.pr) {
      throw new UnsupportedStageError(`Session '${id}': review session has no pr`);
    }
    const worktreePath = session.workspace.worktreePath;
    if (!worktreePath) {
      throw new WorkspaceMissingError(id);
    }

    const oldCommit = (await this.deps.git.run(['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
    await this.deps.git.run(['fetch', 'origin', `pull/${session.pr.number}/head`], { cwd: worktreePath });
    const newCommit = (await this.deps.git.run(['rev-parse', 'FETCH_HEAD'], { cwd: worktreePath })).stdout.trim();
    await this.deps.git.run(['reset', '--hard', 'FETCH_HEAD'], { cwd: worktreePath });
    const newCommitsText = (
      await this.deps.git.run(['log', '--oneline', `${oldCommit}..${newCommit}`], { cwd: worktreePath })
    ).stdout;
    const commitCount = newCommitsText.split('\n').filter((line) => line.trim().length > 0).length;
    const changesSince = (
      await this.deps.git.run(['diff', '--stat', `${oldCommit}...HEAD`], { cwd: worktreePath })
    ).stdout;

    const sessionDir = this.sessionDir(id);
    const existingReview = await readNonEmpty(this.deps.fs, `${sessionDir}/REVIEW.md`);
    // reviewVersion counts archived files, so only bump it (and only claim a
    // previous-review filename) when an archive was actually written — a
    // rereview off a failed run that never produced a REVIEW.md has nothing
    // to archive, and must not lie about either the count or the filename.
    let previousReviewLine = 'Previous review: (none — no prior REVIEW.md was present)';
    let archivedVersion: number | null = null;
    if (existingReview !== null) {
      const version = await nextReviewVersion(this.deps.fs, sessionDir);
      await this.deps.fs.writeFile(`${sessionDir}/REVIEW-v${version}.md`, existingReview);
      archivedVersion = version;
      previousReviewLine = `Previous review: REVIEW-v${version}.md`;
    }
    const reReviewContent = [
      `# RE-REVIEW — PR #${session.pr.number}`,
      ``,
      previousReviewLine,
      `Reviewed commit: ${oldCommit}`,
      `New head: ${newCommit}`,
      ``,
      `## New commits (${commitCount})`,
      newCommitsText || '(none listed)',
      ``,
      `## Changes since last review`,
      changesSince || '(no diffstat)',
      ``,
    ].join('\n');
    await this.deps.fs.writeFile(`${sessionDir}/RE-REVIEW.md`, reReviewContent);

    const REREVIEW_RUNNABLE_FROM: readonly ReviewPhase[] = ['ready', 'changes_requested', 'failed'];
    const prompt = renderRereviewPrompt({ sessionDir, commitCount, reviewSkillCommand: this.deps.config.reviewSkillCommand });
    // After the git work, so a fetch/reset failure never leaves a started app behind.
    const prep = await this.prepareEnvironment(id, 'rereview', session);
    const brief = renderRereviewBrief({ sessionDir, prNumber: session.pr.number, commitCount, env: prep.ctx });
    try {
      // Only mark the session 'failed' in the catch below if OUR preRun
      // actually committed the reviewing transition — a lost-race rejection
      // must never mask itself as this session's own failure.
      let preRunCommitted = false;
      let result: StageRunResult;
      try {
        result = await this.runStageLocked(id, 'rereview', brief, prompt, async () => {
          const fresh = await this.deps.store.load(id);
          // Authoritative (R9/R19) — see runFindings.
          await this.assertNoHumanTurn(fresh);
          if (fresh.mode !== 'review' || !REREVIEW_RUNNABLE_FROM.includes(fresh.stageStatus)) {
            throw new UnsupportedStageError(`Session '${id}' cannot run rereview (mode=${fresh.mode}, stage=${fresh.stageStatus})`);
          }
          if (!fresh.pr) {
            throw new UnsupportedStageError(`Session '${id}': review session has no pr`);
          }
          // Transition FIRST, then the reviewVersion/archive patch: if a
          // concurrent action already moved this session past eligibility,
          // fail here before ever bumping reviewVersion — a stale plan must
          // not leave an orphaned archived REVIEW-vN.md/reviewVersion bump
          // behind for a session it turns out it was never allowed to touch.
          await this.transitionUnlocked(id, 'reviewing');
          if (archivedVersion !== null) {
            const afterTransition = await this.deps.store.load(id);
            if (afterTransition.mode === 'review') {
              await this.deps.store.save({ ...afterTransition, reviewVersion: archivedVersion });
            }
          }
          preRunCommitted = true;
        });
      } catch (err) {
        if (preRunCommitted) {
          await this.transition(id, 'failed');
        }
        throw err;
      }

      const { outcome, summary } = await evaluateRereview(result.exit, this.deps.fs, sessionDir);
      return await this.lock.withLock(id, async () => {
        const before = await this.deps.store.load(id);
        const to = outcome === 'ready' ? 'ready' : 'failed';
        let after = await this.deps.store.transition(id, to);
        this.deps.events.emit('session.transitioned', { session: after, from: before.stageStatus, to });
        if (outcome === 'ready' && after.mode === 'review' && after.pr) {
          after = {
            ...after,
            pr: { ...after.pr, reviewedSha: newCommit, headSha: newCommit },
            lastRereviewSummary: summary,
          };
          await this.deps.store.save(after);
        }
        return after;
      });
    } finally {
      // OUTSIDE the preRunCommitted try/catch (R4 AMENDED); takes no session lock.
      await prep.teardown();
    }
  }

  async runStage(id: string, stage: StageName): Promise<Session> {
    switch (stage) {
      case 'findings':
        return this.runFindings(id);
      case 'plan':
        return this.runPlan(id);
      case 'develop':
        return this.runDevelop(id);
      case 'review':
        return this.runReview(id);
      case 'rereview':
        return this.runRereview(id);
      case 'respond':
        return this.runRespond(id);
    }
  }

  async stop(id: string): Promise<boolean> {
    return this.deps.stageRunner.stop(id);
  }

  /** Ids of sessions with an in-flight run right now — see StageRunner.activeSessionIds. */
  activeSessionIds(): string[] {
    return this.deps.stageRunner.activeSessionIds();
  }

  /**
   * Claims the agent conversation for a human (R9, R20). Refused while a run
   * is in flight: two `claude --resume <same id>` processes on one transcript
   * is unrecoverable corruption, so the caller must `stop` first. Idempotent
   * — a re-claim is the extension's heartbeat and simply pushes `expiresAt`
   * out.
   */
  async claimConversation(id: string): Promise<Session> {
    return this.lock.withLock(id, async () => {
      const fresh = await this.deps.store.load(id);
      // Read inside the lock, so a run that started while this call queued is
      // still seen. A live run has already released the lock (it releases at
      // `run.started`), so the lock alone cannot exclude it.
      if (this.activeSessionIds().includes(id)) {
        throw new RunInProgressError(id);
      }
      const now = this.now();
      const humanTurn = {
        claimedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.deps.config.humanTurnTtlMs).toISOString(),
      };
      const agent = fresh.agent
        ? { ...fresh.agent, humanTurn }
        : { runner: this.deps.config.runnerKind, resumeId: null, humanTurn };
      const claimed: Session = { ...fresh, agent };
      await this.deps.store.save(claimed);
      return claimed;
    });
  }

  /** Releases the claim. Idempotent, and a no-op on a session that has no agent record at all. */
  async releaseConversation(id: string): Promise<Session> {
    return this.lock.withLock(id, async () => {
      const fresh = await this.deps.store.load(id);
      if (fresh.agent == null || fresh.agent.humanTurn == null) return fresh;
      const released: Session = { ...fresh, agent: { ...fresh.agent, humanTurn: null } };
      await this.deps.store.save(released);
      return released;
    });
  }

  /** The resume contract: what a human needs to pick this conversation up by hand, and whether one already has it. */
  async conversation(id: string): Promise<{
    runner: 'claude-code' | 'codex' | null;
    resumeId: string | null;
    worktreePath: string | null;
    claimed: boolean;
  }> {
    const session = await this.deps.store.load(id);
    return {
      runner: session.agent?.runner ?? null,
      resumeId: session.agent?.resumeId ?? null,
      worktreePath: session.workspace.worktreePath ?? null,
      claimed: isClaimed(session, this.now()),
    };
  }

  /**
   * Clears every claim in the store, one session at a time under that
   * session's own lock (R20's boot recovery path): no extension can hold a
   * claim across an engine restart it did not survive. Reports what it
   * touched so the host can log it.
   */
  async clearAllHumanTurns(): Promise<{ count: number; sessionIds: string[] }> {
    const sessionIds: string[] = [];
    for (const session of await this.deps.store.list()) {
      if (session.agent?.humanTurn == null) continue;
      await this.lock.withLock(session.id, async () => {
        const fresh = await this.deps.store.load(session.id);
        if (fresh.agent?.humanTurn == null) return;
        await this.deps.store.save({ ...fresh, agent: { ...fresh.agent, humanTurn: null } });
        sessionIds.push(session.id);
      });
    }
    return { count: sessionIds.length, sessionIds };
  }

  async retry(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (!session.lastRun) {
      throw new UnsupportedStageError(`Session '${id}' has no previous run to retry`);
    }
    return this.runStage(id, session.lastRun.stage);
  }
}

export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export { repoSlugFromUrl, repoSlugFromUrl as repoSlug } from '../gh/repo-slug';
