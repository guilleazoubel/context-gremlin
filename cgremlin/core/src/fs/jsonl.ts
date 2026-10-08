import type { z } from 'zod';
import type { SessionFileSystem } from './session-file-system';

/** Engine state files are never world-readable (the dismissals / attention-acks posture). */
export const JSONL_FILE_MODE = 0o600;

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Appends ONE JSON line. The whole file is rewritten tmp-then-rename, so a crash mid-write
 * leaves the previous file intact rather than a torn record; a last line torn by something
 * else first gets a newline, so the new record never lands glued onto it. One writer per file
 * (the engine); callers that can race serialize their own appends (FeedbackLog does).
 */
export async function appendJsonLine(fs: SessionFileSystem, path: string, value: unknown): Promise<void> {
  const line = JSON.stringify(value);
  await fs.mkdir(dirnameOf(path), { recursive: true });
  const existing = (await fs.exists(path)) ? await fs.readFile(path) : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const tmpPath = `${path}.${randomSuffix()}.tmp`;
  await fs.writeFile(tmpPath, `${existing}${separator}${line}\n`, { mode: JSONL_FILE_MODE });
  await fs.rename(tmpPath, path);
}

/** Every line that parses and matches `schema`. Blank, torn and foreign lines are skipped, never thrown; a missing or unreadable file is []. */
export async function readJsonLines<T>(fs: SessionFileSystem, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T[]> {
  if (!(await fs.exists(path))) return [];
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) out.push(result.data);
  }
  return out;
}
