import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';
import { ensureMirror, mirrorDirName } from './repo-mirror';
import { createWorktree, removeWorktree } from './worktree';
import { writePermissionSettings } from './permission-guard';
import {
  shouldWritePostHelpers,
  writePostHelpers,
  type PostTarget,
} from './post-helpers';

export interface CreateWorkspaceParams {
  repoUrl: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  mode: SessionMode;
  /** R51: reset an EXISTING branch (the PR's own head) instead of inventing one — see worktree.ts. */
  resetBranch?: boolean;
  /**
   * Phase 20 — the pull request this session is FOR. Its slug and number are
   * baked into `.cgremlin/post-review` and `.cgremlin/post-comment` at write
   * time, which is the whole of the scoping: the agent cannot pass a repo or
   * a number (see ./post-helpers.ts). Only `review` and `respond` get the
   * helpers; without a PR, nobody does.
   */
  pr?: PostTarget;
}

/**
 * The whole of what the engine installs INTO a worktree for the agent that
 * will run there: the permission guard, and — for the two posting modes, when
 * the session has a pull request — the scoped helpers with that PR baked in.
 *
 * Idempotent, and deliberately overwriting rather than skip-if-present: both
 * writes replace whatever is on disk, and `fs.writeFile` chmods, so a helper
 * the agent edited or stripped +x from comes back byte-for-byte at 0o755.
 * That matters because this runs TWICE — once at worktree creation below,
 * and again immediately before EVERY stage run (src/pipeline/stage-runner.ts).
 * Written once, at creation only, a session kept whatever permission table it
 * was born with forever, and a session older than the helpers could never
 * post at all no matter what shipped afterwards.
 *
 * Keep this the ONLY caller of `writePermissionSettings`/`writePostHelpers`:
 * a scattered third call site is how the two drift apart again, and
 * test/pipeline/stage-runner.workspace-refresh.test.ts fails if one appears.
 */
export async function refreshWorkspaceGuardrails(
  fs: SessionFileSystem,
  worktreePath: string,
  mode: SessionMode,
  pr?: PostTarget,
): Promise<void> {
  await writePermissionSettings(fs, worktreePath, { mode });
  if (pr !== undefined && shouldWritePostHelpers(mode)) {
    await writePostHelpers(fs, worktreePath, pr);
  }
}

export class WorkspaceManager {
  constructor(
    private readonly git: GitRunner,
    private readonly fs: SessionFileSystem,
    private readonly mirrorsDir: string,
  ) {}

  async createWorkspace(params: CreateWorkspaceParams): Promise<string> {
    const mirrorPath = await ensureMirror(this.git, this.fs, this.mirrorsDir, params.repoUrl);
    await createWorktree(
      this.git,
      mirrorPath,
      params.worktreePath,
      params.branchName,
      params.baseRef,
      { resetBranch: params.resetBranch === true },
    );
    try {
      await refreshWorkspaceGuardrails(this.fs, params.worktreePath, params.mode, params.pr);
    } catch (err) {
      // Best-effort rollback so a retry with the same branchName doesn't
      // fail with "a branch already exists" — surface the original error
      // regardless of whether rollback itself succeeds.
      await removeWorktree(this.git, mirrorPath, params.worktreePath, params.branchName).catch(
        () => undefined,
      );
      throw err;
    }
    // Callers (Phase 1c) should persist this mirror path on the session
    // record and pass it back for teardown, rather than re-deriving it —
    // removeWorkspace re-derives from repoUrl only for convenience today.
    return mirrorPath;
  }

  async removeWorkspace(repoUrl: string, worktreePath: string, branchName: string): Promise<void> {
    const mirrorPath = `${this.mirrorsDir}/${mirrorDirName(repoUrl)}`;
    await removeWorktree(this.git, mirrorPath, worktreePath, branchName);
  }
}
