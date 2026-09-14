import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { ItemRef } from './item-ref';
import type { WorkItemId } from '../work/work-item-id';

export interface DismissEntry {
  /** When the user dismissed it — what `dismissed` is ordered by, newest first. */
  dismissedAt: string;
  /**
   * Every `attention.refs` the item carried AT DISMISSAL TIME. A work item's
   * id is derived (`pr:o/r#12` becomes `ticket:HB-999` the moment the PR is
   * recognised as mine AND linked to a ticket), so an id-only key would
   * silently un-dismiss the row the user just hid. The refs are stable —
   * they name the SOURCE rows, not the grouping — so an item is dismissed
   * when its id matches OR when any stored ref is still one of its refs.
   */
  refs: ItemRef[];
}

export type DismissMap = Record<WorkItemId, DismissEntry>;

const DismissMapSchema = z.record(
  z.string(),
  z.object({ dismissedAt: z.string(), refs: z.array(z.string()) }),
);

/** Engine state, never world-readable — the same posture as `attention-acks.json`. */
const DISMISS_FILE_MODE = 0o600;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * "I don't care about this one right now", persisted in the state dir so it
 * is shared by every window and survives a reinstall — the same store shape
 * as `AckStore` (R10): tmp-then-rename, 0600, and a malformed file is simply
 * "nothing dismissed" rather than a read that throws.
 *
 * A dismissal is never "hide a thing that needs me": `WorkItemService`
 * auto-undismisses an item whose `needsYou` turns true.
 */
export class DismissStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  /** Never throws: a missing or unreadable store is simply "nothing dismissed". */
  async load(): Promise<DismissMap> {
    if (!(await this.fs.exists(this.path))) return {};
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path);
    } catch {
      return {};
    }
    try {
      return DismissMapSchema.parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  async put(id: WorkItemId, entry: DismissEntry): Promise<void> {
    const dismissals = await this.load();
    dismissals[id] = entry;
    await this.write(dismissals);
  }

  /** Drops the named keys. No-op when none of them is present. */
  async remove(keys: readonly WorkItemId[]): Promise<void> {
    const dismissals = await this.load();
    let changed = false;
    for (const key of keys) {
      if (key in dismissals) {
        delete dismissals[key];
        changed = true;
      }
    }
    if (changed) await this.write(dismissals);
  }

  private async write(dismissals: DismissMap): Promise<void> {
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    // Mode is set on the tmp file before the rename, so the store is never
    // briefly world-readable.
    await this.fs.writeFile(tmpPath, JSON.stringify(dismissals, null, 2), { mode: DISMISS_FILE_MODE });
    await this.fs.rename(tmpPath, this.path);
  }
}

/**
 * The one place the "is this item dismissed" rule lives: by id, or by ANY
 * ref the entry was stored with, so a dismissal follows the item across an
 * id change (see {@link DismissEntry.refs}).
 */
export function dismissalFor(
  dismissals: DismissMap,
  id: WorkItemId,
  refs: readonly ItemRef[],
): { key: WorkItemId; entry: DismissEntry } | null {
  const direct = dismissals[id];
  if (direct !== undefined) return { key: id, entry: direct };
  const own = new Set(refs);
  for (const [key, entry] of Object.entries(dismissals)) {
    if (entry.refs.some((ref) => own.has(ref))) return { key, entry };
  }
  return null;
}
