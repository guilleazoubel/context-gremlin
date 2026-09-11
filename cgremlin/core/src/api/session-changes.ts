import type { GitRunner } from '../git/git-runner';

export interface ChangeEntry {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

export interface ChangesSummary {
  files: number;
  additions: number;
  deletions: number;
  entries: ChangeEntry[];
}

export interface SessionChangesResult {
  base: string;
  /** false when `merge-base` could not resolve `base` locally (e.g. the ref was never fetched) — the committed diff then falls back to a plain three-dot diff against `base` itself. */
  baseResolved: boolean;
  head: string;
  committed: ChangesSummary;
  workingTree: ChangesSummary;
}

/** `git diff --numstat` line: `<additions>\t<deletions>\t<path>`; binary files report `-\t-\t<path>`. */
function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const out = new Map<string, { additions: number; deletions: number }>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [a, d, ...rest] = line.split('\t');
    const path = rest.join('\t');
    out.set(path, {
      additions: a === '-' ? 0 : Number.parseInt(a, 10),
      deletions: d === '-' ? 0 : Number.parseInt(d, 10),
    });
  }
  return out;
}

/** `git diff --name-status` line: `<status>\t<path>` (status is a single letter — M/A/D — with `--no-renames`). */
function parseNameStatus(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [status, ...rest] = line.split('\t');
    out.set(rest.join('\t'), status);
  }
  return out;
}

function buildSummary(numstatOut: string, nameStatusOut: string): ChangesSummary {
  const counts = parseNumstat(numstatOut);
  const statuses = parseNameStatus(nameStatusOut);
  const paths = new Set([...counts.keys(), ...statuses.keys()]);
  const entries: ChangeEntry[] = [...paths].map((path) => ({
    path,
    additions: counts.get(path)?.additions ?? 0,
    deletions: counts.get(path)?.deletions ?? 0,
    status: statuses.get(path) ?? '?',
  }));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: entries.length,
    additions: entries.reduce((sum, e) => sum + e.additions, 0),
    deletions: entries.reduce((sum, e) => sum + e.deletions, 0),
    entries,
  };
}

async function diffSummary(git: GitRunner, cwd: string, diffArgs: readonly string[]): Promise<ChangesSummary> {
  const numstat = await git.run(['diff', '--no-renames', '--numstat', ...diffArgs], { cwd });
  const nameStatus = await git.run(['diff', '--no-renames', '--name-status', ...diffArgs], { cwd });
  return buildSummary(numstat.stdout, nameStatus.stdout);
}

/**
 * Phase 10 `GET /sessions/:id/changes`. Diffs against `git merge-base <base>
 * HEAD` so a stale/rebased base never inflates the counts; if `merge-base`
 * itself fails (the base ref was never fetched into this worktree), falls
 * back to a plain three-dot diff against `base` and reports
 * `baseResolved: false` rather than failing the request.
 */
export async function computeSessionChanges(git: GitRunner, cwd: string, base: string): Promise<SessionChangesResult> {
  const headOut = await git.run(['rev-parse', 'HEAD'], { cwd });
  const head = headOut.stdout.trim();

  let baseResolved = true;
  let committedDiffArgs: readonly string[];
  try {
    const mergeBaseOut = await git.run(['merge-base', base, 'HEAD'], { cwd });
    const mergeBase = mergeBaseOut.stdout.trim();
    committedDiffArgs = [mergeBase, 'HEAD'];
  } catch {
    baseResolved = false;
    committedDiffArgs = [`${base}...HEAD`];
  }

  const committed = await diffSummary(git, cwd, committedDiffArgs);
  const workingTree = await diffSummary(git, cwd, ['HEAD']);

  return { base, baseResolved, head, committed, workingTree };
}
