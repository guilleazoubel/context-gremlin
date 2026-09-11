/**
 * Watching one file that is replaced rather than written.
 *
 * Pure module — Node stdlib only, and no mention of the editor API (R30).
 *
 * The engine writes `core.json` the safe way: a temp file, `chmod 0600`, then a rename over the
 * target. A watch on the file itself follows the *inode*, so the very first save from the engine's
 * own `config init` would orphan it. Watching the directory and filtering by basename survives
 * that, and is the only reason "restart on save" keeps working past the first save.
 *
 * What the callback means is the part worth being exact about: it is a **re-check**, not a change
 * notification. The platform reports events, not changes — a `chmod` of the watched file is an
 * event for it on macOS, an event may carry no filename at all, and a directory-level one is
 * named after the directory — so the callback's only promise is "something may have happened to
 * this file; go and look". The caller answers with a digest of the bytes (`ui/engine.ts`), which
 * is what keeps a mode-only touch from being read as a save.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface WatchHandle {
  dispose(): void;
}

/**
 * Does this directory event call for a look at the watched file?
 *
 * Only an event that names some *other* entry is dropped. An event with no filename, and the
 * directory-level one macOS names after the directory itself, both say "something in here
 * happened" without saying what — and since the callback is a re-check rather than a change
 * notification, routing those through costs one digest and guessing wrong costs a missed save.
 */
export function needsRecheck(
  changed: string | null | undefined,
  name: string,
  dirName: string,
): boolean {
  if (changed === null || changed === undefined) return true;
  return changed === name || changed === dirName;
}

export function watchFileByRename(filePath: string, callback: () => void): WatchHandle {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const dirName = path.basename(dir);
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_event, changed) => {
      if (needsRecheck(changed, name, dirName)) callback();
    });
  } catch {
    // A directory that is not there yet, or a filesystem with no watch support: the caller keeps
    // working, it just does not get told about saves.
    watcher = null;
  }
  return {
    dispose(): void {
      watcher?.close();
      watcher = null;
    },
  };
}
