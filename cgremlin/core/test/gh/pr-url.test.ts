import { describe, expect, it } from 'vitest';
import { InvalidPrUrlError, parsePrUrl } from '../../src/gh/pr-url';

describe('parsePrUrl', () => {
  it('parses canonical, trailing-slash, and /files suffixed URLs', () => {
    for (const u of [
      'https://github.com/aplaceformom/grace-frontend/pull/2019',
      'https://github.com/aplaceformom/grace-frontend/pull/2019/',
      'https://github.com/aplaceformom/grace-frontend/pull/2019/files',
      'http://github.com/aplaceformom/grace-frontend/pull/2019#issuecomment-1',
    ]) {
      expect(parsePrUrl(u)).toEqual({
        owner: 'aplaceformom', repo: 'grace-frontend', number: 2019, slug: 'aplaceformom/grace-frontend',
        url: 'https://github.com/aplaceformom/grace-frontend/pull/2019',
      });
    }
  });
  it('rejects non-PR URLs and non-numeric ids', () => {
    for (const u of ['https://github.com/a/b', 'https://github.com/a/b/issues/3', 'https://gitlab.com/a/b/pull/3', 'https://github.com/a/b/pull/x', ''])
      expect(() => parsePrUrl(u)).toThrow(InvalidPrUrlError);
  });
});
