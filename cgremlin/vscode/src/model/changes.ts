/**
 * "Changes so far" — `GET /sessions/<id>/changes`, mirrored and summarised (§4, amended).
 *
 * The expanded row answers "how big is this, right now?" with two numbers: what the session has
 * committed, and what is still only in its working tree. Both come from one engine route.
 *
 * The parse is **defensive on purpose**. This is the one route the extension reads that an engine
 * older than Phase 10 does not serve at all, and the row must then say `—` rather than render a
 * fabricated zero (MG-12) or throw inside a render. So anything that is not the shape below
 * collapses to `null` and the row shows the placeholder.
 *
 * Pure module — no editor API (MG-B1).
 */

export interface ChangeSet {
  files: number | null;
  additions: number | null;
  deletions: number | null;
}

export interface SessionChanges {
  base: string | null;
  /**
   * The engine's own `baseResolved` is a BOOLEAN, not a sha: it says whether `git merge-base
   * <base> HEAD` resolved in that worktree, and `false` means the committed counts come from a
   * plain three-dot diff against `base` instead. Anything that is not a boolean is `null` —
   * "the engine did not say" — so an older engine is never read as `false`.
   */
  baseResolved: boolean | null;
  head: string | null;
  committed: ChangeSet;
  workingTree: ChangeSet;
}

/** The `—` every unknown field renders as, so the placeholder is written once (MG-12). */
export const UNKNOWN = '—';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function changeSet(value: unknown): ChangeSet {
  const body = record(value);
  if (body === null) return { files: null, additions: null, deletions: null };
  // `entries[]` is on the wire and deliberately not read: an unbounded file list does not belong
  // in a 300 px sidebar, and `files` already answers the question the row asks.
  return {
    files: count(body.files) ?? (Array.isArray(body.entries) ? body.entries.length : null),
    additions: count(body.additions),
    deletions: count(body.deletions),
  };
}

export function parseChanges(raw: unknown): SessionChanges | null {
  const body = record(raw);
  if (body === null) return null;
  if (body.committed === undefined && body.workingTree === undefined) return null;
  return {
    base: text(body.base),
    baseResolved: flag(body.baseResolved),
    head: text(body.head),
    committed: changeSet(body.committed),
    workingTree: changeSet(body.workingTree),
  };
}

/**
 * `8 files +240/−31`, the same wording as a PR row's size cell, and `—` when the engine knows of
 * no change at all. A set with a file count but no line counts says the count alone.
 */
export function changeSummary(set: ChangeSet | null | undefined): string {
  if (set === undefined || set === null || set.files === null) return UNKNOWN;
  const files = `${set.files} ${set.files === 1 ? 'file' : 'files'}`;
  if (set.additions === null && set.deletions === null) return files;
  return `${files} +${set.additions ?? 0}/−${set.deletions ?? 0}`;
}
