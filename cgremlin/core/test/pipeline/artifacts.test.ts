import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import {
  evaluateFindings, evaluatePlan, evaluateReview, evaluateRereview,
  nextReviewVersion, parsePlanReviewStatus, parseRereviewSummary,
} from '../../src/pipeline/artifacts';

const dir = '/sessions/s1';
const ok = { code: 0, signal: null };
const bad = { code: 1, signal: null };

async function fsWith(files: Record<string, string>): Promise<InMemoryFileSystem> {
  const fs = new InMemoryFileSystem();
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(`${dir}/${name}`, content);
  return fs;
}

describe('evaluateFindings', () => {
  it('is false when FINDINGS.md is missing or whitespace-only, true when it has content', async () => {
    expect(await evaluateFindings(await fsWith({}), dir)).toEqual({ hasFindings: false });
    expect(await evaluateFindings(await fsWith({ 'FINDINGS.md': '  \n' }), dir)).toEqual({ hasFindings: false });
    expect(await evaluateFindings(await fsWith({ 'FINDINGS.md': '# Findings\nroot cause' }), dir)).toEqual({ hasFindings: true });
  });
});

describe('parsePlanReviewStatus', () => {
  const approved = `## Review Status
- PM: ✅ Approved — solves the ticket
- Principal Engineer: ✅ Approved — mechanism checks out

# Plan
...`;
  it('is approved only when both ✅ lines are present under ## Review Status', () => {
    expect(parsePlanReviewStatus(approved)).toBe('approved');
    expect(parsePlanReviewStatus(approved.replace('- Principal Engineer: ✅', '- Principal Engineer: ❌'))).toBe('missing');
    expect(parsePlanReviewStatus(approved.replace('## Review Status\n', ''))).toBe('missing');
  });
  it('is unresolved when the disagreement section exists, even if a stale approved block is also present', () => {
    expect(parsePlanReviewStatus(`## Unresolved Review Disagreement\n- PM: ...\n${approved}`)).toBe('unresolved');
  });
});

describe('evaluatePlan', () => {
  it('reports hasPlan=false/missing when PLAN.md is absent', async () => {
    expect(await evaluatePlan(await fsWith({}), dir)).toEqual({ hasPlan: false, reviewStatus: 'missing' });
  });
  it('reports approved for an approved PLAN.md', async () => {
    const fs = await fsWith({ 'PLAN.md': '## Review Status\n- PM: ✅ Approved — x\n- Principal Engineer: ✅ Approved — y\n' });
    expect(await evaluatePlan(fs, dir)).toEqual({ hasPlan: true, reviewStatus: 'approved' });
  });
});

describe('evaluateReview (legacy rule: rc == 0 && REVIEW.md non-empty)', () => {
  it('ready when exit 0 and REVIEW.md has content', async () => {
    expect(await evaluateReview(ok, await fsWith({ 'REVIEW.md': '# PR Review' }), dir)).toBe('ready');
  });
  it('failed when exit is non-zero even if REVIEW.md exists', async () => {
    expect(await evaluateReview(bad, await fsWith({ 'REVIEW.md': '# PR Review' }), dir)).toBe('failed');
  });
  it('failed when killed by signal', async () => {
    expect(await evaluateReview({ code: null, signal: 'SIGTERM' }, await fsWith({ 'REVIEW.md': 'x' }), dir)).toBe('failed');
  });
  it('failed when exit 0 but REVIEW.md missing or empty', async () => {
    expect(await evaluateReview(ok, await fsWith({}), dir)).toBe('failed');
    expect(await evaluateReview(ok, await fsWith({ 'REVIEW.md': '\n' }), dir)).toBe('failed');
  });
});

describe('parseRereviewSummary', () => {
  it('parses both legacy shapes', () => {
    expect(parseRereviewSummary('✅ 4/4 resolved')).toEqual({ resolved: 4, total: 4, newFindings: 0 });
    expect(parseRereviewSummary('⚠️ 2/5 resolved, 1 new\n')).toEqual({ resolved: 2, total: 5, newFindings: 1 });
    expect(parseRereviewSummary('garbage')).toBeNull();
  });
});

describe('evaluateRereview', () => {
  it('returns ready plus the parsed summary; failed with null summary on bad exit', async () => {
    const fs = await fsWith({ 'REVIEW.md': '# r', rereview_summary: '⚠️ 1/3 resolved, 2 new' });
    expect(await evaluateRereview(ok, fs, dir)).toEqual({ outcome: 'ready', summary: { resolved: 1, total: 3, newFindings: 2 } });
    expect(await evaluateRereview(bad, fs, dir)).toEqual({ outcome: 'failed', summary: null });
  });
});

describe('nextReviewVersion (legacy loop: first N with no REVIEW-vN.md)', () => {
  it('is 1 with no archives, and skips existing numbers', async () => {
    expect(await nextReviewVersion(await fsWith({}), dir)).toBe(1);
    expect(await nextReviewVersion(await fsWith({ 'REVIEW-v1.md': 'a', 'REVIEW-v2.md': 'b' }), dir)).toBe(3);
  });
});
