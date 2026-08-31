import { describe, expect, it } from 'vitest';
import { parseCreateWorkspaceRequest, ValidationError } from '../../src/api/validation';

describe('parseCreateWorkspaceRequest', () => {
  it('returns the parsed params for a valid request', () => {
    const body = {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    };
    expect(parseCreateWorkspaceRequest(body)).toEqual(body);
  });

  it('throws ValidationError for an invalid mode', () => {
    expect(() =>
      parseCreateWorkspaceRequest({
        repoUrl: 'git@github.com:org/repo.git',
        worktreePath: '/work/inv-1',
        branchName: 'main',
        baseRef: 'origin/main',
        mode: 'bogus',
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for a missing required field', () => {
    expect(() =>
      parseCreateWorkspaceRequest({
        repoUrl: 'git@github.com:org/repo.git',
        branchName: 'main',
        baseRef: 'origin/main',
        mode: 'investigation',
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for a non-object body', () => {
    expect(() => parseCreateWorkspaceRequest('not an object')).toThrow(ValidationError);
  });
});
