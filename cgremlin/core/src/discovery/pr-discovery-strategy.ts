import type { GhRunner } from '../gh/gh-runner';
import { PR_LIST_FIELDS, parsePrList, type PrListItem, type ReviewDecision } from '../gh/pr-view';
import type { Session } from '../schema/session';
import type { DiscoveryConfig } from './discovery-config';

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

export interface DiscoveryContext {
  existingSessions: readonly Session[];
}

export interface DiscoveryRepoError {
  repo: string;
  error: string;
}

export interface PRDiscoveryStrategy {
  readonly lastErrors: readonly DiscoveryRepoError[];
  poll(config: DiscoveryConfig, ctx: DiscoveryContext): Promise<CandidatePR[]>;
}

function isAlreadyTracked(sessions: readonly Session[], repo: string, number: number): boolean {
  return sessions.some((s) => s.mode === 'review' && s.pr?.repo === repo && s.pr.number === number);
}

export class DefaultPRDiscoveryStrategy implements PRDiscoveryStrategy {
  readonly lastErrors: DiscoveryRepoError[] = [];

  constructor(private readonly gh: GhRunner) {}

  async poll(config: DiscoveryConfig, ctx: DiscoveryContext): Promise<CandidatePR[]> {
    this.lastErrors.length = 0;
    const candidates: CandidatePR[] = [];

    for (const repo of config.repos) {
      let items: PrListItem[];
      try {
        const { stdout } = await this.gh.run([
          'pr', 'list',
          '--repo', repo,
          '--state', 'open',
          '--limit', String(config.prListLimit),
          '--json', PR_LIST_FIELDS,
        ]);
        items = parsePrList(stdout);
      } catch (err) {
        this.lastErrors.push({ repo, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      for (const item of items) {
        if (item.reviewDecision === 'APPROVED') continue;
        if (item.author.is_bot === true) continue;
        const isWatched = config.watchAuthors.some(
          (author) => author.toLowerCase() === item.author.login.toLowerCase(),
        );
        if (!isWatched) continue;
        const isOwn = item.author.login.toLowerCase() === config.me.toLowerCase();
        if (item.isDraft && !isOwn) continue;
        if (isAlreadyTracked(ctx.existingSessions, repo, item.number)) continue;

        candidates.push({
          kind: isOwn ? 'own' : 'review',
          repo,
          number: item.number,
          url: item.url,
          author: item.author.login,
          isDraft: item.isDraft,
          reviewDecision: item.reviewDecision,
          headSha: item.headRefOid,
          title: item.title,
        });
      }
    }

    return candidates;
  }
}
