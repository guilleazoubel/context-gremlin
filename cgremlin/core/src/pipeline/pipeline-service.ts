import { assertSafeSessionId, InvalidSessionIdError, type SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { StageRunner } from './stage-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { GitRunner } from '../git/git-runner';
import type { EngineEvents } from '../engine/events';
import type { InvestigationSession, Session } from '../schema/session';
import type { ReviewPhase } from '../schema/pipeline';
import type { LastRun, StageName } from '../schema/stage';
import {
  renderDevelopBrief,
  renderFindingsBrief,
  renderPlanBrief,
  renderRereviewPrompt,
  renderReviewPrompt,
  STAGE_ENTRY_PROMPT,
} from './prompts';
import { evaluateFindings, evaluatePlan, evaluateRereview, evaluateReview, nextReviewVersion, readNonEmpty } from './artifacts';
import { assertCanPromote } from './plan-gate';
import { WorkspaceMissingError } from './stage-runner';

export interface PipelineConfig {
  sessionsDir: string; // absolute
  worktreesDir: string; // absolute; worktree = `${worktreesDir}/${sessionId}`
  defaultBaseRef: string; // e.g. 'origin/main'
  reviewSkillCommand?: string;
  includeLiveUiCheck?: boolean;
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
}

export interface CreateInvestigationInput {
  repoUrl: string;
  ticket: string | null;
  intent: 'investigate_only' | 'development';
  driveToCompletion: boolean;
  baseRef?: string;
}

export class UnsupportedStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedStageError';
  }
}

export class PipelineService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string, repoSlug: string, key: string) => string;

  constructor(private readonly deps: PipelineServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix, slug, key) => `${prefix}-${slug.replace('/', '-')}-${key}-${stamp(this.now())}`);
  }

  private sessionDir(id: string): string {
    return `${this.deps.config.sessionsDir}/${id}`;
  }

  async transition(id: string, to: string): Promise<Session> {
    const before = await this.deps.store.load(id);
    const after = await this.deps.store.transition(id, to);
    this.deps.events.emit('session.transitioned', { session: after, from: before.stageStatus, to });
    return after;
  }

  private async patchLastRun(id: string, patch: Partial<LastRun>): Promise<Session> {
    const s = await this.deps.store.load(id);
    if (!s.lastRun) return s;
    const updated = { ...s, lastRun: { ...s.lastRun, ...patch } };
    await this.deps.store.save(updated);
    return updated;
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
      lineage: { pipelineId: id, parentSessionId: null, ticket: input.ticket },
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

  async runFindings(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'investigation' || session.stageStatus !== 'findings') {
      throw new UnsupportedStageError(
        `Session '${id}' cannot run findings (mode=${session.mode}, stage=${session.stageStatus})`,
      );
    }
    const sessionDir = this.sessionDir(id);
    const brief = renderFindingsBrief({ sessionDir, ticket: session.lineage.ticket, intent: session.intent });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    const result = await this.deps.stageRunner.run({ sessionId: id, stage: 'findings', brief, prompt });
    if (result.outcome !== 'succeeded') return result.session;

    const { hasFindings } = await evaluateFindings(this.deps.fs, sessionDir);
    if (!hasFindings) {
      return await this.patchLastRun(id, {
        outcome: 'failed',
        error: 'run succeeded but FINDINGS.md is missing or empty',
      });
    }
    if (session.intent === 'development') {
      return await this.runPlan(id);
    }
    return result.session;
  }

  async runPlan(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'investigation') {
      throw new UnsupportedStageError(`Session '${id}' cannot run plan (mode=${session.mode})`);
    }
    if (session.stageStatus === 'findings') {
      const sessionDir = this.sessionDir(id);
      const { hasFindings } = await evaluateFindings(this.deps.fs, sessionDir);
      if (!hasFindings) {
        throw new UnsupportedStageError(`Session '${id}': FINDINGS.md missing`);
      }
      await this.transition(id, 'planning');
    } else if (session.stageStatus !== 'planning') {
      throw new UnsupportedStageError(`Session '${id}' cannot run plan from stage '${session.stageStatus}'`);
    }

    const sessionDir = this.sessionDir(id);
    const brief = renderPlanBrief({ sessionDir, ticket: session.lineage.ticket, driveToCompletion: session.driveToCompletion });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    const result = await this.deps.stageRunner.run({ sessionId: id, stage: 'plan', brief, prompt });
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
    const inv = await this.deps.store.load(id);
    assertCanPromote(inv);
    // Legal from either 'approved' (a human approved it) or 'plan_ready'
    // (drive-to-completion) directly — the schema has both edges so this
    // never has to synthesize an 'approved' step nobody actually took.
    const investigation = await this.transition(id, 'promoted_to_development');

    const slug = repoSlugFromUrl(inv.workspace.repoUrl);
    const devId = this.newId('dev', slug, inv.lineage.ticket ?? inv.id);
    const development: Session = {
      schemaVersion: 2,
      id: devId,
      mode: 'development',
      createdAt: this.now().toISOString(),
      workspace: inv.workspace,
      lineage: { pipelineId: inv.lineage.pipelineId, parentSessionId: inv.id, ticket: inv.lineage.ticket },
      stageStatus: 'active',
      agent: null,
      lastRun: null,
      pr: null,
    };
    await this.deps.store.save(development);

    const invDir = this.sessionDir(id);
    const devDir = this.sessionDir(devId);
    for (const name of ['FINDINGS.md', 'PLAN.md']) {
      const src = `${invDir}/${name}`;
      if (await this.deps.fs.exists(src)) {
        await this.deps.fs.writeFile(`${devDir}/${name}`, await this.deps.fs.readFile(src));
      }
    }

    this.deps.events.emit('session.created', { session: development });
    await this.runDevelop(devId);
    const finalDevelopment = await this.deps.store.load(devId);
    return { investigation, development: finalDevelopment };
  }

  async runDevelop(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    if (session.mode !== 'development' || session.stageStatus !== 'active') {
      throw new UnsupportedStageError(
        `Session '${id}' cannot run develop (mode=${session.mode}, stage=${session.stageStatus})`,
      );
    }
    const sessionDir = this.sessionDir(id);
    const hasPlan = await this.deps.fs.exists(`${sessionDir}/PLAN.md`);
    const brief = renderDevelopBrief({ sessionDir, ticket: session.lineage.ticket, hasPlan });
    const prompt = STAGE_ENTRY_PROMPT(sessionDir);
    // No transition on success: PR detection (which drives active -> pr_opened) is Phase 3b.
    const result = await this.deps.stageRunner.run({ sessionId: id, stage: 'develop', brief, prompt });
    return result.session;
  }

  async runReview(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    const REVIEW_RUNNABLE_FROM: readonly ReviewPhase[] = ['queued', 'changes_requested', 'ready', 'failed'];
    if (session.mode !== 'review' || !REVIEW_RUNNABLE_FROM.includes(session.stageStatus)) {
      throw new UnsupportedStageError(
        `Session '${id}' cannot run review (mode=${session.mode}, stage=${session.stageStatus})`,
      );
    }
    if (!session.pr) {
      throw new UnsupportedStageError(`Session '${id}': review session has no pr`);
    }
    if (!session.workspace.worktreePath) {
      throw new WorkspaceMissingError(id);
    }
    await this.transition(id, 'reviewing');

    const sessionDir = this.sessionDir(id);
    const prompt = renderReviewPrompt({
      sessionDir,
      reviewSkillCommand: this.deps.config.reviewSkillCommand,
      includeLiveUiCheck: this.deps.config.includeLiveUiCheck,
    });
    let result;
    try {
      result = await this.deps.stageRunner.run({ sessionId: id, stage: 'review', brief: null, prompt });
    } catch (err) {
      await this.transition(id, 'failed');
      throw err;
    }

    // evaluateReview already treats a non-clean exit (including a stopped
    // run's signal) as 'failed' — no separate stopped-run special case needed.
    const outcome = await evaluateReview(result.exit, this.deps.fs, sessionDir);
    const updated = await this.transition(id, outcome === 'ready' ? 'ready' : 'failed');
    if (outcome === 'ready' && updated.mode === 'review' && updated.pr) {
      const withSha: Session = { ...updated, pr: { ...updated.pr, reviewedSha: updated.pr.headSha } };
      await this.deps.store.save(withSha);
      return withSha;
    }
    return updated;
  }

  async runRereview(id: string): Promise<Session> {
    const session = await this.deps.store.load(id);
    const REREVIEW_RUNNABLE_FROM: readonly ReviewPhase[] = ['ready', 'changes_requested', 'failed'];
    if (session.mode !== 'review' || !REREVIEW_RUNNABLE_FROM.includes(session.stageStatus)) {
      throw new UnsupportedStageError(
        `Session '${id}' cannot run rereview (mode=${session.mode}, stage=${session.stageStatus})`,
      );
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
    if (existingReview !== null) {
      const version = await nextReviewVersion(this.deps.fs, sessionDir);
      await this.deps.fs.writeFile(`${sessionDir}/REVIEW-v${version}.md`, existingReview);
      await this.deps.store.save({ ...session, reviewVersion: version });
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

    await this.transition(id, 'reviewing');

    const prompt = renderRereviewPrompt({ sessionDir, commitCount, reviewSkillCommand: this.deps.config.reviewSkillCommand });
    let result;
    try {
      result = await this.deps.stageRunner.run({ sessionId: id, stage: 'rereview', brief: null, prompt });
    } catch (err) {
      await this.transition(id, 'failed');
      throw err;
    }

    const { outcome } = await evaluateRereview(result.exit, this.deps.fs, sessionDir);
    if (outcome === 'ready') {
      const updated = await this.transition(id, 'ready');
      if (updated.mode === 'review' && updated.pr) {
        const withSha: Session = { ...updated, pr: { ...updated.pr, reviewedSha: newCommit, headSha: newCommit } };
        await this.deps.store.save(withSha);
        return withSha;
      }
      return updated;
    }
    return await this.transition(id, 'failed');
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
    }
  }

  async stop(id: string): Promise<boolean> {
    return this.deps.stageRunner.stop(id);
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

export function repoSlugFromUrl(repoUrl: string): string {
  const m = repoUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : repoUrl.replace(/[^a-zA-Z0-9._-]/g, '-');
}
export { repoSlugFromUrl as repoSlug };
