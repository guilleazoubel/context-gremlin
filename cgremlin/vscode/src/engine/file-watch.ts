/**
 * Watching one file that is replaced rather than written.
 *
 * Pure module — Node stdlib only, and no mention of the editor API (R30).
 *
 * The engine writes `core.json` the safe way: a temp file, `chmod 0600`, then a rename over the
 * target. A watch on the file itself follows the *inode*, so the very first save from the engine's
 * own `config init` would orphan it. Watching the directory and filtering by basename survives
 * that, and is the only reason "restart on save" keeps working past the first save.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface WatchHandle {
  dispose(): void;
}

export function watchFileByRename(filePath: string, callback: () => void): WatchHandle {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_event, changed) => {
      // A rename reports the *new* name; some platforms report null, in which case the only safe
      // reading is "something in this directory changed".
      if (changed === null || changed === undefined || changed === name) callback();
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
