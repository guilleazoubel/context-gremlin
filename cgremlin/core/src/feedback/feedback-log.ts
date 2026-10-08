import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { appendJsonLine, readJsonLines } from '../fs/jsonl';
import { KeyedLock } from '../api/keyed-lock';
import { StageNameSchema } from '../schema/stage';
import { EFFORT_LEVELS, RUNNER_KINDS } from '../config/routing';

export const FEEDBACK_KINDS = ['finding_dismissed', 'review_dismissed', 'verdict_rejected'] as const;

/**
 * §20 — one line of `<stateDir>/feedback.jsonl`. `id` is deterministic per signal, so the same
 * dismissal seen at two hand-over points is one record. `source: 'user'` is reserved for the
 * 💡 Improve button (step 11); step 2 writes only `auto`.
 */
export const FeedbackRecordSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  at: z.string(),
  source: z.enum(['auto', 'user']),
  kind: z.enum(FEEDBACK_KINDS),
  text: z.string(),
  context: z.object({
    sessionId: z.string().min(1),
    mode: z.string(),
    stage: StageNameSchema.nullable(),
    ticket: z.string().nullable(),
    pr: z.object({ repo: z.string(), number: z.number().int() }).nullable(),
    /** Absolute path of the file the signal is about. */
    artifact: z.string().nullable(),
    /** A finding's anchor (`f2`), when the signal is about one finding. */
    anchor: z.string().nullable(),
  }),
  /** The run that produced the artifact (newest matching record in the session's runs.jsonl). */
  producedBy: z
    .object({ stage: StageNameSchema, runner: z.enum(RUNNER_KINDS), model: z.string().nullable(), effort: z.enum(EFFORT_LEVELS).nullable() })
    .nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

const IdOnly = z.object({ id: z.string() }).passthrough();

/**
 * Module-level and keyed by file path, so two FeedbackLog instances on the same file still
 * serialize their read-check-append (a per-instance lock would let them lose records).
 */
const APPEND_LOCK = new KeyedLock();

/**
 * The engine's single writer of feedback.jsonl. Appends are serialized in-process (a lock keyed
 * by the file's path, not the session lock) and each one rewrites the file tmp-then-rename
 * (src/fs/jsonl.ts), so concurrent signals never lose or tear a record. It reads and writes ONLY `path`.
 */
export class FeedbackLog {

  constructor(
    private readonly fs: SessionFileSystem,
    readonly path: string,
  ) {}

  /** Appends unless a record with this id is already there. Returns whether it wrote. */
  async appendOnce(record: FeedbackRecord): Promise<boolean> {
    const valid = FeedbackRecordSchema.parse(record);
    return APPEND_LOCK.withLock(this.path, async () => {
      const existing = await readJsonLines(this.fs, this.path, IdOnly);
      if (existing.some((r) => r.id === valid.id)) return false;
      await appendJsonLine(this.fs, this.path, valid);
      return true;
    });
  }

  async list(): Promise<FeedbackRecord[]> {
    return readJsonLines(this.fs, this.path, FeedbackRecordSchema);
  }
}
