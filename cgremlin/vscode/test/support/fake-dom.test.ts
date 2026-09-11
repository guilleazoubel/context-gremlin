/**
 * The instrumented DOM is itself the instrument, so its two load-bearing promises are asserted
 * here rather than assumed by every test that installs it:
 *  - **a write that changes nothing logs nothing** (otherwise "identical data mutates NOTHING"
 *    would pass on a reconciler that rewrites every leaf);
 *  - **a write that changes something logs exactly once** (otherwise the same test would pass on
 *    a reconciler that does nothing at all).
 */
import { describe, expect, it } from 'vitest';
import { FakeDocument, installDom } from './fake-dom';

describe('the fake DOM records only real changes', () => {
  it('logs a create, then nothing for an idempotent write', () => {
    const doc = new FakeDocument();
    const node = doc.createElement('div');
    expect(doc.log).toEqual([{ kind: 'create', tag: 'DIV', key: '' }]);
    doc.clearLog();

    node.className = 'row';
    node.textContent = 'hello';
    node.setAttribute('role', 'treeitem');
    node.tabIndex = 0;
    expect(doc.log.map((m) => m.kind)).toEqual(['class', 'text', 'attr', 'prop']);
    doc.clearLog();

    node.className = 'row';
    node.textContent = 'hello';
    node.setAttribute('role', 'treeitem');
    node.tabIndex = 0;
    expect(doc.log).toEqual([]);
  });

  it('logs one text write when the text actually changes', () => {
    const doc = new FakeDocument();
    const node = doc.createElement('span');
    node.textContent = 'coding';
    doc.clearLog();
    node.textContent = 'reviewing';
    expect(doc.log).toEqual([{ kind: 'text', tag: 'SPAN', key: '', detail: 'reviewing' }]);
  });

  it('does not log an insert that re-appends a child already in that position', () => {
    const doc = new FakeDocument();
    const parent = doc.createElement('div');
    const a = doc.createElement('span');
    const b = doc.createElement('span');
    parent.appendChild(a);
    parent.appendChild(b);
    doc.clearLog();

    parent.insertBefore(a, b);
    parent.appendChild(b);
    expect(doc.log).toEqual([]);
    expect(parent.children).toEqual([a, b]);
  });

  it('logs a move, and a removal, when the sequence really changes', () => {
    const doc = new FakeDocument();
    const parent = doc.createElement('div');
    const a = doc.createElement('span');
    const b = doc.createElement('span');
    parent.appendChild(a);
    parent.appendChild(b);
    doc.clearLog();

    parent.insertBefore(b, a);
    expect(parent.children).toEqual([b, a]);
    expect(doc.log.map((m) => m.kind)).toEqual(['insert']);

    doc.clearLog();
    parent.removeChild(a);
    expect(doc.log.map((m) => m.kind)).toEqual(['remove']);
    expect(a.parentNode).toBeNull();
  });

  it('reads text back through the children, and finds nodes by class', () => {
    const doc = new FakeDocument();
    const row = doc.createElement('div');
    const label = doc.createElement('span');
    label.className = 'row-label cell';
    label.textContent = 'HB-627';
    row.appendChild(label);
    expect(row.textContent).toBe('HB-627');
    expect(row.byClass('cell')).toEqual([label]);
    expect(row.byClass('row')).toEqual([]);
  });

  it('installs globals a webview bundle can load against, and takes them back', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const before = globals.document;
    const dom = installDom();
    expect(globals.document).toBe(dom.document);
    expect(dom.document.getElementById('cgremlin-panel')).toBe(dom.root);

    const received: unknown[] = [];
    (globals.window as { addEventListener(t: string, h: (e: unknown) => void): void }).addEventListener(
      'message',
      (event) => received.push(event),
    );
    dom.send({ type: 'render' });
    expect(received).toEqual([{ data: { type: 'render' } }]);

    dom.uninstall();
    expect(globals.document).toBe(before);
  });
});
