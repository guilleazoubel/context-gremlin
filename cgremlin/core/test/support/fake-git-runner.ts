import type { GitRunner } from '../../src/git/git-runner';

export interface RecordedGitCall {
  args: string[];
  cwd: string;
}

export class FakeGitRunner implements GitRunner {
  readonly calls: RecordedGitCall[] = [];
  private responses: Array<{ stdout: string; stderr: string } | Error> = [];

  queueResponse(response: { stdout: string; stderr: string } | Error): void {
    this.responses.push(response);
  }

  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, cwd: options.cwd });
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { stdout: '', stderr: '' };
  }
}
