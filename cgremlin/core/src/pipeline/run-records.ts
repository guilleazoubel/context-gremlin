import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { appendJsonLine, readJsonLines } from '../fs/jsonl';
import { StageNameSchema } from '../schema/stage';
import { EFFORT_LEVELS, RUNNER_KINDS } from '../config/routing';

/**
 * R116/R118f — one line per run that reached `run.started`, in the session dir. The session dir
 * is agent-writable (`--add-dir`), so these records are telemetry, never evidence (S2-34).
 */
export const RUNS_FILE = 'runs.jsonl';
/** S2-25 — the record's known prefix, written at `run.started`; whoever removes it writes the record. */
export const RUN_FACTS_FILE = '.run-facts.json';

/**
 * S2-34 — the session dir is agent-writable, so every free-text field of a record or of the run
 * facts is bounded: the writers cap it, and a forged line or facts file that exceeds it is skipped.
 */
export const RUN_RECORD_TEXT_MAX = 512;
const text = () => z.string().max(RUN_RECORD_TEXT_MAX);

/** Caps one free-text value at RUN_RECORD_TEXT_MAX characters, the ellipsis included. */
export function capRecordText(value: string): string {
  return value.length > RUN_RECORD_TEXT_MAX ? `${value.slice(0, RUN_RECORD_TEXT_MAX - 1)}…` : value;
}

function capNullable(value: string | null): string | null {
  return value === null ? null : capRecordText(value);
}

export const TokenUsageSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });

export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUsd: z.number().nullable(),
});

export const LimitEventSchema = z.object({
  at: text(),
  kind: z.enum(['warning', 'rejected']),
  limitType: text().nullable(),
  resetsAt: text().nullable(),
  message: text().nullable(),
});

export const RunRecordSchema = z.object({
  v: z.literal(1),
  sessionId: text().min(1),
  stage: StageNameSchema,
  runner: z.enum(RUNNER_KINDS),
  /** The routed model, else the one the CLI reported, else null. */
  model: text().nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  routeSource: z.enum(['routing', 'legacy']),
  fresh: z.boolean(),
  resumed: z.boolean(),
  startedAt: text(),
  finishedAt: text(),
  tokens: TokenUsageSchema.nullable(),
  tokensSource: z.enum(['result', 'assistant']).nullable(),
  /** D2 — Claude's total_cost_usd; null when not reported. */
  costUsd: z.number().nullable(),
  /** D2 — Claude's per-model usage; null when not reported. */
  modelUsage: z.record(z.string(), ModelUsageSchema).nullable(),
  limitEvents: z.array(LimitEventSchema),
  /** The process outcome, except a run that hit a `rejected` limit is `stopped` (S2-35). */
  outcome: z.enum(['succeeded', 'failed', 'stopped']),
  stopReason: z.enum(['user', 'limit']).nullable(),
  error: text().nullable(),
  /** S2-25 — the engine died under this run; it was recorded when the run was healed. */
  interrupted: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/**
 * The run facts: the record's known prefix plus `runId`, a nonce naming THIS run, so a run only
 * ever takes its own facts (a lost run's late exit must not take the next run's).
 */
export const PendingRunSchema = RunRecordSchema.pick({
  v: true, sessionId: true, stage: true, runner: true, model: true, effort: true, routeSource: true, fresh: true, resumed: true, startedAt: true,
}).extend({ runId: z.string().min(1).max(64) });
export type PendingRun = z.infer<typeof PendingRunSchema>;

/** The record fields the facts carry: everything but the run's nonce. */
export function recordPrefixOf(pending: PendingRun): Omit<PendingRun, 'runId'> {
  const { runId: _runId, ...prefix } = pending;
  return prefix;
}

function boundRunRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    model: capNullable(record.model),
    error: capNullable(record.error),
    limitEvents: record.limitEvents.map((e) => ({
      ...e,
      at: capRecordText(e.at),
      limitType: capNullable(e.limitType),
      resetsAt: capNullable(e.resetsAt),
      message: capNullable(e.message),
    })),
  };
}

export function runsPath(sessionDir: string): string {
  return `${sessionDir}/${RUNS_FILE}`;
}

function factsPath(sessionDir: string): string {
  return `${sessionDir}/${RUN_FACTS_FILE}`;
}

export async function appendRunRecord(fs: SessionFileSystem, sessionDir: string, record: RunRecord): Promise<void> {
  await appendJsonLine(fs, runsPath(sessionDir), RunRecordSchema.parse(boundRunRecord(record)));
}

export async function readRunRecords(fs: SessionFileSystem, sessionDir: string): Promise<RunRecord[]> {
  return readJsonLines(fs, runsPath(sessionDir), RunRecordSchema);
}

export async function writeRunFacts(fs: SessionFileSystem, sessionDir: string, pending: PendingRun): Promise<void> {
  const bounded = { ...pending, model: capNullable(pending.model) };
  await fs.writeFile(factsPath(sessionDir), JSON.stringify(PendingRunSchema.parse(bounded)), { mode: 0o600 });
}

/**
 * Reads the run facts and, only when `isThisRun` accepts them, REMOVES them: the caller now owns
 * writing that run's record. Null when absent, unreadable, out of bounds or another run's — and
 * then the file is left exactly where it is, for the run it belongs to.
 */
export async function takeRunFacts(
  fs: SessionFileSystem,
  sessionDir: string,
  isThisRun: (pending: PendingRun) => boolean,
): Promise<PendingRun | null> {
  const path = factsPath(sessionDir);
  if (!(await fs.exists(path))) return null;
  let pending: PendingRun;
  try {
    const parsed = PendingRunSchema.safeParse(JSON.parse(await fs.readFile(path)));
    if (!parsed.success) return null;
    pending = parsed.data;
  } catch {
    return null;
  }
  if (!isThisRun(pending)) return null;
  await fs.remove(path);
  return pending;
}
