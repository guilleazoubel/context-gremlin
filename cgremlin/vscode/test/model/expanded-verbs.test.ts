/**
 * Round 3 §e.7 — `ActionPlacement` is computed through three modules and was then thrown away.
 *
 * `expanded.ts` rendered every leftover action as an identical button and never read `placement`
 * (`item-tab.ts` has honoured it since phase 17 — the panel was the outlier). That is the single
 * cause of BOTH reported defects: two buttons reading `Open`, and a row of jargon (`Ack`,
 * `Rename`, `Dismiss`) sitting at the same weight as the verb that does the work.
 *
 * So the open block resolves the placements ONCE, in the model: the one recommended action, at
 * most two supporting ones, and the housekeeping in the disclosure. No verb is invented here —
 * every one of them comes from `rowActions` or from a part that took it from there (P0-2).
 */
import { describe, expect, it } from 'vitest';
import { hoistVerbs, itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { itemActionFacts } from '../../src/model/row-actions';
import { actionsFor } from '../../src/ui/panel-view';
import type { ItemsResponse, WorkItem, WorkListKind } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function itemOf(id: string): WorkItem {
  const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const found = response.items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function hoisted(id: string, list: WorkListKind) {
  const item = itemOf(id);
  const facts = itemActionFacts(item);
  const actions = actionsFor(item, list);
  const parts = itemParts({
    item,
    list,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions,
    now: NOW,
  });
  return hoistVerbs(parts, actions);
}

const labels = (verbs: { label: string; placement: string }[], placement: string): string[] =>
  verbs.filter((verb) => verb.placement === placement).map((verb) => verb.label);

describe('the open block resolves placement once', () => {
  it('leads with ONE primary verb and at most two supporting ones', () => {
    const { verbs } = hoisted('pr:acme/web#102', 'parkingLot');
    expect(labels(verbs, 'primary')).toEqual(['Read the review']);
    expect(labels(verbs, 'inline').length).toBeLessThanOrEqual(2);
  });

  it('puts the housekeeping in the disclosure, never beside the work', () => {
    const { verbs } = hoisted('pr:acme/web#102', 'parkingLot');
    expect(labels(verbs, 'overflow')).toContain('Rename this item');
    expect(labels(verbs, 'overflow')).toContain('Hide from the panel');
    expect(labels(verbs, 'primary')).not.toContain('Rename this item');
    expect(labels(verbs, 'inline')).not.toContain('Hide from the panel');
  });

  it('never says a verb twice: a hoisted one leaves the part it came from', () => {
    const { verbs, parts } = hoisted('pr:acme/web#102', 'parkingLot');
    const onParts = parts.flatMap((part) => part.actions.map((a) => `${a.command}:${a.childId ?? ''}`));
    const up = verbs.map((verb) => `${verb.command}:${verb.childId ?? ''}`);
    expect(up.filter((key) => onParts.includes(key))).toEqual([]);
  });

  it('gives a failed run its Retry as the one primary, over anything else', () => {
    const item = itemOf('pr:acme/web#102');
    item.agents[0] = { ...item.agents[0], runFailed: true };
    const facts = itemActionFacts(item);
    const actions = actionsFor(item, 'parkingLot');
    const parts = itemParts({
      item,
      list: 'parkingLot',
      slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
      actions,
      now: NOW,
    });
    expect(labels(hoistVerbs(parts, actions).verbs, 'primary')).toEqual(['Retry']);
  });

  it('drops Ack from the row entirely — reading is acknowledging', () => {
    const all = actionsFor(itemOf('pr:acme/web#102'), 'parkingLot');
    expect(all.map((action) => action.command)).not.toContain('cgremlin.ack');
  });

  it('names the housekeeping verbs by their effect', () => {
    const all = actionsFor(itemOf('pr:acme/web#102'), 'parkingLot').map((a) => a.label);
    expect(all).toContain('Rename this item');
    expect(all).toContain('Hide from the panel');
    expect(all).not.toContain('Rename');
    expect(all).not.toContain('Dismiss');
  });
});
