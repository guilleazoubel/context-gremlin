/**
 * §2.2 rule 4 — "no re-sorting while the pointer is inside the list", as a pure function.
 *
 * The rule has two halves and it is the second that is easy to get wrong: the ORDER is frozen,
 * the CONTENT is not. A refresh that arrives while the cursor is over a row must still show that
 * a phase moved on; it may only not slide the row out from under the pointer. Both halves are
 * asserted here, with no DOM, so the webview's job is reduced to calling this.
 */
import { describe, expect, it } from 'vitest';
import { freezeOrder, paintedOrderOf } from '../../src/model/panel-tree';
import type { PanelRowView, PanelSectionView, PanelState } from '../../src/model/panel-protocol';
import type { ParkingLotGroup, WorkListKind } from '../../src/model/work-items';

/** Only the id and the label matter to ordering, so the rest of the row view is not invented. */
function row(id: string, label = id): PanelRowView {
  return { id, label } as PanelRowView;
}

function stateOf(
  sections: { group: ParkingLotGroup | null; rows: PanelRowView[] }[],
  kind: WorkListKind = 'parkingLot',
): PanelState {
  const views = sections.map(
    (section) =>
      ({
        key: section.group === null ? kind : `${kind}:${section.group}`,
        list: kind,
        group: section.group,
        count: section.rows.length,
        collapsed: false,
        rows: section.rows,
      }) as unknown as PanelSectionView,
  );
  return {
    sections: views,
    focus: 'all',
    focusOptions: [],
    needsYou: [],
    banner: null,
    trouble: null,
    notice: null,
    connected: true,
  };
}

describe('freezing the painted order (§2.2 rule 4)', () => {
  it('records the ids of every section, keyed by list and group', () => {
    const painted = paintedOrderOf(
      stateOf([
        { group: 'untouched', rows: [row('a'), row('b')] },
        { group: 'someoneOnIt', rows: [row('c')] },
      ]),
    );
    expect(painted.get('parkingLot:untouched')).toEqual(['a', 'b']);
    expect(painted.get('parkingLot:someoneOnIt')).toEqual(['c']);
  });

  it('keeps the sequence already on screen when the incoming one disagrees', () => {
    const painted = paintedOrderOf(stateOf([{ group: 'untouched', rows: [row('a'), row('b')] }]));
    const next = stateOf([{ group: 'untouched', rows: [row('b'), row('a')] }]);
    expect(frozenIds(freezeOrder(next, painted))).toEqual(['a', 'b']);
  });

  it('still lands the new CONTENT of a row whose position is frozen', () => {
    const painted = paintedOrderOf(stateOf([{ group: 'untouched', rows: [row('a'), row('b')] }]));
    const next = stateOf([
      { group: 'untouched', rows: [row('b', 'b reviewing'), row('a', 'a reviewing')] },
    ]);
    const frozen = freezeOrder(next, painted);
    expect(frozen.sections[0].rows.map((r) => r.label)).toEqual([
      'a reviewing',
      'b reviewing',
    ]);
  });

  it('drops a row that left and joins a new one at the end, in the incoming order', () => {
    const painted = paintedOrderOf(
      stateOf([{ group: 'untouched', rows: [row('a'), row('b'), row('c')] }]),
    );
    const next = stateOf([{ group: 'untouched', rows: [row('d'), row('c'), row('e'), row('a')] }]);
    expect(frozenIds(freezeOrder(next, painted))).toEqual(['a', 'c', 'd', 'e']);
  });

  it('leaves a section the pointer never saw exactly as it arrived', () => {
    const painted = paintedOrderOf(stateOf([{ group: 'untouched', rows: [row('a')] }]));
    const next = stateOf([
      { group: 'untouched', rows: [row('a')] },
      { group: 'reviewing', rows: [row('z'), row('y')] },
    ]);
    expect(freezeOrder(next, painted).sections[1].rows.map((r) => r.id)).toEqual([
      'z',
      'y',
    ]);
  });

  it('keys a groupless section apart from the parking lot, so the two never freeze each other', () => {
    const painted = paintedOrderOf(stateOf([{ group: null, rows: [row('a'), row('b')] }], 'myWork'));
    expect([...painted.keys()]).toEqual(['myWork']);
    const next = stateOf([{ group: null, rows: [row('b'), row('a')] }], 'parkingLot');
    expect(frozenIds(freezeOrder(next, painted))).toEqual(['b', 'a']);
  });
});

function frozenIds(state: PanelState): string[] {
  return state.sections[0].rows.map((r) => r.id);
}
