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
    expect(() => transitionPhase('review', 'queued', 'changes_requested')).toThrow(
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

describe('review phase additions (phase 3a)', () => {
  it('allows reviewing -> failed, failed -> reviewing, failed -> dismissed', () => {
    expect(canTransition('review', 'reviewing', 'failed')).toBe(true);
    expect(canTransition('review', 'failed', 'reviewing')).toBe(true);
    expect(canTransition('review', 'failed', 'dismissed')).toBe(true);
  });
  it('allows ready -> reviewing so an updated PR can be re-reviewed before a human acts', () => {
    expect(canTransition('review', 'ready', 'reviewing')).toBe(true);
  });
  it('still rejects failed -> ready (a failed run must be re-run, not declared ready)', () => {
    expect(canTransition('review', 'failed', 'ready')).toBe(false);
  });
});

describe('drive-to-completion promotion edge (phase 3a)', () => {
  it('allows drive-to-completion to promote directly from plan_ready, but not from planning', () => {
    expect(canTransition('investigation', 'plan_ready', 'promoted_to_development')).toBe(true);
    expect(canTransition('investigation', 'planning', 'promoted_to_development')).toBe(false);
  });
});

describe('review transitions driven by external GitHub facts (phase 3b R1)', () => {
  it('allows queued -> approved and queued -> dismissed (an external approval/close can land before our review even starts)', () => {
    expect(canTransition('review', 'queued', 'approved')).toBe(true);
    expect(canTransition('review', 'queued', 'dismissed')).toBe(true);
  });
  it('allows changes_requested -> approved (an external approval can land after we requested changes)', () => {
    expect(canTransition('review', 'changes_requested', 'approved')).toBe(true);
  });
  it('allows failed -> approved (an external approval can land even though our own run failed)', () => {
    expect(canTransition('review', 'failed', 'approved')).toBe(true);
  });
  it('approved stays terminal — no outgoing transitions, including to dismissed', () => {
    expect(canTransition('review', 'approved', 'dismissed')).toBe(false);
  });
});

describe('development active can reach merged directly (phase 3b R2)', () => {
  it('allows active -> merged (Phase 3a never records pr_opened, so a merged PR must not strand an active development session)', () => {
    expect(canTransition('development', 'active', 'merged')).toBe(true);
  });
});
