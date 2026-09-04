import type { SessionFileSystem } from '../fs/session-file-system';
import { InventorySchema, type Inventory } from './inventory';

export class InventoryCorruptError extends Error {
  constructor(path: string, reason: string, options?: { cause?: unknown }) {
    super(`Inventory at '${path}' is corrupt: ${reason}`, options);
    this.name = 'InventoryCorruptError';
  }
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export class InventoryStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  async save(inv: Inventory): Promise<void> {
    const validated = InventorySchema.parse(inv);
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, this.path);
  }

  async load(): Promise<Inventory | null> {
    const exists = await this.fs.exists(this.path);
    if (!exists) {
      return null;
    }
    const raw = await this.fs.readFile(this.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new InventoryCorruptError(this.path, `invalid JSON: ${(err as Error).message}`, { cause: err });
    }
    try {
      return InventorySchema.parse(parsed);
    } catch (err) {
      throw new InventoryCorruptError(this.path, `schema validation failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}
