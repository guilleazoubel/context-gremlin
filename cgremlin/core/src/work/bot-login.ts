/**
 * R5 — the ONE bot predicate. MG-4 asserts no second `[bot]` literal exists
 * anywhere under `src/`: every site that decides bot-ness calls this.
 *
 * Precedence: (a) the parsed author's own `is_bot` flag, when gh emitted one;
 * (b) a `[bot]` login suffix, case-insensitively; (c) membership of the
 * default list, widened (never replaced) by `config.botLogins`.
 */
export const DEFAULT_BOT_LOGINS: readonly string[] = [
  'github-actions',
  'dependabot',
  'renovate',
  'codecov',
  'codecov-commenter',
  'vercel',
  'sonarcloud',
  'apfm-sonar',
  'gitstream-cm',
  'copilot',
  'copilot-pull-request-reviewer',
  'coderabbitai',
  'netlify',
  'snyk-bot',
];

const DEFAULT_SET = new Set(DEFAULT_BOT_LOGINS);

export function isBotLogin(login: string, opts?: { isBot?: boolean; extra?: readonly string[] }): boolean {
  if (opts?.isBot === true) return true;
  const lower = login.toLowerCase();
  if (lower.endsWith('[bot]')) return true;
  if (DEFAULT_SET.has(lower)) return true;
  return (opts?.extra ?? []).some((extra) => extra.toLowerCase() === lower);
}
