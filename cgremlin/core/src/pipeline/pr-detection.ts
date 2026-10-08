import { GhCommandError, type GhRunner } from '../gh/gh-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { PrInfo } from '../schema/stage';
import { parsePrUrl } from '../gh/pr-url';
import { PR_LIST_FIELDS, PR_VIEW_FIELDS, mapPrView, parsePrList, parsePrView } from '../gh/pr-view';
import { redactSecrets } from '../config/core-config';

export type PrDetection =
  | { found: true; pr: PrInfo; isDraft: boolean; via: 'PR_URL' | 'gh pr list' }
  | { found: false; why: string };

export interface DetectPrInput {
  gh: GhRunner;
  fs: SessionFileSystem;
  sessionDir: string;
  /** "owner/name" of the session's repo. */
  repoSlug: string;
  /** The session's own branch: the only head a PR may have to be this session's. */
  branch: string;
  /** CoreConfig.me — the only author a PR may have to be this session's (S2-31). */
  me: string;
}

/**
 * One line, redacted, ≤ 200 chars. A GhCommandError's own message leads with every argument
 * (the long `--json` field list), which would push the reason — gh's stderr — past the cap, so
 * it is summarized as the verb and the first non-empty stderr line. Redacted before it is cut,
 * so a cut can never split a secret out of the redactor's reach.
 */
function messageOf(err: unknown): string {
  const text =
    err instanceof GhCommandError
      ? `gh ${err.args.slice(0, 2).join(' ')} exited with code ${err.exitCode}: ${firstLine(err.stderr)}`
      : firstLine(err instanceof Error ? err.message : String(err));
  return clip(text);
}

/** Agent-written text that reaches a reason (and so the engine log): redacted, then ≤ 200 chars. */
function clip(text: string): string {
  return redactSecrets(text).slice(0, 200);
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function isMe(login: string, me: string): boolean {
  return login.toLowerCase() === me.toLowerCase();
}

async function prUrlHint(fs: SessionFileSystem, sessionDir: string): Promise<string | null> {
  const text = await fs.readFile(`${sessionDir}/PR_URL`).catch(() => null);
  if (text === null) return null;
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? null;
}

/**
 * R91 — which OPEN pull request this development session's branch has, if any.
 *
 * READ-ONLY: the only gh verbs used are `pr view` and `pr list`; nothing here opens, readies,
 * edits or posts. The agent's PR_URL is a hint, never trusted on its own (it is agent-written
 * text): it must parse as a GitHub PR URL, name THIS repo, be OPEN, have this session's branch
 * as its head and be authored by `me` — otherwise it is ignored and `gh pr list --head <branch>`
 * decides, adopting only an unambiguous single match by `me`. Never throws: a missing or
 * unauthenticated gh is `found: false` with the reason.
 */
export async function detectDevelopmentPr(input: DetectPrInput): Promise<PrDetection> {
  const notes: string[] = [];
  const hint = await prUrlHint(input.fs, input.sessionDir);
  if (hint !== null) {
    try {
      const ref = parsePrUrl(hint);
      if (ref.slug.toLowerCase() !== input.repoSlug.toLowerCase()) {
        notes.push(`PR_URL names ${clip(ref.slug)}, not ${input.repoSlug}`);
      } else {
        const { stdout } = await input.gh.run([
          'pr', 'view', String(ref.number), '--repo', input.repoSlug, '--json', PR_VIEW_FIELDS,
        ]);
        const view = mapPrView(input.repoSlug, parsePrView(stdout));
        const author = view.pr.author ?? '';
        if (view.headRefName !== input.branch) {
          notes.push(`PR_URL #${ref.number} is for branch ${view.headRefName}, not ${input.branch}`);
        } else if (view.state !== 'OPEN') {
          notes.push(`PR_URL #${ref.number} is ${view.state}`);
        } else if (!isMe(author, input.me)) {
          notes.push(`PR_URL #${ref.number} is by ${author}, not ${input.me}`);
        } else {
          return { found: true, pr: view.pr, isDraft: view.isDraft, via: 'PR_URL' };
        }
      }
    } catch (err) {
      notes.push(`PR_URL unusable: ${messageOf(err)}`);
    }
  }
  try {
    const { stdout } = await input.gh.run([
      'pr', 'list', '--repo', input.repoSlug, '--head', input.branch, '--state', 'open', '--json', PR_LIST_FIELDS, '--limit', '5',
    ]);
    const matches = parsePrList(stdout).filter((item) => item.headRefName === input.branch && isMe(item.author.login, input.me));
    if (matches.length === 1) {
      const item = matches[0];
      return {
        found: true,
        via: 'gh pr list',
        isDraft: item.isDraft,
        pr: {
          repo: input.repoSlug, number: item.number, url: item.url, headSha: item.headRefOid,
          reviewedSha: null, title: item.title, author: item.author.login,
        },
      };
    }
    notes.push(
      matches.length === 0
        ? `no open PR by ${input.me} has head ${input.branch}`
        : `${matches.length} open PRs by ${input.me} have head ${input.branch}; not guessing`,
    );
  } catch (err) {
    notes.push(`gh pr list failed: ${messageOf(err)}`);
  }
  return { found: false, why: notes.join('; ') };
}
