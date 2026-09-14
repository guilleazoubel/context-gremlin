/**
 * The `PanelState` the host would post, built from the same pure modules the host builds it with.
 *
 * Built here rather than hand-written so that the webview's tests are driven by the real shape —
 * a fixture that drifted from `PanelView.state()` would assert the reconciler against data the
 * panel never receives.
 */
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
// The panel's own action layer, so the fixture cannot drift from what the host actually posts.
import { actionsFor } from '../../src/ui/panel-view';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import {
  buildWorkLists,
  DISMISSED_SECTION_GLYPH,
  DISMISSED_SECTION_KEY,
  DISMISSED_SECTION_TITLE,
  PANEL_SECTIONS,
  type ItemsResponse,
} from '../../src/model/work-items';
import type { WorkRow } from '../../src/model/work-items';
import type { PanelSectionView, PanelState } from '../../src/model/panel-protocol';
import itemsFixture from '../support/fixtures/items.json';

export const NOW = Date.parse('2026-09-10T12:00:00.000Z');

export function itemsResponse(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

export interface StateOptions {
  expanded?: string;
  selected?: string;
  response?: ItemsResponse;
  changes?: { committed: string; workingTree: string };
  /** Which sections the user has closed, by section key. */
  collapsed?: Record<string, boolean>;
  /** §6: `all`, or the one section key the panel is narrowed to. */
  focus?: string;
  /** Item 2: the ids the user has put aside, and whether the bin is open. */
  dismissed?: string[];
  showDismissed?: boolean;
}

export function stateOf(over: StateOptions = {}): PanelState {
  const response = over.response ?? itemsResponse();
  const built = buildWorkLists({ response, now: NOW });
  const sections: PanelSectionView[] = PANEL_SECTIONS.map((spec, index) => {
    const list = built[spec.list];
    const source = list.sections.find((section) => section.group === spec.group);
    const rows = (source?.rows ?? [])
      .filter((row) => !(over.dismissed ?? []).includes(row.id))
      .map((row) => rowViewOf(row, over));
    return {
      key: spec.key,
      list: spec.list,
      group: spec.group,
      title: spec.title,
      glyph: spec.glyph,
      count: rows.length,
      collapsed: over.collapsed?.[spec.key] ?? spec.collapsed,
      sort: list.sort,
      sorts: [...list.sorts],
      showsSort: PANEL_SECTIONS.findIndex((other) => other.list === spec.list) === index,
      rows,
    };
  });
  const focus = over.focus ?? 'all';
  const shown = focus === 'all' ? sections : sections.filter((section) => section.key === focus);
  const bin = dismissedSectionOf(built, over);
  return {
    sections: (over.showDismissed ?? false) ? [...shown, bin] : shown,
    focus,
    focusOptions: [
      {
        key: 'all',
        title: 'All areas',
        count: sections.reduce((sum, section) => sum + section.count, 0),
      },
      ...sections.map((section) => ({
        key: section.key,
        title: section.title,
        count: section.count,
      })),
    ],
    needsYou: [],
    dismissedCount: over.dismissed?.length ?? 0,
    showDismissed: over.showDismissed ?? false,
    banner: null,
    trouble: null,
    notice: null,
    connected: true,
  };
}

/** One row, built exactly the way `PanelView.rowView` builds it. */
function rowViewOf(row: WorkRow, over: StateOptions) {
  const expanded = over.expanded === row.id;
  const dismissed = (over.dismissed ?? []).includes(row.id);
  const actions = actionsFor(row.item, row.list, dismissed);
  return {
    id: row.id,
    list: row.list,
    label: row.label,
    identity: row.identity,
    identityKeys: row.identityKeys,
    description: row.description,
    descriptionIsOwn: false,
    badges: row.badges,
    chips: row.chips,
    age: row.age,
    size: row.size,
    ci: row.ci,
    meta: row.meta,
    tier: row.tier,
    demoted: row.demoted,
    dismissed,
    needsYou: row.needsYou,
    hasChildren: true,
    expanded,
    selected: over.selected === row.id,
    parts: expanded ? partsOf(row.item, row.list, actions) : [],
    changes: expanded ? (over.changes ?? { committed: '—', workingTree: '—' }) : null,
    actions,
    hint: null,
    detailNotice: null,
  };
}

/** Item 2's bin: the dismissed rows, taken out of the sections they came from. */
function dismissedSectionOf(
  built: ReturnType<typeof buildWorkLists>,
  over: StateOptions,
): PanelSectionView {
  const ids = over.dismissed ?? [];
  const rows = Object.values(built)
    .flatMap((list) => list.sections.flatMap((section) => section.rows))
    .filter((row) => ids.includes(row.id))
    .map((row) => rowViewOf(row, over));
  return {
    key: DISMISSED_SECTION_KEY,
    list: 'parkingLot',
    group: null,
    title: DISMISSED_SECTION_TITLE,
    glyph: DISMISSED_SECTION_GLYPH,
    count: rows.length,
    collapsed: over.collapsed?.[DISMISSED_SECTION_KEY] ?? false,
    sort: built.parkingLot.sort,
    sorts: [],
    showsSort: false,
    rows,
  };
}

function partsOf(
  item: Parameters<typeof itemActionFacts>[0],
  list: Parameters<typeof rowActions>[1],
  actions: ReturnType<typeof rowActions>,
) {
  const facts = itemActionFacts(item);
  return itemParts({
    item,
    list,
    slots: lifecycleSlots({ agents: item.agents, facts, now: NOW }),
    actions,
    now: NOW,
  });
}
