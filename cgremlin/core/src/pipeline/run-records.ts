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
  at: z.string(),
  kind: z.enum(['warning', 'rejected']),
  limitType: z.string().nullable(),
  resetsAt: z.string().nullable(),
  message: z.string().nullable(),
});

export const RunRecordSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  stage: StageNameSchema,
  runner: z.enum(RUNNER_KINDS),
  /** The routed model, else the one the CLI reported, else null. */
  model: z.string().nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  routeSource: z.enum(['routing', 'legacy']),
  fresh: z.boolean(),
  resumed: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
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
  error: z.string().nullable(),
  /** S2-25 — the engine died under this run; it was recorded when the run was healed. */
  interrupted: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const PendingRunSchema = RunRecordSchema.pick({
  v: true, sessionId: true, stage: true, runner: true, model: true, effort: true, routeSource: true, fresh: true, resumed: true, startedAt: true,
});
export type PendingRun = z.infer<typeof PendingRunSchema>;

export function runsPath(sessionDir: string): string {
  return `${sessionDir}/${RUNS_FILE}`;
}

function factsPath(sessionDir: string): string {
  return `${sessionDir}/${RUN_FACTS_FILE}`;
}

export async function appendRunRecord(fs: SessionFileSystem, sessionDir: string, record: RunRecord): Promise<void> {
  await appendJsonLine(fs, runsPath(sessionDir), RunRecordSchema.parse(record));
}

export async function readRunRecords(fs: SessionFileSystem, sessionDir: string): Promise<RunRecord[]> {
  return readJsonLines(fs, runsPath(sessionDir), RunRecordSchema);
}

export async function writeRunFacts(fs: SessionFileSystem, sessionDir: string, pending: PendingRun): Promise<void> {
  await fs.writeFile(factsPath(sessionDir), JSON.stringify(PendingRunSchema.parse(pending)), { mode: 0o600 });
}

/** Reads and REMOVES the run facts: the caller now owns writing this run's record. Null when absent or unreadable. */
export async function takeRunFacts(fs: SessionFileSystem, sessionDir: string): Promise<PendingRun | null> {
  const path = factsPath(sessionDir);
  if (!(await fs.exists(path))) return null;
  let pending: PendingRun | null = null;
  try {
    const parsed = PendingRunSchema.safeParse(JSON.parse(await fs.readFile(path)));
    pending = parsed.success ? parsed.data : null;
  } catch {
    pending = null;
  }
  await fs.remove(path);
  return pending;
}
