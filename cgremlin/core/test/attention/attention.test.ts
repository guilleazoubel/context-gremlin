import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REASONS,
  NEEDS_YOU_REASONS,
  deriveSessionReasons,
  derivePrReasons,
  evaluateAttention,
  type AttentionReason,
  type DerivedReason,
  type SessionEvidence,
} from '../../src/attention/attention';
import type { InventoryEntry } from '../../src/inventory/inventory';
import type { InvestigationSession, ReviewSession, Session } from '../../src/schema/session';
import { PHASE9_ENTRY_DEFAULTS } from '../support/inventory-entry';

const CREATED = '2026-09-01T00:00:00.000Z';
const ATTENTION_SOURCE = readFileSync(
  path.join(__dirname, '../../src/attention/attention.ts'),
  'utf8',
);

function investigation(over: Partial<InvestigationSession> = {}): InvestigationSession {
  return {
    schemaVersion: 2,
    id: 'i1',
    createdAt: CREATED,
    mode: 'investigation',
    stageStatus: 'findings',
    intent: 'investigate_only',
    driveToCompletion: false,
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/worktrees/i1', branch: 'b' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'APP-1', selfReview: false },
    agent: null,
    lastRun: null,
    pr: null,
    ...over,
  };
}

function review(over: Partial<ReviewSession> = {}): ReviewSession {
  return {
    schemaVersion: 2,
    id: 'r1',
    createdAt: CREATED,
    mode: 'review',
    stageStatus: 'reviewing',
    reviewVersion: 1,
    lastRereviewSummary: null,
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/worktrees/r1', branch: 'b' },
    lineage: { pipelineId: 'p2', parentSessionId: null, ticket: null, selfReview: false },
    agent: null,
    lastRun: null,
    pr: { repo: 'acme/app', number: 12, url: 'u', headSha: 's', reviewedSha: null, title: 't', author: 'bob' },
    ...over,
  };
}

function lastRun(over: Partial<NonNullable<Session['lastRun']>> = {}): NonNullable<Session['lastRun']> {
  return {
    stage: 'findings',
    startedAt: '2026-09-02T00:00:00.000Z',
    finishedAt: '2026-09-02T01:00:00.000Z',
    exitCode: 0,
    signal: null,
    outcome: 'succeeded',
    error: null,
    ...over,
  };
}

function evidence(over: Partial<SessionEvidence> = {}): SessionEvidence {
  return {
    session: investigation(),
    agentState: null,
    agentStateMtime: null,
    running: false,
    localApp: null,
    ...over,
  };
}

function entry(over: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    ...PHASE9_ENTRY_DEFAULTS,
    repo: 'acme/app',
    number: 12,
    url: 'https://github.com/acme/app/pull/12',
    title: 'Add thing',
    author: 'me-user',
    isDraft: false,
    headSha: 'sha1',
    baseRef: 'main',
    updatedAt: '2026-09-03T00:00:00.000Z',
    reviewDecision: '',
    isMine: true,
    teamActivity: [],
    ours: { status: 'none' },
    seenAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

function stateOf(ev: SessionEvidence, ack: { signature: string; ackedAt: string } | null = null) {
  return evaluateAttention({
    derived: deriveSessionReasons(ev),
    fallbackSince: ev.session.createdAt,
    ack,
  });
}

function reasonsOf(ev: SessionEvidence): AttentionReason[] {
  return stateOf(ev).reasons;
}

describe('deriveSessionReasons', () => {
  it('fires plan_ready for an investigation at plan_ready', () => {
    expect(reasonsOf(evidence({ session: investigation({ stageStatus: 'plan_ready' }) }))).toEqual([
      'plan_ready',
    ]);
  });

  it('fires needs_input and blocked from AGENT_STATE', () => {
    expect(reasonsOf(evidence({ agentState: 'needs-input' }))).toEqual(['needs_input']);
    expect(reasonsOf(evidence({ agentState: 'blocked' }))).toEqual(['blocked']);
  });

  it('fires run_failed for a failed run with nothing running', () => {
    expect(
      reasonsOf(evidence({ session: investigation({ lastRun: lastRun({ outcome: 'failed' }) }), running: false })),
    ).toEqual(['run_failed']);
  });

  it('does not fire run_failed for a failed run while a run is live', () => {
    expect(
      reasonsOf(evidence({ session: investigation({ lastRun: lastRun({ outcome: 'failed' }) }), running: true })),
    ).toEqual([]);
  });

  it('fires review_ready, and rereview_ready as well when a rereview summary is recorded', () => {
    expect(reasonsOf(evidence({ session: review({ stageStatus: 'ready' }) }))).toEqual(['review_ready']);
    expect(
      reasonsOf(
        evidence({
          session: review({
            stageStatus: 'ready',
            lastRereviewSummary: { resolved: 1, total: 2, newFindings: 0 },
          }),
        }),
      ),
    ).toEqual(['review_ready', 'rereview_ready']);
  });

  it('fires local_prereq_failed when this session owns a degraded local app', () => {
    expect(
      reasonsOf(evidence({ localApp: { state: 'unavailable', reason: 'port busy' } })),
    ).toEqual(['local_prereq_failed']);
  });

  // R22: localApp is null for a session that does not own the app, so
  // local_prereq_failed can only ever fire for the owner. The ownership
  // filter itself lives in SessionSourceAdapter (asserted there);
  // deriveSessionReasons only ever sees the already-filtered value.
  it('R22: never fires local_prereq_failed when the app is not this session’s', () => {
    expect(reasonsOf(evidence({ localApp: null }))).toEqual([]);
  });

  // R6: AGENT_STATE is authoritative even while a run is live — this
  // deliberately diverges from the legacy precedence in
  // docs/superpowers/plans/2026-07-09-status-panel-attention-work-sessions.md:17,
  // where activity always won over the attention file.
  it('R6: raises needs_input even while a run is live, and reports running unchanged', () => {
    const ev = evidence({ agentState: 'needs-input', running: true });
    expect(reasonsOf(ev)).toEqual(['needs_input']);
    expect(ev.running).toBe(true);
  });

  // R22: the engine died mid-run — the record says 'running', nothing is.
  it('R22: fires run_failed for a running record with nothing running, since = startedAt', () => {
    const run = lastRun({ outcome: 'running', finishedAt: null, exitCode: null });
    const state = stateOf(evidence({ session: investigation({ lastRun: run }), running: false }));
    expect(state.reasons).toEqual(['run_failed']);
    expect(state.since).toBe(run.startedAt);
  });

  it('R22: does not fire run_failed for a running record while the run is live', () => {
    const run = lastRun({ outcome: 'running', finishedAt: null, exitCode: null });
    expect(reasonsOf(evidence({ session: investigation({ lastRun: run }), running: true }))).toEqual([]);
  });
});

describe('derivePrReasons', () => {
  it('fires changes_requested for my own PR with CHANGES_REQUESTED, timestamped from reviewDecisionAt (R58)', () => {
    const derived = derivePrReasons(
      entry({ isMine: true, reviewDecision: 'CHANGES_REQUESTED', reviewDecisionAt: '2026-09-03T09:00:00.000Z' }),
    );
    expect(derived).toEqual([{ reason: 'changes_requested', at: '2026-09-03T09:00:00.000Z' }]);
  });

  it('R50: fresh HUMAN activity on my own PR is review_arrived, not changes_requested', () => {
    const derived = derivePrReasons(
      entry({
        isMine: true,
        // deliberately NOT in watchAuthors — teamActivity stays empty and the
        // reason still fires, which is the widening R50 asks for.
        teamActivity: [],
        humanActivity: { reviewedBy: [], commentedBy: ['stranger'], lastAt: '2026-09-03T10:00:00.000Z' },
      }),
    );
    expect(derived).toEqual([{ reason: 'review_arrived', at: '2026-09-03T10:00:00.000Z' }]);
  });

  // MG-A8 no-parking-lot-attention
  it('MG-A8 no-parking-lot-attention: a parking-lot entry needs nothing', () => {
    for (const reviewDecision of ['', 'REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'] as const) {
      const parked = entry({ isMine: false, ours: { status: 'none' }, teamActivity: [], reviewDecision });
      const derived = derivePrReasons(parked);
      expect(derived).toEqual([]);
      expect(
        evaluateAttention({ derived, fallbackSince: parked.seenAt, ack: null }),
      ).toEqual({
        needsAttention: false,
        needsYou: false,
        reasons: [],
        since: parked.seenAt,
        signature: `|${parked.seenAt}`,
        acked: false,
      });
    }
  });
});

describe('evaluateAttention', () => {
  it('orders reasons in ATTENTION_REASONS order regardless of evidence order, with no sort', () => {
    const derived: DerivedReason[] = [
      { reason: 'changes_requested', at: null },
      { reason: 'needs_input', at: null },
      { reason: 'plan_ready', at: null },
    ];
    const state = evaluateAttention({ derived, fallbackSince: CREATED, ack: null });
    expect(state.reasons).toEqual(['plan_ready', 'needs_input', 'changes_requested']);
    expect(state.signature).toBe(`plan_ready,needs_input,changes_requested|${CREATED}`);
    expect(ATTENTION_SOURCE).not.toContain('.sort(');
  });

  it('dedupes a reason derived twice', () => {
    const state = evaluateAttention({
      derived: [
        { reason: 'blocked', at: '2026-09-05T00:00:00.000Z' },
        { reason: 'blocked', at: '2026-09-06T00:00:00.000Z' },
      ],
      fallbackSince: CREATED,
      ack: null,
    });
    expect(state.reasons).toEqual(['blocked']);
    expect(state.since).toBe('2026-09-06T00:00:00.000Z');
  });

  it('R22: needsYou is true only for a needs-you reason on an unacked item', () => {
    const badge = evaluateAttention({
      derived: [{ reason: 'local_prereq_failed', at: null }],
      fallbackSince: CREATED,
      ack: null,
    });
    expect(badge.needsAttention).toBe(true);
    expect(badge.needsYou).toBe(false);

    const pops = evaluateAttention({
      derived: [{ reason: 'plan_ready', at: null }],
      fallbackSince: CREATED,
      ack: null,
    });
    expect(pops.needsAttention).toBe(true);
    expect(pops.needsYou).toBe(true);

    const acked = evaluateAttention({
      derived: [{ reason: 'plan_ready', at: null }],
      fallbackSince: CREATED,
      ack: { signature: pops.signature, ackedAt: CREATED },
    });
    expect(acked).toEqual({
      needsAttention: false,
      needsYou: false,
      reasons: ['plan_ready'],
      since: CREATED,
      signature: pops.signature,
      acked: true,
    });
    expect(NEEDS_YOU_REASONS).not.toContain('local_prereq_failed');
  });

  it('takes the max contributing timestamp as since, and falls back when every at is null', () => {
    const state = evaluateAttention({
      derived: [
        { reason: 'needs_input', at: '2026-09-07T00:00:00.000Z' },
        { reason: 'run_failed', at: '2026-09-08T00:00:00.000Z' },
        { reason: 'local_prereq_failed', at: null },
      ],
      fallbackSince: CREATED,
      ack: null,
    });
    expect(state.since).toBe('2026-09-08T00:00:00.000Z');
    expect(
      evaluateAttention({ derived: [{ reason: 'blocked', at: null }], fallbackSince: CREATED, ack: null }).since,
    ).toBe(CREATED);
  });

  it('uses agentStateMtime for needs_input and lastRun.finishedAt for plan_ready', () => {
    const mtime = '2026-09-09T00:00:00.000Z';
    expect(stateOf(evidence({ agentState: 'needs-input', agentStateMtime: mtime })).since).toBe(mtime);
    const run = lastRun({ outcome: 'succeeded' });
    expect(
      stateOf(evidence({ session: investigation({ stageStatus: 'plan_ready', lastRun: run }) })).since,
    ).toBe(run.finishedAt);
  });

  it('uses reviewDecisionAt for changes_requested and entry.seenAt as the fallback', () => {
    const e = entry({ isMine: true, reviewDecision: 'CHANGES_REQUESTED', reviewDecisionAt: '2026-09-03T00:00:00.000Z' });
    const state = evaluateAttention({
      derived: derivePrReasons(e),
      fallbackSince: e.seenAt,
      ack: null,
    });
    expect(state.since).toBe(e.updatedAt);
  });

  it('never reads the clock', () => {
    const input = {
      derived: [{ reason: 'needs_input' as const, at: null }],
      fallbackSince: CREATED,
      ack: null,
    };
    expect(evaluateAttention(input)).toEqual(evaluateAttention(input));
  });

  it('returns an empty state with a stable since when nothing fires', () => {
    expect(evaluateAttention({ derived: [], fallbackSince: CREATED, ack: null })).toEqual({
      needsAttention: false,
      needsYou: false,
      reasons: [],
      since: CREATED,
      signature: `|${CREATED}`,
      acked: false,
    });
  });

  // MG-A2 ack-resets-on-a-new-reason
  it('MG-A2 ack-resets-on-a-new-reason: a new reason or a newer since re-raises attention', () => {
    const first = evidence({ agentState: 'needs-input', agentStateMtime: '2026-09-10T00:00:00.000Z' });
    const before = stateOf(first);
    const ack = { signature: before.signature, ackedAt: '2026-09-10T00:00:01.000Z' };
    const ackedState = stateOf(first, ack);
    expect(ackedState.needsAttention).toBe(false);
    expect(ackedState.acked).toBe(true);

    const withNewReason = evidence({
      agentState: 'needs-input',
      agentStateMtime: '2026-09-10T00:00:00.000Z',
      session: investigation({ lastRun: lastRun({ outcome: 'failed' }) }),
    });
    const gained = stateOf(withNewReason, ack);
    expect(gained.reasons).toEqual(['needs_input', 'run_failed']);
    expect(gained.needsAttention).toBe(true);
    expect(gained.acked).toBe(false);

    const laterOnly = evidence({ agentState: 'needs-input', agentStateMtime: '2026-09-11T00:00:00.000Z' });
    const moved = stateOf(laterOnly, ack);
    expect(moved.reasons).toEqual(['needs_input']);
    expect(moved.needsAttention).toBe(true);
    expect(moved.acked).toBe(false);
  });
});

// MG-A1 attention-is-pure-and-source-agnostic (the source-read half; the
// stub-adapter half lives in attention-service.test.ts and the routes test).
describe('MG-A1 attention-is-pure-and-source-agnostic', () => {
  it('reads no filesystem, no engine and no clock', () => {
    expect(ATTENTION_SOURCE).not.toContain('node:fs');
    expect(ATTENTION_SOURCE).not.toContain('../fs/');
    expect(ATTENTION_SOURCE).not.toContain('../engine/');
    expect(ATTENTION_SOURCE).not.toContain('Date.now');
    expect(ATTENTION_SOURCE).not.toContain('new Date(');
  });

  it('keeps evaluateAttention free of any source-specific field', () => {
    const start = ATTENTION_SOURCE.indexOf('export function evaluateAttention');
    expect(start).toBeGreaterThan(-1);
    const rest = ATTENTION_SOURCE.slice(start + 'export function evaluateAttention'.length);
    const end = rest.indexOf('\nexport ');
    const body = end === -1 ? rest : rest.slice(0, end);
    expect(body).not.toMatch(/session/i);
    expect(body).not.toMatch(/entry/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A6 — R63's pinned array and R50/R58's PR reasons.
// ---------------------------------------------------------------------------

describe('ATTENTION_REASONS is pinned verbatim (R63)', () => {
  it('matches R63 element-for-element, positions included', () => {
    expect([...ATTENTION_REASONS]).toEqual([
      'plan_ready',
      'needs_input',
      'blocked',
      'run_failed',
      'review_ready',
      'rereview_ready',
      'comments_ready',
      'local_prereq_failed',
      'changes_requested',
      'review_arrived',
      'approved',
    ]);
  });

  it('NEEDS_YOU_REASONS contains all three new reasons', () => {
    for (const reason of ['comments_ready', 'review_arrived', 'approved'] as const) {
      expect(NEEDS_YOU_REASONS).toContain(reason);
    }
  });
});

describe('derivePrReasons: the three my-own-PR reasons (R50, R58)', () => {
  const human = (at: string) => ({ reviewedBy: ['jane'], commentedBy: [], lastAt: at });

  it('a non-bot review on my PR fires review_arrived, stamped from humanActivity.lastAt', () => {
    const derived = derivePrReasons(entry({ isMine: true, humanActivity: human('2026-09-05T00:00:00.000Z') }));
    expect(derived).toContainEqual({ reason: 'review_arrived', at: '2026-09-05T00:00:00.000Z' });
  });

  it('APPROVED fires approved, stamped from reviewDecisionAt and NEVER from updatedAt', () => {
    const derived = derivePrReasons(
      entry({
        isMine: true,
        reviewDecision: 'APPROVED',
        reviewDecisionAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:00.000Z',
      }),
    );
    const approved = derived.find((d) => d.reason === 'approved');
    expect(approved?.at).toBe('2026-09-05T00:00:00.000Z');
  });

  it('a bot-only review fires nothing', () => {
    expect(derivePrReasons(entry({ isMine: true }))).toEqual([]);
  });

  it("a teammate's PR fires nothing however loud it is (MG-A8 unchanged)", () => {
    expect(
      derivePrReasons(
        entry({
          isMine: false,
          reviewDecision: 'CHANGES_REQUESTED',
          reviewDecisionAt: '2026-09-05T00:00:00.000Z',
          humanActivity: human('2026-09-05T00:00:00.000Z'),
        }),
      ),
    ).toEqual([]);
  });

  it('R58, named: "a push to an approved, acked PR re-fires nothing"', () => {
    const before = entry({
      isMine: true,
      reviewDecision: 'APPROVED',
      reviewDecisionAt: '2026-09-05T00:00:00.000Z',
      humanActivity: human('2026-09-05T00:00:00.000Z'),
      updatedAt: '2026-09-05T00:00:00.000Z',
      headSha: 'sha1',
    });
    const first = evaluateAttention({ derived: derivePrReasons(before), fallbackSince: before.seenAt, ack: null });
    const ack = { signature: first.signature, ackedAt: '2026-09-06T00:00:00.000Z' };
    expect(evaluateAttention({ derived: derivePrReasons(before), fallbackSince: before.seenAt, ack }).acked).toBe(true);

    // the push: updatedAt and headSha move, no new review.
    const after = { ...before, updatedAt: '2026-09-09T12:00:00.000Z', headSha: 'sha2' };
    const second = evaluateAttention({ derived: derivePrReasons(after), fallbackSince: after.seenAt, ack });
    expect(second.signature).toBe(first.signature);
    expect(second.acked).toBe(true);
    expect(second.needsAttention).toBe(false);
  });
});

describe('deriveSessionReasons: comments_ready (R51)', () => {
  function respond(stageStatus: string): SessionEvidence {
    return {
      session: {
        schemaVersion: 2,
        id: 'respond-1',
        mode: 'respond',
        createdAt: CREATED,
        workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: '/wt/respond-1' },
        lineage: { pipelineId: 'respond-1', parentSessionId: null, ticket: null },
        agent: null,
        lastRun: {
          stage: 'respond',
          startedAt: '2026-09-03T00:00:00.000Z',
          finishedAt: '2026-09-03T00:10:00.000Z',
          exitCode: 0,
          signal: null,
          outcome: 'succeeded',
          error: null,
        },
        pr: null,
        stageStatus,
      } as unknown as SessionEvidence['session'],
      agentState: null,
      agentStateMtime: null,
      running: false,
      localApp: null,
    };
  }

  it('fires comments_ready at `ready`, stamped from the run finish', () => {
    expect(deriveSessionReasons(respond('ready'))).toContainEqual({
      reason: 'comments_ready',
      at: '2026-09-03T00:10:00.000Z',
    });
  });

  it('fires NOTHING at triaging or addressing', () => {
    for (const phase of ['triaging', 'addressing']) {
      expect(deriveSessionReasons(respond(phase)).map((d) => d.reason)).not.toContain('comments_ready');
    }
  });

  it('comments_ready is in NEEDS_YOU_REASONS', () => {
    expect(NEEDS_YOU_REASONS).toContain('comments_ready');
  });
});
