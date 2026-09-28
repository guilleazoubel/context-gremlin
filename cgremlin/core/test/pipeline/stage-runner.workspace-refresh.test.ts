import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { StageRunner, WorkspaceMissingError, WorktreeGoneError } from '../../src/pipeline/stage-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { SessionSchema, type Session, type SessionMode } from '../../src/schema/session';
import type { StageName } from '../../src/schema/stage';
import { postHelperFiles } from '../../src/workspace/post-helpers';
import { DEFAULT_PERMISSIONS, renderPermissionSettings } from '../../src/workspace/permission-guard';

/**
 * The guardrails a session runs under — `.claude/settings.local.json` and the
 * scoped `.cgremlin/` post helpers — used to be written EXACTLY once, at
 * worktree creation. So a session created before a permission-table change
 * kept the old table forever, and a session created before the helpers
 * existed had no way to post at all. They are refreshed on the stage-run
 * path now; these tests pin that, and the last one pins it structurally so a
 * refactor cannot quietly go back to write-once.
 */

const SESSIONS_DIR = '/sessions';

/** The deny list a review worktree created before Phase 20's table carries. */
const STALE_REVIEW_SETTINGS = `${JSON.stringify(
  {
    permissions: {
      deny: [
        'Bash(gh pr review:*)',
        'Bash(gh pr comment:*)',
        'Bash(gh api:*--method*)',
        'Bash(git push:*)',
      ],
    },
  },
  null,
  2,
)}\n`;

const MODE_FIELDS: Record<SessionMode, Record<string, unknown>> = {
  investigation: { stageStatus: 'findings', intent: 'investigate_only', driveToCompletion: false },
  development: { stageStatus: 'active' },
  review: { stageStatus: 'reviewing', reviewVersion: 0, lastRereviewSummary: null },
  respond: { stageStatus: 'addressing' },
  qa: { stageStatus: 'verifying', qa: { verifiedSha: null, verdict: null } },
};

const STAGE_FOR: Record<SessionMode, StageName> = {
  investigation: 'findings',
  development: 'develop',
  review: 'review',
  respond: 'respond',
  qa: 'verify',
};

function makeSession(mode: SessionMode, id: string, pr: { repo: string; number: number } | null): Session {
  return SessionSchema.parse({
    schemaVersion: 2,
    id,
    mode,
    createdAt: '2026-09-18T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/w/${id}`, branch: 'b' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    agent: null,
    lastRun: null,
    pr:
      pr === null
        ? null
        : {
            repo: pr.repo,
            number: pr.number,
            url: `https://github.com/${pr.repo}/pull/${pr.number}`,
            headSha: null,
            reviewedSha: null,
            title: null,
            author: null,
          },
    ...MODE_FIELDS[mode],
  });
}

/** Same macrotask-boundary trick stage-runner.test.ts uses to reach `runner.start()`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Runs one whole stage to a clean exit and hands back the worktree filesystem. */
async function runStage(
  session: Session,
  seed?: (fs: InMemoryFileSystem, worktreePath: string) => Promise<void>,
): Promise<InMemoryFileSystem> {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, SESSIONS_DIR);
  await store.save(session);
  const worktreePath = session.workspace.worktreePath!;
  await fs.mkdir(worktreePath, { recursive: true });
  if (seed) await seed(fs, worktreePath);
  const runner = new FakeAgentRunner();
  const sr = new StageRunner({
    runner,
    store,
    fs,
    events: new EngineEvents(),
    sessionsDir: SESSIONS_DIR,
    runnerKind: 'claude-code',
    lock: new KeyedLock(),
  });
  const pending = sr.run({
    sessionId: session.id,
    stage: STAGE_FOR[session.mode],
    brief: null,
    prompt: 'go',
  });
  await flush();
  runner.emitExit(runner.lastHandle(), { code: 0, signal: null });
  const result = await pending;
  expect(result.outcome).toBe('succeeded');
  return fs;
}

describe('a stage run refreshes the worktree guardrails', () => {
  it('overwrites a STALE settings.local.json with the current permission table', async () => {
    const session = makeSession('review', 'rev-1', { repo: 'acme/app', number: 2113 });
    const fs = await runStage(session, async (memfs, worktree) => {
      await memfs.mkdir(`${worktree}/.claude`, { recursive: true });
      await memfs.writeFile(`${worktree}/.claude/settings.local.json`, STALE_REVIEW_SETTINGS);
    });
    const written = await fs.readFile('/w/rev-1/.claude/settings.local.json');
    expect(written).toBe(renderPermissionSettings(DEFAULT_PERMISSIONS.review));
    const deny = JSON.parse(written).permissions.deny as string[];
    expect(deny).not.toContain('Bash(gh api:*--method*)');
    expect(deny).toContain('Bash(gh api:*)');
    expect(deny).toContain('Bash(gh repo:*)');
  });

  it('installs both helpers, executable, in a worktree that has no .cgremlin at all', async () => {
    const session = makeSession('review', 'rev-2', { repo: 'acme/app', number: 2113 });
    const fs = await runStage(session);
    for (const helper of ['.cgremlin/post-review', '.cgremlin/post-comment']) {
      expect(await fs.exists(`/w/rev-2/${helper}`)).toBe(true);
      expect(await fs.statMode(`/w/rev-2/${helper}`)).toBe(0o755);
    }
    expect(await fs.readFile('/w/rev-2/.cgremlin/package.json')).toContain('"type": "module"');
  });

  it('restores a tampered helper byte-for-byte, and restores mode 0o755', async () => {
    const session = makeSession('respond', 'res-1', { repo: 'acme/app', number: 7 });
    const fs = await runStage(session, async (memfs, worktree) => {
      await memfs.mkdir(`${worktree}/.cgremlin`, { recursive: true });
      await memfs.writeFile(`${worktree}/.cgremlin/post-review`, '#!/bin/sh\necho tampered\n', {
        mode: 0o644,
      });
    });
    const canonical = postHelperFiles({ repoSlug: 'acme/app', prNumber: 7 }).find(
      (f) => f.relativePath === '.cgremlin/post-review',
    )!;
    expect(await fs.readFile('/w/res-1/.cgremlin/post-review')).toBe(canonical.content);
    expect(await fs.statMode('/w/res-1/.cgremlin/post-review')).toBe(0o755);
  });

  it("bakes each session's OWN pull request into its helper — no cross-contamination", async () => {
    const one = await runStage(makeSession('review', 'rev-a', { repo: 'acme/app', number: 11 }));
    const two = await runStage(makeSession('review', 'rev-b', { repo: 'other/svc', number: 99 }));
    const a = await one.readFile('/w/rev-a/.cgremlin/post-review');
    const b = await two.readFile('/w/rev-b/.cgremlin/post-review');
    expect(a).toContain('const REPO = "acme/app"');
    expect(a).toContain('const PR = 11');
    expect(a).not.toContain('other/svc');
    expect(b).toContain('const REPO = "other/svc"');
    expect(b).toContain('const PR = 99');
    expect(b).not.toContain('acme/app');
  });

  it.each(['investigation', 'development', 'qa'] as const)(
    '%s gets refreshed permissions and NO helpers',
    async (mode) => {
      const session = makeSession(mode, `${mode}-1`, { repo: 'acme/app', number: 3 });
      const fs = await runStage(session, async (memfs, worktree) => {
        await memfs.mkdir(`${worktree}/.claude`, { recursive: true });
        await memfs.writeFile(`${worktree}/.claude/settings.local.json`, STALE_REVIEW_SETTINGS);
      });
      expect(await fs.readFile(`/w/${mode}-1/.claude/settings.local.json`)).toBe(
        renderPermissionSettings(DEFAULT_PERMISSIONS[mode]),
      );
      expect(await fs.exists(`/w/${mode}-1/.cgremlin/post-review`)).toBe(false);
      expect(await fs.exists(`/w/${mode}-1/.cgremlin/post-comment`)).toBe(false);
    },
  );
});

/**
 * The structural guard. The bug this suite exists for was not a wrong write —
 * it was a write that happened in only ONE place, worktree creation. If the
 * two writers ever regain a second, scattered caller, or the stage-run path
 * loses its call, this fails.
 */
describe('the guardrail writers are reached from exactly two places', () => {
  const srcRoot = `${path.resolve(__dirname, '../../src')}/`;

  function tsFiles(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = `${dir}${name}`;
      if (statSync(full).isDirectory()) out.push(...tsFiles(`${full}/`, `${prefix}${name}/`));
      else if (name.endsWith('.ts')) out.push(`${prefix}${name}`);
    }
    return out;
  }

  /** Files that CALL `name` — the definition and bare imports do not count. */
  function callerFiles(name: string): string[] {
    const call = new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`);
    return tsFiles(srcRoot)
      .filter((rel) => call.test(readFileSync(`${srcRoot}${rel}`, 'utf8')))
      .sort();
  }

  it('writePermissionSettings and writePostHelpers are called only by the shared refresh', () => {
    expect(callerFiles('writePermissionSettings')).toEqual(['workspace/workspace-manager.ts']);
    expect(callerFiles('writePostHelpers')).toEqual(['workspace/workspace-manager.ts']);
  });

  it('the shared refresh is called from BOTH createWorkspace and the stage-run path', () => {
    expect(callerFiles('refreshWorkspaceGuardrails')).toEqual([
      'pipeline/stage-runner.ts',
      'workspace/workspace-manager.ts',
    ]);
  });
});

/**
 * The refresh's recursive `mkdir` would otherwise CONJURE a worktree that is
 * no longer on disk (deleted by hand, `git worktree prune`, a wiped scratch
 * disk): the directory comes back containing `.claude/` and nothing else, the
 * agent spawns into it happily, and a review agent that can see no code still
 * writes a confident report about nothing. A loud failure beats that.
 */
describe('a stage run refuses a worktree whose directory is gone', () => {
  it('fails with WorktreeGoneError, creates nothing at the path, and spawns no agent', async () => {
    const session = makeSession('review', 'rev-gone', { repo: 'acme/app', number: 5 });
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, SESSIONS_DIR);
    await store.save(session);
    // Deliberately NOT creating /w/rev-gone.
    const runner = new FakeAgentRunner();
    const events = new EngineEvents();
    const finished: string[] = [];
    events.on('run.finished', (e) => finished.push(e.outcome));
    const sr = new StageRunner({
      runner,
      store,
      fs,
      events,
      sessionsDir: SESSIONS_DIR,
      runnerKind: 'claude-code',
      lock: new KeyedLock(),
    });
    await expect(
      sr.run({ sessionId: 'rev-gone', stage: 'review', brief: null, prompt: 'go' }),
    ).rejects.toThrow(WorktreeGoneError);
    expect(await fs.exists('/w/rev-gone')).toBe(false);
    expect(await fs.exists('/w/rev-gone/.claude/settings.local.json')).toBe(false);
    expect(await fs.exists('/w/rev-gone/.cgremlin/post-review')).toBe(false);
    expect(() => runner.lastHandle()).toThrow('no handle has been started yet');
    // Same shape as every other preparation failure on this path.
    expect((await store.load('rev-gone')).lastRun).toMatchObject({ outcome: 'failed' });
    expect(finished).toEqual(['failed']);
  });

  it('names the worktree path, and reads differently from an unset path', async () => {
    expect(new WorktreeGoneError('rev-gone', '/w/rev-gone').message).toContain('/w/rev-gone');
    expect(new WorktreeGoneError('rev-gone', '/w/rev-gone').message).not.toBe(
      new WorkspaceMissingError('rev-gone').message,
    );
  });

  it('still runs normally when the worktree directory IS there', async () => {
    const fs = await runStage(makeSession('review', 'rev-ok', { repo: 'acme/app', number: 6 }));
    expect(await fs.exists('/w/rev-ok/.cgremlin/post-review')).toBe(true);
    expect(await fs.readFile('/w/rev-ok/.claude/settings.local.json')).toBe(
      renderPermissionSettings(DEFAULT_PERMISSIONS.review),
    );
  });
});

/**
 * The refresh rewrites `.claude/settings.local.json` before EVERY stage run,
 * which is what makes a policy change reach sessions already on disk. The
 * same property cuts the other way: a session that legitimately has MORE
 * authority than its mode implies must keep it across runs. Passing only
 * `session.mode` to the refresh reverted a development-bound investigation to
 * the plain-investigation table on its next stage — it could commit and push
 * right up until the engine ran another stage for it, and then it could not.
 * So the refresh is computed from the SESSION each time, never latched.
 *
 * The fixture is shaped like the session this was found on: `investigation` /
 * `intent: development` / `stageStatus: plan_ready`.
 */
describe('the refresh preserves an intent-derived permission set', () => {
  function developmentBoundInvestigation(id: string): Session {
    return SessionSchema.parse({
      schemaVersion: 2,
      id,
      mode: 'investigation',
      createdAt: '2026-09-24T20:28:09.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/w/${id}`, branch: 'b' },
      lineage: { pipelineId: id, parentSessionId: null, ticket: 'HB-1409', selfReview: false },
      agent: null,
      lastRun: null,
      pr: null,
      stageStatus: 'plan_ready',
      intent: 'development',
      driveToCompletion: false,
    });
  }

  it('writes the development-bound table, not the plain-investigation one', async () => {
    const session = developmentBoundInvestigation('inv-dev-1');
    const fs = await runStage(session, async (memfs, worktree) => {
      await memfs.mkdir(`${worktree}/.claude`, { recursive: true });
      await memfs.writeFile(`${worktree}/.claude/settings.local.json`, STALE_REVIEW_SETTINGS);
    });
    const written = await fs.readFile('/w/inv-dev-1/.claude/settings.local.json');
    expect(written).toBe(
      renderPermissionSettings(DEFAULT_PERMISSIONS['investigation:development']),
    );
    const deny = JSON.parse(written).permissions.deny as string[];
    expect(deny).not.toContain('Bash(git commit:*)');
    expect(deny).not.toContain('Bash(git push:*)');
    expect(deny).not.toContain('Bash(gh pr create:*)');
    expect(deny).toContain('Bash(gh api:*)');
  });

  it('keeps it across a SECOND stage run — the authority is recomputed, never latched', async () => {
    const session = developmentBoundInvestigation('inv-dev-2');
    const fs = await runStage(session);
    const first = await fs.readFile('/w/inv-dev-2/.claude/settings.local.json');
    const again = await runStage(developmentBoundInvestigation('inv-dev-2'));
    expect(await again.readFile('/w/inv-dev-2/.claude/settings.local.json')).toBe(first);
    expect(first).toBe(renderPermissionSettings(DEFAULT_PERMISSIONS['investigation:development']));
  });
});
