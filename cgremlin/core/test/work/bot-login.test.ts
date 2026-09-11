import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_LOGINS, isBotLogin } from '../../src/work/bot-login';

describe('isBotLogin (R5)', () => {
  it('is_bot: true wins, whatever the login looks like', () => {
    expect(isBotLogin('alice', { isBot: true })).toBe(true);
  });

  it('a [bot] suffix is a bot, case-insensitively', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('Dependabot[Bot]')).toBe(true);
  });

  it('github-actions is a bot via the default list', () => {
    expect(isBotLogin('github-actions')).toBe(true);
    expect(DEFAULT_BOT_LOGINS).toContain('github-actions');
  });

  it('a human called robots is not a bot', () => {
    expect(isBotLogin('robots')).toBe(false);
    expect(isBotLogin('robots', { isBot: false })).toBe(false);
  });

  it('the extra list adds to, never replaces, the defaults', () => {
    expect(isBotLogin('acme-ci', { extra: ['acme-ci'] })).toBe(true);
    // the defaults still apply alongside the extra list
    expect(isBotLogin('renovate', { extra: ['acme-ci'] })).toBe(true);
    expect(isBotLogin('alice', { extra: ['acme-ci'] })).toBe(false);
  });

  // gh#2125 false positive: gitstream-cm and apfm-sonar have no [bot] suffix
  // and no is_bot flag on every gh response observed, and github-actions can
  // show up without the suffix too — the default list has to carry them.
  it.each(['gitstream-cm', 'apfm-sonar', 'codecov-commenter', 'copilot', 'netlify', 'snyk-bot'])(
    '%s is a bot via the default list',
    (login) => {
      expect(isBotLogin(login)).toBe(true);
      expect(DEFAULT_BOT_LOGINS).toContain(login);
    },
  );
});
