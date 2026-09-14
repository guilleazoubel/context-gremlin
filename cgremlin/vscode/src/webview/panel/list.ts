/**
 * One section: its header, its sort control, and the rows beneath it (§5, R66).
 *
 * §5 promoted the parking lot's three groups to sections, so there is exactly ONE header level
 * now — one sticky offset, one colour per section, one disclosure. The header is a real
 * `<button>`, so <kbd>Enter</kbd> and <kbd>Space</kbd> are the browser's and the tree's roles
 * stay clean: the rows it owns are its siblings, not its descendants.
 *
 * Every level here is reconciled by key, so the only nodes that ever move are the ones whose
 * position actually changed. A row and the block it opens into are siblings in the same sequence
 * — `row:…` followed by `expanded:row:…` — which is what keeps the tree's document order the same
 * as the order `panelTreeNodes` walks.
 *
 * Runs in a browser context (R40).
 */
import { button, el } from './dom';
import { createExpanded, expandedKey, patchExpanded } from './expanded';
import { reconcile, setAttr, setClass, setHidden, setText } from './reconcile';
import { child, createRow, patchRow, rowKey } from './row';
import { sectionClassOf } from '../../model/work-items';
import type { PanelRowView, PanelSectionView } from '../../model/panel-protocol';

const SORT_LABELS: Record<string, string> = {
  untouchedFirstThenOldest: 'untouched',
  oldest: 'oldest',
  newest: 'newest',
  smallestChange: 'smallest',
  needsYouThenRecent: 'needs you',
};

/** Down for open, right for shut. */
const OPEN = '▾';
const SHUT = '▸';

/** An empty section is an answer, not a gap (§6). */
const NOTHING = 'Nothing waiting for you';

export interface SectionContext {
  focusedKey: string | null;
  /** Told whenever the pointer enters or leaves a tree, so the order can be frozen (§2.2 rule 4). */
  onPointer: (inside: boolean) => void;
}

export function createSection(section: PanelSectionView, context: SectionContext): HTMLElement {
  const node = el('div', 'section');
  node.dataset.section = section.key;

  const bar = el('div', 'section-bar');
  const header = button({
    className: 'section-header',
    label: '',
    message: () => ({
      type: 'toggleSection',
      key: node.dataset.section ?? '',
      collapsed: header.getAttribute('aria-expanded') === 'true',
    }),
  });
  const chevron = el('span', 'section-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  header.appendChild(chevron);
  const glyph = el('span', 'section-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  header.appendChild(glyph);
  header.appendChild(el('span', 'section-title'));
  header.appendChild(el('span', 'section-count'));
  bar.appendChild(header);

  const sorts = el('div', 'sorts');
  sorts.setAttribute('role', 'group');
  bar.appendChild(sorts);
  node.appendChild(bar);

  node.appendChild(el('div', 'section-empty', NOTHING));

  const tree = el('div', 'tree');
  tree.setAttribute('role', 'tree');
  tree.addEventListener('pointerenter', () => context.onPointer(true));
  tree.addEventListener('pointerleave', () => context.onPointer(false));
  node.appendChild(tree);
  return node;
}

export function patchSection(
  node: HTMLElement,
  section: PanelSectionView,
  context: SectionContext,
): void {
  const accent = sectionClassOf(section.key);
  setClass(node, `section ${accent}`);
  const header = child(node, '.section-header');
  setClass(header, `section-header ${accent}`);
  setAttr(header, 'aria-expanded', String(!section.collapsed));
  setText(child(node, '.section-chevron'), section.collapsed ? SHUT : OPEN);
  setText(child(node, '.section-glyph'), section.glyph);
  setText(child(node, '.section-title'), section.title);
  setText(child(node, '.section-count'), String(section.count));
  setAttr(header, 'aria-label', `${section.title} (${section.count})`);

  const sorts = child(node, '.sorts');
  setAttr(sorts, 'aria-label', `Sort ${section.title}`);
  setHidden(sorts, section.collapsed);
  reconcile(
    sorts,
    section.collapsed ? [] : section.sorts.map((sort) => ({ key: sort, data: sort })),
    (sort) =>
      button({
        className: 'sort',
        label: SORT_LABELS[sort] ?? sort,
        message: () => ({ type: 'setSort', list: section.list, sort }),
      }),
    (item, sort) => {
      setClass(item, sort === section.sort ? 'sort selected' : 'sort');
      setAttr(item, 'aria-pressed', String(sort === section.sort));
    },
  );

  const rows = section.collapsed ? [] : section.rows;
  setHidden(child(node, '.section-empty'), section.collapsed || rows.length > 0);

  const tree = child(node, '.tree');
  setAttr(tree, 'aria-label', section.title);
  setHidden(tree, section.collapsed);
  reconcile(
    tree,
    rows.flatMap((row) => entriesOf(row, accent)),
    (entry) => (entry.kind === 'row' ? createRow(entry.row) : createExpanded()),
    (element, entry) => {
      if (entry.kind === 'row') patchRow(element, entry.row, entry.accent, context);
      else patchExpanded(element, entry.row, context.focusedKey);
    },
  );
}

interface Entry {
  kind: 'row' | 'expanded';
  row: PanelRowView;
  accent: string;
}

/** The row, then — only while it is open — the block it opens into, as its sibling. */
function entriesOf(row: PanelRowView, accent: string): { key: string; data: Entry }[] {
  const key = rowKey(row);
  const entries: { key: string; data: Entry }[] = [{ key, data: { kind: 'row', row, accent } }];
  if (row.expanded) {
    entries.push({ key: expandedKey(key), data: { kind: 'expanded', row, accent } });
  }
  return entries;
}
