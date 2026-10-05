import type { TicketBriefState } from './prompts';

/**
 * 0c — the shared preflight every headless stage that reads a PR (review, rereview — the
 * automatic one included — respond, verify) passes before an agent is launched. A run that
 * cannot see the linked Jira ticket, or cannot use `gh`, is not started: it would only produce
 * a confident report about half the evidence. The user may skip the Jira half ("Run anyway");
 * the `gh` half is never skippable.
 *
 * Reason strings start with `Jira ` or `GitHub ` — the editor keys on those prefixes.
 */
export type PreflightResult =
  | { ok: true }
  | { ok: false; kind: 'jira_not_loaded' | 'gh_unavailable'; reason: string };

export interface PreflightDeps {
  ticketState(key: string | null): Promise<TicketBriefState>;
  ghAuthOk(): Promise<{ ok: true } | { ok: false; detail: string }>;
}

const NOT_LOADED_LABEL = { auth: 'auth error', unavailable: 'unavailable', not_configured: 'not configured' } as const;

const GH_DETAIL_MAX = 200;
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]+/g;

/** First line only, every `gh[pousr]_…` token replaced, at most 200 characters. */
export function redactGhDetail(detail: string): string {
  const firstLine = detail.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return firstLine.replace(GH_TOKEN_RE, '[redacted]').trim().slice(0, GH_DETAIL_MAX);
}

/**
 * The one useful line of a failed `gh auth status`. Its output leads with the bare host name
 * (`github.com`) and marks the failing account with `X `, so "the first line" alone would say
 * nothing; prefer the `X` line, else the first non-empty one. Redaction still happens later.
 */
export function summarizeGhAuthFailure(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const failing = lines.find((line) => line.startsWith('X '));
  if (failing !== undefined) return failing.slice(2).trim();
  return lines[0] ?? 'gh auth status failed';
}

const TICKET_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** The key lands in a one-line AGENT_NOTE; anything that is not a plain Jira key is replaced. */
function safeKey(key: string): string {
  return key.length <= 40 && TICKET_KEY_RE.test(key) ? key : '(invalid key)';
}

export async function preflightAccess(
  deps: PreflightDeps,
  p: { ticketKey: string | null; skipJiraCheck: boolean },
): Promise<PreflightResult> {
  if (p.ticketKey !== null && !p.skipJiraCheck) {
    const state = await deps.ticketState(p.ticketKey);
    if (state.kind === 'not_loaded') {
      return {
        ok: false,
        kind: 'jira_not_loaded',
        reason: `Jira ${safeKey(p.ticketKey)} could not be loaded (${NOT_LOADED_LABEL[state.reason]}) — fix access or choose Run anyway`,
      };
    }
  }
  // Never skipped: "Run anyway" waives the ticket, not the PR.
  const gh = await deps.ghAuthOk();
  if (!gh.ok) {
    return { ok: false, kind: 'gh_unavailable', reason: `GitHub is not usable: ${redactGhDetail(gh.detail)}` };
  }
  return { ok: true };
}
