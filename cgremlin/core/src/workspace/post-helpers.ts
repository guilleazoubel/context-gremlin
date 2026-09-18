import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

/**
 * Phase 20 — no mode may type a GitHub write verb (see ./permission-guard.ts):
 * `gh pr review`, `gh pr comment` and `gh api` are all denied, because all
 * three take a repository and a number and would therefore reach every pull
 * request the token can see. The two writes a review or respond agent
 * legitimately makes are carried by THESE helpers, which the engine writes
 * into the worktree with the session's repo slug and PR number baked in at
 * write time. The agent runs `.cgremlin/post-review <findings.json>` or
 * `.cgremlin/post-comment <comment.json>`; there is no repo, number or URL it
 * can pass, so the calls it can make go to one pull request and no other.
 *
 * They do NOT shell out to `gh api`: whether a deny rule reaches a subprocess
 * a script spawns is not something this repository can establish, so a helper
 * reads a token with `gh auth token` (a verb no mode denies) and calls
 * api.github.com itself. That is correct under either answer.
 *
 * The two share their whole skeleton — argument handling, the refusal to be
 * retargeted, the dry run, the token and the POST — so that neither can drift
 * into being laxer than the other. Only the endpoint and the payload differ.
 */
export interface PostTarget {
  readonly repoSlug: string;
  readonly prNumber: number;
}

export const POST_REVIEW_HELPER_PATH = '.cgremlin/post-review';
export const POST_COMMENT_HELPER_PATH = '.cgremlin/post-comment';
const HELPER_PACKAGE_JSON = '.cgremlin/package.json';

interface HelperSpec {
  /** Basename of the helper, and the prefix of everything it says. */
  readonly name: string;
  /** Env var that makes it print the request instead of sending it. */
  readonly dryRunEnv: string;
  /** What the single argument holds, in the helper's own words. */
  readonly docName: string;
  /** JS expression appended to `.../repos/<slug>` to form the endpoint. */
  readonly endpointSuffix: string;
  /** What it posts, for the refusal line: "one review", "one comment". */
  readonly posts: string;
}

/**
 * Everything up to and including the parsed, target-checked `doc`. The body
 * that follows must define `payload`; `renderEpilogue` sends it.
 */
function renderPrologue(spec: HelperSpec, target: PostTarget): string {
  return `#!/usr/bin/env node
// cgremlin ${spec.name} — written by the engine for ONE session.
// The repository and the pull request number are baked in below. Nothing on
// the command line can change them: the only argument is a JSON file.
//   usage: .cgremlin/${spec.name} <${spec.docName}.json>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = ${JSON.stringify(target.repoSlug)};
const PR = ${JSON.stringify(target.prNumber)};
const TARGET = REPO + '#' + PR;
const ENDPOINT = 'https://api.github.com/repos/' + REPO + ${spec.endpointSuffix};

function refuse(why) {
  process.stderr.write('${spec.name}: refused — ' + why + '\\n');
  process.stderr.write('${spec.name}: this helper posts ${spec.posts} to ' + TARGET + ', and nothing else.\\n');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1) refuse('expects exactly one argument, the ${spec.docName} file — the pull request is not a parameter');
const file = args[0];
if (file.charAt(0) === '-') refuse('the option ' + file + ' is not accepted');
if (file.indexOf('://') !== -1) refuse('a URL is not accepted');

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  refuse('cannot read the ${spec.docName} file ' + file + ': ' + err.message);
}
if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) refuse('the ${spec.docName} file must be a JSON object');

for (const key of ['repo', 'repository']) {
  if (doc[key] !== undefined && String(doc[key]) !== REPO) refuse('the ${spec.docName} file names the repository ' + doc[key]);
}
for (const key of ['prNumber', 'pull_number', 'number']) {
  if (doc[key] !== undefined && Number(doc[key]) !== PR) refuse('the ${spec.docName} file names pull request ' + doc[key]);
}
`;
}

/** Sends the `payload` the body above defined, and reports what happened. */
function renderEpilogue(spec: HelperSpec, successExpr: string): string {
  return `
if (process.env.${spec.dryRunEnv} === '1') {
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
    'user-agent': 'cgremlin-${spec.name}',
  },
  body: JSON.stringify(payload),
});
const text = await response.text();
if (!response.ok) {
  process.stderr.write('${spec.name}: GitHub refused the request (' + response.status + '): ' + text + '\\n');
  process.exit(1);
}
process.stdout.write(${successExpr} + '\\n');
`;
}

const REVIEW_SPEC: HelperSpec = {
  name: 'post-review',
  dryRunEnv: 'CGREMLIN_POST_REVIEW_DRY_RUN',
  docName: 'findings',
  endpointSuffix: `'/pulls/' + PR + '/reviews'`,
  posts: 'one review',
};

const COMMENT_SPEC: HelperSpec = {
  name: 'post-comment',
  dryRunEnv: 'CGREMLIN_POST_COMMENT_DRY_RUN',
  docName: 'comment',
  endpointSuffix: `'/issues/' + PR + '/comments'`,
  posts: 'one conversation comment',
};

export function renderPostReviewHelper(target: PostTarget): string {
  // Written as ESM (the sibling package.json pins `type: module`, so the host
  // repository's own package type cannot change how this file is parsed).
  return `${renderPrologue(REVIEW_SPEC, target)}
const EVENTS = [['approve', 'APPROVE'], ['request changes', 'REQUEST_CHANGES'], ['comment', 'COMMENT']];
function eventFor(verdict) {
  const text = String(verdict === undefined || verdict === null ? '' : verdict).toLowerCase();
  for (const pair of EVENTS) if (text.indexOf(pair[0]) !== -1) return pair[1];
  return null;
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
${renderEpilogue(
  REVIEW_SPEC,
  `'post-review: posted ' + payload.event + ' with ' + comments.length + ' inline comment(s) to ' + TARGET`,
)}`;
}

/**
 * The conversation-comment sibling. It takes the same JSON-object argument as
 * `post-review` — not a bare text file — so that the "this file names another
 * repository / another number" refusal is the SAME code in both helpers, and
 * so an agent has one file shape to learn rather than two.
 */
export function renderPostCommentHelper(target: PostTarget): string {
  return `${renderPrologue(COMMENT_SPEC, target)}
const body = doc.body === undefined || doc.body === null ? '' : String(doc.body);
if (body.trim() === '') refuse('the comment file has no "body" to post');

const payload = { body: body };
${renderEpilogue(COMMENT_SPEC, `'post-comment: posted a conversation comment to ' + TARGET`)}`;
}

export interface PostHelperFile {
  readonly relativePath: string;
  readonly content: string;
  readonly mode?: number;
}

export function postHelperFiles(target: PostTarget): PostHelperFile[] {
  return [
    // Pins the module type so the HOST repository's own package.json cannot
    // change how an extensionless entry point is parsed.
    { relativePath: HELPER_PACKAGE_JSON, content: `{ "type": "module" }\n` },
    { relativePath: POST_REVIEW_HELPER_PATH, content: renderPostReviewHelper(target), mode: 0o755 },
    { relativePath: POST_COMMENT_HELPER_PATH, content: renderPostCommentHelper(target), mode: 0o755 },
  ];
}

/** Only the two modes that post. QA, development and investigation get nothing. */
const POSTING_MODES: readonly SessionMode[] = ['review', 'respond'];
export function shouldWritePostHelpers(mode: SessionMode): boolean {
  return POSTING_MODES.includes(mode);
}

export async function writePostHelpers(
  fs: SessionFileSystem,
  worktreePath: string,
  target: PostTarget,
): Promise<void> {
  await fs.mkdir(`${worktreePath}/.cgremlin`, { recursive: true });
  for (const file of postHelperFiles(target)) {
    await fs.writeFile(`${worktreePath}/${file.relativePath}`, file.content, { mode: file.mode });
  }
}
