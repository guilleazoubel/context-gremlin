import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';

/**
 * R80 — the auto-trigger identity: the SORTED join of `repo#n@mergeOid` over
 * every merged PR on the item. Sorted, because PR order is incidental; a new
 * merge on any of them is a different identity and therefore a new
 * verification. The QA-entry ORDINAL is carried separately, so a re-entry at
 * the same shas is unambiguous without pretending we know when Jira changed.
 */
export function qaIdentityOf(prs: readonly { repo: string; number: number; mergeSha: string }[]): string {
  return prs
    .map((pr) => `${pr.repo}#${pr.number}@${pr.mergeSha}`)
    .sort()
    .join('+');
}

export type QaAttemptOutcome =
  | 'reserved'
  | 'started'
  | 'create-failed'
  | 'unreachable'
  | 'ready'
  | 'not_ready'
  | 'failed';

/**
 * Written BEFORE the session is created (E2). A crash between the reserve and
 * `run.started` therefore leaves a record whose `attempt` has already reached
 * the cap, so the leg never auto-retries — the row shows the lit manual
 * action instead. Recording AFTER the start re-fires the whole verification
 * on the next tick after any crash.
 */
export interface QaAttempt {
  /** The ticket key. */
  key: string;
  /** R80's sorted join. */
  identity: string;
  ordinal: number;
  /** 1-based, per `(key, identity, ordinal)`. */
  attempt: number;
  reservedAt: string;
  sessionId: string | null;
  outcome: QaAttemptOutcome;
}

export interface QaTicketRecord {
  lastStatus: string | null;
  /** OUR tick's observation time (R80) — never presented as a Jira fact. */
  lastObservedAt: string | null;
  ordinal: number;
  attempts: QaAttempt[];
}

export interface QaTriggerState {
  /**
   * E1 — `false` means the file was present but unreadable or malformed.
   * That is NOT "nothing recorded, therefore everything is new": the leg
   * SEEDS on such a tick and starts nothing, so a truncated write can never
   * turn into a fleet of verifications.
   */
  ok: boolean;
  tickets: Record<string, QaTicketRecord>;
}

export const QA_KEEP_ATTEMPTS_PER_TICKET = 5;
export const QA_FORGET_AFTER_DAYS = 90;
const QA_FILE_MODE = 0o600;

const AttemptSchema = z.object({
  key: z.string(),
  identity: z.string(),
  ordinal: z.number().int(),
  attempt: z.number().int(),
  reservedAt: z.string(),
  sessionId: z.string().nullable(),
  outcome: z.string(),
});

const StateSchema = z.record(
  z.string(),
  z.object({
    lastStatus: z.string().nullable(),
    lastObservedAt: z.string().nullable(),
    ordinal: z.number().int(),
    attempts: z.array(AttemptSchema),
  }),
);

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * `<stateDir>/qa-verifications.json` — `DismissStore`'s shape verbatim:
 * 0600, tmp-then-rename, and a read that never throws. What it does NOT
 * share is DismissStore's "a malformed file means nothing is recorded": for
 * THIS store that reading would turn a truncated write into a fleet of
 * verifications, so `load()` reports `ok: false` and the leg seeds only.
 */
export class QaTriggerStore {
  private readonly now: () => Date;

  constructor(
    private readonly fs: SessionFileSystem,
    private readonly path: string,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** Never throws. `ok:false` means "present but unreadable" — see {@link QaTriggerState.ok}. */
  async load(): Promise<QaTriggerState> {
    if (!(await this.fs.exists(this.path))) return { ok: true, tickets: {} };
    let raw: string;
    try {
      raw = await this.fs.readFile(this.path);
    } catch {
      return { ok: false, tickets: {} };
    }
    try {
      return { ok: true, tickets: StateSchema.parse(JSON.parse(raw)) as Record<string, QaTicketRecord> };
    } catch {
      return { ok: false, tickets: {} };
    }
  }

  /** How many attempts are already recorded for this exact `(key, identity, ordinal)`. */
  static attemptsFor(state: QaTriggerState, key: string, identity: string, ordinal: number): number {
    return (state.tickets[key]?.attempts ?? []).filter(
      (a) => a.identity === identity && a.ordinal === ordinal,
    ).length;
  }

  /** Records the status we observed, WITHOUT treating it as an entry. The seed path (E1/R77). */
  async observe(key: string, status: string): Promise<QaTicketRecord> {
    return this.update(key, (record) => ({ ...record, lastStatus: status }));
  }

  /** An observed non-QA -> QA transition: the ordinal increments (R80). */
  async enterQa(key: string, status: string): Promise<QaTicketRecord> {
    return this.update(key, (record) => ({ ...record, lastStatus: status, ordinal: record.ordinal + 1 }));
  }

  /** E2 — write the attempt BEFORE the session is created. */
  async reserve(attempt: QaAttempt): Promise<void> {
    await this.update(attempt.key, (record) => ({ ...record, attempts: [...record.attempts, attempt] }));
  }

  /** Fills in what only the caller learns later: the session id, then the verdict. */
  async patch(key: string, reservedAt: string, patch: Partial<QaAttempt>): Promise<void> {
    await this.update(key, (record) => ({
      ...record,
      attempts: record.attempts.map((a) => (a.reservedAt === reservedAt ? { ...a, ...patch } : a)),
    }));
  }

  private async update(key: string, fn: (record: QaTicketRecord) => QaTicketRecord): Promise<QaTicketRecord> {
    const state = await this.load();
    const nowIso = this.now().toISOString();
    const before: QaTicketRecord = state.tickets[key] ?? {
      lastStatus: null,
      lastObservedAt: null,
      ordinal: 0,
      attempts: [],
    };
    const after: QaTicketRecord = { ...fn(before), lastObservedAt: nowIso };
    await this.write({ ...state.tickets, [key]: after });
    return after;
  }

  /** E14 — both hygiene rules run on WRITE, so the file stays bounded with no migration. */
  private async write(tickets: Record<string, QaTicketRecord>): Promise<void> {
    const cutoff = this.now().getTime() - QA_FORGET_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const pruned: Record<string, QaTicketRecord> = {};
    for (const [key, record] of Object.entries(tickets)) {
      const observed = record.lastObservedAt === null ? NaN : Date.parse(record.lastObservedAt);
      if (!Number.isNaN(observed) && observed < cutoff) continue;
      pruned[key] = { ...record, attempts: record.attempts.slice(-QA_KEEP_ATTEMPTS_PER_TICKET) };
    }
    await this.fs.mkdir(dirnameOf(this.path), { recursive: true });
    const tmpPath = `${this.path}.${randomSuffix()}.tmp`;
    // Mode is set on the tmp file before the rename, so the store is never
    // briefly world-readable.
    // Compact, unlike the config stores: nobody hand-edits this file, and the
    // indent is a third of its size at the sizes E14 is defending against.
    await this.fs.writeFile(tmpPath, JSON.stringify(pruned), { mode: QA_FILE_MODE });
    await this.fs.rename(tmpPath, this.path);
  }
}
