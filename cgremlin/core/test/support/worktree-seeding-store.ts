import { SessionStore } from '../../src/engine/session-store';
import type { SessionFileSystem } from '../../src/fs/session-file-system';
import type { Session } from '../../src/schema/session';

/**
 * A SessionStore that also MATERIALIZES the worktree directory a session
 * names, in the same (in-memory) filesystem.
 *
 * Fixtures that seed a session with `store.save(...)` were always implicitly
 * assuming the worktree it names exists — in production `git worktree add`
 * created it. They got away with never creating it because nothing looked.
 * StageRunner looks now: it refuses to run in a worktree that is not on disk
 * (WorktreeGoneError), because the guardrail refresh's recursive mkdir would
 * otherwise conjure an empty one back and let an agent run in it. So the
 * seeding has to be real. Doing it here, once, keeps ten test files from
 * each growing their own `mkdir` line — a test that deliberately wants NO
 * worktree simply saves a session with no `worktreePath`.
 */
export class WorktreeSeedingSessionStore extends SessionStore {
  constructor(
    private readonly worktreeFs: SessionFileSystem,
    sessionsDir: string,
  ) {
    super(worktreeFs, sessionsDir);
  }

  override async save(session: Session): Promise<void> {
    const worktreePath = session.workspace.worktreePath;
    if (worktreePath) await this.worktreeFs.mkdir(worktreePath, { recursive: true });
    await super.save(session);
  }
}
