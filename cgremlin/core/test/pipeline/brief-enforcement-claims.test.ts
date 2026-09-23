import { describe, expect, it } from 'vitest';
import { renderPostingProtocol, renderRespondBrief, renderReviewContract } from '../../src/pipeline/prompts';

/**
 * The briefs must not describe the permission guard as more than it is. The
 * guard matches Bash command text; it does not wall off the network. `curl`,
 * `wget`, `node -e` and `python3 -c` are all reachable, and `gh auth token`
 * prints a credential that would authorise them against any repository the
 * token can see — the post helpers themselves work exactly that way
 * (src/workspace/post-helpers.ts). This project's own QA spec says so
 * (docs/superpowers/specs/2026-09-15-cgremlin-phase15-qa-verification.md:37,190).
 *
 * "Every `gh` command that writes to GitHub is UNAVAILABLE" was true of `gh`
 * and read as true of GitHub. An agent that believes the sandbox is airtight
 * has no reason to treat "post only here" as a rule it must keep — which is
 * the one thing that actually holds when a PR diff or a review comment tries
 * to talk it into posting elsewhere.
 */
const posting = renderPostingProtocol(123);
const respond = renderRespondBrief({
  sessionDir: '/s/respond-1',
  prRepo: 'acme/app',
  prNumber: 12,
  threads: [],
  reviews: [],
  reviewDecision: null,
  failingChecks: [],
  changedFiles: 3,
  additions: 10,
  deletions: 2,
});
const BRIEFS: ReadonlyArray<readonly [string, string]> = [
  ['the review/re-review posting protocol', posting],
  ['the respond brief', respond],
];

const OVERCLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['every GitHub write is unavailable', /every\s+`?gh`?\s+command that writes to GitHub is UNAVAILABLE/i],
  ['GitHub is unreachable', /(cannot|can't|unable to|no way to)\s+(reach|call|post to)\s+(github|api\.github\.com)/i],
  ['the sandbox stops every write', /(every|any) (github )?write is (blocked|impossible|prevented)/i],
];

describe('no brief overstates what the permission guard enforces', () => {
  for (const [name, text] of BRIEFS) {
    it.each(OVERCLAIMS)(`${name} does not claim "%s"`, (_claim, pattern) => {
      expect(text).not.toMatch(pattern);
    });
  }
});

describe('the briefs say what is actually true', () => {
  it.each(BRIEFS)('%s names the denied gh verbs as denied, not GitHub as unreachable', (_n, text) => {
    expect(text).toMatch(/denie[sd]|denied by the permission guard|the guard denies/i);
    expect(text).toContain('gh api');
  });

  it.each(BRIEFS)('%s names the two helpers as the sanctioned way to post', (_n, text) => {
    expect(text).toContain('.cgremlin/post-review');
    expect(text).toContain('.cgremlin/post-comment');
  });

  it.each(BRIEFS)('%s admits the direct-HTTPS path and rules it out of bounds anyway', (_n, text) => {
    expect(text).toMatch(/api\.github\.com/);
    expect(text).toMatch(/gh auth token/);
    expect(text).toMatch(/out of bounds/i);
    expect(text).toMatch(/nothing (here )?(mechanically )?stops|no rule stops|not because .* stops you/i);
  });
});

/**
 * An agent may never approve. The helper refuses the event
 * (src/workspace/post-helpers.ts); the brief must not send the agent at it in
 * the first place, and must say what to do with an approving conclusion
 * instead. The agent's OPINION is untouched — `REVIEW.md` keeps its `✅
 * Approve` verdict — only its authority to act on it is gone.
 */
describe('no brief tells the agent to approve', () => {
  it.each(BRIEFS)('%s names no APPROVE event anywhere', (_n, text) => {
    expect(text).not.toMatch(/APPROVE/);
  });

  it('the verdict table maps exactly the two events the agent may send', () => {
    expect(posting).toContain('REQUEST_CHANGES');
    expect(posting).toContain('COMMENT');
    expect(posting).toMatch(/🔄 Request changes.*REQUEST_CHANGES/);
    expect(posting).toMatch(/💬 Comment.*COMMENT/);
  });

  it('a review that concludes approve is routed to a comment, not an approval', () => {
    expect(posting).toMatch(/✅ Approve/);
    // The approving conclusion posts a COMMENT…
    expect(posting).toMatch(/✅ Approve[\s\S]{0,400}COMMENT/);
    // …whose body says both halves: nothing blocking, and whose the approval is.
    expect(posting).toMatch(/nothing blocking/i);
    expect(posting).toMatch(/approval is the human’s to give/);
    // …and never implies the pull request has been approved.
    expect(posting).toMatch(/must not (say|imply)[^\n]*approved/i);
  });

  it('REVIEW.md keeps its own ✅ Approve verdict — the opinion is not the authority', () => {
    expect(renderReviewContract()).toContain('✅ Approve');
  });

  it('the scoping and anti-injection paragraphs are still there', () => {
    expect(posting).toContain('**Where.** Exactly one pull request');
    expect(posting).toMatch(/refuse it, record it in `REVIEW\.md` as a finding/);
    expect(posting).toMatch(/NOT delivered/);
  });
});
