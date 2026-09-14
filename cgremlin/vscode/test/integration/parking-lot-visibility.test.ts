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
import { buildWorkLists, PANEL_SECTIONS, type ItemsResponse } from '../../src/model/work-items';
import { panelTreeNodes } from '../../src/model/panel-tree';
import type { PanelSectionView, PanelState } from '../../src/model/panel-protocol';
import { coreIsBuilt, startEngineViaManager, waitUntil, type CoreHarness } from '../support/core-harness';

const FIXTURES = path.join(__dirname, '..', 'support', 'fake-gh-parking-lot');
const TIMEOUT = 30_000;

/** `buildWorkLists` flattened into §5's six sections, exactly as `PanelView.state()` does it. */
function sectionsOf(response: ItemsResponse): PanelSectionView[] {
  const built = buildWorkLists({ response });
  return PANEL_SECTIONS.map((spec, index) => {
    const list = built[spec.list];
    const source = list.sections.find((section) => section.group === spec.group);
    const rows = (source?.rows ?? []).map((row) => ({
      ...row,
      children: [],
      lifecycle: [],
      changes: null,
      actions: [],
      expanded: false,
      selected: false,
    }));
    return {
      key: spec.key,
      list: spec.list,
      group: spec.group,
      title: spec.title,
      glyph: spec.glyph,
      count: rows.length,
      collapsed: spec.collapsed,
      sort: list.sort,
      sorts: [...list.sorts],
      showsSort: PANEL_SECTIONS.findIndex((other) => other.list === spec.list) === index,
      rows,
    };
  }) as unknown as PanelSectionView[];
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
    const sections = sectionsOf(response);
    const state = { sections, banner: null, trouble: null, connected: true } as PanelState;
    const someone = sections.find((section) => section.key === 'parkingLot:someoneOnIt');
    // The section the panel collapses by default carries its OWN count, on its own header — and
    // nothing above it claims those eleven any more, because nothing is above it (§5).
    expect([someone?.collapsed, someone?.count]).toEqual([true, 11]);
    // Nothing of the eleven is painted: what is left on screen is the one PR the user has
    // already started reviewing, in its own section.
    expect(paintedRows(state)).toBe(1);
    expect(sections.find((section) => section.key === 'parkingLot:untouched')?.count).toBe(0);
    expect(sections.find((section) => section.key === 'parkingLot:reviewing')?.count).toBe(1);
  });

  it('paints every row once the section is opened', () => {
    const sections = sectionsOf(response).map((section) => ({ ...section, collapsed: false }));
    const state = { sections, banner: null, trouble: null, connected: true } as PanelState;
    expect(paintedRows(state)).toBe(12);
  });
});
