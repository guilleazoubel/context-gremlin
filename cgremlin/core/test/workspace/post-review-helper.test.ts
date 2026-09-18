import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POST_REVIEW_HELPER_PATH,
  postReviewHelperFiles,
  writePostReviewHelper,
} from '../../src/workspace/post-review-helper';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

/**
 * Phase 20 — the agent may not call `gh api`, so the ONE REST call a review
 * with inline comments needs is made by this helper, with the session's repo
 * and number baked in at write time. These tests run the SHIPPED script under
 * `node`, in dry-run, so what is asserted is the artifact itself and never a
 * re-implementation of it — and no request ever leaves the machine.
 */
const TARGET = { repoSlug: 'acme/app', prNumber: 42 };

function installedHelper(): string {
  const dir = mkdtempSync(join(tmpdir(), 'post-review-'));
  mkdirSync(join(dir, '.cgremlin'), { recursive: true });
  for (const file of postReviewHelperFiles(TARGET)) {
    writeFileSync(join(dir, file.relativePath), file.content, { mode: file.mode ?? 0o644 });
  }
  return join(dir, POST_REVIEW_HELPER_PATH);
}

function runHelper(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [installedHelper(), ...args], {
      encoding: 'utf8',
      env: { ...process.env, CGREMLIN_POST_REVIEW_DRY_RUN: '1' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function findingsFile(payload: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'findings-')), 'findings.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

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
    ['✅ Approve', 'APPROVE'],
    ['🔄 Request changes', 'REQUEST_CHANGES'],
    ['💬 Comment', 'COMMENT'],
  ])('%s → %s', (verdict, event) => {
    const result = runHelper([findingsFile({ verdict, body: 'summary' })]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).body.event).toBe(event);
  });

  it('refuses a verdict that is not one of the three', () => {
    const result = runHelper([findingsFile({ verdict: '🚀 Ship it', body: 'b' })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/verdict/i);
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

describe('writePostReviewHelper', () => {
  it('writes an executable helper at .cgremlin/post-review', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/pr-1', { recursive: true });
    await writePostReviewHelper(fs, '/work/pr-1', TARGET);
    expect(POST_REVIEW_HELPER_PATH).toBe('.cgremlin/post-review');
    expect(await fs.statMode(`/work/pr-1/${POST_REVIEW_HELPER_PATH}`)).toBe(0o755);
    expect(await fs.readFile(`/work/pr-1/${POST_REVIEW_HELPER_PATH}`)).toContain('acme/app');
  });
});
