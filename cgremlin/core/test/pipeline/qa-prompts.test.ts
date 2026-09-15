import { describe, expect, it } from 'vitest';
import {
  EMPTY_QA_ENVIRONMENT,
  EMPTY_ENVIRONMENT,
  renderEnvironmentSection,
  renderClerkTestUserLine,
  QA_CONDUCT_RULE,
  QA_MAX_BRIEF_CHARS,
  renderQaBrief,
  renderQaEnvironmentSection,
  renderQaPrompt,
  type QaBriefContext,
  type QaEnvironmentBriefContext,
} from '../../src/pipeline/prompts';

const SECRET = 'sUpErS3cr3tBypass';

function env(over: Partial<QaEnvironmentBriefContext> = {}): QaEnvironmentBriefContext {
  return { ...EMPTY_QA_ENVIRONMENT, url: 'https://qa.example.com', ...over };
}

function ctx(over: Partial<QaBriefContext> = {}): QaBriefContext {
  return {
    sessionDir: '/sessions/qa-1',
    ticket: 'HB-1489',
    prRepo: 'acme/app',
    prNumber: 42,
    mergeSha: 'abc1234def5678',
    change: {
      title: 'Add web content block',
      author: 'alice',
      mergedAt: '2026-09-14T09:00:00.000Z',
      changedFiles: 3,
      additions: 120,
      deletions: 4,
      files: ['src/a.tsx', 'src/api/b.ts', 'src/flags.ts'],
    },
    priorArtifacts: ['/sessions/rev-1/REVIEW.md'],
    ticketContext: null,
    env: env(),
    ...over,
  };
}

describe('renderQaEnvironmentSection', () => {
  it('renders nothing when nothing is configured (the R14 gate)', () => {
    expect(renderQaEnvironmentSection(EMPTY_QA_ENVIRONMENT)).toBe('');
  });

  it('carries the QA url, the api base url, the PostHog project and the flags', () => {
    const text = renderQaEnvironmentSection(
      env({
        apiBaseUrl: 'https://api-qa.example.com',
        posthog: { project: 'grace', host: 'https://us.posthog.com' },
        featureFlags: ['hb-1489-web-content'],
      }),
    );
    expect(text).toContain('## QA environment');
    expect(text).toContain('https://qa.example.com');
    expect(text).toContain('https://api-qa.example.com');
    expect(text).toContain('grace');
    expect(text).toContain('hb-1489-web-content');
  });

  it('names the bypass-secret FILE, never the secret itself', () => {
    const text = renderQaEnvironmentSection(
      env({ auth: 'vercel-bypass', bypassSecretPath: '/sessions/qa-1/.bypass-secret' }),
    );
    expect(text).toContain('/sessions/qa-1/.bypass-secret');
    expect(text).not.toContain(SECRET);
  });

  it('states the no-secrets rule', () => {
    const text = renderQaEnvironmentSection(env());
    expect(text).toMatch(/never print a secret, cookie, token or `Authorization` header/i);
  });

  it('an unreachable QA degrades to a do-not-start line, never a throw', () => {
    const text = renderQaEnvironmentSection(env({ unreachableReason: 'connect ECONNREFUSED' }));
    expect(text).toContain('QA: UNREACHABLE — connect ECONNREFUSED. Do not attempt to start anything');
  });

  it('uses the SAME clerk sentence the live UI check emits — one description of how to sign in', () => {
    const clerk = { emailTemplate: 'uicheck-qa-1+clerk_test@example.com', verificationCode: '424242' };
    const qa = renderQaEnvironmentSection(env({ auth: 'clerk-test', clerk }));
    const review = renderEnvironmentSection({ ...EMPTY_ENVIRONMENT, clerk });
    const line = renderClerkTestUserLine(clerk);
    expect(qa).toContain(line);
    expect(review).toContain(line);
  });

  it('says a test account exists without printing a credential when auth is none', () => {
    expect(renderQaEnvironmentSection(env({ auth: 'none' }))).toContain('no test account is configured');
  });
});

describe('renderQaBrief', () => {
  it('leads with the ticket, the repo and the merged sha', () => {
    expect(renderQaBrief(ctx())).toMatch(/^# QA VERIFICATION — HB-1489 \(acme\/app#42, merged abc1234\)/);
  });

  it('carries the conduct rule verbatim', () => {
    expect(renderQaBrief(ctx())).toContain(QA_CONDUCT_RULE);
    expect(QA_CONDUCT_RULE).toContain('never delete records');
    expect(QA_CONDUCT_RULE).toContain('emails or texts a real person');
    expect(QA_CONDUCT_RULE).toContain('write to Jira or GitHub');
  });

  it('describes the change and names all three ways to read the diff', () => {
    const text = renderQaBrief(ctx());
    expect(text).toContain('## The change');
    expect(text).toContain('src/api/b.ts');
    expect(text).toContain('gh pr diff 42');
    expect(text).toContain('git fetch origin pull/42/head');
    expect(text).toContain('git show --stat abc1234def5678');
  });

  it('lists prior artifacts by absolute path only', () => {
    const text = renderQaBrief(ctx());
    expect(text).toContain('## What we already know');
    expect(text).toContain('/sessions/rev-1/REVIEW.md');
  });

  it('omits the sections it has nothing for', () => {
    const text = renderQaBrief(ctx({ change: null, priorArtifacts: [], env: EMPTY_QA_ENVIRONMENT }));
    // Headings only — the protocol REFERS to '## The change' in prose, which
    // is exactly why the assertion is anchored to the start of a line.
    expect(text).not.toMatch(/^## The change$/m);
    expect(text).not.toMatch(/^## What we already know$/m);
    expect(text).not.toMatch(/^## QA environment/m);
    expect(text).toMatch(/^## How to verify$/m);
    expect(text).toMatch(/^## Output$/m);
  });

  it('gives the QA.md contract, ending in the parsed marker', () => {
    const text = renderQaBrief(ctx());
    expect(text).toContain('## QA Verdict');
    expect(text).toContain('- Verdict: ✅ Ready to deploy');
  });

  it('MG-21 — no secret reaches the brief', () => {
    const text = renderQaBrief(
      ctx({ env: env({ auth: 'vercel-bypass', bypassSecretPath: '/sessions/qa-1/.bypass-secret' }) }),
    );
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/x-vercel-protection-bypass=[A-Za-z0-9]/);
  });

  it('is capped, with the truncation note', () => {
    const text = renderQaBrief(ctx({ priorArtifacts: Array.from({ length: 4000 }, (_, i) => `/sessions/s${i}/REVIEW.md`) }));
    expect(text.length).toBeLessThanOrEqual(QA_MAX_BRIEF_CHARS);
    expect(text).toContain('_(truncated by the engine)_');
  });
});

describe('renderQaPrompt', () => {
  it('names the skill, degrades to the brief, and forbids every outward action', () => {
    const text = renderQaPrompt({ sessionDir: '/sessions/qa-1', qaSkillCommand: '/cgremlin:qa-verify' });
    expect(text).toContain('/cgremlin:qa-verify');
    expect(text).toContain('if it is not available follow BRIEF.md');
    expect(text).toContain('/sessions/qa-1/QA.md');
    expect(text).toMatch(/Make no code changes, open no PR, post nothing/);
  });

  it('defaults the skill command', () => {
    expect(renderQaPrompt({ sessionDir: '/s' })).toContain('/cgremlin:qa-verify');
  });
});
