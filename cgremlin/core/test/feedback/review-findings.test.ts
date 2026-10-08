import { describe, expect, it } from 'vitest';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import { parseReviewFindings, parseReviewVerdict } from '../../src/feedback/review-findings';

const DISMISS_F2_DETAIL = (text: string): string =>
  text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');
const DISMISS_F3_ROW = (text: string): string => text.replace(/(\| \[3\]\(#f3\) \|.*\|) open \|$/m, '$1 🔇 dismissed |');

describe('REVIEW.md findings (the contract the agents are shown)', () => {
  it('reads the four findings of the contract example, none dismissed, and its verdict', () => {
    const findings = parseReviewFindings(REVIEW_CONTRACT_EXAMPLE);
    expect(findings.map((f) => f.anchor)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(findings.every((f) => !f.dismissed)).toBe(true);
    expect(findings[0]).toMatchObject({ number: 1, severity: '🔴 Critical', where: 'src/api/web-content.ts:88', status: 'open' });
    expect(findings[1]).toMatchObject({ number: 2, severity: '🔧 Maintainability', where: 'ui/list.tsx:40', title: '<plain-English title>' });
    expect(findings[2].where).toBe('/search');
    expect(parseReviewVerdict(REVIEW_CONTRACT_EXAMPLE)).toBe('request_changes');
  });

  it('a finding marked dismissed in its detail block, or only in its table row, is dismissed', () => {
    const findings = parseReviewFindings(DISMISS_F3_ROW(DISMISS_F2_DETAIL(REVIEW_CONTRACT_EXAMPLE)));
    expect(findings.map((f) => [f.anchor, f.dismissed])).toEqual([['f1', false], ['f2', true], ['f3', true], ['f4', false]]);
    expect(findings[1].status).toBe('🔇 dismissed');
  });

  it('a hostile detail line (40,000 spaces then a carriage return) parses quickly instead of stalling the event loop', () => {
    const pad = ' '.repeat(40_000);
    const hostile = REVIEW_CONTRACT_EXAMPLE.replace('- **Where:** `ui/list.tsx:40`', `- **Where:**${pad}x\ry`).replace(
      '### 2. <plain-English title>',
      `### 2.${pad}x\ry`,
    );
    const started = performance.now();
    const findings = parseReviewFindings(hostile);
    expect(performance.now() - started).toBeLessThan(100);
    expect(findings[1].where).toBe('x\ry');
    expect(findings[1].title).toBe('x\ry');
  });

  it('a Status that only mentions dismissal is not dismissed; one that says it is, in any form, is', () => {
    const withStatus = (status: string): string =>
      REVIEW_CONTRACT_EXAMPLE.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, `$1 ${status}`);
    for (const status of ['open (not dismissed)', 'reopened (was dismissed)', 'un-dismissed', 'undismissed']) {
      expect(parseReviewFindings(withStatus(status))[1].dismissed, status).toBe(false);
    }
    for (const status of ['🔇 dismissed', 'dismissed', 'Dismissed — duplicate of 1', '**dismissed**']) {
      expect(parseReviewFindings(withStatus(status))[1].dismissed, status).toBe(true);
    }
  });

  it('a clean review has no findings; a file with no verdict line has no verdict', () => {
    const clean = '# PR Review: #1 — t\n**Verdict:** ✅ Approve — fine\n\n## Summary\nNothing worth flagging — looks good to me.\n\n## Details\n';
    expect(parseReviewFindings(clean)).toEqual([]);
    expect(parseReviewVerdict(clean)).toBe('approve');
    expect(parseReviewVerdict('**Verdict:** 💬 Comment — fyi')).toBe('comment');
    expect(parseReviewVerdict('# nothing here')).toBeNull();
  });
});
