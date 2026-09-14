/**
 * A line of signals, as one element per signal (P0-3).
 *
 * The defect this replaces: the second line was joined into a sentence host-side and then clipped
 * after the author in a 300 px sidebar, so the age and the size — the two things the user decides
 * on — were the parts that disappeared. As cells, the `·` separators are CSS and the sidebar
 * truncates the LAST cell instead of the sentence. No cell carries a `title`: what was behind the
 * hover is either on the line now or gone (§3).
 *
 * Runs in a browser context (R40).
 */
import { el } from './dom';
import { reconcile, setAttr, setClass, setText } from './reconcile';
import type { RowMetaCell } from '../../model/panel-protocol';

export function patchCells(parent: HTMLElement, cells: readonly RowMetaCell[]): void {
  reconcile(
    parent,
    // A row can carry two cells of one kind (two PRs, two agents), so the position is part of
    // the key: without it the second one would be created and destroyed on every render.
    cells.map((cell, index) => ({ key: `${index}:${cell.kind}`, data: cell })),
    () => el('span'),
    (node, cell) => {
      setClass(node, `cell cell-${cell.kind}${cell.tone === undefined ? '' : ` tone-${cell.tone}`}`);
      setText(node, cell.text);
      // The accessible name, not a tooltip: a cell whose whole content is a coloured dot still
      // has to say what it means to a screen reader (§3).
      setAttr(node, 'aria-label', cell.label ?? null);
    },
  );
}
