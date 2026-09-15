/**
 * Phase 14 — the tab must never present the BRIEF as the REVIEW.
 *
 * The live case: `pr-grace-frontend-2061-20260915-160008` wrote exactly one artifact, BRIEF.md,
 * whose own first line is `# REVIEW — PR #2061` because it is the brief FOR a review. The tab
 * labelled the block `BRIEF.md · 2026-09-15T16:00:08.000Z` and rendered the instructions under
 * it, so the user read the agent's orders as the agent's verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIEF_ONLY_NOTICE,
  artifactLabel,
  artifactRole,
  orderArtifactTabs,
  primaryArtifactName,
} from '../src/model/artifact-labels';

describe('artifactRole / artifactLabel', () => {
  it('labels each artifact by WHAT IT IS, not by its filename', () => {
    expect(artifactLabel('BRIEF.md')).toBe('Brief — the instructions this agent was given');
    expect(artifactLabel('REVIEW.md')).toBe('Review');
    expect(artifactLabel('FINDINGS.md')).toBe('Findings');
    expect(artifactLabel('PLAN.md')).toBe('Plan');
    expect(artifactLabel('COMMENTS.md')).toBe('Comments');
  });

  it('a versioned or re-review file is still a Review, and an unknown file keeps its name', () => {
    expect(artifactRole('REVIEW-v1.md')).toBe('review');
    expect(artifactRole('RE-REVIEW.md')).toBe('review');
    expect(artifactLabel('REVIEW-v2.md')).toBe('Review');
    expect(artifactRole('NOTES.md')).toBe('other');
    expect(artifactLabel('NOTES.md')).toBe('NOTES.md');
  });
});

describe('the primary artifact', () => {
  it('is REVIEW.md whenever it exists, whatever the mtimes say', () => {
    expect(primaryArtifactName(['BRIEF.md', 'REVIEW.md', 'NOTES.md'])).toBe('REVIEW.md');
    expect(primaryArtifactName(['BRIEF.md', 'REVIEW-v1.md'])).toBe('REVIEW-v1.md');
  });

  it('falls back through findings, plan and comments, and finally to the brief', () => {
    expect(primaryArtifactName(['BRIEF.md', 'FINDINGS.md'])).toBe('FINDINGS.md');
    expect(primaryArtifactName(['BRIEF.md', 'PLAN.md'])).toBe('PLAN.md');
    expect(primaryArtifactName(['BRIEF.md'])).toBe('BRIEF.md');
    expect(primaryArtifactName([])).toBeNull();
  });

  it('orders the tabs by role — the brief last, because it is context and not the answer', () => {
    expect(orderArtifactTabs(['BRIEF.md', 'NOTES.md', 'REVIEW.md'])).toEqual([
      'REVIEW.md',
      'NOTES.md',
      'BRIEF.md',
    ]);
  });

  it('breaks a same-role tie by name, so the order does not follow the mtime', () => {
    expect(orderArtifactTabs(['REVIEW.md', 'REVIEW-v2.md'])).toEqual(
      orderArtifactTabs(['REVIEW-v2.md', 'REVIEW.md']),
    );
  });
});

describe('when the brief is all there is', () => {
  it('says so, in one sentence, with no emoji', () => {
    expect(BRIEF_ONLY_NOTICE).toContain('brief');
    expect(BRIEF_ONLY_NOTICE).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
