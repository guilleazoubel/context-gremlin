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

export type PanelNodeKind = 'row' | 'child';

export interface PanelTreeNode {
  /** Unique within the rendered panel, and stable across re-renders. */
  key: string;
  kind: PanelNodeKind;
  list: WorkListKind;
  /** 1 for a row, 2 for one of its parts (R66). */
  level: 1 | 2;
  label: string;
  expandable: boolean;
  expanded: boolean;
  /** The row a child belongs to, `null` for a row. */
  rowId: string | null;
  /** The item id for a row, the child id for a child. */
  id: string | null;
  group: ParkingLotGroup | null;
}

/**
 * Every focusable node, in render order: each section's rows, then each expanded row's parts.
 *
 * §5 promoted the parking lot's groups to sections, and a section header is a `<button>`
 * disclosure rather than a `treeitem` — the browser owns its Enter and Space, exactly as the list
 * header's already did. So the tree is rows and parts, and nothing else. A collapsed section
 * contributes nothing at all, which is what keeps the keyboard out of rows the user cannot see.
 */
export function panelTreeNodes(state: PanelState): PanelTreeNode[] {
  const nodes: PanelTreeNode[] = [];
  for (const section of state.sections) {
    if (section.collapsed) continue;
    for (const row of section.rows) {
      nodes.push({
        key: `row:${section.list}:${row.id}`,
        kind: 'row',
        list: section.list,
        level: 1,
        label: row.label,
        expandable: row.hasChildren,
        expanded: row.expanded,
        rowId: null,
        id: row.id,
        group: section.group,
      });
      // §6's rule, one level down: a part inside a CLOSED disclosure is not on screen, so the
      // keyboard must not be able to walk onto it. The disclosure's state is the host's for
      // exactly this reason — the tree cannot ask the DOM.
      if (!row.expanded || !row.detailsOpen) continue;
      for (const part of row.parts) {
        nodes.push({
          key: `part:${row.id}:${part.key}`,
          kind: 'child',
          list: section.list,
          level: 2,
          label: `${part.name} ${part.stateText}`,
          expandable: false,
          expanded: false,
          rowId: row.id,
          // A stage that never ran opens nothing, so activating it does nothing (§4).
          id: part.childId,
          group: section.group,
        });
      }
    }
  }
  return nodes;
}

export type KeyIntent =
  | { kind: 'focus'; key: string }
  | { kind: 'toggleRow'; id: string; expanded: boolean }
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
  return node.id === null ? null : { kind: 'toggleRow', id: node.id, expanded };
}

// ---------------------------------------------------------------------------
// Order freezing (§2.2 rule 4, P0-4)
// ---------------------------------------------------------------------------

/** The row ids actually painted, per section — the key is the section's own (§5). */
export type PaintedOrder = Map<string, string[]>;

export function paintedOrderOf(state: PanelState): PaintedOrder {
  const order: PaintedOrder = new Map();
  for (const section of state.sections) {
    order.set(section.key, section.rows.map((row) => row.id));
  }
  return order;
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
    sections: next.sections.map((section) => {
      const prior = painted.get(section.key);
      if (prior === undefined) return section;
      const byId = new Map(section.rows.map((row) => [row.id, row]));
      const kept = prior.flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      });
      const added = section.rows.filter((row) => !prior.includes(row.id));
      return { ...section, rows: [...kept, ...added] };
    }),
  };
}
