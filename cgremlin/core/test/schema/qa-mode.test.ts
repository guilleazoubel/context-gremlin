import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionModeSchema } from '../../src/schema/session-mode';
import { STAGE_NAMES } from '../../src/schema/stage';
import {
  QA_PHASES,
  QA_RUNNABLE_FROM,
  IllegalTransitionError,
  canTransition,
  transitionPhase,
} from '../../src/schema/pipeline';
import { SessionSchema, SessionV1Schema, parseSession } from '../../src/schema/session';
import { TERMINAL_PHASES_BY_MODE } from '../../src/workspace/workspace-in-use';
import { DEFAULT_PERMISSIONS } from '../../src/workspace/permission-guard';

const QA_DOC = {
  schemaVersion: 2,
  id: 'qa-app-HB-1489-2026-09-15-aaaa',
  mode: 'qa',
  createdAt: '2026-09-15T10:00:00.000Z',
  workspace: { repoUrl: 'https://github.com/acme/app.git', worktreePath: '/worktrees/qa-app', branch: 'qa/HB-1489-abc1234' },
  lineage: { pipelineId: 'qa-app-HB-1489-2026-09-15-aaaa', parentSessionId: null, ticket: 'HB-1489' },
  agent: null,
  lastRun: null,
  pr: null,
  stageStatus: 'queued',
};

describe('R68 — the fifth mode', () => {
  it("SessionModeSchema gains 'qa', appended", () => {
    expect(SessionModeSchema.options).toEqual(['review', 'investigation', 'development', 'respond', 'qa']);
  });

  it("STAGE_NAMES gains 'verify', APPENDED so no persisted lastRun.stage shifts meaning", () => {
    expect([...STAGE_NAMES]).toEqual(['findings', 'plan', 'develop', 'review', 'rereview', 'respond', 'verify']);
  });

  it('R69 — seven phases, terminal = closed/abandoned, ready is NOT terminal', () => {
    expect([...QA_PHASES]).toEqual(['queued', 'verifying', 'ready', 'not_ready', 'failed', 'closed', 'abandoned']);
    expect([...TERMINAL_PHASES_BY_MODE.qa].sort()).toEqual(['abandoned', 'closed']);
  });

  it('QA_RUNNABLE_FROM is every phase a verification may start from', () => {
    expect([...QA_RUNNABLE_FROM]).toEqual(['queued', 'ready', 'not_ready', 'failed']);
  });
});

describe('QA transitions', () => {
  it.each([
    ['queued', 'verifying'],
    ['verifying', 'ready'],
    ['verifying', 'not_ready'],
    ['verifying', 'failed'],
    ['ready', 'verifying'],
    ['ready', 'not_ready'],
    ['not_ready', 'verifying'],
    ['not_ready', 'ready'],
    ['failed', 'verifying'],
  ] as const)('%s -> %s is legal', (from, to) => {
    expect(canTransition('qa', from, to)).toBe(true);
  });

  it('closed and abandoned are reachable from every non-terminal phase', () => {
    for (const from of ['queued', 'verifying', 'ready', 'not_ready', 'failed'] as const) {
      expect(canTransition('qa', from, 'closed')).toBe(true);
      expect(canTransition('qa', from, 'abandoned')).toBe(true);
    }
  });

  it('the terminal phases go nowhere', () => {
    expect(() => transitionPhase('qa', 'closed', 'verifying')).toThrow(IllegalTransitionError);
    expect(() => transitionPhase('qa', 'abandoned', 'verifying')).toThrow(IllegalTransitionError);
    expect(canTransition('qa', 'queued', 'ready')).toBe(false);
  });
});

describe('the session variant', () => {
  it('a qa document round-trips, with qa defaulted when absent', () => {
    const parsed = SessionSchema.parse(QA_DOC);
    expect(parsed.mode).toBe('qa');
    expect(parsed.mode === 'qa' && parsed.qa).toEqual({ verifiedSha: null, verdict: null });
    expect(SessionSchema.parse(parsed)).toEqual(parsed);
  });

  it('carries verifiedSha and a verdict', () => {
    const parsed = SessionSchema.parse({ ...QA_DOC, stageStatus: 'not_ready', qa: { verifiedSha: 'abc1234', verdict: 'blocked' } });
    expect(parsed.mode === 'qa' && parsed.qa).toEqual({ verifiedSha: 'abc1234', verdict: 'blocked' });
  });

  it('the v1 union is deliberately NOT extended — a v1 qa document cannot exist', () => {
    expect(() => SessionV1Schema.parse({ ...QA_DOC, schemaVersion: 1 })).toThrow();
  });

  // Phase 20: QA's policy is unchanged, but it can no longer be expressed as
  // "review's deny list plus more" — review now deliberately PERMITS posting.
  // QA's prohibitions are therefore asserted directly, and the point of the
  // test is the same one it always made: QA writes nothing outward.
  it('the guard denies every outward write — posting, landing, gh issue, any mutating gh api, push and commit', () => {
    const deny = DEFAULT_PERMISSIONS.qa.deny ?? [];
    for (const rule of [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr ready:*)',
      'Bash(gh pr create:*)',
      'Bash(gh issue:*)',
      'Bash(gh api:*--method*)',
      'Bash(gh api:*graphql*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ]) {
      expect(deny).toContain(rule);
    }
    expect(DEFAULT_PERMISSIONS.qa.allow ?? []).toEqual([]);
  });
});

describe('MG-18 old-sessions-still-load', () => {
  const dir = path.join(__dirname, '../fixtures/sessions-pre-phase15');

  it('every committed pre-Phase-15 session still parses, unchanged', () => {
    const names = readdirSync(dir).sort();
    expect(names.length).toBe(7);
    for (const name of names) {
      const raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { mode: string };
      const session = parseSession(raw);
      expect(session.mode).toBe(raw.mode);
      expect(session.schemaVersion).toBe(2);
    }
  });
});
