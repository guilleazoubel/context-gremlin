import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { JiraIssueSummary } from './jira-source';

/** R35 — four kinds, not two booleans. `kind !== 'notConfigured'` is the same answer `configured` used to give. */
export type TicketSourceKind = 'notConfigured' | 'auth' | 'unavailable' | 'ok';

export interface JiraScanReport {
  scannedAt: string;
  /** R37 — the accountId from `whoami()`, resolved once per scan. `myWork` compares against it. */
  me: string | null;
  issues: JiraIssueSummary[];
  error: string | null;
  kind: TicketSourceKind;
}

const JiraIssueSummarySchema = z.object({
  key: z.string(),
  summary: z.string(),
  status: z.string(),
  statusCategory: z.string(),
  assignee: z.string().nullable(),
  updated: z.string(),
  url: z.string(),
});

const JiraScanReportSchema = z.object({
  scannedAt: z.string(),
  me: z.string().nullable(),
  issues: z.array(JiraIssueSummarySchema),
  error: z.string().nullable(),
  kind: z.enum(['notConfigured', 'auth', 'unavailable', 'ok']),
});

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * `<stateDir>/jira.json`, written tmp-then-rename exactly like
 * `InventoryStore` (`inventory-store.ts:26-32`). Unlike the inventory, a
 * corrupt or unreadable cache is NOT an error: the whole point of the cache
 * is that an unreachable Jira degrades to stale tickets plus a banner, so a
 * bad file degrades the same way rather than 500ing a read.
 *
 * MG-5: the report carries issue content and an accountId. It never carries
 * the API token or an Authorization header, because nothing puts them here.
 */
export class JiraStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
  ) {}

  async save(report: JiraScanReport): Promise<void> {
    const validated = JiraScanReportSchema.parse(report);
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, this.path);
  }

  async load(): Promise<JiraScanReport | null> {
    if (!(await this.fs.exists(this.path))) return null;
    try {
      return JiraScanReportSchema.parse(JSON.parse(await this.fs.readFile(this.path)));
    } catch {
      return null;
    }
  }
}
