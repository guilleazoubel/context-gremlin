import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView, type ReviewDecision } from '../gh/pr-view';
import { parsePrUrl } from '../gh/pr-url';
import { OwnPrError } from '../gh/own-pr-error';
import { linkPrToSource } from '../discovery/link-pr-to-source';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { EngineEvents } from '../engine/events';
import type { ReviewSession } from '../schema/session';
import { stamp } from './pipeline-service';
import { extractTicketKey } from '../gh/ticket-key';

export interface CandidatePR {
  kind: 'review' | 'own';
  repo: string;
  number: number;
  url: string;
  author: string;
  isDraft: boolean;
  reviewDecision: ReviewDecision;
  headSha: string;
  title: string;
}

export interface CreateFromPrUrlOptions {
  refuseAuthor?: string;
  selfReview?: boolean;
}

export interface ReviewSessionFactoryDeps {
  gh: GhRunner;
  store: SessionStore;
  workspace: WorkspaceManager;
  events: EngineEvents;
  sessionsDir: string;
  worktreesDir: string;
  now?: () => Date;
  newId?: (slug: string, number: number) => string;
}

function repoName(slug: string): string {
  return slug.split('/').pop() ?? slug;
}

export class ReviewSessionFactory {
  constructor(private readonly deps: ReviewSessionFactoryDeps) {}

  /** `refuseAuthor`: reject the PR (before any worktree exists) when it is authored by that login, case-insensitively. */
  async createFromPrUrl(prUrl: string, opts?: CreateFromPrUrlOptions): Promise<ReviewSession> {
    const ref = parsePrUrl(prUrl);
    return this.create(ref.slug, ref.number, opts);
  }

  async createFromCandidate(candidate: CandidatePR): Promise<ReviewSession> {
    // Phase 10: a candidate seeded `kind: 'own'` is a deliberate self-review
    // (the `selfReview` request flag bypassed OwnPrError upstream) — record
    // it on lineage so attention/inventory can tell the two apart.
    return this.create(candidate.repo, candidate.number, { selfReview: candidate.kind === 'own' });
  }

  private async create(slug: string, number: number, opts?: CreateFromPrUrlOptions): Promise<ReviewSession> {
    const { gh, store, workspace, events, worktreesDir, now, newId } = this.deps;

    const { stdout } = await gh.run(['pr', 'view', String(number), '--repo', slug, '--json', PR_VIEW_FIELDS]);
    const mapped = mapPrView(slug, parsePrView(stdout));

    // Checked from the view we already fetched (no second gh call) and BEFORE
    // createWorkspace, so a refusal leaves no worktree and no session behind.
    const refuseAuthor = opts?.refuseAuthor;
    if (
      refuseAuthor !== undefined &&
      mapped.pr.author !== null &&
      mapped.pr.author.toLowerCase() === refuseAuthor.toLowerCase()
    ) {
      throw new OwnPrError(slug, number);
    }

    const nowDate = (now ?? (() => new Date()))();
    const id = (newId ?? ((s, n) => `pr-${repoName(s)}-${n}-${stamp(nowDate)}`))(slug, number);

    const repoUrl = `https://github.com/${slug}.git`;
    const worktreePath = `${worktreesDir}/${id}`;
    const branchName = `pr-${number}`;
    const baseRef = `origin/pr/${number}`;

    await workspace.createWorkspace({ repoUrl, worktreePath, branchName, baseRef, mode: 'review' });

    const session: ReviewSession = {
      schemaVersion: 2,
      id,
      mode: 'review',
      createdAt: nowDate.toISOString(),
      workspace: { repoUrl, worktreePath, branch: branchName },
      lineage: {
        pipelineId: id,
        parentSessionId: null,
        ticket: extractTicketKey(mapped.headRefName),
        selfReview: opts?.selfReview === true,
      },
      agent: null,
      lastRun: null,
      pr: mapped.pr,
      stageStatus: 'queued',
      reviewVersion: 0,
      lastRereviewSummary: null,
    };

    const { linked, source, supersede } = linkPrToSource(session, await store.list());
    await store.save(linked);
    if (supersede && source) {
      const updated = await store.transition(source.id, 'superseded');
      events.emit('session.transitioned', { session: updated, from: 'pr_opened', to: 'superseded' });
    }
    events.emit('session.created', { session: linked });

    return linked;
  }
}
