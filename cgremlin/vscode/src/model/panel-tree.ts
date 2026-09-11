/**
 * The panel's tree model and its keyboard map (R54, R66).
 *
 * R66 says the panel is an accessible tree, not a pile of divs, and that declaring the roles
 * without implementing the keys — or the reverse — is the failure mode. So both come from **one**
 * pure module: `panelTreeNodes` is the sequence of `role="treeitem"` nodes with their
 * `aria-level` and `aria-expanded`, and `handleKey` is the navigation those roles promise. The
 * webview renders the first and dispatches the second; a test asserts them together.
 *
 * Pure module — no editor API (MG-B1).
 */
import type { ParkingLotGroup, WorkListKind } from './work-items';
import type { PanelState } from './panel-protocol';

export type PanelNodeKind = 'group' | 'row' | 'child';

export interface PanelTreeNode {
  /** Unique within the rendered panel, and stable across re-renders. */
  key: string;
  kind: PanelNodeKind;
  list: WorkListKind;
  /** 1 for a group header or a row, 2 for a child (R66). */
  level: 1 | 2;
  label: string;
  expandable: boolean;
  expanded: boolean;
  /** The row a child belongs to, `null` for a row or a group header. */
  rowId: string | null;
  /** The item id for a row, the child id for a child, `null` for a group header. */
  id: string | null;
  group: ParkingLotGroup | null;
}

/**
 * Every focusable node, in render order: a collapsible group header, then its rows, then each
 * expanded row's children. A collapsed group contributes its header and nothing else.
 */
export function panelTreeNodes(state: PanelState): PanelTreeNode[] {
  const nodes: PanelTreeNode[] = [];
  for (const list of state.lists) {
    for (const section of list.sections) {
      if (section.group !== null && section.collapsible) {
        nodes.push({
          key: `group:${list.kind}:${section.group}`,
          kind: 'group',
          list: list.kind,
          level: 1,
          label: `${section.title} (${section.count})`,
          expandable: true,
          expanded: !section.collapsed,
          rowId: null,
          id: null,
          group: section.group,
        });
      }
      if (section.collapsed) continue;
      for (const row of section.rows) {
        nodes.push({
          key: `row:${list.kind}:${row.id}`,
          kind: 'row',
          list: list.kind,
          level: 1,
          label: row.label,
          expandable: row.hasChildren,
          expanded: row.expanded,
          rowId: null,
          id: row.id,
          group: section.group,
        });
        if (!row.expanded) continue;
        for (const child of row.children) {
          nodes.push({
            key: `child:${row.id}:${child.id}`,
            kind: 'child',
            list: list.kind,
            level: 2,
            label: child.label,
            expandable: false,
            expanded: false,
            rowId: row.id,
            id: child.id,
            group: section.group,
          });
        }
      }
    }
  }
  return nodes;
}

export type KeyIntent =
  | { kind: 'focus'; key: string }
  | { kind: 'toggleRow'; id: string; expanded: boolean }
  | { kind: 'toggleGroup'; list: WorkListKind; group: ParkingLotGroup; collapsed: boolean }
  | { kind: 'activate'; node: PanelTreeNode }
  | null;

/**
 * The tree keyboard model: up/down between nodes, right/left to expand and collapse (or to step
 * into and out of a row's children), Enter or Space to take the default action.
 */
export function handleKey(
  key: string,
  nodes: readonly PanelTreeNode[],
  focusedKey: string | null,
): KeyIntent {
  if (nodes.length === 0) return null;
  const at = nodes.findIndex((node) => node.key === focusedKey);
  const focused = at >= 0 ? nodes[at] : undefined;

  switch (key) {
    case 'ArrowDown':
      return { kind: 'focus', key: nodes[Math.min(at + 1, nodes.length - 1)].key };
    case 'ArrowUp':
      return { kind: 'focus', key: nodes[Math.max(at - 1, 0)].key };
    case 'Home':
      return { kind: 'focus', key: nodes[0].key };
    case 'End':
      return { kind: 'focus', key: nodes[nodes.length - 1].key };
    case 'ArrowRight': {
      if (focused === undefined) return { kind: 'focus', key: nodes[0].key };
      if (focused.expandable && !focused.expanded) return expand(focused, true);
      // Already open (or a leaf): step into the first thing under it, which is the next node.
      return at + 1 < nodes.length ? { kind: 'focus', key: nodes[at + 1].key } : null;
    }
    case 'ArrowLeft': {
      if (focused === undefined) return { kind: 'focus', key: nodes[0].key };
      if (focused.expandable && focused.expanded) return expand(focused, false);
      if (focused.kind === 'child') {
        const parent = nodes.find(
          (node) => node.kind === 'row' && node.id === focused.rowId,
        );
        return parent === undefined ? null : { kind: 'focus', key: parent.key };
      }
      return at > 0 ? { kind: 'focus', key: nodes[at - 1].key } : null;
    }
    case 'Enter':
    case ' ':
      return focused === undefined ? null : { kind: 'activate', node: focused };
    default:
      return null;
  }
}

function expand(node: PanelTreeNode, expanded: boolean): KeyIntent {
  if (node.kind === 'group' && node.group !== null) {
    return { kind: 'toggleGroup', list: node.list, group: node.group, collapsed: !expanded };
  }
  return node.id === null ? null : { kind: 'toggleRow', id: node.id, expanded };
}

// ---------------------------------------------------------------------------
// Order freezing (§2.2 rule 4, P0-4)
// ---------------------------------------------------------------------------

/** The row ids actually painted, per section — the key is `<list>:<group>`. */
export type PaintedOrder = Map<string, string[]>;

export function paintedOrderOf(state: PanelState): PaintedOrder {
  const order: PaintedOrder = new Map();
  for (const list of state.lists) {
    for (const section of list.sections) {
      order.set(sectionKey(list.kind, section.group), section.rows.map((row) => row.id));
    }
  }
  return order;
}

function sectionKey(list: WorkListKind, group: ParkingLotGroup | null): string {
  return `${list}:${group ?? ''}`;
}

/**
 * "No re-sorting while the pointer is inside the list": the CONTENT of a frozen render still
 * lands (a phase that moved on is news), but the sequence keeps the order already on screen, so
 * the row under the cursor cannot slide out from under it. Rows that are new to the section join
 * at the end, in the incoming order, and rows that left simply drop out.
 *
 * Pure, so the rule is asserted without a DOM.
 */
export function freezeOrder(next: PanelState, painted: PaintedOrder): PanelState {
  return {
    ...next,
    lists: next.lists.map((list) => ({
      ...list,
      sections: list.sections.map((section) => {
        const prior = painted.get(sectionKey(list.kind, section.group));
        if (prior === undefined) return section;
        const byId = new Map(section.rows.map((row) => [row.id, row]));
        const kept = prior.flatMap((id) => {
          const row = byId.get(id);
          return row === undefined ? [] : [row];
        });
        const added = section.rows.filter((row) => !prior.includes(row.id));
        return { ...section, rows: [...kept, ...added] };
      }),
    })),
  };
}
