import { describe, expect, it } from 'vitest';
import { repoSlugFromUrl } from '../../src/gh/repo-slug';
import { repoSlug, repoSlugFromUrl as reexported } from '../../src/pipeline/pipeline-service';

describe('repoSlugFromUrl', () => {
  it('extracts owner/repo from an https URL', () => {
    expect(repoSlugFromUrl('https://github.com/aplaceformom/grace-frontend')).toBe('aplaceformom/grace-frontend');
  });
  it('strips a trailing .git suffix', () => {
    expect(repoSlugFromUrl('https://github.com/aplaceformom/grace-frontend.git')).toBe('aplaceformom/grace-frontend');
  });
  it('extracts owner/repo from an ssh-style URL', () => {
    expect(repoSlugFromUrl('git@github.com:aplaceformom/grace-frontend.git')).toBe('aplaceformom/grace-frontend');
  });
  it('strips a trailing slash', () => {
    expect(repoSlugFromUrl('https://github.com/aplaceformom/grace-frontend/')).toBe('aplaceformom/grace-frontend');
  });
  it('falls back to a sanitized form of the whole string when it cannot find owner/repo', () => {
    expect(repoSlugFromUrl('nourl')).toBe('nourl');
    expect(repoSlugFromUrl('')).toBe('');
  });
});

describe('pipeline-service re-export', () => {
  it('is still reachable from pipeline-service.ts as both names', () => {
    expect(reexported).toBe(repoSlugFromUrl);
    expect(repoSlug).toBe(repoSlugFromUrl);
  });
});
