/**
 * P1 — a header never claims a row the tree does not paint.
 *
 * The user's report was "the parking lot says 11 but shows nothing": every PR in his parking lot
 * was a teammate's that somebody had already glanced at, so the core put all of them in
 * `someoneOnIt` — the group the panel collapses by default (R47) — and the list header counted
 * them anyway.
 *
 * Driven through the real webview against the stand-in DOM, so what is asserted is the number of
 * `.row` nodes actually in the document, not a model's opinion of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { itemsResponse, stateOf } from './state';
import { visibleRowCount } from '../../src/model/work-items';
import type { ItemsResponse, ParkingLotGroup, WorkItem } from '../../src/model/work-items';
import type { PanelListView, PanelState } from '../../src/model/panel-protocol';

interface Panel {
  render(next: PanelState): void;
}

let dom: InstalledDom;
let panel: Panel;

beforeEach(async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  dom = installDom();
  panel = (await import('../../src/webview/panel')) as unknown as Panel;
});

afterEach(() => {
  dom.uninstall();
});

/** A parking lot of `n` PRs, all in one group and nothing anywhere else. */
function onlyGroup(group: ParkingLotGroup, n: number): ItemsResponse {
  const base = itemsResponse();
  const template = base.items.find((item) => item.id === 'pr:acme/web#101');
  if (template === undefined) throw new Error('fixture');
  const items: WorkItem[] = [];
  const ids: string[] = [];
  for (let at = 0; at < n; at += 1) {
    const clone = JSON.parse(JSON.stringify(template)) as WorkItem;
    clone.id = `pr:acme/web#${300 + at}`;
    clone.prs[0].number = 300 + at;
    clone.lists = ['parkingLot'];
    clone.parkingLotGroup = group;
    clone.demoted = group === 'someoneOnIt';
    items.push(clone);
    ids.push(clone.id);
  }
  const lot = { reviewing: [] as string[], untouched: [] as string[], someoneOnIt: [] as string[] };
  lot[group] = ids;
  return {
    ...base,
    items,
    lists: { parkingLot: lot, myWork: [], investigations: [], waitingForReview: [] },
  };
}

const rows = (): FakeElement[] => dom.root.byClass('row');
const headerTexts = (): string[] =>
  dom.root.byClass('section-header').map((node) => node.textContent);
const listTexts = (): string[] => dom.root.byClass('list-title').map((node) => node.textContent);

/** Opens every group, exactly as the user clicking each chevron would. */
function expandAll(state: PanelState): PanelState {
  const lists: PanelListView[] = state.lists.map((list) => {
    const sections = list.sections.map((section) => ({ ...section, collapsed: false }));
    return { ...list, sections, count: visibleRowCount(sections) };
  });
  return { ...state, lists };
}

describe('P1 header counts', () => {
  it('counts the visible rows, not the ones a collapsed group holds', () => {
    const state = stateOf({ response: onlyGroup('someoneOnIt', 11) });
    panel.render(state);
    expect(rows().length).toBe(0);
    expect(listTexts()).toContain('Parking lot (0)');
    // The eleven are not lost — the group that holds them says so on its own header.
    expect(headerTexts()).toContain('Someone is on it (11)');
  });

  it('counts every row once the groups are expanded', () => {
    panel.render(expandAll(stateOf({ response: onlyGroup('someoneOnIt', 11) })));
    expect(rows().length).toBe(11);
    expect(listTexts()).toContain('Parking lot (11)');
  });

  it('holds for an untouched-only parking lot, which is never collapsed', () => {
    const state = stateOf({ response: onlyGroup('untouched', 11) });
    panel.render(state);
    expect(rows().length).toBe(11);
    expect(listTexts()).toContain('Parking lot (11)');
    expect(headerTexts()).toContain('Untouched (11)');
  });

  it('agrees with the tree on the real fixture, with every group open', () => {
    const state = expandAll(stateOf());
    panel.render(state);
    const total = state.lists.reduce((sum, list) => sum + list.count, 0);
    expect(rows().length).toBe(total);
  });
});
