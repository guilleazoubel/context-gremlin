import { describe, expect, it } from 'vitest';
import {
  canTransition,
  IllegalTransitionError,
  transitionPhase,
} from '../../src/schema/pipeline';

describe('pipeline transition table', () => {
  it('allows investigation findings -> planning', () => {
    expect(canTransition('investigation', 'findings', 'planning')).toBe(true);
  });

  it('rejects skipping straight from findings to approved', () => {
    expect(canTransition('investigation', 'findings', 'approved')).toBe(false);
  });

  it('rejects promoting to development before plan approval', () => {
    // Guards the exact gap in today's bash implementation: nothing stops
    // --develop before approval except a bypassable shell `if`.
    expect(
      canTransition('investigation', 'planning', 'promoted_to_development'),
    ).toBe(false);
  });

  it('transitionPhase returns the target phase on a legal transition', () => {
    expect(transitionPhase('review', 'queued', 'reviewing')).toBe('reviewing');
  });

  it('transitionPhase throws IllegalTransitionError on an illegal transition', () => {
    expect(() => transitionPhase('review', 'queued', 'approved')).toThrow(
      IllegalTransitionError,
    );
  });

  it('review supports the changes_requested -> reviewing re-review loop', () => {
    expect(canTransition('review', 'changes_requested', 'reviewing')).toBe(true);
  });

  it('allows development pr_opened -> merged directly (matches reconcile_orphaned_sources)', () => {
    expect(canTransition('development', 'pr_opened', 'merged')).toBe(true);
  });

  it('allows investigation approved -> abandoned (matches reconcile_orphaned_sources on stale investigations)', () => {
    expect(canTransition('investigation', 'approved', 'abandoned')).toBe(true);
  });

  it('terminal phases have no outgoing transitions', () => {
    expect(canTransition('development', 'merged', 'active')).toBe(false);
    expect(canTransition('review', 'approved', 'reviewing')).toBe(false);
  });
});
