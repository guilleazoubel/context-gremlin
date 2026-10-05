import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POST_COMMENT_HELPER_PATH,
  POST_HELPER_PATHS,
  POST_REVIEW_HELPER_PATH,
  postHelperFiles,
  removePostHelpers,
  writePostHelpers,
} from '../../src/workspace/post-helpers';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

/**
 * Phase 20 — the agent may not type `gh pr review`, `gh pr comment` or
 * `gh api`, so the two REST calls it legitimately makes are carried by these
 * helpers, with the session's repo and number baked in at write time. These
 * tests run the SHIPPED scripts under `node`, in dry-run, so what is asserted
 * is the artifact itself and never a re-implementation of it — and no request
 * ever leaves the machine.
 */
const TARGET = { repoSlug: 'acme/app', prNumber: 42 };

function installedHelper(relativePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'post-helpers-'));
  mkdirSync(join(dir, '.cgremlin'), { recursive: true });
  for (const file of postHelperFiles(TARGET)) {
    writeFileSync(join(dir, file.relativePath), file.content, { mode: file.mode ?? 0o644 });
  }
  return join(dir, relativePath);
}

function run(
  relativePath: string,
  dryRunEnv: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [installedHelper(relativePath), ...args], {
      encoding: 'utf8',
      env: { ...process.env, [dryRunEnv]: '1' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const runHelper = (args: string[]) =>
  run(POST_REVIEW_HELPER_PATH, 'CGREMLIN_POST_REVIEW_DRY_RUN', args);
const runComment = (args: string[]) =>
  run(POST_COMMENT_HELPER_PATH, 'CGREMLIN_POST_COMMENT_DRY_RUN', args);

function jsonFile(payload: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'payload-')), 'payload.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}
const findingsFile = jsonFile;

describe('the helper cannot be retargeted', () => {
  it.each([
    ['--repo', 'acme/other'],
    ['--pr', '99'],
  ])('refuses %s %s — the target is baked in, not passed', (flag, value) => {
    const result = runHelper([findingsFile({ verdict: '💬 Comment', body: 'b' }), flag, value]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acme/app#42');
  });

  it('refuses a pull request URL as the findings file', () => {
    const result = runHelper(['https://github.com/acme/other/pull/99']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acme/app#42');
  });

  it('refuses a findings file whose own repo or number disagrees with the baked target', () => {
    for (const payload of [
      { verdict: '💬 Comment', body: 'b', repo: 'acme/other' },
      { verdict: '💬 Comment', body: 'b', prNumber: 99 },
    ]) {
      const result = runHelper([findingsFile(payload)]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('acme/app#42');
    }
  });

  it('posts to the baked repo and number and to no other URL', () => {
    const result = runHelper([findingsFile({ verdict: '💬 Comment', body: 'b' })]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).url).toBe('https://api.github.com/repos/acme/app/pulls/42/reviews');
  });
});

describe('the contract verdict picks the GitHub event', () => {
  it.each([
    ['🔄 Request changes', 'REQUEST_CHANGES'],
    ['💬 Comment', 'COMMENT'],
  ])('%s → %s', (verdict, event) => {
    const result = runHelper([findingsFile({ verdict, body: 'summary' })]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).body.event).toBe(event);
  });

  it('refuses a verdict that is neither of the two', () => {
    const result = runHelper([findingsFile({ verdict: '🚀 Ship it', body: 'b' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/verdict/i);
  });
});

/**
 * An agent may never approve. The brief says so, and this is the wall behind
 * the rule: whatever a review concludes, an approving review does not leave
 * this helper. Nothing is posted, the exit is non-zero, and the refusal says
 * what to send instead.
 */
describe('an approving verdict is refused outright — approving is the human’s', () => {
  it.each([
    ['✅ Approve'],
    ['approve'],
    ['✅ Approved — nothing blocking'],
    ['LGTM, approving'],
  ])('refuses the verdict %s and posts nothing', (verdict) => {
    const result = runHelper([findingsFile({ verdict, body: 'summary' })]);
    expect(result.status).not.toBe(0);
    // Dry run prints the request it WOULD send; a refusal prints nothing at all.
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('approving a pull request is the human’s alone');
    expect(result.stderr).toContain('💬 Comment');
  });

  it('cannot be smuggled in as an `event` field beside a comment verdict', () => {
    const result = runHelper([findingsFile({ verdict: '💬 Comment', body: 'b', event: 'APPROVE' })]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).body.event).toBe('COMMENT');
  });

  it('the shipped helper carries no APPROVE event at all', () => {
    const helper = postHelperFiles(TARGET).find((f) => f.relativePath === POST_REVIEW_HELPER_PATH);
    expect(helper?.content ?? '').not.toMatch(/APPROVE/);
  });
});

describe('one inline comment per finding at its path:line', () => {
  it('two path:line findings yield two inline comments in the request body', () => {
    const result = runHelper([
      findingsFile({
        verdict: '🔄 Request changes',
        body: 'summary',
        findings: [
          { where: 'src/api/web-content.ts:88', body: 'f1 · 🔴 Critical — boom' },
          { where: 'ui/list.tsx:40', body: 'f2 · 🔧 Maintainability — mixed' },
        ],
      }),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).body).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'summary',
      comments: [
        { path: 'src/api/web-content.ts', line: 88, body: 'f1 · 🔴 Critical — boom' },
        { path: 'ui/list.tsx', line: 40, body: 'f2 · 🔧 Maintainability — mixed' },
      ],
    });
  });

  it('a finding with no path:line Where stays in the body, not inline', () => {
    const result = runHelper([
      findingsFile({ verdict: '💬 Comment', body: 's', findings: [{ where: '/search', body: 'f3' }] }),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).body.comments).toEqual([]);
  });
});

describe('writePostHelpers', () => {
  it.each([POST_REVIEW_HELPER_PATH, POST_COMMENT_HELPER_PATH])(
    'writes an executable helper at %s',
    async (path) => {
      const fs = new InMemoryFileSystem();
      await fs.mkdir('/work/pr-1', { recursive: true });
      await writePostHelpers(fs, '/work/pr-1', TARGET);
      expect(await fs.statMode(`/work/pr-1/${path}`)).toBe(0o755);
      expect(await fs.readFile(`/work/pr-1/${path}`)).toContain('acme/app');
    },
  );

  it('writes both helpers at the paths the briefs name', () => {
    expect(POST_REVIEW_HELPER_PATH).toBe('.cgremlin/post-review');
    expect(POST_COMMENT_HELPER_PATH).toBe('.cgremlin/post-comment');
  });

  // R110 — the removal list is the write list, so neither can grow a file
  // the other does not know about.
  it('POST_HELPER_PATHS is exactly what postHelperFiles writes, and removePostHelpers takes it all out', async () => {
    const written = postHelperFiles({ repoSlug: 'acme/app', prNumber: 1 }).map((f) => f.relativePath);
    expect([...POST_HELPER_PATHS].sort()).toEqual([...written].sort());
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/pr-r110', { recursive: true });
    await writePostHelpers(fs, '/work/pr-r110', { repoSlug: 'acme/app', prNumber: 1 });
    await removePostHelpers(fs, '/work/pr-r110');
    for (const path of written) expect(await fs.exists(`/work/pr-r110/${path}`)).toBe(false);
  });
});

/**
 * `.cgremlin/post-comment` is the conversation-comment sibling. `gh pr
 * comment` is denied in every mode precisely because it takes `-R/--repo`, so
 * this helper must offer no way whatsoever to name a target.
 */
describe('the comment helper cannot be retargeted', () => {
  it.each([
    ['--repo', 'acme/other'],
    ['--body', 'hi'],
  ])('refuses the extra argument %s %s — the target is baked in, not passed', (flag, value) => {
    const result = runComment([jsonFile({ body: 'hello' }), flag, value]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acme/app#42');
  });

  it('refuses an option in place of the comment file', () => {
    const result = runComment(['--repo=acme/other']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acme/app#42');
  });

  it('refuses a pull request URL as the comment file', () => {
    const result = runComment(['https://github.com/acme/other/pull/99']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acme/app#42');
  });

  it('refuses a comment file whose own repo or number disagrees with the baked target', () => {
    for (const payload of [
      { body: 'hello', repo: 'acme/other' },
      { body: 'hello', prNumber: 99 },
    ]) {
      const result = runComment([jsonFile(payload)]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('acme/app#42');
    }
  });
});

describe('the comment helper posts one conversation comment', () => {
  it('posts to the issues-comments endpoint of the baked PR, and to no other URL', () => {
    const result = runComment([jsonFile({ body: 'looks good to me' })]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      url: 'https://api.github.com/repos/acme/app/issues/42/comments',
      body: { body: 'looks good to me' },
    });
  });

  it('refuses a comment file with no body to post', () => {
    const result = runComment([jsonFile({ body: '  ' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/body/i);
  });
});
