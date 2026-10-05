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
/**
 * Task 6 fix — the stages the preflight gates. The one a block refused is written to
 * `PREFLIGHT_STAGE` beside AGENT_NOTE, so the editor's "Run anyway" re-issues exactly that stage
 * instead of guessing it from the phase (a failed re-review guessed as `review` would overwrite
 * REVIEW.md).
 */
export const PREFLIGHT_STAGES = ['review', 'rereview', 'respond', 'verify'] as const;
export type PreflightStage = (typeof PREFLIGHT_STAGES)[number];

/** A read-back of `PREFLIGHT_STAGE`: a known stage, or null for anything else. */
export function parsePreflightStage(raw: string): PreflightStage | null {
  const value = raw.trim();
  return (PREFLIGHT_STAGES as readonly string[]).includes(value) ? (value as PreflightStage) : null;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; kind: 'jira_not_loaded' | 'gh_unavailable'; reason: string };

export interface PreflightDeps {
  ticketState(key: string | null): Promise<TicketBriefState>;
  ghAuthOk(): Promise<{ ok: true } | { ok: false; detail: string }>;
}

const NOT_LOADED_LABEL = { auth: 'auth error', unavailable: 'unavailable', not_configured: 'not configured' } as const;

const GH_DETAIL_MAX = 200;
const GH_TOKEN_RE = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g;

/** First line only, every `gh[pousr]_…` and fine-grained `github_pat_…` token replaced, at most 200 characters. */
export function redactGhDetail(detail: string): string {
  const firstLine = detail.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  return firstLine.replace(GH_TOKEN_RE, '[redacted]').trim().slice(0, GH_DETAIL_MAX);
}

/**
 * The one useful line of a failed GitHub probe (`gh api user --jq .login`): its first non-empty
 * line — e.g. `gh: Bad credentials (HTTP 401)`, or gh's "please run: gh auth login" when nobody is
 * logged in. Redaction still happens later, in `redactGhDetail`.
 */
export function summarizeGhAuthFailure(output: string): string {
  const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  return first ?? 'gh api user failed';
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
