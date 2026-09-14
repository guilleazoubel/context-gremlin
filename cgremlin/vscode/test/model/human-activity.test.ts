/**
 * "Someone is on it" — with the evidence attached.
 *
 * The parking lot demotes a PR the moment a human has touched it, and then said so with four
 * words and no date: `👤 @DavidAPFM commented`. The user cannot tell a comment from this morning
 * from one from three weeks ago, which is the whole question he is asking of that group.
 *
 * What the wire actually carries is `humanActivity: { reviewedBy, commentedBy, lastAt }` — the
 * core has ALREADY dropped the bots and the team-only review requests, and it sends ONE
 * timestamp for the PR rather than one per actor. So: no per-actor clock can be invented here,
 * and the extension keeps no second roster of bot names (MG-B2 — one rule, one place). The
 * extension does no bot test of its own AT ALL: `core/src/work/bot-login.ts` holds the one
 * predicate in the project, and MG-4 enforces that it is the only one.
 */
import { describe, expect, it } from 'vitest';
import {
  humanActivitySummary,
  humanInteractions,
  type WorkItemPr,
} from '../../src/model/work-items';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');

function pr(over: Partial<WorkItemPr>): WorkItemPr {
  return {
    repo: 'apfm/grace',
    number: 2199,
    url: 'https://example.invalid',
    title: null,
    author: 'austinbrownapfm',
    branch: null,
    isDraft: false,
    isMine: false,
    reviewDecision: null,
    humanActivity: null,
    reviewRequests: null,
    teamActivity: null,
    updatedAt: null,
    createdAt: null,
    changedFiles: null,
    additions: null,
    deletions: null,
    ci: null,
    labels: null,
    ...over,
  };
}

const activity = (over: Partial<WorkItemPr['humanActivity'] & object> = {}) => ({
  reviewedBy: [] as string[],
  commentedBy: [] as string[],
  lastAt: '2026-09-11T14:58:00.000Z',
  ...over,
});

describe('the collapsed line', () => {
  it('names the one human and says how long ago', () => {
    const line = humanActivitySummary(pr({ humanActivity: activity({ commentedBy: ['DavidAPFM'] }) }), NOW);
    expect(line).toBe('@DavidAPFM commented 2d');
  });

  it('ranks a review above a comment — it is the stronger thing to have happened', () => {
    const line = humanActivitySummary(
      pr({ humanActivity: activity({ reviewedBy: ['jane'], commentedBy: ['DavidAPFM'] }) }),
      NOW,
    );
    expect(line).toBe('@jane reviewed 2d');
  });

  it('leaves the verdict to the PR part of the submenu, not to this line (§2)', () => {
    const line = humanActivitySummary(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        humanActivity: activity({ reviewedBy: ['jane'], lastAt: '2026-09-14T07:00:00.000Z' }),
      }),
      NOW,
    );
    expect(line).toBe('@jane reviewed 5h');
  });

  it('drops the verdict when two reviewers could own it, rather than pinning it on one', () => {
    const line = humanActivitySummary(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        humanActivity: activity({ reviewedBy: ['jane', 'dana'] }),
      }),
      NOW,
    );
    expect(line).toBe('@jane, @dana reviewed 2d');
  });

  it('lists several commenters by handle', () => {
    const line = humanActivitySummary(pr({ humanActivity: activity({ commentedBy: ['a', 'b'] }) }), NOW);
    expect(line).toBe('@a, @b commented 2d');
  });

  it('says who was asked when nobody has done anything yet', () => {
    expect(humanActivitySummary(pr({ reviewRequests: ['platform-team'] }), NOW)).toBe(
      '@platform-team requested',
    );
  });

  it('says nothing at all when the core flagged nothing', () => {
    expect(humanActivitySummary(pr({ humanActivity: activity() }), NOW)).toBe('');
    expect(humanActivitySummary(pr({}), NOW)).toBe('');
    expect(humanActivitySummary(undefined, NOW)).toBe('');
  });

  it('says nothing for a PR only bots touched, because the core sent nothing', () => {
    // apfm-sonar, gitstream-cm and github-actions never reach here: the core's own bot predicate
    // dropped them, and `humanActivity` arrives empty. The extension keeps no second roster.
    expect(
      humanActivitySummary(
        pr({ humanActivity: { reviewedBy: [], commentedBy: [], lastAt: null }, reviewRequests: [] }),
        NOW,
      ),
    ).toBe('');
  });

  it('says the age is unknown rather than inventing one', () => {
    expect(
      humanActivitySummary(pr({ humanActivity: activity({ commentedBy: ['a'], lastAt: null }) }), NOW),
    ).toBe('@a commented');
  });
});

describe('grace#2199, as the core delivers it', () => {
  // The bots (apfm-sonar, gitstream-cm, github-actions) and the team-only review requests are
  // already gone by the time the extension sees this: one human comment, and its timestamp.
  const grace = pr({
    humanActivity: { reviewedBy: [], commentedBy: ['DavidAPFM'], lastAt: '2026-09-11T14:58:00.000Z' },
    reviewRequests: [],
  });

  it('reads as one human commenting, two days ago', () => {
    expect(humanActivitySummary(grace, NOW)).toBe('@DavidAPFM commented 2d');
  });

  it('opens into that one interaction and nothing else', () => {
    expect(humanInteractions(grace, NOW)).toEqual([
      { login: 'DavidAPFM', kind: 'commented', verdict: null, age: '2d ago' },
    ]);
  });
});

describe('the expanded list', () => {
  it('is every reviewer then every commenter, each with its own line', () => {
    const every = humanInteractions(
      pr({
        reviewDecision: 'APPROVED',
        humanActivity: activity({ reviewedBy: ['jane'], commentedBy: ['DavidAPFM', 'kim'] }),
      }),
      NOW,
    );
    expect(every).toEqual([
      { login: 'jane', kind: 'reviewed', verdict: 'approved', age: '2d ago' },
      { login: 'DavidAPFM', kind: 'commented', verdict: null, age: '2d ago' },
      { login: 'kim', kind: 'commented', verdict: null, age: '2d ago' },
    ]);
  });

  it('leaves the verdict off every reviewer when more than one could own it', () => {
    const every = humanInteractions(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        humanActivity: activity({ reviewedBy: ['jane', 'dana'] }),
      }),
      NOW,
    );
    expect(every.map((entry) => entry.verdict)).toEqual([null, null]);
  });

  it('is empty for a PR no human has touched', () => {
    expect(humanInteractions(pr({ humanActivity: activity() }), NOW)).toEqual([]);
    expect(humanInteractions(undefined, NOW)).toEqual([]);
  });
});

describe('the age, at its boundaries', () => {
  const ago = (iso: string): string =>
    humanInteractions(pr({ humanActivity: activity({ commentedBy: ['a'], lastAt: iso }) }), NOW)[0].age;

  it('is "<1h ago" under the hour, and hours up to two days', () => {
    expect(ago('2026-09-14T11:30:00.000Z')).toBe('<1h ago');
    expect(ago('2026-09-14T11:00:00.000Z')).toBe('1h ago');
    expect(ago('2026-09-12T13:00:00.000Z')).toBe('47h ago');
  });

  it('is days from two days, and weeks from a fortnight', () => {
    expect(ago('2026-09-12T12:00:00.000Z')).toBe('2d ago');
    expect(ago('2026-09-01T12:00:00.000Z')).toBe('13d ago');
    // `compactAge`'s own boundary, unchanged: a fortnight reads as weeks.
    expect(ago('2026-08-31T12:00:00.000Z')).toBe('2w ago');
  });

  it('is "—" when the engine sent no timestamp, never a fabricated zero (MG-12)', () => {
    expect(ago(null as unknown as string)).toBe('—');
  });
});
