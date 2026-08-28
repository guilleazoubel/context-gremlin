import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitRunner } from './git-runner';

const execFileAsync = promisify(execFile);

export class NodeGitRunner implements GitRunner {
  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: options.cwd });
    return { stdout, stderr };
  }
}
