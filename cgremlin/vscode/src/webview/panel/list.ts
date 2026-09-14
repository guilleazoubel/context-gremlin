/**
 * One list: its header, its sort control, and the tree of sections beneath it (R47, R66).
 *
 * Every level here is reconciled by key, so the only nodes that ever move are the ones whose
 * position actually changed. A row and the block it opens into are siblings in the same sequence
 * — `row:…` followed by `expanded:row:…` — which is what keeps the tree's document order the same
 * as the order `panelTreeNodes` walks.
 *
 * P2: both header levels are disclosures. The list's own is a real `<button>`, so
 * <kbd>Enter</kbd> and <kbd>Space</kbd> are the browser's and the tree's roles stay clean — the
 * tree it owns is a sibling of the button, not a descendant of it. A group's header stays a
 * `treeitem`, which is what the keyboard model already navigates. Neither one ever hides rows in
 * silence: the chevron says which way it is, and the count says how much is behind it.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { button, el } from './dom';
import { createExpanded, expandedKey, patchExpanded } from './expanded';
import { reconcile, setAttr, setClass, setHidden, setTabStop, setText } from './reconcile';
import { child, createRow, patchRow, rowKey } from './row';
import type {
  PanelListView,
  PanelRowView,
  PanelSectionView,
} from '../../model/panel-protocol';

const SORT_LABELS: Record<string, string> = {
  untouchedFirstThenOldest: 'untouched',
  oldest: 'oldest',
  newest: 'newest',
  smallestChange: 'smallest',
  needsYouThenRecent: 'needs you',
};

/** Down for open, right for shut — the twisty a row already uses, one level up. */
const OPEN = '▾';
const SHUT = '▸';

/** An empty list is an answer, not a gap (P2). */
const NOTHING = 'Nothing waiting for you';

export interface ListContext {
  focusedKey: string | null;
  /** Told whenever the pointer enters or leaves a tree, so the order can be frozen (§2.2 rule 4). */
  onPointer: (inside: boolean) => void;
}

export function createList(list: PanelListView, context: ListContext): HTMLElement {
  const node = el('div', 'list');
  node.dataset.kind = list.kind;

  const header = el('div', 'list-header');
  const toggle = button({
    className: 'list-toggle',
    label: '',
    message: () => ({
      type: 'toggleList',
      list: node.dataset.kind ?? '',
      collapsed: toggle.getAttribute('aria-expanded') === 'true',
    }),
  });
  toggle.appendChild(el('span', 'list-chevron'));
  const glyph = el('span', 'list-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  toggle.appendChild(glyph);
  toggle.appendChild(el('span', 'list-title'));
  toggle.appendChild(el('span', 'list-count'));
  header.appendChild(toggle);

  const sorts = el('div', 'sorts');
  sorts.setAttribute('role', 'group');
  header.appendChild(sorts);
  node.appendChild(header);

  node.appendChild(el('div', 'list-empty', NOTHING));

  const tree = el('div', 'tree');
  tree.setAttribute('role', 'tree');
  tree.addEventListener('pointerenter', () => context.onPointer(true));
  tree.addEventListener('pointerleave', () => context.onPointer(false));
  node.appendChild(tree);
  return node;
}

export function patchList(node: HTMLElement, list: PanelListView, context: ListContext): void {
  const toggle = child(node, '.list-toggle');
  setAttr(toggle, 'aria-expanded', String(!list.collapsed));
  setText(child(node, '.list-chevron'), list.collapsed ? SHUT : OPEN);
  setText(child(node, '.list-glyph'), list.glyph);
  setText(child(node, '.list-title'), list.title);
  setText(child(node, '.list-count'), String(list.count));
  setAttr(toggle, 'aria-label', `${list.title} (${list.count})`);

  const sorts = child(node, '.sorts');
  setAttr(sorts, 'aria-label', `Sort ${list.title}`);
  setHidden(sorts, list.collapsed);
  reconcile(
    sorts,
    list.collapsed ? [] : list.sorts.map((sort) => ({ key: sort, data: sort })),
    (sort) =>
      button({
        className: 'sort',
        label: SORT_LABELS[sort] ?? sort,
        message: () => ({ type: 'setSort', list: list.kind, sort }),
      }),
    (item, sort) => {
      setClass(item, sort === list.sort ? 'sort selected' : 'sort');
      setAttr(item, 'aria-pressed', String(sort === list.sort));
    },
  );

  // A group that holds nothing is not a thing to expand, so it is not drawn at all — the same
  // sequence `panelTreeNodes` walks (R66).
  const sections = list.collapsed
    ? []
    : list.sections.filter((section) => section.group === null || section.count > 0);
  const rows = sections.reduce((total, section) => total + section.rows.length, 0);
  setHidden(child(node, '.list-empty'), list.collapsed || rows > 0);

  const tree = child(node, '.tree');
  setAttr(tree, 'aria-label', list.title);
  setHidden(tree, list.collapsed);
  reconcile(
    tree,
    sections.map((section) => ({
      key: `section:${list.kind}:${section.group ?? ''}`,
      data: section,
    })),
    (section) => createSection(list, section),
    (sectionNode, section) => patchSection(sectionNode, list, section, context),
  );
}

function createSection(list: PanelListView, section: PanelSectionView): HTMLElement {
  const node = el('div', 'section');
  const header = el('div', 'section-header');
  header.setAttribute('role', 'treeitem');
  header.setAttribute('aria-level', '1');
  const chevron = el('span', 'section-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  header.appendChild(chevron);
  header.appendChild(el('span', 'section-title'));
  header.appendChild(el('span', 'section-count'));
  if (section.group !== null && section.collapsible) {
    header.dataset.key = `group:${list.kind}:${section.group}`;
    const group = section.group;
    header.addEventListener('click', () => {
      post({
        type: 'toggleGroup',
        list: list.kind,
        group,
        collapsed: header.getAttribute('aria-expanded') === 'true',
      });
    });
  }
  node.appendChild(header);
  node.appendChild(el('div', 'section-rows'));
  return node;
}

function patchSection(
  node: HTMLElement,
  list: PanelListView,
  section: PanelSectionView,
  context: ListContext,
): void {
  const header = child(node, '.section-header');
  setHidden(header, section.group === null);
  setText(child(node, '.section-title'), section.title);
  setText(child(node, '.section-count'), String(section.count));
  setAttr(header, 'aria-label', `${section.title} (${section.count})`);
  // A group that cannot be closed carries no chevron: an affordance that does nothing is worse
  // than none, and those two groups are always open.
  setText(
    child(node, '.section-chevron'),
    section.collapsible ? (section.collapsed ? SHUT : OPEN) : '',
  );
  setClass(header, section.collapsible ? 'section-header collapsible' : 'section-header');
  if (section.collapsible) {
    setAttr(header, 'aria-expanded', String(!section.collapsed));
    setAttr(header, 'aria-selected', String(context.focusedKey === header.dataset.key));
    setTabStop(header, context.focusedKey === header.dataset.key);
  }
  // A collapsed group contributes its header and nothing else — the same sequence the tree model
  // walks, so the roles and the keyboard cannot disagree (R66).
  const rows = section.collapsed ? [] : section.rows;
  reconcile(
    child(node, '.section-rows'),
    rows.flatMap((row) => entriesOf(row)),
    (entry) => (entry.kind === 'row' ? createRow(entry.row) : createExpanded()),
    (element, entry) => {
      if (entry.kind === 'row') patchRow(element, entry.row, context);
      else patchExpanded(element, entry.row, context.focusedKey);
    },
  );
}

interface Entry {
  kind: 'row' | 'expanded';
  row: PanelRowView;
}

/** The row, then — only while it is open — the block it opens into, as its sibling. */
function entriesOf(row: PanelRowView): { key: string; data: Entry }[] {
  const key = rowKey(row);
  const entries: { key: string; data: Entry }[] = [{ key, data: { kind: 'row', row } }];
  if (row.expanded) entries.push({ key: expandedKey(key), data: { kind: 'expanded', row } });
  return entries;
}
