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
      await writePermissionSettings(this.fs, params.worktreePath, params.mode);
      if (params.pr !== undefined && shouldWritePostHelpers(params.mode)) {
        await writePostHelpers(this.fs, params.worktreePath, params.pr);
      }
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
