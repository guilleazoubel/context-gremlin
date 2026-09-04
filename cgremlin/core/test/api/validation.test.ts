import { describe, expect, it } from 'vitest';
import {
  parseArtifactName,
  parseCreateInvestigationRequest,
  parseCreateWorkspaceRequest,
  parseRunStageRequest,
  ValidationError,
} from '../../src/api/validation';

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

describe('parseCreateInvestigationRequest', () => {
  it('returns the parsed input for a valid request', () => {
    const body = {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: 'APP-1',
      intent: 'investigate_only',
      driveToCompletion: false,
    };
    expect(parseCreateInvestigationRequest(body)).toEqual(body);
  });

  it('accepts a null ticket and an optional baseRef', () => {
    const body = {
      repoUrl: 'git@github.com:acme/app.git',
      ticket: null,
      intent: 'development',
      driveToCompletion: true,
      baseRef: 'origin/main',
    };
    expect(parseCreateInvestigationRequest(body)).toEqual(body);
  });

  it('throws ValidationError for an invalid intent', () => {
    expect(() =>
      parseCreateInvestigationRequest({
        repoUrl: 'git@github.com:acme/app.git',
        ticket: null,
        intent: 'bogus',
        driveToCompletion: false,
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for a ticket containing characters that would produce an unsafe derived id', () => {
    expect(() =>
      parseCreateInvestigationRequest({
        repoUrl: 'git@github.com:acme/app.git',
        ticket: '../../x',
        intent: 'investigate_only',
        driveToCompletion: false,
      }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError for a missing required field', () => {
    expect(() =>
      parseCreateInvestigationRequest({
        ticket: null,
        intent: 'investigate_only',
        driveToCompletion: false,
      }),
    ).toThrow(ValidationError);
  });
});

describe('parseRunStageRequest', () => {
  it('returns the stage for a valid request', () => {
    expect(parseRunStageRequest({ stage: 'findings' })).toEqual({ stage: 'findings' });
  });

  it('throws ValidationError for an unknown stage', () => {
    expect(() => parseRunStageRequest({ stage: 'bogus' })).toThrow(ValidationError);
  });
});

describe('parseArtifactName', () => {
  it('accepts every allow-listed artifact name', () => {
    const names = [
      'FINDINGS.md', 'PLAN.md', 'DEVELOPMENT.md', 'REVIEW.md', 'RE-REVIEW.md', 'BRIEF.md',
      'REVIEW-v1.md', 'REVIEW-v23.md', 'AGENT_NOTE', 'AGENT_STATE', 'rereview_summary', 'PR_URL',
    ];
    for (const name of names) {
      expect(parseArtifactName(name)).toBe(name);
    }
  });

  it('rejects the internal session.json file, traversal attempts, and near-miss names', () => {
    expect(() => parseArtifactName('session.json')).toThrow(ValidationError);
    expect(() => parseArtifactName('../secrets')).toThrow(ValidationError);
    expect(() => parseArtifactName('REVIEW-vX.md')).toThrow(ValidationError);
  });
});
