import { describe, expect, it } from 'vitest';
import { mapErrorToHttp } from '../../src/api/http-errors';
import {
  SessionNotFoundError,
  InvalidSessionIdError,
  SessionCorruptError,
} from '../../src/engine/session-store';
import { IllegalTransitionError } from '../../src/schema/pipeline';
import { ValidationError } from '../../src/api/validation';
import { PlanGateError } from '../../src/pipeline/plan-gate';
import { RunInProgressError, WorkspaceMissingError } from '../../src/pipeline/stage-runner';
import { HumanTurnInProgressError, UnsupportedStageError } from '../../src/pipeline/pipeline-service';
import { WorkspaceInUseError } from '../../src/workspace/workspace-in-use';
import { ArtifactNotFoundError } from '../../src/api/artifacts';
import { TickInProgressError } from '../../src/discovery/scheduler';
import { OwnPrError, NoScanYetError } from '../../src/api/server';
import {
  LocalAppPortBusyError,
  LocalAppPrereqError,
  LocalAppSetupError,
  LocalAppUnhealthyError,
} from '../../src/env/local-app-runner';

describe('mapErrorToHttp', () => {
  it('maps SessionNotFoundError to 404', () => {
    const result = mapErrorToHttp(new SessionNotFoundError('inv-1'));
    expect(result.status).toBe(404);
    expect(result.body.error).toContain('inv-1');
  });

  it('maps InvalidSessionIdError to 400', () => {
    const result = mapErrorToHttp(new InvalidSessionIdError('../bad'));
    expect(result.status).toBe(400);
  });

  it('maps IllegalTransitionError to 409', () => {
    const result = mapErrorToHttp(
      new IllegalTransitionError('investigation', 'findings', 'approved'),
    );
    expect(result.status).toBe(409);
  });

  it('maps SessionCorruptError to 500', () => {
    const result = mapErrorToHttp(new SessionCorruptError('inv-1', 'bad json'));
    expect(result.status).toBe(500);
  });

  it('maps ValidationError to 400', () => {
    const result = mapErrorToHttp(new ValidationError('bad body'));
    expect(result.status).toBe(400);
  });

  it('maps an unknown Error to 500', () => {
    const result = mapErrorToHttp(new Error('something else'));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('something else');
  });

  it('maps a non-Error thrown value to 500', () => {
    const result = mapErrorToHttp('a string error');
    expect(result.status).toBe(500);
  });

  it('maps PlanGateError to 409', () => {
    expect(mapErrorToHttp(new PlanGateError('cannot promote')).status).toBe(409);
  });

  it('maps RunInProgressError to 409', () => {
    expect(mapErrorToHttp(new RunInProgressError('inv-1')).status).toBe(409);
  });

  it('maps WorkspaceInUseError to 409', () => {
    expect(mapErrorToHttp(new WorkspaceInUseError('/w', ['inv-1'])).status).toBe(409);
  });

  it('maps HumanTurnInProgressError to 409 with its message', () => {
    const result = mapErrorToHttp(new HumanTurnInProgressError('dev-1'));
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/dev-1/);
  });

  it('maps UnsupportedStageError to 409', () => {
    expect(mapErrorToHttp(new UnsupportedStageError('cannot run')).status).toBe(409);
  });

  it('maps WorkspaceMissingError to 409', () => {
    expect(mapErrorToHttp(new WorkspaceMissingError('inv-1')).status).toBe(409);
  });

  it('maps ArtifactNotFoundError to 404', () => {
    expect(mapErrorToHttp(new ArtifactNotFoundError('inv-1', 'PLAN.md')).status).toBe(404);
  });

  it('maps TickInProgressError to 409', () => {
    expect(mapErrorToHttp(new TickInProgressError()).status).toBe(409);
  });

  it('maps OwnPrError to 409', () => {
    expect(mapErrorToHttp(new OwnPrError('acme/app', 5)).status).toBe(409);
  });

  it('maps NoScanYetError to 404', () => {
    expect(mapErrorToHttp(new NoScanYetError()).status).toBe(404);
  });

  it('maps every local-app failure to 409 with its own message', () => {
    for (const err of [
      new LocalAppPortBusyError(8080, 42, false),
      new LocalAppPrereqError('PREREQ: nope'),
      new LocalAppUnhealthyError('did not come up'),
      new LocalAppSetupError('pnpm install failed', 'pnpm install'),
    ]) {
      expect(mapErrorToHttp(err)).toEqual({ status: 409, body: { error: err.message } });
    }
  });
});
