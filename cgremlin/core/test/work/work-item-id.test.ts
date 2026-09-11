import { describe, expect, it } from 'vitest';
import { parseWorkItemId, workItemIdOf } from '../../src/work/work-item-id';
import { ValidationError } from '../../src/api/validation';

describe('workItemIdOf / parseWorkItemId (MG-9, R14/R25)', () => {
  it('round-trips all THREE forms', () => {
    const forms = [
      { kind: 'ticket', key: 'HB-627' } as const,
      { kind: 'pr', repo: 'owner/repo', number: 12 } as const,
      { kind: 'session', id: 'inv-2026-09-10-abcdef' } as const,
    ];
    for (const form of forms) {
      expect(parseWorkItemId(workItemIdOf(form))).toEqual(form);
    }
  });

  it('formats each id exactly as the wire grammar says', () => {
    expect(workItemIdOf({ kind: 'ticket', key: 'HB-627' })).toBe('ticket:HB-627');
    expect(workItemIdOf({ kind: 'pr', repo: 'owner/repo', number: 12 })).toBe('pr:owner/repo#12');
    expect(workItemIdOf({ kind: 'session', id: 's-1' })).toBe('session:s-1');
  });

  it('rejects garbage with a ValidationError', () => {
    for (const bad of ['', 'nope', 'ticket:', 'pr:owner/repo', 'pr:owner/repo#0', 'pr:owner#12', 'session:', 'jira:HB-1']) {
      expect(() => parseWorkItemId(bad)).toThrow(ValidationError);
    }
  });

  it('a session id containing a colon still round-trips (the ref grammar splits on the FIRST colon)', () => {
    expect(parseWorkItemId(workItemIdOf({ kind: 'session', id: 'weird:id' }))).toEqual({
      kind: 'session',
      id: 'weird:id',
    });
  });
});
