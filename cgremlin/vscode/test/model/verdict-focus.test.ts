/**
 * Round 3 pre-merge — ONE selection, not three.
 *
 * The expanded block made three independent choices and could describe three different things
 * in one frame: the verdict came from `verdictAgentOf` (by stage rank), the freshness bit and
 * the PR facts from `prs[0]` (by `updatedAt`, the core's order), and the full-width button from
 * whichever part happened to emit a `primary` first (by part order).
 *
 * On a ticket carrying two pull requests — mine, and a teammate's I am reviewing — those
 * disagree, and the block states a review's verdict over the OTHER pull request's size, CI and
 * freshness. A genuinely stale approval renders as fresh, which is the exact failure this
 * redesign exists to prevent.
 *
 * So the verdict agent is THE focus, and everything in the block follows it. Where its pull
 * request cannot be identified, the block says nothing about a pull request at all: omission is
 * safe, a wrong claim is not.
 */
import { describe, expect, it } from 'vitest';
import { verdictFocusOf } from '../../src/model/lifecycle';
import { twoFinishedStages, twoPullRequests, pr } from '../support/round3-items';

describe('the block follows the verdict', () => {
  it('picks the pull request the verdict agent is about, not the most recently updated one', () => {
    const item = twoPullRequests();
    const focus = verdictFocusOf(item.agents, item.prs);
    expect(focus.agent?.sessionId).toBe('rev-2140');
    expect(focus.pr?.number).toBe(2140);
    // …which is emphatically not the one the old code took.
    expect(item.prs[0].number).toBe(500);
  });

  it('claims NOTHING about a pull request it cannot identify in the list', () => {
    const item = twoPullRequests({ reviewedPrInList: false });
    const focus = verdictFocusOf(item.agents, item.prs);
    expect(focus.agent?.sessionId).toBe('rev-2140');
    expect(focus.pr).toBeNull();
  });

  it('takes the only pull request there is when no agent names one — nothing is ambiguous', () => {
    const item = twoFinishedStages();
    expect(verdictFocusOf([], item.prs).pr?.number).toBe(2140);
  });

  it('refuses to guess between two pull requests when nothing names one', () => {
    const item = twoPullRequests();
    expect(verdictFocusOf([], item.prs).pr).toBeNull();
  });

  it('falls back to the one pull request for an engine too old to send the link', () => {
    const item = twoFinishedStages();
    const older = item.agents.map(({ pr: _drop, ...rest }) => rest);
    expect(verdictFocusOf(older, item.prs).pr?.number).toBe(2140);
  });

  it('ranks the latest conclusion as the focus: a review over the investigation under it', () => {
    const item = twoFinishedStages();
    expect(verdictFocusOf(item.agents, item.prs).agent?.sessionId).toBe('rev-1');
  });

  it('is empty on an item whose agents wrote nothing to read', () => {
    const focus = verdictFocusOf([], [pr({ number: 1 }), pr({ number: 2 })]);
    expect(focus.agent).toBeNull();
    expect(focus.pr).toBeNull();
  });
});
