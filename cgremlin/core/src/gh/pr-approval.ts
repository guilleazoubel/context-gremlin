import type { Session } from '../schema/session';
import type { PostTarget } from '../workspace/post-helpers';
import type { GhRunner } from './gh-runner';

/**
 * The HUMAN's approval on a pull request — the one GitHub write no agent may
 * ever make (see ../workspace/post-helpers.ts, which refuses the approving
 * event, and ../pipeline/prompts.ts, which no longer names it).
 *
 * WHY THIS CANNOT BE POINTED AT ANOTHER PULL REQUEST. Everything in Phase 20
 * exists because `gh pr review --repo X <n>` takes a repository and a number
 * and therefore reaches every pull request the token can see. The post
 * helpers answer that by baking the target in at write time; this answers it
 * the same way. The route is `POST /sessions/:id/approve-pr`: the only thing
 * a caller supplies is a SESSION id, and the repo slug and the pull request
 * number are read here out of `session.pr` — the document the engine itself
 * wrote when it created the review. There is no repo, number or URL
 * parameter to aim, and a request body that names a different repository or
 * number is refused rather than honoured, exactly as the helpers refuse a
 * findings file that does. The engine grows no "approve any PR" endpoint:
 * every pull request this route can reach is one the engine already reviewed.
 */

/** A review that has actually produced a review. Nothing else may be approved. */
const REVIEWED_PHASES = ['ready', 'changes_requested', 'approved'] as const;

export type ApprovalTargetResult =
  | { ok: true; target: PostTarget }
  | { ok: false; kind: 'not-a-review' | 'no-pr' | 'not-reviewed' | 'retargeted'; message: string };

/** Keys a caller might use to name a pull request. Each one is checked, none is honoured. */
const REPO_KEYS = ['repo', 'repository'] as const;
const NUMBER_KEYS = ['prNumber', 'pull_number', 'number'] as const;

export function resolveApprovalTarget(session: Session, body: unknown): ApprovalTargetResult {
  if (session.mode !== 'review') {
    return {
      ok: false,
      kind: 'not-a-review',
      message: `Session '${session.id}' is a ${session.mode} session — only a review session's own pull request can be approved`,
    };
  }
  const pr = session.pr;
  if (pr === null) {
    return { ok: false, kind: 'no-pr', message: `Session '${session.id}' has no pull request to approve` };
  }
  if (!(REVIEWED_PHASES as readonly string[]).includes(session.stageStatus)) {
    return {
      ok: false,
      kind: 'not-reviewed',
      message: `Session '${session.id}' is at '${session.stageStatus}' — approve a pull request after its review is written, not before`,
    };
  }
  const target: PostTarget = { repoSlug: pr.repo, prNumber: pr.number };
  const said = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const refused = (named: string): ApprovalTargetResult => ({
    ok: false,
    kind: 'retargeted',
    message: `This route approves ${pr.repo}#${pr.number}, the pull request session '${session.id}' reviewed, and nothing else — the request names ${named}`,
  });
  for (const key of REPO_KEYS) {
    if (said[key] !== undefined && String(said[key]) !== pr.repo) return refused(String(said[key]));
  }
  for (const key of NUMBER_KEYS) {
    if (said[key] !== undefined && Number(said[key]) !== pr.number) return refused(String(said[key]));
  }
  return { ok: true, target };
}

/** Posts the approval. One implementation; the tests substitute their own. */
export interface PrApprover {
  approve(target: PostTarget): Promise<void>;
}

export class PrApprovalFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrApprovalFailedError';
  }
}

/**
 * Reads the user's own token with `gh auth token` and calls api.github.com
 * directly — the same route the post helpers take, and for the same reason:
 * `gh pr review` is the verb this whole design refuses to build an argv for
 * (MG-14). The approval is posted as the user, because it IS the user's.
 */
export class GhTokenPrApprover implements PrApprover {
  constructor(
    private readonly gh: GhRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async approve(target: PostTarget): Promise<void> {
    let token: string;
    try {
      token = (await this.gh.run(['auth', 'token'])).stdout.trim();
    } catch (err) {
      throw new PrApprovalFailedError(`could not read a GitHub token from \`gh auth token\`: ${(err as Error).message}`);
    }
    const url = `https://api.github.com/repos/${target.repoSlug}/pulls/${target.prNumber}/reviews`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'cgremlin-approve-pr',
      },
      body: JSON.stringify({ event: 'APPROVE', body: 'Approved.' }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new PrApprovalFailedError(
        `GitHub refused the approval of ${target.repoSlug}#${target.prNumber} (${response.status}): ${text}`,
      );
    }
  }
}
