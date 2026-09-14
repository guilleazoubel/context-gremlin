/**
 * Keyed diff and patch — the whole of P0-4's machinery, in one place (§3.3).
 *
 * The defect this replaces is one line: `container.textContent = ''` followed by a full rebuild
 * on every render. That is why the row under the cursor lost `:hover` mid-click, why focus
 * jumped, and why the scroll position moved during a background refresh.
 *
 * Two rules, and every helper here exists to hold one of them:
 *  - **a write that changes nothing is not performed.** The real DOM does not deduplicate:
 *    assigning the same string to `textContent` still tears down and rebuilds the text node, which
 *    collapses a selection and cancels an IME composition. So every setter compares first.
 *  - **a node survives as long as its key does.** Rows are matched by key, not by position, so a
 *    reorder moves nodes and an unchanged sequence moves nothing.
 *
 * Runs in a browser context (R40): the DOM only, no editor module, no Node.
 */

/** The per-parent key→node index. A `WeakMap` so a detached subtree's cache goes with it. */
const CACHES = new WeakMap<Element, Map<string, HTMLElement>>();

function cacheOf(parent: Element): Map<string, HTMLElement> {
  let cache = CACHES.get(parent);
  if (cache === undefined) {
    cache = new Map<string, HTMLElement>();
    CACHES.set(parent, cache);
  }
  return cache;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, className: string): void {
  if (node.className !== className) node.className = className;
}

/** `null` removes the attribute — an `aria-expanded` on a row that stopped having children. */
export function setAttr(node: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    if (node.getAttribute(name) !== null) node.removeAttribute(name);
    return;
  }
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** The roving tab stop (R66): exactly one node in the tree is reachable by <kbd>Tab</kbd>. */
export function setTabStop(node: HTMLElement, focused: boolean): void {
  const value = focused ? 0 : -1;
  if (node.tabIndex !== value) node.tabIndex = value;
}

/**
 * §2.2 rule 1: `hidden`, never `display`. A block that enters the flow when it appears
 * changes the row's height, which is the layout shift P0-4 is about.
 */
export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export interface Keyed<T> {
  key: string;
  data: T;
}

/**
 * Makes `parent`'s element children be exactly `items`, in that order, reusing by key.
 *
 * `create` is called only for a key that is new; `patch` is called for every item, new or not,
 * and is where a surviving node's changed leaves are written. Nodes whose keys are gone are
 * removed. Ordering is settled by comparing each position against the node that is already
 * there, so an unchanged sequence performs no insertion at all.
 */
export function reconcile<T>(
  parent: Element,
  items: readonly Keyed<T>[],
  create: (data: T, key: string) => HTMLElement,
  patch: (node: HTMLElement, data: T, key: string) => void,
): HTMLElement[] {
  const cache = cacheOf(parent);
  const wanted = new Set(items.map((item) => item.key));
  for (const [key, node] of [...cache]) {
    if (wanted.has(key)) continue;
    node.parentNode?.removeChild(node);
    cache.delete(key);
  }

  const out: HTMLElement[] = [];
  items.forEach((item, index) => {
    let node = cache.get(item.key);
    if (node === undefined) {
      node = create(item.data, item.key);
      cache.set(item.key, node);
    }
    patch(node, item.data, item.key);
    if (parent.childNodes[index] !== node) {
      parent.insertBefore(node, parent.childNodes[index] ?? null);
    }
    out.push(node);
  });
  return out;
}
