import type { GitRunner } from '../../src/git/git-runner';
import type { SessionFileSystem } from '../../src/fs/session-file-system';

export interface RecordedGitCall {
  args: string[];
  cwd: string;
}

export class FakeGitRunner implements GitRunner {
  readonly calls: RecordedGitCall[] = [];
  private responses: Array<{ stdout: string; stderr: string } | Error> = [];

  /**
   * Hand it the filesystem the workspace writes into and `git worktree add`
   * MATERIALIZES the directory, the way the real command does. Fixtures used
   * to leave the path empty and get away with it; StageRunner now refuses to
   * run in a worktree that is not on disk (WorktreeGoneError), so a fake that
   * never creates one no longer models git.
   */
  constructor(private readonly fs?: SessionFileSystem) {}

  queueResponse(response: { stdout: string; stderr: string } | Error): void {
    this.responses.push(response);
  }

  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, cwd: options.cwd });
    if (this.fs && args[0] === 'worktree' && args[1] === 'add' && args[2]) {
      await this.fs.mkdir(args[2], { recursive: true });
    }
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { stdout: '', stderr: '' };
  }
}
