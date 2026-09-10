import { describe, expect, it } from 'vitest';
import { ITEM_SOURCES, parseItemRef, prRef, sessionRef } from '../../src/attention/item-ref';
import { ValidationError } from '../../src/api/validation';

describe('item-ref', () => {
  it('formats and round-trips a session ref', () => {
    expect(sessionRef('a-b')).toBe('session:a-b');
    expect(parseItemRef(sessionRef('a-b'))).toEqual({ source: 'session', id: 'a-b' });
  });

  it('formats and round-trips a PR ref — the one PR-ref formatter', () => {
    expect(prRef('o/r', 12)).toBe('pr:o/r#12');
    expect(parseItemRef(prRef('o/r', 12))).toEqual({ source: 'pr', repo: 'o/r', number: 12 });
  });

  // Ground-truth correction: assertSafeSessionId rejects only '', '/', '\',
  // '.' and '..', so a ':' in a session id is legal. parseItemRef splits on
  // the FIRST ':' and treats the remainder as opaque, which is unambiguous
  // because no ItemSource name contains ':'.
  it('splits on the first colon only, so a session id may contain a colon', () => {
    expect(sessionRef('a:b')).toBe('session:a:b');
    expect(parseItemRef(sessionRef('a:b'))).toEqual({ source: 'session', id: 'a:b' });
    expect(ITEM_SOURCES.some((s) => s.includes(':'))).toBe(false);
  });

  it('rejects an unknown source, a missing id, and a malformed PR ref', () => {
    for (const bad of ['nope:x', 'session:', 'pr:o/r', 'pr:o/r#x', 'session', '', 'pr:r#1']) {
      expect(() => parseItemRef(bad)).toThrow(ValidationError);
    }
  });
});
