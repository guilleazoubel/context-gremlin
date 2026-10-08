import type { SessionFileSystem } from '../fs/session-file-system';
import { nextVersion, readNonEmpty } from './artifacts';

/** R90 — the two files one round of a session hands its agent. */
export const ROUND_FILES = ['BRIEF', 'FEEDBACK'] as const;

/**
 * R90 — before a FRESH round writes its own hand-off, the previous round's copies are kept as
 * `<STEM>-v<N>.md`, ONE N for both files (the round they belonged to), the `REVIEW-vN`/`QA-vN`
 * precedent. BRIEF.md is COPIED: the new brief overwrites it, or a run with no new brief keeps
 * reading it. FEEDBACK.md is MOVED, and removed even when empty: a fresh agent must never read
 * the last round's feedback as this round's. Returns the round number used, or null when there
 * was nothing to archive.
 */
export async function archiveRound(fs: SessionFileSystem, sessionDir: string): Promise<number | null> {
  const present: Array<{ stem: (typeof ROUND_FILES)[number]; text: string }> = [];
  for (const stem of ROUND_FILES) {
    const text = await readNonEmpty(fs, `${sessionDir}/${stem}.md`);
    if (text !== null) present.push({ stem, text });
  }
  if (present.length === 0) {
    await fs.remove(`${sessionDir}/FEEDBACK.md`);
    return null;
  }
  let round = 1;
  for (const stem of ROUND_FILES) round = Math.max(round, await nextVersion(fs, sessionDir, stem));
  for (const { stem, text } of present) {
    await fs.writeFile(`${sessionDir}/${stem}-v${round}.md`, text);
  }
  await fs.remove(`${sessionDir}/FEEDBACK.md`);
  return round;
}
