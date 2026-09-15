import type { SessionFileSystem } from '../fs/session-file-system';
import type { AgentExitResult } from '../agent/agent-runner';
import type { QaVerdict } from '../schema/session';

export type PlanReviewStatus = 'approved' | 'unresolved' | 'missing';
export interface RereviewSummary { resolved: number; total: number; newFindings: number }

export async function readNonEmpty(fs: SessionFileSystem, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  const raw = await fs.readFile(path);
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  return text.trim().length > 0 ? text : null;
}

export async function evaluateFindings(fs: SessionFileSystem, sessionDir: string) {
  return { hasFindings: (await readNonEmpty(fs, `${sessionDir}/FINDINGS.md`)) !== null };
}

const REVIEW_STATUS_HEADING = /^#{2,3} Review Status:?\s*$/gm;
const SECTION_END = /^#{1,3} /;
const PM_APPROVED = /^\s*-\s*PM(?: \([^)\n]*\))?:\s*✅/m;
const PRINCIPAL_ENGINEER_APPROVED = /^\s*-\s*Principal Engineer(?: \([^)\n]*\))?:\s*✅/m;

export function parsePlanReviewStatus(planText: string): PlanReviewStatus {
  if (/^## Unresolved Review Disagreement\s*$/m.test(planText)) return 'unresolved';
  const headings = [...planText.matchAll(REVIEW_STATUS_HEADING)];
  // A second Review Status heading means a stale block from an earlier review round is
  // present; never trust either one — fail safe to 'missing' rather than risk approving on stale text.
  if (headings.length !== 1) return 'missing';
  const start = headings[0].index ?? -1;
  if (start < 0) return 'missing';
  const rest = planText.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => SECTION_END.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const pm = PM_APPROVED.test(section);
  const pe = PRINCIPAL_ENGINEER_APPROVED.test(section);
  return pm && pe ? 'approved' : 'missing';
}

export async function evaluatePlan(fs: SessionFileSystem, sessionDir: string) {
  const text = await readNonEmpty(fs, `${sessionDir}/PLAN.md`);
  if (text === null) return { hasPlan: false, reviewStatus: 'missing' as PlanReviewStatus };
  return { hasPlan: true, reviewStatus: parsePlanReviewStatus(text) };
}

function exitedCleanly(exit: AgentExitResult): boolean {
  return exit.code === 0 && exit.signal === null;
}

export async function evaluateReview(exit: AgentExitResult, fs: SessionFileSystem, sessionDir: string): Promise<'ready' | 'failed'> {
  if (!exitedCleanly(exit)) return 'failed';
  return (await readNonEmpty(fs, `${sessionDir}/REVIEW.md`)) !== null ? 'ready' : 'failed';
}

export function parseRereviewSummary(line: string): RereviewSummary | null {
  const m = line.trim().match(/^(?:✅|⚠️?)\s*(\d+)\/(\d+) resolved(?:,\s*(\d+) new)?$/u);
  if (!m) return null;
  return { resolved: Number(m[1]), total: Number(m[2]), newFindings: m[3] ? Number(m[3]) : 0 };
}

export async function evaluateRereview(exit: AgentExitResult, fs: SessionFileSystem, sessionDir: string) {
  const outcome = await evaluateReview(exit, fs, sessionDir);
  if (outcome === 'failed') return { outcome, summary: null };
  const line = await readNonEmpty(fs, `${sessionDir}/rereview_summary`);
  return { outcome, summary: line === null ? null : parseRereviewSummary(line) };
}

/** The first free `<stem>-v<N>.md` in `sessionDir`. */
export async function nextVersion(fs: SessionFileSystem, sessionDir: string, stem: string): Promise<number> {
  let version = 1;
  while (await fs.exists(`${sessionDir}/${stem}-v${version}.md`)) version += 1;
  return version;
}

export async function nextReviewVersion(fs: SessionFileSystem, sessionDir: string): Promise<number> {
  return nextVersion(fs, sessionDir, 'REVIEW');
}

const QA_VERDICT_HEADING = /^#{2,3} QA Verdict:?\s*$/gm;
const VERDICT_LINE = /^\s*-\s*Verdict:\s*(✅|❌|🚧)/mu;

/**
 * The completion marker, twin of `parsePlanReviewStatus`: EXACTLY one
 * `## QA Verdict` heading (two means a stale block from an earlier round is
 * still present — never trust either, fail safe to 'missing'), read only to
 * the next heading, and the glyph on the `- Verdict:` line decides. R79:
 * 🚧 Blocked is a verdict in its own right; it maps to the `not_ready`
 * PHASE in `evaluateQa`, not here.
 */
export function parseQaVerdict(qaText: string): QaVerdict | 'missing' {
  const headings = [...qaText.matchAll(QA_VERDICT_HEADING)];
  if (headings.length !== 1) return 'missing';
  const start = headings[0].index ?? -1;
  if (start < 0) return 'missing';
  const rest = qaText.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => SECTION_END.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const m = VERDICT_LINE.exec(section);
  if (m === null) return 'missing';
  return m[1] === '✅' ? 'ready' : m[1] === '❌' ? 'not_ready' : 'blocked';
}

export interface QaEvaluation {
  outcome: 'ready' | 'not_ready' | 'failed';
  verdict: QaVerdict | null;
}

/**
 * A run counts only when it exited cleanly AND left a non-empty `QA.md` AND
 * that file carries a parsable verdict — anything else is `failed`, so a
 * half-written report never reads as a pass. R79 folds `blocked` into the
 * `not_ready` phase: blocked means not ready AND needs me.
 */
export async function evaluateQa(
  exit: AgentExitResult,
  fs: SessionFileSystem,
  sessionDir: string,
): Promise<QaEvaluation> {
  if (!exitedCleanly(exit)) return { outcome: 'failed', verdict: null };
  const text = await readNonEmpty(fs, `${sessionDir}/QA.md`);
  if (text === null) return { outcome: 'failed', verdict: null };
  const verdict = parseQaVerdict(text);
  if (verdict === 'missing') return { outcome: 'failed', verdict: null };
  return { outcome: verdict === 'ready' ? 'ready' : 'not_ready', verdict };
}
