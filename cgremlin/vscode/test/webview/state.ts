/**
 * The `PanelState` the host would post, built from the same pure modules the host builds it with.
 *
 * Built here rather than hand-written so that the webview's tests are driven by the real shape —
 * a fixture that drifted from `PanelView.state()` would assert the reconciler against data the
 * panel never receives.
 */
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import { lifecycleSlots } from '../../src/model/lifecycle';
import {
  buildItemChildren,
  buildWorkLists,
  visibleRowCount,
  LIST_GLYPHS,
  type ItemsResponse,
  type WorkListKind,
} from '../../src/model/work-items';
import type {
  PanelListView,
  PanelSlotView,
  PanelState,
} from '../../src/model/panel-protocol';
import itemsFixture from '../support/fixtures/items.json';

export const NOW = Date.parse('2026-09-10T12:00:00.000Z');

export function itemsResponse(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

const START_COMMAND: Record<string, string> = {
  investigation: 'cgremlin.startInvestigation',
  development: 'cgremlin.startDevelopment',
  review: 'cgremlin.startReview',
};

export interface StateOptions {
  expanded?: string;
  selected?: string;
  response?: ItemsResponse;
  changes?: { committed: string; workingTree: string };
}

export function stateOf(over: StateOptions = {}): PanelState {
  const response = over.response ?? itemsResponse();
  const built = buildWorkLists({ response, now: NOW });
  const lists: PanelListView[] = (Object.keys(built) as WorkListKind[]).map((kind) => {
    const list = built[kind];
    const sections = list.sections.map((section) => ({
        group: section.group,
        title: section.title,
        count: section.count,
        collapsible: section.collapsible,
        collapsed: section.collapsed,
        rows: section.rows.map((row) => {
          const expanded = over.expanded === row.id;
          const actions = rowActions(itemActionFacts(row.item), row.list);
          return {
            id: row.id,
            list: row.list,
            label: row.label,
            description: row.description,
            badges: row.badges,
            chips: row.chips,
            age: row.age,
            size: row.size,
            ci: row.ci,
            meta: row.meta,
            stateLine: row.stateLine,
            tier: row.tier,
            demoted: row.demoted,
            needsYou: row.needsYou,
            hasChildren: true,
            expanded,
            selected: over.selected === row.id,
            children: expanded
              ? buildItemChildren(row.item)
                  .filter((child) => child.kind !== 'agent')
                  .map((child) => ({
                    id: child.id,
                    kind: child.kind,
                    label: child.label,
                    goToLabel: 'Open',
                  }))
              : [],
            lifecycle: expanded ? slotsOf(row.item, actions) : [],
            changes: expanded ? (over.changes ?? { committed: '—', workingTree: '—' }) : null,
            actions,
          };
        }),
    }));
    return {
      kind,
      title: list.title,
      glyph: LIST_GLYPHS[kind],
      collapsed: false,
      count: visibleRowCount(sections),
      sort: list.sort,
      sorts: [...list.sorts],
      sections,
    };
  });
  return { lists, needsYou: [], banner: null, trouble: null, connected: true };
}

function slotsOf(
  item: Parameters<typeof itemActionFacts>[0],
  actions: ReturnType<typeof rowActions>,
): PanelSlotView[] {
  return lifecycleSlots({ agents: item.agents, facts: itemActionFacts(item), now: NOW }).map(
    (slot) => ({
      stage: slot.stage,
      title: slot.title,
      glyph: slot.glyph,
      state: slot.state,
      stateText: slot.stateText,
      sessionId: slot.sessionId,
      start: slot.next
        ? (actions.find((action) => action.command === START_COMMAND[slot.stage]) ?? null)
        : null,
    }),
  );
}
