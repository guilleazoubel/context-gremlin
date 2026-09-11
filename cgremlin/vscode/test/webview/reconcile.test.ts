/**
 * P0-4's machinery, asserted on its own before anything is built on it.
 *
 * Every claim here is about MUTATIONS, not about markup: the instrumented DOM logs a write only
 * when the write changes something, so "identical input logs nothing" is a real statement about
 * what the browser would have had to do.
 */
import { describe, expect, it } from 'vitest';
import {
  reconcile,
  setAttr,
  setClass,
  setHidden,
  setTabStop,
  setText,
  setTitle,
} from '../../src/webview/panel/reconcile';
import { FakeDocument, type FakeElement } from '../support/fake-dom';

function fixture(): { doc: FakeDocument; parent: FakeElement } {
  const doc = new FakeDocument();
  const parent = doc.createElement('div');
  doc.clearLog();
  return { doc, parent };
}

/** `reconcile` is typed against the browser DOM; the fake stands in for it at runtime. */
function apply(doc: FakeDocument, parent: FakeElement, keys: readonly string[]): void {
  reconcile(
    parent as unknown as Element,
    keys.map((key) => ({ key, data: key })),
    (data) => {
      const node = doc.createElement('div');
      node.dataset.key = data;
      node.textContent = data;
      return node as unknown as HTMLElement;
    },
    (node, data) => setText(node, data),
  );
}

const keysOf = (parent: FakeElement): string[] => parent.children.map((c) => c.dataset.key ?? '');

describe('the setters refuse a write that changes nothing', () => {
  it('writes once, then never again for the same value', () => {
    const { doc, parent } = fixture();
    for (let i = 0; i < 2; i += 1) {
      setText(parent as unknown as HTMLElement, 'coding');
      setClass(parent as unknown as HTMLElement, 'row needs-you');
      setAttr(parent as unknown as HTMLElement, 'aria-level', '1');
      setTabStop(parent as unknown as HTMLElement, true);
      setTitle(parent as unknown as HTMLElement, '2026-09-01T00:00:00Z');
      setHidden(parent as unknown as HTMLElement, true);
    }
    expect(doc.log.map((m) => m.kind)).toEqual(['text', 'class', 'attr', 'prop', 'prop', 'prop']);
    // Six writes, not twelve: the second pass through the loop assigned nothing at all.
    expect(doc.writes).toHaveLength(6);
  });

  it('removes an attribute only when it is there', () => {
    const { doc, parent } = fixture();
    setAttr(parent as unknown as HTMLElement, 'aria-expanded', null);
    expect(doc.log).toEqual([]);
    setAttr(parent as unknown as HTMLElement, 'aria-expanded', 'true');
    setAttr(parent as unknown as HTMLElement, 'aria-expanded', null);
    expect(doc.log.map((m) => m.detail)).toEqual(['aria-expanded=true', '-aria-expanded']);
    expect(parent.getAttribute('aria-expanded')).toBeNull();
  });
});

describe('reconcile keeps nodes alive across renders', () => {
  it('creates each key once and mutates nothing when the input repeats', () => {
    const { doc, parent } = fixture();
    apply(doc, parent, ['a', 'b', 'c']);
    const before = [...parent.children];
    doc.clearLog();

    apply(doc, parent, ['a', 'b', 'c']);
    expect(doc.log).toEqual([]);
    // The setters are the only thing standing between this and a full rebuild, so the ASSIGNMENT
    // ledger is asserted too — `log` alone would pass on `node.textContent = text` unguarded.
    expect(doc.writes).toEqual([]);
    expect(parent.children).toEqual(before);
  });

  it('inserts only what appeared and removes only what left', () => {
    const { doc, parent } = fixture();
    apply(doc, parent, ['a', 'b', 'c']);
    const survivor = parent.children[0];
    doc.clearLog();

    apply(doc, parent, ['a', 'd']);
    expect(keysOf(parent)).toEqual(['a', 'd']);
    expect(doc.log.filter((m) => m.kind === 'remove')).toHaveLength(2);
    expect(doc.log.filter((m) => m.kind === 'create')).toHaveLength(1);
    expect(parent.children[0]).toBe(survivor);
  });

  it('moves the surviving nodes rather than rebuilding them on a reorder', () => {
    const { doc, parent } = fixture();
    apply(doc, parent, ['a', 'b', 'c']);
    const [a, b, c] = parent.children;
    doc.clearLog();

    apply(doc, parent, ['c', 'a', 'b']);
    expect(parent.children).toEqual([c, a, b]);
    expect(doc.log.filter((m) => m.kind === 'create')).toEqual([]);
    expect(doc.log.filter((m) => m.kind === 'text')).toEqual([]);
  });

  it('patches a surviving node in place and leaves its neighbours alone', () => {
    const { doc, parent } = fixture();
    apply(doc, parent, ['a', 'b']);
    const [a, b] = parent.children;
    doc.clearLog();

    reconcile(
      parent as unknown as Element,
      [
        { key: 'a', data: 'a' },
        { key: 'b', data: 'b reviewing' },
      ],
      () => {
        throw new Error('nothing should be created');
      },
      (node, data) => setText(node, data),
    );
    expect(doc.log).toEqual([{ kind: 'text', tag: 'DIV', key: 'b', detail: 'b reviewing' }]);
    expect(parent.children).toEqual([a, b]);
  });

  it('gives each parent its own index, so two lists never steal one another’s nodes', () => {
    const { doc, parent } = fixture();
    const other = doc.createElement('div');
    apply(doc, parent, ['a']);
    apply(doc, other, ['a']);
    expect(parent.children).toHaveLength(1);
    expect(other.children).toHaveLength(1);
    expect(parent.children[0]).not.toBe(other.children[0]);
  });

  it('empties a parent whose every key is gone, without creating anything', () => {
    const { doc, parent } = fixture();
    apply(doc, parent, ['a', 'b']);
    doc.clearLog();
    apply(doc, parent, []);
    expect(parent.children).toEqual([]);
    expect(doc.log.filter((m) => m.kind === 'create')).toEqual([]);
  });
});
