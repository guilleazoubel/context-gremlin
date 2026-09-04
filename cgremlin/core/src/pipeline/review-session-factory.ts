import type { GhRunner } from '../gh/gh-runner';
import { PR_VIEW_FIELDS, mapPrView, parsePrView } from '../gh/pr-view';
import { parsePrUrl } from '../gh/pr-url';
import type { CandidatePR } from '../discovery/pr-discovery-strategy';
import { linkPrToSource } from '../discovery/link-pr-to-source';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager } from '../workspace/workspace-manager';
import type { EngineEvents } from '../engine/events';
import type { ReviewSession } from '../schema/session';
import { stamp } from './pipeline-service';
import { extractTicketKey } from '../gh/ticket-key';

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

  async createFromPrUrl(prUrl: string): Promise<ReviewSession> {
    const ref = parsePrUrl(prUrl);
    return this.create(ref.slug, ref.number);
  }

  async createFromCandidate(candidate: CandidatePR): Promise<ReviewSession> {
    return this.create(candidate.repo, candidate.number);
  }

  private async create(slug: string, number: number): Promise<ReviewSession> {
    const { gh, store, workspace, events, worktreesDir, now, newId } = this.deps;

    const { stdout } = await gh.run(['pr', 'view', String(number), '--repo', slug, '--json', PR_VIEW_FIELDS]);
    const mapped = mapPrView(slug, parsePrView(stdout));

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
      lineage: { pipelineId: id, parentSessionId: null, ticket: extractTicketKey(mapped.headRefName) },
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
