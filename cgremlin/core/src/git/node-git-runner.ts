import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitRunner } from './git-runner';

const execFileAsync = promisify(execFile);

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export class NodeGitRunner implements GitRunner {
  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: options.cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: DEFAULT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { stdout, stderr };
  }
}
