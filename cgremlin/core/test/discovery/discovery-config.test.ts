import { describe, expect, it } from 'vitest';
import { ConfigError, DiscoveryConfigSchema, parseLegacyWatchConfig } from '../../src/discovery/discovery-config';

const LEGACY_TEXT =
  'WATCH_REPOS="aplaceformom/grace-frontend aplaceformom/grace"\n' +
  'WATCH_AUTHORS="a b guilleazoubel"\n' +
  'GITHUB_ME="guilleazoubel"\n' +
  '# comment\n' +
  'REVIEW_MODEL="opus"';

describe('parseLegacyWatchConfig', () => {
  it('parses the exact legacy config text into repos/watchAuthors/me', () => {
    expect(parseLegacyWatchConfig(LEGACY_TEXT)).toEqual({
      repos: ['aplaceformom/grace-frontend', 'aplaceformom/grace'],
      watchAuthors: ['a', 'b', 'guilleazoubel'],
      me: 'guilleazoubel',
    });
  });

  it('accepts unquoted values', () => {
    expect(parseLegacyWatchConfig('WATCH_REPOS=a/b\nGITHUB_ME=me\n')).toEqual({
      repos: ['a/b'],
      watchAuthors: [],
      me: 'me',
    });
  });

  it('ignores comments, blank lines, and unrelated keys', () => {
    const text = '# top comment\n\nWATCH_REPOS="a/b"\n\nGITHUB_ME="me"\nSOME_OTHER_KEY="ignored"\n';
    expect(parseLegacyWatchConfig(text)).toEqual({ repos: ['a/b'], watchAuthors: [], me: 'me' });
  });

  it('defaults watchAuthors to [] when WATCH_AUTHORS is missing', () => {
    expect(parseLegacyWatchConfig('WATCH_REPOS="a/b"\nGITHUB_ME="me"\n').watchAuthors).toEqual([]);
  });

  it('throws ConfigError when WATCH_REPOS is missing', () => {
    expect(() => parseLegacyWatchConfig('GITHUB_ME="me"\n')).toThrow(ConfigError);
  });

  it('throws ConfigError when GITHUB_ME is missing', () => {
    expect(() => parseLegacyWatchConfig('WATCH_REPOS="a/b"\n')).toThrow(ConfigError);
  });
});

describe('DiscoveryConfigSchema', () => {
  it('applies defaults for pollIntervalMs and prListLimit', () => {
    const parsed = DiscoveryConfigSchema.parse({ repos: ['a/b'], watchAuthors: [], me: 'me' });
    expect(parsed.pollIntervalMs).toBe(60_000);
    expect(parsed.prListLimit).toBe(50);
  });

  it('rejects an empty repos array', () => {
    expect(() => DiscoveryConfigSchema.parse({ repos: [], watchAuthors: [], me: 'me' })).toThrow();
  });
});
