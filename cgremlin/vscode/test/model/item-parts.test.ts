/**
 * Phase 11 task 5 — what a row opens into is the list of the item's OWN parts.
 *
 * The user's third complaint was "options that don't apply". The expanded row rendered all three
 * lifecycle slots on every row, so a teammate's parking-lot PR offered `Investigation / not
 * started` and `Development / not started` — two stages that can only ever produce a nonsensical
 * session on somebody else's branch. §4 replaces the fixed three with the parts the item actually
 * has, in a fixed order, each with its own state and its own buttons.
 */
import { describe, expect, it } from 'vitest';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import type { ItemsResponse, WorkItem, WorkListKind } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function itemOf(id: string): WorkItem {
  const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const found = response.items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function partsOf(id: string, list: WorkListKind) {
  const item = itemOf(id);
  const facts = itemActionFacts(item);
  return itemParts({
    item,
    list,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions: rowActions(facts, list),
    now: NOW,
  });
}

describe('§4 — which parts a row has', () => {
  it("offers a teammate's parking-lot PR only Review and the PR itself", () => {
    const parts = partsOf('pr:acme/web#101', 'parkingLot');
    expect(parts.map((part) => part.kind)).toEqual(['review', 'pr']);
    expect(parts.map((part) => part.key)).toEqual(['review', 'pr:acme/web#101']);
    expect(parts[0].stateText).toBe('not started');
    expect(parts[0].actions.map((action) => action.label)).toEqual(['Start review']);
  });

  it('lists every part of my own ticket, in §4 order', () => {
    const parts = partsOf('ticket:HB-627', 'myWork');
    expect(parts.map((part) => part.key)).toEqual([
      'investigation',
      'development',
      'review',
      'ticket:HB-627',
      'pr:acme/web#310',
      'pr:acme/api#88',
    ]);
    expect(parts[0].stateText).toBe('needs you');
    expect(parts[1].stateText).toBe('running · developing');
    expect(parts[3].stateText).toBe('In Progress');
    expect(parts[4].stateText).toContain('approved');
    expect(parts[4].stateText).toContain('12 files +300/−80');
  });

  it('never offers a Start development on a PR that is out with reviewers', () => {
    const parts = partsOf('pr:acme/web#200', 'waitingForReview');
    const labels = parts.flatMap((part) => part.actions.map((action) => action.label));
    expect(labels).not.toContain('Start development');
    expect(labels).not.toContain('Start investigation');
    expect(parts.map((part) => part.kind)).toEqual(['review', 'pr']);
  });

  it('gives a PR of mine a Review part exactly where Address review comments is offered', () => {
    const parts = partsOf('ticket:HB-627', 'waitingForReview');
    const review = parts.find((part) => part.kind === 'review');
    expect(review?.actions.map((action) => action.label)).toEqual(['Address review comments']);
    // …and no Review part at all where the list offers nothing to do with one: #200 already has
    // a respond agent triaging, so there is no second respond run to start.
    expect(partsOf('pr:acme/web#200', 'waitingForReview').find((p) => p.kind === 'review')?.actions)
      .toEqual([]);
  });

  it('gives an investigation no Review part — there is no PR to review', () => {
    const parts = partsOf('session:inv-stacktrace-1', 'investigations');
    expect(parts.map((part) => part.kind)).toEqual(['investigation', 'development']);
    expect(parts[1].actions.map((action) => action.label)).toContain('Start development');
  });

  it('opens an agent part only where a session exists', () => {
    const parts = partsOf('ticket:HB-627', 'myWork');
    expect(parts[0].childId).toBe('agent:inv-hb-627');
    expect(partsOf('pr:acme/web#101', 'parkingLot')[0].childId).toBeNull();
  });
});

describe('§4 — every button a part renders is one the list already allows', () => {
  const LISTS: [string, WorkListKind][] = [
    ['pr:acme/web#101', 'parkingLot'],
    ['pr:acme/web#102', 'parkingLot'],
    ['pr:acme/api#55', 'parkingLot'],
    ['ticket:HB-627', 'myWork'],
    ['pr:acme/api#77', 'myWork'],
    ['session:inv-stacktrace-1', 'investigations'],
    ['pr:acme/web#200', 'waitingForReview'],
    ['ticket:HB-627', 'waitingForReview'],
  ];

  it('never invents a command the row itself would refuse', () => {
    for (const [id, list] of LISTS) {
      const allowed = new Set(rowActions(itemActionFacts(itemOf(id)), list).map((a) => a.command));
      // The two navigations are the parts' own and belong to no list rule: opening the item tab
      // on a part is not a verb the engine can refuse.
      allowed.add('cgremlin.openChild');
      for (const part of partsOf(id, list)) {
        for (const action of part.actions) {
          expect(allowed.has(action.command), `${id}/${list}: ${action.command}`).toBe(true);
        }
      }
    }
  });

  it('never renders a Start for a stage behind the furthest one reached', () => {
    for (const [id, list] of LISTS) {
      const starts = partsOf(id, list)
        .flatMap((part) => part.actions)
        .filter((action) => action.label.startsWith('Start'));
      expect(new Set(starts.map((s) => s.label)).size, `${id}/${list}`).toBe(starts.length);
    }
  });
});

/**
 * Round 3 §e.4 — no button is labelled `Open`.
 *
 * Two buttons on one open row both read `Open` and meant different things: one opened the review
 * in the Item tab, the other opened the PR's own pane. `openAction()` hardcoded the word for
 * every part kind. A verb names the document it opens, or it is not there at all — a PR and a
 * ticket have exactly one destination each, and it is not local.
 */
describe('AC 4 — a verb names what it opens', () => {
  const labelsOf = (id: string, list: WorkListKind): string[] =>
    partsOf(id, list).flatMap((part) => part.actions.map((action) => action.label));

  it('names the document on a stage part, per its kind', () => {
    const parts = partsOf('ticket:HB-627', 'myWork');
    const byKind = new Map(parts.map((part) => [part.kind, part.actions.map((a) => a.label)]));
    expect(byKind.get('investigation')).toContain('Read the findings');
    expect(byKind.get('development')).toContain('Read the plan');
  });

  it('names the review on a review part that actually ran', () => {
    const parts = partsOf('pr:acme/web#102', 'parkingLot');
    const review = parts.find((part) => part.kind === 'review');
    expect(review?.actions.map((a) => a.label) ?? []).toContain('Read the review');
  });

  it('leaves a PR and a ticket with only their one true destination', () => {
    const parts = partsOf('ticket:HB-627', 'myWork');
    const ticket = parts.find((part) => part.kind === 'ticket');
    const pr = parts.find((part) => part.kind === 'pr');
    expect(ticket?.actions.map((a) => a.label)).toEqual(['Open in Jira']);
    expect(pr?.actions.map((a) => a.label)).toEqual(['Open on GitHub']);
  });

  it('labels nothing, on any row of any list, exactly `Open`', () => {
    const rows: [string, WorkListKind][] = [
      ['pr:acme/web#101', 'parkingLot'],
      ['ticket:HB-627', 'myWork'],
      ['pr:acme/web#200', 'waitingForReview'],
      ['pr:acme/web#102', 'parkingLot'],
      ['session:inv-stacktrace-1', 'investigations'],
    ];
    for (const [id, list] of rows) expect(labelsOf(id, list)).not.toContain('Open');
  });
});
