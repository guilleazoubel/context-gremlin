/**
 * ONE composer, enforced (Phase 14).
 *
 * The user's ask, after a merged PR's row degraded on four lines at once: "make sure those items
 * use DRY concepts and we can keep them from regressing so it always shows the proper way."
 *
 * `src/model/row-composition.ts` is the one place a work item's visible lines are built. The
 * cheapest way for that to rot is for the next feature to write `` `${pr.repo}#${pr.number}` ``
 * again somewhere else, so this test reads the sources and refuses it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.join(__dirname, '../src');
const COMPOSER = path.join(SRC, 'model/row-composition.ts');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** `${x.repo}#${x.number}` and `pr:${x.repo}#${x.number}`, in any spacing. */
const AD_HOC_LABEL = /\}\s*#\s*\$\{/;

describe('no module outside the composer builds a PR label of its own', () => {
  it('has exactly one file containing the `<repo>#<number>` template', () => {
    const offenders = sources(SRC).filter(
      (file) => file !== COMPOSER && AD_HOC_LABEL.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('the composer really is where it lives, so the guard above cannot pass by being vacuous', () => {
    expect(AD_HOC_LABEL.test(readFileSync(COMPOSER, 'utf8'))).toBe(true);
  });

  it('the composer names the rule in ink, so a reader learns it before a test fails on them', () => {
    const text = readFileSync(COMPOSER, 'utf8');
    expect(text).toContain('no second place may compose a line');
  });
});

/**
 * Phase 15 §8 — the same rule, applied to the QA verification token.
 *
 * `⛋ not ready` is one line built out of a mode glyph and a re-worded phase. The cheapest way
 * for the collapsed row and the expanded part to start disagreeing about what a verification is
 * doing is for the second one to spell the words itself, so nothing outside the composer may.
 * (`'blocked'` is deliberately NOT matched: it is an attention reason and a respond phase that
 * both predate Phase 15, and the QA row reaches it through `qaStateText` alone.)
 */
const QA_TOKEN = /⛋|'not ready'|"not ready"|awaiting qa deploy/;

describe('no module outside the composer spells a QA state', () => {
  it('has exactly one file containing the QA glyph or its re-worded phases', () => {
    const offenders = sources(SRC).filter(
      (file) => file !== COMPOSER && QA_TOKEN.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('the composer really is where they live', () => {
    expect(QA_TOKEN.test(readFileSync(COMPOSER, 'utf8'))).toBe(true);
  });
});
