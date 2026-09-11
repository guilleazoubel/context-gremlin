/**
 * The `⋯` popover: at most one open, and dismissible the three ways a popover has to be.
 *
 * The defect this fixes: the menu only closed when its own trigger was clicked again. Escape did
 * nothing, a click on the row behind it selected that row *through* the open menu — swapping the
 * workspace by accident — and scrolling left it floating over a row it no longer belonged to.
 *
 * Which open menu there is lives here rather than on the row, because "at most one" is a fact
 * about the panel and not about any row: a second trigger has to close the first, and a document
 * listener has to be able to close whichever one it is.
 *
 * Runs in a browser context (R40).
 */
import { setHidden } from './reconcile';

let open: { menu: HTMLElement; trigger: HTMLElement } | null = null;
let installed = false;

export function toggleOverflow(menu: HTMLElement, trigger: HTMLElement): void {
  if (open?.menu === menu) {
    closeOverflow(true);
    return;
  }
  closeOverflow(false);
  open = { menu, trigger };
  setHidden(menu, false);
}

/**
 * `returnFocus` is for the dismissals the user made deliberately — Escape, or the trigger again —
 * where leaving the caret on a hidden node would strand the keyboard. A click elsewhere and a
 * scroll are already taking focus somewhere the user chose, so they must not move it back.
 */
export function closeOverflow(returnFocus: boolean): void {
  if (open === null) return;
  const { menu, trigger } = open;
  open = null;
  setHidden(menu, true);
  if (returnFocus) trigger.focus();
}

/** Called when a row's menu is emptied or rebuilt, so a stale node is never "the open one". */
export function forgetOverflow(menu: HTMLElement): void {
  if (open?.menu === menu) closeOverflow(false);
}

export function installOverflowDismissal(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || open === null) return;
    event.preventDefault();
    closeOverflow(true);
  });
  document.addEventListener('pointerdown', (event: Event) => {
    if (open === null) return;
    const target = event.target;
    if (within(target, open.menu) || within(target, open.trigger)) return;
    closeOverflow(false);
  });
}

/** The list scrolls under the popover, which is positioned against a row that just moved. */
export function dismissOnScroll(node: HTMLElement): void {
  node.addEventListener('scroll', () => closeOverflow(false));
}

/**
 * `Node.contains` deliberately not used: this runs against a stand-in DOM too, and a walk up
 * `parentNode` is the part both have.
 */
function within(target: unknown, node: HTMLElement): boolean {
  let at = target as { parentNode?: unknown } | null;
  while (at !== null && at !== undefined) {
    if (at === node) return true;
    at = (at.parentNode ?? null) as { parentNode?: unknown } | null;
  }
  return false;
}
