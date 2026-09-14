/**
 * The `PanelState` the host would post, built from the same pure modules the host builds it with.
 *
 * Built here rather than hand-written so that the webview's tests are driven by the real shape —
 * a fixture that drifted from `PanelView.state()` would assert the reconciler against data the
 * panel never receives.
 */
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import { itemParts } from '../../src/model/item-parts';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { buildWorkLists, PANEL_SECTIONS, type ItemsResponse } from '../../src/model/work-items';
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
}

export function stateOf(over: StateOptions = {}): PanelState {
  const response = over.response ?? itemsResponse();
  const built = buildWorkLists({ response, now: NOW });
  const sections: PanelSectionView[] = PANEL_SECTIONS.map((spec, index) => {
    const list = built[spec.list];
    const source = list.sections.find((section) => section.group === spec.group);
    const rows = (source?.rows ?? []).map((row) => {
      const expanded = over.expanded === row.id;
      const actions = rowActions(itemActionFacts(row.item), row.list);
      return {
        id: row.id,
        list: row.list,
        label: row.label,
        identity: row.identity,
        identityKeys: row.identityKeys,
        description: row.description,
        badges: row.badges,
        chips: row.chips,
        age: row.age,
        size: row.size,
        ci: row.ci,
        meta: row.meta,
        tier: row.tier,
        demoted: row.demoted,
        needsYou: row.needsYou,
        hasChildren: true,
        expanded,
        selected: over.selected === row.id,
        parts: expanded ? partsOf(row.item, row.list, actions) : [],
        changes: expanded ? (over.changes ?? { committed: '—', workingTree: '—' }) : null,
        actions,
        hint: null,
      };
    });
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
  return {
    sections: focus === 'all' ? sections : sections.filter((section) => section.key === focus),
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
    banner: null,
    trouble: null,
    notice: null,
    connected: true,
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
