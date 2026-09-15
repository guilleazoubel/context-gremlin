import { describe, expect, it } from 'vitest';
import {
  hasAnySecret,
  redactCoreConfig,
  redactSecrets,
  resolveCoreConfig,
  type CoreConfig,
} from '../../src/config/core-config';

const HOME = '/home/u';
const SLUG = 'aplaceformom/grace-frontend';

function cfg(qa: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): CoreConfig {
  return resolveCoreConfig(
    { repos: [SLUG], me: 'me', environments: { [SLUG]: qa === undefined ? {} : { qa } }, ...extra },
    HOME,
  );
}

describe('the qa environment config', () => {
  it('needs only a url; everything else has a default', () => {
    const qa = cfg({ url: 'https://qa.example.com' }).environments[SLUG].qa;
    expect(qa).toMatchObject({
      url: 'https://qa.example.com',
      auth: 'none',
      healthPath: '/',
      healthTimeoutMs: 15_000,
      featureFlags: [],
    });
  });

  it('apiBaseUrl defaults to url when absent, and is kept when given', () => {
    expect(cfg({ url: 'https://qa.example.com' }).environments[SLUG].qa?.apiBaseUrl).toBe('https://qa.example.com');
    expect(
      cfg({ url: 'https://qa.example.com', apiBaseUrl: 'https://api-qa.example.com' }).environments[SLUG].qa
        ?.apiBaseUrl,
    ).toBe('https://api-qa.example.com');
  });

  it('accepts the three auth modes and rejects anything else', () => {
    for (const auth of ['clerk-test', 'vercel-bypass', 'none']) {
      expect(cfg({ url: 'https://q', auth }).environments[SLUG].qa?.auth).toBe(auth);
    }
    expect(() => cfg({ url: 'https://q', auth: 'basic' })).toThrow();
  });

  it('carries the optional posthog project and the flags', () => {
    const qa = cfg({
      url: 'https://q',
      posthog: { project: 'grace', host: 'https://us.posthog.com' },
      featureFlags: ['hb-1489'],
    }).environments[SLUG].qa;
    expect(qa?.posthog).toEqual({ project: 'grace', host: 'https://us.posthog.com' });
    expect(qa?.featureFlags).toEqual(['hb-1489']);
  });

  it('is absent when the repo does not configure QA', () => {
    expect(cfg(undefined).environments[SLUG].qa).toBeUndefined();
  });
});

describe('the top-level qa knobs', () => {
  it('default to on, one auto-start per tick, a 20s budget', () => {
    const c = cfg(undefined);
    expect(c.qa).toEqual({ autoVerify: true, maxAutoStartsPerTick: 1, scanBudgetMs: 20_000 });
    expect(c.qaSkillCommand).toBe('/cgremlin:qa-verify');
  });

  it('autoVerify can be switched off', () => {
    expect(cfg(undefined, { qa: { autoVerify: false } }).qa.autoVerify).toBe(false);
  });

  it('jira.qaStatuses has a default and is overridable', () => {
    const base = { siteUrl: 'https://x.atlassian.net', email: 'e@x' };
    expect(cfg(undefined, { jira: base }).jira?.qaStatuses).toEqual(['QA', 'UAT', 'Ready for QA']);
    expect(cfg(undefined, { jira: { ...base, qaStatuses: ['In QA'] } }).jira?.qaStatuses).toEqual(['In QA']);
  });
});

describe('secrets', () => {
  it('QA adds no new secret — hasAnySecret is unchanged by a qa block', () => {
    expect(hasAnySecret(cfg({ url: 'https://q', auth: 'clerk-test' }))).toBe(false);
  });

  it('redactCoreConfig still redacts the bypass secret, and a qa block survives it', () => {
    const c = resolveCoreConfig(
      {
        repos: [SLUG],
        me: 'me',
        environments: {
          [SLUG]: {
            vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: 'S3CRET' },
            qa: { url: 'https://q' },
          },
        },
      },
      HOME,
    );
    const red = redactCoreConfig(c);
    expect(red.environments[SLUG].vercel?.bypassSecret).toBe('[redacted]');
    expect(red.environments[SLUG].qa?.url).toBe('https://q');
    expect(JSON.stringify(red)).not.toContain('S3CRET');
  });
});

describe('redactSecrets — widened beyond the vercel bypass shape', () => {
  it.each([
    ['?x-vercel-protection-bypass=S3CRET&x=1', 'S3CRET'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1', 'eyJhbGciOiJIUzI1'],
    ['-H "authorization: Basic YWxpY2U6cHc="', 'YWxpY2U6cHc='],
    ['Cookie: __session=abc.def.ghi; other=1', 'abc.def.ghi'],
    ['set-cookie: __session=abc.def.ghi; Path=/', 'abc.def.ghi'],
    ['Set-Cookie: sid=zzz9; HttpOnly', 'zzz9'],
    ['{"Authorization":"Bearer tok_123"}', 'tok_123'],
  ])('redacts %s', (text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('<redacted>');
  });

  it('is idempotent and leaves ordinary prose alone', () => {
    expect(redactSecrets(redactSecrets('Authorization: Bearer tok'))).toBe(redactSecrets('Authorization: Bearer tok'));
    expect(redactSecrets('The user is authorized to see the page.')).toBe('The user is authorized to see the page.');
  });
});
