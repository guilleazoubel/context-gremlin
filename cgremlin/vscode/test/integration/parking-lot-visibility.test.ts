/**
 * P1 — "the parking lot says 11 but shows nothing", against a REAL engine.
 *
 * The user's parking lot was entirely teammates' PRs somebody had already glanced at, so the core
 * put every one of them in `someoneOnIt` — the one group the panel collapsed by DEFAULT. The list
 * header counted all three groups and the tree painted none of them, and there was no chevron to
 * say why.
 *
 * Asserted end to end rather than on a hand-written fixture: the grouping is the core's answer
 * (D2), so the shape that broke the panel has to come out of a real `GET /items`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildWorkLists, visibleRowCount, type ItemsResponse } from '../../src/model/work-items';
import { panelTreeNodes } from '../../src/model/panel-tree';
import type { PanelListView, PanelState } from '../../src/model/panel-protocol';
import { coreIsBuilt, startEngineViaManager, waitUntil, type CoreHarness } from '../support/core-harness';

const FIXTURES = path.join(__dirname, '..', 'support', 'fake-gh-parking-lot');
const TIMEOUT = 30_000;

/** `buildWorkLists` as the panel posts it — counts and rows, nothing else this file needs. */
function listsOf(response: ItemsResponse): PanelListView[] {
  const built = buildWorkLists({ response });
  return Object.values(built).map((list) => ({
    kind: list.kind,
    title: list.title,
    count: list.count,
    sort: list.sort,
    sorts: [...list.sorts],
    sections: list.sections.map((section) => ({
      group: section.group,
      title: section.title,
      count: section.count,
      collapsible: section.collapsible,
      collapsed: section.collapsed,
      rows: section.rows.map((row) => ({
        ...row,
        children: [],
        lifecycle: [],
        changes: null,
        actions: [],
        expanded: false,
        selected: false,
      })),
    })),
  })) as unknown as PanelListView[];
}

/** The rows the tree really paints — the same walk the webview reconciles (R66). */
function paintedRows(state: PanelState): number {
  return panelTreeNodes(state).filter((node) => node.kind === 'row' && node.list === 'parkingLot')
    .length;
}

describe.skipIf(!coreIsBuilt())('integration: P1 — the parking lot renders what it counts', () => {
  let h: CoreHarness;
  let response: ItemsResponse;

  beforeAll(async () => {
    h = await startEngineViaManager({ ghFixtures: FIXTURES });
    expect((await h.client.scan()).status).toBe(200);
    response = await waitUntil(
      async () => (await h.client.items()) as unknown as ItemsResponse,
      (listing) => listing.lists.parkingLot.someoneOnIt.length > 0,
      { what: 'the PR inventory scan' },
    );
  }, TIMEOUT);

  afterAll(async () => {
    await h?.stop();
    await h?.cleanup();
  });

  it('really does group every teammate PR into "someone is on it"', () => {
    const lot = response.lists.parkingLot;
    expect(lot.untouched).toEqual([]);
    expect(lot.someoneOnIt.length).toBe(11);
  });

  it('never counts a row the tree does not paint', () => {
    const lists = listsOf(response);
    const state = { lists, banner: null, trouble: null, connected: true } as PanelState;
    const parkingLot = lists.find((list) => list.kind === 'parkingLot');
    if (parkingLot === undefined) throw new Error('no parking lot');
    const hidden = parkingLot.sections.find((section) => section.group === 'someoneOnIt');
    // The group the panel collapses by default carries its OWN count, on its own header.
    expect([hidden?.collapsed, hidden?.count]).toEqual([true, 11]);
    expect(paintedRows(state)).toBe(parkingLot.count);
    // …and the eleven are not in that number, which is the whole of the user's complaint.
    expect(parkingLot.count).toBeLessThan(11);
  });

  it('counts every row once the groups are expanded', () => {
    const lists = listsOf(response);
    for (const list of lists) {
      for (const section of list.sections) section.collapsed = false;
      list.count = visibleRowCount(list.sections);
    }
    const state = { lists, banner: null, trouble: null, connected: true } as PanelState;
    const parkingLot = lists.find((list) => list.kind === 'parkingLot');
    if (parkingLot === undefined) throw new Error('no parking lot');
    expect(parkingLot.count).toBeGreaterThanOrEqual(11);
    expect(paintedRows(state)).toBe(parkingLot.count);
  });
});
