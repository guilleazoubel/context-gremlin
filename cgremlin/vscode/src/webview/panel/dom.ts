/**
 * The four constructors the panel builds everything out of.
 *
 * Nothing here composes markup from strings: a PR title carrying `<script>` reaches the DOM
 * through `textContent` and is inert by construction (MG-B7), and there is no `innerHTML` in the
 * whole bundle to regress that.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A glyph that is unicode, sized and aligned by CSS — never an icon font (R38, §2.2 rule 11). */
export function glyph(text: string): HTMLElement {
  const node = el('span', 'glyph', text);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export interface ButtonSpec {
  className: string;
  label: string;
  /** What to post. Built at click time, so a patched button sends the row's CURRENT identity. */
  message: () => unknown;
}

/**
 * A button that does not also trigger the row it sits in. Every one of these is ≥ 24 px by the
 * stylesheet (§2.2 rule 2); the stopPropagation is what stops "clicking Start review" from also
 * selecting the row and swapping the workspace.
 */
export function button(spec: ButtonSpec): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = spec.className;
  node.type = 'button';
  node.textContent = spec.label;
  node.addEventListener('click', (event: Event) => {
    event.stopPropagation();
    post(spec.message());
  });
  return node;
}
