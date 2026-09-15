/**
 * Phase 17 §2 — the part switcher: an ARIA `tablist` of the item's parts, one pane on screen.
 *
 * Why this and not the alternatives: a contents rail costs 44% of a 400px pane and restates the
 * findings table the review already prints; a `Jump to…` select hides the item's shape, so you
 * cannot see a QA report exists until you open the list. The switcher is the only option that
 * REMOVES content from the screen, which is the user's actual complaint.
 *
 * Keyboard: a roving `tabindex`, so the strip is one tab stop. Arrows move AND select, `Home` and
 * `End` jump to the ends, and `Enter`/`Space` are deliberately no-ops — arrow-select already
 * acted, and a second activation model would disagree with the first.
 *
 * Runs in a browser context (R40): no editor module, and no markup built from strings.
 */
import type { TabPart } from '../../model/item-tab-parts';
import { post } from './channel';
import { el, idPart, reconcile, setAttr, setClass, setId, setTabStop, setText } from './dom';

export const TAB_ID_PREFIX = 'part-tab-';

export function tabIdOf(key: string): string {
  return `${TAB_ID_PREFIX}${idPart(key)}`;
}

/** The index the arrows move from: the selected part, or the first one when none matched. */
function selectedIndex(parts: readonly TabPart[], selectedKey: string | null): number {
  const at = parts.findIndex((part) => part.key === selectedKey);
  return at < 0 ? 0 : at;
}

function select(parts: readonly TabPart[], at: number): void {
  const part = parts[at];
  if (part === undefined) return;
  post({ type: 'setFocus', focus: part.focus });
}

/**
 * The key handler, exported so the switcher's model is testable without a keyboard event.
 *
 * Returns the index it moved to, or `null` when the key means nothing here — the caller only
 * calls `preventDefault` on the former, so every other key keeps its native behaviour.
 */
export function targetOf(
  key: string,
  parts: readonly TabPart[],
  from: number,
): number | null {
  if (parts.length === 0) return null;
  if (key === 'ArrowRight') return from + 1 < parts.length ? from + 1 : null;
  if (key === 'ArrowLeft') return from - 1 >= 0 ? from - 1 : null;
  if (key === 'Home') return from === 0 ? null : 0;
  if (key === 'End') return from === parts.length - 1 ? null : parts.length - 1;
  return null;
}

export interface Switcher {
  node: HTMLElement;
  render: (parts: readonly TabPart[], selectedKey: string | null) => void;
}

export function createSwitcher(): Switcher {
  const node = el('div', 'part-switcher');
  node.setAttribute('role', 'tablist');
  node.setAttribute('aria-label', 'Parts of this item');
  let parts: readonly TabPart[] = [];
  let selectedKey: string | null = null;

  node.addEventListener('keydown', (event: KeyboardEvent) => {
    const at = targetOf(event.key, parts, selectedIndex(parts, selectedKey));
    if (at === null) return;
    event.preventDefault();
    // The caret follows immediately; the host's render confirms it a tick later.
    const part = parts[at];
    if (part !== undefined) document.getElementById(tabIdOf(part.key))?.focus();
    select(parts, at);
  });

  const create = (part: TabPart): HTMLElement => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => {
      const at = parts.findIndex((candidate) => candidate.key === part.key);
      select(parts, at);
    });
    return tab;
  };

  const patch = (tab: HTMLElement, part: TabPart): void => {
    const selected = part.key === selectedKey;
    setId(tab, tabIdOf(part.key));
    setText(tab, part.label);
    setClass(tab, selected ? 'part-tab selected' : 'part-tab');
    setAttr(tab, 'aria-selected', selected ? 'true' : 'false');
    setAttr(tab, 'aria-controls', 'item-pane');
    setTabStop(tab, selected);
  };

  return {
    node,
    render: (next, key) => {
      const moved = key !== selectedKey;
      parts = next;
      selectedKey = key;
      const tabs = reconcile(
        node,
        next.map((part) => ({ key: part.key, data: part })),
        create,
        patch,
      );
      // At 400px with six parts the selected tab can sit past the right edge, and an overlay
      // scrollbar gives no hint the strip runs on — so the strip is moved to it. Only on a CHANGE
      // of selection: a re-render must leave a hand-scrolled strip where the user put it.
      if (!moved) return;
      const at = next.findIndex((part) => part.key === key);
      tabs[at]?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    },
  };
}
