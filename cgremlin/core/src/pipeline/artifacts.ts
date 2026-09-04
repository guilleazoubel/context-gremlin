import type { SessionFileSystem } from '../fs/session-file-system';
import type { AgentExitResult } from '../agent/agent-runner';

export type PlanReviewStatus = 'approved' | 'unresolved' | 'missing';
export interface RereviewSummary { resolved: number; total: number; newFindings: number }

export async function readNonEmpty(fs: SessionFileSystem, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  const text = await fs.readFile(path);
  return text.trim().length > 0 ? text : null;
}

export async function evaluateFindings(fs: SessionFileSystem, sessionDir: string) {
  return { hasFindings: (await readNonEmpty(fs, `${sessionDir}/FINDINGS.md`)) !== null };
}

export function parsePlanReviewStatus(planText: string): PlanReviewStatus {
  if (/^## Unresolved Review Disagreement\s*$/m.test(planText)) return 'unresolved';
  const start = planText.search(/^## Review Status\s*$/m);
  if (start < 0) return 'missing';
  const rest = planText.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const pm = /^- PM: ✅/m.test(section);
  const pe = /^- Principal Engineer: ✅/m.test(section);
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
  const m = line.trim().match(/^(?:✅|⚠️)\s*(\d+)\/(\d+) resolved(?:,\s*(\d+) new)?$/u);
  if (!m) return null;
  return { resolved: Number(m[1]), total: Number(m[2]), newFindings: m[3] ? Number(m[3]) : 0 };
}

export async function evaluateRereview(exit: AgentExitResult, fs: SessionFileSystem, sessionDir: string) {
  const outcome = await evaluateReview(exit, fs, sessionDir);
  if (outcome === 'failed') return { outcome, summary: null };
  const line = await readNonEmpty(fs, `${sessionDir}/rereview_summary`);
  return { outcome, summary: line === null ? null : parseRereviewSummary(line) };
}

export async function nextReviewVersion(fs: SessionFileSystem, sessionDir: string): Promise<number> {
  let version = 1;
  while (await fs.exists(`${sessionDir}/REVIEW-v${version}.md`)) version += 1;
  return version;
}
