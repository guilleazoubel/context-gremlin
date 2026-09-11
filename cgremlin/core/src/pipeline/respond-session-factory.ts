import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { EngineEvents } from '../engine/events';
import type { RespondSession } from '../schema/session';
import { TERMINAL_PHASES_BY_MODE } from '../workspace/workspace-in-use';
import { stamp } from './pipeline-service';
import { extractTicketKey } from '../gh/ticket-key';

/**
 * The mirror of `OwnPrError`, and the reason that one still exists: review
 * mode refuses MY OWN PR, respond mode refuses SOMEBODY ELSE'S.
 */
export class NotMyPrError extends Error {
  constructor(repo: string, number: number) {
    super(`PR ${repo}#${number} is not yours; respond mode only addresses reviews on your own pull request`);
    this.name = 'NotMyPrError';
  }
}

export interface RespondSessionFactoryDeps {
  gh: GhRunner;
  store: SessionStore;
  workspace: WorkspaceManager;
  events: EngineEvents;
  worktreesDir: string;
  /** The login a PR must be authored by, compared case-insensitively. */
  me: string;
  now?: () => Date;
  newId?: (slug: string, number: number) => string;
}

function repoName(slug: string): string {
  return slug.split('/').pop() ?? slug;
}

/**
 * R51 — `RespondSessionFactory`, the mirror of `ReviewSessionFactory`. It
 * fetches the PR once with `PR_VIEW_FIELDS` and, **before** `createWorkspace`,
 * requires the author to be me: the same refuse-before-you-create ordering,
 * so a refusal leaves no worktree and no session behind.
 */
export class RespondSessionFactory {
  constructor(private readonly deps: RespondSessionFactoryDeps) {}

  /** The live respond session for this PR, or null. Used by the parity rule on a second POST. */
  async existingFor(slug: string, number: number): Promise<RespondSession | null> {
    const sessions = await this.deps.store.list();
    return (
      (sessions.find(
        (s): s is RespondSession =>
          s.mode === 'respond' &&
          !TERMINAL_PHASES_BY_MODE.respond.has(s.stageStatus) &&
          s.pr !== null &&
          s.pr.repo === slug &&
          s.pr.number === number,
      ) as RespondSession | undefined) ?? null
    );
  }

  async createFromPr(slug: string, number: number): Promise<RespondSession> {
    const { gh, store, workspace, events, worktreesDir, now, newId } = this.deps;

    const { stdout } = await gh.run(['pr', 'view', String(number), '--repo', slug, '--json', PR_VIEW_FIELDS]);
    const mapped = mapPrView(slug, parsePrView(stdout));

    // BEFORE createWorkspace: the same ordering `review-session-factory.ts`
    // uses for `OwnPrError`, asserted by a test that the workspace fake
    // recorded zero calls.
    if (mapped.pr.author === null || mapped.pr.author.toLowerCase() !== this.deps.me.toLowerCase()) {
      throw new NotMyPrError(slug, number);
    }

    const nowDate = (now ?? (() => new Date()))();
    const id = (newId ?? ((s, n) => `respond-${repoName(s)}-${n}-${stamp(nowDate)}`))(slug, number);

    const repoUrl = `https://github.com/${slug}.git`;
    const worktreePath = `${worktreesDir}/${id}`;
    // R51: the PR's OWN head branch, not a detached `pr-N` branch — the point
    // of the mode is to commit a fix onto that branch.
    const branchName = mapped.headRefName;
    const baseRef = `origin/${mapped.headRefName}`;

    // `resetBranch` (R51): the bare mirror already carries `refs/heads/<head branch>` from its
    // `clone --bare`, so `-b` would fail on the very first respond run — and even if it did not,
    // that ref is the clone-time snapshot, not the fetched head.
    await workspace.createWorkspace({
      repoUrl,
      worktreePath,
      branchName,
      baseRef,
      mode: 'respond',
      resetBranch: true,
    });

    const session: RespondSession = {
      schemaVersion: 2,
      id,
      mode: 'respond',
      createdAt: nowDate.toISOString(),
      workspace: { repoUrl, worktreePath, branch: branchName },
      lineage: { pipelineId: id, parentSessionId: null, ticket: extractTicketKey(mapped.headRefName) },
      agent: null,
      lastRun: null,
      pr: mapped.pr,
      stageStatus: 'triaging',
    };
    await store.save(session);
    events.emit('session.created', { session });
    return session;
  }
}
