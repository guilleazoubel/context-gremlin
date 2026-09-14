/**
 * Phase 12 item 1 — L2 is never empty while anything is known.
 *
 * `descriptionOf` used to be `ticket.summary || prs[0].title`, and BOTH can be empty on real
 * data: the core seeds a ticket candidate with `summary: ''` when the key came from a PR and was
 * not in the JQL snapshot, and a session-only item has neither. The row then drew one line of
 * keys and nothing else — `HB-627` on its own, which is exactly the "no title on it" complaint.
 *
 * So the fallback is a chain, and every rung is pinned here. The one thing it may never do is
 * repeat L1: an investigation's own title IS its identity, and saying it twice is not a
 * description.
 */
import { describe, expect, it } from 'vitest';
import { descriptionOf, identityOf, type WorkItem } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';

function fixtureItem(id: string): WorkItem {
  const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const item = response.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no ${id} in the fixture`);
  return item;
}

/** The ticket-with-a-PR row, which has every rung available at once. */
function ticketed(): WorkItem {
  return fixtureItem('ticket:HB-627');
}

describe('item 1 — the L2 fallback chain', () => {
  it('prefers the ticket summary', () => {
    expect(descriptionOf(ticketed())).toBe('Caregiver inbox reshuffle');
  });

  it('falls back to the first PR title when the ticket was seeded with no summary', () => {
    const item = ticketed();
    // What the core does when the key came from a PR and was not in the JQL snapshot.
    item.ticket = { ...item.ticket!, summary: '' };
    expect(descriptionOf(item)).toBe('HB-627 inbox reshuffle (web)');
  });

  it('falls back to the item title when neither the ticket nor the PR names the work', () => {
    const item = ticketed();
    item.ticket = { ...item.ticket!, summary: '' };
    item.prs[0].title = null;
    item.title = 'Caregiver inbox reshuffle, by hand';
    expect(descriptionOf(item)).toBe('Caregiver inbox reshuffle, by hand');
  });

  it('falls back to the branch — the last thing a PR always has a name in', () => {
    const item = ticketed();
    item.ticket = { ...item.ticket!, summary: '' };
    item.prs[0].title = null;
    item.title = '';
    item.prs[0].branch = 'hb-627-inbox-reshuffle';
    expect(descriptionOf(item)).toBe('hb-627-inbox-reshuffle');
  });

  it('draws no second line at all when nothing whatsoever is known', () => {
    const item = ticketed();
    item.ticket = { ...item.ticket!, summary: '' };
    item.prs[0].title = null;
    item.prs[0].branch = null;
    item.title = '';
    expect(descriptionOf(item)).toBe('');
  });

  it('never repeats L1: a session title that IS the identity is not also the description', () => {
    const item = fixtureItem('session:inv-stacktrace-1');
    expect(identityOf(item)).toBe('Investigate the nightly crash');
    expect(descriptionOf(item)).toBe('');
  });

  it('takes only the prose half of the core’s own title, never the head L1 already draws', () => {
    const item = ticketed();
    item.ticket = null;
    item.prs[0].title = null;
    item.prs[0].branch = null;
    item.title = 'acme/web#310 — Rework the inbox query';
    expect(descriptionOf(item)).toBe('Rework the inbox query');
  });

  it('ignores a rung that is only whitespace', () => {
    const item = ticketed();
    item.ticket = { ...item.ticket!, summary: '   ' };
    expect(descriptionOf(item)).toBe('HB-627 inbox reshuffle (web)');
  });
});
