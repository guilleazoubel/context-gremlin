import { describe, expect, it } from 'vitest';
import {
  EMPTY_QA_ENVIRONMENT,
  PLAN_REVIEW_STATUS_EXAMPLE,
  QA_CONTRACT_EXAMPLE,
  REVIEW_CONTRACT_EXAMPLE,
  qaOutputContract,
  renderPlanBrief,
  renderReviewBrief,
  QA_CONDUCT_RULE,
  renderQaBrief,
  renderRereviewBrief,
  renderRespondBrief,
  renderReviewContract,
  renderReviewPrompt,
} from '../../src/pipeline/prompts';
import { parsePlanReviewStatus, parseQaVerdict } from '../../src/pipeline/artifacts';

/**
 * MG-17k — the contract and the parsers cannot drift. The worked example an
 * agent is shown IS the fixture the engine's parsers are proved against, so
 * the shape demanded and the shape read are one string, not two that happen
 * to agree today.
 *
 * MG-17l — `## Review Status` and `## QA Verdict` are frozen markers
 * (`pipeline/artifacts.ts`): each must appear EXACTLY ONCE at depth 2-3 in
 * the text that carries it. A second match silently turns a finished run
 * into `missing`.
 */

const H_QA_VERDICT = /^#{2,3} QA Verdict:?\s*$/gm;
const H_REVIEW_STATUS = /^#{2,3} Review Status:?\s*$/gm;
const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

describe('MG-17k — the contract examples are the parsers’ fixtures', () => {
  it('renderReviewContract() carries REVIEW_CONTRACT_EXAMPLE byte-identical', () => {
    expect(renderReviewContract()).toContain(REVIEW_CONTRACT_EXAMPLE);
  });

  it('qaOutputContract() carries QA_CONTRACT_EXAMPLE byte-identical', () => {
    expect(qaOutputContract('/s')).toContain(QA_CONTRACT_EXAMPLE);
  });

  it('the plan brief carries PLAN_REVIEW_STATUS_EXAMPLE byte-identical', () => {
    expect(renderPlanBrief({ sessionDir: '/s', ticket: 'HB-1', driveToCompletion: false })).toContain(PLAN_REVIEW_STATUS_EXAMPLE);
  });

  it('the engine parses the very examples the agents are shown', () => {
    expect(parseQaVerdict(QA_CONTRACT_EXAMPLE)).toBe('ready');
    expect(parsePlanReviewStatus(PLAN_REVIEW_STATUS_EXAMPLE)).toBe('approved');
  });

  it('the review example carries the four findings, one field per line', () => {
    expect([...REVIEW_CONTRACT_EXAMPLE.matchAll(/^<a id="f(\d)"><\/a>$/gm)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect([...REVIEW_CONTRACT_EXAMPLE.matchAll(/^- \*\*Severity:\*\* (.+)$/gm)].map((m) => m[1])).toEqual([
      '🔴 Critical',
      '🔧 Maintainability',
      '📋 PM/AC',
      '🎨 Design',
    ]);
    // §4d: `Where` is a backticked repo-relative path:line and NOTHING else,
    // which is what makes the tab's `fileRefOf` exact rather than heuristic.
    expect([...REVIEW_CONTRACT_EXAMPLE.matchAll(/^- \*\*Where:\*\* `(.+)`$/gm)].map((m) => m[1])).toEqual([
      'src/api/web-content.ts:88',
      'ui/list.tsx:40',
    ]);
    for (const where of ['src/api/web-content.ts:88', 'ui/list.tsx:40']) {
      expect(where).toMatch(/^[\w./-]+\.[A-Za-z0-9]+:\d+(?:-L?\d+)?$/);
    }
  });

  it('the QA example carries one field per line too', () => {
    expect(QA_CONTRACT_EXAMPLE).toContain('- **Severity:** 🔴 Blocker');
    expect(QA_CONTRACT_EXAMPLE).toContain('<a id="q1"></a>');
  });

  it('every example opens with the header block — bold lines, never headings', () => {
    for (const example of [REVIEW_CONTRACT_EXAMPLE, QA_CONTRACT_EXAMPLE]) {
      const [h1, verdict, scope] = example.split('\n');
      expect(h1.startsWith('# ')).toBe(true);
      expect(verdict).toMatch(/^\*\*Verdict:\*\* (✅|❌|🚧|🔄|💬|⚠️) .+ — .+$/u);
      expect(scope).toMatch(/^\*\*Scope:\*\* .+$/);
    }
  });
});

describe('MG-17l — the frozen markers still match exactly once', () => {
  it('the QA contract has one `## QA Verdict`, and the rendered text still parses', () => {
    const contract = qaOutputContract('/s');
    expect(count(contract, H_QA_VERDICT)).toBe(1);
    expect(parseQaVerdict(contract)).toBe('ready');
    expect(count(contract, H_REVIEW_STATUS)).toBe(0);
  });

  it('the plan block has one `## Review Status`, and the rendered text still parses', () => {
    for (const drive of [true, false]) {
      const plan = renderPlanBrief({ sessionDir: '/s', ticket: 'HB-1', driveToCompletion: drive });
      expect(count(plan, H_REVIEW_STATUS)).toBe(1);
      expect(parsePlanReviewStatus(plan)).toBe('approved');
      expect(count(plan, H_QA_VERDICT)).toBe(0);
    }
  });

  it('the review contract introduces neither frozen heading', () => {
    const brief = renderReviewBrief({ sessionDir: '/s', prNumber: 7 });
    expect(count(brief, H_QA_VERDICT)).toBe(0);
    expect(count(brief, H_REVIEW_STATUS)).toBe(0);
    expect(count(renderReviewContract(), H_QA_VERDICT)).toBe(0);
  });

  it('the review contract states ONE verdict, in the header block, and no `## Verdict` section', () => {
    expect(renderReviewContract()).not.toMatch(/^#{2,3} Verdict\s*$/m);
  });
});

describe('MG-17k — the external review skill does not get to pick the shape', () => {
  it('the review prompt says the brief’s contract overrides the skill’s own output shape', () => {
    const prompt = renderReviewPrompt({ sessionDir: '/s', reviewSkillCommand: '/APFM:apfm-review' });
    expect(prompt).toContain('/APFM:apfm-review');
    expect(prompt).toContain('/s/BRIEF.md');
    expect(prompt).toMatch(/whatever shape it proposes/i);
  });
});

/**
 * Phase 20 — the user reversed the deferred-posting decision. The permission
 * guard cannot pin a repo and number (prefix/glob patterns, no negation), so
 * "post to THIS pull request and no other" is enforced by the brief alone.
 * These are the guards on that text.
 */
describe('phase 20 — posting goes through the scoped helper, and nowhere else', () => {
  const review = renderReviewBrief({ sessionDir: '/s', prNumber: 7 });
  const respond = renderRespondBrief({
    sessionDir: '/s',
    prRepo: 'acme/app',
    prNumber: 42,
    threads: [],
    reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED', body: 'nope', submittedAt: '2026-09-14T09:00:00.000Z' }],
    reviewDecision: null,
    failingChecks: [],
    changedFiles: 1,
    additions: 1,
    deletions: 0,
  });

  it.each([['review', () => review], ['respond', () => respond]] as const)(
    'the %s brief posts the review with the scoped helper and never names a REST endpoint',
    (_mode, brief) => {
      const text = brief();
      expect(text).toContain('## Posting');
      expect(text).toContain('.cgremlin/post-review');
      expect(text).not.toContain('/pulls/');
      expect(text).toMatch(/gh api[^\n]*(unavailable|denied)|(unavailable|denied)[^\n]*gh api/i);
    },
  );

  it.each([['review', () => review], ['respond', () => respond]] as const)(
    'the %s brief names gh pr comment as the way to leave a plain conversation comment',
    (_mode, brief) => {
      expect(brief()).toMatch(/gh pr comment[\s\S]{0,200}conversation comment|conversation comment[\s\S]{0,200}gh pr comment/);
    },
  );

  it('the review brief posts to its own PR, once, and to no other', () => {
    expect(review).toContain('PR #7');
    expect(review).toMatch(/any other pull request/i);
    expect(review).toMatch(/exactly once per run/i);
  });

  it('the review brief puts every finding with a Where at its path:line', () => {
    expect(review).toMatch(/inline comment/i);
    expect(review).toContain('"where"');
  });

  it('the review brief maps every contract verdict to its GitHub event', () => {
    expect(review).toContain('🔄 Request changes` → `REQUEST_CHANGES');
    expect(review).toContain('✅ Approve` → `APPROVE');
    expect(review).toContain('💬 Comment` → `COMMENT');
  });

  it('the review brief posts a NEW review on a re-review and says how to spot its own prior comments', () => {
    expect(review).toMatch(/new review/i);
    expect(review).toMatch(/anchor/i);
  });

  it('the review brief still forbids landing or rewriting the PR', () => {
    expect(review).toMatch(/never merge/i);
    expect(review).toMatch(/close/i);
    expect(review).toMatch(/ready/i);
  });

  it('the re-review brief carries the same posting section', () => {
    expect(renderRereviewBrief({ sessionDir: '/s', prNumber: 7, commitCount: 2 })).toContain('## Posting');
  });

  it('the review prompt no longer tells the agent to stay off GitHub', () => {
    const prompt = renderReviewPrompt({ sessionDir: '/s' });
    expect(prompt).not.toContain('Do NOT post to GitHub');
    expect(prompt).toMatch(/## Posting/);
  });

  it('the respond brief answers on its own PR only, and never force-pushes or lands it', () => {
    expect(respond).toContain('acme/app#42');
    expect(respond).toMatch(/any other pull request/i);
    expect(respond).not.toContain('Nothing here posts to GitHub');
    expect(respond).toMatch(/never merge/i);
  });

  it('QA is untouched: its brief still says it writes nothing to GitHub and never instructs posting', () => {
    const qa = renderQaBrief({
      sessionDir: '/s',
      ticket: 'HB-1',
      prRepo: 'acme/app',
      prNumber: 42,
      mergeSha: 'abc1234',
      change: { title: 't', author: 'a', mergedAt: '2026-09-14T09:00:00.000Z', changedFiles: 1, additions: 1, deletions: 0, files: ['a.ts'] },
      priorArtifacts: [],
      ticketContext: null,
      env: { ...EMPTY_QA_ENVIRONMENT, url: 'https://qa.example.com' },
    });
    expect(qa).toContain(QA_CONDUCT_RULE);
    expect(QA_CONDUCT_RULE).toContain('write to Jira or GitHub');
    expect(qa).not.toContain('## Posting');
    expect(qa).not.toMatch(/gh pr (review|comment)/);
  });
});
