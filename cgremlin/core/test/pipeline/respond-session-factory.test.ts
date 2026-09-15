import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotMyPrError, RespondSessionFactory } from '../../src/pipeline/respond-session-factory';
import { ReviewSessionFactory } from '../../src/pipeline/review-session-factory';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { createHarness, WORKTREES_DIR, FIXED_NOW } from '../support/pipeline-harness';
import { OwnPrError } from '../../src/gh/own-pr-error';
import { SessionStore } from '../../src/engine/session-store';
import { migrateV1ToV2, parseSession, SessionV1Schema } from '../../src/schema/session';
import { RESPOND_PHASES, canTransition, transitionPhase, IllegalTransitionError } from '../../src/schema/pipeline';
import { TERMINAL_PHASES_BY_MODE } from '../../src/workspace/workspace-in-use';
import { STAGE_NAMES } from '../../src/schema/stage';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const REPO = 'acme/app';

function prViewJson(author: string, headRefName = 'feature/HB-627-x'): string {
  return JSON.stringify({
    number: 12,
    title: 'PR twelve',
    author: { login: author },
    headRefName,
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    url: `https://github.com/${REPO}/pull/12`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'CHANGES_REQUESTED',
    mergedAt: null,
    closedAt: null,
    latestReviews: [],
    statusCheckRollup: [],
  });
}

function makeFactory(me = 'me-user') {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const createCalls: unknown[] = [];
  const workspace = {
    ...h.workspace,
    createWorkspace: async (params: unknown) => {
      createCalls.push(params);
      return h.workspace.createWorkspace(params as never);
    },
  } as unknown as typeof h.workspace;
  const factory = new RespondSessionFactory({
    gh,
    store: h.store,
    workspace,
    events: h.events,
    worktreesDir: WORKTREES_DIR,
    me,
    now: FIXED_NOW,
  });
  return { h, gh, factory, createCalls };
}

describe('RespondSessionFactory (R51)', () => {
  it("throws NotMyPrError on a teammate's PR, and the workspace fake records ZERO createWorkspace calls", async () => {
    const { gh, factory, createCalls } = makeFactory();
    gh.queueResponse({ stdout: prViewJson('bob') });
    await expect(factory.createFromPr(REPO, 12)).rejects.toThrow(NotMyPrError);
    expect(createCalls).toEqual([]);
  });

  it('on MY PR it creates the worktree on the PR own head branch, and sets lineage.ticket from it', async () => {
    const { gh, factory, createCalls } = makeFactory();
    gh.queueResponse({ stdout: prViewJson('me-user', 'feature/HB-627-x') });
    const session = await factory.createFromPr(REPO, 12);
    expect(session.mode).toBe('respond');
    expect(session.stageStatus).toBe('triaging');
    expect(session.workspace.branch).toBe('feature/HB-627-x');
    expect(createCalls[0]).toMatchObject({
      branchName: 'feature/HB-627-x',
      baseRef: 'origin/feature/HB-627-x',
      mode: 'respond',
      // The PR's head branch is ALREADY in the bare mirror's refs/heads/*, so `-b` would fail
      // on the first respond run ever made; `resetBranch` is what turns it into `-B`.
      resetBranch: true,
    });
    expect(session.lineage.ticket).toBe('HB-627');
    expect(session.pr?.number).toBe(12);
  });

  it('the author match is case-insensitive', async () => {
    const { gh, factory } = makeFactory('ME-USER');
    gh.queueResponse({ stdout: prViewJson('me-user') });
    await expect(factory.createFromPr(REPO, 12)).resolves.toBeTruthy();
  });

  it('existingFor finds a live respond session and ignores a terminal one', async () => {
    const { gh, factory, h } = makeFactory();
    gh.queueResponse({ stdout: prViewJson('me-user') });
    const created = await factory.createFromPr(REPO, 12);
    expect((await factory.existingFor(REPO, 12))?.id).toBe(created.id);
    await h.store.save({ ...created, stageStatus: 'closed' });
    expect(await factory.existingFor(REPO, 12)).toBeNull();
  });

  it("ReviewSessionFactory's OwnPrError behaviour is unchanged", async () => {
    const h = createHarness();
    const gh = new FakeGhRunner();
    const review = new ReviewSessionFactory({
      gh,
      store: h.store,
      workspace: h.workspace,
      events: h.events,
      sessionsDir: '/sessions',
      worktreesDir: WORKTREES_DIR,
      now: FIXED_NOW,
    });
    gh.queueResponse({ stdout: prViewJson('me-user') });
    await expect(
      review.createFromPrUrl(`https://github.com/${REPO}/pull/12`, { refuseAuthor: 'me-user' }),
    ).rejects.toThrow(OwnPrError);
  });
});

describe('the respond phases and their transitions (R51)', () => {
  it('RESPOND_PHASES is the documented five', () => {
    expect([...RESPOND_PHASES]).toEqual(['triaging', 'addressing', 'ready', 'closed', 'abandoned']);
  });

  it('the transition table is exactly R51', () => {
    expect(canTransition('respond', 'triaging', 'addressing')).toBe(true);
    expect(canTransition('respond', 'triaging', 'abandoned')).toBe(true);
    expect(canTransition('respond', 'triaging', 'ready')).toBe(false);
    expect(canTransition('respond', 'addressing', 'ready')).toBe(true);
    expect(canTransition('respond', 'addressing', 'abandoned')).toBe(true);
    // a new review arriving sends it back
    expect(canTransition('respond', 'ready', 'addressing')).toBe(true);
    expect(canTransition('respond', 'ready', 'closed')).toBe(true);
    expect(canTransition('respond', 'ready', 'abandoned')).toBe(true);
    for (const to of RESPOND_PHASES) {
      expect(canTransition('respond', 'closed', to)).toBe(false);
      expect(canTransition('respond', 'abandoned', to)).toBe(false);
    }
    expect(() => transitionPhase('respond', 'closed', 'addressing')).toThrow(IllegalTransitionError);
  });

  it('TERMINAL_PHASES_BY_MODE.respond is closed + abandoned', () => {
    expect([...TERMINAL_PHASES_BY_MODE.respond].sort()).toEqual(['abandoned', 'closed']);
  });

  it("R56: STAGE_NAMES gains 'respond', APPENDED so no persisted lastRun.stage shifts meaning", () => {
    // Later phases APPEND further names; what R56 pins is that the first six
    // never move, so no persisted `lastRun.stage` value shifts meaning.
    expect([...STAGE_NAMES].slice(0, 6)).toEqual(['findings', 'plan', 'develop', 'review', 'rereview', 'respond']);
  });
});

describe('MG-13 old-sessions-still-load', () => {
  const dir = path.join(__dirname, '../fixtures/sessions-pre-phase9');

  it('every committed pre-Phase-9 session — v1 and v2, all three old modes — still parses', () => {
    const names = readdirSync(dir).sort();
    expect(names.length).toBe(6);
    for (const name of names) {
      const raw = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { schemaVersion: number; mode: string };
      const session = parseSession(raw);
      expect(session.mode).toBe(raw.mode);
      expect(session.schemaVersion).toBe(2);
    }
  });

  it('they load unchanged through SessionStore after the fourth variant is added', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    for (const name of readdirSync(dir)) {
      const raw = readFileSync(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as { id: string };
      await fs.mkdir(`/sessions/${parsed.id}`, { recursive: true });
      await fs.writeFile(`/sessions/${parsed.id}/session.json`, raw);
    }
    const loaded = await store.list();
    expect(loaded.length).toBe(6);
    expect(new Set(loaded.map((s) => s.mode))).toEqual(new Set(['investigation', 'development', 'review']));
  });

  it('the v1 union is deliberately NOT extended — a v1 respond document cannot exist', () => {
    const v1Respond = {
      schemaVersion: 1,
      id: 'respond-app-12',
      mode: 'respond',
      createdAt: '2026-08-01T10:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git' },
      lineage: { pipelineId: 'p', parentSessionId: null, ticket: null },
      stageStatus: 'triaging',
    };
    expect(SessionV1Schema.safeParse(v1Respond).success).toBe(false);
    // ...and migrateV1ToV2 therefore needs no respond case at all.
    expect(migrateV1ToV2(SessionV1Schema.parse(JSON.parse(readFileSync(path.join(dir, 'v1-review.json'), 'utf8'))))
      .mode).toBe('review');
  });
});
