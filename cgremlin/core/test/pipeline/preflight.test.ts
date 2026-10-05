import { describe, expect, it } from 'vitest';
import { preflightAccess, redactGhDetail, summarizeGhAuthFailure, type PreflightDeps } from '../../src/pipeline/preflight';
import type { TicketBriefState } from '../../src/pipeline/prompts';

function deps(state: TicketBriefState, gh: Awaited<ReturnType<PreflightDeps['ghAuthOk']>> = { ok: true }) {
  const keys: Array<string | null> = [];
  let ghCalls = 0;
  const d: PreflightDeps = {
    ticketState: async (k) => { keys.push(k); return state; },
    ghAuthOk: async () => { ghCalls += 1; return gh; },
  };
  return { d, keys, ghCalls: () => ghCalls };
}

const NOT_LOADED_AUTH: TicketBriefState = { kind: 'not_loaded', key: 'HB-627', reason: 'auth' };
const LOADED: TicketBriefState = {
  kind: 'loaded',
  ticket: { key: 'HB-627', summary: 's', status: 'UAT', url: 'https://jira.invalid/browse/HB-627', descriptionText: 'd', comments: [] },
};

describe('redactGhDetail — final fix M5', () => {
  it('strips fine-grained github_pat_ tokens as well as gh[pousr]_ ones', () => {
    const pat = `github_pat_11ABCDEFG0${'a'.repeat(20)}_${'B'.repeat(59)}`;
    const out = redactGhDetail(`bad token ${pat} and ghp_${'c'.repeat(36)} (HTTP 401)`);
    expect(out).toBe('bad token [redacted] and [redacted] (HTTP 401)');
    expect(out).not.toContain('github_pat_');
    expect(out).not.toContain('_B');
  });
});

describe('preflightAccess (0c)', () => {
  it('a linked ticket that is not loaded blocks with the Jira reason', async () => {
    const { d } = deps(NOT_LOADED_AUTH);
    expect(await preflightAccess(d, { ticketKey: 'HB-627', skipJiraCheck: false })).toEqual({
      ok: false,
      kind: 'jira_not_loaded',
      reason: 'Jira HB-627 could not be loaded (auth error) — fix access or choose Run anyway',
    });
  });

  it('labels each not_loaded reason', async () => {
    for (const [reason, label] of [['unavailable', 'unavailable'], ['not_configured', 'not configured']] as const) {
      const { d } = deps({ kind: 'not_loaded', key: 'HB-1', reason });
      const r = await preflightAccess(d, { ticketKey: 'HB-1', skipJiraCheck: false });
      expect(r).toMatchObject({ ok: false, kind: 'jira_not_loaded', reason: `Jira HB-1 could not be loaded (${label}) — fix access or choose Run anyway` });
    }
  });

  it('a loaded ticket and gh ok is ok', async () => {
    const { d } = deps(LOADED);
    expect(await preflightAccess(d, { ticketKey: 'HB-627', skipJiraCheck: false })).toEqual({ ok: true });
  });

  it('skipJiraCheck waives the Jira check (and never asks Jira) when gh is ok', async () => {
    const { d, keys } = deps(NOT_LOADED_AUTH);
    expect(await preflightAccess(d, { ticketKey: 'HB-627', skipJiraCheck: true })).toEqual({ ok: true });
    expect(keys).toEqual([]);
  });

  it('gh failing blocks even with skipJiraCheck (R4: the override never covers GitHub)', async () => {
    const { d } = deps(NOT_LOADED_AUTH, { ok: false, detail: 'You are not logged into any GitHub hosts.' });
    expect(await preflightAccess(d, { ticketKey: 'HB-627', skipJiraCheck: true })).toEqual({
      ok: false,
      kind: 'gh_unavailable',
      reason: 'GitHub is not usable: You are not logged into any GitHub hosts.',
    });
  });

  it('gh failing blocks with no ticket at all', async () => {
    const { d } = deps(LOADED, { ok: false, detail: 'boom' });
    expect(await preflightAccess(d, { ticketKey: null, skipJiraCheck: false })).toMatchObject({ ok: false, kind: 'gh_unavailable' });
  });

  it('no ticket + gh ok is ok, and ticketState is never called', async () => {
    const { d, keys, ghCalls } = deps(NOT_LOADED_AUTH);
    expect(await preflightAccess(d, { ticketKey: null, skipJiraCheck: false })).toEqual({ ok: true });
    expect(keys).toEqual([]);
    expect(ghCalls()).toBe(1);
  });

  it('a blocked Jira check does not also probe gh', async () => {
    const { d, ghCalls } = deps(NOT_LOADED_AUTH);
    await preflightAccess(d, { ticketKey: 'HB-627', skipJiraCheck: false });
    expect(ghCalls()).toBe(0);
  });

  it('a key that is not a plain ticket key never reaches the reason verbatim', async () => {
    const { d } = deps({ kind: 'not_loaded', key: 'x', reason: 'auth' });
    const r = await preflightAccess(d, { ticketKey: 'HB-1\nAGENT_STATE=ready', skipJiraCheck: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain('\n');
      expect(r.reason.startsWith('Jira (invalid key) could not be loaded')).toBe(true);
    }
  });
});

describe('redactGhDetail', () => {
  it('strips gh tokens and keeps the first line only', () => {
    const out = redactGhDetail('error: token ghp_abcdef123456 is invalid\nsecond line');
    expect(out).not.toContain('ghp_abcdef123456');
    expect(out).not.toContain('second line');
    expect(out).toContain('error: token');
  });

  it('strips every gh token prefix', () => {
    for (const p of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      expect(redactGhDetail(`bad ${p}AbC123xyz here`)).not.toContain(`${p}AbC123xyz`);
    }
  });

  it('cuts a 1000-char detail to at most 200', () => {
    expect(redactGhDetail('a'.repeat(1000)).length).toBeLessThanOrEqual(200);
  });
});

describe('summarizeGhAuthFailure', () => {
  it('a 401 from `gh api user` is its first line', () => {
    expect(summarizeGhAuthFailure('gh: Bad credentials (HTTP 401)\n{"message":"Bad credentials"}')).toBe('gh: Bad credentials (HTTP 401)');
  });

  it('not logged in: the first non-empty line', () => {
    expect(
      summarizeGhAuthFailure('\nTo get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n'),
    ).toBe('To get started with GitHub CLI, please run:  gh auth login');
  });

  it('an empty output still says something', () => {
    expect(summarizeGhAuthFailure('')).toBe('gh api user failed');
  });
});
