/**
 * The title the USER writes for an item (item 1).
 *
 * The derived description (`descriptionOf`) answers "what is this" only as well as its sources do,
 * and the user asked to be able to name a row himself. That name is *his*, not the engine's, so it
 * lives in the host's `globalState` rather than on the wire — the core has no field for it and
 * inventing one would make the panel a writer of work items.
 *
 * It is keyed by the item's id **and by every ref the item answers to**. An id is a shape:
 * `pr:acme/web#101` becomes `ticket:HB-627` the moment the scan links the PR to a ticket, and a
 * title that disappeared at that moment would fail exactly when the row starts mattering. Every
 * key is written, and the first one that answers is read — so linking, splitting or re-keying an
 * item all keep the name the user gave it.
 *
 * Pure module — the store is the same narrow two-member slice the sorts persist through (R64).
 */
import type { WorkItem } from './work-items';

export const TITLE_STATE_PREFIX = 'cgremlin.itemTitle.';

export interface TitleStore {
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): unknown;
}

export function titleStateKey(ref: string): string {
  return `${TITLE_STATE_PREFIX}${ref}`;
}

/**
 * Every name this item answers to, most specific first: its id, its ticket, each PR, each session,
 * and finally whatever the attention refs carry that those four did not already name.
 */
export function titleKeysOf(item: WorkItem): string[] {
  const keys = [item.id];
  if (item.ticket !== null) keys.push(`ticket:${item.ticket.key}`);
  for (const pr of item.prs) keys.push(`pr:${pr.repo}#${pr.number}`);
  for (const agent of item.agents) keys.push(`session:${agent.sessionId}`);
  for (const ref of item.attention.refs) if (typeof ref === 'string') keys.push(ref);
  return [...new Set(keys)];
}

/**
 * The user's title, or empty when he has not written one. A stored value that is not a string —
 * a hand-edited `globalState`, a shape from an older build — reads as "no override" rather than
 * being rendered as whatever it is.
 */
export function readTitle(store: TitleStore, item: WorkItem): string {
  for (const key of titleKeysOf(item)) {
    const stored = store.getState<unknown>(titleStateKey(key));
    if (typeof stored === 'string' && stored.trim() !== '') return stored.trim();
  }
  return '';
}

/** Writes (or, for an empty input, clears) the override under **every** key the item answers to. */
export function writeTitle(store: TitleStore, item: WorkItem, title: string): void {
  const text = title.trim();
  for (const key of titleKeysOf(item)) {
    store.setState(titleStateKey(key), text === '' ? undefined : text);
  }
}
