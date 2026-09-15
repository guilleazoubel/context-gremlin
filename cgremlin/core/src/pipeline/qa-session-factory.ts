import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { EngineEvents } from '../engine/events';
import type { QaSession } from '../schema/session';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { stamp } from './pipeline-service';

/** The PR fields a QA brief needs beyond `PR_VIEW_FIELDS`: the merge commit QA is supposed to be running, and the file list. */
export const PR_QA_VIEW_FIELDS = `${PR_VIEW_FIELDS},mergeCommit,files`;

/**
 * R70 — a verification may only start once EVERY PR on the item has merged.
 * The factory enforces it on the single PR it is handed; the caller (the
 * API route, the trigger leg) enforces it across the item.
 */
export class PrNotMergedError extends Error {
  constructor(repo: string, number: number, state: string) {
    super(`PR ${repo}#${number} is ${state}, not merged; QA verification only runs on merged work`);
    this.name = 'PrNotMergedError';
  }
}

export interface QaSessionFactoryDeps {
  gh: GhRunner;
  store: SessionStore;
  workspace: WorkspaceManager;
  events: EngineEvents;
  worktreesDir: string;
  defaultBaseRef: string;
  now?: () => Date;
  newId?: (ticket: string, slug: string) => string;
}

function repoName(slug: string): string {
  return slug.split('/').pop() ?? slug;
}

/** What `gh pr view --json mergeCommit` adds on top of `parsePrView`. */
interface MergeInfo {
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
  state: string;
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
}

/**
 * R68/R70 — the QA session factory. It sits OFF the forward-only ladder: it
 * is not reachable from `nextStages`, only from the QA verbs and the
 * automatic leg, and it refuses anything that has not merged.
 */
export class QaSessionFactory {
  constructor(private readonly deps: QaSessionFactoryDeps) {}

  /** The live QA session for this ticket, or null. Used by the parity rule on a second POST and by the trigger. */
  async existingFor(ticket: string): Promise<QaSession | null> {
    const sessions = await this.deps.store.list();
    return (
      (sessions.find(
        (s): s is QaSession =>
          s.mode === 'qa' &&
          !TERMINAL_PHASES_BY_MODE.qa.has(s.stageStatus) &&
          s.lineage.ticket === ticket,
      ) as QaSession | undefined) ?? null
    );
  }

  /**
   * Creates the session for a ticket whose PR has merged. `baseRef` is the
   * MERGE COMMIT, not a branch: the worktree must be exactly what QA is
   * supposed to be running, and the PR's own head branch may have moved (or
   * been deleted) since.
   */
  async createFromMergedPr(ticket: string, slug: string, number: number): Promise<QaSession> {
    const { gh, store, workspace, events, worktreesDir, now, newId } = this.deps;

    const { stdout } = await gh.run(['pr', 'view', String(number), '--repo', slug, '--json', PR_QA_VIEW_FIELDS]);
    const raw = JSON.parse(stdout) as MergeInfo;
    const mapped = mapPrView(slug, parsePrView(stdout));

    // BEFORE createWorkspace, so a refusal leaves no worktree and no session
    // behind — the same refuse-before-you-create ordering the review and
    // respond factories use.
    if (raw.state !== 'MERGED' || raw.mergeCommit === null) {
      throw new PrNotMergedError(slug, number, raw.state);
    }
    const mergeSha = raw.mergeCommit.oid;

    const nowDate = (now ?? (() => new Date()))();
    const id = (newId ?? ((t, s) => `qa-${repoName(s)}-${t}-${stamp(nowDate)}`))(ticket, slug);

    const repoUrl = `https://github.com/${slug}.git`;
    const worktreePath = `${worktreesDir}/${id}`;
    const branchName = `qa/${ticket}-${mergeSha.slice(0, 7)}`;

    await workspace.createWorkspace({
      repoUrl,
      worktreePath,
      branchName,
      baseRef: mergeSha,
      mode: 'qa',
      // The branch name embeds the sha, but a re-entry at the same sha
      // reuses it, so the mirror may already carry it from a prior run.
      resetBranch: true,
    });

    const session: QaSession = {
      schemaVersion: 2,
      id,
      mode: 'qa',
      createdAt: nowDate.toISOString(),
      workspace: { repoUrl, worktreePath, branch: branchName },
      lineage: { pipelineId: id, parentSessionId: null, ticket, selfReview: false },
      agent: null,
      lastRun: null,
      // `headSha` carries the MERGE commit here: it is the commit this
      // session verifies, and every downstream reader (the brief, the
      // verified-sha patch, the trigger's identity) wants that one.
      pr: { ...mapped.pr, headSha: mergeSha },
      stageStatus: 'queued',
      qa: { verifiedSha: null, verdict: null },
    };
    await store.save(session);
    events.emit('session.created', { session });
    return session;
  }
}
