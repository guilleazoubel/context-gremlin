/**
 * §6 — the one control that narrows the panel to a single area.
 *
 * A native `<select>`, and deliberately so. Segmented tabs do not fit seven targets in a 300 px
 * sidebar; chips wrap to three rows, which is the clutter this phase removes. A select is one
 * line at any width, the platform gives it keyboard and screen-reader behaviour for free, and it
 * opens no popup of our own — the user is removing popups, not adding one.
 *
 * It is the panel's FIRST tab stop, and it sits outside the tree: the tree's roving stop is the
 * second, and `keyboard.ts` ignores keys while the caret is on a control.
 *
 * Runs in a browser context (R40).
 */
import { post } from './channel';
import { reconcile, setAttr, setText } from './reconcile';
import type { PanelFocusOption } from '../../model/panel-protocol';

export function createFocus(): HTMLElement {
  const node = document.createElement('select');
  node.className = 'focus';
  node.setAttribute('aria-label', 'Narrow the panel to one area');
  node.addEventListener('change', (event: Event) => {
    const target = event.target as { value?: string } | null;
    post({ type: 'setFocus', focus: target?.value ?? 'all' });
  });
  return node;
}

export function patchFocus(
  node: HTMLElement,
  options: readonly PanelFocusOption[],
  focus: string,
): void {
  reconcile(
    node,
    options.map((option) => ({ key: option.key, data: option })),
    () => document.createElement('option'),
    (item, option) => {
      setAttr(item, 'value', option.key);
      setText(item, `${option.title} (${option.count})`);
      // The selection is an ATTRIBUTE as well as a property: the attribute is what a re-render
      // reconciles against, and the property is what the browser actually shows.
      setAttr(item, 'selected', option.key === focus ? 'true' : null);
    },
  );
  const select = node as unknown as { value?: string };
  if (select.value !== focus) select.value = focus;
}
