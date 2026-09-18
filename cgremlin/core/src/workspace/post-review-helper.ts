import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

/**
 * Phase 20 — `gh api` is denied outright for the posting modes (see
 * ./permission-guard.ts). A review with inline comments still needs the REST
 * reviews endpoint, which `gh pr review` cannot reach, so the engine writes
 * THIS helper into the worktree with the session's repo slug and PR number
 * baked in at write time. The agent runs `.cgremlin/post-review <findings>`;
 * there is no repo, number or URL it can pass, so the one call it can make
 * goes to one pull request and no other.
 *
 * It does NOT shell out to `gh api`: whether a deny rule reaches a subprocess
 * a script spawns is not something this repository can establish, so the
 * helper reads a token with `gh auth token` (a verb no mode denies) and calls
 * api.github.com itself. That is correct under either answer.
 */
export interface PostReviewTarget {
  readonly repoSlug: string;
  readonly prNumber: number;
}

export const POST_REVIEW_HELPER_PATH = '.cgremlin/post-review';
const POST_REVIEW_HELPER_PACKAGE_JSON = '.cgremlin/package.json';

/** Only the two modes that post. QA, development and investigation get nothing. */
const POSTING_MODES: readonly SessionMode[] = ['review', 'respond'];
export function shouldWritePostReviewHelper(mode: SessionMode): boolean {
  return POSTING_MODES.includes(mode);
}

export interface PostReviewHelperFile {
  readonly relativePath: string;
  readonly content: string;
  readonly mode?: number;
}

export function renderPostReviewHelper(target: PostReviewTarget): string {
  const repo = JSON.stringify(target.repoSlug);
  const pr = JSON.stringify(target.prNumber);
  // Written as ESM (the sibling package.json pins `type: module`, so the host
  // repository's own package type cannot change how this file is parsed).
  return `#!/usr/bin/env node
// cgremlin post-review — written by the engine for ONE session.
// The repository and the pull request number are baked in below. Nothing on
// the command line can change them: the only argument is a findings file.
//   usage: ${POST_REVIEW_HELPER_PATH} <findings.json>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = ${repo};
const PR = ${pr};
const TARGET = REPO + '#' + PR;
const ENDPOINT = 'https://api.github.com/repos/' + REPO + '/pulls/' + PR + '/reviews';

function refuse(why) {
  process.stderr.write('post-review: refused — ' + why + '\\n');
  process.stderr.write('post-review: this helper posts one review to ' + TARGET + ', and nothing else.\\n');
  process.exit(2);
}

const EVENTS = [['approve', 'APPROVE'], ['request changes', 'REQUEST_CHANGES'], ['comment', 'COMMENT']];
function eventFor(verdict) {
  const text = String(verdict === undefined || verdict === null ? '' : verdict).toLowerCase();
  for (const pair of EVENTS) if (text.indexOf(pair[0]) !== -1) return pair[1];
  return null;
}

const args = process.argv.slice(2);
if (args.length !== 1) refuse('expects exactly one argument, the findings file — the pull request is not a parameter');
const file = args[0];
if (file.charAt(0) === '-') refuse('the option ' + file + ' is not accepted');
if (file.indexOf('://') !== -1) refuse('a URL is not accepted');

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  refuse('cannot read the findings file ' + file + ': ' + err.message);
}
if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) refuse('the findings file must be a JSON object');

for (const key of ['repo', 'repository']) {
  if (doc[key] !== undefined && String(doc[key]) !== REPO) refuse('the findings file names the repository ' + doc[key]);
}
for (const key of ['prNumber', 'pull_number', 'number']) {
  if (doc[key] !== undefined && Number(doc[key]) !== PR) refuse('the findings file names pull request ' + doc[key]);
}

const event = eventFor(doc.verdict);
if (event === null) refuse('the verdict ' + JSON.stringify(doc.verdict) + ' is not one of: Approve, Request changes, Comment');

const findings = Array.isArray(doc.findings) ? doc.findings : [];
const comments = [];
for (const finding of findings) {
  if (finding === null || typeof finding !== 'object') refuse('every entry of "findings" must be an object');
  const match = /^(.+):([0-9]+)$/.exec(String(finding.where === undefined ? '' : finding.where));
  // A finding with no path:line "Where" (a PM/AC or design finding) belongs in
  // the review body, not at a line — it is deliberately not an inline comment.
  if (match === null) continue;
  comments.push({ path: match[1], line: Number(match[2]), body: String(finding.body === undefined ? '' : finding.body) });
}

const payload = { event: event, body: String(doc.body === undefined ? '' : doc.body), comments: comments };

if (process.env.CGREMLIN_POST_REVIEW_DRY_RUN === '1') {
  process.stdout.write(JSON.stringify({ url: ENDPOINT, body: payload }) + '\\n');
  process.exit(0);
}

let token;
try {
  token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
} catch (err) {
  refuse('could not read a GitHub token from \`gh auth token\`: ' + err.message);
}

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + token,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'cgremlin-post-review',
  },
  body: JSON.stringify(payload),
});
const text = await response.text();
if (!response.ok) {
  process.stderr.write('post-review: GitHub refused the review (' + response.status + '): ' + text + '\\n');
  process.exit(1);
}
process.stdout.write('post-review: posted ' + payload.event + ' with ' + comments.length + ' inline comment(s) to ' + TARGET + '\\n');
`;
}

export function postReviewHelperFiles(target: PostReviewTarget): PostReviewHelperFile[] {
  return [
    // Pins the module type so the HOST repository's own package.json cannot
    // change how an extensionless entry point is parsed.
    { relativePath: POST_REVIEW_HELPER_PACKAGE_JSON, content: `{ "type": "module" }\n` },
    { relativePath: POST_REVIEW_HELPER_PATH, content: renderPostReviewHelper(target), mode: 0o755 },
  ];
}

export async function writePostReviewHelper(
  fs: SessionFileSystem,
  worktreePath: string,
  target: PostReviewTarget,
): Promise<void> {
  await fs.mkdir(`${worktreePath}/.cgremlin`, { recursive: true });
  for (const file of postReviewHelperFiles(target)) {
    await fs.writeFile(`${worktreePath}/${file.relativePath}`, file.content, { mode: file.mode });
  }
}
