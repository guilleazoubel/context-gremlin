import { describe, expect, it } from 'vitest';
import { createHarness, flush, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { SessionStore } from '../../src/engine/session-store';
import type { Session } from '../../src/schema/session';
import { postHelperFiles } from '../../src/workspace/post-helpers';

/**
 * R110 — a review of someone else's PR posts only when the USER asks, in the
 * conversation. A headless run is denied the helpers and has none on disk
 * (test/pipeline/stage-runner.workspace-refresh.test.ts). The other half is
 * here: when the user claims the conversation — the editor does that before
 * it opens `claude --resume` in the worktree — the engine installs the
 * helpers and re-renders the settings without the helper denies, so posting
 * works once the user asks; releasing puts the headless state back.
 */

const NOW = new Date('2026-10-05T12:00:00.000Z');
const REPO_URL = 'git@github.com:acme/app.git';
const HELPER_FILES = ['.cgremlin/post-review', '.cgremlin/post-comment', '.cgremlin/package.json'];
const HELPER_DENIES = [
  'Bash(.cgremlin/post-review:*)',
  'Bash(./.cgremlin/post-review:*)',
  'Bash(.cgremlin/post-comment:*)',
  'Bash(./.cgremlin/post-comment:*)',
];

const PR = {
  repo: 'acme/app', number: 31, url: 'https://github.com/acme/app/pull/31',
  headSha: 'a'.repeat(40), reviewedSha: null, title: 'T', author: 'bob',
};

function review(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-05T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-31' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'ready', agent: null, lastRun: null, pr: PR,
    reviewVersion: 1, lastRereviewSummary: null,
  };
}

function respond(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'respond', createdAt: '2026-10-05T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feature/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'addressing', agent: null, lastRun: null, pr: PR,
  } as Session;
}

async function denies(h: PipelineHarness, id: string): Promise<string[]> {
  const settings = await h.fs.readFile(`${WORKTREES_DIR}/${id}/.claude/settings.local.json`);
  return JSON.parse(settings).permissions.deny as string[];
}

async function helpersOnDisk(h: PipelineHarness, id: string): Promise<boolean[]> {
  return Promise.all(HELPER_FILES.map((f) => h.fs.exists(`${WORKTREES_DIR}/${id}/${f}`)));
}

describe('R110 — the conversation claim is what lets a review post', () => {
  it('claiming a review installs both helpers, with its own PR baked in, and lifts the helper denies', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(review('rev-1'));
    await h.service.claimConversation('rev-1');

    expect(await helpersOnDisk(h, 'rev-1')).toEqual([true, true, true]);
    const canonical = postHelperFiles({ repoSlug: 'acme/app', prNumber: 31 });
    for (const file of canonical) {
      expect(await h.fs.readFile(`${WORKTREES_DIR}/rev-1/${file.relativePath}`)).toBe(file.content);
    }
    expect(await h.fs.statMode(`${WORKTREES_DIR}/rev-1/.cgremlin/post-review`)).toBe(0o755);
    const deny = await denies(h, 'rev-1');
    for (const rule of HELPER_DENIES) expect(deny).not.toContain(rule);
    // Everything else a review may never do stays denied in the chat too.
    expect(deny).toContain('Bash(gh api:*)');
    expect(deny).toContain('Bash(gh pr merge:*)');
    expect(deny).toContain('Bash(git push:*)');
  });

  it('releasing the claim puts the headless state back: no helpers, helper denies restored', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(review('rev-2'));
    await h.service.claimConversation('rev-2');
    await h.service.releaseConversation('rev-2');

    expect(await helpersOnDisk(h, 'rev-2')).toEqual([false, false, false]);
    expect(await denies(h, 'rev-2')).toEqual(expect.arrayContaining(HELPER_DENIES));
  });

  it('the next headless run after a claim posts nothing either, released or not', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(review('rev-3'));
    await h.service.claimConversation('rev-3');
    // The claim expires (or the editor dies without releasing); the
    // reconciliation tick then starts the automatic re-review.
    await h.store.save({ ...(await h.store.load('rev-3')), agent: null });
    const run = h.service.runRereview('rev-3');
    run.catch(() => undefined);
    await flush();
    expect(await helpersOnDisk(h, 'rev-3')).toEqual([false, false, false]);
    expect(await denies(h, 'rev-3')).toEqual(expect.arrayContaining(HELPER_DENIES));
    await h.finishRun({ 'REVIEW.md': '# r\n', rereview_summary: '✅ 1/1 resolved' }, { code: 0, signal: null });
    await run.catch(() => undefined);
  });

  it('respond is unchanged by a claim or a release: its helpers stay, and nothing denies them', async () => {
    const h = createHarness({ now: () => NOW });
    await h.store.save(respond('res-1'));
    await h.service.claimConversation('res-1');
    expect(await helpersOnDisk(h, 'res-1')).toEqual([true, true, true]);
    await h.service.releaseConversation('res-1');
    expect(await helpersOnDisk(h, 'res-1')).toEqual([true, true, true]);
    const deny = await denies(h, 'res-1');
    for (const rule of HELPER_DENIES) expect(deny).not.toContain(rule);
  });

  it('a claim on a session whose worktree is gone writes no guardrail into it', async () => {
    const h = createHarness({ now: () => NOW });
    // A plain store: the harness's own one would create the worktree directory.
    // (Its save on the claim's way out still does — a harness artefact — so
    // what is asserted is that no guardrail was written while it was absent.)
    await new SessionStore(h.fs, SESSIONS_DIR).save(review('rev-gone'));
    expect(await h.fs.exists(`${WORKTREES_DIR}/rev-gone`)).toBe(false);
    await h.service.claimConversation('rev-gone');
    expect(await h.fs.exists(`${WORKTREES_DIR}/rev-gone/.claude/settings.local.json`)).toBe(false);
    expect(await helpersOnDisk(h, 'rev-gone')).toEqual([false, false, false]);
  });
});
