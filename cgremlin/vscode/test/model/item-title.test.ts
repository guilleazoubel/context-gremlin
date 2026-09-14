/**
 * Phase 12 item 1 — the title the USER writes.
 *
 * A derived description answers "what is this" only as well as the sources do. The user asked to
 * be able to write his own, so an override lives in the host's `globalState` — and it is keyed by
 * every name the item answers to, not just by `WorkItem.id`. An id is a *shape* (`pr:acme/web#101`
 * becomes `ticket:HB-627` the moment the scan links the two), and a title that vanished when the
 * item gained a ticket would be the feature failing at exactly the moment the row matters most.
 *
 * Pure module — the store is the narrow two-member slice the sorts already use (R64).
 */
import { describe, expect, it } from 'vitest';
import {
  readTitle,
  titleKeysOf,
  titleStateKey,
  writeTitle,
  type TitleStore,
} from '../../src/model/item-title';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

class Store implements TitleStore {
  readonly state = new Map<string, unknown>();

  getState<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  setState(key: string, value: unknown): unknown {
    if (value === undefined) this.state.delete(key);
    else this.state.set(key, value);
    return undefined;
  }
}

function fixtureItem(id: string): WorkItem {
  const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const item = response.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no ${id} in the fixture`);
  return item;
}

describe('item 1 — a per-item title the user writes', () => {
  it('keys the override by the id and by every ref the item answers to', () => {
    expect(titleKeysOf(fixtureItem('ticket:HB-627'))).toEqual([
      'ticket:HB-627',
      'pr:acme/web#310',
      'pr:acme/api#88',
      'session:inv-hb-627',
      'session:dev-hb-627',
    ]);
  });

  it('reads back what was written, under the item’s own state prefix', () => {
    const store = new Store();
    const item = fixtureItem('pr:acme/web#101');
    writeTitle(store, item, 'The retry budget nobody owns');
    expect(readTitle(store, item)).toBe('The retry budget nobody owns');
    expect(store.getState(titleStateKey('pr:acme/web#101'))).toBe('The retry budget nobody owns');
  });

  it('trims what the user typed, and treats whitespace as nothing at all', () => {
    const store = new Store();
    const item = fixtureItem('pr:acme/web#101');
    writeTitle(store, item, '  A shorter name  ');
    expect(readTitle(store, item)).toBe('A shorter name');
    writeTitle(store, item, '   ');
    expect(readTitle(store, item)).toBe('');
  });

  it('clears every key, so an empty input restores the derived description for good', () => {
    const store = new Store();
    const item = fixtureItem('ticket:HB-627');
    writeTitle(store, item, 'Inbox, second attempt');
    writeTitle(store, item, '');
    expect(readTitle(store, item)).toBe('');
    expect([...store.state.keys()]).toEqual([]);
  });

  it('survives the item gaining a ticket, because the PR ref is a key too', () => {
    const store = new Store();
    const beforeLink = fixtureItem('pr:acme/web#101');
    writeTitle(store, beforeLink, 'The retry budget nobody owns');

    // The scan links the PR to a ticket: same work, new id, new title, a ticket where there was
    // none. Only the PR ref is unchanged — and that is enough.
    const afterLink = fixtureItem('pr:acme/web#101');
    afterLink.id = 'ticket:HB-900';
    afterLink.kind = 'pr+ticket';
    afterLink.ticket = {
      key: 'HB-900',
      summary: 'Retry budget',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      url: 'https://jira.example/HB-900',
      assignee: 'me',
      updatedAt: '2026-09-10T07:00:00.000Z',
    };
    expect(readTitle(store, afterLink)).toBe('The retry budget nobody owns');
  });

  it('ignores a stored value this panel did not write', () => {
    const store = new Store();
    const item = fixtureItem('pr:acme/web#101');
    store.setState(titleStateKey('pr:acme/web#101'), { not: 'a string' });
    expect(readTitle(store, item)).toBe('');
  });
});
