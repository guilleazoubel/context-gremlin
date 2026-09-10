import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { ItemRef } from './item-ref';

export interface AckEntry {
  signature: string;
  ackedAt: string;
}

export type AckMap = Record<ItemRef, AckEntry>;

const AckMapSchema = z.record(z.string(), z.object({ signature: z.string(), ackedAt: z.string() }));

/** Engine state, never world-readable — the same posture as `core.json`. */
const ACK_FILE_MODE = 0o600;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Acknowledgement lives in its own store, not on the session record (R10): an
 * ack must exist for inventory items that have no session at all, an ack is
 * not pipeline state, and an ack write must not contend with the per-session
 * lock that guards session.json. Keyed by ItemRef; the value is the
 * canonical attention signature, which is what makes a NEW reason or a NEWER
 * `since` re-raise attention automatically.
 */
export class AckStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  /** Never throws: a missing or unreadable store is simply "nothing acked". */
  async load(): Promise<AckMap> {
    if (!(await this.fs.exists(this.path))) return {};
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path);
    } catch {
      return {};
    }
    try {
      return AckMapSchema.parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  async put(ref: ItemRef, entry: AckEntry): Promise<void> {
    const acks = await this.load();
    acks[ref] = entry;
    await this.write(acks);
  }

  /** Drops acks for items that no longer exist. */
  async prune(liveRefs: readonly ItemRef[]): Promise<void> {
    const acks = await this.load();
    const live = new Set(liveRefs);
    let changed = false;
    for (const ref of Object.keys(acks)) {
      if (!live.has(ref)) {
        delete acks[ref];
        changed = true;
      }
    }
    if (changed) await this.write(acks);
  }

  private async write(acks: AckMap): Promise<void> {
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    // Mode is set on the tmp file before the rename, so the store is never
    // briefly world-readable.
    await this.fs.writeFile(tmpPath, JSON.stringify(acks, null, 2), { mode: ACK_FILE_MODE });
    await this.fs.rename(tmpPath, this.path);
  }
}
