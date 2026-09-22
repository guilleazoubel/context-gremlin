/**
 * Round 3 §e.1 — the expanded row states the ANSWER, in the agent's own words.
 *
 * `ready` is a pipeline state: `evaluateReview` sets it when `REVIEW.md` is non-empty and the
 * process exited 0, which is all it checks. The verdict is on line 2 of every artifact contract,
 * `verdictOf`/`severityCountsOf` already read it, and `primaryArtifact` is already on the wire —
 * so the block costs one fetch for the one row the user expanded and no engine change at all.
 *
 * Two rules are absolute here. **Never fabricate**: an artifact with no parseable verdict draws
 * NO block, and never `0 findings`. And **staleness ships with the verdict**: a verdict about
 * code that has since changed invites a wrong merge, so it is said next to the claim, never
 * below the fold.
 */
import { describe, expect, it } from 'vitest';
import { verdictView } from '../../src/model/row-composition';

const REVIEW = [
  '# Review',
  '',
  '**Verdict:** 🔄 Request changes — the payment retry loop can double-charge.',
  '**Scope:** the diff and HB-1555',
  '',
  '### 1. Double charge on retry',
  '- **Severity:** 🔴 Critical',
  '',
  '### 2. Slow query',
  '- **Severity:** 🟠 High',
  '',
  '### 3. Spacing',
  '- **Severity:** 🎨 Design',
].join('\n');

const view = (over: Partial<Parameters<typeof verdictView>[0]> = {}) =>
  verdictView({ text: REVIEW, unreadable: false, newCommits: false, mode: 'review', ...over });

describe('the verdict block', () => {
  it('states tone, label, sentence and counts from a parsed artifact', () => {
    const v = view();
    expect(v).not.toBeNull();
    expect(v?.tone).toBe('mixed');
    expect(v?.label).toBe('Request changes');
    expect(v?.sentence).toBe('the payment retry loop can double-charge.');
    expect(v?.counts).toBe('1 critical · 1 high · 1 design');
    expect(v?.notice).toBeNull();
    expect(v?.stale).toBeNull();
  });

  it('renders no block at all — and no zero — for an artifact with no verdict in it', () => {
    expect(view({ text: '# Review\n\nsome prose and no contract line at all' })).toBeNull();
    expect(view({ text: '' })).toBeNull();
    expect(view({ text: null })).toBeNull();
  });

  it('counts nothing rather than `0 findings` when the verdict parsed and the findings did not', () => {
    const v = view({ text: '**Verdict:** ✅ Approve — nothing worth blocking on.' });
    expect(v?.label).toBe('Approve');
    expect(v?.counts).toBe('');
  });

  it('degrades to one sentence when the artifact could not be read, keeping the block', () => {
    const v = view({ text: null, unreadable: true });
    expect(v?.notice).toBe('The review could not be read');
    expect(v?.label).toBe('');
    expect(v?.counts).toBe('');
    expect(v?.tone).toBeNull();
  });

  it('names the document it could not read, per the agent that wrote it', () => {
    expect(view({ text: null, unreadable: true, mode: 'qa' })?.notice).toBe(
      'The QA result could not be read',
    );
  });

  it('says the pull request changed after the agent looked at it, WITH the verdict', () => {
    const v = view({ newCommits: true });
    expect(v?.stale).toBe('The pull request changed after the agent looked at it');
    expect(v?.label).toBe('Request changes');
  });

  it('says it even where there is no verdict to be stale about', () => {
    const v = view({ text: 'no verdict here', newCommits: true });
    expect(v?.stale).toBe('The pull request changed after the agent looked at it');
    expect(v?.label).toBe('');
    expect(v?.counts).toBe('');
  });
});
