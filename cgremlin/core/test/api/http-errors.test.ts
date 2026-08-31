import { describe, expect, it } from 'vitest';
import { mapErrorToHttp } from '../../src/api/http-errors';
import {
  SessionNotFoundError,
  InvalidSessionIdError,
  SessionCorruptError,
} from '../../src/engine/session-store';
import { IllegalTransitionError } from '../../src/schema/pipeline';

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

  it('maps an unknown Error to 500', () => {
    const result = mapErrorToHttp(new Error('something else'));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('something else');
  });

  it('maps a non-Error thrown value to 500', () => {
    const result = mapErrorToHttp('a string error');
    expect(result.status).toBe(500);
  });
});
