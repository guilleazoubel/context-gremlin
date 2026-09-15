/**
 * The item tab's constructors and its guarded setters.
 *
 * Phase 17 rebuilds the tab around keyed reconciliation, so the rule from `panel/reconcile`
 * applies here too: **a write that changes nothing is not performed**. The real DOM does not
 * deduplicate — re-assigning the same string to `textContent` still tears down the text node,
 * collapsing a selection and cancelling an IME composition — so every setter compares first.
 *
 * Runs in a browser context (R40).
 */
export { reconcile, setAttr, setClass, setHidden, setTabStop, setText } from '../panel/reconcile';

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setId(node: HTMLElement, id: string): void {
  if (node.id !== id) node.id = id;
}

export function setDisabled(node: HTMLButtonElement, disabled: boolean): void {
  if (node.disabled !== disabled) node.disabled = disabled;
}

/**
 * The bundle's ONE `innerHTML` sink (MG-B7), guarded like every other setter.
 *
 * Only ever called with markdown-it's output, which is built with `html: false` — raw HTML in an
 * artifact renders as the characters of that HTML (R40). Nothing else may call it.
 */
export function setHtml(node: HTMLElement, html: string): void {
  if (node.innerHTML === html) return;
  node.innerHTML = html; // SAFE_HTML: markdown-it, html:false (R40)
}

/** An id fragment safe to put in an attribute and to compare — the part keys carry `/` and `#`. */
export function idPart(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-');
}
