/**
 * Phase 19 — a live run says WHICH stage, and for how long.
 *
 * The user's complaint: an investigation was genuinely in flight, he clicked Chat and got the
 * raw engine sentence `session '…' already has a stage run in progress` — no explanation, no
 * next step ("I cant do anything"). The refusal was correct; the silence was the bug. The
 * collapsed row (and the expanded part, which reads the same `meta` cells — `src/webview/panel/
 * row.ts` patches `.row-signals` once, unconditionally of `expanded`) used to say only the bare
 * word `running`; this makes it say `investigating… 3m`, `reviewing… 3m`, and so on, per the
 * stage the engine's own `lastRun.stage` names.
 *
 * `agentBusyText`/`elapsedSince` are the ONE place this text is built (`row-composition.ts`) —
 * `row-composition.guard.test.ts` forbids a second module from spelling the stage words itself.
 */
import { describe, expect, it } from 'vitest';
import { agentBusyText, elapsedSince, rowMetaCells } from '../../src/model/row-composition';
import type { WorkItem, WorkItemAgent, WorkListKind } from '../../src/model/work-items';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');

function agent(over: Partial<WorkItemAgent> = {}): WorkItemAgent {
  return {
    sessionId: 's1',
    mode: 'investigation',
    phase: 'findings',
    running: true,
    needsYou: false,
    claimed: false,
    primaryArtifact: null,
    worktreePath: null,
    ref: 'session:s1',
    ...over,
  } as WorkItemAgent;
}

function item(agents: WorkItemAgent[]): WorkItem {
  return {
    id: 'session:s1',
    kind: 'session',
    lists: ['investigations'],
    demoted: false,
    parkingLotGroup: null,
    title: 'A session',
    prs: [],
    ticket: null,
    agents,
    needsYou: false,
    dismissed: false,
    dismissedAt: null,
    attention: { reasons: [], since: '2026-09-16T11:00:00.000Z', acked: false, refs: [] },
  } as unknown as WorkItem;
}

describe('elapsedSince — minutes and hours', () => {
  it('formats minutes alone', () => {
    expect(elapsedSince('2026-09-16T11:57:00.000Z', NOW)).toBe('3m');
  });

  it('formats whole hours alone', () => {
    expect(elapsedSince('2026-09-16T11:00:00.000Z', NOW)).toBe('1h');
  });

  it('formats hours and minutes together', () => {
    expect(elapsedSince('2026-09-16T10:56:00.000Z', NOW)).toBe('1h 4m');
  });
});

describe('agentBusyText — the stage word, per mode/stage, plus elapsed time', () => {
  it('reads `investigating… 3m` for a running investigation (lastRun.stage findings)', () => {
    const a = agent({
      mode: 'investigation',
      lastRun: { stage: 'findings', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('investigating… 3m');
  });

  it('reads `planning… 3m` for a running investigation past findings (lastRun.stage plan)', () => {
    const a = agent({
      mode: 'investigation',
      lastRun: { stage: 'plan', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('planning… 3m');
  });

  it('reads `developing… 3m` for a running development agent', () => {
    const a = agent({
      mode: 'development',
      lastRun: { stage: 'develop', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('developing… 3m');
  });

  it('reads `reviewing… 3m` for a running review agent', () => {
    const a = agent({
      mode: 'review',
      lastRun: { stage: 'review', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('reviewing… 3m');
  });

  it('reads `reviewing… 3m` for a running re-review too (lastRun.stage rereview)', () => {
    const a = agent({
      mode: 'review',
      lastRun: { stage: 'rereview', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('reviewing… 3m');
  });

  it('reads `addressing… 3m` for a running respond agent', () => {
    const a = agent({
      mode: 'respond',
      lastRun: { stage: 'respond', startedAt: '2026-09-16T11:57:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('addressing… 3m');
  });

  it('reads `verifying… 1h 4m` for a running QA agent', () => {
    const a = agent({
      mode: 'qa',
      lastRun: { stage: 'verify', startedAt: '2026-09-16T10:56:00.000Z' },
    });
    expect(agentBusyText(a, NOW)).toBe('verifying… 1h 4m');
  });

  it('falls back to the bare word `running` when the engine sent no lastRun (older engine)', () => {
    const a = agent({ mode: 'investigation', lastRun: undefined });
    expect(agentBusyText(a, NOW)).toBe('running');
  });
});

describe('the collapsed row (and, through the same cells, the expanded part) draws the specific text', () => {
  it('rowMetaCells carries `investigating… 3m` instead of the bare `running`', () => {
    const it1 = item([
      agent({
        mode: 'investigation',
        lastRun: { stage: 'findings', startedAt: '2026-09-16T11:57:00.000Z' },
      }),
    ]);
    const cells = rowMetaCells(
      it1,
      'investigations' as WorkListKind,
      { age: '1h', size: '', tier: '', activity: '', repo: '' },
      NOW,
    );
    const texts = cells.map((c) => c.text);
    expect(texts).toContain('investigating… 3m');
    expect(texts).not.toContain('running');
  });
});
